"""Recurring-contract endpoints for the «Общие расходы» page.

A RecurringContract represents a fixed monthly cost (office rent, accounting,
office parking) that the user enters once with a start date, end date, annual
amount, currency and the day-of-month the charge should fire on. The system
then auto-generates one Transaction per month on that day.

Lifecycle:
  • POST   /recurring-contracts/        — create a new contract
  • GET    /recurring-contracts/        — list all (active + cancelled)
  • PATCH  /recurring-contracts/{id}/cancel  — cancel (stop future auto-charges,
                                               keeps already-generated txns)
  • DELETE /recurring-contracts/{id}    — delete contract + all its auto-generated txns
  • POST   /recurring-contracts/sync    — generate any missing monthly txns for
                                          the requested date range (idempotent)

Generated transactions are stored with:
  source      = "recurring"
  external_id = f"recurring_{contract_id}_{YYYY-MM}"  (dedup key — sync is idempotent)
  fuel_type   = f"manual_general_{category}"           (office / accounting / parking)
  plate_number = NULL (so they fall into the unassigned pool redistributed
                        across active vehicles — same logic as salary taxes)
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, and_, delete, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from datetime import datetime, date, timedelta, time, timezone
from typing import Optional
from decimal import Decimal
import calendar

from app.core.database import get_db
from app.api.deps import get_current_user, require_manager, require_owner, get_request_context
from app.models.models import User, Transaction, RecurringContract, RecurringTombstone
from app.schemas.schemas import (
    RecurringContractCreate, RecurringContractOut, RECURRING_CATEGORIES,
)
from app.services import audit_service, fx_service, fx_autoload

router = APIRouter(prefix="/recurring-contracts", tags=["recurring-contracts"])

# Category → human-readable default description (used when the user does not
# provide one). The frontend always sends a description, but the backend keeps
# a sensible fallback in case the API is called directly.
_DEFAULT_DESCRIPTION = {
    "office":     "Аренда офиса",
    "accounting": "Бухгалтерия",
    "parking":    "Стоянка возле офиса",
}


def _monthly_amount(annual: float) -> float:
    """Round monthly share to 2 decimals — avoids 833.333333333 repeating."""
    return round(annual / 12.0, 2)


def _iter_monthly_charge_dates(start: date, end: date, day_of_month: int):
    """Yield each date on which the contract should fire.

    The first fire-date is the first month where `start`'s month is reached
    (the contract starts being billable on its start month). The last is the
    month containing `end`. We always use `day_of_month` (1..28), which is
    safe because every month has at least 28 days.
    """
    cur = date(start.year, start.month, day_of_month)
    # If start_date is past day_of_month in the start month, we still charge
    # that month — the contract is "active" that month. (User picks day-of-month
    # themselves, so if they want it to start next month they pick start_date
    # accordingly.)
    while cur <= end:
        if cur >= start:
            yield cur
        # advance one month
        year = cur.year + (1 if cur.month == 12 else 0)
        month = 1 if cur.month == 12 else cur.month + 1
        cur = date(year, month, day_of_month)


@router.get("/", response_model=list[RecurringContractOut])
async def list_contracts(
    active_only: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(RecurringContract).where(
        RecurringContract.company_id == current_user.company_id
    ).order_by(RecurringContract.created_at.desc())
    if active_only:
        q = q.where(RecurringContract.is_active == True)
    result = await db.execute(q)
    return result.scalars().all()


@router.post("/", response_model=RecurringContractOut)
async def create_contract(
    request: Request,
    data: RecurringContractCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Create a recurring contract. Owner or manager only (Issue #1)."""
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
        "в разделе «Общие расходы». Этот способ оставлен только для ранее созданных договоров.",
    )

@router.patch("/{contract_id}/cancel", response_model=RecurringContractOut)
async def cancel_contract(
    contract_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Cancel a contract. Owner or manager only (Issue #1).
    Stops future auto-charge generation but keeps all already-generated
    transactions in place (they represent real past expenses)."""
    result = await db.execute(select(RecurringContract).where(
        RecurringContract.id == contract_id,
        RecurringContract.company_id == current_user.company_id,
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
        entity_type="RecurringContract",
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
    ВСЕ списания договора вместе с уже оплаченными — проведённые операции
    исчезали из отчётов задним числом. Теперь:
      • удалять может только владелец (роль менеджера — операционная);
      • при наличии хотя бы одного списания — 409: история неизменяема,
        для остановки будущих начислений есть PATCH /cancel.
    """
    result = await db.execute(select(RecurringContract).where(
        RecurringContract.id == contract_id,
        RecurringContract.company_id == current_user.company_id,
    ))
    contract = result.scalar_one_or_none()
    if not contract:
        raise HTTPException(404, "Contract not found")

    # PAY-01: считаем ровно то, что собирался удалить DELETE, и запрещаем,
    # если это проведённые операции (история — не расходник).
    prefix = f"recurring_{contract_id}_"
    charges = (await db.execute(
        select(func.count(Transaction.id)).where(
            Transaction.company_id == current_user.company_id,
            Transaction.source == "recurring",
            # Точный префикс, а не LIKE: "_" в LIKE — подстановочный знак,
            # поэтому "leasing_1_%" совпадал и с "leasing_15_...".
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
    # Договор без единого списания удалять безопасно: физические деньги он
    # не создавал. Также чистим tombstones, чтобы будущий договор не унаследовал их.
    await db.execute(
        delete(RecurringTombstone).where(
            RecurringTombstone.contract_id == contract_id,
        )
    )
    await db.delete(contract)
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="DELETE",
        entity_type="RecurringContract",
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