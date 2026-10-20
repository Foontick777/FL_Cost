"""Trailer-contract endpoints — recurring RENTAL + INSURANCE for rented trailers.

Parallel to leasing_contracts.py but with a `category` field (rental | insurance)
and plate_number referring to the TRAILER (not in the Vehicle table).

Generated transactions:
  source      = "recurring"
  external_id = f"trailer_{contract_id}_{YYYY-MM}"
  fuel_type   = "manual_trailer_{category}"   (rental / insurance)
  plate_number = trailer plate (string only — no vehicle_id FK)
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, delete, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from datetime import datetime, date, time, timezone
from typing import Optional
from decimal import Decimal

from app.core.database import get_db
from app.api.deps import get_current_user, require_manager, require_owner, get_request_context
from app.models.models import User, Transaction, TrailerContract, TrailerTombstone
from app.schemas.schemas import (
    TrailerContractCreate, TrailerContractOut, TRAILER_CATEGORIES,
)
from app.services import audit_service, fx_service, fx_autoload

router = APIRouter(prefix="/trailer-contracts", tags=["trailer-contracts"])


def _monthly_amount(total: float, term: int) -> float:
    return round(total / float(term), 2)


def _iter_monthly_charge_dates(start: date, term_months: int, day_of_month: int):
    for i in range(term_months):
        year = start.year + ((start.month - 1 + i) // 12)
        month = ((start.month - 1 + i) % 12) + 1
        yield date(year, month, day_of_month)


@router.get("/", response_model=list[TrailerContractOut])
async def list_contracts(
    active_only: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(TrailerContract).where(
        TrailerContract.company_id == current_user.company_id
    ).order_by(TrailerContract.created_at.desc())
    if active_only:
        q = q.where(TrailerContract.is_active == True)
    result = await db.execute(q)
    return result.scalars().all()


@router.post("/", response_model=TrailerContractOut)
async def create_contract(
    request: Request,
    data: TrailerContractCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Create a trailer contract. Owner or manager only (Issue #1)."""
    # ── Новые договоры этим способом больше не создаются ──────────────
    # Регулярный расход теперь один: RecurringExpense («Регулярные платежи»
    # на странице раздела). Пока работали оба механизма, один и тот же
    # договор можно было завести дважды — и в учёте появлялись две независимые
    # серии списаний по одному обязательству.
    # Просмотр, синхронизация и закрытие ранее созданных договоров работают
    # как раньше: закрыт только СОЗДАЮЩИЙ метод.
    raise HTTPException(
        409,
        "Новые регулярные расходы создаются через «Регулярные платежи» "
        "в разделе «Прицепы». Этот способ оставлен только для ранее созданных договоров.",
    )

@router.patch("/{contract_id}/cancel", response_model=TrailerContractOut)
async def cancel_contract(
    contract_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Cancel a contract. Owner or manager only (Issue #1).
    Stops future auto-charge generation but keeps all already-generated
    transactions in place (they represent real past expenses)."""
    result = await db.execute(select(TrailerContract).where(
        TrailerContract.id == contract_id,
        TrailerContract.company_id == current_user.company_id,
    ))
    contract = result.scalar_one_or_none()
    if not contract:
        raise HTTPException(404, "Contract not found")
    old_snapshot = audit_service.snapshot(contract)
    contract.is_active = False
    contract.cancelled_at = datetime.now(timezone.utc)
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="CANCEL",
        entity_type="TrailerContract",
        entity_id=contract_id,
        old_value=old_snapshot,
        new_value=audit_service.snapshot(contract),
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(contract)
    return contract


@router.delete("/{contract_id}")
async def delete_contract(
    contract_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Delete a contract that has NO generated transactions (created in error).

    PAY-01 (аудит stage8): раньше удаление было доступно менеджеру и стирало
    ВСЕ списания договора вместе с уже оплаченными. Теперь: только владелец;
    при наличии списаний — 409 (история неизменяема, используйте PATCH /cancel).
    """
    result = await db.execute(select(TrailerContract).where(
        TrailerContract.id == contract_id,
        TrailerContract.company_id == current_user.company_id,
    ))
    contract = result.scalar_one_or_none()
    if not contract:
        raise HTTPException(404, "Contract not found")

    # PAY-01: считаем ровно то, что собирался удалить DELETE, и запрещаем,
    # если это проведённые операции (история — не расходник).
    prefix = f"trailer_{contract_id}_"
    charges = (await db.execute(
        select(func.count(Transaction.id)).where(
            Transaction.company_id == current_user.company_id,
            Transaction.source == "recurring",
            # Точный префикс, а не LIKE: "_" в LIKE — подстановочный знак,
            # поэтому "trailer_1_%" совпадал и с "trailer_15_...".
            func.substr(Transaction.external_id, 1, len(prefix)) == prefix,
        )
    )).scalar() or 0
    if charges:
        raise HTTPException(
            409,
            f"У договора есть списания ({int(charges)}). Удаление стёрло бы "
            "проведённые операции. Используйте «Остановить» (PATCH /cancel): "
            "история и прогресс сохранятся, новых списаний не будет.",
        )

    old_snapshot = audit_service.snapshot(contract)
    await db.execute(delete(TrailerTombstone).where(
        TrailerTombstone.contract_id == contract_id,
    ))
    await db.delete(contract)
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="DELETE",
        entity_type="TrailerContract",
        entity_id=contract_id,
        old_value=old_snapshot,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True, "deleted_transactions": False}


class SyncResponse(BaseModel):
    generated: int
    skipped: int
    # Результат автодогрузки курсов и автопересчёта: сгенерированные строки в валюте
    # без курса на дату операции остались бы без amount_eur и не попали бы в суммы.
    auto: Optional[dict] = None


@router.post("/sync", response_model=SyncResponse)
async def sync_contracts(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Устаревшая точка входа — закрыта намеренно (410 Gone).

    Раньше здесь создавались списания по СТАРОЙ модели договоров. После перехода
    на общие регулярные расходы в системе жили две системы учёта одновременно:
    договор, созданный через этот роут, не попадал в новую, и по одному
    обязательству могли идти две независимые серии платежей — двойной расход.
    Миграция 0009 перенесла данные, но сам роут оставался открытым.

    Данные не удалены: старые договоры по-прежнему читаются (GET), а начисления
    по ним создаёт единый механизм — POST /recurring-expenses/sync.
    """
    raise HTTPException(
        410,
        "Устаревшая точка входа. Договоры и списания ведутся через "
        "/recurring-expenses/ (синхронизация — POST /recurring-expenses/sync). "
        "Старые данные доступны только для чтения.",
    )