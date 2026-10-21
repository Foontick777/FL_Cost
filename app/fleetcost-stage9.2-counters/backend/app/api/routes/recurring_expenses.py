"""Универсальные регулярные расходы (ТЗ §8).

Любая активная категория любого раздела может быть разовой или регулярной.
Этот ресурс — «регулярный» вариант. В отличие от RecurringContract
(офис/бухгалтерия/стоянка с годовой суммой), здесь:

  • категория — любая (системная или созданная компанией);
  • объект — автомобиль (plate_number), прицеп (trailer_plate) или компания
    (оба поля пустые);
  • сумма задаётся ЗА ПЕРИОД: monthly / quarterly / yearly / weekly.

Списания создаются в `transactions` с source="recurring" и
external_id="rexp_{id}_{period}" — идемпотентно, с учётом tombstone-записей
(периоды, удалённые пользователем вручную, не воссоздаются).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, delete, func, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal
from typing import Optional

from app.core.database import get_db
from app.api.deps import get_current_user, require_manager, require_owner, get_request_context
from app.models.models import (
    User, Vehicle, RecurringExpense, RecurringExpenseTombstone,
    ExpenseCategory, Transaction,
)
from app.schemas.schemas import (
    RecurringExpenseCreate, RecurringExpenseUpdate, RecurringExpenseOut,
    RECURRING_EXPENSE_FREQUENCIES,
)
from app.services import audit_service, fx_autoload, fx_service, recurring_expense_service
from app.services.category_service import SECTIONS, resolve_category, COMPANY_LEVEL_SECTIONS
# Модуль нужен целиком: object_allowed и code_for_name вызываются из проверок.
from app.services import category_service

from app.services.plates import normalize_trailer_plate

import logging
logger = logging.getLogger(__name__)

router = APIRouter(prefix="/recurring-expenses", tags=["recurring-expenses"])


def _to_out(c: RecurringExpense, cat: Optional[ExpenseCategory],
            skipped: int = 0, stats: Optional[dict] = None,
            eur_rates: Optional[dict] = None) -> RecurringExpenseOut:
    out = RecurringExpenseOut.model_validate(c, from_attributes=True)
    if cat:
        out.section = cat.section
        out.code = cat.code
        out.category_name = cat.name
    _fill_schedule(out, c, skipped, stats, eur_rates=eur_rates)
    return out


async def _today_eur_rates(db: AsyncSession,
                           contracts: list[RecurringExpense]) -> dict[str, Decimal]:
    """Курсы валют договоров к EUR на сегодня — одним справочником на запрос.

    Остаток обязательств показывается и в валюте договора, и в евро. Пересчёт
    делается на сервере: фронтендовский fallback-словарь курсов устаревает, и
    KPI «Остаток обязательств» получался по нему (дефект аудита stage9.1).
    Валюты без курса в словарь не попадают — их остаток остаётся в исходной
    валюте без пересчёта.
    """
    currencies = sorted({(c.currency or "").upper() for c in contracts
                         if c.currency and c.currency.upper() != "EUR"})
    if not currencies:
        return {"EUR": Decimal("1")}
    rates: dict[str, Decimal] = {"EUR": Decimal("1")}
    for cur in currencies:
        rate, _d, _s = await fx_service.get_rate(cur, date.today(), db)
        if rate is not None:
            rates[cur] = rate
    return rates


def _fill_schedule(out: RecurringExpenseOut, c: RecurringExpense,
                   skipped: int = 0, stats: Optional[dict] = None,
                   eur_rates: Optional[dict] = None) -> None:
    """Досчитать то, что клиенту знать нужно, а выводить самому — нельзя.

    Остаток по договору и «приведено к месяцу» считаются в одном месте. Если
    отдать это фронтенду, разные экраны (страховка, прицепы, общие) начнут
    показывать разные остатки по одному и тому же договору — а расхождение в
    деньгах пользователь замечает сразу и перестаёт доверять цифрам.

    `eur_rates` — необязательный словарь {валюта: курс к EUR на сегодня}: без него
    EUR-остаток не считается (остаётся None), и фронтенд показывает валюту
    договора без пересчёта, вместо того чтобы делить на устаревший захардкоженный
    курс (дефект аудита stage9.1: KPI «Остаток обязательств» на вкладке лизинга
    считался по fallback-словарю фронтенда).
    """
    out.display_status = c.display_status
    out.total_periods = c.total_periods
    out.paid_periods = c.paid_periods or 0
    out.skipped_periods = skipped or 0
    if stats:
        out.created_periods = int(stats.get("created") or 0)
        out.paid_periods = int(stats.get("paid") or 0)
        out.unpaid_periods = int(stats.get("unpaid") or 0)
        # По фактическим неоплаченным списаниям, а не «сумма × количество»: в режиме
        # «всего за срок» последнее списание отличается на копейки.
        _us = stats.get("unpaid_sum")
        out.unpaid_amount = float(_us) if _us is not None else float((c.amount or 0) * out.unpaid_periods)
    else:
        # Статистику не передали — оставляем значение из договора. Обнулять его
        # нельзя: «оплачено 0 из 12» на карточке выглядит как реальный факт, хотя
        # это была всего лишь забытая выборка.
        out.paid_periods = int(c.paid_periods or 0)
    # Остаток = запланировано − оплачено − ПРОПУЩЕНО. Без третьего слагаемого
    # договор, который два месяца стоял на паузе, навсегда показывал «осталось 9»
    # вместо 7: пропущенные периоды никогда не будут оплачены, и считать их
    # будущими платежами — значит показывать долг, которого нет.
    left = recurring_expense_service.remaining_periods(c)
    if left is not None:
        left = max(0, left - (skipped or 0))
    out.remaining_periods = left
    if left is not None:
        out.remaining_amount = float(recurring_expense_service.schedule_remaining_amount(
            c, left, last_closed=bool((stats or {}).get("last_closed"))))
        out.remaining_period_amount = out.remaining_amount
    # Разовый взнос входит в обязательство, пока он впереди. Условие то же, по
    # которому он создаётся в генерации: до даты начала его в базе нет.
    down = Decimal(str(c.down_payment or 0))
    # …и пока он НЕ ОПЛАЧЕН: взнос после даты начала раньше молча выпадал из
    # «остатка обязательств», даже если оплату с него сняли (дефект аудита stage9.1).
    unpaid_dp = Decimal(str((stats or {}).get("unpaid_down_payment") or 0))
    ahead = bool(down > 0 and c.start_date and c.start_date > date.today())
    out.remaining_down_payment = float(down) if (ahead or unpaid_dp > 0) else 0.0
    out.remaining_total_obligation = float(
        (out.remaining_amount or 0) + (out.remaining_down_payment or 0))
    # Остаток в евро — по курсу на сегодня, если он известен (eur_rates передан
    # вызывающим маршрутом). Неизвестный курс — None: фронтенд покажет валюту
    # договора без пересчёта, а не подставит устаревший курс.
    rate = (eur_rates or {}).get((c.currency or "").upper())
    if rate:
        out.remaining_amount_eur = float(
            (Decimal(str(out.remaining_amount or 0))
             + Decimal(str(out.remaining_down_payment or 0))) * rate)
    # «Сколько это в месяц» — для итога блока «Регулярные платежи».
    per_year = recurring_expense_service.periods_per_year(c.frequency)
    out.monthly_amount = float(c.amount or 0) * per_year / 12 if per_year else float(c.amount or 0)
    # Ближайшее списание: следующая дата графика строго после последнего
    # созданного списания, но не раньше сегодняшнего дня и не за концом графика.
    if c.status == "active" and left:
        after = c.last_run_at or (c.start_date - timedelta(days=1))
        nxt = next((d for d in recurring_expense_service.iter_charge_dates(
            c.start_date, c.end_date, c.frequency, c.day_of_month) if d > after), None)
        if nxt is not None and c.total_periods and (c.paid_periods or 0) >= c.total_periods:
            nxt = None
        out.next_charge_date = nxt


async def _load_categories(db: AsyncSession, company_id: int, ids: list[int]) -> dict[int, ExpenseCategory]:
    if not ids:
        return {}
    rows = (await db.execute(
        select(ExpenseCategory).where(
            ExpenseCategory.company_id == company_id,
            ExpenseCategory.id.in_(ids),
        )
    )).scalars().all()
    return {c.id: c for c in rows}


@router.get("/", response_model=list[RecurringExpenseOut])
async def list_recurring(
    active_only: bool = Query(default=False),
    section: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None, description="active|paused|upcoming|completed|current"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Список регулярных расходов.

    Фильтр по состоянию применяется ПОСЛЕ вычисления состояния: `upcoming`,
    `completed` и `paused` — не то, что лежит в базе, а следствие дат и числа
    созданных списаний. Поэтому «Текущие» и «Будущие» нельзя выбрать в SQL —
    только посчитать и затем отобрать, что здесь и делается.
    """
    q = select(RecurringExpense).where(RecurringExpense.company_id == current_user.company_id)
    if active_only:
        q = q.where(RecurringExpense.status == "active")
    q = q.order_by(RecurringExpense.created_at.desc())
    rows = (await db.execute(q)).scalars().all()
    cats = await _load_categories(db, current_user.company_id, [r.category_id for r in rows])
    # Пропущенные периоды — одним запросом на страницу, а не N запросов.
    _skip_map = await recurring_expense_service.skipped_map(db, current_user.company_id)
    # Оплата/неоплата — тоже одной картой на всю страницу, а не запросом на договор.
    _stats = await recurring_expense_service.charge_stats_map(db, current_user.company_id, list(rows))
    _eur = await _today_eur_rates(db, list(rows))
    out = [_to_out(r, cats.get(r.category_id), _skip_map.get(r.id, 0), _stats.get(r.id),
                   eur_rates=_eur)
           for r in rows]
    if section:
        out = [o for o in out if o.section == section]
    if status:
        wanted = {s.strip().lower() for s in status.split(",") if s.strip()}
        if "current" in wanted:
            # «Текущие» на экране — это идущие и приостановленные: приостановленный
            # платёж всё ещё «в работе», пользователь его не завершал.
            wanted.discard("current")
            wanted |= {"active", "paused"}
        out = [o for o in out if o.display_status in wanted]
    return out


@router.post("/", response_model=RecurringExpenseOut)
async def create_recurring(
    request: Request,
    data: RecurringExpenseCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Создать регулярный расход и сразу достроить уже наступившие списания.

    Пользователь не должен нажимать «синхронизировать» после создания: если
    дата начала уже прошла, первое списание обязано появиться в списке сразу.
    """
    company_id = current_user.company_id
    if data.end_date and data.end_date < data.start_date:
        raise HTTPException(400, "end_date must be on or after start_date")
    if data.frequency not in RECURRING_EXPENSE_FREQUENCIES:
        raise HTTPException(400, f"frequency must be one of {sorted(RECURRING_EXPENSE_FREQUENCIES)}")

    # ── Категория: по id, по section+code или создаём новую ──
    cat: Optional[ExpenseCategory] = None
    if data.category_id:
        cat = (await db.execute(
            select(ExpenseCategory).where(
                ExpenseCategory.id == data.category_id,
                ExpenseCategory.company_id == company_id,
            )
        )).scalar_one_or_none()
        if not cat:
            raise HTTPException(404, "Category not found")
    elif data.section and data.code:
        if data.section not in SECTIONS:
            raise HTTPException(400, f"section must be one of {', '.join(SECTIONS)}")
        cat = await resolve_category(db, company_id, data.section, data.code)
    if not cat:
        raise HTTPException(400, "category_id или (section + code) обязательны")

    # ── Объект: автомобиль / прицеп / компания ──
    vehicle_id = None
    plate = (data.plate_number or "").strip().upper() or None
    trailer = normalize_trailer_plate(data.trailer_plate)
    if plate:
        v = (await db.execute(
            select(Vehicle).where(Vehicle.company_id == company_id, Vehicle.plate_number == plate)
        )).scalar_one_or_none()
        vehicle_id = v.id if v else None
        trailer = None
    elif trailer:
        plate = None
    # Общие расходы и налоги по смыслу принадлежат компании: привязку к авто
    # не выдумываем, но если её явно передали — не спорим с пользователем.
    if cat.section in COMPANY_LEVEL_SECTIONS and not plate and not trailer:
        vehicle_id = None

    description = (data.description or "").strip()
    if not description:
        description = cat.name

    # ── Те же проверки, что и в форме расхода (§4, §6 ревью) ──────────────
    # Отдельный endpoint — это тоже вход в систему, и правило должно быть одно.
    # Пока проверок здесь не было, прямым запросом к API можно было создать
    # «Аренду офиса → BI422GV» или налог, привязанный к автомобилю, и в отчётах
    # это выглядело как настоящий расход.
    if not cat.is_active:
        raise HTTPException(400, "Категория отключена — выберите активную или включите её")
    if not category_service.object_allowed(
            cat.section, bool(plate), bool(trailer), plate_is_vehicle=bool(vehicle_id)):
        raise HTTPException(
            400,
            "Для этой категории такой объект не подходит: расходы раздела ведутся по компании",
        )

    # ── Сумма и границы графика — одним расчётом на все точки создания ──
    freq = data.frequency
    try:
        plan = recurring_expense_service.plan_schedule(
            start_date=data.start_date,
            frequency=freq,
            day_of_month=data.day_of_month,
            amount=data.amount,
            input_amount=data.input_amount,
            amount_mode=data.amount_mode,
            down_payment=data.down_payment,
            total_periods=data.total_periods,
            end_date=data.end_date,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    amount = plan["amount"]
    input_amount = plan["input_amount"]
    mode = plan["amount_mode"]
    total_periods = plan["total_periods"]
    end_date = plan["end_date"]

    contract = RecurringExpense(
        company_id=company_id,
        category_id=cat.id,
        vehicle_id=vehicle_id,
        trailer_plate=trailer,
        plate_number=plate or trailer,
        description=description,
        amount=amount,
        input_amount=input_amount,
        amount_mode=mode,
        down_payment=Decimal(str(data.down_payment or 0)),
        total_periods=total_periods,
        currency=data.currency,
        frequency=freq,
        start_date=data.start_date,
        end_date=end_date,
        day_of_month=data.day_of_month,
        document_ref=(data.document_ref or "").strip() or None,
        comment=(data.comment or "").strip() or None,
        # Полисные атрибуты (страхование): схема их объявляла, но конструктор
        # не передавал — данные терялись молча (дефект аудита stage9.1).
        country=(data.country or "").strip() or None,
        policy_number=(data.policy_number or "").strip() or None,
        insurer=(data.insurer or "").strip() or None,
        status="active",
        is_active=True,
        created_by=current_user.id,
    )
    db.add(contract)
    await db.flush()

    # Сразу достраиваем наступившие списания.
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
    _skip_map = await recurring_expense_service.skipped_map(db, company_id)
    _st = await recurring_expense_service.charge_stats(db, contract)
    _eur = await _today_eur_rates(db, [contract])
    return _to_out(contract, cat, _skip_map.get(contract.id, 0), _st, eur_rates=_eur)


async def _get_contract(db: AsyncSession, company_id: int, contract_id: int) -> RecurringExpense:
    contract = (await db.execute(
        select(RecurringExpense).where(
            RecurringExpense.id == contract_id,
            RecurringExpense.company_id == company_id,
        )
    )).scalar_one_or_none()
    if not contract:
        raise HTTPException(404, "Recurring expense not found")
    return contract


async def _set_paused(db: AsyncSession, contract: RecurringExpense) -> None:
    contract.status = "paused"
    contract.paused_at = datetime.now(timezone.utc)
    contract.is_active = False   # зеркало для прежних запросов/индексов


@router.patch("/{contract_id}", response_model=RecurringExpenseOut)
async def update_recurring(
    contract_id: int,
    data: RecurringExpenseUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Изменить регулярный расход — влияет на БУДУЩИЙ график, не трогая прошлое.

    Почему так, а не «пересчитать всё». Уже созданные списания — это деньги,
    которые реально ушли. Если правка перепишет прошлые месяцы, отчёт за закрытый
    период изменится задним числом, и сданная отчётность перестанет сходиться.
    Поэтому прошедшие платежи остаются как есть, а изменения действуют на
    периоды, которые ещё не наступили (они в базе просто не созданы).

    Если из-за правки график сжался до уже оплаченных платежей, договор
    становится завершённым — состояние вычисляется по датам и числу оплат.
    """
    contract = await _get_contract(db, current_user.company_id, contract_id)
    before = audit_service.snapshot(contract)
    # Исходные значения графика запоминаем СРАЗУ. Простые поля (частота, день
    # списания) присваиваются ниже, до проверки блокировки, поэтому сравнение с
    # уже изменённым объектом всегда совпадало и запрет не срабатывал.
    orig_frequency, orig_start_date, orig_day_of_month = (
        contract.frequency, contract.start_date, contract.day_of_month)


    # ── Категория ──
    if data.category_id is not None:
        cat = (await db.execute(
            select(ExpenseCategory).where(
                ExpenseCategory.id == data.category_id,
                ExpenseCategory.company_id == current_user.company_id,
            )
        )).scalar_one_or_none()
        if not cat:
            raise HTTPException(404, "Category not found")
        # §6 ревью: отключённую категорию нельзя назначить и при правке — иначе
        # кнопка «Отключить» в администрировании ничего не значит.
        if not cat.is_active:
            raise HTTPException(400, "Категория отключена — выберите активную")
        contract.category_id = cat.id
    elif data.section and data.code:
        cat = await resolve_category(db, current_user.company_id, data.section, data.code)
        contract.category_id = cat.id

    # ── Объект ──
    if data.plate_number is not None or data.trailer_plate is not None:
        plate = (data.plate_number or "").strip().upper() or None
        trailer = normalize_trailer_plate(data.trailer_plate)
        if plate and trailer:
            raise HTTPException(400, "Укажите либо автомобиль, либо прицеп, не оба")
        if trailer and not plate:
            plate = trailer
        vehicle_id = None
        if plate:
            vehicle = (await db.execute(
                select(Vehicle).where(Vehicle.company_id == current_user.company_id,
                                      Vehicle.plate_number == plate)
            )).scalar_one_or_none()
            vehicle_id = vehicle.id if vehicle else None
        # §4 ревью: та же проверка области применения, что и при создании.
        # Без неё правкой можно было привязать «Аренду офиса» к автомобилю.
        cat_for_scope = (await db.execute(
            select(ExpenseCategory).where(ExpenseCategory.id == contract.category_id)
        )).scalar_one_or_none()
        if cat_for_scope and not category_service.object_allowed(
                cat_for_scope.section, bool(plate), bool(trailer),
                plate_is_vehicle=bool(vehicle_id)):
            raise HTTPException(
                400,
                "Для этой категории такой объект не подходит: расходы раздела ведутся по компании",
            )
        contract.plate_number = plate
        contract.trailer_plate = trailer
        contract.vehicle_id = vehicle_id

    # ── Простые поля ──
    if data.description is not None:
        contract.description = (data.description or "").strip() or contract.description
    if data.currency is not None:
        contract.currency = data.currency
    if data.frequency is not None:
        contract.frequency = data.frequency
    # P0-5: различаем «не прислали» / «прислали null» и для дня списания —
    # раньше сервер трактовал day_of_month=None как «не меняли», а клиент при
    # очистке поля подставлял день из даты начала, и правка молча сдвигала день
    # списания (или упиралась в блокировку §7). Теперь явный null = «вернуть
    # авто-день»: день берётся из даты начала, это НЕ считается изменением.
    fields_set = getattr(data, "model_fields_set", set())
    day_provided = "day_of_month" in fields_set
    if day_provided and data.day_of_month is None:
        new_day = start_auto_day = (data.start_date or contract.start_date).day
        contract.day_of_month = min(28, max(1, new_day))
        _day_is_autofallback = True
    elif data.day_of_month is not None:
        contract.day_of_month = data.day_of_month
        _day_is_autofallback = False
    else:
        _day_is_autofallback = False
    if data.document_ref is not None:
        contract.document_ref = (data.document_ref or "").strip() or None
    if data.comment is not None:
        contract.comment = (data.comment or "").strip() or None
    if data.country is not None:
        contract.country = (data.country or "").strip() or None
    if data.policy_number is not None:
        contract.policy_number = (data.policy_number or "").strip() or None
    if data.insurer is not None:
        contract.insurer = (data.insurer or "").strip() or None

    # ── График и сумма: пересчитываем тем же расчётом, что и при создании ──
    #
    # §7 ревью: частота, дата начала и день списания ЗАМОРАЖИВАЮТСЯ, как только по
    # договору есть хотя бы одно списание. Иначе смена, например, monthly→quarterly
    # меняет period_key уже созданных периодов, и следующая синхронизация создаёт
    # ВТОРОЕ списание за тот же месяц (было «2026-10» → стало «2026-Q4»): один
    # договор, два платежа в октябре. Полноценные версии графика (ScheduleVersion)
    # для FleetCost избыточны — проще не менять прошлое.
    locked = []
    if data.frequency is not None and data.frequency != orig_frequency:
        locked.append("частота")
    if data.start_date is not None and data.start_date != orig_start_date:
        locked.append("дата начала")
    if data.day_of_month is not None and data.day_of_month != orig_day_of_month:
        locked.append("день списания")
    elif day_provided and data.day_of_month is None and _day_is_autofallback:
        # P0-5: явная очистка поля = «вернуть авто-день». Если авто-день
        # совпадает с текущим сохранённым — изменения графика нет и блокировка
        # не нужна; если не совпадает — это реальная смена дня, трактуем её
        # так же, как явную (без этого дыра в §7: null обходил бы замок).
        if contract.day_of_month != orig_day_of_month:
            locked.append("день списания")
    if locked:
        existing_charges = (await db.execute(
            select(func.count()).select_from(Transaction).where(
                Transaction.company_id == current_user.company_id,
                Transaction.source == "recurring",
                func.substr(Transaction.external_id, 1, len(f"rexp_{contract.id}_"))
                == f"rexp_{contract.id}_",
            )
        )).scalar() or 0
        if existing_charges:
            raise HTTPException(
                400,
                "Уже есть списания (" + str(int(existing_charges)) + "), поэтому изменить "
                "нельзя: " + ", ".join(locked) + ". Изменение графика задним числом создало бы "
                "вторые списания за те же периоды. Остановите договор и создайте новый.",
            )

    start = data.start_date or contract.start_date
    # §9 ревью: отличаем «поле не прислали» от «прислали null». Без этого договор
    # нельзя было сделать бессрочным: frontend отправляет end_date=null, а сервер
    # считал это «не меняли» и оставлял прежнюю дату окончания.
    # P0-5: fields_set уже вычислен выше (блок дня списания) — повторный getattr
    # убран, поведение не меняется, но исключает расхождение двух копий одного
    # выражения при будущих правках.
    end_provided = "end_date" in fields_set
    if end_provided:
        end = data.end_date
    else:
        end = contract.end_date
    if end is not None and end < start:
        raise HTTPException(400, "Дата окончания раньше даты начала")
    # Сумма: если пользователь прислал новую — берём её, иначе текущую.
    amount_in = data.input_amount if data.input_amount is not None else None
    mode = data.amount_mode or contract.amount_mode or "period"
    if data.amount is not None and amount_in is None:
        # Аудит stage9.1 (критический дефект): форма при правке ВСЕГДА шлёт
        # amount_mode вместе с amount (для режима «за период» input_amount=null,
        # сумма уходит в amount). Прежнее условие требовало amount_mode is None —
        # и новая сумма молча игнорировалась, договор оставался со старой.
        # Теперь: amount без input_amount — валидный ввод для любого режима.
        if data.amount_mode is None:
            # Прежний способ ввода: amount = сумма за период.
            mode = "period"
        amount_in = data.amount
    elif amount_in is None and (data.amount_mode is not None or data.total_periods is not None):
        # Режим или число платежей поменяли, а сумму нет — берём прежнюю введённую.
        amount_in = contract.input_amount if contract.input_amount is not None else contract.amount
    if amount_in is None:
        amount_in = contract.input_amount if contract.input_amount is not None else contract.amount

    try:
        plan = recurring_expense_service.plan_schedule(
            start_date=start,
            frequency=contract.frequency,
            day_of_month=contract.day_of_month,
            # Именно input_amount: сумма уже разобрана выше (вместе с режимом), а
            # plan_schedule при пустом input_amount переключается на режим
            # «за период» — из-за этого «18 000 за 12 платежей» сохранялось как
            # «18 000 за период», и в списаниях оказывалась годовая сумма.
            input_amount=amount_in,
            amount_mode=mode,
            down_payment=(data.down_payment if data.down_payment is not None else contract.down_payment),
            # «Число платежей» тоже различаем: не прислали или прислали null.
            # Без этого договор нельзя сделать бессрочным — очистить число
            # платежей было нечем, и end_date пересчитывался по старому значению.
            total_periods=(data.total_periods if "total_periods" in fields_set
                           else contract.total_periods),
            # Именно `end`: выше он уже разобран с учётом «поле не прислали» /
            # «прислали null». Старое выражение здесь обнуляло эту логику — null
            # снова подменялся прежней датой, и бессрочным договор не становился.
            end_date=(end if (end_provided or not (data.total_periods if "total_periods" in fields_set else contract.total_periods)) else None),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))

    prev_total_periods = contract.total_periods
    prev_end_date = contract.end_date
    contract.start_date = start
    contract.amount = plan["amount"]
    contract.input_amount = plan["input_amount"]
    contract.amount_mode = plan["amount_mode"]
    contract.down_payment = plan["down_payment"]
    contract.total_periods = plan["total_periods"]
    # §8 ревью: если число платежей поменяли, дата окончания должна поехать за ним.
    # Иначе остаётся «24 платежа, конец 2030» — данные договора противоречат друг
    # другу, и по ним нельзя понять, когда обязательство закрывается.
    if plan["total_periods"]:
        if end_provided and data.end_date:
            # Дату прислали явно — plan_schedule уже проверил, что она согласуется
            # с числом платежей, и подменять её расчётной нельзя.
            contract.end_date = data.end_date
        elif (not end_provided and prev_end_date is not None
              and plan["total_periods"] == prev_total_periods and start == orig_start_date):
            # Частичная правка (комментарий, сумма…): график не менялся, и
            # сохранённая дата окончания остаётся как есть, а не «нормализуется».
            contract.end_date = prev_end_date
        else:
            computed_end = recurring_expense_service.nth_charge_date(
                start, contract.frequency, contract.day_of_month, plan["total_periods"])
            contract.end_date = computed_end or plan["end_date"]
    else:
        contract.end_date = plan["end_date"]

    await db.flush()
    # Оплачено/пропущено пересчитываем по факту: после правки график другой, а
    # прогресс должен соответствовать реальным списаниям.
    await recurring_expense_service.recount_paid_periods(db, contract)

    # Параметры — как в остальных маршрутах (ip/user_agent/client_id), а не
    # объект Request: у audit_service.log другая подпись.
    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user,
        action="update", entity_type="RecurringExpense", entity_id=contract.id,
        old_value=before, new_value=audit_service.snapshot(contract),
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(contract)
    cats = await _load_categories(db, current_user.company_id, [contract.category_id])
    _skip_map = await recurring_expense_service.skipped_map(db, current_user.company_id)
    _st = await recurring_expense_service.charge_stats(db, contract)
    _eur = await _today_eur_rates(db, [contract])
    return _to_out(contract, cats.get(contract.category_id), _skip_map.get(contract.id, 0), _st,
                   eur_rates=_eur)

@router.get("/{contract_id}/charges")
async def list_charges(
    contract_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Начисления договора — чтобы отметить конкретную дату оплаченной или нет.

    Ровно тот сценарий, о котором шла речь: договор внесён, начисления по прошлым
    датам считаются оплаченными, а по одной дате оплату опровергают — тогда она
    перестаёт числиться оплаченной и снова попадает в остаток обязательств.
    """
    contract = await _get_contract(db, current_user.company_id, contract_id)
    prefix = f"rexp_{contract.id}_"
    rows = (await db.execute(
        select(Transaction).where(
            Transaction.company_id == current_user.company_id,
            or_(
                and_(Transaction.recurring_expense_id.is_(None),
                     func.substr(Transaction.external_id, 1, len(prefix)) == prefix),
                Transaction.recurring_expense_id == contract.id,
            ),
            Transaction.source == "recurring",
        ).order_by(Transaction.transaction_date)
    )).scalars().all()
    out = []
    for t in rows:
        is_dp = (t.external_id or "").endswith("_dp")
        out.append({
            "id": t.id,
            "date": t.transaction_date.date().isoformat() if t.transaction_date else None,
            "amount": float(t.amount or 0),
            "currency": t.currency,
            "is_paid": bool(t.is_paid),
            "kind": "down_payment" if is_dp else "period",
        })
    return out


@router.patch("/{contract_id}/pause", response_model=RecurringExpenseOut)
async def pause_recurring(
    contract_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """«Остановить»: следующих списаний не будет.

    Именно остановка, а не удаление: график, прогресс («оплачено 6 из 12») и уже
    созданные списания сохраняются. Удаления нет — расходы прошлых периодов были
    в реальности, и стирать их вместе с кнопкой «пауза» нельзя.
    """
    contract = await _get_contract(db, current_user.company_id, contract_id)
    old = audit_service.snapshot(contract)
    await _set_paused(db, contract)
    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user, action="PAUSE",
        entity_type="RecurringExpense", entity_id=contract_id,
        old_value=old, new_value=audit_service.snapshot(contract),
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(contract)
    cats = await _load_categories(db, current_user.company_id, [contract.category_id])
    _skip_map = await recurring_expense_service.skipped_map(db, current_user.company_id)
    _st = await recurring_expense_service.charge_stats(db, contract)
    _eur = await _today_eur_rates(db, [contract])
    return _to_out(contract, cats.get(contract.category_id), _skip_map.get(contract.id, 0), _st,
                   eur_rates=_eur)


@router.patch("/{contract_id}/resume", response_model=RecurringExpenseOut)
async def resume_recurring(
    contract_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """«Продолжить»: списания возобновляются с ближайшего будущего периода.

    Периоды, попавшие в паузу, НЕ создаются задним числом. Иначе «остановил на
    месяц» означало бы «при возобновлении спишется сразу за три месяца» — то есть
    кнопка делала бы не то, что написано. Помечаем эти периоды так же, как
    удалённые вручную: механизм «этот период создавать не надо» в системе один,
    и он же защищает от повторного появления после синхронизации.
    """
    contract = await _get_contract(db, current_user.company_id, contract_id)
    old = audit_service.snapshot(contract)

    if contract.paused_at:
        paused_from = contract.paused_at.date()
        today = date.today()
        existing = {
            row[0] for row in (await db.execute(
                select(RecurringExpenseTombstone.external_id).where(
                    RecurringExpenseTombstone.company_id == current_user.company_id,
                    RecurringExpenseTombstone.contract_id == contract.id,
                )
            )).all()
        }
        # Периоды, по которым списание УЖЕ СОЗДАНО (в том числе в день паузы):
        # они оплачены/проведены, и помечать их «пропущенными» нельзя — счётчик
        # «пропущено» считал оплаченный период дважды (paid=1 и skipped=1,
        # дефект аудита stage9.1).
        prefix = f"rexp_{contract.id}_"
        charged = {
            row[0] for row in (await db.execute(
                select(Transaction.external_id).where(
                    Transaction.company_id == current_user.company_id,
                    Transaction.source == "recurring",
                    or_(
                        Transaction.recurring_expense_id == contract.id,
                        and_(Transaction.recurring_expense_id.is_(None),
                             func.substr(Transaction.external_id, 1, len(prefix)) == prefix),
                    ),
                )
            )).all()
        }
        for charge_date in recurring_expense_service.iter_charge_dates(
                contract.start_date, contract.end_date, contract.frequency, contract.day_of_month):
            if charge_date > today:
                break
            if charge_date < paused_from:
                continue
            ext_id = f"rexp_{contract.id}_{recurring_expense_service.period_key(contract.frequency, charge_date)}"
            if ext_id in existing or ext_id in charged:
                continue
            db.add(RecurringExpenseTombstone(
                company_id=current_user.company_id,
                contract_id=contract.id,
                period_key=recurring_expense_service.period_key(contract.frequency, charge_date),
                external_id=ext_id,
            ))

    contract.status = "active"
    contract.is_active = True
    contract.paused_at = None

    # Возобновили — сразу достраиваем то, что уже должно было списаться.
    await db.flush()
    await recurring_expense_service.generate_for_contracts(db, current_user.company_id, [contract])

    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user, action="RESUME",
        entity_type="RecurringExpense", entity_id=contract_id,
        old_value=old, new_value=audit_service.snapshot(contract),
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(contract)
    cats = await _load_categories(db, current_user.company_id, [contract.category_id])
    _skip_map = await recurring_expense_service.skipped_map(db, current_user.company_id)
    _st = await recurring_expense_service.charge_stats(db, contract)
    _eur = await _today_eur_rates(db, [contract])
    return _to_out(contract, cats.get(contract.category_id), _skip_map.get(contract.id, 0), _st,
                   eur_rates=_eur)


@router.patch("/{contract_id}/cancel", response_model=RecurringExpenseOut)
async def cancel_recurring(
    contract_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Прежнее имя остановки — оставлено, чтобы уже написанные вызовы не сломались."""
    return await pause_recurring(contract_id, request, db, current_user)


@router.delete("/{contract_id}")
async def delete_recurring(
    contract_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),   # PAY-01: было require_manager
):
    """Delete a recurring expense that has NO generated charges (created in error).

    PAY-01 (аудит stage8): удаление было доступно менеджеру и стирало ВСЕ
    списания договора, включая уже оплаченные, — проведённые операции исчезали
    из отчётов задним числом, а восстановить можно было только снапшот договора
    из журнала действий (но не каждое списание). Это противоречило и философии
    проекта («History is never lost»), и практике: категорию так удалить нельзя
    (409), пользователь удаляется мягко.

    Теперь:
      • удалять может только владелец (роль менеджера — операционная);
      • при наличии хотя бы одного списания — 409: история неизменяема,
        для остановки будущих начислений есть «Остановить» (PATCH /pause).
    """
    contract = (await db.execute(
        select(RecurringExpense).where(
            RecurringExpense.id == contract_id,
            RecurringExpense.company_id == current_user.company_id,
        )
    )).scalar_one_or_none()
    if not contract:
        raise HTTPException(404, "Recurring expense not found")

    # Списания нельзя удалять вместе с договором: это проведённые операции.
    # Порядок: считать по FK (индексно), легаси-строки — по точному префиксу.
    prefix = f"rexp_{contract_id}_"
    charges = (await db.execute(select(func.count()).select_from(Transaction).where(
        Transaction.company_id == current_user.company_id,
        Transaction.source == "recurring",
        or_(
            Transaction.recurring_expense_id == contract_id,
            and_(Transaction.recurring_expense_id.is_(None),
                 func.substr(Transaction.external_id, 1, len(prefix)) == prefix),
        ),
    ))).scalar() or 0
    if charges:
        raise HTTPException(
            409,
            f"У договора есть списания ({int(charges)}). Удаление стёрло бы "
            "проведённые операции. Используйте «Остановить» (PATCH /pause): "
            "история и прогресс сохранятся, новых списаний не будет.",
        )

    old = audit_service.snapshot(contract)
    # Договор без единого списания удалять безопасно: операций он не создавал.
    await db.execute(delete(RecurringExpenseTombstone).where(
        RecurringExpenseTombstone.contract_id == contract_id,
    ))
    await db.delete(contract)
    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user, action="DELETE",
        entity_type="RecurringExpense", entity_id=contract_id, old_value=old,
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True}


class SyncResponse(BaseModel):
    generated: int
    skipped: int
    # Результат автодогрузки курсов: без него регулярный валютный платёж
    # остался бы без amount_eur и не попал бы в EUR-суммы.
    auto: Optional[dict] = None


@router.post("/sync", response_model=SyncResponse)
async def sync_recurring(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Достроить все недостающие списания по активным регулярным расходам.

    Вызывается при открытии страницы, поэтому не зависит от выбранного периода:
    в базе всегда есть полный набор списаний до сегодняшнего дня, а фильтр по
    датам применяет уже фронтенд. Будущие периоды не создаются.
    """
    # Берём ВСЕ договоры компании, а не только активные: сервис сам пропускает
    # приостановленные и завершённые, зато пересчитывает по ним «оплачено N из M».
    # Иначе после паузы прогресс замирал бы на устаревшем числе.
    # Тот же путь, что и у ежедневной задачи планировщика: одна реализация —
    # одно поведение, и его не нужно искать в двух местах.
    generated, skipped = await recurring_expense_service.sync_company(current_user.company_id)
    auto = await fx_autoload.auto_finish(current_user.company_id)
    return SyncResponse(generated=generated, skipped=skipped, auto=auto)


@router.get("/legacy-status")
async def legacy_status(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Сколько договоров старого формата ещё не перенесено в регулярные платежи."""
    from app.services import legacy_migration_service
    return await legacy_migration_service.legacy_counts(db, current_user.company_id)


@router.post("/migrate-legacy")
async def migrate_legacy(
    apply: bool = Query(default=False, description="false — пробный прогон без изменений"),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Перенести договоры старого формата (лизинг, прицепы, страхование, общие) в
    регулярные платежи. По умолчанию — пробный прогон: отчёт тот же, изменений нет.
    Только владелец компании; затрагивает данные ТОЛЬКО его компании."""
    from app.services import legacy_migration_service
    report = await legacy_migration_service.migrate_company(
        db, current_user.company_id, apply=apply)
    if apply and report["migrated"]:
        ctx = get_request_context(request)
        await audit_service.log(
            db, company_id=current_user.company_id, user=current_user,
            action="migrate", entity_type="RecurringExpense", entity_id=0,
            old_value=None, new_value={k: report[k] for k in
                                       ("migrated", "already", "errors", "charges_relinked", "tombstones_moved")},
            ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
        )
        await db.commit()
        # Новые договоры могли не успеть получить списания за последние периоды.
        try:
            await recurring_expense_service.sync_company(current_user.company_id)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"post-migration sync failed: {e}")
    return report
