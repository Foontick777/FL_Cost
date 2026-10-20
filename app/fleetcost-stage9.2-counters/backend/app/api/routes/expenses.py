import re
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field, field_validator
from datetime import datetime, date, time, timezone
from decimal import Decimal
from typing import Optional
from app.core.database import get_db
from app.api.deps import get_current_user, require_manager, get_request_context
from app.models.models import (
    User, Transaction, Vehicle, ExpenseCategory, RecurringExpense,
    RecurringTombstone, LeasingTombstone, TrailerTombstone, InsuranceTombstone,
    RecurringExpenseTombstone,
)
from app.schemas.schemas import CurrencyCode
from app.services import audit_service, fx_service, category_service
from app.services import fx_autoload, recurring_expense_service
from app.api.routes import trailers as trailer_service
from app.services.category_service import SECTIONS

from app.services.plates import normalize_trailer_plate

router = APIRouter(prefix="/expenses", tags=["expenses"])


class ManualExpenseCreate(BaseModel):
    """Единая форма «Добавить расход» (ТЗ §4).

    Новый путь (любой раздел): section + category_code (или category_id, или
    category_name для создания «на лету») + type = oneoff | recurring.
    Старый путь (`category="other_fine"`) продолжает работать без изменений —
    он превращается в пару (section, code) и дополнительно связывается с
    категорией, чтобы старые экраны и внешние вызовы API не сломались.
    """
    expense_date: date
    plate_number: Optional[str] = None
    # Прицеп — отдельное поле: прицепов нет в таблице vehicles, у них только номер.
    trailer_plate: Optional[str] = None
    description: Optional[str] = None
    # gt=0 и CurrencyCode — на стороне сервера, а не «в форме тоже есть
    # min=0»: прямым запросом к API можно было создать расход −500 EUR
    # или в валюте «ABC», и он попадал в отчёты как настоящий.
    amount: Optional[Decimal] = Field(default=None, gt=0)
    currency: CurrencyCode = "EUR"
    # ── Легаси-параметр (совместимость) ──
    category: Optional[str] = None      # "other_fine" | "general_other" | "salary_zus" | ...
    volume: Optional[Decimal] = Field(default=None, gt=0)    # liters, used for manual fuel entries
    country: Optional[str] = None       # ISO-2 code, e.g. "BY"
    # ── Новые параметры ──
    section: Optional[str] = None       # other | trailer | general | salary | salary_tax | insurance
    category_code: Optional[str] = None
    category_id: Optional[int] = None
    category_name: Optional[str] = None  # если категории нет — создаём с таким именем
    type: str = "oneoff"                # oneoff | recurring
    periodicity: Optional[str] = None   # monthly | quarterly | yearly | weekly
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    day_of_month: int = 1               # 1..28
    # Лимиты равны длинам колонок: без них длинный текст давал 500 от БД.
    # ── Полисные атрибуты (страхование) ──
    # Раньше форма их отправляла, а сервер молча отбрасывал: поля не были
    # объявлены в схеме, и конструктор договора их не передавал — данные
    # терялись без ошибки (дефект аудита stage9.1).
    country: Optional[str] = Field(default=None, max_length=60)
    policy_number: Optional[str] = Field(default=None, max_length=100)
    insurer: Optional[str] = Field(default=None, max_length=200)
    comment: Optional[str] = Field(default=None, max_length=500)
    document_ref: Optional[str] = Field(default=None, max_length=100)
    # ── Как задана сумма регулярного расхода ──
    # period — «столько за период»; yearly — «столько за год»;
    # total — «столько всего за total_periods списаний» (лизинг).
    input_amount: Optional[Decimal] = Field(default=None, gt=0)
    amount_mode: str = "period"
    # ge=0: отрицательный взнос не имеет смысла и молча игнорировался генерацией
    # (дефект аудита stage9.1); в /recurring-expenses ограничение уже было.
    down_payment: Optional[Decimal] = Field(default=None, ge=0)
    total_periods: Optional[int] = None

    @field_validator("amount_mode")
    @classmethod
    def _check_amount_mode(cls, v):
        v = (v or "period").strip().lower()
        if v not in ("period", "yearly", "total"):
            raise ValueError("amount_mode must be one of: total, yearly, period")
        return v

    @field_validator("type")
    @classmethod
    def _check_type(cls, v):
        v = (v or "oneoff").strip().lower()
        if v not in ("oneoff", "recurring"):
            raise ValueError("type must be 'oneoff' or 'recurring'")
        return v

    @field_validator("periodicity")
    @classmethod
    def _check_periodicity(cls, v):
        if v is None or not str(v).strip():
            return None
        v = str(v).strip().lower()
        if v not in ("monthly", "quarterly", "yearly", "weekly"):
            raise ValueError("periodicity must be one of: monthly, quarterly, yearly, weekly")
        return v


async def _resolve_expense_category(db: AsyncSession, company_id: int, data: "ManualExpenseCreate"):
    """Определить категорию расхода и её (section, code).

    Порядок: category_id → section+category_code → legacy `category` →
    section+category_name (создание «на лету»). Возвращает
    (category | None, section | None, code | None).
    """
    # 1. Явный id
    if data.category_id:
        cat = (await db.execute(
            select(ExpenseCategory).where(
                ExpenseCategory.id == data.category_id,
                ExpenseCategory.company_id == company_id,
            )
        )).scalar_one_or_none()
        if not cat:
            raise HTTPException(404, "Category not found")
        return cat, cat.section, cat.code

    # 2. Раздел + код (новый формат)
    if data.section and data.category_code:
        if data.section not in SECTIONS:
            raise HTTPException(400, f"section must be one of {', '.join(SECTIONS)}")
        cat = await category_service.resolve_category(
            db, company_id, data.section, data.category_code, name=data.category_name
        )
        return cat, (cat.section if cat else data.section), (cat.code if cat else data.category_code)

    # 3. Легаси `category` («other_fine», «general_other», …)
    if data.category:
        parsed = category_service.parse_legacy_category(data.category)
        if parsed:
            section, code = parsed
            # `manual_salary_*` — общий префикс для выплат и налогов; раздел
            # уточняем по уже заведённым категориям раздела salary_tax.
            if section == category_service.SECTION_SALARY:
                tax_codes = await category_service.active_salary_tax_codes(db, company_id)
                section = category_service.section_of_salary_code(code, tax_codes)
            cat = await category_service.resolve_category(db, company_id, section, code)
            return cat, section, code
        # Категории нет (fuel / adblue / income / unknown) — оставляем как есть.
        return None, None, None

    # 4. Только раздел + имя (создание категории «прямо из списка»)
    if data.section and data.category_name:
        code = category_service.code_for_name(data.category_name)
        cat = await category_service.resolve_category(
            db, company_id, data.section, code, name=data.category_name
        )
        return cat, cat.section, cat.code

    return None, None, None


@router.get("/trailer-plates")
async def trailer_plate_suggestions(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Номера прицепов, уже введённые в расходах и регулярных платежах компании.

    Подсказка для формы: общая для всех устройств и без отдельного справочника.
    Новые сверху (по последней дате расхода).
    """
    from sqlalchemy import func
    cid = current_user.company_id
    rows = (await db.execute(
        select(Transaction.trailer_plate, func.max(Transaction.transaction_date))
        .where(Transaction.company_id == cid,
               Transaction.trailer_plate.is_not(None),
               Transaction.trailer_plate != "",
               Transaction.source.in_(["manual", "recurring"]))
        .group_by(Transaction.trailer_plate)
    )).all()
    seen: dict[str, object] = {}
    for plate, last in rows:
        key = normalize_trailer_plate(plate)
        if key and (key not in seen or (last and last > seen[key])):
            seen[key] = last
    contracts = (await db.execute(
        select(RecurringExpense.trailer_plate).where(
            RecurringExpense.company_id == cid,
            RecurringExpense.trailer_plate.is_not(None))
    )).scalars().all()
    for plate in contracts:
        key = normalize_trailer_plate(plate)
        if key and key not in seen:
            seen[key] = None
    def _k(item):
        return (item[1] is not None, item[1].isoformat() if item[1] else "")
    ordered = [k for k, _ in sorted(seen.items(), key=_k, reverse=True)]
    return {"plates": ordered[:100]}


@router.post("/")
async def add_manual_expense(
    request: Request,
    data: ManualExpenseCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Добавить расход: разовый (Transaction) или регулярный (RecurringExpense).

    Owner или manager (viewer — 403). Регулярный расход сразу достраивает уже
    наступившие списания, чтобы после сохранения пользователь увидел операцию,
    а не пустой список.
    """
    company_id = current_user.company_id

    # Готовый системный набор должен существовать до первого расхода: иначе
    # расход записался бы в категорию, которой нет, и выпал бы из аналитики.
    await category_service.ensure_seeded(db, company_id)

    cat, section, code = await _resolve_expense_category(db, company_id, data)

    plate = (data.plate_number or "").strip().upper() or None
    trailer = normalize_trailer_plate(data.trailer_plate)
    # Расходы разделов «Общие расходы» и «Налоги» по смыслу принадлежат
    # компании — не привязываем их к автомобилю, если пользователь не указал его.
    # Прицепа нет в таблице vehicles, и вся существующая механика (страница
    # «Прицепы», группировка по прицепам, extractTrailerPlates) опознаёт прицеп
    # по `plate_number`. Поэтому номер прицепа кладём в то же поле — иначе
    # расход «потерялся» бы из карточки прицепа.
    if plate and trailer:
        # «Автомобиль + прицеп» одновременно — не объект, а два объекта:
        # расход переставал быть чьим-то конкретно и попадал в обе карточки.
        raise HTTPException(400, "Укажите либо автомобиль, либо прицеп, не оба")
    if trailer and not plate:
        plate = trailer

    # ── Проверки, которые раньше соблюдал только интерфейс ──────────────
    if cat is not None and not cat.is_active:
        # Отключённую категорию нельзя использовать для НОВЫХ расходов: иначе
        # кнопка «Отключить» ничего не значит. Импорт и уже созданные регулярные
        # списания отключённую категорию используют как и раньше — там путь другой.
        raise HTTPException(400, "Категория отключена — выберите активную или включите её в администрировании")
    # Прицеп из формы попадает в реестр: иначе добавленный вручную номер жил бы
    # только в этой строке и не появился бы в списке прицепов.
    # Только для раздела «Прицепы» или когда прицеп указан явно — иначе номер
    # машины из другого раздела попал бы в реестр как прицеп.
    if trailer or section == "trailer":
        candidate = trailer or plate
        if candidate:
            await trailer_service.ensure_trailer(db, company_id, candidate, origin="manual")

    if section and not category_service.object_allowed(section, bool(plate), bool(trailer)):
        raise HTTPException(
            400,
            f"Для раздела «{section}» такой объект не подходит: расходы этого раздела ведутся по компании",
        )

    # ── Регулярный расход ─────────────────────────────────────────────
    if data.type == "recurring":
        if not cat:
            raise HTTPException(
                400,
                "Для регулярного расхода нужна категория (category_id, либо "
                "section + category_code, либо section + category_name)",
            )
        frequency = data.periodicity or "monthly"
        start = data.start_date or data.expense_date
        if data.end_date and data.end_date < start:
            raise HTTPException(400, "end_date must be on or after start_date")
        if not (1 <= data.day_of_month <= 28):
            raise HTTPException(400, "day_of_month must be between 1 and 28")

        # Сумма может быть задана за период, за год или «всего за N списаний»
        # (лизинг). Расчёт общий с /recurring-expenses — см. plan_schedule.
        try:
            plan = recurring_expense_service.plan_schedule(
                start_date=start, frequency=frequency, day_of_month=data.day_of_month,
                amount=data.amount, input_amount=data.input_amount,
                amount_mode=data.amount_mode, down_payment=data.down_payment,
                total_periods=data.total_periods, end_date=data.end_date,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))

        vehicle_id = None
        if plate:
            v = (await db.execute(
                select(Vehicle).where(and_(
                    Vehicle.company_id == company_id, Vehicle.plate_number == plate
                ))
            )).scalar_one_or_none()
            vehicle_id = v.id if v else None

        contract = RecurringExpense(
            company_id=company_id,
            category_id=cat.id,
            vehicle_id=vehicle_id,
            trailer_plate=trailer,
            plate_number=plate or trailer,
            description=(data.description or "").strip() or cat.name,
            amount=plan["amount"],
            input_amount=plan["input_amount"],
            amount_mode=plan["amount_mode"],
            down_payment=plan["down_payment"],
            total_periods=plan["total_periods"],
            currency=data.currency,
            frequency=frequency,
            start_date=start,
            end_date=plan["end_date"],
            day_of_month=data.day_of_month,
            document_ref=(data.document_ref or "").strip() or None,
            comment=(data.comment or "").strip() or None,
            # Полисные атрибуты (страхование): раньше терялись при создании
            # через эту форму (дефект аудита stage9.1).
            country=(data.country or "").strip() or None,
            policy_number=(data.policy_number or "").strip() or None,
            insurer=(data.insurer or "").strip() or None,
            status="active",
            is_active=True,
            created_by=current_user.id,
        )
        db.add(contract)
        await db.flush()
        generated, _skipped = await recurring_expense_service.generate_for_contracts(
            db, company_id, [contract]
        )

        ctx = get_request_context(request)
        await audit_service.log(
            db, company_id=company_id, user=current_user, action="CREATE",
            entity_type="RecurringExpense", entity_id=contract.id,
            new_value={**audit_service.snapshot(contract), "generated_charges": generated},
            ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
        )
        await db.commit()
        await db.refresh(contract)
        # Списанные сейчас периоды могли попасть на даты, курса на которые ещё нет
        # (архив ЕЦБ докачивается по требованию) — тогда amount_eur остался NULL и
        # строка не попала бы в EUR-итоги. Доводим курсы до конца сразу, как это
        # делают синхронизации договоров; сбой докачки не ломает создание расхода.
        auto = await fx_autoload.auto_finish(company_id)
        return {"ok": True, "id": contract.id, "kind": "recurring",
                "generated": generated, "auto": auto}

    # ── Разовый расход ────────────────────────────────────────────────
    # Сумма обязательна: разовый платёж без суммы — это строка-призрак в
    # отчётах, которая выглядит как расход, но ничего не значит.
    if data.amount is None:
        raise HTTPException(400, "Укажите сумму расхода")

    vehicle_id = None
    if plate:
        result = await db.execute(
            select(Vehicle).where(and_(
                Vehicle.company_id == company_id,
                Vehicle.plate_number == plate,
            ))
        )
        vehicle = result.scalar_one_or_none()
        if vehicle:
            vehicle_id = vehicle.id

    fuel_type = (f"manual_{data.category}" if data.category and not section
                 else category_service.fuel_type_for(section, code) if section and code
                 else f"manual_{data.category or 'other'}")

    txn = Transaction(
        company_id=company_id,
        vehicle_id=vehicle_id,
        source="manual",
        external_id=f"manual_{company_id}_{datetime.now(timezone.utc).timestamp()}",
        transaction_date=datetime.combine(data.expense_date, time(0, 0, 0), tzinfo=timezone.utc),
        plate_number=plate,
        # Номер прицепа пишем и в саму операцию: по нему считаются «операции по
        # прицепу», переносится расход при исправлении опечатки и строится привязка.
        trailer_plate=(trailer if section == "trailer" else data.trailer_plate) or None,
        country=data.country.upper() if data.country else None,
        amount=data.amount,
        currency=data.currency,
        volume=data.volume,
        fuel_type=fuel_type,
        category_id=cat.id if cat else None,
        expense_type="oneoff",
        comment=(data.comment or "").strip() or None,
        document_ref=(data.document_ref or "").strip() or None,
        station_address=(data.description or "").strip() or (cat.name if cat else None),
        is_confirmed=True,
    )
    # Issue #3: populate fx_rate / amount_eur at insert time.
    await fx_service.backfill_transaction(txn, db)
    db.add(txn)
    await db.flush()

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=company_id,
        user=current_user,
        action="CREATE",
        entity_type="Transaction",
        entity_id=txn.id,
        new_value=audit_service.snapshot(txn),
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(txn)
    # Расход может быть датирован прошлым (курс на дату уже в архиве, но отрезок
    # ещё не докачан) или «неевровым» числом (курс только ручной). Проверка и
    # докачка здесь — чтобы строка не осталась без amount_eur и не выпала из
    # EUR-аналитики до следующего ночного прохода. auto_finish не бросает
    # исключений: расход уже создан, и сбой курсов не должен это отменять.
    auto = await fx_autoload.auto_finish(company_id)
    return {"ok": True, "id": txn.id, "kind": "transaction", "auto": auto}


class ManualExpensePatch(BaseModel):
    plate_number: Optional[str] = None  # None or "" to unassign, "BI855GS" to assign


class PaidToggle(BaseModel):
    """Отметка о факте оплаты начисления."""
    is_paid: bool


@router.post("/{txn_id}/paid")
async def set_paid(
    txn_id: int,
    data: PaidToggle,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Отметить начисление оплаченным или снять отметку.

    Почему «оплачено по умолчанию», а не «по подтверждению». Договоры в большинстве
    случаев оплачиваются (пользователь оценивает это как 95%), поэтому требовать
    подтверждения по каждой строке — работа, которая почти всегда заканчивается
    одинаково. Начисление сразу считается оплаченным, а опровергается точечно:
    нашёл нужную дату и снял отметку.

    Импортированные банковские операции менять нельзя: там оплата — факт из банка,
    а не наша оценка. Для них есть отдельный признак `is_confirmed`.
    """
    txn = (await db.execute(
        select(Transaction).where(Transaction.id == txn_id,
                                  Transaction.company_id == current_user.company_id)
    )).scalar_one_or_none()
    if not txn:
        raise HTTPException(404, "Transaction not found")
    if txn.source not in ("manual", "recurring"):
        raise HTTPException(
            400,
            "Это операция из внешнего источника — её оплату подтверждает банк, "
            "вручную отметку менять нельзя",
        )

    before = {"is_paid": bool(txn.is_paid)}
    txn.is_paid = bool(data.is_paid)

    # Если это списание договора — прогресс «оплачено N из M» пересчитывается сразу,
    # иначе карточка договора показывала бы устаревшее число.
    contract_id = txn.recurring_expense_id
    if contract_id is None and (txn.external_id or "").startswith("rexp_"):
        m = re.match(r"^rexp_(\d+)_", txn.external_id or "")
        contract_id = int(m.group(1)) if m else None
    if contract_id:
        contract = (await db.execute(
            select(RecurringExpense).where(RecurringExpense.id == contract_id,
                                           RecurringExpense.company_id == current_user.company_id)
        )).scalar_one_or_none()
        if contract:
            await db.flush()
            await recurring_expense_service.recount_paid_periods(db, contract)

    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user,
        action="update", entity_type="Transaction", entity_id=txn.id,
        old_value=before, new_value={"is_paid": bool(txn.is_paid)},
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True, "id": txn.id, "is_paid": bool(txn.is_paid)}


@router.patch("/{expense_id}")
async def patch_manual_expense(
    expense_id: int,
    request: Request,
    data: ManualExpensePatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Update plate_number on a manual/csv_income transaction (used for income binding).
    Owner or manager only (Issue #1)."""
    result = await db.execute(
        select(Transaction).where(
            Transaction.id == expense_id,
            Transaction.company_id == current_user.company_id,
            Transaction.source.in_(["manual", "csv_income"]),
        )
    )
    txn = result.scalar_one_or_none()
    if not txn:
        raise HTTPException(404, "Expense not found")

    old_snapshot = audit_service.snapshot(txn)
    new_plate = (data.plate_number or "").strip().upper() if data.plate_number else ""
    if new_plate:
        from app.models.models import Vehicle
        v_result = await db.execute(
            select(Vehicle).where(and_(
                Vehicle.company_id == current_user.company_id,
                Vehicle.plate_number == new_plate,
            ))
        )
        vehicle = v_result.scalar_one_or_none()
        txn.plate_number = new_plate
        txn.vehicle_id = vehicle.id if vehicle else None
    else:
        txn.plate_number = None
        txn.vehicle_id = None

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="UPDATE",
        entity_type="Transaction",
        entity_id=txn.id,
        old_value=old_snapshot,
        new_value=audit_service.snapshot(txn),
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(txn)
    return {"ok": True, "id": txn.id, "plate_number": txn.plate_number}


@router.delete("/{expense_id}")
async def delete_manual_expense(
    expense_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Delete a single manual / csv_income / recurring transaction.

    Owner or manager only (Issue #1). Used by:
      • ManualPage / GeneralPage «one-off other expense» rows
      • GeneralPage auto-generated recurring rows (when the user wants to
        delete a single monthly charge without cancelling the whole contract)

    When deleting a `recurring`-source transaction, a tombstone is recorded
    so the sync endpoint doesn't re-create the same monthly charge on the
    next page load.
    """
    result = await db.execute(
        select(Transaction).where(
            Transaction.id == expense_id,
            Transaction.company_id == current_user.company_id,
            Transaction.source.in_(["manual", "csv_income", "recurring"]),
        )
    )
    txn = result.scalar_one_or_none()
    if not txn:
        raise HTTPException(404, "Expense not found")

    old_snapshot = audit_service.snapshot(txn)

    # If this is a recurring auto-charge, mark the (year-month) as tombstoned
    # so sync doesn't recreate it. Four external_id formats:
    #   • recurring_{id}_{YYYY-MM}  → RecurringTombstone (general expenses)
    #   • leasing_{id}_{YYYY-MM}    → LeasingTombstone (vehicle leasing)
    #   • trailer_{id}_{YYYY-MM}    → TrailerTombstone (rented trailers)
    #   • insurance_{id}_{YYYY-MM}  → InsuranceTombstone (vehicle insurance)
    if txn.source == "recurring" and txn.external_id:
        parts = txn.external_id.split("_")
        if len(parts) >= 3:
            try:
                contract_id = int(parts[1])
                year_month = parts[2]
                prefix = parts[0]
                if prefix == "leasing":
                    existing = await db.execute(
                        select(LeasingTombstone).where(
                            LeasingTombstone.contract_id == contract_id,
                            LeasingTombstone.year_month == year_month,
                        )
                    )
                    if not existing.scalar_one_or_none():
                        db.add(LeasingTombstone(
                            company_id=current_user.company_id,
                            contract_id=contract_id,
                            year_month=year_month,
                            external_id=txn.external_id,
                        ))
                elif prefix == "trailer":
                    existing = await db.execute(
                        select(TrailerTombstone).where(
                            TrailerTombstone.contract_id == contract_id,
                            TrailerTombstone.year_month == year_month,
                        )
                    )
                    if not existing.scalar_one_or_none():
                        db.add(TrailerTombstone(
                            company_id=current_user.company_id,
                            contract_id=contract_id,
                            year_month=year_month,
                            external_id=txn.external_id,
                        ))
                elif prefix == "insurance":
                    existing = await db.execute(
                        select(InsuranceTombstone).where(
                            InsuranceTombstone.contract_id == contract_id,
                            InsuranceTombstone.year_month == year_month,
                        )
                    )
                    if not existing.scalar_one_or_none():
                        db.add(InsuranceTombstone(
                            company_id=current_user.company_id,
                            contract_id=contract_id,
                            year_month=year_month,
                            external_id=txn.external_id,
                        ))
                elif prefix == "rexp":
                    # Универсальный регулярный расход (любая категория).
                    existing = await db.execute(
                        select(RecurringExpenseTombstone).where(
                            RecurringExpenseTombstone.contract_id == contract_id,
                            RecurringExpenseTombstone.period_key == year_month,
                        )
                    )
                    if not existing.scalar_one_or_none():
                        db.add(RecurringExpenseTombstone(
                            company_id=current_user.company_id,
                            contract_id=contract_id,
                            period_key=year_month,
                            external_id=txn.external_id,
                        ))
                else:  # "recurring" — general expenses
                    existing = await db.execute(
                        select(RecurringTombstone).where(
                            RecurringTombstone.contract_id == contract_id,
                            RecurringTombstone.year_month == year_month,
                        )
                    )
                    if not existing.scalar_one_or_none():
                        db.add(RecurringTombstone(
                            company_id=current_user.company_id,
                            contract_id=contract_id,
                            year_month=year_month,
                            external_id=txn.external_id,
                        ))
            except (ValueError, IndexError):
                pass  # external_id format unexpected — just delete the txn

    await db.delete(txn)
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="DELETE",
        entity_type="Transaction",
        entity_id=expense_id,
        old_value=old_snapshot,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True}


# ── Bulk delete (multi-select in the Income table) ─────────────────
class BulkDeleteRequest(BaseModel):
    ids: list[int]


@router.post("/bulk-delete")
async def bulk_delete_expenses(
    body: BulkDeleteRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Delete multiple manual / csv_income / recurring transactions at once.
    Owner or manager only (Issue #1).

    Same security rules as the single-item DELETE:
      • Only transactions belonging to the current company are deleted
      • Only transactions with source in [manual, csv_income, recurring] are
        deleted (prevents deleting E100 / Q8 / auto-synced fuel transactions)
      • For `recurring`-source transactions, a tombstone is recorded so sync
        doesn't recreate the same monthly charge on the next page load.

    Returns {"ok": True, "deleted": N}. If a requested ID doesn't exist or
    doesn't belong to the current company, it's silently skipped (no error).
    """
    ids = body.ids or []
    if not ids:
        return {"ok": True, "deleted": 0}

    result = await db.execute(
        select(Transaction).where(
            Transaction.id.in_(ids),
            Transaction.company_id == current_user.company_id,
            Transaction.source.in_(["manual", "csv_income", "recurring"]),
        )
    )
    txns = result.scalars().all()

    for txn in txns:
        if txn.source == "recurring" and txn.external_id:
            parts = txn.external_id.split("_")
            if len(parts) >= 3:
                try:
                    contract_id = int(parts[1])
                    year_month = parts[2]
                    prefix = parts[0]
                    if prefix == "leasing":
                        existing = await db.execute(
                            select(LeasingTombstone).where(
                                LeasingTombstone.contract_id == contract_id,
                                LeasingTombstone.year_month == year_month,
                            )
                        )
                        if not existing.scalar_one_or_none():
                            db.add(LeasingTombstone(
                                company_id=current_user.company_id,
                                contract_id=contract_id,
                                year_month=year_month,
                                external_id=txn.external_id,
                            ))
                    elif prefix == "trailer":
                        existing = await db.execute(
                            select(TrailerTombstone).where(
                                TrailerTombstone.contract_id == contract_id,
                                TrailerTombstone.year_month == year_month,
                            )
                        )
                        if not existing.scalar_one_or_none():
                            db.add(TrailerTombstone(
                                company_id=current_user.company_id,
                                contract_id=contract_id,
                                year_month=year_month,
                                external_id=txn.external_id,
                            ))
                    elif prefix == "insurance":
                        existing = await db.execute(
                            select(InsuranceTombstone).where(
                                InsuranceTombstone.contract_id == contract_id,
                                InsuranceTombstone.year_month == year_month,
                            )
                        )
                        if not existing.scalar_one_or_none():
                            db.add(InsuranceTombstone(
                                company_id=current_user.company_id,
                                contract_id=contract_id,
                                year_month=year_month,
                                external_id=txn.external_id,
                            ))
                    elif prefix == "rexp":
                        # Универсальный регулярный расход (любая категория).
                        existing = await db.execute(
                            select(RecurringExpenseTombstone).where(
                                RecurringExpenseTombstone.contract_id == contract_id,
                                RecurringExpenseTombstone.period_key == year_month,
                            )
                        )
                        if not existing.scalar_one_or_none():
                            db.add(RecurringExpenseTombstone(
                                company_id=current_user.company_id,
                                contract_id=contract_id,
                                period_key=year_month,
                                external_id=txn.external_id,
                            ))
                    else:  # "recurring" — general expenses
                        existing = await db.execute(
                            select(RecurringTombstone).where(
                                RecurringTombstone.contract_id == contract_id,
                                RecurringTombstone.year_month == year_month,
                            )
                        )
                        if not existing.scalar_one_or_none():
                            db.add(RecurringTombstone(
                                company_id=current_user.company_id,
                                contract_id=contract_id,
                                year_month=year_month,
                                external_id=txn.external_id,
                            ))
                except (ValueError, IndexError):
                    pass  # external_id format unexpected — just delete the txn

        old_snapshot = audit_service.snapshot(txn)
        await db.delete(txn)
        ctx = get_request_context(request)
        await audit_service.log(
            db,
            company_id=current_user.company_id,
            user=current_user,
            action="DELETE",
            entity_type="Transaction",
            entity_id=txn.id,
            old_value=old_snapshot,
            ip=ctx["ip"],
            user_agent=ctx["user_agent"],
            client_id=ctx.get("client_id"),
        )

    await db.commit()
    return {"ok": True, "deleted": len(txns)}
