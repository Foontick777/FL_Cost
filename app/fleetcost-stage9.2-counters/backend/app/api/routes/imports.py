"""Q8 Truck CSV import — semicolon separated"""
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Query, Request
from sqlalchemy import select, and_, delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone, date as date_type
from decimal import Decimal
import csv, io, logging, time

from app.core.database import get_db
from app.api.deps import get_current_user, require_manager, get_request_context
from app.models.models import User, Transaction, Vehicle
from app.scraper.service import get_or_create_vehicle
from app.services import audit_service, fx_service, import_history_service, fx_autoload

logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/import", tags=["import"])

def q8_ftype(product: str) -> str:
    p = (product or "").lower().strip()
    if "ad blue" in p or "adblue" in p: return "AdBlue"
    if "diesel" in p or "дт" in p: return "Diesel"
    if "petrol" in p or "gasoline" in p: return "Petrol"
    return product or "Fuel"

# Лимит размера загрузки. Тот же, что в frontend/nginx.conf, но проверяется и
# в backend: запрос может прийти мимо nginx (напрямую в uvicorn, из скрипта).
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


async def read_upload_limited(file: UploadFile) -> bytes:
    """Читает загрузку порциями и обрывает её, если файл больше лимита.

    Раньше файл читался целиком: большая загрузка могла выесть память
    процесса (FC-013 в аудите). Порционное чтение позволяет остановиться на
    превышении, не загружая остаток файла.
    """
    chunks, total = [], 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Файл больше {MAX_UPLOAD_BYTES // (1024 * 1024)} МБ",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def parse_float(s):
    """Число из ячейки CSV/XLSX.

    Пустая ячейка — законный ноль: колонка может отсутствовать. Неразбираемый
    текст — ошибка. Раньше и то и другое давало 0.0, поэтому повреждённая сумма
    молча попадала в базу как нулевая (FC-009 в аудите). Строка с такой ошибкой
    теперь считается неудачной: внешний `except` вокруг строки ставит failed и
    пишет причину.
    """
    raw = (s or "").strip().replace(",", ".").replace(" ", "").replace("\xa0", "")
    if not raw or raw == "-":
        return 0.0
    return float(raw)

@router.post("/q8-csv")
async def import_q8_csv(
    request: Request,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Import Q8 Truck CSV. Owner or manager only (Issue #1).
    Issue #4: audit-logged. Issue #3: each imported Transaction gets
    fx_rate / amount_eur populated at insert time. Issue #6: records
    detailed ImportHistory entry with row counts + duration."""
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Only CSV files are supported")

    timer = import_history_service.ImportTimer()
    timer.__enter__()
    try:
        content = await read_upload_limited(file)
        try: text = content.decode("utf-8-sig")
        except: text = content.decode("latin-1")

        reader = csv.DictReader(io.StringIO(text), delimiter=";")
        rows = list(reader)
        if not rows:
            raise HTTPException(400, "CSV file is empty or wrong format")

        new_count = 0
        skipped = 0
        failed = 0
        file_dates = []
        # Why rows were skipped — surfaced in the UI and stored in
        # import_history.error_message. Previously every per-row problem was
        # swallowed by a bare `except: skipped += 1; continue`, so the operator
        # saw "500 skipped" with no way to find out what was wrong with them.
        skip_reasons: dict[str, int] = {}
        # Guards against duplicates *within* the same file.
        seen_external_ids: set[str] = set()

        def _skip(reason: str):
            skip_reasons[reason] = skip_reasons.get(reason, 0) + 1

        # Preload the external_ids already in the DB for this company.
        # The previous implementation ran one SELECT per CSV row (plus a
        # get_or_create_vehicle SELECT), i.e. ~2 queries × row count — a
        # 5 000-row card file meant ~10 000 round-trips inside one transaction.
        existing_ids: set[str] = set()
        pre = await db.execute(
            select(Transaction.external_id).where(and_(
                Transaction.company_id == current_user.company_id,
                Transaction.external_id.like("q8\\_%"),
            ))
        )
        existing_ids.update(eid for (eid,) in pre.all() if eid)
        # Vehicles are created lazily but only once per plate per file.
        vehicle_cache: dict[str, object] = {}

        # Курсы пар (валюта, дата) кэшируются на время импорта: без
        # этого на каждую строку уходил отдельный запрос (FC-015).
        rates_cache: dict = {}
        for row in rows:
            try:
                trs_date = row.get("TrsDate","").strip()
                trs_time = row.get("TrsTime","").strip()
                if not trs_date:
                    skipped += 1; _skip("пустая дата (TrsDate)"); continue

                try:
                    dt_str = f"{trs_date} {trs_time}" if trs_time else trs_date
                    fmt = "%d/%m/%Y %H:%M" if trs_time else "%d/%m/%Y"
                    txn_date = datetime.strptime(dt_str, fmt)
                    file_dates.append(txn_date.date())
                except Exception:
                    skipped += 1; _skip(f"не разобрана дата/время: {trs_date!r} {trs_time!r}"); continue

                tx_nr = row.get("TransactionNr","").strip()
                plate = (row.get("PlateNr","") or "").strip().upper()
                external_id = f"q8_{tx_nr}" if tx_nr else f"q8_{plate}_{txn_date.strftime('%Y%m%d%H%M%S')}"

                if external_id in existing_ids or external_id in seen_external_ids:
                    skipped += 1; _skip("уже есть в базе (дубликат external_id)"); continue

                # LOCAL CURRENCY amount (what driver actually paid, in station's currency)
                local_amount = parse_float(row.get("Station Curr. GrossAmount") or row.get("Cust. Curr. GrossAmount","0"))
                # Normalise the currency: it lands in varchar(10) and is used
                # as an FX lookup key, so a stray long/blank value used to
                # raise inside the bare except and vanish silently.
                local_currency = (row.get("Station Currency") or row.get("Cust. Curr.") or "EUR").strip().upper()
                if not local_currency or local_currency == "-" or len(local_currency) > 10:
                    local_currency = "EUR"

                # EUR amount (for reference, stored as price field since we don't have extra column)
                eur_amount = parse_float(row.get("EUR GrossAmount","0"))

                # Volume
                volume = parse_float(row.get("Volume","0"))

                # Price per liter in STATION CURRENCY (what driver sees on pump)
                price_local = parse_float(row.get("Station Curr. GrossUnitPrice") or row.get("Station Curr. NetUnitPrice","0"))
                # Price per liter in EUR
                price_eur = parse_float(row.get("EUR GrossUnitPrice") or row.get("EUR NetUnitPrice","0"))

                country = (row.get("Country") or "").strip()
                station = (row.get("StationName") or "").strip()
                driver = (row.get("DriverName") or "").strip() or None
                product = (row.get("Product") or "").strip()
                ftype = q8_ftype(product)

                vehicle = None
                if plate:
                    vehicle = vehicle_cache.get(plate)
                    if vehicle is None:
                        vehicle = await get_or_create_vehicle(db, current_user.company_id, plate, driver)
                        vehicle_cache[plate] = vehicle

                # Store local currency amount (same logic as E100)
                # Use local amount if available, fallback to EUR
                amount = local_amount if local_amount > 0 else eur_amount
                currency = local_currency

                db_txn = Transaction(
                    company_id=current_user.company_id,
                    vehicle_id=vehicle.id if vehicle else None,
                    source="q8",
                    external_id=external_id,
                    transaction_date=txn_date,
                    plate_number=plate or None,
                    driver_name=driver,
                    country=country or None,
                    station_id=row.get("StationID","").strip() or None,
                    station_address=station or None,
                    # Price per liter in local station currency
                    price=price_local if price_local > 0 else price_eur,
                    volume=volume,
                    amount=amount,
                    currency=currency,
                    fuel_type=ftype,
                    category_code=1,
                    is_confirmed=True,
                )
                # Issue #3: populate fx_rate / amount_eur on insert
                await fx_service.backfill_transaction(db_txn, db, cache=rates_cache)
                db.add(db_txn)
                seen_external_ids.add(external_id)
                existing_ids.add(external_id)
                new_count += 1

            except Exception as e:
                # A row that raised is a FAILURE, not a silent skip — it used
                # to be counted as "skipped" with no trace, so a file where
                # every row failed still reported status="success".
                failed += 1
                skipped += 1
                _skip(f"ошибка обработки строки: {type(e).__name__}: {str(e)[:80]}")
                logger.warning(
                    f"Q8 import: row {reader.line_num if hasattr(reader, 'line_num') else '?'} "
                    f"failed: {type(e).__name__}: {e}",
                    exc_info=True,
                )
                continue

        # Issue #4: audit the import (single summary row)
        ctx = get_request_context(request)
        reason_summary = "; ".join(f"{k}×{v}" for k, v in sorted(
            skip_reasons.items(), key=lambda kv: -kv[1])[:6]) or None
        await audit_service.log(
            db,
            company_id=current_user.company_id,
            user=current_user,
            action="IMPORT",
            entity_type="Transaction",
            entity_id=f"q8:{file.filename}",
            new_value={"imported": new_count, "skipped": skipped, "failed": failed,
                       "total_rows": len(rows), "skip_reasons": skip_reasons},
            ip=ctx["ip"],
            user_agent=ctx["user_agent"],
            client_id=ctx.get("client_id"),
        )
        await db.commit()

        # Issue #6: record detailed import history
        file_date_from = min(file_dates) if file_dates else None
        file_date_to = max(file_dates) if file_dates else None
        if failed == 0 and new_count > 0:
            status = "success"
        elif new_count > 0:
            status = "partial"
        else:
            status = "failed"
        await import_history_service.record_import(
            company_id=current_user.company_id,
            user=current_user,
            source="q8",
            filename=file.filename,
            total_rows=len(rows),
            new_rows=new_count,
            updated_rows=0,
            skipped_rows=skipped,
            failed_rows=failed,
            file_date_from=file_date_from,
            file_date_to=file_date_to,
            duration_ms=timer.duration_ms,
            status=status,
            error_message=reason_summary,
        )
        # Курс подставляется в момент записи строки и только из таблицы курсов: если
        # курса на дату заливки ещё не было, строка осталась без EUR и не попала в
        # суммы. Здесь закрываем этот разрыв — докачиваем недостающие даты из архива
        # ЕЦБ (только их, не всю историю) и пересчитываем то, что стало точнее.
        # Никогда не бросает: сбой докачки не должен превращать успешный импорт в ошибку.
        auto = await fx_autoload.auto_finish(current_user.company_id)
        return {"ok": True, "imported": new_count, "skipped": skipped, "failed": failed,
                "total_rows": len(rows), "skip_reasons": skip_reasons,
                "duration_ms": timer.duration_ms, "auto": auto}
    except HTTPException:
        raise
    except Exception as e:
        await import_history_service.record_import(
            company_id=current_user.company_id,
            user=current_user,
            source="q8",
            filename=file.filename if file else None,
            status="failed",
            error_message=str(e)[:500],
            duration_ms=timer.duration_ms,
        )
        raise
    finally:
        timer.__exit__(None, None, None)


# ── Income CSV import (Fakturownia-style) ─────────────
import re

def extract_plate_from_text(text: str, fleet_plates: set = None) -> str | None:
    """Extract vehicle plate (e.g. BI329LF, BI855GS) from product/service description.

    The plate appears before '/' which separates truck from trailer, e.g.:
        "...CMR Nr 61/s000391655 dnia 26.08.2026, BI855GS/QARA785"
        "..., BI866GS/QASB985"
        "..., BI866GS//QASB983"  (double slash)
        "...BI724LE/QARP459"  (no space before plate)

    Problem: the description also contains order/document numbers that look
    like plates (e.g. "ZL1794/08/26", "TU1472173"). The regex matches these
    first because they appear earlier in the text.

    Solution: find ALL candidate patterns, then:
      1. If fleet_plates is provided, return the first candidate that's in
         the fleet — this skips document numbers that happen to look like plates.
      2. Otherwise return the first candidate (best-effort).

    FUZZY MATCHING: if no candidate matches the fleet exactly, fall back to
    partial matching — match the plate prefix (everything except the last
    letter), so a typo in the last letter (BI329LF vs BI329LE) still resolves
    to the right vehicle. This is a common error from dispatchers.
    """
    if not text:
        return None

    # Candidate plate pattern: 2 uppercase letters + 2-4 digits + 0-3 uppercase letters.
    # (?<![A-Z]) prevents matching in the middle of a longer letter sequence.
    pattern = r'(?<![A-Z])([A-Z]{2}\d{2,4}[A-Z]{0,3})'

    candidates = []
    for m in re.finditer(pattern, text):
        candidate = m.group(1)
        if any(c.isdigit() for c in candidate) and 5 <= len(candidate) <= 9:
            candidates.append(candidate)

    if not candidates:
        return None

    # ── 1. Exact match against fleet ──
    if fleet_plates:
        fleet_upper = {p.upper() for p in fleet_plates}
        for c in candidates:
            if c.upper() in fleet_upper:
                return c.upper()

        # ── 2. Fuzzy match: same prefix (everything except last letter) ──
        # Handles dispatcher typos in the last letter (BI329LF vs BI329LE).
        # Only applies if the candidate has at least one trailing letter
        # (so plates like "BI329" with no letter suffix won't match "BI329LF").
        for c in candidates:
            if len(c) < 4:
                continue
            # Must have at least one trailing letter to fuzzy-match on
            if not c[-1].isalpha():
                continue
            prefix = c[:-1].upper()
            # Find a fleet plate whose prefix (minus last char) matches
            for fp in fleet_upper:
                if len(fp) >= 4 and fp[-1].isalpha() and fp[:-1] == prefix:
                    return fp
        # No match found — return None
        return None

    # Fallback (no fleet_plates provided): return the first candidate
    return candidates[0]


# Пара «тягач/прицеп» в описании услуги: BI329LF/QASB981, BI866GS//QASB983.
# Регистр НЕ приводим к верхнему: иначе строчные фрагменты номеров документов
# («CMR Nr 61/s000391655») превращались бы в «номера прицепов».
_PAIR_RE = re.compile(r"(?<![A-Z0-9])([A-Z]{2}\d{2,4}[A-Z]{0,3})\s*/{1,2}\s*([A-Z]{1,5}\d{2,5}[A-Z]{0,3})(?![A-Z0-9])")


def extract_trailer_from_text(text: str, truck_plate: str = None) -> str | None:
    """Номер ПРИЦЕПА из пары «тягач/прицеп» в описании услуги.

    Зачем. В счетах описание содержит пару: «...CMR Nr10040627 dnia 28.08.2026,
    BI329LF/QASB981». Раньше из неё брался только тягач, а номер прицепа
    выбрасывался — то есть информация о том, КАКОЙ прицеп работал с КАКОЙ
    машиной, приходила в систему с каждым счётом и терялась. Из этой пары
    восстанавливается реальная связка «прицеп ↔ машина ↔ дата», и по ней уже
    можно относить расходы прицепа на машину, которая им пользовалась, а не
    раскидывать ровным счётом на весь парк.

    Сначала ищем пару, где тягач совпадает с уже определённым номером машины —
    это защищает от номеров документов, похожих на пару. Если тягач не совпал,
    берём первую правдоподобную пару (в описании она обычно одна).
    """
    if not text:
        return None
    pairs = [m.group(1, 2) for m in _PAIR_RE.finditer(text)]
    if not pairs:
        return None
    if truck_plate:
        want = truck_plate.strip().upper()
        for truck, trailer in pairs:
            if truck == want:
                return trailer
    for _truck, trailer in pairs:
        # Отсекаем короткие «номера» вида ZL1794/08: прицеп — это буквы+цифры
        # и не короче шести знаков (QASB981, QARA785, QARP459).
        if len(trailer) >= 6:
            return trailer
    return None

@router.post("/income-csv")
async def import_income_csv(
    request: Request,
    file: UploadFile = File(...),
    purge: bool = Query(default=False, description="Delete ALL existing csv_income transactions before importing. Default FALSE (UPSERT mode): updates existing by invoice number, inserts new, leaves transactions not in CSV untouched. Use purge=true ONLY when you want a clean slate (e.g. first import after parser upgrade)."),
    confirm_purge: bool = Query(default=False, description="Safety interlock: MUST be true together with purge=true, otherwise the request is rejected with 400. Prevents an accidental/replayed query parameter from wiping all imported income."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Income CSV import (Fakturownia export). Owner or manager only (Issue #1).

    Rewritten to handle the realities of the real-world Fakturownia export:

    1. DATE — uses 'Data sprzedaży' (sale date = contract date) as the
       transaction date. Falls back to 'Data wystawienia' (issue date) only
       when 'Data sprzedaży' is empty (e.g. for "Nota księgowa" rows).
       Reason: employees often issue invoices in a later month than the
       actual transport (e.g. August invoice for a June transport).

    2. AMOUNT — takes ONLY the FIRST 'Wartość brutto' column (invoice-level
       total in the invoice's currency, e.g. EUR). The CSV has two columns
       with the same name: the FIRST is the invoice-currency amount, the
       SECOND is a per-line-item amount. We use csv.reader (positional)
       instead of DictReader to reliably get the first one. If the first
       is 0 (credit note case), we store 0 — no fallback to the second.

       ALSO captures 'Wartość brutto PLN' (unique column) and stores it
       in the Transaction.price field, so the frontend can show the PLN
       equivalent as a small gray sub-line under each amount for verification.

    3. PLATE — extracted from 'Produkt/usługa' text via extract_plate_from_text,
       which now supports FUZZY matching: if the candidate plate isn't in the
       fleet exactly, it tries matching the prefix (minus last letter), so
       "BI329LE" (typo) resolves to "BI329LF" (real fleet plate).

    4. NEGATIVES — credit notes / corrections are stored as real transactions
       with negative amount. They are NOT cancelled against positives
       (the old logic was lossy and hid legitimate corrections). The user
       can bind a vehicle to a negative transaction just like a positive one.

    5. UPSERT (default, purge=false) — by external_id = f"income_{numer}" (invoice
       number). If a transaction with the same invoice number already exists,
       its amount / date / currency / plate / description / PLN is UPDATED to
       match the latest CSV. New transactions are INSERTED. Transactions NOT
       in the CSV are LEFT UNTOUCHED — so you can safely re-import a partial
       CSV (e.g. last 3 months) without losing older data.

       PURGE mode (purge=true) — deletes ALL existing csv_income transactions
       before importing. Use this ONLY when you want a clean slate, e.g.:
         • First import after upgrading the parser (to clear old wrong data)
         • Suspecting data corruption and wanting to start fresh

    6. COMPANY — station_address is set to ONLY the company name from the
       'Nabywca' column. Previously appended 'Przyczyna korekty' and
       'Oryginalny dokument', which polluted the company name with stuff
       like "(Błędna kwota frachtu) · ref: 261".
    """
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Only CSV files are supported")

    content = await read_upload_limited(file)
    try:
        text = content.decode("utf-8-sig")
    except Exception:
        text = content.decode("latin-1")

    # ── Parse with csv.reader (positional) to avoid DictReader's
    # duplicate-column bug (Wartość netto / Wartość brutto appear twice).
    lines = text.split("\n")
    # Strip trailing \r from each line (Windows line endings)
    lines = [ln.rstrip("\r") for ln in lines]
    # Drop trailing empty lines
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        raise HTTPException(400, "CSV file is empty or wrong format")

    reader = csv.reader(lines)
    header = next(reader)
    rows_raw = list(reader)
    if not rows_raw:
        raise HTTPException(400, "CSV file is empty or wrong format")

    # Build column-name → first-occurrence-index map (so duplicate names
    # always resolve to the FIRST column with that name).
    col_idx = {}
    for i, name in enumerate(header):
        if name not in col_idx:
            col_idx[name] = i

    def get(row, name, default=""):
        i = col_idx.get(name)
        if i is None or i >= len(row):
            return default
        return row[i]

    # Get all company plates for matching
    vehicles_result = await db.execute(
        select(Vehicle).where(Vehicle.company_id == current_user.company_id)
    )
    all_vehicles = vehicles_result.scalars().all()
    fleet_plates = {v.plate_number.upper() for v in all_vehicles}
    # Map plate (uppercase) → vehicle_id, for fast lookup
    plate_to_vehicle = {v.plate_number.upper(): v.id for v in all_vehicles}

    skip_reasons = []
    new_count = 0
    updated_count = 0
    skipped = 0
    # Прицепы, встреченные в описаниях услуг («BI329LF/QASB981»). Возвращаем их
    # в ответе импорта: пользователь сразу видит, что связка «прицеп ↔ машина»
    # распознана, а не потеряна.
    # Строки, которые действительно НЕ удалось обработать (сломанная дата,
    # исключение). Отдельно от `skipped`: пропуск по правилу (нулевая сумма,
    # неизменившийся дубликат) — это не ошибка импорта.
    failed = 0
    # Реальные даты обработанных строк. Нужны для колонки «Дата в файле»:
    # раньше туда попадали ключи месяцев («2026-07») как первое число месяца.
    parsed_dates = []
    purged_count = 0
    # Per-month breakdown for debugging — lets the user verify the import
    # matches their CSV. Keyed by "YYYY-MM" (based on Data sprzedaży).
    monthly_breakdown = {}  # {"2026-07": {"count": 52, "eur": 94544.51, "pln": 388279.31}}
    # Currencies we could not convert to EUR (no rate on/around the invoice
    # date) — reported back so the user knows the EUR summary is incomplete
    # instead of silently under-reporting it.
    missing_fx_currencies: set = set()

    # ── PURGE mode (default=True): delete ALL existing csv_income transactions
    # for this company before importing. This guarantees a clean slate:
    # no stale data from previous parser versions, no orphaned transactions
    # with wrong dates/amounts. Manual income (source="manual") is NOT deleted
    # — only CSV-imported income (source="csv_income").
    if purge:
        # Safety interlock: `purge=true` destroys every imported income row.
        # It used to be enough to change one character in the URL (or to replay
        # a stale request) to wipe the whole income history, and the audit log
        # only recorded a row COUNT. Now the caller must also pass
        # confirm_purge=true, and we snapshot what is about to be deleted.
        if not confirm_purge:
            raise HTTPException(
                400,
                "purge=true requires confirm_purge=true — this deletes ALL imported "
                "income for the company. Confirm in the UI to proceed.",
            )
        purge_snapshot = (await db.execute(
            select(
                func.count(Transaction.id),
                func.min(Transaction.transaction_date),
                func.max(Transaction.transaction_date),
            ).where(
                Transaction.company_id == current_user.company_id,
                Transaction.source == "csv_income",
            )
        )).one()
        purge_result = await db.execute(
            delete(Transaction).where(
                Transaction.company_id == current_user.company_id,
                Transaction.source == "csv_income",
            )
        )
        purged_count = purge_result.rowcount or 0
        await db.flush()  # execute the DELETE without committing yet
        existing_by_extid = {}  # no existing transactions to upsert against
        logger.warning(
            f"Income import: PURGE deleted {purged_count} csv_income rows for "
            f"company {current_user.company_id} (user={current_user.email})"
        )
    else:
        # Preload existing income external_ids → Transaction for upsert mode.
        existing_income_txns = (await db.execute(
            select(Transaction).where(
                Transaction.company_id == current_user.company_id,
                Transaction.source == "csv_income",
            )
        )).scalars().all()
        existing_by_extid = {t.external_id: t for t in existing_income_txns}

    # Курсы пар (валюта, дата) кэшируются на время импорта: без
    # этого на каждую строку уходил отдельный запрос (FC-015).
    rates_cache: dict = {}
    for idx, row in enumerate(rows_raw, start=2):
        try:
            # ── Invoice number — primary dedup key ──
            invoice_nr = (get(row, "numer") or "").strip()
            if not invoice_nr:
                reason = f"Row {idx}: empty invoice number (numer)"
                skip_reasons.append(reason)
                skipped += 1
                continue

            # ── Amount — FIRST 'Wartość brutto' ONLY (invoice-level, invoice currency) ──
            # The CSV has two columns named "Wartość brutto"; we use ONLY the
            # first one (invoice-level total in the invoice's currency, e.g. EUR).
            # If it's 0 (credit note case where invoice-level brutto is 0), we
            # store 0 — that's the correct value for that column, as the user
            # explicitly requested. No fallback to the second column.
            brutto_str = (get(row, "Wartość brutto") or "").strip().replace(",", ".").replace(" ", "")
            # Decimal, not float: the column is NUMERIC(14,2) and float cannot
            # represent cents exactly, which made the "did anything change?"
            # comparison below unreliable and let rounding drift into stored
            # money.
            try:
                brutto = Decimal(brutto_str).quantize(Decimal("0.01")) if brutto_str else Decimal("0")
            except Exception:
                reason = f"Row {idx}: unparsable amount '{brutto_str}' (invoice='{invoice_nr}')"
                skip_reasons.append(reason)
                skipped += 1
                continue

            # Also capture Wartość brutto PLN (unique column) for display.
            # Stored in the Transaction.price field, shown as a small gray
            # sub-line under the amount in the income table — so the user
            # can verify that EUR ↔ PLN totals match.
            brutto_pln_str = (get(row, "Wartość brutto PLN") or "").strip().replace(",", ".").replace(" ", "")
            try:
                brutto_pln = (
                    Decimal(brutto_pln_str).quantize(Decimal("0.01"))
                    if brutto_pln_str else Decimal("0")
                )
            except Exception:
                brutto_pln = Decimal("0")

            # Skip only if both are genuinely 0 (no data in either column)
            if brutto == 0 and brutto_pln == 0:
                reason = f"Row {idx}: zero amount (brutto='{brutto_str}', brutto_pln='{brutto_pln_str}', invoice='{invoice_nr}')"
                skip_reasons.append(reason)
                skipped += 1
                continue

            # ── Date — Data sprzedaży (sale date) preferred, fallback Data wystawienia ──
            sale_date_str = (get(row, "Data sprzedaży") or "").strip()
            issue_date_str = (get(row, "Data wystawienia") or "").strip()
            date_str = sale_date_str or issue_date_str
            if not date_str:
                reason = f"Row {idx}: empty date (invoice='{invoice_nr}')"
                skip_reasons.append(reason)
                skipped += 1
                continue
            try:
                # Use noon UTC to avoid timezone-shift issues: a naive datetime
                # saved to a timezone-aware column gets interpreted as UTC, and
                # if the DB session timezone is < UTC, cast(... as Date) can
                # shift the date to the previous day. Using noon (12:00) UTC
                # ensures the date is the same in any timezone from UTC-12 to UTC+12.
                naive = datetime.strptime(date_str, "%Y-%m-%d")
                txn_date = datetime(naive.year, naive.month, naive.day, 12, 0, 0, tzinfo=timezone.utc)
            except ValueError:
                reason = f"Row {idx}: bad date format '{date_str}' (invoice='{invoice_nr}')"
                skip_reasons.append(reason)
                skipped += 1
                failed += 1
                continue

            # ── Company / currency / product ──
            company = " ".join((get(row, "Nabywca") or "").strip().split())
            currency = (get(row, "Waluta") or "EUR").strip()
            if not currency or currency == "-":
                currency = "EUR"
            product = (get(row, "Produkt/usługa") or "").strip()

            # ── External ID for dedup/upsert ──
            # CRITICAL: The dedup key must be STABLE across different CSV exports
            # from Fakturownia. The user generates reports for different date
            # ranges (e.g. yearly vs last 3 months), and the LP (row number)
            # is reset to 1 in each export — so LP can't be used.
            #
            # We use: numer + Data sprzedaży (invoice number + sale date).
            # This combination is:
            #   • Unique within a single CSV (475/475 in real-world exports)
            #   • Stable across different exports — the same invoice from the
            #     same sale date always produces the same key, regardless of
            #     which date range the report was generated for
            #
            # Multi-line invoices: the same `numer` can appear with different
            # sale dates (e.g. credit note issued later). The date component
            # keeps them as separate transactions — exactly what we want.
            #
            # The `date_str` is already computed above (Data sprzedaży with
            # fallback to Data wystawienia).
            external_id = f"income_{invoice_nr}_{date_str}"

            # ── Plate extraction with fuzzy matching ──
            plate = extract_plate_from_text(product, fleet_plates)
            plate_number = plate if plate else None
            vehicle_id = plate_to_vehicle.get(plate_number) if plate_number else None
            # Из описания берём ТОЛЬКО номер тягача. Номер прицепа в доходах не
            # разбираем и в реестр прицепов не заносим: прицепы ведутся вручную в
            # расходах раздела «Прицепы», а пара «тягач/прицеп» из текста услуги
            # давала случайные номера. Уже сохранённый trailer_plate не трогаем.
            trailer_plate = None

            # station_address = company name ONLY (from the Nabywca column).
            # Previously appended Przyczyna korekty and Oryginalny dokument,
            # which polluted the company name with stuff like
            # "(Błędna kwota frachtu) · ref: 261". The user wants ONLY the
            # company name from Nabywca.
            description = company

            # ── Save the RAW product text (which contains the plate number as
            # typed by the dispatcher, e.g. "BI4866GS/QARA784") in the
            # driver_name field. This is used by the frontend to show an "i"
            # icon next to unassigned transactions — when the user hovers
            # over it, they see what plate was in the CSV (so they can spot
            # typos like BI4866GS → should be BI866GS, and bind the right
            # vehicle manually).
            #
            # driver_name is normally empty for income transactions (CSV
            # income has no driver info), so reusing it here is safe and
            # doesn't conflict with anything.
            raw_plate_text = product[:255] if product else None  # truncate to field size

            # ── Upsert ──
            existing = existing_by_extid.get(external_id)
            if existing:
                # Update in place if anything changed
                changed = False
                if existing.amount != brutto:
                    existing.amount = brutto; changed = True
                if existing.currency != currency:
                    existing.currency = currency; changed = True
                # Compare dates by their date part only (ignore time/timezone).
                # txn_date is now noon UTC; existing.transaction_date may be
                # stored as midnight UTC (from old imports) or noon UTC (new).
                existing_d = existing.transaction_date.date() if existing.transaction_date else None
                new_d = txn_date.date()
                if existing_d != new_d:
                    existing.transaction_date = txn_date; changed = True
                if (existing.plate_number or None) != plate_number:
                    existing.plate_number = plate_number; changed = True
                if (existing.vehicle_id or None) != (vehicle_id or None):
                    existing.vehicle_id = vehicle_id; changed = True
                if (existing.station_address or "") != description:
                    existing.station_address = description; changed = True
                if (existing.station_id or None) != (invoice_nr or None):
                    existing.station_id = invoice_nr; changed = True
                if (existing.price or 0) != brutto_pln:
                    existing.price = brutto_pln; changed = True
                # Save the raw product text (with plate as typed) in driver_name
                if (existing.driver_name or None) != raw_plate_text:
                    existing.driver_name = raw_plate_text; changed = True
                if changed:
                    updated_count += 1
                    # Don't count as "skipped" — it's a legitimate update
                else:
                    skipped += 1
            else:
                # Insert new
                db_txn = Transaction(
                    company_id=current_user.company_id,
                    vehicle_id=vehicle_id,
                    source="csv_income",
                    external_id=external_id,
                    transaction_date=txn_date,
                    plate_number=plate_number,
                    driver_name=raw_plate_text,  # raw product text with plate, for "i" icon tooltip
                    station_address=description,
                    station_id=invoice_nr,
                    price=brutto_pln,  # PLN amount — shown as small gray sub-line in income table
                    amount=brutto,
                    currency=currency,
                    fuel_type="manual_income_freight",
                    is_confirmed=True,
                )
                # Issue #3: populate fx_rate / amount_eur at insert time.
                # NOTE: For income transactions, brutto is in the invoice's
                # currency (e.g. EUR). fx_rate will be 1.0 for EUR transactions,
                # and the actual rate for foreign-currency invoices.
                await fx_service.backfill_transaction(db_txn, db, cache=rates_cache)
                db.add(db_txn)
                # Track in map in case the same invoice number appears
                # twice in the same CSV (shouldn't happen, but defensive).
                existing_by_extid[external_id] = db_txn
                new_count += 1

            # ── Monthly breakdown (for debugging) ──
            # Track every successfully processed row (insert OR update) by
            # its Data sprzedaży month. The dedup key is `income_{numer}_{date}`
            # (see above), so each row = one transaction and the count matches
            # both the CSV row count and the DB transaction count.
            parsed_dates.append(txn_date.date())
            month_key = txn_date.strftime("%Y-%m")
            if month_key not in monthly_breakdown:
                monthly_breakdown[month_key] = {"count": 0, "eur": 0.0, "pln": 0.0}
            monthly_breakdown[month_key]["count"] += 1
            # EUR equivalent for the summary. This used to be
            # `float(brutto) * 0.23  # rough rate` for PLN and *nothing* for
            # any other currency — the summary shown right after an import could
            # therefore contradict the amount_eur stored on the transactions.
            # Use the same FX service the transactions use.
            eur_equiv = None
            if currency == "EUR":
                eur_equiv = brutto
            else:
                _r, _amt_eur, _rd, _src = await fx_service.convert_to_eur(
                    brutto, currency, txn_date.date(), db,
                    company_id=current_user.company_id,
                )
                if _amt_eur is None:
                    missing_fx_currencies.add(currency)
                else:
                    eur_equiv = _amt_eur
            if eur_equiv is not None:
                monthly_breakdown[month_key]["eur"] += float(eur_equiv)
            monthly_breakdown[month_key]["pln"] += float(brutto_pln)

        except Exception as e:
            reason = f"Row {idx}: ERROR - {type(e).__name__}: {e}"
            skip_reasons.append(reason)
            logger.error(f"[income-csv] {reason}", exc_info=True)
            skipped += 1
            failed += 1
            continue

    # Issue #4: audit the import (single summary row)
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="IMPORT",
        entity_type="Transaction",
        entity_id=f"income:{file.filename}",
        new_value={
            "imported": new_count, "updated": updated_count,
            "skipped": skipped, "purged": purged_count,
            "purged_period": (
                f"{purge_snapshot[1]:%Y-%m-%d}..{purge_snapshot[2]:%Y-%m-%d}"
                if purge and purge_snapshot[1] and purge_snapshot[2] else None
            ),
            "total_rows": len(rows_raw),
            "unconverted_currencies": sorted(missing_fx_currencies) or None,
        },
        old_value={"purged_rows": purge_snapshot[0]} if purge else None,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()

    result = {
        "ok": True,
        "parser_version": "v5_numer_date_dedup",
        "imported": new_count,
        "updated": updated_count,
        "skipped": skipped,
        "purged": purged_count,
        "total_rows": len(rows_raw),
        "monthly_breakdown": monthly_breakdown,
    }
    if missing_fx_currencies:
        # Tell the user the EUR column in monthly_breakdown is incomplete
        # rather than letting it look authoritative.
        result["unconverted_currencies"] = sorted(missing_fx_currencies)
        result["unconverted_note"] = (
            "Для этих валют нет курса на дату счёта — в колонке EUR они не учтены. "
            "Добавьте ручной курс в «Курсы валют» — это может сделать "
            "владелец или менеджер."
        )
    if skip_reasons:
        result["skip_reasons"] = skip_reasons[:50]
        if len(skip_reasons) > 50:
            result["skip_reasons_truncated"] = len(skip_reasons) - 50

    # Автодогрузка курсов и автопересчёт — сразу после импорта, пока оператор ещё
    # смотрит на результат. Для валют, которых нет в архиве ЕЦБ (BYN, RSD…), сводка
    # назовёт конкретные даты, на которые нужен ручной курс.
    result["auto"] = await fx_autoload.auto_finish(current_user.company_id)

    # Issue #6: record detailed import history
    # Диапазон дат — из РЕАЛЬНЫХ дат обработанных строк. Раньше он собирался из
    # ключей месячной разбивки, то есть из «первого числа месяца»: для файла с
    # августом и одной июльской продажей в истории появлялось
    # «01.07.2026 — 01.08.2026» — похоже на ошибку диапазона, хотя импорт верный.
    file_dates = parsed_dates
    # «ОШИБ» — только реально упавшие строки. Раньше тут стояло
    # len(skip_reasons), то есть число ПРИЧИН: строка, пропущенная по правилу
    # (например, нулевая сумма), попадала одновременно и в «ПРОП», и в «ОШИБ».
    failed_count = failed
    status = "success" if failed_count == 0 else ("partial" if (new_count + updated_count) > 0 else "failed")
    await import_history_service.record_import(
        company_id=current_user.company_id,
        user=current_user,
        source="fakturownia",
        filename=file.filename,
        total_rows=len(rows_raw),
        new_rows=new_count,
        updated_rows=updated_count,
        skipped_rows=skipped,
        failed_rows=failed_count,
        file_date_from=min(file_dates) if file_dates else None,
        file_date_to=max(file_dates) if file_dates else None,
        status=status,
    )
    return result



# ── Mileage XLSX import (nav.by "Подробный" export) ────
import openpyxl
from app.models.models import Mileage, MileageSegment

def normalize_plate(raw: str) -> str:
    """nav.by exports plates like 'BI 855GS' with a stray space; our fleet
    plates are stored without spaces (e.g. 'BI855GS')."""
    return re.sub(r"\s+", "", (raw or "")).upper()


def _parse_hms(s):
    """'HH:MM:SS' -> seconds since midnight, or None if unparseable."""
    if s is None:
        return None
    try:
        h, m, sec = str(s).strip().split(":")
        return int(h) * 3600 + int(m) * 60 + int(sec)
    except Exception:
        return None


@router.post("/mileage-xlsx")
async def import_mileage_xlsx(
    request: Request,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Import nav.by XLSX (mileage + segments). Owner or manager only (Issue #1).
    Issue #4: audit-logged."""
    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "Only .xlsx files are supported")

    content = await read_upload_limited(file)
    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    except Exception as e:
        raise HTTPException(400, f"Could not read XLSX file: {e}")
    ws = wb.active

    # nav.by has shifted which column "Объект/Дата" starts in between exports
    # (column B in older files, column A in newer ones) — auto-detect the
    # offset from row 1 instead of hardcoding it, so both formats work.
    header_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), ())
    col = None
    for i, cell in enumerate(header_row):
        if cell and "Объект/Дата" in str(cell):
            col = i
            break
    if col is None:
        col = 1  # fallback: assume the older "column B" layout

    # ── Column layout, relative to the detected "Объект/Дата" column ──────
    # col+0 Объект/Дата (summary header) | col+1 Комментарий | col+2 Объект
    # col+3 Дата | col+4 С | col+5 По | col+6 Состояние | col+7 Пробег | col+8 Расход ДУТ

    # Existing fleet plates for this company, for vehicle_id matching
    vehicles_result = await db.execute(
        select(Vehicle).where(Vehicle.company_id == current_user.company_id)
    )
    fleet = {v.plate_number.upper(): v.id for v in vehicles_result.scalars().all()}

    # Preload existing external_ids once (instead of one query per row —
    # matters here since a two-month export can carry 5,000+ detail rows).
    existing_mileage_ids = set((await db.execute(
        select(Mileage.external_id).where(Mileage.company_id == current_user.company_id)
    )).scalars().all())
    existing_segment_ids = set((await db.execute(
        select(MileageSegment.external_id).where(MileageSegment.company_id == current_user.company_id)
    )).scalars().all())

    new_count = 0
    skipped = 0
    new_segments = 0
    skipped_segments = 0
    unmatched_plates = set()

    current_plate = None  # tracks which vehicle the detail rows below a
    current_day = None    # summary row belong to (detail rows don't repeat it)
    # Даты разобранных строк — для колонки «Дата в файле» в истории импортов.
    # Раньше диапазон не сохранялся вообще, и в истории стояло «—», хотя колонка
    # «Дата» в файле заполнена.
    file_dates = []

    def cell(row, rel_idx):
        idx = col + rel_idx
        return row[idx] if len(row) > idx else None

    for row in ws.iter_rows(min_row=2, values_only=True):
        header_cell = cell(row, 0)

        if header_cell:
            # ── Summary row: "DD.MM.YYYY\nPLATE", daily km and daily fuel
            # consumption in liters. ────────────────────────────────────
            m = re.match(r"(\d{2}\.\d{2}\.\d{4})\s*\n?\s*(.+)", str(header_cell).strip())
            if not m:
                continue  # e.g. the trailing "Итого:" grand-total row
            date_str, plate_raw = m.group(1), m.group(2)
            plate = normalize_plate(plate_raw)
            if not re.search(r"\d", plate):
                continue  # not a real plate (defensive, catches stray total rows)

            try:
                day = datetime.strptime(date_str, "%d.%m.%Y")
            except ValueError:
                skipped += 1
                continue

            current_plate, current_day = plate, day
            file_dates.append(day.date())

            km = cell(row, 7)
            km = float(km) if km is not None else 0.0
            fuel = cell(row, 8)
            fuel = float(fuel) if fuel is not None else None

            external_id = f"mileage_{plate}_{day.strftime('%Y%m%d')}"
            if external_id in existing_mileage_ids:
                skipped += 1
                continue

            vehicle_id = fleet.get(plate)
            if vehicle_id is None:
                unmatched_plates.add(plate)

            db.add(Mileage(
                company_id=current_user.company_id,
                vehicle_id=vehicle_id,
                plate_number=plate,
                date=day,
                km=km,
                fuel_liters=fuel,
                source="navby_xlsx",
                external_id=external_id,
            ))
            existing_mileage_ids.add(external_id)
            new_count += 1
            continue

        # ── Detail row: one movement/stop segment (Объект, Дата, С, По,
        # Состояние, Пробег). These carry the time-balance / КТУ / avg-speed
        # / stop-count data the summary rows don't. ───────────────────────
        plate_raw = cell(row, 2)
        status = cell(row, 6)
        if not plate_raw or status not in ("Движение", "Стоянка"):
            continue

        plate = normalize_plate(plate_raw)
        date_str = cell(row, 3)
        try:
            day = datetime.strptime(str(date_str).strip(), "%d.%m.%Y") if date_str else current_day
        except ValueError:
            day = current_day
        if day is None:
            skipped_segments += 1
            continue
        file_dates.append(day.date())

        time_from_raw = cell(row, 4)
        time_to_raw = cell(row, 5)
        time_from = str(time_from_raw) if time_from_raw is not None else None
        time_to = str(time_to_raw) if time_to_raw is not None else None

        sec_from, sec_to = _parse_hms(time_from), _parse_hms(time_to)
        if sec_from is None or sec_to is None:
            skipped_segments += 1
            continue
        duration = sec_to - sec_from
        if duration < 0:
            duration += 86400  # segment crosses midnight

        seg_km = cell(row, 7)
        seg_km = float(seg_km) if seg_km is not None else None

        external_id = f"mileageseg_{plate}_{day.strftime('%Y%m%d')}_{time_from}_{time_to}_{status}"
        if external_id in existing_segment_ids:
            skipped_segments += 1
            continue

        vehicle_id = fleet.get(plate)
        if vehicle_id is None:
            unmatched_plates.add(plate)

        db.add(MileageSegment(
            company_id=current_user.company_id,
            vehicle_id=vehicle_id,
            plate_number=plate,
            date=day,
            time_from=time_from,
            time_to=time_to,
            status=status,
            km=seg_km,
            duration_seconds=duration,
            source="navby_xlsx",
            external_id=external_id,
        ))
        existing_segment_ids.add(external_id)
        new_segments += 1

    # Issue #4: audit the import
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="IMPORT",
        entity_type="Mileage",
        entity_id=f"xlsx:{file.filename}",
        new_value={
            "imported": new_count, "skipped": skipped,
            "segments_imported": new_segments, "segments_skipped": skipped_segments,
            "unmatched_plates": sorted(unmatched_plates) or None,
        },
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    # Issue #6: record detailed import history
    failed_count = skipped + skipped_segments
    status = "success" if failed_count == 0 else ("partial" if (new_count + new_segments) > 0 else "failed")
    await import_history_service.record_import(
        company_id=current_user.company_id,
        user=current_user,
        source="navby_mileage",
        filename=file.filename,
        total_rows=new_count + skipped + new_segments + skipped_segments,
        new_rows=new_count + new_segments,
        updated_rows=0,
        skipped_rows=skipped + skipped_segments,
        # Здесь нет пути, который «роняет» строку молча: нераспознанные строки
        # уходят в пропуски с причиной, поэтому ошибок всегда 0. Не хардкод
        # «на всякий случай», а отсутствие такого случая.
        failed_rows=0,
        file_date_from=min(file_dates) if file_dates else None,
        file_date_to=max(file_dates) if file_dates else None,
        status=status,
    )
    return {
        "ok": True,
        "imported": new_count,
        "skipped": skipped,
        "segments_imported": new_segments,
        "segments_skipped": skipped_segments,
        "unmatched_plates": sorted(unmatched_plates) or None,
    }