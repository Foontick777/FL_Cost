"""FX rate endpoints (Issue #3).

  • GET  /fx-rates                — list rates (optionally by currency / date range)
  • GET  /fx-rates/currencies      — list known currencies
  • POST /fx-rates                 — owner: any currency; manager: только валюты,
                                     которых нет в архиве ЕЦБ (переопределить
                                     официальный курс может только владелец)
  • POST /fx-rates/sync            — owner/manager: pull latest ECB rates now
  • POST /fx-rates/convert          — public helper: convert amount × currency × date → EUR
  • POST /fx-rates/backfill         — owner и manager: populate amount_eur on all
                                     transactions missing it
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from sqlalchemy import select, and_, func, distinct
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from datetime import date
from decimal import Decimal

from app.core.database import get_db
# require_owner здесь больше не нужен: все операции с курсами доступны и менеджеру
# (владелец видит ту же страницу внутри «Администрирования»). Просмотр — любая роль.
from app.api.deps import get_current_user, require_manager, get_request_context
from app.models.models import User, FxRate
from app.schemas.schemas import (
    FxRateOut, FxRateCreate, FxRateBulkCreate, FxConversionRequest, FxConversionResponse,
)
from app.services import fx_service, audit_service, fx_history, fx_autoload
from app.services import backfill_plan

router = APIRouter(prefix="/fx-rates", tags=["fx-rates"])


@router.get("/", response_model=list[FxRateOut])
async def list_rates(
    currency: Optional[str] = Query(default=None),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    limit: int = Query(default=200, le=2000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Multi-tenant fix: this used to return EVERY row in fx_rates, so a company
    # saw the manual overrides entered by other companies (and vice versa).
    # Global ECB rows (company_id IS NULL) are shared by design.
    q = (
        select(FxRate)
        .where(
            (FxRate.company_id.is_(None))
            | (FxRate.company_id == current_user.company_id)
        )
        .order_by(FxRate.rate_date.desc(), FxRate.currency.asc())
        .limit(limit)
    )
    if currency:
        q = q.where(FxRate.currency == currency.upper())
    if date_from:
        q = q.where(FxRate.rate_date >= date_from)
    if date_to:
        q = q.where(FxRate.rate_date <= date_to)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/currencies")
async def list_currencies(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the set of currencies we have any rate for, plus EUR (always 1.0)."""
    # Тот же фильтр по компании, что в list_rates: без него компания видела
    # набор валют, заведённых другой компанией (FC-033 в аудите). Глобальные
    # строки ЕЦБ (company_id IS NULL) общие по замыслу.
    result = await db.execute(
        select(distinct(FxRate.currency)).where(
            (FxRate.company_id.is_(None)) | (FxRate.company_id == current_user.company_id)
        )
    )
    auto = sorted(await fx_autoload.auto_currencies())
    currencies = sorted({r[0] for r in result.all()} | set(auto))
    if "EUR" not in currencies:
        currencies = ["EUR"] + currencies
    # Отдельно отдаём набор валют архива ЕЦБ: интерфейс по нему понимает, какие
    # курсы подтягиваются автоматически, а какие можно задать только вручную.
    return {"currencies": currencies,
            "ecb_currencies": sorted(fx_autoload.ECB_CURRENCIES),
            # Валюты вне ЕЦБ, которые подгружаются сами из Frankfurter.
            "auto_currencies": auto}


# ──────────────────────────────────────────────────────────────────────
# FX-01 (аудит stage8): единый источник списка валют для выпадающих
# ──────────────────────────────────────────────────────────────────────
# Раньше список валют предлагающих в формах был ЗАХАРДКОЖЕН на фронтенде в
# пяти местах (ExpenseForm, Manual, Income, Fuel, FuelLike) и раз от разу
# расходился с бэкендом: в формах не было CHF/RSD/MDL/GEL, хотя бэкенд
# спокойно считает по ним курсы. Список форм — это свойство БЭКЕНДА
# (он решает, по каким валютам умеет считать), поэтому теперь отдаём его
# отсюда, а фронтенд только кэширует.
#
# Исторические валюты ЕЦБ (страны, перешедшие на евро) НЕ предлагаем в
# формах: для новых операций они бессмысленны. В backfill старых данных
# они по-прежнему работают — fx_autoload.ECB_CURRENCIES их не терял.
_FORM_HISTORICAL_CURRENCIES = frozenset({
    "CYP", "EEK", "LTL", "LVL", "MTL", "SIT", "SKK", "ROL", "TRL", "HRK",
})

# Офлайн-резерв на случай, когда Frankfurter недоступен и auto-набор пуст:
# валюты вне ЕЦБ, которые сервис стабильно покрывает (названы в fx_frankfurter).
_FRANKFURTER_FALLBACK = frozenset({"BYN", "RSD", "UAH", "MDL", "GEL"})


@router.get("/form-currencies")
async def form_currencies(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Список валют, которые показывать в выпадающих списках форм.

    Возвращает {code, name, source} — source подсказывает интерфейсу, откуда
    возьмётся курс (ecb | frankfurter | manual). Ответ НЕ зависит от того,
    заведены ли уже курсы (в отличие от GET /currencies) — новый пользователь
    с пустой базой видит полный список сразу.
    """
    active_ecb = sorted(fx_autoload.ECB_CURRENCIES - _FORM_HISTORICAL_CURRENCIES)
    try:
        auto = {c for c in await fx_autoload.auto_currencies()
                if c not in _FORM_HISTORICAL_CURRENCIES}
    except Exception:
        auto = set()
    if not auto:
        auto = set(_FRANKFURTER_FALLBACK)

    out = [{"code": "EUR", "name": "Euro", "source": "base"}]
    for code in active_ecb:
        out.append({"code": code, "name": _CURRENCY_NAMES.get(code, code), "source": "ecb"})
    for code in sorted(auto):
        out.append({"code": code, "name": _CURRENCY_NAMES.get(code, code), "source": "frankfurter"})
    return {"currencies": out}


# Короткие имена для интерфейса (tooltip в форме). Отсутствующие коды
# отображаются как сам код — это не ошибка.
_CURRENCY_NAMES = {
    "AUD": "Australian dollar", "BGN": "Bulgarian lev", "BRL": "Brazilian real",
    "BYN": "Belarusian ruble", "CAD": "Canadian dollar", "CHF": "Swiss franc",
    "CNY": "Chinese yuan", "CZK": "Czech koruna", "DKK": "Danish krone",
    "GEL": "Georgian lari", "GBP": "Pound sterling", "HKD": "Hong Kong dollar",
    "HUF": "Hungarian forint", "IDR": "Indonesian rupiah", "ILS": "Israeli shekel",
    "INR": "Indian rupee", "ISK": "Icelandic króna", "JPY": "Japanese yen",
    "KRW": "South Korean won", "MDL": "Moldovan leu", "MXN": "Mexican peso",
    "MYR": "Malaysian ringgit", "NOK": "Norwegian krone", "NZD": "New Zealand dollar",
    "PHP": "Philippine peso", "PLN": "Polish złoty", "RON": "Romanian leu",
    "RSD": "Serbian dinar", "RUB": "Russian ruble", "SEK": "Swedish krona",
    "SGD": "Singapore dollar", "THB": "Thai baht", "TRY": "Turkish lira",
    "UAH": "Ukrainian hryvnia", "USD": "US dollar", "ZAR": "South African rand",
}


@router.post("/convert", response_model=FxConversionResponse)
async def convert(
    body: FxConversionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Convert an amount in a foreign currency to EUR at a given date.
    Uses company-specific manual rates first, then falls back to global
    ECB rates (Issue #11)."""
    rate, actual_date, source = await fx_service.get_rate(
        body.currency, body.date, db, company_id=current_user.company_id
    )
    if rate is None:
        raise HTTPException(
            422,
            f"No FX rate available for {body.currency} on or before {body.date} "
            f"(checked company-specific manual rates, then global ECB rates "
            f"within 14 days backward). Add one via POST /api/fx-rates.",
        )
    amount_eur = (Decimal(body.amount) * rate).quantize(Decimal("0.01"))
    return FxConversionResponse(
        amount=body.amount,
        currency=body.currency,
        rate_date=actual_date,
        fx_rate=rate,
        amount_eur=amount_eur,
        source=source or "ECB",
    )


@router.post("/", response_model=FxRateOut)
async def add_manual_rate(
    request: Request,
    body: FxRateCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Ручной курс: владелец — любой валюты, менеджер — только той, которой нет в ЕЦБ.

    ПОЧЕМУ ТАК. Менеджеру страница курсов нужна ради валют, у которых нет источника
    вообще (BYN, RSD, UAH, MDL, GEL): без ручного ввода их суммы не попадают в
    EUR-аналитику. Для валют ИЗ архива ЕЦБ ручной ввод — это переопределение
    официального курса: поиск идёт как «company-specific manual → global ECB», то
    есть введённое значение перебивает ECB для всех строк этой компании и молча
    меняет уже посчитанные исторические суммы. Поэтому override — только у владельца.
    Проверка именно здесь, на сервере: скрытая в интерфейсе кнопка защитой не является.

    MULTI-TENANT (Issue #11): the rate is stored with the current user's
    company_id, so it only affects that company's transactions. Other
    companies are unaffected. Global ECB rates (company_id IS NULL) are
    never modified by this endpoint.
    """
    body.currency = body.currency.upper()
    if not fx_autoload.may_edit_currency(body.currency, getattr(current_user, "role", None)):
        raise HTTPException(status_code=403,
                            detail=fx_autoload.currency_edit_refusal(body.currency))
    existing = (await db.execute(
        select(FxRate).where(and_(
            FxRate.company_id == current_user.company_id,
            FxRate.currency == body.currency,
            FxRate.rate_date == body.rate_date,
        ))
    )).scalar_one_or_none()

    if existing:
        old_snapshot = audit_service.snapshot(existing)
        existing.rate_to_eur = body.rate_to_eur
        existing.source = body.source or "manual"
        await db.flush()
        await db.refresh(existing)
        ctx = get_request_context(request)
        await audit_service.log(
            db,
            company_id=current_user.company_id,
            user=current_user,
            action="UPDATE",
            entity_type="FxRate",
            entity_id=existing.id,
            old_value=old_snapshot,
            new_value=audit_service.snapshot(existing),
            ip=ctx["ip"],
            user_agent=ctx["user_agent"],
            client_id=ctx.get("client_id"),
        )
        await db.commit()
        # Курс мог закрыть строки, которые до этого оставались без EUR (или посчитать
        # их точнее) — пересчитываем сразу, чтобы «сохранил курс» и «суммы сошлись»
        # были одним действием, а не двумя.
        existing.auto = await fx_autoload.auto_finish(
            current_user.company_id, rates_changed=True,
        )
        return existing

    rate = FxRate(
        company_id=current_user.company_id,  # company-specific, NOT global
        currency=body.currency,
        rate_date=body.rate_date,
        rate_to_eur=body.rate_to_eur,
        source=body.source or "manual",
    )
    db.add(rate)
    await db.flush()
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="CREATE",
        entity_type="FxRate",
        entity_id=rate.id,
        new_value=audit_service.snapshot(rate),
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(rate)
    rate.auto = await fx_autoload.auto_finish(
        current_user.company_id, rates_changed=True,
    )
    return rate


@router.post("/manual-bulk")
async def add_manual_rates_bulk(
    request: Request,
    body: FxRateBulkCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Один курс — сразу на несколько дат одной валюты (владелец и менеджер).

    Основной случай — валюта вне архива ЕЦБ (BYN, RSD, UAH, MDL…), где курса в
    источнике нет никогда, а значение всё равно одно на все даты. Для валют архива
    ЕЦБ действует то же правило, что и у одиночного ввода: override — только
    владелец (проверка ниже).

    ЗАЧЕМ: для валют, которых нет в архиве ЕЦБ (BYN, RSD, UAH, MDL…), курса в
    источнике не будет никогда. Курс при этом действует только 14 дней вперёд
    (`fx_service.get_rate`), поэтому окно из нескольких транзакций требует
    нескольких записей — вводить их по одной дате неудобно, а после каждой ввода
    приходилось ещё и нажимать «Пересчитать», чтобы увидеть следующую дату.

    Здесь значение вводится один раз и применяется ко всем нужным датам.

    ЧЕСТНО ПРО ЦЕНУ РЕШЕНИЯ: одно и то же значение применяется ко всем перечисленным
    датам, даже если фактический курс за это время менялся — для валюты без
    источника это осознанный компромисс. Поэтому действие попадает в журнал
    действий одной записью с полным перечнем дат и значением, чтобы его можно было
    проверить задним числом.

    Даты приходят как `list[date]`: pydantic разбирает ISO-строки и отбрасывает
    мусор до запросов к БД (та же защита, что описана в §30).
    """
    currency = body.currency  # уже нормализована валидатором схемы
    if not fx_autoload.may_edit_currency(currency, getattr(current_user, "role", None)):
        raise HTTPException(status_code=403,
                            detail=fx_autoload.currency_edit_refusal(currency))
    dates, dropped = fx_history.normalize_bulk_dates(body.dates)
    if not dates:
        raise HTTPException(status_code=400, detail="Не указано ни одной даты")

    created = 0
    updated = 0
    first_id = None
    for d in dates:
        existing = (await db.execute(
            select(FxRate).where(and_(
                FxRate.company_id == current_user.company_id,
                FxRate.currency == currency,
                FxRate.rate_date == d,
            ))
        )).scalar_one_or_none()
        if existing:
            existing.rate_to_eur = body.rate_to_eur
            existing.source = body.source or "manual"
            updated += 1
            first_id = first_id if first_id is not None else existing.id
        else:
            rate = FxRate(
                company_id=current_user.company_id,   # курсы компании, не глобальные
                currency=currency,
                rate_date=d,
                rate_to_eur=body.rate_to_eur,
                source=body.source or "manual",
            )
            db.add(rate)
            await db.flush()
            first_id = first_id if first_id is not None else rate.id
            created += 1

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="CREATE",
        entity_type="FxRate",
        entity_id=first_id,
        new_value={
            "bulk": True,
            "currency": currency,
            "rate_to_eur": str(body.rate_to_eur),
            "dates": [d.isoformat() for d in dates],
            "created": created,
            "updated": updated,
            "dropped_over_limit": dropped,
        },
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {
        "status": "ok",
        "currency": currency,
        "created": created,
        "updated": updated,
        "dates": [d.isoformat() for d in dates],
        "dropped": dropped,
        "requested": len(body.dates),
        "auto": await fx_autoload.auto_finish(
            current_user.company_id, rates_changed=True,
        ),
    }


async def _safe_other(company_id, *, history: bool, days: int) -> dict:
    """Загрузка валют вне ЕЦБ; сбой Frankfurter не должен ломать ответ по ЕЦБ."""
    try:
        return await fx_autoload.sync_other_currencies(company_id, history=history, days=days)
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "source": "FRANKFURTER", "results": [], "new_rows": 0,
                "updated_rows": 0, "message": f"{type(e).__name__}: {e}"}


@router.post("/sync")
async def sync_ecb(
    current_user: User = Depends(require_manager),
):
    """Owner or manager: trigger an immediate ECB pull (instead of waiting
    for the daily scheduler job). Pulls ONLY today's rate snapshot."""
    result = await fx_service.fetch_and_store_ecb_rates(date.today())
    # Валюты ЭТОЙ компании, которых нет в ЕЦБ (BYN…): последние дни из Frankfurter.
    # Одна кнопка — оба источника. Загруженное общее, но берётся только то, что
    # реально используется в данных вызывающей компании.
    result["other"] = await _safe_other(current_user.company_id, history=False, days=7)
    # Курсы только что изменились — сразу закрываем и последствия: дозагрузка
    # недостающих дат (если ЕЦБ опубликовал день, которого у нас нет) и пересчёт
    # строк, которые посчитались точнее. Раньше это приходилось делать вручную.
    result["auto"] = await fx_autoload.auto_finish(
        current_user.company_id, rates_changed=True,
    )
    return result


@router.post("/sync-historical")
async def sync_historical(
    current_user: User = Depends(require_manager),
    days_back: int = Query(default=0, ge=0,
                            description="If > 0, only import rates newer than today-days_back. "
                                        "0 (default) imports the entire ECB archive back to 1999."),
):
    """Owner and manager: pull the full ECB historical archive (~25 years of daily
    rates) and store it in the fx_rates table.

    Доступно и менеджеру: страница «Курсы валют» у него теперь целиком, а операция
    безопасна — она только пополняет таблицу курсов из источника и не меняет
    исторические суммы в EUR (для этого отдельная кнопка «Пересчитать всё заново»).

    Use this ONCE after enabling FX tracking — it populates rates for every
    past date so the existing transactions can be EUR-converted via
    /api/fx-rates/backfill. After this initial import, the daily scheduler
    job keeps the table fresh.

    Takes ~10-30 seconds and writes ~15000 rows (3000 business days × 31
    currencies). Idempotent — re-running only inserts rows that aren't
    already present, and updates rows whose rate has changed.
    """
    result = await fx_service.fetch_and_store_historical_rates(days_back=days_back)
    # Валюты вне ЕЦБ: полная история — от самой ранней операции компании в этой
    # валюте; при days_back>0 — только последние дни.
    result["other"] = await _safe_other(current_user.company_id, history=(days_back == 0),
                                        days=days_back or 7)
    result["auto"] = await fx_autoload.auto_finish(
        current_user.company_id, rates_changed=True,
    )
    return result


@router.post("/backfill")
async def backfill_transactions(
    force: bool = False,
    current_user: User = Depends(require_manager),
):
    """Owner and manager: заполнить amount_eur из таблицы курсов.

    Доступно и менеджеру — это то же действие, что выполняется автоматически при
    импорте; вручную его запускают, когда нужно не ждать.

    Обычный вызов обрабатывает только строки с NULL amount_eur — «ещё не
    пересчитанные». `force=true` пересчитывает все строки заново: нужно один
    раз после исправления направления курса, потому что до исправления суммы в
    иностранной валюте были завышены, но уже записаны и обычным проходом не
    задеваются (FC-001 в аудите: дашборд считает по amount_eur)."""
    summary = await fx_service.backfill_all_missing(current_user.company_id, force=force)
    if not force:
        # Строки с NULL amount_eur уже обработаны выше, поэтому здесь include_null=False:
        # добираем только те, где курс был взят «ближайшим назад», а точный на дату
        # операции уже появился. Без этого после докачки архива дашборд и вкладки
        # показывали бы разные суммы за один период (курс-то у строк разный).
        refined = await fx_autoload.refine_company(current_user.company_id, include_null=False)
        summary["recalculated_inexact"] = refined.get("recalculated", 0)
        summary["refine"] = refined
        after = await fx_autoload.unrated_overview(current_user.company_id)
        summary["remaining"] = after["remaining"]
        summary["no_rate_detail"] = after["detail"]
        hint = backfill_plan.describe_unrated(after["currencies"], after["period"], after["detail"])
        summary["note"] = hint or summary.get("note")
    return summary
