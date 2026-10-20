import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import date

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger
from zoneinfo import ZoneInfo
from sqlalchemy import text, select

from app.api.routes import (
    auth, transactions, settings, expenses, imports, mileage,
    recurring_contracts, leasing_contracts, trailer_contracts, insurance_contracts,
)
from app.api.routes import fx_rates, audit as audit_route, imports_history
from app.api.routes import expense_categories, recurring_expenses
from app.api.routes import trailers as trailers_route
from app.core import schema_sync
from app.core.database import engine, Base, AsyncSessionLocal
from app.core.config import settings as cfg
from app.scraper.service import sync_company, sync_all_companies
from app.services.sync_lock import acquire_sync_lock, release_sync_lock
from app.models.models import ScraperSettings, Company
from app.services import audit_service, fx_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


# ──────────────────────────────────────────────────────────────────────
# Issue #11: scheduler honors per-company ScraperSettings (interval + enabled)
# ──────────────────────────────────────────────────────────────────────
SCHEDULER_MIN_INTERVAL_MIN = 5  # safety floor — never run a company more often than 5 min


async def _sync_company_job(company_id: int, interval_min: int):
    """Wrapper around sync_company that catches exceptions so a single
    company's failure can't crash the scheduler thread.

    Лок берём и здесь: ручной запуск из настроек берёт тот же лок, и без него
    плановая и ручная синхронизации могли идти одновременно — две сверки
    месяцев по одним данным (FC-006 в аудите)."""
    acquired, _ = acquire_sync_lock(company_id, user_id=0)
    if not acquired:
        logger.info(f"Scheduled sync for company {company_id} skipped: sync already running")
        return
    try:
        await sync_company(company_id)
    except Exception as e:
        logger.error(f"Scheduled sync for company {company_id} failed: {e}", exc_info=True)
    finally:
        release_sync_lock(company_id, user_id=0)


async def _reschedule_per_company_jobs():
    """Drop all per-company scheduler jobs and recreate them from the
    current ScraperSettings table. Called on startup and whenever
    /api/settings/scraper is updated."""
    # Remove existing per-company jobs
    for job in scheduler.get_jobs():
        if job.id.startswith("company_sync_"):
            scheduler.remove_job(job.id)

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ScraperSettings, Company.id.label("cid"))
            .join(Company, Company.id == ScraperSettings.company_id)
            .where(Company.is_active == True, ScraperSettings.is_enabled == True)
        )
        rows = result.all()

    for ss, cid in rows:
        interval = max(ss.interval_minutes or cfg.DEFAULT_SCRAPE_INTERVAL_MINUTES,
                       SCHEDULER_MIN_INTERVAL_MIN)
        job_id = f"company_sync_{cid}"
        scheduler.add_job(
            _sync_company_job,
            trigger=IntervalTrigger(minutes=interval),
            args=[cid, interval],
            id=job_id,
            replace_existing=True,
            misfire_grace_time=300,
        )
        logger.info(f"Scheduled company {cid} sync every {interval} min")


# ──────────────────────────────────────────────────────────────────────
# Issue #3: daily FX rate refresh (ECB publishes ~16:00 CET)
# ──────────────────────────────────────────────────────────────────────
async def _daily_fx_refresh():
    try:
        result = await fx_service.fetch_and_store_ecb_rates(date.today())
        logger.info(f"Daily FX refresh: {result}")
    except Exception as e:
        # Сбой ЕЦБ не должен отменять загрузку валют вне ЕЦБ: источники независимы.
        logger.error(f"Daily FX refresh failed: {e}", exc_info=True)
    # Валюты вне ЕЦБ (BYN и др.): последние дни из Frankfurter по всем используемым
    # в системе валютам. Курсы общие (публичные данные), данных компаний не касается.
    try:
        from app.services import fx_autoload as _fa
        other = await _fa.sync_other_currencies(None, history=False, days=7)
        if other.get("results"):
            logger.info(f"Daily Frankfurter refresh: {other.get('status')} "
                        f"new={other.get('new_rows')} updated={other.get('updated_rows')}")
    except Exception as e:
        logger.error(f"Daily Frankfurter refresh failed: {e}", exc_info=True)
    # Курсы обновлены — доводим до конца последствия для сумм. Ежедневная задача
    # приносит только последний опубликованный день, поэтому после простоя сервера
    # часть дат остаётся пустой, а строки на эти даты — без amount_eur. Здесь это
    # закрывается само: недостающий отрезок догружается, строки пересчитываются.
    # Иначе «сервер работает» не означало бы «суммы в EUR верные».
    try:
        from app.services import fx_autoload
        for company_id in await fx_autoload.companies_with_unrated_rows():
            summary = await fx_autoload.auto_finish(company_id)
            if summary.get("recalculated") or summary.get("rates_added"):
                logger.info(f"Daily FX auto-recalc for company {company_id}: {summary}")
        # Строки, посчитанные по курсу предыдущего дня, пока сегодняшнего не было:
        # курс уже загружен выше, поэтому пересчёт запускаем принудительно.
        for company_id in await fx_autoload.companies_with_approx_rows():
            summary = await fx_autoload.auto_finish(company_id, rates_changed=True)
            if summary.get("recalculated"):
                logger.info(f"Daily FX refine of approximate rows, company {company_id}: {summary}")
    except Exception as e:
        logger.error(f"Daily FX auto-recalc failed: {e}", exc_info=True)


# ──────────────────────────────────────────────────────────────────────
# Начисление регулярных расходов (ежедневно)
# ──────────────────────────────────────────────────────────────────────
async def _daily_recurring_charges():
    """Создать наступившие списания по регулярным расходам.

    Зачем отдельная задача. До неё списания появлялись только когда кто-то
    открывал страницу раздела (страница вызывает синхронизацию). То есть в
    месяц, когда в сервис не заходили, платежи не начислялись вовсе: отчёт
    показывал меньше расходов, чем было, а при возврате они появлялись «задним
    числом». Финансовый учёт не должен зависеть от того, открыл ли кто-то вкладку.
    """
    try:
        from app.services import recurring_expense_service, fx_autoload
        companies = await recurring_expense_service.companies_with_active_recurring()
        total = 0
        for company_id in companies:
            try:
                generated, _skipped = await recurring_expense_service.sync_company(company_id)
                total += generated
                if generated:
                    # Даты списаний могли оказаться без курса (архив ЕЦБ догружается
                    # по требованию) — доводим суммы в EUR до конца.
                    await fx_autoload.auto_finish(company_id)
            except Exception as e:
                logger.error(f"Recurring charges for company {company_id} failed: {e}", exc_info=True)
        if total:
            logger.info(f"Recurring charges: created {total} entries in {len(companies)} companies")
    except Exception as e:
        logger.error(f"Recurring charges job failed: {e}", exc_info=True)


# ──────────────────────────────────────────────────────────────────────
# Audit log purge (nightly, only if AUDIT_LOG_RETENTION_DAYS > 0)
# ──────────────────────────────────────────────────────────────────────
async def _nightly_audit_purge():
    if cfg.AUDIT_LOG_RETENTION_DAYS <= 0:
        return
    try:
        deleted = await audit_service.purge_old_logs(cfg.AUDIT_LOG_RETENTION_DAYS)
        if deleted:
            logger.info(f"Audit log purge: removed {deleted} rows older than {cfg.AUDIT_LOG_RETENTION_DAYS} days")
    except Exception as e:
        logger.error(f"Audit log purge failed: {e}", exc_info=True)


async def _run_lightweight_migrations(conn):
    """Best-effort in-place migrations for columns/tables added after the
    initial deploy. Base.metadata.create_all only creates missing tables,
    it never alters existing ones — so new columns on pre-existing tables
    need an explicit ALTER here. Safe to run on every startup: IF NOT EXISTS
    makes it a no-op once applied.

    This is the FALLBACK safety net. If `alembic upgrade head` (called from
    the Docker entrypoint via app/scripts/migrate.py) ran successfully,
    all these columns/tables already exist and these ALTERs are no-ops.
    If alembic failed (e.g. on the pre-Alembic-schema stamp step), THIS
    function ensures the backend can still query its own tables — every
    column the ORM expects is added here.

    NOTE: This only ADDS new columns. It does NOT change types (Float →
    Numeric). If your DB still has Float columns (because alembic failed),
    SQLAlchemy will return Decimal values from the NUMERIC-declared model
    fields when reading Float columns — that works fine, just with extra
    precision-conversion at read time.
    """
    # ── Old lightweight migration: mileage.fuel_liters ────────────────
    try:
        await conn.execute(text(
            "ALTER TABLE mileage ADD COLUMN IF NOT EXISTS fuel_liters DOUBLE PRECISION"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (mileage.fuel_liters) skipped/failed: {e}")

    # ── Issue #3: FX rate columns on transactions ─────────────────────
    # These are NULL on existing rows; backfilled via /api/fx-rates/backfill.
    fx_columns = [
        ("fx_rate", "NUMERIC(18, 8)"),
        ("amount_eur", "NUMERIC(14, 2)"),
        ("fx_rate_date", "DATE"),
        ("fx_source", "VARCHAR(20)"),
    ]
    for col_name, col_type in fx_columns:
        try:
            await conn.execute(text(
                f"ALTER TABLE transactions ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
            ))
        except Exception as e:
            logger.warning(f"Lightweight migration (transactions.{col_name}) skipped/failed: {e}")

    # ── Issue #12: provenance columns ────────────────────────────────
    provenance_columns = [
        ("e100_credentials", "source_account", "VARCHAR(255)"),
        ("transactions", "credential_id", "INTEGER"),
        ("transactions", "source_account", "VARCHAR(255)"),
        # Дата смены пароля доступа e100: e100 периодически требует сменить
        # пароль, и пользователь должен видеть, что доступ обновлён.
        ("e100_credentials", "password_changed_at", "TIMESTAMPTZ"),
    ]
    for table, col_name, col_type in provenance_columns:
        try:
            await conn.execute(text(
                f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
            ))
        except Exception as e:
            logger.warning(f"Lightweight migration ({table}.{col_name}) skipped/failed: {e}")

    # ── Issue #3: fx_rates table (created if missing via CREATE TABLE IF NOT EXISTS) ──
    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS fx_rates (
                id SERIAL PRIMARY KEY,
                currency VARCHAR(10) NOT NULL,
                rate_date DATE NOT NULL,
                rate_to_eur NUMERIC(18, 8) NOT NULL,
                source VARCHAR(20) DEFAULT 'ECB',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                CONSTRAINT uq_fx_rates_currency_date UNIQUE (currency, rate_date)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_fx_rates_currency ON fx_rates (currency)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_fx_rates_rate_date ON fx_rates (rate_date)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_fx_rates_currency_date ON fx_rates (currency, rate_date)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (fx_rates table) skipped/failed: {e}")

    # ── Issue #4: audit_log table ────────────────────────────────────
    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES companies(id),
                user_id INTEGER REFERENCES users(id),
                user_email VARCHAR(255),
                action VARCHAR(30) NOT NULL,
                entity_type VARCHAR(50) NOT NULL,
                entity_id VARCHAR(64),
                old_value TEXT,
                new_value TEXT,
                ip_address VARCHAR(64),
                user_agent VARCHAR(512),
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_audit_log_company_id ON audit_log (company_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_audit_log_created_at ON audit_log (created_at)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_audit_log_company_created ON audit_log (company_id, created_at)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_audit_log_entity ON audit_log (entity_type, entity_id)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (audit_log table) skipped/failed: {e}")

    # ── Issue #6: audit_log.client_id column (browser UUID) ──────────
    try:
        await conn.execute(text(
            "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS client_id VARCHAR(64)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_audit_log_client_id ON audit_log (client_id)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (audit_log.client_id) skipped/failed: {e}")

    # ── Issue #10: alembic_version table (create empty if missing, so
    # `alembic current` doesn't crash on the next restart) ──────────────
    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS alembic_version (
                version_num VARCHAR(32) NOT NULL,
                CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
            )
        """))
    except Exception as e:
        logger.warning(f"Lightweight migration (alembic_version) skipped/failed: {e}")

    # ── Issue #11: fx_rates.company_id column (multi-tenant manual rates) ──
    try:
        await conn.execute(text(
            "ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS company_id INTEGER "
            "REFERENCES companies(id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_fx_rates_company_currency_date "
            "ON fx_rates (company_id, currency, rate_date)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (fx_rates.company_id) skipped/failed: {e}")

    # ── Issue #6: import_history table ─────────────────────────────────
    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS import_history (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES companies(id),
                user_id INTEGER REFERENCES users(id),
                user_email VARCHAR(255),
                source VARCHAR(50) NOT NULL,
                filename VARCHAR(255),
                total_rows INTEGER DEFAULT 0,
                new_rows INTEGER DEFAULT 0,
                updated_rows INTEGER DEFAULT 0,
                skipped_rows INTEGER DEFAULT 0,
                failed_rows INTEGER DEFAULT 0,
                file_date_from DATE,
                file_date_to DATE,
                duration_ms INTEGER,
                status VARCHAR(20) NOT NULL,
                error_message TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_import_history_company_id ON import_history (company_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_import_history_created_at ON import_history (created_at)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_import_history_company_created ON import_history (company_id, created_at)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (import_history table) skipped/failed: {e}")

    # ── Issue #2 (transaction history): transaction_revisions table ──
    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS transaction_revisions (
                id SERIAL PRIMARY KEY,
                transaction_id INTEGER NOT NULL REFERENCES transactions(id),
                company_id INTEGER NOT NULL REFERENCES companies(id),
                captured_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
                source VARCHAR(50) DEFAULT 'e100',
                amount NUMERIC(14, 2),
                currency VARCHAR(10),
                is_confirmed BOOLEAN,
                fx_rate NUMERIC(18, 8),
                amount_eur NUMERIC(14, 2),
                inserted_at_source TIMESTAMPTZ,
                station_id VARCHAR(30),
                station_address TEXT,
                station_region VARCHAR(100)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_transaction_revisions_transaction_id "
            "ON transaction_revisions (transaction_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_transaction_revisions_txn_created "
            "ON transaction_revisions (transaction_id, captured_at)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_transaction_revisions_company_created "
            "ON transaction_revisions (company_id, captured_at)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (transaction_revisions table) skipped/failed: {e}")

    # ── SaaS-доработка: динамические категории расходов ───────────────
    # Альтернативы alembic здесь работают ровно так же, как для остальных
    # «безопасных» миграций: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT
    # EXISTS. Если alembic 0006 уже прошёл, это no-op.
    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS expense_categories (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES companies(id),
                section VARCHAR(30) NOT NULL,
                code VARCHAR(50) NOT NULL,
                name VARCHAR(120) NOT NULL,
                icon VARCHAR(16),
                color VARCHAR(20),
                object_scope VARCHAR(20) NOT NULL DEFAULT 'any',
                is_system BOOLEAN NOT NULL DEFAULT FALSE,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                created_by INTEGER REFERENCES users(id),
                updated_at TIMESTAMPTZ,
                CONSTRAINT uq_expense_categories_company_section_code
                    UNIQUE (company_id, section, code)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_expense_categories_company_section "
            "ON expense_categories (company_id, section, is_active)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (expense_categories table) skipped/failed: {e}")

    category_columns = [
        ("transactions", "category_id", "INTEGER REFERENCES expense_categories(id)"),
        ("transactions", "expense_type", "VARCHAR(20) DEFAULT 'oneoff'"),
        ("transactions", "periodicity", "VARCHAR(20)"),
        ("transactions", "comment", "VARCHAR(500)"),
        ("transactions", "document_ref", "VARCHAR(255)"),
        ("insurance_contracts", "country", "VARCHAR(60)"),
        ("insurance_contracts", "policy_number", "VARCHAR(100)"),
        ("insurance_contracts", "insurer", "VARCHAR(200)"),
    ]
    for table, col_name, col_type in category_columns:
        try:
            await conn.execute(text(
                f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
            ))
        except Exception as e:
            logger.warning(f"Lightweight migration ({table}.{col_name}) skipped/failed: {e}")
    try:
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_transactions_category_id "
            "ON transactions (category_id)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (ix_transactions_category_id) skipped/failed: {e}")
    # Вид страхования стал свободным кодом категории — расширяем колонку.
    try:
        await conn.execute(text(
            "ALTER TABLE insurance_contracts ALTER COLUMN category TYPE VARCHAR(60)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (insurance_contracts.category) skipped/failed: {e}")

    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS recurring_expenses (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES companies(id),
                category_id INTEGER NOT NULL REFERENCES expense_categories(id),
                vehicle_id INTEGER REFERENCES vehicles(id),
                trailer_plate VARCHAR(20),
                plate_number VARCHAR(20),
                description VARCHAR(500) NOT NULL,
                amount NUMERIC(18, 2) NOT NULL,
                currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
                frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
                start_date DATE NOT NULL,
                end_date DATE,
                day_of_month INTEGER NOT NULL DEFAULT 1,
                next_run_at DATE,
                last_run_at DATE,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                cancelled_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                created_by INTEGER REFERENCES users(id)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_recurring_expenses_company_active "
            "ON recurring_expenses (company_id, is_active)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_recurring_expenses_category_id "
            "ON recurring_expenses (category_id)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (recurring_expenses table) skipped/failed: {e}")

    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS recurring_expense_tombstones (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES companies(id),
                contract_id INTEGER NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
                period_key VARCHAR(10) NOT NULL,
                external_id VARCHAR(150) NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                CONSTRAINT uq_recurring_expense_tombstones_contract_period
                    UNIQUE (company_id, contract_id, period_key)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_recurring_expense_tombstones_contract_id "
            "ON recurring_expense_tombstones (contract_id)"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (recurring_expense_tombstones) skipped/failed: {e}")

    # ── График регулярных расходов: сумма, пауза, прогресс (alembic 0007) ──
    # Те же ADD COLUMN, что в миграции 0007. Нужны и здесь: на существующей
    # установке без прогона alembic приложение обязано подняться, а не упасть на
    # первом же обращении к новым полям.
    try:
        for _sql in (
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS amount_mode VARCHAR(20) NOT NULL DEFAULT 'period'",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS input_amount NUMERIC(18,2)",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS down_payment NUMERIC(18,2) NOT NULL DEFAULT 0",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS total_periods INTEGER",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS paid_periods INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS document_ref VARCHAR(100)",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS comment VARCHAR(500)",
            "CREATE INDEX IF NOT EXISTS ix_recurring_expenses_company_status ON recurring_expenses (company_id, status)",
            # Перенос: раньше сумма всегда была «за период».
            "UPDATE recurring_expenses SET input_amount = amount WHERE input_amount IS NULL",
        ):
            await conn.execute(text(_sql))
    except Exception as e:
        logger.warning(f"Lightweight migration (recurring_expenses schedule) skipped/failed: {e}")

    # ── Оплата начислений и связь списания с договором (alembic 0013) ────
    #
    # Подробности — в app/core/schema_sync.py. Кратко: `ADD COLUMN IF NOT EXISTS`
    # понимает только PostgreSQL, поэтому на SQLite колонки молча не появлялись, и
    # запросы к transactions падали (страницы показывали пустые списки, sync → 500).
    # Теперь колонка сначала ищется, затем добавляется — одинаково на обоих диалектах.
    await schema_sync.sync_transactions_schema(conn)
    await schema_sync.sync_recurring_expenses_schema(conn)
    # SEC-02 (аудит stage8): users.token_version для мгновенного отзыва токенов
    await schema_sync.sync_users_schema(conn)
    # SEC-02: таблица refresh_tokens создаётся create_all выше на свежей базе;
    # на существующей тоже доводим её явно — create_all пропускает таблицы,
    # которые уже есть, а на старых деплоях её ещё нет.
    await conn.execute(text("""
        CREATE TABLE IF NOT EXISTS refresh_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            token_hash VARCHAR(64) NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            user_agent VARCHAR(512),
            ip VARCHAR(64)
        )
    """))
    try:
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_refresh_tokens_user_id ON refresh_tokens (user_id)"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_refresh_tokens_token_hash ON refresh_tokens (token_hash)"))
    except Exception as e:
        logger.warning(f"refresh_tokens index creation skipped: {e}")

    # ── Реестр прицепов и привязки (alembic 0012) ───────────────────────
    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS trailers (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES companies(id),
                plate VARCHAR(20) NOT NULL,
                note VARCHAR(200),
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                origin VARCHAR(20) NOT NULL DEFAULT 'manual',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                created_by INTEGER REFERENCES users(id),
                CONSTRAINT uq_trailers_company_plate UNIQUE (company_id, plate)
            )
        """))
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS trailer_bindings (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES companies(id),
                trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE CASCADE,
                vehicle_id INTEGER REFERENCES vehicles(id),
                plate_number VARCHAR(20),
                from_date DATE NOT NULL,
                to_date DATE,
                note VARCHAR(200),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                created_by INTEGER REFERENCES users(id)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_trailer_bindings_trailer "
            "ON trailer_bindings (trailer_id, from_date)"))
    except Exception as e:
        logger.warning(f"Lightweight migration (trailers) skipped/failed: {e}")

    # ── Номер прицепа в строке операции (alembic 0011) ───────────────────
    try:
        await conn.execute(text(
            "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS trailer_plate VARCHAR(20)"))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_transactions_trailer_plate "
            "ON transactions (trailer_plate)"))
    except Exception as e:
        logger.warning(f"Lightweight migration (transactions.trailer_plate) skipped/failed: {e}")

    # ── Полисные атрибуты регулярного расхода (alembic 0010) ─────────────
    try:
        for _sql in (
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS country VARCHAR(60)",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS policy_number VARCHAR(100)",
            "ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS insurer VARCHAR(200)",
        ):
            await conn.execute(text(_sql))
    except Exception as e:
        logger.warning(f"Lightweight migration (recurring policy fields) skipped/failed: {e}")

    # ── Уникальность автоматических списаний (alembic 0008) ─────────────
    # Нужна, потому что генерация сначала проверяет «есть ли такое списание», а
    # потом вставляет: между этими шагами вторая синхронизация успевает вставить
    # дубль. Индекс частичный — у обычных разовых расходов external_id пустой.
    try:
        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_company_source_external "
            "ON transactions (company_id, source, external_id) WHERE external_id IS NOT NULL"
        ))
    except Exception as e:
        logger.warning(f"Lightweight migration (recurring dedup index) skipped/failed: {e}")

    # ── Issue #2 (UNIQUE constraints) — added via lightweight ALTER ─────
    # These run IF NOT EXISTS (Postgres 9.5+ supports the IF NOT EXISTS
    # clause for CREATE INDEX, but constraints need explicit catches).
    unique_constraints = [
        # (constraint_name, table, columns)
        ("uq_vehicles_company_plate", "vehicles", "company_id, plate_number"),
        ("uq_mileage_company_external", "mileage", "company_id, external_id"),
        ("uq_mileage_segments_company_external", "mileage_segments", "company_id, external_id"),
        ("uq_recurring_tombstones_contract_month", "recurring_tombstones", "company_id, contract_id, year_month"),
        ("uq_leasing_tombstones_contract_month", "leasing_tombstones", "company_id, contract_id, year_month"),
        ("uq_trailer_tombstones_contract_month", "trailer_tombstones", "company_id, contract_id, year_month"),
        ("uq_insurance_tombstones_contract_month", "insurance_tombstones", "company_id, contract_id, year_month"),
        # ВНИМАНИЕ: uq_fx_rates_company_currency_date здесь БОЛЬШЕ НЕТ (FC-008).
        # Обычное UNIQUE(company_id, currency, rate_date) не защищает глобальные
        # курсы ЕЦБ (company_id IS NULL: NULL != NULL), а для строк компаний его
        # заменяет частичный индекс ниже. Если оставить эту строку, ограничение
        # возвращалось при каждом запуске и спорило с миграцией 0005.
    ]
    for constraint_name, table, columns in unique_constraints:
        try:
            await conn.execute(text(
                f"ALTER TABLE {table} ADD CONSTRAINT {constraint_name} "
                f"UNIQUE ({columns})"
            ))
            logger.info(f"Added UNIQUE constraint {constraint_name} on {table}")
        except Exception as e:
            # Constraint already exists or duplicate rows prevent creation.
            # Either way, the migration runner (0003_integrity_constraints)
            # will report the failure clearly when it runs.
            pass

    # ── Legacy global-only FX constraint must go ──────────────────────
    # The pre-Alembic schema declared UNIQUE(currency, rate_date) on fx_rates
    # (see the CREATE TABLE IF NOT EXISTS above). That makes a company-specific
    # manual override impossible whenever an ECB row already exists for the same
    # date — exactly the case Issue #11 needs — and it also made
    # `store_rates()` blow up with MultipleResultsFound. Alembic 0003 drops it,
    # but 0003 always failed on a fresh DB, so it was never removed. Do it here,
    # idempotently.
    for stmt, label in [
        ("ALTER TABLE fx_rates DROP CONSTRAINT IF EXISTS uq_fx_rates_currency_date",
         "fx_rates legacy constraint (constraint form)"),
        ("DROP INDEX IF EXISTS uq_fx_rates_currency_date",
         "fx_rates legacy constraint (index form)"),
    ]:
        try:
            await conn.execute(text(stmt))
            logger.info(f"Lightweight migration: {label} applied")
        except Exception as e:
            logger.warning(f"Lightweight migration ({label}) skipped/failed: {e}")

    # Partial unique indexes (for nullable columns — only enforced when NOT NULL)
    partial_indexes = [
        ("uq_e100_credentials_company_source_account", "e100_credentials",
         "company_id, source_account", "source_account IS NOT NULL"),
        ("uq_transactions_company_credential_external", "transactions",
         "company_id, credential_id, external_id",
         "credential_id IS NOT NULL AND external_id IS NOT NULL"),
        # FC-008: глобальные курсы ЕЦБ (company_id IS NULL) — один курс на
        # валюту и дату. Обычный UNIQUE тут не работает: в PostgreSQL NULL-ы
        # считаются различными, поэтому без этого индекса на одну дату могло
        # лежать несколько «глобальных» курсов одной валюты.
        ("uq_fx_rates_global_currency_date", "fx_rates",
         "currency, rate_date", "company_id IS NULL"),
        # FC-008, вторая половина: ручные курсы компаний. Раньше их держало
        # обычное UNIQUE(company_id, currency, rate_date) — для строк с непустым
        # company_id NULL-сравнение не мешает, поэтому оно работало; теперь эта
        # роль у частичного индекса, а старое ограничение снято (см. выше).
        ("uq_fx_rates_company_currency_date_partial", "fx_rates",
         "company_id, currency, rate_date", "company_id IS NOT NULL"),
        # FC-007: транзакции, созданные договорами (credential_id IS NULL), —
        # один external_id на компанию. Индекс выше покрывает только строки с
        # credential_id, поэтому параллельная генерация договоров могла создать
        # дубликаты: два вызова успевали прочитать «ещё нет» до вставки.
        ("uq_transactions_company_contract_external", "transactions",
         "company_id, external_id",
         "credential_id IS NULL AND external_id IS NOT NULL"),
    ]
    for index_name, table, columns, where_clause in partial_indexes:
        try:
            await conn.execute(text(
                f"CREATE UNIQUE INDEX IF NOT EXISTS {index_name} "
                f"ON {table} ({columns}) WHERE {where_clause}"
            ))
        except Exception as e:
            logger.warning(f"Lightweight migration ({index_name}) skipped/failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # SAFETY NET (только вне production): create any missing tables. Runs even if alembic
    # upgrade head failed in the Docker entrypoint — at least the app
    # starts so the user can debug via /api/health and the audit log.
    # NOTE: Base.metadata.create_all only CREATES missing tables — it does
    # NOT alter existing ones. So if you're on the old Float-based schema,
    # this won't add the new NUMERIC/credential_id/fx_* columns. For that
    # you need `alembic upgrade head` to have run successfully (which the
    # smart migration runner in app/scripts/migrate.py handles).
    try:
        # create_all needs a normal transaction…
        async with engine.begin() as conn:
            if cfg.ENVIRONMENT == "production":
                # В production схему ведёт только alembic. create_all создаёт
                # недостающие таблицы, но НЕ добавляет колонки к существующим,
                # поэтому он маскирует расхождение схемы: приложение стартует и
                # «работает» на неполной схеме (см. FC-003 в аудите). Если
                # миграции не прошли, контейнер теперь просто не поднимается —
                # это видно в логах и не портит данные.
                logger.info(
                    "Skipping Base.metadata.create_all in production — schema is "
                    "managed by alembic (app/scripts/migrate.py)."
                )
            else:
                await conn.run_sync(Base.metadata.create_all)
    except Exception as e:
        logger.error(f"Startup DB setup failed (DB unreachable?): {e}", exc_info=True)

    try:
        # …but the lightweight migrations run in AUTOCOMMIT mode: every DDL
        # statement becomes its own transaction.
        #
        # Why: the helpers below rely on `try/except` per statement
        # ("ADD COLUMN IF NOT EXISTS may fail, skip it"). In a SINGLE
        # PostgreSQL transaction that assumption is wrong — after the first
        # error the transaction is aborted and *every* following statement
        # fails with InFailedSQLTransactionError. Because each failure was
        # swallowed and logged as a warning, the "safety net" silently did
        # nothing from the first duplicate constraint onwards, which is how
        # the dedup indexes (`uq_transactions_company_credential_external`,
        # `uq_e100_credentials_company_source_account`) ended up missing.
        async with engine.connect() as conn:
            conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
            await _run_lightweight_migrations(conn)
    except Exception as e:
        # Reaching here means the connection itself could not be opened (DB
        # down) — individual statement failures are handled inside the
        # function. Log loudly and keep going: the user still gets
        # /api/health and can debug. Better than a container restart loop.
        logger.error(f"Lightweight DB migrations could not run: {e}", exc_info=True)

    # Issue #11: per-company scheduler — fail-safe, ignore errors
    try:
        await _reschedule_per_company_jobs()
    except Exception as e:
        logger.error(f"Scheduler per-company setup failed: {e}", exc_info=True)
    # Global FX refresh — fixed time, not "24h after container start".
    # ECB publishes the reference rates at ~16:00 CET on TARGET2 business days,
    # so we fetch at 17:00 Warsaw time. The old IntervalTrigger(minutes=1440)
    # drifted with every restart and could run before publication.
    try:
        scheduler.add_job(
            _daily_fx_refresh,
            trigger=CronTrigger(
                hour=17, minute=5, timezone=ZoneInfo("Europe/Warsaw"),
                day_of_week="mon-fri",
            ),
            id="daily_fx_refresh",
            replace_existing=True,
            misfire_grace_time=3600,
        )
    except Exception as e:
        logger.error(f"FX refresh scheduler setup failed: {e}", exc_info=True)
    # Начисление регулярных расходов — 06:10 Варшава, до начала рабочего дня.
    # Периодичность ежедневная: день списания у каждого договора свой (1–28).
    try:
        scheduler.add_job(
            _daily_recurring_charges,
            trigger=CronTrigger(hour=6, minute=10, timezone=ZoneInfo("Europe/Warsaw")),
            id="daily_recurring_charges",
            replace_existing=True,
            misfire_grace_time=3600,
        )
    except Exception as e:
        logger.error(f"Recurring charges scheduler setup failed: {e}", exc_info=True)
    # Nightly audit log purge — 03:30 Warsaw, so it is not tied to restarts.
    try:
        scheduler.add_job(
            _nightly_audit_purge,
            trigger=CronTrigger(hour=3, minute=30, timezone=ZoneInfo("Europe/Warsaw")),
            id="nightly_audit_purge",
            replace_existing=True,
            misfire_grace_time=3600,
        )
    except Exception as e:
        logger.error(f"Audit purge scheduler setup failed: {e}", exc_info=True)
    try:
        scheduler.start()
        logger.info("Scheduler started (per-company + FX refresh + recurring charges + audit purge)")
    except Exception as e:
        logger.error(f"Scheduler start failed: {e}", exc_info=True)

    # Start Telegram bot in background
    if cfg.TELEGRAM_BOT_TOKEN:
        try:
            from app.telegram.bot import start_bot
            asyncio.create_task(start_bot())
            logger.info("Telegram bot started")
        except Exception as e:
            logger.error(f"Telegram bot failed to start: {e}", exc_info=True)

    yield

    scheduler.shutdown()


# ──────────────────────────────────────────────────────────────────────
# Issue #6: docs/redoc/openapi.json disabled in non-development envs
# ──────────────────────────────────────────────────────────────────────
def _docs_url():
    return "/docs" if cfg.ENVIRONMENT == "development" else None


def _redoc_url():
    return "/redoc" if cfg.ENVIRONMENT == "development" else None


def _openapi_url():
    # /openapi.json is gated by env too — without it, Swagger UI / Postman
    # can't even introspect the API. In prod, attackers don't get to see
    # the route surface.
    return "/openapi.json" if cfg.ENVIRONMENT == "development" else None


app = FastAPI(
    title="FleetCost API",
    description="Fleet expense tracking service",
    version="1.1.0",
    lifespan=lifespan,
    docs_url=_docs_url(),
    redoc_url=_redoc_url(),
    openapi_url=_openapi_url(),
)

# Rate limiter middleware — must be set BEFORE include_router so the
# decorators on auth.py endpoints are picked up. The state object lives
# on the app so the route decorators can find it.
from slowapi.errors import RateLimitExceeded
from app.api.routes.auth import limiter, _ratelimit_exceeded_handler
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _ratelimit_exceeded_handler)

# CORS — Issue #5: must reflect the actual frontend origin in production.
# allow_credentials=True is required for cookies to be sent cross-origin;
# combined with a specific origin (not "*"), this is safe.
_allowed_origins = ["http://localhost:3000", "http://localhost:5173"]
if cfg.ENVIRONMENT == "production":
    # In production, set CORS_ORIGINS env var (comma-separated)
    import os
    extra = os.environ.get("CORS_ORIGINS", "")
    if extra:
        _allowed_origins = [o.strip() for o in extra.split(",") if o.strip()]
    else:
        # Без списка источников оставлять localhost-ы нельзя: они разрешали бы
        # странице с локального сервера обращаться к API с cookies (FC-018).
        # Приложение отдаётся через nginx с того же источника, поэтому пустой
        # список ничего не ломает.
        _allowed_origins = []
        logger.warning(
            "CORS_ORIGINS is empty in production — cross-origin requests are "
            "disabled. Set CORS_ORIGINS if the API is called from another origin."
        )

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-CSRF-Token"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(transactions.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(expenses.router, prefix="/api")
app.include_router(imports.router, prefix="/api")
app.include_router(mileage.router, prefix="/api")
app.include_router(recurring_contracts.router, prefix="/api")
app.include_router(leasing_contracts.router, prefix="/api")
app.include_router(trailer_contracts.router, prefix="/api")
app.include_router(insurance_contracts.router, prefix="/api")
app.include_router(fx_rates.router, prefix="/api")
app.include_router(audit_route.router, prefix="/api")
app.include_router(imports_history.router, prefix="/api")
# SaaS-доработка: динамические категории расходов + универсальные регулярные
# расходы (любая категория любого раздела).
app.include_router(expense_categories.router, prefix="/api")
app.include_router(recurring_expenses.router, prefix="/api")
# Реестр прицепов: прицеп — объект, привязка к машине — период.
app.include_router(trailers_route.router, prefix="/api")


@app.get("/api/health")
async def health():
    """Health check — returns DB connectivity + table count. Use this
    to diagnose '502 Bad Gateway from nginx' issues: if this endpoint
    returns OK, the backend is up; if it doesn't respond at all, the
    backend container is crashing in a restart loop.

    Works on both PostgreSQL (production) and SQLite (dev/tests)."""
    db_ok = False
    db_error = None
    table_count = None
    try:
        async with engine.connect() as conn:
            # Try PostgreSQL first, fall back to SQLite
            try:
                result = await conn.execute(
                    text("SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')")
                )
            except Exception:
                # SQLite fallback
                result = await conn.execute(
                    text("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
                )
            table_count = result.scalar()
            db_ok = True
    except Exception as e:
        db_error = str(e)[:200]

    # В production наружу уходит только признак жизни: имена окружения, число
    # таблиц и текст ошибки БД (в нём бывают хост и пользователь) — это
    # подсказки для того, кто ищет уязвимости (FC-019 в аудите). В разработке
    # диагностика остаётся, она там нужна.
    if cfg.ENVIRONMENT == "production":
        return {"status": "ok" if db_ok else "degraded", "version": "1.1.0"}

    return {
        "status": "ok" if db_ok else "degraded",
        "version": "1.1.0",
        "env": cfg.ENVIRONMENT,
        "db": {
            "connected": db_ok,
            "table_count": table_count,
            "error": db_error,
        },
    }
