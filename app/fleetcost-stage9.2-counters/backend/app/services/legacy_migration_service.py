"""Перенос договоров старого формата в единую модель регулярных расходов.

Раньше существовало четыре отдельные модели со своими сериями списаний:

    LeasingContract   → списания  leasing_{id}_{YYYY-MM}
    TrailerContract   → списания  trailer_{id}_{YYYY-MM}
    InsuranceContract → списания  insurance_{id}_{YYYY-MM}
    RecurringContract → списания  recurring_{id}_{YYYY-MM}   («Общие расходы»)

Сейчас всё это — `RecurringExpense` (списания `rexp_{id}_{период}`). Этот модуль
переносит ДАННЫЕ, ничего не теряя:

  • договор → новый RecurringExpense (в той же компании; `legacy_ref` хранит
    «откуда», поэтому повторный запуск ничего не дублирует);
  • уже созданные списания ПЕРЕИМЕНОВЫВАЮТСЯ на новый договор (external_id,
    recurring_expense_id, категория, fuel_type). Суммы, курсы, EUR, статус оплаты
    и даты не трогаются — история остаётся ровно той же;
  • tombstones («удалённые пользователем списания») переносятся, чтобы удалённое
    не появилось снова;
  • сами старые договоры не удаляются (их закрытые маршруты ничего не создают).

Режим «пробного прогона» (apply=False) выполняет всё то же самое и откатывает —
отчёт совпадает с реальным.
"""
from __future__ import annotations

import logging
import re
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    ExpenseCategory, InsuranceContract, InsuranceTombstone, LeasingContract,
    LeasingTombstone, RecurringContract, RecurringExpense,
    RecurringExpenseTombstone, RecurringTombstone, TrailerContract,
    TrailerTombstone, Transaction,
)
from app.services import category_service, recurring_expense_service as rs
from app.services.category_service import (
    SECTION_GENERAL, SECTION_INSURANCE, SECTION_LEASING, SECTION_TRAILER,
    fuel_type_for,
)

logger = logging.getLogger(__name__)

# kind → (модель договора, модель tombstone, префикс external_id старых списаний)
KINDS = {
    "leasing": (LeasingContract, LeasingTombstone, "leasing"),
    "trailer": (TrailerContract, TrailerTombstone, "trailer"),
    "insurance": (InsuranceContract, InsuranceTombstone, "insurance"),
    "general": (RecurringContract, RecurringTombstone, "recurring"),
}
_PERIOD_RE = re.compile(r"^\d{4}-\d{2}$")


def legacy_ref(kind: str, contract_id: int) -> str:
    return f"{kind}:{contract_id}"


def _section_and_code(kind: str, c) -> tuple[str, str]:
    if kind == "leasing":
        return SECTION_LEASING, "leasing"
    if kind == "trailer":
        return SECTION_TRAILER, (c.category or "other")
    if kind == "insurance":
        return SECTION_INSURANCE, (c.category or "other")
    return SECTION_GENERAL, (c.category or "other")


async def _category(db: AsyncSession, company_id: int, idx: dict, section: str, code: str):
    """Категория (section, code); если у компании её нет (например, старый код
    «parking» в общих расходах) — заводим пользовательскую, а не теряем договор."""
    cat = idx.get((section, code))
    if cat is not None:
        return cat
    cat = ExpenseCategory(
        company_id=company_id, section=section, code=code,
        name=code.replace("_", " ").capitalize(), icon="📦",
        object_scope=category_service.SECTION_OBJECT_SCOPE.get(section, "any"),
        is_system=False, is_active=True, sort_order=1000,
    )
    db.add(cat)
    await db.flush()
    idx[(section, code)] = cat
    return cat


def _build_expense(kind: str, c, cat: ExpenseCategory) -> tuple[Optional[RecurringExpense], Optional[str]]:
    """Новый RecurringExpense по старому договору. Возвращает (договор, причина отказа)."""
    dom = c.day_of_month if c.day_of_month and 1 <= c.day_of_month <= 28 else 1
    monthly = Decimal(str(c.monthly_amount))
    if kind == "general":
        # Годовая сумма на срок [start, end]; шаг — месяц, как в старой модели.
        start = c.start_date
        end = c.end_date
        tp = rs.count_periods(start, end, "monthly", dom)
        mode, input_amount = "yearly", Decimal(str(c.annual_amount))
    else:
        # В старой модели первый платёж — в месяце start_date в выбранный день,
        # даже если он раньше самой start_date. В новой первый платёж не может быть
        # раньше start_date, поэтому start сдвигается на этот день: график не
        # меняется ни на день.
        start = date(c.start_date.year, c.start_date.month, dom)
        tp = int(c.term_months)
        mode, input_amount = "total", Decimal(str(c.total_amount))
        end = rs.nth_charge_date(start, "monthly", dom, tp)
    if not tp or tp < 1:
        return None, "по сроку договора не получается ни одного платежа"
    if end is None:
        return None, "не удалось определить дату окончания"

    cancelled = (not c.is_active) or c.cancelled_at is not None
    plate = c.plate_number if kind != "general" else None
    exp = RecurringExpense(
        company_id=c.company_id,
        category_id=cat.id,
        vehicle_id=getattr(c, "vehicle_id", None),
        trailer_plate=(c.plate_number if kind == "trailer" else None),
        plate_number=plate if kind != "trailer" else c.plate_number,
        description=(getattr(c, "description", None) or cat.name)[:500],
        amount=monthly,
        currency=c.currency,
        frequency="monthly",
        start_date=start,
        end_date=end,
        day_of_month=dom,
        amount_mode=mode,
        input_amount=input_amount,
        down_payment=Decimal("0"),
        total_periods=tp,
        is_active=True,
        status="paused" if cancelled else "active",
        paused_at=c.cancelled_at if cancelled else None,
        paid_periods=0,
        legacy_ref=legacy_ref(kind, c.id),
        country=getattr(c, "country", None),
        policy_number=getattr(c, "policy_number", None),
        insurer=getattr(c, "insurer", None),
    )
    if getattr(c, "created_at", None) is not None:
        exp.created_at = c.created_at
    return exp, None


async def migrate_company(db: AsyncSession, company_id: int, apply: bool = False) -> dict:
    """Перенести все старые договоры компании. Коммитит только при apply=True."""
    await category_service.ensure_seeded(db, company_id)
    idx = await category_service.existing_index(db, company_id)
    report: dict = {"company_id": company_id, "apply": apply, "contracts": [],
                    "migrated": 0, "already": 0, "errors": 0,
                    "charges_relinked": 0, "tombstones_moved": 0}

    for kind, (Contract, Tomb, prefix) in KINDS.items():
        legacy = (await db.execute(
            select(Contract).where(Contract.company_id == company_id).order_by(Contract.id)
        )).scalars().all()
        for c in legacy:
            item = {"kind": kind, "legacy_id": c.id, "description": getattr(c, "description", None)}
            ref = legacy_ref(kind, c.id)
            try:
                async with db.begin_nested():     # SAVEPOINT: сбой одного договора не рушит остальные
                    existing = (await db.execute(
                        select(RecurringExpense).where(
                            RecurringExpense.company_id == company_id,
                            RecurringExpense.legacy_ref == ref,
                        )
                    )).scalar_one_or_none()
                    if existing is None:
                        section, code = _section_and_code(kind, c)
                        cat = await _category(db, company_id, idx, section, code)
                        exp, why = _build_expense(kind, c, cat)
                        if exp is None:
                            raise ValueError(why)
                        db.add(exp)
                        await db.flush()
                        item["status"] = "migrated"
                    else:
                        exp = existing
                        cat = await db.get(ExpenseCategory, exp.category_id)
                        item["status"] = "already"
                    item["new_id"] = exp.id

                    relinked, left_alone = await _relink_charges(db, company_id, kind, prefix, c, exp, cat)
                    moved = await _move_tombstones(db, company_id, Tomb, c, exp)
                    await rs.recount_paid_periods(db, exp)
                    item["charges_relinked"] = relinked
                    item["tombstones_moved"] = moved
                    if left_alone:
                        item["notes"] = left_alone
                report["charges_relinked"] += relinked
                report["tombstones_moved"] += moved
                report["migrated" if item["status"] == "migrated" else "already"] += 1
            except Exception as e:  # noqa: BLE001 — отчёт важнее остановки
                logger.warning(f"legacy migration {ref} failed: {e}")
                item["status"] = "error"
                item["error"] = str(e)
                report["errors"] += 1
            report["contracts"].append(item)

    if apply:
        await db.commit()
    else:
        await db.rollback()
    return report


async def _relink_charges(db, company_id, kind, prefix, c, exp, cat) -> tuple[int, list[str]]:
    """Переименовать списания старого договора на новый. Суммы/курсы не трогаем."""
    pre = f"{prefix}_{c.id}_"
    rows = (await db.execute(
        select(Transaction).where(
            Transaction.company_id == company_id,
            Transaction.source == "recurring",
            # Точный префикс, а не LIKE: «_» в LIKE — подстановочный знак, и
            # «leasing_1_%» совпало бы с «leasing_15_…».
            func.substr(Transaction.external_id, 1, len(pre)) == pre,
        )
    )).scalars().all()
    n = 0
    notes: list[str] = []
    for t in rows:
        suffix = t.external_id[len(pre):]
        if not _PERIOD_RE.match(suffix):
            notes.append(f"{t.external_id}: нестандартный период, не тронуто")
            continue
        new_ext = f"rexp_{exp.id}_{suffix}"
        clash = (await db.execute(
            select(Transaction.id).where(Transaction.company_id == company_id,
                                         Transaction.external_id == new_ext)
        )).first()
        if clash:
            notes.append(f"{t.external_id}: {new_ext} уже существует, не тронуто")
            continue
        t.external_id = new_ext
        t.recurring_expense_id = exp.id
        t.category_id = cat.id
        t.fuel_type = fuel_type_for(cat.section, cat.code)
        t.expense_type = "recurring"
        t.periodicity = "monthly"
        if kind == "trailer":
            t.trailer_plate = c.plate_number
        n += 1
    await db.flush()
    return n, notes


async def _move_tombstones(db, company_id, Tomb, c, exp) -> int:
    rows = (await db.execute(
        select(Tomb).where(Tomb.company_id == company_id, Tomb.contract_id == c.id)
    )).scalars().all()
    have = {r for (r,) in (await db.execute(
        select(RecurringExpenseTombstone.period_key).where(
            RecurringExpenseTombstone.company_id == company_id,
            RecurringExpenseTombstone.contract_id == exp.id)
    )).all()}
    n = 0
    for r in rows:
        if r.year_month in have:
            continue
        db.add(RecurringExpenseTombstone(
            company_id=company_id, contract_id=exp.id, period_key=r.year_month,
            external_id=f"rexp_{exp.id}_{r.year_month}",
        ))
        have.add(r.year_month)
        n += 1
    await db.flush()
    return n


async def legacy_counts(db: AsyncSession, company_id: int) -> dict:
    """Сколько старых договоров ещё не перенесено — для подсказки в интерфейсе."""
    out = {}
    for kind, (Contract, _t, _p) in KINDS.items():
        ids = [i for (i,) in (await db.execute(
            select(Contract.id).where(Contract.company_id == company_id))).all()]
        refs = {r for (r,) in (await db.execute(
            select(RecurringExpense.legacy_ref).where(
                RecurringExpense.company_id == company_id,
                RecurringExpense.legacy_ref.like(f"{kind}:%")))).all()}
        out[kind] = sum(1 for i in ids if legacy_ref(kind, i) not in refs)
    out["total"] = sum(out.values())
    return out
