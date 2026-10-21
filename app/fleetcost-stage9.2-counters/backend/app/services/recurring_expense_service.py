"""Генерация списаний по универсальным регулярным расходам.

Отдельный сервис, потому что генерация нужна из двух мест:
  • POST /recurring-expenses/sync — кнопка/загрузка страницы;
  • POST /expenses/ (type=recurring) — сразу после создания регулярного
    расхода, чтобы пользователь увидел первое списание, не нажимая «синхр.».

Идемпотентность: у каждого списания есть `external_id` вида
`rexp_{contract_id}_{period_key}`, и он же является ключом дедупликации в
таблице transactions. Повторный вызов ничего не создаёт. Периоды, которые
пользователь удалил руками, помечены tombstone-записью и не воссоздаются.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable, Optional

# func нужен на уровне модуля: _charge_filter строится вне функций с сессией.
from sqlalchemy import select, func, and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    ExpenseCategory, RecurringExpense, RecurringExpenseTombstone, Transaction,
)
from app.services import fx_service
from app.services.category_service import fuel_type_for

FREQUENCIES = ("monthly", "quarterly", "yearly", "weekly")

# Горизонт для БЕССРОЧНОГО расхода (end_date = NULL).
#
# Зачем он нужен, если будущие списания всё равно не создаются (генерация
# останавливается на «сегодня»). Итератор дат — это не только часть генерации:
# его перебирают и другие места (например, поиск следующей даты списания), а
# любой перебор без `break` обязан КОНЧАТЬСЯ. Без горизонта бессрочный расход
# уводил итератор в год 10000 и падал с `ValueError: year 10000 is out of
# range` — генерацию спасал только `break` у вызывающего, то есть безопасность
# держалась на договорённости, а не на коде. Горизонт щедрый (до него не
# доживает ни один договор), но конечный.
HORIZON_DATE = date(2100, 12, 31)


def period_key(freq: str, d: date) -> str:
    """Ключ периода — часть external_id. Формат различается по частоте, чтобы
    годовой платёж не «размножился» на 12 месяцев."""
    if freq == "yearly":
        return f"{d.year}"
    if freq == "quarterly":
        return f"{d.year}-Q{(d.month - 1) // 3 + 1}"
    if freq == "weekly":
        iso = d.isocalendar()
        return f"{iso[0]}-W{iso[1]:02d}"
    return f"{d:%Y-%m}"


def iter_charge_dates(start: date, end: Optional[date], freq: str,
                      day_of_month: int) -> Iterable[date]:
    """Даты списаний от `start` до `end` (включительно) с шагом частоты.

    `end=None` — бессрочно. Итератор всё равно конечен (см. HORIZON_DATE), а
    вызывающий код останавливается раньше — обычно на «не позже сегодня», чтобы
    не создавать будущие списания.
    """
    if day_of_month < 1 or day_of_month > 28:
        day_of_month = 1
    if end is None:
        end = HORIZON_DATE
    if freq == "weekly":
        cur = start
        while True:
            if end is not None and cur > end:
                return
            yield cur
            cur = cur + timedelta(days=7)
        return

    step = {"monthly": 1, "quarterly": 3, "yearly": 12}.get(freq, 1)
    cur = date(start.year, start.month, day_of_month)
    while True:
        if end is not None and cur > end:
            return
        if cur >= start:
            yield cur
        # следующий период
        total = (cur.year * 12 + (cur.month - 1)) + step
        cur = date(total // 12, total % 12 + 1, day_of_month)


PERIODS_PER_YEAR = {"monthly": 12, "quarterly": 4, "yearly": 1, "weekly": 52}


def periods_per_year(freq: str) -> int:
    return PERIODS_PER_YEAR.get(freq, 12)


def compute_amount(amount_mode: str, input_amount, freq: str,
                   total_periods: Optional[int]):
    """Сумма ОДНОГО списания из того, что ввёл пользователь.

    Смысл в том, чтобы не заставлять человека делить в уме: «90 000 всего на 48
    месяцев» — это нормальная формулировка договора, и она должна вводиться
    как есть, а не превращаться пользователем в 1 875 ещё до ввода.

    Разовый взнос (`down_payment`) здесь НЕ вычитается из общей суммы: в
    договорах лизинга он идёт сверху («10 000 сейчас + 90 000 за 48 месяцев»),
    и вычитание испортило бы расчёт на ровном месте.

    Режим «всего за срок» округляет СУММУ СПИСАНИЯ ВНИЗ (ROUND_DOWN), а не
    «по правилам арифметики» (ROUND_HALF_UP). Причина: график обязан закрыть
    договор ровно — сумма обычных платежей не должна ПРЕВЫШАТЬ общую сумму.
    Округление вверх переплачивало: «всего 0.02 за 3 платежа» давало 3 × 0.01 =
    0.03 вместо 0.02 (дефект аудита stage9.1). С округлением вниз последний
    платёж (`last_period_amount`) добирает остаток, и итог сходится точно;
    а суммы, которые невозможно разбить на центы вообще (0.02 на 3 платежа),
    отклоняются ещё при создании — с понятной ошибкой «сумма платежа должна
    быть больше нуля», вместо молчаливой переплаты.
    """
    from decimal import Decimal, ROUND_HALF_UP, ROUND_DOWN
    value = Decimal(str(input_amount or 0))
    if amount_mode == "yearly":
        value = value / Decimal(periods_per_year(freq))
        return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if amount_mode == "total":
        n = total_periods or 0
        value = (value / Decimal(n)) if n > 0 else value
        return value.quantize(Decimal("0.01"), rounding=ROUND_DOWN)
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def count_periods(start: date, end: Optional[date], freq: str, day_of_month: int) -> Optional[int]:
    """Сколько списаний укладывается в отрезок [start, end]. NULL, если бессрочно."""
    if end is None:
        return None
    total = 0
    for _ in iter_charge_dates(start, end, freq, day_of_month):
        total += 1
        if total > 1200:      # защита от неверного ввода: 100 лет ежемесячных
            break
    return total


def last_period_amount(contract: RecurringExpense, index: int):
    """Сумма списания для периода №`index` (0 — первый).

    Для режима «всего за срок» последний платёж ЗАКРЫВАЕТ договор ровно: он
    равен `общая сумма − сумма предыдущих`. Иначе 10 000 за 3 платежа дают
    3 × 3 333,33 = 9 999,99, и в договоре навсегда остаётся «потерянная»
    копейка. Разница в копейку — не мелочь: именно из-за неё сумма платежей не
    сходится с суммой договора, и такой отчёт нельзя показать бухгалтеру.
    """
    amount = contract.amount
    if (contract.amount_mode == "total" and contract.total_periods
            and contract.input_amount is not None and contract.total_periods > 1
            and index == contract.total_periods - 1):
        rest = (Decimal(str(contract.input_amount))
                - Decimal(str(amount)) * Decimal(contract.total_periods - 1))
        if rest > 0:
            return rest.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return amount


def nth_charge_date(start: date, freq: str, day_of_month: int, n: int) -> Optional[date]:
    """Дата n-го списания — чтобы по «всего 48 платежей» получить дату окончания."""
    if not n or n < 1:
        return None
    for i, d in enumerate(iter_charge_dates(start, None, freq, day_of_month)):
        if i + 1 == n:
            return d
    return None


def plan_schedule(*, start_date: date, frequency: str, day_of_month: int,
                  amount=None, input_amount=None, amount_mode: str = "period",
                  down_payment=None, total_periods: Optional[int] = None,
                  end_date: Optional[date] = None) -> dict:
    """Свести ввод пользователя к сумме одного списания и границам графика.

    Один расчёт на все точки создания (страница и универсальная форма) — иначе
    «90 000 за 48 месяцев» считалось бы по-разному в двух местах, и это была бы
    ошибка, которую не видно в коде, но видно в деньгах.

    Бросает ValueError с понятным текстом — вызывающий превращает его в 400.
    """
    mode = (amount_mode or "period").strip().lower()
    if input_amount:
        inp = Decimal(str(input_amount))
    else:
        mode, inp = "period", Decimal(str(amount or 0))

    tp = total_periods
    if end_date and end_date < start_date:
        raise ValueError("дата окончания раньше даты начала")
    if tp is not None and tp < 1:
        raise ValueError("число платежей должно быть не меньше 1")
    if tp and end_date:
        # И число платежей, и дата окончания: они обязаны описывать один график.
        # Иначе сумма платежа считается из одного числа, а списаний создаётся
        # другое («12 000 за 12 платежей» при дате «до июня» — 6 списаний по 1 000).
        # Проверка на сервере: проверку формы обходит прямой запрос к API.
        fits = count_periods(start_date, end_date, frequency, day_of_month)
        if fits != tp:
            raise ValueError(
                f"число платежей ({tp}) не совпадает с датой окончания: до "
                f"{end_date:%d.%m.%Y} укладывается {fits}. Укажите что-то одно — "
                "второе рассчитается само")
    if tp is None and end_date:
        # Дату окончания дали, а число платежей нет — считаем сами: иначе
        # «оплачено 3 из ?» и остаток показать нечем.
        tp = count_periods(start_date, end_date, frequency, day_of_month)
        if not tp:
            raise ValueError("до указанной даты окончания не приходится ни одного платежа")
    if mode == "total" and not tp:
        raise ValueError("для суммы «всего за срок» укажите число платежей или дату окончания")

    per = compute_amount(mode, inp, frequency, tp)
    if per <= 0:
        raise ValueError("сумма платежа должна быть больше нуля")

    eff_end = end_date
    if eff_end is None and tp:
        d = nth_charge_date(start_date, frequency, day_of_month, tp)
        # График длиннее горизонта — считаем бессрочным, а не «до 2100 года».
        eff_end = None if d == HORIZON_DATE else d

    return {
        "amount": per,
        "input_amount": inp,
        "amount_mode": mode,
        "total_periods": tp,
        "end_date": eff_end,
        "down_payment": Decimal(str(down_payment or 0)),
    }


def remaining_periods(contract: RecurringExpense) -> Optional[int]:
    if not contract.total_periods:
        return None
    return max(contract.total_periods - (contract.paid_periods or 0), 0)


def remaining_amount(contract: RecurringExpense):
    """Сколько денег ещё предстоит списать по графику.

    Считается как «осталось списаний × сумма списания», а не «общая сумма минус
    оплачено»: так остаток сходится с фактическими будущими списаниями, даже
    если цену договора потом поправят.
    """
    return schedule_remaining_amount(contract, remaining_periods(contract))


def schedule_remaining_amount(contract: RecurringExpense, left: Optional[int],
                              last_closed: bool = False):
    """Сумма `left` оставшихся списаний ПО ФАКТИЧЕСКОМУ ГРАФИКУ.

    В режиме «всего за срок» последний платёж отличается от остальных (он закрывает
    договор ровно, см. last_period_amount). Остаток «платёж × число» на 10 000 за
    3 платежа давал 9 999,99 вместо 10 000,00. Последний платёж идёт в остаток
    всегда, пока остаётся хоть один непогашенный период.
    """
    if left is None:
        return None
    if left <= 0:
        return Decimal("0.00")
    base = Decimal(str(contract.amount or 0))
    tp = contract.total_periods
    if (contract.amount_mode == "total" and tp and tp > 1
            and contract.input_amount is not None and not last_closed):
        last = Decimal(str(last_period_amount(contract, tp - 1)))
        return base * (left - 1) + last
    return base * left


async def skipped_map(db: AsyncSession, company_id: int) -> dict[int, int]:
    """{contract_id: сколько периодов пропущено} по компании — одним запросом.

    Считаем по tombstones: именно они означают «этого периода не будет никогда»
    (пауза или удалённое списание). Разовый взнос (`dp`) периодом графика не
    является и в счётчик не входит.
    """
    from sqlalchemy import func
    rows = (await db.execute(
        select(RecurringExpenseTombstone.contract_id, func.count()).where(
            RecurringExpenseTombstone.company_id == company_id,
            RecurringExpenseTombstone.period_key != DOWN_PAYMENT_SUFFIX,
        ).group_by(RecurringExpenseTombstone.contract_id)
    )).all()
    return {cid: int(n or 0) for cid, n in rows}


def _charge_filter(contract: RecurringExpense, include_paid: Optional[bool] = None):
    """Условия «это списание данного договора, и это не разовый взнос».

    Основной путь — внешний ключ `recurring_expense_id` (индексный поиск). Для
    строк, созданных до появления ключа, остаётся запасной путь по префиксу
    external_id — но только когда ключ ПУСТОЙ, иначе строка другого договора могла
    бы попасть в подсчёт.
    """
    from sqlalchemy import and_, or_
    prefix = f"rexp_{contract.id}_"
    is_own = or_(
        and_(Transaction.recurring_expense_id.is_(None),
             func.substr(Transaction.external_id, 1, len(prefix)) == prefix),
        Transaction.recurring_expense_id == contract.id,
    )
    conds = [
        is_own,
        Transaction.source == "recurring",
        # Разовый взнос лежит в той же семье ключей (rexp_5_dp), но периодом не является.
        or_(Transaction.external_id.is_(None),
            func.substr(Transaction.external_id, len(prefix) + 1) != DOWN_PAYMENT_SUFFIX),
    ]
    if include_paid is True:
        conds.append(Transaction.is_paid == True)
    elif include_paid is False:
        conds.append(Transaction.is_paid == False)
    return and_(*conds)


async def charge_stats(db: AsyncSession, contract: RecurringExpense) -> dict:
    """{created, paid, unpaid, unpaid_sum, unpaid_down_payment, last_closed} по договору.

    `unpaid_sum` — сумма неоплаченных списаний В ЕВРО (по сохранённому amount_eur
    каждой строки). Раньше складывались исходные `amount` без учёта валюты: после
    смены валюты договора старый долг в PLN показывался как EUR, а «не оплачено»
    по договору со списаниями в разных валютах вообще не имело смысла
    (дефект аудита stage9.1). Строки без курса дают 0 — как во всех EUR-итогах
    проекта; о них предупреждает баннер «без курса».
    """
    from sqlalchemy import func
    rows = (await db.execute(
        select(Transaction.is_paid, func.count(), func.coalesce(func.sum(Transaction.amount_eur), 0))
        .where(_charge_filter(contract))
        .group_by(Transaction.is_paid)
    )).all()
    paid = sum(int(n or 0) for flag, n, _ in rows if flag)
    unpaid = sum(int(n or 0) for flag, n, _ in rows if not flag)
    unpaid_sum = sum(Decimal(str(v or 0)) for flag, _, v in rows if not flag)
    closed = await last_period_closed_ids(db, contract.company_id, [contract])
    stats = {"created": paid + unpaid, "paid": paid, "unpaid": unpaid,
            "unpaid_sum": unpaid_sum, "last_closed": contract.id in closed}
    # Разовый взнос, который уже создан, но НЕ оплачен: он остаётся обязательством
    # и после даты начала договора (раньше выпадал из «остатка обязательств» —
    # дефект аудита stage9.1).
    stats["unpaid_down_payment"] = await _unpaid_down_payment(db, contract)
    return stats


async def _unpaid_down_payment(db: AsyncSession, contract: RecurringExpense) -> Decimal:
    """Сумма неоплаченного разового взноса договора (0, если он оплачен/отсутствует).

    Взнос создаётся одной операцией с external_id `rexp_{id}_dp` (source=recurring,
    expense_type=oneoff). Проверяем её is_paid: после даты начала взнос больше не
    «будущий», но пока он не оплачен — это действующий долг.
    """
    down = Decimal(str(contract.down_payment or 0))
    if down <= 0:
        return Decimal("0")
    row = (await db.execute(
        select(Transaction.is_paid).where(
            Transaction.company_id == contract.company_id,
            Transaction.source == "recurring",
            Transaction.external_id == f"rexp_{contract.id}_dp",
        )
    )).first()
    if row is None:
        # Взнос ещё не создан (договор в будущем) — обязательство «взнос впереди»
        # учитывается отдельно, здесь он долгом не считается.
        return Decimal("0")
    return down if not row[0] else Decimal("0")


async def last_period_closed_ids(db: AsyncSession, company_id: int,
                                 contracts: list[RecurringExpense]) -> set[int]:
    """id договоров «всего за срок», у которых ПОСЛЕДНИЙ период уже закрыт:
    по нему есть списание или он пропущен (пауза/удаление, tombstone).

    Нужно остатку: корректировка последнего платежа (last_period_amount) входит в
    остаток, только пока последний период ещё впереди. Если он пропущен или уже
    списан, остаток — это обычные платежи без поправки.
    """
    keys: dict[str, tuple[int, str]] = {}
    for c in contracts:
        if c.amount_mode != "total" or not c.total_periods or c.total_periods < 2:
            continue
        d = nth_charge_date(c.start_date, c.frequency, c.day_of_month, c.total_periods)
        if d is None:
            continue
        pk = period_key(c.frequency, d)
        keys[f"rexp_{c.id}_{pk}"] = (c.id, pk)
    if not keys:
        return set()
    closed: set[int] = set()
    ext = (await db.execute(
        select(Transaction.external_id).where(
            Transaction.company_id == company_id,
            Transaction.external_id.in_(list(keys)))
    )).scalars().all()
    for e in ext:
        closed.add(keys[e][0])
    ids = [cid for cid, _ in keys.values()]
    tombs = (await db.execute(
        select(RecurringExpenseTombstone.contract_id, RecurringExpenseTombstone.period_key).where(
            RecurringExpenseTombstone.company_id == company_id,
            RecurringExpenseTombstone.contract_id.in_(ids))
    )).all()
    wanted = {v for v in keys.values()}
    for cid, pk in tombs:
        if (cid, pk) in wanted:
            closed.add(cid)
    return closed


async def charge_stats_map(db: AsyncSession, company_id: int,
                           contracts: list[RecurringExpense]) -> dict[int, dict]:
    """{contract_id: {created, paid, unpaid, unpaid_sum, unpaid_down_payment}} по компании.

    Одним групповым запросом (по ключу договора) плюс один проход по «старым»
    строкам без ключа — вместо запроса на каждый договор.

    `unpaid_sum` — В ЕВРО (по amount_eur строк), см. charge_stats: сложение
    исходных сумм без учёта валюты показывало долг в чужой валюте (дефект
    аудита stage9.1).
    """
    import re as _re
    from sqlalchemy import func
    ids = [c.id for c in contracts]
    out = {cid: {"created": 0, "paid": 0, "unpaid": 0, "unpaid_sum": Decimal("0"),
                 "unpaid_down_payment": Decimal("0"), "last_closed": False} for cid in ids}
    if not ids:
        return out
    rows = (await db.execute(
        select(Transaction.recurring_expense_id, Transaction.is_paid, func.count(),
               func.coalesce(func.sum(Transaction.amount_eur), 0))
        .where(Transaction.company_id == company_id,
               Transaction.source == "recurring",
               Transaction.recurring_expense_id.in_(ids),
               # Разовый взнос — не период графика: в счётчике «оплачено N из M» он
               # не участвует. Без этого условия взнос увеличивал прогресс на единицу.
               or_(Transaction.external_id.is_(None),
                   func.substr(Transaction.external_id,
                               func.length(Transaction.external_id) - 1) != DOWN_PAYMENT_SUFFIX))
        .group_by(Transaction.recurring_expense_id, Transaction.is_paid)
    )).all()
    for cid, flag, n, total in rows:
        if cid not in out:
            continue
        n = int(n or 0)
        out[cid]["created"] += n
        out[cid]["paid" if flag else "unpaid"] += n
        if not flag:
            out[cid]["unpaid_sum"] += Decimal(str(total or 0))

    legacy = (await db.execute(
        select(Transaction.external_id, Transaction.is_paid, Transaction.amount_eur)
        .where(Transaction.company_id == company_id,
               Transaction.source == "recurring",
               Transaction.recurring_expense_id.is_(None))
    )).all()
    for ext, flag, eur in legacy:
        m = _re.match(r"^rexp_(\d+)_(.+)$", ext or "")
        if not m:
            continue
        cid = int(m.group(1))
        if cid not in out or m.group(2) == DOWN_PAYMENT_SUFFIX:
            continue
        out[cid]["created"] += 1
        out[cid]["paid" if flag else "unpaid"] += 1
        if not flag:
            out[cid]["unpaid_sum"] += Decimal(str(eur or 0))
    for c in contracts:
        out[c.id]["unpaid_down_payment"] = await _unpaid_down_payment(db, c)
    for cid in await last_period_closed_ids(db, company_id, contracts):
        if cid in out:
            out[cid]["last_closed"] = True
    return out

async def companies_with_active_recurring() -> list[int]:
    """Компании, у которых есть активные регулярные расходы — для планировщика."""
    from app.core.database import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(RecurringExpense.company_id)
            .where(RecurringExpense.status == "active")
            .distinct()
        )).scalars().all()
    return [int(c) for c in rows]


async def sync_company(company_id: int, today: Optional[date] = None) -> tuple[int, int]:
    """Достроить списания компании и сохранить результат.

    Один вход для двух вызывающих: кнопка/загрузка страницы и ежедневная задача.
    Пока логика была продублирована, «прогресс не сохранялся, если новых списаний
    не было» — ошибка, которую пришлось искать отдельно; теперь путь один.
    """
    from app.core.database import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        contracts = (await db.execute(
            select(RecurringExpense).where(RecurringExpense.company_id == company_id)
        )).scalars().all()
        generated, skipped = await generate_for_contracts(db, company_id, list(contracts), today)
        # Коммит ВСЕГДА: синхронизация ещё и пересчитывает «оплачено N из M», и без
        # коммита пересчёт терялся именно тогда, когда новых списаний не было.
        await db.commit()
        return generated, skipped


async def recount_paid_periods(db: AsyncSession, contract: RecurringExpense) -> int:
    """Пересчитать, сколько списаний по графику реально существует.

    Не инкрементом, а запросом: инкремент расходится с базой при удалении
    отдельного списания, а «оплачено 7 из 12» из ниоткуда — это ровно тот вид
    ошибки, который подрывает доверие к остатку и прогрессу.
    """
    from sqlalchemy import func
    chain = _charge_filter(contract, include_paid=True)
    total = (await db.execute(
        select(func.count()).select_from(Transaction).where(
            # Разовый взнос в счётчик периодов не входит — он не период графика.
            chain,
        )
    )).scalar() or 0
    # paid_periods — именно ОПЛАЧЕННЫЕ периоды (is_paid=True), а не все созданные.
    contract.paid_periods = int(total)
    return contract.paid_periods


DOWN_PAYMENT_SUFFIX = "dp"


async def generate_for_contracts(
    db: AsyncSession,
    company_id: int,
    contracts: list[RecurringExpense],
    today: Optional[date] = None,
) -> tuple[int, int]:
    """Создать недостающие списания. Возвращает (создано, пропущено).

    Ничего не коммитит — это делает вызывающий (чтобы списание и запись в
    журнал действий попали в одну транзакцию). Исключение — если были вставки,
    вызывающий обязан сделать commit.
    """
    if not contracts:
        return (0, 0)
    today = today or date.today()

    cat_ids = {c.category_id for c in contracts}
    cats = {
        c.id: c for c in (await db.execute(
            select(ExpenseCategory).where(ExpenseCategory.id.in_(cat_ids))
        )).scalars().all()
    }

    # (платёж, категория, дата, external_id, сумма, тип операции, периодичность)
    expected: list[tuple[RecurringExpense, ExpenseCategory, date, str, Decimal, str, Optional[str]]] = []
    for c in contracts:
        cat = cats.get(c.category_id)
        if not cat:
            continue  # категория удалена — платёж продолжает жить, но списания не строим
        if (c.status or "active") != "active":
            # «Остановить» = следующих списаний не будет. График, прогресс и
            # история при этом сохраняются, поэтому это не удаление.
            continue

        # Разовый взнос в начале договора (например, первый взнос по лизингу).
        # Тип операции — «разовый»: он не входит в счётчик «оплачено N из M»,
        # иначе прогресс договора поехал бы на единицу в самом начале.
        # Разовый взнос — такой же платёж по графику, и до даты начала он не
        # существует. Без этой проверки договор с началом 01.01.2027 создавал
        # списание 10 000 EUR СЕГОДНЯ: деньги списывались раньше договора, и
        # отчёт показывал обязательство, которого ещё нет.
        if c.down_payment and c.down_payment > 0 and c.start_date <= today:
            expected.append((c, cat, c.start_date, f"rexp_{c.id}_{DOWN_PAYMENT_SUFFIX}",
                             c.down_payment, "oneoff", None))

        produced = 0
        for charge_date in iter_charge_dates(c.start_date, c.end_date, c.frequency, c.day_of_month):
            if c.total_periods and produced >= c.total_periods:
                break  # график выработан — дальше списаний нет
            if charge_date > today:
                break  # будущие списания не создаём (и дальше только позже)
            expected.append((c, cat, charge_date,
                             f"rexp_{c.id}_{period_key(c.frequency, charge_date)}",
                             last_period_amount(c, produced), "recurring", c.frequency))
            produced += 1

    async def _recount_all() -> None:
        """Пересчитать «оплачено N из M» по факту.

        Не инкрементом: инкремент расходится с базой, когда пользователь удаляет
        отдельное списание, и тогда на карточке остаётся неверный прогресс, а
        вместе с ним и неверный остаток. Поэтому всегда считаем по операциям.
        """
        for c in contracts:
            await recount_paid_periods(db, c)

    if not expected:
        # Считать всё равно нужно: у приостановленного договора новых списаний не
        # будет никогда, но прогресс у него обязан быть верным — иначе «оплачено
        # 6 из 12» замерзает на моменте паузы навсегда.
        await _recount_all()
        return (0, 0)

    ext_ids = [e[3] for e in expected]
    existing = {row[0] for row in (await db.execute(
        select(Transaction.external_id).where(
            Transaction.company_id == company_id,
            Transaction.external_id.in_(ext_ids),
        )
    )).all()}
    tombstoned = {row[0] for row in (await db.execute(
        select(RecurringExpenseTombstone.external_id).where(
            RecurringExpenseTombstone.company_id == company_id,
            RecurringExpenseTombstone.external_id.in_(ext_ids),
        )
    )).all()}

    generated = 0
    skipped = 0
    touched: dict[int, tuple[RecurringExpense, date]] = {}
    for contract, cat, charge_date, ext_id, amount, expense_type, periodicity in expected:
        if ext_id in existing or ext_id in tombstoned:
            skipped += 1
            continue
        txn = Transaction(
            company_id=company_id,
            vehicle_id=contract.vehicle_id,
            source="recurring",
            external_id=ext_id,
            # Связь хранится данными, а не разбором строки (см. модель).
            recurring_expense_id=contract.id,
            is_paid=True,  # начисление считается оплаченным, опровергается точечно
            transaction_date=datetime.combine(charge_date, time(0, 0, 0), tzinfo=timezone.utc),
            plate_number=contract.plate_number,
            # Как и у разового расхода прицепа: номер прицепа хранится и в
            # trailer_plate, иначе операции по прицепу считали бы не все списания.
            trailer_plate=contract.trailer_plate,
            country=None,
            amount=amount,
            currency=contract.currency,
            volume=None,
            fuel_type=fuel_type_for(cat.section, cat.code),
            category_id=cat.id,
            expense_type=expense_type,
            periodicity=periodicity,
            station_address=contract.description,
            document_ref=contract.document_ref,
            comment=contract.comment,
            is_confirmed=True,
        )
        try:
            # SAVEPOINT на одну операцию: уникальный индекс ловит повторный
            # external_id (в том числе от параллельного вызова), и без savepoint
            # ошибка откатила бы всю генерацию целиком.
            async with db.begin_nested():
                db.add(txn)
                await fx_service.backfill_transaction(txn, db)
        except IntegrityError:
            skipped += 1
            continue
        generated += 1
        if expense_type == "recurring":
            prev = touched.get(contract.id)
            if prev is None or charge_date > prev[1]:
                touched[contract.id] = (contract, charge_date)

    if generated:
        for contract, last_date in touched.values():
            contract.last_run_at = last_date
            contract.next_run_at = next(
                (d for d in iter_charge_dates(contract.start_date, contract.end_date,
                                              contract.frequency, contract.day_of_month)
                 if d > last_date),
                None,
            )
        await db.flush()

    await _recount_all()
    return (generated, skipped)
