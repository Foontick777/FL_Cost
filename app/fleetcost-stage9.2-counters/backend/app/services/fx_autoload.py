"""Автозагрузка недостающих курсов и автопересчёт сразу после синхронизации/импорта.

ЗАЧЕМ
-----
Курс подставляется в строку в МОМЕНТ её записи (`fx_service.backfill_transaction`)
и только на дату операции плюс окно 14 дней назад. Значит порядок «сначала курсы,
потом импорт» был обязательным — но нигде не проверялся. Импорт в базе без курсов
просто оставлял `amount_eur = NULL`: строка не попадала в суммы ни на дашборде, ни
во вкладках, а оператор узнавал об этом постфактум из предупреждения на дашборде.
Курс, загруженный позже, сам по себе тоже ничего не менял — надо было ещё
догадаться нажать «Пересчитать». После простоя сервера так терялась целая неделя
операций: даты этой недели не попали в таблицу курсов (ежедневная задача берёт
только последний опубликованный день), и строки оставались NULL навсегда.

ТЕПЕРЬ
------
Любое действие, которое пишет курсы или транзакции, само закрывает этот разрыв:

  1. смотрим, есть ли у компании строки без EUR (`amount_eur IS NULL`);
  2. если даты этих строк есть в архиве ЕЦБ — докачиваем ТОЛЬКО недостающий
     отрезок (`days_back`), а не весь архив: полная история (640 КБ, ~7000 дат) нужна
     один раз, а для недельного пропуска достаточно нескольких дней;
  3. пересчитываем строки, по которым курс теперь известен — и заодно те, где
     прежде подставился «ближайший» курс, хотя курс ровно на дату операции уже есть;
  4. отдаём сводку: что докачали, сколько строк пересчитали, что осталось без курса
     и НА КАКУЮ ДАТУ вводить курс вручную.

ЧТО ОСТАЁТСЯ РУЧНЫМ — И ПОЧЕМУ
------------------------------
* Валюты, которых нет в архиве ЕЦБ (BYN, RSD, UAH, MDL, GEL): источника не
  существует, закрыть автоматически нечем. Сводка называет конкретные даты, на
  которые нужно ввести курс вручную (см. `backfill_plan.build_unrated_detail`).
* Полный пересчёт (`force=true`) остаётся отдельной кнопкой: он нужен строкам, у
  которых `amount_eur` УЖЕ записан, но неверно (последствия прежней ошибки с
  направлением курса, FC-001), и специально требует осознанного нажатия. Здесь
  такие строки не трогаются — иначе «редкое и опасное» действие стало бы
  побочным эффектом обычной синхронизации.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import Date, and_, cast, func, or_, select

from app.core.database import AsyncSessionLocal
from app.models.models import FxRate, RecurringExpense, Transaction
from app.services import backfill_plan, fx_frankfurter, fx_service

logger = logging.getLogger(__name__)

# Валюты, которые ЕЦБ публикует в архиве `eurofxref-hist` (проверено по самому
# файлу: 42 колонки, выпуск от 2026-09-27). Нужен, чтобы не скачивать архив ради
# валюты, которой там заведомо нет: для BYN/RSD/UAH/MDL/GEL загрузка не поможет
# никогда, и повторять её на каждом импорте было бы чистой тратой времени.
#
# Часть кодов историческая (EEK, CYP, MTL, SIT, SKK, LTL, LVL) — страны перешли на
# евро, но операции прошлых лет в архиве есть, и закрывать их нужно оттуда.
ECB_CURRENCIES = frozenset({
    "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CYP", "CZK", "DKK", "EEK",
    "GBP", "HKD", "HRK", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW",
    "LTL", "LVL", "MTL", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "ROL",
    "RON", "RUB", "SEK", "SGD", "SIT", "SKK", "THB", "TRL", "TRY", "USD", "ZAR",
})

# Запас к отрезку докачки. Курс действует 14 дней назад от даты операции, поэтому
# «дырка», из-за которой строка осталась без EUR, может лежать немного раньше самой
# операции. Берём с запасом, чтобы одной докачки хватило и не понадобился второй
# заход (лишние дни стоят доли секунды, лишний заход — секунды).
DOWNLOAD_SLACK_DAYS = 45

# Ограничение на «докачивать не чаще раза в N минут на процесс». Защита от
# ситуации, когда архив недоступен: без неё каждый импорт ждал бы таймаут ЕЦБ.
DOWNLOAD_COOLDOWN_SECONDS = 600

_last_download_at: Optional[float] = None


# ──────────────────────────────────────────────────────────────────────────────
# Валюты вне ЕЦБ: автоматически из Frankfurter (см. fx_frankfurter.py)
# ──────────────────────────────────────────────────────────────────────────────
# (валюта, дата), по которым Frankfurter уже опрашивали в этом процессе. Без памяти
# дата, на которую у сервиса курса нет (до начала его данных, редкая валюта), снова
# и снова запускала бы загрузку на каждом заходе.
_frankfurter_checked: set = set()
FRANKFURTER_COOLDOWN_SECONDS = 600
_last_frankfurter_failure_at: Optional[float] = None
MANUAL_SYNC_MIN_INTERVAL = 20          # секунд между ручными загрузками одной компании
_manual_sync_at: dict = {}


async def auto_currencies() -> set[str]:
    """Валюты, которых нет в ЕЦБ, но есть во Frankfurter: курс подгружается сам."""
    sup = await fx_frankfurter.supported_currencies()
    return {c for c in sup if c not in ECB_CURRENCIES and c != "EUR"}


def _frankfurter_cooldown_passed(now: Optional[float] = None) -> bool:
    import time as _time
    now = _time.monotonic() if now is None else now
    if _last_frankfurter_failure_at is None:
        return True
    return (now - _last_frankfurter_failure_at) >= FRANKFURTER_COOLDOWN_SECONDS


def _mark_frankfurter_failure(now: Optional[float] = None) -> None:
    import time as _time
    global _last_frankfurter_failure_at
    _last_frankfurter_failure_at = _time.monotonic() if now is None else now


def reset_frankfurter_state() -> None:
    """Только для тестов."""
    global _last_frankfurter_failure_at
    _last_frankfurter_failure_at = None
    _frankfurter_checked.clear()
    _manual_sync_at.clear()


async def plan_frankfurter(unrated: dict, approx_by_currency: dict, auto: set[str]) -> dict:
    """Что именно докачивать из Frankfurter: {валюта: {"window": (с, по), "need": {даты}}}.

    Берутся даты строк без EUR и приблизительных строк, на которые в общей таблице
    ещё нет точного курса и которые мы не пробовали закрыть раньше. Только валюты,
    которые сервис знает (`auto`).
    """
    wanted: dict[str, set] = {}
    for code, info in (unrated or {}).items():
        if code in auto:
            wanted.setdefault(code, set()).update(info.get("dates") or ())
    for code, dates in (approx_by_currency or {}).items():
        if code in auto:
            wanted.setdefault(code, set()).update(dates)
    sup = await fx_frankfurter.supported_currencies()
    plan: dict = {}
    async with AsyncSessionLocal() as db:
        for code, dates in wanted.items():
            start_limit = (sup.get(code) or (None, None))[0]
            dates = {d for d in dates if d and (code, d) not in _frankfurter_checked
                     and (start_limit is None or d >= start_limit)}
            if not dates:
                continue
            have = {r[0] for r in (await db.execute(
                select(FxRate.rate_date).where(and_(
                    FxRate.currency == code, FxRate.company_id.is_(None),
                    FxRate.rate_date >= min(dates), FxRate.rate_date <= max(dates))))).all()}
            need = {d for d in dates if d not in have}
            if need:
                plan[code] = {"window": fx_frankfurter.window_for(min(need)), "need": need}
    return plan


async def currencies_in_use(company_id: Optional[int] = None) -> dict[str, Optional[date]]:
    """{валюта: самая ранняя дата операции} по операциям и регулярным платежам.
    Для одной компании или (company_id=None) для всех — ночной задаче."""
    out: dict[str, Optional[date]] = {}
    async with AsyncSessionLocal() as db:
        utc_date = _utc_date(db.get_bind())
        q = select(Transaction.currency, func.min(utc_date)).where(
            Transaction.currency.is_not(None), Transaction.currency != "EUR")
        if company_id is not None:
            q = q.where(Transaction.company_id == company_id)
        for cur, first in (await db.execute(q.group_by(Transaction.currency))).all():
            out[str(cur).upper()] = _coerce_date(first)
        q2 = select(RecurringExpense.currency, func.min(RecurringExpense.start_date)).where(
            RecurringExpense.currency.is_not(None), RecurringExpense.currency != "EUR")
        if company_id is not None:
            q2 = q2.where(RecurringExpense.company_id == company_id)
        for cur, first in (await db.execute(q2.group_by(RecurringExpense.currency))).all():
            code = str(cur).upper()
            first = _coerce_date(first)
            if code not in out or (first and (out[code] is None or first < out[code])):
                out[code] = first
    return out


async def sync_other_currencies(company_id: Optional[int], *, history: bool,
                                days: int = 7) -> dict:
    """Ручная/ночная загрузка валют вне ЕЦБ из Frankfurter.

    company_id задан — валюты ЭТОЙ компании (кнопки на странице курсов); None — все
    используемые в системе (ночная задача). Загруженные курсы общие (публичные
    данные), поэтому ничьи данные компании не затрагиваются.
    history=True — от самой ранней операции валюты; иначе — последние `days` дней.
    """
    if not fx_frankfurter.enabled():
        return {"status": "skipped", "source": fx_frankfurter.SOURCE, "results": [],
                "new_rows": 0, "updated_rows": 0, "message": "загрузка из Frankfurter отключена"}
    import time as _time
    if company_id is not None:
        now = _time.monotonic()
        last = _manual_sync_at.get(company_id)
        if last is not None and now - last < MANUAL_SYNC_MIN_INTERVAL:
            return {"status": "skipped", "source": fx_frankfurter.SOURCE, "results": [],
                    "new_rows": 0, "updated_rows": 0,
                    "message": "слишком часто: повторите через несколько секунд"}
        _manual_sync_at[company_id] = now
    auto = await auto_currencies()
    used = await currencies_in_use(company_id)
    today = date.today()
    plan = {}
    for code, first in used.items():
        if code not in auto:
            continue
        start = (first if (history and first) else today - timedelta(days=days))
        plan[code] = fx_frankfurter.window_for(start, today)
    if not plan:
        return {"status": "skipped", "source": fx_frankfurter.SOURCE, "results": [],
                "new_rows": 0, "updated_rows": 0, "message": None}
    summary = await fx_frankfurter.fetch_many(plan)
    if summary["status"] in ("error", "partial"):
        _mark_frankfurter_failure()
    return summary


# ──────────────────────────────────────────────────────────────────────────────
# Кто какие курсы может править вручную
# ──────────────────────────────────────────────────────────────────────────────
# Разделение по ВАЛЮТЕ, а не по роли целиком — и оно обязано жить на бэкенде.
#
# Менеджеру нужна страница курсов ради валют, которых в архиве ЕЦБ НЕТ (BYN, RSD,
# UAH, MDL, GEL): для них не существует источника, и без ручного ввода суммы в этих
# валютах не попадают в EUR-аналитику вообще.
#
# Но у валют ИЗ архива (PLN, USD, CZK…) есть официальный курс, и ручной ввод для них
# — это переопределение, которое перебивает ECB: поиск курса устроен как
# «company-specific manual → global ECB». Ошибка в таком курсе молча меняет все
# исторические суммы компании. Поэтому override — только у владельца.
#
# Проверка на сервере, а не в интерфейсе: скрытая кнопка защитой не является,
# эндпоинт вызывается и напрямую.
def role_name(role) -> str:
    """Имя роли строкой, чем бы она ни была.

    Из модели роль приходит перечислением (`UserRole.manager`), из тестов и старых
    вызовов — строкой. `str(UserRole.manager)` даёт «UserRole.manager», а не
    «manager», поэтому сравнивать через `str()` нельзя: владелец перестаёт
    опознаваться и не может переопределить курс PLN — то есть ровно то, что ему
    разрешено.
    """
    return str(getattr(role, "value", role) or "").lower()


def may_edit_currency(currency: Optional[str], role) -> bool:
    """Может ли эта роль задать курс валюты вручную."""
    code = str(currency or "").strip().upper()
    if not code:
        return False
    name = role_name(role)
    if name == "owner":
        return True
    if name != "manager":
        # viewer и всё остальное: только чтение.
        return False
    # Менеджер: лишь валюты, которых нет в архиве ЕЦБ.
    return code not in ECB_CURRENCIES


def currency_edit_refusal(currency: Optional[str]) -> str:
    """Понятное объяснение отказа вместо «403 Forbidden» без причины."""
    code = str(currency or "").strip().upper() or "этой валюты"
    return (f"Курс {code} есть в архиве ЕЦБ и подгружается автоматически, поэтому "
            f"вручную его может переопределить только владелец: это меняет уже "
            f"посчитанные исторические суммы. Менеджер может задать курс для валюты, "
            f"которой в архиве ЕЦБ нет (BYN, RSD, UAH, MDL, GEL).")


def starts_cooldown(downloaded: Optional[dict]) -> bool:
    """Нужно ли поставить паузу по итогам попытки докачки.

    Пауза нужна ровно против одной ситуации: архив ЕЦБ недоступен, и каждый импорт
    ждёт таймаут. После УСПЕШНОЙ докачки пауза вредна и опасна: она общая на процесс,
    поэтому повторный проход не понадобился бы (все даты уже есть — проверка покрытия
    отсекает загрузку), а вот импорт ДРУГОЙ компании в те же 10 минут остался бы без
    курсов и молча получил бы строки без EUR.
    """
    if downloaded is None:
        return False
    return downloaded.get("status") != "ok"


def _cooldown_passed(now: Optional[float] = None) -> bool:
    """Прошёл ли интервал с последней попытки докачки. Без обращений к сети."""
    import time as _time
    now = _time.monotonic() if now is None else now
    if _last_download_at is None:
        return True
    return (now - _last_download_at) >= DOWNLOAD_COOLDOWN_SECONDS


def _mark_download(now: Optional[float] = None) -> None:
    import time as _time
    global _last_download_at
    _last_download_at = _time.monotonic() if now is None else now


def reset_cooldown() -> None:
    """Только для тестов: снять паузу между докачками."""
    global _last_download_at
    _last_download_at = None


def ecb_currencies_in(codes) -> list[str]:
    """Какие из перечисленных валют вообще есть в архиве ЕЦБ (верхний регистр)."""
    return sorted({str(c).upper() for c in codes if c and str(c).upper() in ECB_CURRENCIES})


def only_manual_currencies(codes) -> list[str]:
    """Валюты, которых в архиве ЕЦБ нет — курс только вручную (BYN, RSD, UAH…)."""
    return sorted({str(c).upper() for c in codes if c and str(c).upper() not in ECB_CURRENCIES})


def days_back_for(earliest: Optional[date], today: Optional[date] = None) -> int:
    """Сколько дней назад докачивать, чтобы закрыть дату `earliest`.

    Полная история нужна один раз; для пропуска после простоя достаточно отрезка
    от самой ранней «бедной курсом» операции. Ограничение снизу нулём: если дата в
    будущем (или сегодня), берём только запас — `days_back=0` означал бы «весь
    архив», а это ровно тот медленный сценарий, который здесь и обходится.
    """
    if earliest is None:
        return 0
    today = today or date.today()
    return max((today - earliest).days, 0) + DOWNLOAD_SLACK_DAYS


def build_note(*, downloaded: Optional[dict], rates_added: int, recalculated: int,
               remaining: int, currencies: list[str], detail: Optional[list[dict]] = None,
               period: Optional[dict] = None) -> Optional[str]:
    """Однострочная сводка «что произошло само» или None, если делать было нечего.

    Отдельная функция без обращений к БД: текст — единственное, что видит оператор,
    и он должен быть проверяем без базы (как и остальные правила в backfill_plan).
    """
    if not downloaded and not rates_added and not recalculated and not remaining:
        return None
    parts: list[str] = []
    if downloaded and downloaded.get("status") == "ok" and rates_added:
        span = ""
        if downloaded.get("earliest_date") and downloaded.get("latest_date"):
            span = f" ({downloaded['earliest_date']} — {downloaded['latest_date']})"
        parts.append(f"курсы ЕЦБ докачаны{span}, добавлено значений: {rates_added}")
    if recalculated:
        parts.append(f"пересчитано строк: {recalculated}")
    if remaining:
        hint = backfill_plan.describe_unrated(currencies, period, detail)
        # Архив ответил, но нужных дат в нём не оказалось (например, операция
        # датирована будущим или раньше 1999 года). Без этой оговорки сообщение
        # «курсы докачаны, добавлено 0» выглядело бы как поломка докачки.
        if downloaded and downloaded.get("status") == "ok" and not rates_added:
            hint = ("в архиве ЕЦБ дат для этих строк нет — курс можно задать только "
                    "вручную. " + (hint or ""))
        parts.append(hint or f"осталось без EUR: {remaining}")
    elif rates_added or recalculated:
        parts.append("строк без курса не осталось")
    return " · ".join(parts) if parts else None


# ──────────────────────────────────────────────────────────────────────────────
# Сводка «что осталось без курса» — вход для докачки и для текста оператору
# ──────────────────────────────────────────────────────────────────────────────
def _utc_date(bind=None):
    """Дата операции в UTC — то же выражение, что в `scraper/service.py`.

    Именно так, а не `func.date(col)`: `cast(... as Date)` берёт таймзону СЕССИИ БД
    и около полуночи сдвигает дату на сутки. Для валютной строки это означает поиск
    курса не на ту дату, поэтому в проекте уже принято приведение к UTC явно.

    `bind` нужен ради переносимости: `timezone()` — функция PostgreSQL, на других
    СУБД (SQLite в локальных прогонах и проверках) её нет, и весь запрос падал с
    «no such function: timezone». Падение было не безобидным: оно срывало сводку
    «что осталось без курса», то есть ИМЕННО тот механизм, который должен
    сообщать, что суммы в EUR неполные. Здесь выбирается выражение по диалекту.
    """
    dialect = getattr(getattr(bind, "dialect", None), "name", None)
    if dialect == "sqlite":
        # БЕЗ `cast(..., Date)`: в SQLite типа DATE нет, и `CAST(дата AS DATE)`
        # превращает строку '2026-08-05' в ЧИСЛО 2026 — запрос падал на
        # разборе результата. Здесь возвращается строка ISO, а в date её
        # переводит `_coerce_date` уже в Python.
        return func.date(Transaction.transaction_date)
    return cast(func.timezone("UTC", Transaction.transaction_date), Date)


def _coerce_date(value):
    """Привести «дату операции» из базы к `date`.

    Нужно потому, что выражение даты зависит от СУБД: PostgreSQL отдаёт готовый
    `date`, SQLite — строку ISO. Дальше по коду ожидается именно дата (сравнения
    и арифметика по архиву курсов), поэтому приведение делается один раз здесь,
    а не разбросано по вызывающим.
    """
    if value is None or isinstance(value, date):
        return value
    if isinstance(value, datetime):
        return value.date()
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


# Даты, по которым докачку архива уже пробовали в этом процессе. Нужны против
# праздников: у ЕЦБ нет курса на 1 января и Страстную пятницу, это рабочие дни без
# публикации, и докачка их не закроет. Без памяти такая строка запускала бы
# скачивание архива при каждом заходе.
_approx_checked: set = set()
APPROX_SCAN_LIMIT = 2000


async def approx_overview(company_id: Optional[int] = None) -> dict:
    """Строки с EUR, посчитанные по курсу НЕ на дату операции, хотя дата — будний день
    и точного курса в базе нет.

    `unrated_overview` видит только строки без EUR. Но `get_rate` умеет подставить курс
    предыдущего дня (до 14 дней назад), и тогда `amount_eur` заполнен, строка перестаёт
    считаться «без курса», а докачка архива не запускается: точный курс так и не
    появляется, пока какая-нибудь другая строка не останется совсем без EUR.

    Субботы и воскресенья не считаются: у ЕЦБ курса на выходной не бывает, курс
    пятницы для них — норма, и качать там нечего. Только EUR-пересчитываемые валюты
    (архив ЕЦБ), BYN и подобные сюда не попадают — для них источника нет.
    """
    auto = await auto_currencies() if fx_frankfurter.enabled() else set()
    async with AsyncSessionLocal() as db:
        utc_date = _utc_date(db.get_bind())
        exact_exists = (
            select(FxRate.id)
            .where(
                FxRate.currency == Transaction.currency,
                FxRate.rate_date == utc_date,
                or_(FxRate.company_id == Transaction.company_id, FxRate.company_id.is_(None)),
            )
            .exists()
        )
        rows = (await db.execute(
            select(Transaction.currency, utc_date, func.count(Transaction.id))
            .where(
                Transaction.amount_eur.is_not(None),
                Transaction.fx_rate_date.is_not(None),
                Transaction.fx_rate_date != utc_date,
                Transaction.currency.in_(sorted(ECB_CURRENCIES | auto)),
                ~exact_exists,
                *( [Transaction.company_id == company_id] if company_id is not None else [] ),
            )
            .group_by(Transaction.currency, utc_date)
            .order_by(utc_date)
            .limit(APPROX_SCAN_LIMIT)
        )).all()
    dates: set = set()          # даты валют ЕЦБ
    currencies: set = set()     # валюты ЕЦБ
    by_currency: dict[str, set] = {}   # валюты Frankfurter: {код: {даты}}
    count = 0
    for currency, d, n in rows:
        d = _coerce_date(d)
        code = str(currency).upper()
        if d is None:
            continue
        if code in ECB_CURRENCIES:
            if d.weekday() >= 5 or d in _approx_checked:
                continue
            dates.add(d)
            currencies.add(code)
        else:
            # Frankfurter публикует курс и на выходные (BYN — посуточно), поэтому
            # выходные здесь НЕ пропускаются; пробованные даты помнит _frankfurter_checked.
            if (code, d) in _frankfurter_checked:
                continue
            by_currency.setdefault(code, set()).add(d)
        count += int(n or 0)
    other_dates = [d for ds in by_currency.values() for d in ds]
    all_dates = list(dates) + other_dates
    return {"rows": count, "dates": dates, "currencies": sorted(currencies),
            "by_currency": by_currency,
            "earliest": min(all_dates) if all_dates else None,
            "earliest_ecb": min(dates) if dates else None}


async def companies_with_approx_rows(limit: int = 200, days: int = 20) -> list[int]:
    """Компании, у которых за последние `days` дней есть строки с EUR по курсу НЕ на
    дату операции (будний день). Нужен ночной задаче курсов.

    Типичный случай: платёж «за сегодня» создан утром, курса ECB на сегодня ещё нет
    (его публикуют около 16:00 CET), и строка посчиталась по вчерашнему. Вечером
    задача загружает сегодняшний курс, но `companies_with_unrated_rows` такую
    компанию не видит — строка так и остаётся на вчерашнем курсе. Здесь они
    находятся, и их пересчитывают принудительно (rates_changed=True).
    """
    since = date.today() - timedelta(days=days)
    auto = await auto_currencies() if fx_frankfurter.enabled() else set()
    async with AsyncSessionLocal() as db:
        utc_date = _utc_date(db.get_bind())
        rows = (await db.execute(
            select(Transaction.company_id, utc_date, Transaction.currency)
            .where(
                Transaction.amount_eur.is_not(None),
                Transaction.fx_rate_date.is_not(None),
                Transaction.fx_rate_date != utc_date,
                Transaction.currency.in_(sorted(ECB_CURRENCIES | auto)),
                Transaction.company_id.is_not(None),
                utc_date >= since,
            )
            .group_by(Transaction.company_id, utc_date, Transaction.currency)
        )).all()
    out: list[int] = []
    for cid, d, cur in rows:
        d = _coerce_date(d)
        # Выходные: курса ECB на них не бывает, курс пятницы — норма. Для валют
        # Frankfurter выходной — обычный день с курсом.
        weekend_ok = str(cur).upper() in ECB_CURRENCIES
        if d is None or (weekend_ok and d.weekday() >= 5) or cid in out:
            continue
        out.append(cid)
        if len(out) >= limit:
            break
    return out


async def unrated_overview(company_id: Optional[int] = None) -> dict:
    """По каким валютам, на какие даты и в каком периоде у компании нет EUR.

    Форма — та, которую понимает `backfill_plan.build_unrated_detail`: оператору
    нужна КОНКРЕТНАЯ дата, а не только код валюты (курс действует вперёд, поэтому
    «ввести сегодня» старые строки не закрывает). Возвращает ещё и самую раннюю
    дату: по ней считается отрезок докачки из архива ЕЦБ.
    """
    unrated: dict[str, dict] = {}
    earliest: Optional[date] = None
    async with AsyncSessionLocal() as db:
        utc_date = _utc_date(db.get_bind())
        rows = (await db.execute(
            select(Transaction.currency, func.count(Transaction.id), func.min(utc_date))
            .where(
                Transaction.amount_eur.is_(None),
                Transaction.currency.is_not(None),
                *( [Transaction.company_id == company_id] if company_id is not None else [] ),
            )
            .group_by(Transaction.currency)
            .order_by(Transaction.currency)
        )).all()
        if not rows:
            return {"unrated": {}, "detail": [], "remaining": 0, "currencies": [],
                    "earliest": None, "period": None}

        for currency, count, first_date in rows:
            code = str(currency).upper()
            unrated[code] = {"rows": int(count or 0), "dates": set(), "truncated": False}
            first_date = _coerce_date(first_date)
            if first_date is not None and (earliest is None or first_date < earliest):
                earliest = first_date

        # Даты — вторым запросом и с ограничением: строк без курса может быть
        # десятки тысяч, а для подсказки нужен лишь минимальный набор дат.
        date_rows = (await db.execute(
            select(Transaction.currency, utc_date)
            .where(
                Transaction.amount_eur.is_(None),
                Transaction.currency.is_not(None),
                *( [Transaction.company_id == company_id] if company_id is not None else [] ),
            )
            .group_by(Transaction.currency, utc_date)
            .order_by(utc_date)
            .limit(backfill_plan.MAX_DATES_PER_CURRENCY * 4)
        )).all()
        limit = backfill_plan.MAX_DATES_PER_CURRENCY * 4
        truncated = len(date_rows) >= limit
        for currency, d in date_rows:
            code = str(currency).upper()
            d = _coerce_date(d)
            if d is None:
                continue
            info = unrated.setdefault(code, {"rows": 0, "dates": set(), "truncated": False})
            if len(info["dates"]) < backfill_plan.MAX_DATES_PER_CURRENCY:
                info["dates"].add(d)
            else:
                info["truncated"] = True

    all_dates = [d for info in unrated.values() for d in info["dates"]]
    detail = backfill_plan.build_unrated_detail(unrated)
    # `manual_only` = курс задаётся только руками (валюты нет в архиве ЕЦБ). Нужен
    # интерфейсу: менеджеру показываем поле ввода только для таких валют, для
    # остальных он всё равно получит 403 от сервера.
    auto = await auto_currencies() if fx_frankfurter.enabled() else set()
    for item in detail:
        code = str(item.get("currency") or "").upper()
        # `auto` — курс подгружается сам из Frankfurter; вручную его можно только
        # переопределить. `manual_only` остаётся для валют, которых нет нигде.
        item["auto"] = code in auto
        item["manual_only"] = code not in ECB_CURRENCIES and code not in auto
    return {
        "unrated": unrated,
        "detail": detail,
        "remaining": sum(info["rows"] for info in unrated.values()),
        "currencies": sorted(unrated.keys()),
        "earliest": earliest,
        "period": ({"from": str(min(all_dates)), "to": str(max(all_dates))}
                   if all_dates else None),
        "dates_truncated": truncated,
    }


async def needs_download(company_id: Optional[int] = None) -> dict:
    """Нужна ли докачка и какой отрезок. Без сети и без записи.

    Отдельная функция, потому что это единственное решение в модуле, которое стоит
    денег по времени: если валюты строк без курса в архиве ЕЦБ отсутствуют (BYN,
    RSD, UAH…), качать нечего, и мы этого не делаем.
    """
    overview = await unrated_overview(company_id)
    ecb = ecb_currencies_in(overview["currencies"])
    return {
        "needed": bool(ecb) and overview["remaining"] > 0,
        "ecb_currencies": ecb,
        "manual_currencies": only_manual_currencies(overview["currencies"]),
        "days_back": days_back_for(overview["earliest"]),
        "overview": overview,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Пересчёт строк, для которых курс теперь известен точнее
# ──────────────────────────────────────────────────────────────────────────────
def refine_filter_conditions(
    company_id: Optional[int] = None,
    *,
    include_null: bool = True,
    window: Optional[tuple[date, date]] = None,
    utc_date=None,
) -> list:
    """Условия отбора строк, которые стоит пересчитать — одним списком.

    Вынесено из `refine_company` отдельно, потому что это самая тонкая часть: что
    именно попадёт в пересчёт. Условия можно собрать и напечатать без базы
    (`tests/test_fx_autoload.py`), а значит, и проверить без неё.

    `utc_date` можно передать выражением — в тестах и в SQL он же; по умолчанию берётся
    стандартное приведение из `_utc_date()`.
    """
    utc_date = utc_date if utc_date is not None else _utc_date()
    # Курс есть ровно на дату операции (у компании — в приоритете, затем глобальный ЕЦБ).
    exact_exists = (
        select(FxRate.id)
        .where(
            FxRate.currency == Transaction.currency,
            FxRate.rate_date == utc_date,
            or_(FxRate.company_id == Transaction.company_id, FxRate.company_id.is_(None)),
        )
        .exists()
    )
    # Валюта, для которой курс вообще может появиться: либо она есть в архиве ЕЦБ,
    # либо у компании уже есть по ней ручной курс, либо существует ЛЮБОЙ другой курс
    # — например, глобальный курс Frankfurter для BYN/UAH (записывается с
    # company_id IS NULL). Раньше такой курс «переводимость» не подтверждал:
    # строка BYN, оставшаяся без EUR из-за недоступности Frankfurter при создании,
    # не пересчитывалась и после появления глобального курса за соседний день —
    # get_rate её переводить умеет, а фильтр отбрасывал (дефект аудита stage9.1).
    plausible = or_(
        Transaction.currency.in_(sorted(ECB_CURRENCIES)),
        select(FxRate.id)
        .where(FxRate.currency == Transaction.currency,
               FxRate.company_id == Transaction.company_id)
        .exists(),
        select(FxRate.id)
        .where(FxRate.currency == Transaction.currency,
               FxRate.company_id.is_(None))
        .exists(),
    )
    inexact = or_(Transaction.fx_rate_date.is_(None), Transaction.fx_rate_date != utc_date)
    # Строку трогаем, только если пересчёт может что-то ИЗМЕНИТЬ: она пустая и валюта
    # в принципе переводима, либо курс был взят не на дату операции, а точный уже есть.
    # Без второго условия в очередь вечно попадали бы субботние операции: у ЕЦБ курса
    # на субботу не бывает, они всегда считаются по пятнице и точными не станут.
    needle = or_(
        and_(Transaction.amount_eur.is_(None), plausible),
        and_(inexact, exact_exists),
    ) if include_null else and_(inexact, exact_exists)

    conds = [
        Transaction.currency != "EUR",
        needle,
        # Строка без суммы/даты не пересчитывается — это не «нет курса».
        Transaction.currency.is_not(None),
        Transaction.transaction_date.is_not(None),
    ]
    if company_id is not None:
        conds.append(Transaction.company_id == company_id)
    if window is not None:
        frm, to = window
        # ±1 день: в SQL дата считается по UTC, а поиск курса идёт по дате, которую
        # даёт Python (`transaction_date.date()`). На границе окна они могут разойтись
        # на сутки — лучше взять лишнюю строку, чем пропустить нужную. Лишняя строка
        # отсеется проверкой на стороне Python.
        conds.append(utc_date >= frm - timedelta(days=1))
        conds.append(utc_date <= to + timedelta(days=1))
    return conds


def select_refine_batch(company_id: Optional[int] = None, *, include_null: bool = True,
                        window: Optional[tuple[date, date]] = None,
                        after_id: Optional[int] = None, limit: int = 500, utc_date=None):
    """Запрос одного батча на пересчёт: по возрастающему `id`, не более `limit` строк.

    `utc_date` — выражение «дата операции в UTC»; передаётся из вызывающего кода,
    который знает диалект (см. `_utc_date`), иначе берётся вариант для PostgreSQL.
    """
    q = select(Transaction).where(
        and_(*refine_filter_conditions(company_id, include_null=include_null,
                                      window=window, utc_date=utc_date))
    )
    if after_id is not None:
        q = q.where(Transaction.id > after_id)
    return q.order_by(Transaction.id).limit(limit)


async def refine_company(
    company_id: Optional[int] = None,
    *,
    include_null: bool = True,
    window: Optional[tuple[date, date]] = None,
    batch_size: int = 500,
    max_batches: int = 200,
    time_budget_seconds: Optional[float] = 60.0,
) -> dict:
    """Пересчитывает строки, по которым курс стал известен.

    Что попадает в работу:

      • `amount_eur IS NULL` — строку раньше нечем было пересчитать (`include_null`);
      • курс взят «ближайшим назад», хотя курс ровно на дату операции уже есть —
        именно так выглядит неделя простоя: ежедневная задача берёт только последний
        опубликованный день, промежуточные даты пусты, и до докачки архива строки
        считались по курсу предыдущего дня.

    Чего здесь НЕТ: строк с уже записанным `amount_eur` и точной датой курса. Их
    пересчёт не изменил бы ничего, а «пересчитать всё заново» — отдельное осознанное
    действие (`force=true`) для строк, посчитанных неверно из-за прежней ошибки с
    направлением курса (FC-001).

    Обход — через `backfill_plan.drain_batches`: по возрастающему `id`, с лимитом
    времени и защитой от несдвигающегося курсора. Незавершённая работа не теряется:
    строки остаются как были и попадут в следующий заход.
    """
    counters = {"checked": 0, "recalculated": 0, "no_rate": 0, "failed": 0, "skipped_exact": 0}

    async def process_batch(after_id, limit):
        async with AsyncSessionLocal() as db:
            q = select_refine_batch(company_id, include_null=include_null,
                                    window=window, after_id=after_id, limit=limit,
                                    utc_date=_utc_date(db.get_bind()))

            txns = list((await db.execute(q)).scalars().all())
            if not txns:
                return []

            out = []
            for txn in txns:
                counters["checked"] += 1
                try:
                    op_date = (txn.transaction_date.date()
                               if hasattr(txn.transaction_date, "date") else txn.transaction_date)
                    # Строка уже посчитана точно на свою дату — пересчёт дал бы то же
                    # число. Проверка на стороне Python (а не только в SQL) ещё и
                    # снимает расхождение UTC-даты из SQL с датой из Python.
                    if txn.amount_eur is not None and txn.fx_rate_date == op_date:
                        counters["skipped_exact"] += 1
                        continue
                    before = txn.amount_eur
                    await fx_service.backfill_transaction(txn, db)
                    if txn.amount_eur is None:
                        counters["no_rate"] += 1
                        status = backfill_plan.NO_RATE
                    else:
                        if txn.amount_eur != before:
                            counters["recalculated"] += 1
                        status = backfill_plan.OK
                except Exception as e:  # noqa: BLE001 — строка не должна срывать обход
                    logger.warning(f"fx refine failed for txn {txn.id}: {e}")
                    counters["failed"] += 1
                    status = backfill_plan.FAILED
                ts = txn.transaction_date
                out.append((txn.id, status, txn.currency,
                            ts.date() if hasattr(ts, "date") else ts))
            await db.commit()
            return out

    summary = await backfill_plan.drain_batches(
        process_batch,
        batch_size=batch_size,
        max_batches=max_batches,
        time_budget_seconds=time_budget_seconds,
        log=logger.info,
    )
    return {**summary, **counters}


# ──────────────────────────────────────────────────────────────────────────────
# Точка входа для эндпоинтов: синхронизация, импорт, ручной курс
# ──────────────────────────────────────────────────────────────────────────────
async def ensure_rates_and_recalculate(
    company_id: Optional[int] = None,
    *,
    rates_changed: bool = False,
    allow_download: bool = True,
    force_download: bool = False,
) -> dict:
    """Доводит курсы и суммы до согласованного состояния после записи данных.

    Вызывается ПОСЛЕ того, как строки закоммичены, — из импорта, синхронизации e100,
    кнопок на странице курсов и после ручного ввода курса. Работает по одной схеме:

      1. смотрим, есть ли строки без EUR;
      2. если их валюты есть в архиве ЕЦБ — докачиваем недостающий отрезок
         (с паузой между попытками, чтобы недоступность ЕЦБ не тормозила каждый
         импорт);
      3. пересчитываем то, что стало считаться точнее;
      4. возвращаем сводку для ответа API.

    `rates_changed=True` передают те вызовы, которые сами только что записали курсы
    (кнопки на странице курсов, ручной ввод) — тогда пересчёт запускается даже без
    докачки: курсы уже изменились, и часть строк могла посчитаться точнее.

    Сеть и БД могут быть недоступны — это не должно ломать саму операцию импорта или
    синхронизации. Поэтому все сбои докачки возвращаются в сводке, а не исключением:
    строки просто останутся без EUR и попадут в следующий заход.
    """
    before = await unrated_overview(company_id)
    # Приблизительно посчитанные строки (курс предыдущего дня в будний день) тоже
    # повод проверить архив — см. approx_overview.
    approx = await approx_overview(company_id)
    downloaded: Optional[dict] = None
    rates_added = 0
    refined: Optional[dict] = None

    missing_ecb = ecb_currencies_in(before["currencies"])
    need_archive = bool(before["remaining"] and missing_ecb) or bool(approx["dates"])
    # Отрезок докачки ЕЦБ считается только по датам валют ЕЦБ: строка BYN трёхлетней
    # давности не должна тянуть окно архива ЕЦБ на годы.
    ecb_unrated_earliest = None
    if missing_ecb:
        ecb_dates = [d for c in missing_ecb for d in before["unrated"].get(c, {}).get("dates", ())]
        ecb_unrated_earliest = min(ecb_dates) if ecb_dates else before["earliest"]
    earliest_needed = min([d for d in (ecb_unrated_earliest, approx.get("earliest_ecb")) if d is not None],
                          default=None)
    if need_archive and allow_download and (force_download or _cooldown_passed()):
        missing_ecb = sorted(set(missing_ecb) | set(approx["currencies"]))
        days = days_back_for(earliest_needed)
        # Окно печатаем в лог: если импорт «задумался», по этой строке сразу видно,
        # что дело в объёме архива (одна строка 2023 года тянет окно на годы), а не
        # в самих данных. Полный архив (~7100 дат) грузится кнопкой, не отсюда.
        logger.info(f"fx auto: докачка курсов за {days} дн. (до {date.today()}), "
                    f"валюты: {', '.join(missing_ecb[:8])}")
        try:
            downloaded = await fx_service.fetch_and_store_historical_rates(days_back=days)
        except Exception as e:  # noqa: BLE001 — импорт важнее докачки курсов
            logger.warning(f"fx auto-download failed: {e}")
            downloaded = {"status": "error", "message": f"{type(e).__name__}: {e}"}
        if downloaded.get("status") == "ok":
            # Архив скачан целиком: если точного курса на эти даты всё равно нет,
            # это праздник ЕЦБ, и повторять докачку на каждый заход незачем.
            _approx_checked.update(approx["dates"])
        if starts_cooldown(downloaded):
            # Пауза ставится только после сбоя: она общая на процесс, и после успеха
            # задерживала бы импорт другой компании без всякой пользы.
            _mark_download()
        if downloaded.get("status") in ("ok", "partial"):
            rates_added = int(downloaded.get("new_rows") or 0) + int(downloaded.get("updated_rows") or 0)
            if rates_added:
                rates_changed = True

    # Валюты вне ЕЦБ: та же схема, источник — Frankfurter (см. fx_frankfurter.py).
    downloaded_other: Optional[dict] = None
    other_added = 0
    if allow_download and fx_frankfurter.enabled():
        try:
            auto = await auto_currencies()
            plan = await plan_frankfurter(before["unrated"], approx.get("by_currency", {}), auto)
            if plan and (force_download or _frankfurter_cooldown_passed()):
                logger.info("fx auto: Frankfurter, валюты: " + ", ".join(sorted(plan)[:8]))
                downloaded_other = await fx_frankfurter.fetch_many(
                    {c: v["window"] for c, v in plan.items()})
                ok_codes = {r["currency"] for r in downloaded_other["results"]
                            if r["status"] in ("ok", "unsupported")}
                for c in ok_codes:
                    # Даты, которых сервис так и не отдал, больше не опрашиваем.
                    for d in plan[c]["need"]:
                        _frankfurter_checked.add((c, d))
                if downloaded_other["status"] in ("error", "partial"):
                    _mark_frankfurter_failure()
                other_added = (int(downloaded_other.get("new_rows") or 0)
                               + int(downloaded_other.get("updated_rows") or 0))
                if other_added:
                    rates_added += other_added
                    rates_changed = True
        except Exception as e:  # noqa: BLE001 — импорт важнее докачки курсов
            logger.warning(f"fx frankfurter auto-download failed: {e}")
            downloaded_other = {"status": "error", "source": fx_frankfurter.SOURCE,
                                "message": f"{type(e).__name__}: {e}", "results": [],
                                "new_rows": 0, "updated_rows": 0}
            _mark_frankfurter_failure()

    # Курс этой валюты мог уже загрузить вызов другой компании или ночная задача:
    # курсы общие, а пересчёт строк — у каждой компании свой. Если у компании есть
    # строки без EUR в валюте Frankfurter и общие курсы по ней в базе уже есть —
    # пересчитываем, даже если сами ничего не докачивали.
    if not rates_changed and before["remaining"]:
        pending = [c for c in before["unrated"] if c not in ECB_CURRENCIES]
        if pending:
            async with AsyncSessionLocal() as db:
                have = (await db.execute(
                    select(FxRate.id).where(FxRate.currency.in_(pending),
                                            FxRate.company_id.is_(None)).limit(1))).first()
            if have:
                rates_changed = True

    if rates_changed:
        refined = await refine_company(company_id)

    after = await unrated_overview(company_id)
    note = build_note(
        downloaded=downloaded,
        rates_added=rates_added,
        recalculated=(refined or {}).get("recalculated", 0),
        remaining=after["remaining"],
        currencies=after["currencies"],
        detail=after["detail"],
        period=after["period"],
    )
    if downloaded is not None and downloaded.get("status") == "error":
        note = ("Курсы ЕЦБ докачать не удалось: " + str(downloaded.get("message") or "источник недоступен")
                + ". Нажмите «Пересчитать» после восстановления связи."
                + ((" " + note) if note else ""))

    if other_added and not (downloaded and downloaded.get("status") == "ok" and downloaded.get("new_rows")):
        note = (f"курсы Frankfurter загружены: {other_added}" + (" · " + note if note else ""))
    if downloaded_other is not None and downloaded_other.get("status") == "error":
        note = ("Курсы Frankfurter загрузить не удалось: "
                + str(downloaded_other.get("message") or "источник недоступен")
                + ((" · " + note) if note else ""))

    return {
        "ok": True,
        "downloaded": downloaded,
        "downloaded_other": downloaded_other,
        "rates_added": rates_added,
        "recalculated": (refined or {}).get("recalculated", 0),
        "refine": refined,
        "remaining": after["remaining"],
        # Сколько строк на момент проверки были посчитаны по курсу не на свою дату.
        "approximate_rows": approx["rows"],
        # Тот же разбор, что у кнопки «Пересчитать»: фронтенд рисует из него кнопки
        # «ввести курс» на конкретную дату, поэтому форма обязана совпадать.
        "unrated": after["detail"],
        "unrated_currencies": after["currencies"],
        "note": note,
    }


async def companies_with_unrated_rows(limit: int = 200) -> list[int]:
    """Компании, у которых есть строки без EUR. Нужен ежедневной задаче курсов.

    Без этого «сервер работает» не означало «суммы верные»: ежедневная задача
    приносила только курс последнего дня, а строки, оставшиеся без EUR из-за
    пропуска, ждали, пока человек нажмёт кнопку. Задача сама обходит компании и
    доводит их до согласованного состояния.
    """
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(Transaction.company_id)
            .where(Transaction.amount_eur.is_(None),
                   Transaction.currency.is_not(None),
                   Transaction.company_id.is_not(None))
            .group_by(Transaction.company_id)
            .limit(limit)
        )).all()
    return [r[0] for r in rows]


async def auto_finish(company_id: Optional[int] = None, **kwargs) -> dict:
    """`ensure_rates_and_recalculate`, но НИКОГДА не бросает исключение.

    Все вызовы идут из мест, где данные уже записаны (импорт, синхронизация,
    сохранение курса). Сбой докачки курсов — не повод показывать оператору ошибку
    вместо «импорт выполнен»: строки просто останутся без EUR и попадут в следующий
    заход, а причина вернётся в сводке. Поэтому исключение здесь превращается в
    результат, а не поднимается наверх.
    """
    try:
        return await ensure_rates_and_recalculate(company_id, **kwargs)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"fx auto-recalc failed: {e}", exc_info=True)
        return {
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "note": "Автопересчёт курсов не выполнился: " + f"{type(e).__name__}. "
                    "Данные импортированы, суммы в EUR можно пересчитать кнопкой "
                    "«Пересчитать» на странице курсов.",
        }
