"""FX rate service.

Provides:
  • fetch_and_store_ecb_rates() — pull the latest ECB daily reference rates
    and insert/upsrt them into the fx_rates table. Called once per day by
    the scheduler, and on-demand via /api/fx-rates/sync.
  • get_rate(currency, date) — look up the FX rate for a currency on a
    given date. Falls back to the nearest prior rate if no exact match.
    Returns 1.0 for EUR. Returns None if currency is unknown — caller
    MUST handle None (raise or default).
  • convert_to_eur(amount, currency, date) — convenience: looks up the
    rate and applies it. Returns Decimal. Returns None if no rate found.
  • backfill_transaction(txn) — populate fx_rate, amount_eur, fx_rate_date,
    fx_source on a Transaction row. Called from save_transactions and from
    the manual /expenses/ endpoint.
"""
import logging
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional, Iterable
import hashlib

import httpx
from sqlalchemy import select, and_, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.models import FxRate
from app.services import fx_history

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# ECB fetch + persist
# ──────────────────────────────────────────────────────────────────────
ECB_NAMESPACES = {"gesmes": "http://www.gesmes.org/xml/2002-08-01"}


async def fetch_ecb_rates_for_date(target_date: date) -> dict[str, Decimal]:
    """Pull the ECB daily reference rates for `target_date` (or the nearest
    prior business day if ECB hasn't published yet for that day).

    Returns a dict: currency → rate (1 unit of `currency` = rate EUR).
    The ECB XML has EUR as the base currency, with each <Cube currency='XXX'
    rate='0.2348' /> meaning "1 XXX = 0.2348 EUR". We store that verbatim.

    On network failure or invalid XML, returns an empty dict.
    """
    url = settings.FX_ECB_URL
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url)
            resp.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(f"ECB fetch failed: {e}")
        return {}

    try:
        root = ET.fromstring(resp.text)
    except ET.ParseError as e:
        logger.warning(f"ECB XML parse failed: {e}")
        return {}

    # The XML looks like:
    # <gesmes:Envelope>
    #   <Cube>
    #     <Cube time="2026-09-15">
    #       <Cube currency="USD" rate="1.0842"/>
    #       ...
    #     </Cube>
    #   </Cube>
    # </gesmes:Envelope>
    # We don't actually filter by target_date here — we just take whatever
    # the ECB returned in their daily file (which is for the most recent
    # business day). The caller (fetch_and_store_ecb_rates) decides whether
    # to use the file's stated date or override it.
    cubes = root.iter("{http://www.ecb.europa.eu/vocabulary/2022-08-01/eurofxref}Cube")
    rates: dict[str, Decimal] = {}
    file_date: Optional[date] = None

    # Fall back to no-namespace search — ECB XML sometimes uses default ns
    # and sometimes doesn't.
    for parent in root.iter():
        if not parent.tag.endswith("Cube"):
            continue
        time_attr = parent.attrib.get("time")
        if time_attr:
            try:
                file_date = date.fromisoformat(time_attr)
            except ValueError:
                pass
            continue
        cur = parent.attrib.get("currency")
        rate = parent.attrib.get("rate")
        if cur and rate:
            try:
                ecb_rate = Decimal(rate)
                # ECB publishes "1 EUR = ecb_rate of currency". We want
                # rate_to_eur = "how many EUR is 1 unit of currency".
                # So invert: rate_to_eur = 1 / ecb_rate.
                # e.g. EUR/PLN = 4.25 → PLN rate_to_eur = 1/4.25 = 0.2353
                # Then amount_eur = amount * rate_to_eur (e.g. 100 PLN → 23.53 EUR).
                # Previously we stored ecb_rate directly, which gave
                # 100 PLN × 4.25 = 425 EUR (wrong by ~18×).
                if ecb_rate > 0:
                    rates[cur] = Decimal(1) / ecb_rate
            except Exception:
                pass

    # Always include EUR with rate 1.0 (1 EUR = 1 EUR)
    rates["EUR"] = Decimal("1.0")

    if file_date:
        # Stash the date the ECB file is for, so the caller knows.
        rates["__date__"] = file_date  # type: ignore[assignment]
    return rates


async def store_rates(rates: dict[str, Decimal], rate_date: date, source: str = "ECB") -> int:
    """Upsert a batch of rates into the fx_rates table. Returns the count
    of rows written. Skips the "__date__" pseudo-key."""
    if not rates:
        return 0
    stored = 0
    async with AsyncSessionLocal() as db:
        for cur, rate in rates.items():
            if cur.startswith("__"):
                continue
            if cur == "EUR":
                continue  # don't store EUR rows — it's always 1.0
            # ECB rates live with company_id IS NULL (shared by all tenants).
            # Without this filter, a company-specific manual override for the
            # same currency+date makes the query return TWO rows and
            # scalar_one_or_none() raises MultipleResultsFound — which broke
            # the nightly ECB refresh and POST /fx-rates/sync with a 500.
            existing = (await db.execute(
                select(FxRate)
                .where(
                    and_(
                        FxRate.currency == cur,
                        FxRate.rate_date == rate_date,
                        FxRate.company_id.is_(None),
                    )
                )
                .limit(2)
            )).scalars().all()
            existing = existing[0] if existing else None
            if existing:
                existing.rate_to_eur = rate
                existing.source = source
            else:
                db.add(FxRate(
                    currency=cur,
                    rate_date=rate_date,
                    rate_to_eur=rate,
                    source=source,
                ))
            stored += 1
        await db.commit()
    return stored


async def fetch_and_store_ecb_rates(target_date: Optional[date] = None) -> dict:
    """Pull ECB rates and persist them. Returns a summary dict."""
    raw = await fetch_ecb_rates_for_date(target_date or date.today())
    if not raw:
        return {"status": "error", "message": "ECB fetch returned no rates"}
    file_date = raw.pop("__date__", None) or target_date or date.today()
    stored = await store_rates(raw, file_date, source="ECB")
    return {
        "status": "ok",
        "rate_date": file_date.isoformat(),
        "stored": stored,
        "currencies": sorted(raw.keys()),
    }


# ──────────────────────────────────────────────────────────────────────
# Historical ECB rates — the 90-day+ archive
# ──────────────────────────────────────────────────────────────────────
ECB_HIST_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip"


async def fetch_and_store_historical_rates(days_back: int = 0) -> dict:
    """Pull the ECB historical rates archive and store every daily snapshot
    in the fx_rates table.

    The ECB publishes `eurofxref-hist.zip` — a single ZIP containing one CSV
    with every daily reference rate since 1999-01-04. The CSV has the format:

        Date,USD,JPY,BGN,CYP,CZK,...
        2026-09-19,1.0842,168.32,1.9558,N/A,25.412,...
        2026-09-18,1.0838,168.05,1.9558,N/A,25.407,...

    Each row → one rate per currency for that date. Currencies marked
    "N/A" (no longer tracked by ECB) are skipped.

    `days_back` (optional): if > 0, only store rates with rate_date >=
    today - days_back. Useful if you've already imported the deep history
    and just want a recent refresh.

    Returns a summary dict: {status, dates_stored, currencies, earliest_date, latest_date}
    """
    import zipfile
    import csv
    import io as _io
    from collections import defaultdict

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(ECB_HIST_URL)
            resp.raise_for_status()
    except httpx.HTTPError as e:
        return {"status": "error", "message": f"ECB historical fetch failed: {e}"}

    try:
        zf = zipfile.ZipFile(_io.BytesIO(resp.content))
    except zipfile.BadZipFile as e:
        return {"status": "error", "message": f"Bad ZIP from ECB: {e}"}

    # The zip contains a single CSV file named "eurofxref-hist.csv"
    csv_names = [n for n in zf.namelist() if n.endswith(".csv")]
    if not csv_names:
        return {"status": "error", "message": "ZIP did not contain a CSV"}
    with zf.open(csv_names[0]) as f:
        # Force utf-8 — ECB CSV is ASCII but be safe
        text = f.read().decode("utf-8-sig", errors="replace")

    reader = csv.DictReader(text.splitlines())
    if "Date" not in (reader.fieldnames or []):
        return {"status": "error", "message": f"CSV missing Date column: {reader.fieldnames}"}

    # Collect everything first, then bulk-upsert in one transaction.
    # Each row is one date with N currency rates.
    cutoff = None
    if days_back and days_back > 0:
        cutoff = date.today() - timedelta(days=days_back)

    # rates_by_date: {date_str: {currency: Decimal}}
    rates_by_date: dict[str, dict[str, Decimal]] = defaultdict(dict)
    currencies_seen: set[str] = set()
    earliest: Optional[date] = None
    latest: Optional[date] = None

    for row in reader:
        d_str = (row.get("Date") or "").strip()
        if not d_str:
            continue
        try:
            d = date.fromisoformat(d_str)
        except ValueError:
            continue
        if cutoff and d < cutoff:
            continue
        for cur, rate_str in row.items():
            if cur == "Date":
                continue
            cur = (cur or "").strip().upper()
            if not cur:
                continue
            rate_str = (rate_str or "").strip()
            if not rate_str or rate_str.upper() == "N/A":
                continue  # currency no longer tracked by ECB
            try:
                ecb_rate = Decimal(rate_str)
            except Exception:
                continue
            if ecb_rate <= 0:
                continue
            # Invert: ECB publishes "1 EUR = ecb_rate of currency", we want
            # rate_to_eur = "1 unit of currency = ? EUR" = 1 / ecb_rate.
            rate = Decimal(1) / ecb_rate
            rates_by_date[d_str][cur] = rate
            currencies_seen.add(cur)
            if earliest is None or d < earliest:
                earliest = d
            if latest is None or d > latest:
                latest = d

    if not rates_by_date:
        return {"status": "error", "message": "No historical rates parsed from CSV"}

    # Bulk upsert in batches to avoid huge transactions.
    #
    # Элементы строит fx_history.build_items, и там же объяснено, почему даты —
    # объекты `date`, а не строки: драйвер `postgresql+asyncpg` строго типизирован
    # и строку в параметр DATE не принимает, поэтому прежний код падал на КАЖДОМ
    # батче («All 442 batches failed») при полностью существующей таблице.
    items = fx_history.build_items(rates_by_date)
    fx_history.assert_items_are_typed(items)   # страховка от возврата строк
    total_stored = 0

    batch_size = 500
    batches_ok = 0
    batches_failed = 0
    updated_count = 0
    first_error: Optional[str] = None
    aborted_early = False

    async def _diagnostics() -> dict:
        """Дешёвые ФАКТЫ о схеме — чтобы текст ошибки не гадал (см. ниже)."""
        diag: dict = {"table_exists": None, "rows": None, "global_rows": None,
                      "has_company_id": None, "alembic_revision": None,
                      "alembic_version_missing": None, "probe_error": None}
        try:
            async with AsyncSessionLocal() as probe:
                r = await probe.execute(text("SELECT to_regclass('fx_rates') IS NOT NULL"))
                diag["table_exists"] = bool(r.scalar())
                if diag["table_exists"]:
                    r = await probe.execute(text(
                        "SELECT count(*) FROM information_schema.columns "
                        "WHERE table_name = 'fx_rates' AND column_name = 'company_id'"))
                    diag["has_company_id"] = bool(r.scalar())
                    r = await probe.execute(text(
                        "SELECT count(*), count(*) FILTER (WHERE company_id IS NULL) FROM fx_rates"
                        if diag["has_company_id"] else "SELECT count(*), NULL FROM fx_rates"))
                    row = r.first()
                    diag["rows"] = int(row[0] or 0)
                    diag["global_rows"] = int(row[1]) if row[1] is not None else None
                r = await probe.execute(text("SELECT to_regclass('alembic_version') IS NOT NULL"))
                if bool(r.scalar()):
                    diag["alembic_version_missing"] = False
                    r = await probe.execute(text("SELECT version_num FROM alembic_version"))
                    diag["alembic_revision"] = r.scalar()
                else:
                    diag["alembic_version_missing"] = True
        except Exception as probe_err:
            diag["probe_error"] = f"{type(probe_err).__name__}: {probe_err}"[:200]
        return diag

    try:
        async with AsyncSessionLocal() as db:
            for i in range(0, len(items), batch_size):
                chunk = items[i:i + batch_size]
                # Pull existing rows for this batch so we know which to UPDATE
                # vs INSERT. Cheaper than per-row SELECT.
                chunk_dates = list({d for d, _, _ in chunk})
                chunk_curs = list({c for _, c, _ in chunk})
                inserted_in_batch = 0
                try:
                    existing_result = await db.execute(
                        select(FxRate).where(
                            FxRate.rate_date.in_(chunk_dates),
                            FxRate.currency.in_(chunk_curs),
                            # Только ГЛОБАЛЬНЫЕ курсы (ЕЦБ, company_id IS NULL).
                            # Без этого условия ручной курс компании за ту же
                            # дату считался бы «уже существующим», и его значение
                            # молча перезаписывалось курсом ЕЦБ — ручной ввод
                            # владельца компании исчезал.
                            FxRate.company_id.is_(None),
                        )
                    )
                    existing_map: dict[tuple[date, str], FxRate] = {}
                    for r in existing_result.scalars().all():
                        # Ключ — объект date: так же, как в items. Никаких
                        # строковых переходов, на которых всё и ломалось.
                        # setdefault: при исторических дублях обновляем первую
                        # строку, а не последнюю случайную.
                        existing_map.setdefault((r.rate_date, r.currency), r)

                    for d_obj, cur, rate in chunk:
                        ex = existing_map.get((d_obj, cur))
                        if ex:
                            if ex.rate_to_eur != rate:
                                ex.rate_to_eur = rate
                                ex.source = "ECB"
                                updated_count += 1
                            # else: no change — skip
                        else:
                            db.add(FxRate(
                                currency=cur,
                                rate_date=d_obj,
                                rate_to_eur=rate,
                                source="ECB",
                            ))
                            inserted_in_batch += 1
                    await db.commit()
                    # Считаем ТОЛЬКО закоммиченное: раньше счётчик увеличивался до
                    # commit, и откатившийся батч попадал в «new_rows».
                    total_stored += inserted_in_batch
                    batches_ok += 1
                except Exception as batch_err:
                    await db.rollback()
                    batches_failed += 1
                    if first_error is None:
                        first_error = f"{type(batch_err).__name__}: {batch_err}"
                    logger.warning(f"Historical FX batch {i}-{i+len(chunk)} failed: {batch_err}")
                    if fx_history.should_abort_early(batches_ok, batches_failed):
                        aborted_early = True
                        logger.error(
                            f"Historical FX: stopped after {batches_failed} failed batches with "
                            f"0 written — the cause is systemic, not per-row. "
                            f"First error: {first_error}"
                        )
                        break
                    continue
    except Exception as e:
        # Сюда попадаем, если не работает сам движок/сессии — тогда проверку схемы
        # выполнить нечем, и остаётся честно сказать это.
        logger.error(f"Historical FX store failed: {e}")
        return {
            "status": "error",
            "message": f"Ошибка базы до начала записи: {type(e).__name__}: {e}",
            "dates_stored": len(rates_by_date),
            "new_rows": 0,
        }

    if batches_ok == 0 and batches_failed > 0:
        # Раньше здесь стояла ДОГАДКА («likely the fx_rates table doesn't exist»),
        # выведенная из одного факта «ни один батч не прошёл». Таблицу создаёт ещё
        # и create_all при старте (main.py), поэтому догадка чаще всего неверна, а
        # настоящая ошибка оставалась только в логах. Теперь — факты и текст ошибки.
        diag = await _diagnostics()
        return {
            "status": "error",
            "message": fx_history.summarize_batch_failures(
                batches_ok=batches_ok, batches_failed=batches_failed,
                total_items=len(items), first_error=first_error,
                diagnostics=diag, aborted_early=aborted_early,
            ),
            "first_error": first_error,
            "diagnostics": diag,
            "aborted_early": aborted_early,
            "dates_stored": len(rates_by_date),
            "new_rows": 0,
            "currencies": sorted(currencies_seen),
            "earliest_date": earliest.isoformat() if earliest else None,
            "latest_date": latest.isoformat() if latest else None,
        }

    if batches_failed > 0:
        # Часть батчей не записалась: показать это полным успехом нельзя, иначе
        # пользователь считает архив загруженным и не понимает, почему часть
        # транзакций остаётся без курса.
        return {
            "status": "partial",
            "message": fx_history.summarize_partial(
                batches_ok=batches_ok, batches_failed=batches_failed, first_error=first_error),
            "first_error": first_error,
            "aborted_early": aborted_early,
            "batches_ok": batches_ok,
            "batches_failed": batches_failed,
            "dates_stored": len(rates_by_date),
            "new_rows": total_stored,
            "updated_rows": updated_count,
            "currencies": sorted(currencies_seen),
            "earliest_date": earliest.isoformat() if earliest else None,
            "latest_date": latest.isoformat() if latest else None,
        }

    return {
        "status": "ok",
        "dates_stored": len(rates_by_date),
        "new_rows": total_stored,
        "updated_rows": updated_count,
        "batches_ok": batches_ok,
        "currencies": sorted(currencies_seen),
        "earliest_date": earliest.isoformat() if earliest else None,
        "latest_date": latest.isoformat() if latest else None,
    }


# ──────────────────────────────────────────────────────────────────────
# Rate lookup
# ──────────────────────────────────────────────────────────────────────
async def get_rate(currency: str, target_date: date, db: Optional[AsyncSession] = None,
                   company_id: Optional[int] = None,
                   cache: Optional[dict] = None) -> tuple[Optional[Decimal], Optional[date], Optional[str]]:
    """Курс для пары (валюта, дата). Логика выбора курса — в _get_rate_uncached.

    `cache` — необязательный словарь на время одного импорта. В файле на
    несколько тысяч строк пары (валюта, дата) повторяются, и без кэша на каждую
    строку уходил отдельный запрос в базу (FC-015 в аудите). Кэш хранит ровно то,
    что вернула бы функция, поэтому результат не меняется — меняется только число
    запросов. Владелец кэша — вызывающий код: создаёт словарь перед циклом и
    выбрасывает после, так что устаревшие курсы нигде не задерживаются.
    """
    if cache is None:
        return await _get_rate_uncached(currency, target_date, db, company_id)
    key = (currency.upper() if isinstance(currency, str) else currency, target_date, company_id)
    if key not in cache:
        cache[key] = await _get_rate_uncached(currency, target_date, db, company_id)
    return cache[key]
async def _get_rate_uncached(currency: str, target_date: date, db: Optional[AsyncSession] = None,
                   company_id: Optional[int] = None) -> tuple[Optional[Decimal], Optional[date], Optional[str]]:
    """Return (fx_rate, actual_rate_date, source) for `currency` on `target_date`.

    MULTI-TENANT (Issue #11): if `company_id` is provided, prefer
    company-specific manual rates first, then fall back to global ECB rates.
    If `company_id` is None, only global rates are searched.

    Lookup order:
      1. Exact date match — company-specific first, then global.
      2. Previous business day within 14 days backward — company-specific first,
         then global.
      3. NOTHING ELSE — fail closed. No "most recent rate regardless of date"
         fallback (that would silently apply a stale rate to an old transaction,
         which is dangerous for financial reporting). The caller should handle
         None by leaving amount_eur=NULL and warning the user.

    EUR always returns (Decimal("1.0"), target_date, "fixed").

    Robust against the fx_rates table not yet existing — returns (None, None, None).
    """
    if not currency or currency.upper() == "EUR":
        return Decimal("1.0"), target_date, "fixed"

    currency = currency.upper()

    async def _query(session: AsyncSession):
        try:
            # Helper: try company-specific first, then global, for a given
            # WHERE clause + ORDER BY.
            async def _try_lookup(where_clause, order_by=None):
                # Company-specific — ТОЛЬКО ручные записи (P0-2 / PRIV-1).
                # Ручной курс компании имеет смысл там, где официального источника
                # нет (BYN, RSD, UAH…) или владелец сознательно переопределил ЕЦБ.
                # Без фильтра по source любая company-запись (в т.ч. с подделанным
                # через API source="ECB") перебивала бы глобальный официальный
                # курс для всех строк компании и молча меняла уже посчитанную
                # историю. Автокурсы Frankfurter пишутся только глобально
                # (company_id IS NULL), поэтому их фильтр не затрагивает.
                q = select(FxRate.rate_to_eur, FxRate.rate_date, FxRate.source).where(
                    and_(
                        FxRate.currency == currency,
                        FxRate.company_id == company_id,
                        FxRate.source == "manual",
                        *where_clause,
                    )
                )
                if order_by is not None:
                    q = q.order_by(*order_by).limit(1)
                r = await session.execute(q)
                row = r.first()
                if row:
                    return row[0], row[1], row[2]
                # Global (ECB) — company_id IS NULL
                q = select(FxRate.rate_to_eur, FxRate.rate_date, FxRate.source).where(
                    and_(
                        FxRate.currency == currency,
                        FxRate.company_id.is_(None),
                        *where_clause,
                    )
                )
                if order_by is not None:
                    q = q.order_by(*order_by).limit(1)
                r = await session.execute(q)
                row = r.first()
                if row:
                    return row[0], row[1], row[2]
                return None, None, None

            # 1. Exact date match
            r, d, s = await _try_lookup([FxRate.rate_date == target_date])
            if r is not None:
                return r, d, s
            # 2. Walk backward up to 14 days (covers weekends + ECB holidays)
            earliest = target_date - timedelta(days=14)
            r, d, s = await _try_lookup(
                [FxRate.rate_date <= target_date, FxRate.rate_date >= earliest],
                order_by=[FxRate.rate_date.desc()],
            )
            if r is not None:
                return r, d, s
            # 3. NO silent fallback — fail closed.
            return None, None, None
        except Exception as e:
            logger.warning(f"get_rate failed (table missing?): {e}")
            return None, None, None

    if db is not None:
        return await _query(db)
    async with AsyncSessionLocal() as session:
        return await _query(session)


async def convert_to_eur(
    amount: Decimal,
    currency: str,
    target_date: date,
    db: Optional[AsyncSession] = None,
    company_id: Optional[int] = None,
    cache: Optional[dict] = None,
) -> tuple[Optional[Decimal], Optional[Decimal], Optional[date], Optional[str]]:
    """Convert `amount` in `currency` to EUR using the rate closest to
    `target_date`. Returns (fx_rate, amount_eur, actual_rate_date, source).

    MULTI-TENANT (Issue #11): if `company_id` is provided, company-specific
    manual rates are preferred over global ECB rates.

    Returns (None, None, None, None) if no rate is found within 14 days
    backward of target_date. The caller MUST handle this — do NOT default
    to 1.0 (which would silently treat unknown currencies as EUR)."""
    rate, actual_date, source = await get_rate(currency, target_date, db, company_id=company_id, cache=cache)
    if rate is None:
        return None, None, None, None
    quantized = (amount * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return rate, quantized, actual_date, source or "ECB"


# ──────────────────────────────────────────────────────────────────────
# Backfill Transaction rows
# ──────────────────────────────────────────────────────────────────────
async def backfill_transaction(txn, db: AsyncSession, cache: Optional[dict] = None) -> None:
    """Populate fx_rate / amount_eur / fx_rate_date / fx_source on a Transaction.
    Called after every insert or update to amount/currency/transaction_date.

    Safe to call on EUR transactions — they get fx_rate=1.0, amount_eur=amount.

    MULTI-TENANT (Issue #11): uses txn.company_id to look up company-specific
    manual rates first, then falls back to global ECB rates.

    If no rate is found for the currency on that date (and within 14 days
    prior), the fx fields are set to NULL — the frontend should display the
    original amount only and flag that EUR conversion is unavailable.
    """
    if txn.amount is None or not txn.currency or not txn.transaction_date:
        return
    rate, amount_eur, rate_date, source = await convert_to_eur(
        Decimal(txn.amount),
        txn.currency,
        txn.transaction_date.date() if hasattr(txn.transaction_date, 'date') else txn.transaction_date,
        db,
        company_id=txn.company_id,
        cache=cache,
    )
    if rate is None:
        # Leave fields NULL — frontend should show the raw amount only.
        txn.fx_rate = None
        txn.amount_eur = None
        txn.fx_rate_date = None
        txn.fx_source = None
        return
    txn.fx_rate = rate
    txn.amount_eur = amount_eur
    txn.fx_rate_date = rate_date
    txn.fx_source = source


# ──────────────────────────────────────────────────────────────────────
# Backfill helper — bulk backfill all transactions missing amount_eur
# ──────────────────────────────────────────────────────────────────────
async def backfill_all_missing(
    company_id: Optional[int] = None,
    batch_size: int = 500,
    max_batches: int = 5000,
    time_budget_seconds: Optional[float] = 120.0,
    force: bool = False,
) -> dict:
    """Walk EVERY Transaction with NULL amount_eur and backfill it.

    `force=True` пересчитывает ВСЕ строки, включая уже заполненные. Это нужно,
    когда прежние значения amount_eur посчитаны неверно: раньше курс ЕЦБ
    хранился «как есть» (1 EUR = 4.25 PLN) и умножался, из-за чего суммы в PLN
    были завышены примерно в 18 раз, а сам разбор потом исправили на обратный.
    Строки, обработанные до исправления, так и остались с завышенными суммами —
    обычный проход их не трогает, потому что amount_eur у них не NULL, и именно
    поэтому дашборд (он считает по amount_eur) показывал завышенные расходы.

    Здесь только доступ к БД: выбрать батч, вызвать `backfill_transaction`,
    закоммитить. Порядок обхода и условия остановки — в
    `app.services.backfill_plan` (там же разбор прежней ошибки).

    Два свойства, которые важны именно тут:

    * выборка идёт по ВОЗРАСТАЮЩЕМУ `id` (`Transaction.id > after_id`), поэтому
      одна строка не может попасть в два батча и обход конечен по построению.
      Раньше батч выбирался как «все NULL по LIMIT» и непереводимые строки
      выбирались снова и снова — с одним и тем же телом запроса, пока nginx
      не обрывал соединение по `proxy_read_timeout 120s` (реальный случай:
      268 одинаковых батчей по 500 строк и 502 на фронте).
    * `time_budget_seconds` ограничивает время работы запроса, чтобы успеть
      ответить раньше nginx. Незавершённая работа не теряется: строки, которые
      не успели обработать, остаются с NULL amount_eur и попадут в следующий
      запуск — повторное нажатие кнопки просто продолжает с места остановки.

    Returns a summary: backfilled / failed / invalid_rows / no_rate_rows /
    no_rate_currencies / no_rate_period / remaining / truncated / note.
    """
    from app.models.models import Transaction
    from sqlalchemy import func as sa_func
    from app.services import backfill_plan

    async def process_batch(after_id, limit):
        async with AsyncSessionLocal() as db:
            q = select(Transaction)
            if not force:
                q = q.where(Transaction.amount_eur.is_(None))
            if company_id is not None:
                q = q.where(Transaction.company_id == company_id)
            if after_id is not None:
                q = q.where(Transaction.id > after_id)
            q = q.order_by(Transaction.id).limit(limit)
            txns = list((await db.execute(q)).scalars().all())
            if not txns:
                return []
            out = []
            for txn in txns:
                try:
                    if txn.amount is None or not txn.currency or not txn.transaction_date:
                        # Нет суммы/валюты/даты — пересчитывать нечего, и это не
                        # «нет курса»: оператору нужны разные подсказки.
                        status = backfill_plan.INVALID
                    else:
                        await backfill_transaction(txn, db)
                        status = (backfill_plan.OK if txn.amount_eur is not None
                                  else backfill_plan.NO_RATE)
                except Exception as e:
                    logger.warning(f"backfill failed for txn {txn.id}: {e}")
                    status = backfill_plan.FAILED
                ts = txn.transaction_date
                tdate = ts.date() if hasattr(ts, "date") else ts
                out.append((txn.id, status, txn.currency, tdate))
            await db.commit()
            return out

    summary = await backfill_plan.drain_batches(
        process_batch,
        batch_size=batch_size,
        max_batches=max_batches,
        time_budget_seconds=time_budget_seconds,
        log=logger.info,
    )

    # Сколько строк осталось без EUR — источник правды для «что ещё не готово».
    remaining = 0
    async with AsyncSessionLocal() as db:
        count_q = select(sa_func.count(Transaction.id)).where(Transaction.amount_eur.is_(None))
        if company_id is not None:
            count_q = count_q.where(Transaction.company_id == company_id)
        r = await db.execute(count_q)
        remaining = r.scalar() or 0
    summary["remaining"] = remaining

    # Следующий шаг словами: без этого «осталось 500» выглядит как недоделка
    # приложения, хотя курса для этих валют в архиве ЕЦБ нет и не будет.
    # С датами: без конкретной даты пользователь добавляет курс «сегодня», видит
    # его в списке и не понимает, почему пересчёт снова сообщает «без курса».
    hint = backfill_plan.describe_unrated(
        summary.get("no_rate_currencies"), summary.get("no_rate_period"),
        summary.get("no_rate_detail"),
    )
    if summary.get("truncated"):
        summary["note"] = (
            "Обработаны не все строки: "
            + ({"time_budget": "истёк лимит времени запроса",
                "max_batches": "достигнут предел числа батчей",
                "no_progress": "источник батчей не двигал курсор (ошибка выборки)"}
               .get(summary.get("truncated_reason"), summary.get("truncated_reason") or "остановлено"))
            + ". Нажмите «Пересчитать» ещё раз — работа продолжится с места остановки."
            + ((" " + hint) if hint else "")
        )
    else:
        summary["note"] = hint
    return summary

# ──────────────────────────────────────────────────────────────────────
# Credential source_account hash helper
# ──────────────────────────────────────────────────────────────────────
def hash_source_account(username: str) -> str:
    """SHA-256 hash of the e100 username. Used as the `source_account`
    field on E100Credential and Transaction — stable across decryptions
    (so we don't have to decrypt the password to know which credential
    produced a transaction), but doesn't leak the username itself."""
    return hashlib.sha256((username or "").encode()).hexdigest()[:64]
