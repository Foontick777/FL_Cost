import logging
from datetime import date, timedelta, datetime, time, timezone
from typing import Optional
from sqlalchemy import select, and_, func, cast, Date
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import AsyncSessionLocal
from app.core.security import decrypt_credentials
from app.models.models import (
    Company, E100Credential, Vehicle, Transaction, ScraperSettings,
)
from app.scraper.e100_client import E100Client, E100Transaction, _redact
from app.telegram.notifications import send_new_transaction_notification
from app.services import fx_service, audit_service, import_history_service

logger = logging.getLogger(__name__)

AMOUNT_TOLERANCE = 0.02  # cents-level float slack when comparing currency sums


def make_base_key(txn: E100Transaction) -> str:
    """
    Best-effort key per transaction from fields e100 actually gives us.

    Deliberately excludes amount, station_id, AND the insert timestamp: e100
    revises a transaction as it moves from "blocked"/"delayed" toward its
    final state, and in practice we've seen it correct the amount by a cent,
    correct which exact gantry/station registered a toll charge, and shift
    its own "last touched" timestamp — all for what e100 itself shows as one
    single transaction throughout. Any of those fields in the key turned a
    routine status change into a phantom "new" transaction. save_transactions
    below updates the existing row's amount/station/status in place when it
    finds a match on this key, instead of inserting a second row.

    The vehicle-identifying part uses auto (plate) rather than card_shortname:
    card_shortname is null for some transaction types (anonymous service
    fees), which would otherwise let unrelated vehicles collide into the same
    key. The timestamp is truncated to the minute rather than kept to the
    second, since even that has been observed to shift by a few seconds
    between an entry's blocked and delayed states.

    Card/vehicle + minute + service category is coarser than earlier
    attempts, but that's intentional: genuinely different charges for the
    same vehicle and category inside the same minute still all get stored —
    save_transactions appends a running occurrence counter per group — so
    the only cost of the coarser key is grouping them together for matching
    purposes, not losing any of them.
    """
    vehicle_key = txn.auto or txn.card_shortname or "noauto"
    dt_str = txn.date.strftime("%Y%m%d%H%M") if txn.date else "unknown"
    return f"e100_{vehicle_key}_{dt_str}_{txn.service_category}"


async def get_or_create_vehicle(db, company_id: int, plate: str,
                                 driver_name: Optional[str] = None) -> Optional[Vehicle]:
    result = await db.execute(
        select(Vehicle).where(and_(Vehicle.company_id == company_id, Vehicle.plate_number == plate))
    )
    vehicle = result.scalar_one_or_none()
    if not vehicle:
        vehicle = Vehicle(company_id=company_id, plate_number=plate, driver_name=driver_name)
        db.add(vehicle)
        await db.flush()
        logger.info(f"Auto-created vehicle {plate}")
    elif driver_name and not vehicle.driver_name:
        vehicle.driver_name = driver_name
    return vehicle


async def save_transactions(db, company_id: int,
                             transactions: list[E100Transaction], notify: bool = True,
                             credential_id: Optional[int] = None,
                             source_account: Optional[str] = None) -> dict:
    """Persist fetched e100 transactions for a company.

    Returns a dict with detailed counts so callers (sync_company) can
    report per-service metrics in ImportHistory:
      {"new": N, "updated": N, "unchanged": N, "removed": N}

    Issue #2 (transaction history): when an existing transaction is
    UPDATED (amount corrected, status shifted, etc.), we capture a
    TransactionRevision snapshot of the OLD values BEFORE applying the
    new ones. The main `transactions` table always shows the current
    state — revisions give the bookkeeper the full history.

    Issue #12: credential_id + source_account tie each transaction
    back to the specific E100 credential that produced it.
    Issue #3: each new Transaction gets fx_rate / amount_eur populated.
    """
    new_count = 0
    updated_count = 0
    unchanged_count = 0
    removed_count = 0
    # Telegram notifications are queued here and sent only AFTER db.commit():
    # sending them inline meant the user could receive "новая транзакция" for a
    # row that a later error rolled back.
    pending_notifications: list = []

    # Lazy import to avoid circular import
    from app.models.models import TransactionRevision

    # Group this fetch by base_key, preserving e100's own order within each group.
    groups: dict[str, list[E100Transaction]] = {}
    for txn in transactions:
        groups.setdefault(make_base_key(txn), []).append(txn)

    def _dt_eq(a, b):
        """Compare two datetimes, ignoring timezone differences. E100 client
        returns NAIVE datetimes (no tzinfo), but PostgreSQL stores them in
        timezone-aware columns (DateTime(timezone=True)) → on read back
        they have tzinfo=UTC. Without this normalization, every sync would
        consider EVERY transaction "changed" (naive vs aware → !=), which
        would bloat transaction_revisions with thousands of empty revision
        rows at every sync cycle (60 min interval = ~17K revisions/day)."""
        if a is None and b is None:
            return True
        if a is None or b is None:
            return False
        # Strip timezone info from both sides for comparison
        try:
            if hasattr(a, 'tzinfo') and a.tzinfo is not None:
                a = a.replace(tzinfo=None)
            if hasattr(b, 'tzinfo') and b.tzinfo is not None:
                b = b.replace(tzinfo=None)
        except Exception:
            pass
        return a == b

    for base_key, txns_in_group in groups.items():
        fetched_count = len(txns_in_group)

        # Map Transaction column names → E100Transaction field names for comparison
        _e100_field_map = {
            "price": "price",
            "amount": "amount",
            "currency": "currency",
            "is_confirmed": "is_confirmed",
            "station_id": "station_id",
            "station_address": "address",
            "station_region": "station_region",
        }

        def _occ(t) -> int:
            """Numeric occurrence parsed from the `_nNNN` suffix.

            Sorting the raw external_id strings put _n10 before _n2, so once a
            group had ≥10 rows the pairing below (our row i ↔ e100 row i) was
            misaligned: amounts and statuses were written into the WRONG
            transaction and bogus rows piled up in transaction_revisions.
            """
            try:
                return int((t.external_id or "").rsplit("_n", 1)[-1])
            except (ValueError, IndexError):
                return 0

        existing_rows = sorted((await db.execute(
            select(Transaction).where(and_(
                Transaction.company_id == company_id,
                Transaction.external_id.like(f"{base_key}_n%"),
            ))
        )).scalars().all(), key=_occ)
        existing_count = len(existing_rows)

        if existing_count > fetched_count:
            # We have more rows under this key than e100 currently reports for
            # this exact date/station/category/card combo. That's stale
            # data — drop the extras so our count matches source again.
            extras = existing_rows[fetched_count:]
            # Issue #3 fix: delete TransactionRevision rows for the extras
            # FIRST, to avoid FK violation on transaction_revisions.
            from sqlalchemy import delete as sa_delete
            extra_ids = [t.id for t in extras]
            if extra_ids:
                await db.execute(
                    sa_delete(TransactionRevision).where(
                        TransactionRevision.transaction_id.in_(extra_ids)
                    )
                )
            for t in extras:
                logger.warning(f"Removing stale transaction no longer reported by e100: {t.external_id}")
                await db.delete(t)
                removed_count += 1
            existing_rows = existing_rows[:fetched_count]
            existing_count = len(existing_rows)

        # Rows present on both sides: refresh amount/status in place, since
        # e100 can revise a transaction (blocked/delayed -> confirmed, with a
        # corrected amount) after we first saved it.
        # Курсы пар (валюта, дата) кэшируются на время импорта: без
        # этого на каждую строку уходил отдельный запрос (FC-015).
        rates_cache: dict = {}
        for i in range(existing_count):
            txn = txns_in_group[i]
            db_txn = existing_rows[i]

            # Detect if anything actually changed — if not, this is an
            # "unchanged" sync (the common case). Saves a revision row +
            # an UPDATE. Uses _dt_eq for inserted_at_source to avoid
            # timezone-aware vs naive false-positive (Fix #4).
            fields_simple = ["price", "amount", "currency", "is_confirmed",
                             "station_id", "station_address", "station_region"]
            changed = any(
                (getattr(db_txn, f) is None and getattr(txn, _e100_field_map[f]) is not None) or
                (getattr(db_txn, f) is not None and getattr(txn, _e100_field_map[f]) is None) or
                (getattr(db_txn, f) != getattr(txn, _e100_field_map[f]))
                for f in fields_simple
            )
            # inserted_at_source needs special timezone-aware comparison
            if not changed and not _dt_eq(db_txn.inserted_at_source, txn.datetime_insert):
                changed = True

            if changed:
                # Issue #2: capture a revision BEFORE applying the new
                # values. We store the OLD state, so the revision chain
                # looks like: rev1=initial, rev2=after-first-update, etc.
                db.add(TransactionRevision(
                    transaction_id=db_txn.id,
                    company_id=company_id,
                    source="e100",
                    amount=db_txn.amount,
                    currency=db_txn.currency,
                    is_confirmed=db_txn.is_confirmed,
                    fx_rate=db_txn.fx_rate,
                    amount_eur=db_txn.amount_eur,
                    inserted_at_source=db_txn.inserted_at_source,
                    station_id=db_txn.station_id,
                    station_address=db_txn.station_address,
                    station_region=db_txn.station_region,
                ))
                # Apply new values
                db_txn.price = txn.price
                db_txn.amount = txn.amount
                db_txn.currency = txn.currency
                db_txn.is_confirmed = txn.is_confirmed
                db_txn.inserted_at_source = txn.datetime_insert
                db_txn.station_id = txn.station_id
                db_txn.station_address = txn.address
                db_txn.station_region = txn.station_region
                # Issue #12: also stamp the credential provenance on existing rows
                # if they don't already have it (back-compat for rows created before
                # the new fields existed).
                if credential_id is not None and db_txn.credential_id is None:
                    db_txn.credential_id = credential_id
                if source_account is not None and db_txn.source_account is None:
                    db_txn.source_account = source_account
                # Issue #3: amount/currency may have changed → recompute amount_eur
                await fx_service.backfill_transaction(db_txn, db, cache=rates_cache)
                updated_count += 1
            else:
                unchanged_count += 1

        # Курсы пар (валюта, дата) кэшируются на время импорта: без
        # этого на каждую строку уходил отдельный запрос (FC-015).
        rates_cache: dict = {}
        for occurrence in range(existing_count, fetched_count):
            txn = txns_in_group[occurrence]
            # Zero-padded so lexicographic and numeric ordering agree (_n002
            # vs _n10). Legacy rows keep working — `_occ()` parses both forms.
            if occurrence < 1000:
                ext_id = f"{base_key}_n{occurrence:03d}"
            else:  # pathological group; keep the old format rather than clip
                ext_id = f"{base_key}_n{occurrence}"

            vehicle = None
            if txn.auto:
                vehicle = await get_or_create_vehicle(db, company_id, txn.auto, txn.card_driver)

            # Compute delay status
            delay_hours = None
            if txn.date and txn.datetime_insert:
                delay_hours = (txn.datetime_insert - txn.date).total_seconds() / 3600

            # Service charges: either (no plate AND no country) OR explicit "Subscription" fee
            # (subscription/abonentska plata is a recurring service fee, not an actual toll passage)
            effective_ftype = txn.fuel_type
            ft_lower = (txn.fuel_type or "").lower()
            is_subscription = "subscription" in ft_lower or "абонент" in ft_lower
            if (not txn.auto and not txn.country) or is_subscription:
                effective_ftype = "Сервисный сбор"

            db_txn = Transaction(
                company_id=company_id,
                vehicle_id=vehicle.id if vehicle else None,
                source="e100",
                external_id=ext_id,
                # Issue #12: provenance fields
                credential_id=credential_id,
                source_account=source_account,
                transaction_date=txn.date,
                card_number=txn.card,
                card_shortname=txn.card_shortname,
                plate_number=txn.auto or None,
                driver_name=txn.card_driver,
                country=txn.country,
                station_id=txn.station_id,
                station_address=txn.address,
                station_region=txn.station_region,
                price=txn.price,
                volume=txn.volume,
                amount=txn.amount,
                currency=txn.currency,
                service_category=txn.service_category,
                fuel_type=effective_ftype,
                category_code=txn.category,
                is_confirmed=txn.is_confirmed,
                e100_mobility=txn.e100_mobility,
                inserted_at_source=txn.datetime_insert,
            )
            # Issue #3: populate fx_rate / amount_eur at insert time
            await fx_service.backfill_transaction(db_txn, db, cache=rates_cache)
            db.add(db_txn)
            await db.flush()  # get db_txn.id for the revision FK

            # Issue #2: also capture the INITIAL revision so the chain starts
            # with the original values, not just the changes.
            db.add(TransactionRevision(
                transaction_id=db_txn.id,
                company_id=company_id,
                source="e100",
                amount=db_txn.amount,
                currency=db_txn.currency,
                is_confirmed=db_txn.is_confirmed,
                fx_rate=db_txn.fx_rate,
                amount_eur=db_txn.amount_eur,
                inserted_at_source=db_txn.inserted_at_source,
                station_id=db_txn.station_id,
                station_address=db_txn.station_address,
                station_region=db_txn.station_region,
            ))
            new_count += 1

            if notify and txn.is_confirmed:
                pending_notifications.append(db_txn)

    await db.commit()

    # Only now is the data durable — safe to tell the user about it.
    for db_txn in pending_notifications:
        try:
            await send_new_transaction_notification(company_id, db_txn)
        except Exception as e:
            logger.warning(f"Telegram notification failed: {e}")

    return {
        "new": new_count,
        "updated": updated_count,
        "unchanged": unchanged_count,
        "removed": removed_count,
    }


def month_ranges(date_from: date, date_to: date) -> list[tuple[date, date]]:
    """Calendar-month buckets covering [date_from, date_to]. The first/last
    bucket is clipped to that window, so it may be a partial month."""
    buckets = []
    cur = date_from.replace(day=1)
    while cur <= date_to:
        next_month = date(cur.year + 1, 1, 1) if cur.month == 12 else date(cur.year, cur.month + 1, 1)
        bucket_start = max(cur, date_from)
        bucket_end = min(next_month - timedelta(days=1), date_to)
        buckets.append((bucket_start, bucket_end))
        cur = next_month
    return buckets


def aggregate_fetched(txns: list[E100Transaction]) -> dict:
    """Count + per-currency sum (native currency, not EUR-converted) for a
    list of freshly-fetched e100 transactions."""
    agg: dict[str, dict] = {}
    for t in txns:
        cur = t.currency or "?"
        bucket = agg.setdefault(cur, {"count": 0, "sum": 0.0})
        bucket["count"] += 1
        bucket["sum"] += float(t.amount or 0)
    return agg


async def aggregate_stored(db, company_id: int, d_from: date, d_to: date) -> dict:
    """Same shape as aggregate_fetched, computed from what we already have
    stored for that company/date range."""
    # `cast(col, Date)` depends on the DB SESSION timezone, so the month
    # boundary (and therefore "does this month match?") could wobble with the
    # server's TZ — the very bug that was fixed in the transaction filters but
    # not here. Force UTC explicitly.
    utc_date = cast(func.timezone("UTC", Transaction.transaction_date), Date)
    rows = (await db.execute(
        select(Transaction.currency, func.count(Transaction.id), func.sum(Transaction.amount))
        .where(and_(
            Transaction.company_id == company_id,
            Transaction.source == "e100",
            utc_date >= d_from,
            utc_date <= d_to,
        ))
        .group_by(Transaction.currency)
    )).all()
    return {(cur or "?"): {"count": cnt, "sum": float(s or 0)} for cur, cnt, s in rows}


def aggregates_match(a: dict, b: dict) -> bool:
    for cur in set(a) | set(b):
        va, vb = a.get(cur, {"count": 0, "sum": 0.0}), b.get(cur, {"count": 0, "sum": 0.0})
        if va["count"] != vb["count"] or abs(va["sum"] - vb["sum"]) > AMOUNT_TOLERANCE:
            return False
    return True


async def reconcile_period(db, company_id: int, date_from: date, date_to: date,
                            all_transactions: list[E100Transaction],
                            fetched_credential: dict | None = None,
                            incomplete_reasons: list[str] | None = None) -> dict:
    """
    Safety net on top of save_transactions' per-transaction matching: for
    each calendar month in [date_from, date_to], compare e100's own
    transaction count and per-currency sums (native currency — e100's own
    EUR-converted total can legitimately differ from ours by FX rate, and
    that's expected and deliberately ignored here) against what we have
    stored. A matching month is left untouched. A mismatching month gets
    every stored e100 transaction for it deleted and freshly re-inserted
    from e100's current data — this guarantees FleetCost matches e100
    exactly for that month regardless of which field caused the mismatch,
    instead of chasing individual fields one at a time.
    """
    # Неполный ответ источника — повод НЕ трогать уже имеющиеся данные. Сверка
    # сравнивает ПОЛНЫЙ агрегат e100 с тем, что успели получить, и при
    # расхождении перезаписывает месяц целиком (удаляет все сохранённые строки
    # месяца). Если данных не хватает, это удалило бы корректные операции:
    # так и происходила тихая потеря данных. Поэтому при любой неполноте
    # выходим, ничего не удаляя, и оставляем след в журнале.
    if incomplete_reasons:
        logger.warning(
            f"Company {company_id}: reconcile_period skipped — incomplete fetch: "
            f"{'; '.join(incomplete_reasons)}"
        )
        return {"months_checked": 0, "months_rewritten": [],
                "skipped_incomplete": list(incomplete_reasons)}

    # Ничего не получено — сверять не с чем, и трогать сохранённое нельзя.
    #
    # Без этой проверки пустой ответ сравнивался бы с сохранёнными строками, давал
    # «расхождение» и месяц перезаписывался бы из пустого набора — то есть все
    # строки месяца удалялись. Это тот же класс потери данных, что и FC-002, только
    # повод другой: не «часть источников не ответила», а «ответ пустой».
    #
    # Вызывающий код (`sync_company`) уже проверяет это сам — `if all_fetched`.
    # Но защита обязана быть и здесь: расчёт на то, что каждый новый вызов не
    # забудет проверку, — это не защита, а договорённость.
    if not all_transactions:
        logger.warning(
            f"Company {company_id}: reconcile_period skipped — за {date_from}…{date_to} "
            f"не получено ни одной операции; сохранённые строки не тронуты"
        )
        return {"months_checked": 0, "months_rewritten": [], "skipped_empty": True}

    by_month: dict[tuple, list[E100Transaction]] = {}
    for t in all_transactions:
        if not t.date:
            continue
        by_month.setdefault((t.date.year, t.date.month), []).append(t)

    months_checked = 0
    months_rewritten = []
    for bucket_start, bucket_end in month_ranges(date_from, date_to):
        month_key = (bucket_start.year, bucket_start.month)
        fetched_for_month = by_month.get(month_key, [])
        e100_agg = aggregate_fetched(fetched_for_month)
        db_agg = await aggregate_stored(db, company_id, bucket_start, bucket_end)
        months_checked += 1

        if aggregates_match(e100_agg, db_agg):
            continue

        logger.warning(
            f"Company {company_id}: {bucket_start:%Y-%m} mismatch, rewriting "
            f"from e100 (e100={e100_agg}, stored={db_agg})"
        )
        utc_date = cast(func.timezone("UTC", Transaction.transaction_date), Date)
        existing = (await db.execute(
            select(Transaction).where(and_(
                Transaction.company_id == company_id,
                Transaction.source == "e100",
                utc_date >= bucket_start,
                utc_date <= bucket_end,
            ))
        )).scalars().all()
        # Issue #3 fix: delete TransactionRevision rows FIRST, because the FK
        # transaction_revisions.transaction_id → transactions.id would block
        # the DELETE (orphan revisions). The model has ON DELETE CASCADE in
        # the migration, but for databases that were migrated from the old
        # schema (where the FK might not have CASCADE), we delete revisions
        # explicitly here.
        from app.models.models import TransactionRevision
        from sqlalchemy import delete as sa_delete
        if existing:
            existing_ids = [t.id for t in existing]
            await db.execute(
                sa_delete(TransactionRevision).where(
                    TransactionRevision.transaction_id.in_(existing_ids)
                )
            )
        deleted_count = len(existing)
        # Remember the provenance of what we are about to destroy so the
        # re-inserted rows keep their credential_id / source_account.
        # Previously the rewrite called save_transactions() without them, so
        # every rewritten row lost its credential — which also disabled the
        # partial UNIQUE dedup index (it only applies when credential_id IS
        # NOT NULL) for that month.
        provenance_before = sorted({
            (t.credential_id, t.source_account) for t in existing
        })
        for t in existing:
            await db.delete(t)
        await db.flush()

        # Re-insert fresh. notify=False: this is a data-integrity correction,
        # not "here are brand-new transactions" — save_transactions() already
        # notified about genuinely new ones earlier in sync_company().
        # Group the fetched rows by the credential they came from (the map is
        # built in sync_company) so provenance survives the rewrite.
        buckets: dict[tuple, list] = {}
        for t in fetched_for_month:
            key = (fetched_credential or {}).get(id(t), (None, None))
            buckets.setdefault(key, []).append(t)
        for (cid, sacct), txn_bucket in buckets.items():
            await save_transactions(
                db, company_id, txn_bucket, notify=False,
                credential_id=cid, source_account=sacct,
            )
        months_rewritten.append(f"{bucket_start:%Y-%m}")

        # This is the most destructive operation in the system (delete every
        # stored e100 row for a month and re-insert from source) and it used to
        # leave only a `logger.warning` behind. Record it in the audit log so
        # there is a permanent trace of what was rewritten and by which sync.
        try:
            await audit_service.log_external(
                company_id,
                user=None,
                action="RECONCILE",
                entity_type="Transaction",
                entity_id=f"{bucket_start:%Y-%m}",
                old_value={
                    "deleted_rows": deleted_count,
                    "provenance": [f"cred={c}/acct={a}" for c, a in provenance_before],
                    "stored_agg": db_agg,
                },
                new_value={
                    "inserted_rows": len(fetched_for_month),
                    "e100_agg": e100_agg,
                },
            )
        except Exception as e:
            logger.warning(f"Reconcile audit entry failed: {e}")

    return {"months_checked": months_checked, "months_rewritten": months_rewritten}


async def sync_company(company_id: int) -> dict:
    """Sync E100 transactions for the company. Writes detailed metrics to
    ImportHistory (period covered, new/updated/unchanged counts, duration,
    status) so the user can see "did the sync actually get fresh data?".
    """
    import time as _time
    sync_start = _time.monotonic()
    async with AsyncSessionLocal() as db:
        scraper_cfg = (await db.execute(
            select(ScraperSettings).where(ScraperSettings.company_id == company_id)
        )).scalar_one_or_none()
        lookback_days = scraper_cfg.lookback_days if scraper_cfg else 120

        credentials = (await db.execute(
            select(E100Credential).where(and_(
                E100Credential.company_id == company_id,
                E100Credential.is_active == True,
            ))
        )).scalars().all()

        date_to = date.today()
        date_from = date_to - timedelta(days=lookback_days)

        if not credentials:
            # Audit + ImportHistory: empty sync attempt
            await audit_service.log_external(
                company_id,
                user=None,
                action="SYNC",
                entity_type="Company",
                entity_id=company_id,
                new_value={"status": "error", "message": "No e100 credentials"},
            )
            await import_history_service.record_import(
                company_id=company_id,
                user=None,
                source="e100",
                filename=None,
                total_rows=0, new_rows=0, updated_rows=0,
                skipped_rows=0, failed_rows=0,
                file_date_from=date_from,
                file_date_to=date_to,
                duration_ms=int((_time.monotonic() - sync_start) * 1000),
                status="failed",
                error_message="No e100 credentials configured for this company",
            )
            return {"status": "error", "message": "No e100 credentials"}

        logger.info(f"Syncing company {company_id}: {date_from} to {date_to}")
        total_new = 0
        total_updated = 0
        total_unchanged = 0
        total_removed = 0
        all_fetched: list[E100Transaction] = []
        # id(E100Transaction) → (credential_id, source_account_hash), so
        # reconcile_period can re-insert rewritten rows with their original
        # provenance instead of NULL.
        fetched_credential: dict[int, tuple] = {}
        # Причины неполноты загрузки. Если список не пуст, сверка месяца не
        # имеет права удалять данные — см. reconcile_period ниже.
        fetch_problems: list[str] = []

        for cred in credentials:
            try:
                password = decrypt_credentials(cred.encrypted_password)
                async with E100Client(cred.username, password) as client:
                    if not await client.login():
                        cred.last_sync_status = "error"
                        cred.last_sync_error = "Login failed"
                        await db.commit()
                        await audit_service.log_external(
                            company_id,
                            user=None,
                            action="SYNC",
                            entity_type="E100Credential",
                            entity_id=cred.id,
                            new_value={"status": "error", "message": "Login failed"},
                        )
                        # ImportHistory entry for the failed attempt
                        await import_history_service.record_import(
                            company_id=company_id, user=None, source="e100",
                            filename=None,
                            total_rows=0, new_rows=0, updated_rows=0,
                            skipped_rows=0, failed_rows=1,
                            file_date_from=date_from, file_date_to=date_to,
                            duration_ms=int((_time.monotonic() - sync_start) * 1000),
                            status="failed",
                            error_message=f"E100 login failed for credential #{cred.id} ({cred.username})",
                        )
                        fetch_problems.append(f"credential #{cred.id}: login failed")
                        continue
                    transactions = await client.fetch_all_transactions(date_from, date_to)
                    logger.info(f"Company {company_id}: {len(transactions)} transactions fetched")
                    # Issue #12: pass credential_id + source_account so each
                    # Transaction row is tied back to the specific credential.
                    counts = await save_transactions(
                        db, company_id, transactions,
                        credential_id=cred.id,
                        source_account=fx_service.hash_source_account(cred.username),
                    )
                    total_new += counts["new"]
                    total_updated += counts["updated"]
                    total_unchanged += counts["unchanged"]
                    total_removed += counts["removed"]
                    all_fetched.extend(transactions)
                    _sacct = fx_service.hash_source_account(cred.username)
                    for _t in transactions:
                        fetched_credential[id(_t)] = (cred.id, _sacct)
                    cred.last_sync_at = datetime.now(timezone.utc)
                    cred.last_sync_status = "ok"
                    cred.last_sync_error = None
                    await db.commit()
            except Exception as e:
                logger.error(f"Sync failed company {company_id}: {e}")
                cred.last_sync_status = "error"
                # Persisted to the DB and shown in the UI — mask tokens.
                cred.last_sync_error = _redact(str(e))
                await db.commit()
                await audit_service.log_external(
                    company_id,
                    user=None,
                    action="SYNC",
                    entity_type="E100Credential",
                    entity_id=cred.id,
                    new_value={"status": "error", "message": str(e)},
                )
                # ImportHistory entry for the failed credential
                await import_history_service.record_import(
                    company_id=company_id, user=None, source="e100",
                    filename=None,
                    total_rows=len(all_fetched), new_rows=total_new,
                    updated_rows=total_updated, skipped_rows=total_unchanged,
                    failed_rows=1,
                    file_date_from=date_from, file_date_to=date_to,
                    duration_ms=int((_time.monotonic() - sync_start) * 1000),
                    status="failed",
                    error_message=f"Sync failed for credential #{cred.id}: {str(e)[:500]}",
                )
                fetch_problems.append(f"credential #{cred.id}: {type(e).__name__}")

        reconcile_result = {"months_checked": 0, "months_rewritten": []}
        if all_fetched:
            try:
                reconcile_result = await reconcile_period(
                    db, company_id, date_from, date_to, all_fetched,
                    fetched_credential=fetched_credential,
                    incomplete_reasons=fetch_problems,
                )
                if reconcile_result["months_rewritten"]:
                    logger.warning(
                        f"Company {company_id}: reconciliation rewrote "
                        f"{reconcile_result['months_rewritten']}"
                    )
                await db.commit()
            except Exception as e:
                logger.error(f"Reconciliation failed company {company_id}: {e}")
                await db.rollback()

        # Audit: sync summary
        await audit_service.log_external(
            company_id,
            user=None,
            action="SYNC",
            entity_type="Company",
            entity_id=company_id,
            new_value={
                "status": "ok",
                "new": total_new,
                "updated": total_updated,
                "unchanged": total_unchanged,
                "removed": total_removed,
                "synced_at": datetime.now(timezone.utc).isoformat(),
                "reconciliation": reconcile_result,
                "period": f"{date_from} to {date_to}",
            },
        )

        # ImportHistory: detailed entry for the E100 sync with metrics +
        # period covered. Now visible in the Import Center page.
        # (the old `"success" if X > 0 else "success"` ternary was a no-op; the
        # real distinction is: nothing processed at all → failed, otherwise a
        # sync that only confirmed existing rows is still a success.)
        if total_new + total_updated + total_unchanged == 0:
            sync_status = "failed"  # nothing was processed
        else:
            sync_status = "success"
        await import_history_service.record_import(
            company_id=company_id,
            user=None,
            source="e100",
            filename=None,
            total_rows=len(all_fetched),
            new_rows=total_new,
            updated_rows=total_updated,
            # E100 "skipped" isn't really a thing — every fetched row is either
            # new / updated / unchanged. Reuse skipped_rows for "unchanged" so
            # the Import Center table column header "Проп." doesn't show 0 for
            # a sync that fetched 500 rows. Actually, keep them separate for
            # clarity: skipped_rows=0 (no parse failures), failed_rows=0
            # unless reconciliation crashed.
            skipped_rows=total_unchanged,  # for E100, "unchanged" is the equivalent of "skipped"
            failed_rows=0,
            file_date_from=date_from,
            file_date_to=date_to,
            duration_ms=int((_time.monotonic() - sync_start) * 1000),
            status=sync_status,
        )

        return {
            "status": "ok",
            "new_transactions": total_new,
            "updated_transactions": total_updated,
            "unchanged_transactions": total_unchanged,
            "removed_transactions": total_removed,
            "period": f"{date_from} to {date_to}",
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "reconciliation": reconcile_result,
        }


async def sync_all_companies():
    async with AsyncSessionLocal() as db:
        companies = (await db.execute(
            select(Company).where(Company.is_active == True)
        )).scalars().all()
    for company in companies:
        try:
            result = await sync_company(company.id)
            logger.info(f"Sync company {company.id}: {result}")
        except Exception as e:
            logger.error(f"Sync company {company.id} failed: {e}")
