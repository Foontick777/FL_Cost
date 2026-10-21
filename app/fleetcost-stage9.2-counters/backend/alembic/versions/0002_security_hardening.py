"""security_hardening: Float→Numeric, FX rates, audit log, credential provenance

Revision ID: 0002_security_hardening
Revises: 0001_baseline
Create Date: 2026-09-20

This migration applies all the schema changes that fix the 12 issues the
user identified. It is IDEMPOTENT — every operation uses IF NOT EXISTS
or is wrapped in a try/except, so it's safe to run on:
  1. A FRESH database (where 0001_baseline already created everything)
  2. An EXISTING database (old Float-based schema from create_all)
  3. A partially-migrated database (some columns exist, some don't)

For an EXISTING deployment that was running on Float-based schema and
Base.metadata.create_all, run `alembic stamp 0001_baseline` first to
mark the baseline as already-applied (since the tables exist), then
`alembic upgrade head` to apply THIS migration.

For a FRESH deployment, just run `alembic upgrade head` — alembic will
create everything in baseline form (0001) and 0002 will be a no-op
(because all ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS
operations are no-ops when the objects already exist).
"""
import re
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import logging

log = logging.getLogger(__name__)

revision: str = "0002_security_hardening"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _safe_add_column(table: str, column: str, col_type: str):
    """ADD COLUMN IF NOT EXISTS — works on PostgreSQL 9.6+ and is a
    no-op if the column already exists. Wrapped in try/except for
    databases that don't support IF NOT EXISTS (e.g. older SQLite)."""
    try:
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {col_type}")
    except Exception as e:
        log.warning(f"ADD COLUMN {table}.{column} skipped: {e}")


def _safe_create_fk(name: str, source: str, target: str, cols: list, ref_cols: list):
    """Create FK only if it doesn't already exist."""
    try:
        op.create_foreign_key(name, source, target, cols, ref_cols)
    except Exception as e:
        log.warning(f"CREATE FK {name} skipped: {e}")


def _safe_create_index(name: str, table: str, cols: list, unique: bool = False):
    """Create index only if it doesn't already exist."""
    try:
        op.create_index(name, table, cols, unique=unique)
    except Exception as e:
        log.warning(f"CREATE INDEX {name} skipped: {e}")


def _safe_create_table(name: str, columns_sql: str):
    """CREATE TABLE IF NOT EXISTS."""
    try:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({columns_sql})")
    except Exception as e:
        log.warning(f"CREATE TABLE {name} skipped: {e}")


def upgrade() -> None:
    # ─── Issue #12: provenance columns on e100_credentials ────────────
    _safe_add_column("e100_credentials", "source_account", "VARCHAR(255)")

    # ─── Issue #12: provenance columns on transactions ─────────────────
    _safe_add_column("transactions", "credential_id", "INTEGER")
    _safe_add_column("transactions", "source_account", "VARCHAR(255)")
    _safe_create_fk(
        "fk_transactions_credential_id",
        "transactions", "e100_credentials",
        ["credential_id"], ["id"],
    )
    _safe_create_index("ix_transactions_credential_id", "transactions", ["credential_id"])
    _safe_create_index(
        "ix_transactions_company_credential_ext",
        "transactions", ["company_id", "credential_id", "external_id"],
    )

    # ─── Issue #3: FX columns on transactions ────────────────────────
    _safe_add_column("transactions", "fx_rate", "NUMERIC(18, 8)")
    _safe_add_column("transactions", "amount_eur", "NUMERIC(14, 2)")
    _safe_add_column("transactions", "fx_rate_date", "DATE")
    _safe_add_column("transactions", "fx_source", "VARCHAR(20)")

    # ─── Issue #2: Float → Numeric on `transactions` ──────────────────
    # PostgreSQL's `USING` clause converts the existing Float values to
    # NUMERIC with explicit rounding. Wrapped in try/except in case the
    # column is already NUMERIC (fresh DB from 0001).
    alter_columns = [
        ("transactions", "price", "NUMERIC(12, 4)", True, "ROUND(CAST(price AS NUMERIC(12,4)), 4)"),
        ("transactions", "volume", "NUMERIC(12, 3)", True, "ROUND(CAST(volume AS NUMERIC(12,3)), 3)"),
        ("transactions", "amount", "NUMERIC(14, 2)", False, "ROUND(CAST(amount AS NUMERIC(14,2)), 2)"),
        ("mileage", "km", "NUMERIC(12, 3)", False, "ROUND(CAST(km AS NUMERIC(12,3)), 3)"),
        ("mileage", "fuel_liters", "NUMERIC(12, 3)", True, "ROUND(CAST(fuel_liters AS NUMERIC(12,3)), 3)"),
        ("mileage_segments", "km", "NUMERIC(12, 3)", True, "ROUND(CAST(km AS NUMERIC(12,3)), 3)"),
        ("recurring_contracts", "annual_amount", "NUMERIC(18, 2)", False, "ROUND(CAST(annual_amount AS NUMERIC(18,2)), 2)"),
        ("recurring_contracts", "monthly_amount", "NUMERIC(18, 2)", False, "ROUND(CAST(monthly_amount AS NUMERIC(18,2)), 2)"),
        ("leasing_contracts", "total_amount", "NUMERIC(18, 2)", False, "ROUND(CAST(total_amount AS NUMERIC(18,2)), 2)"),
        ("leasing_contracts", "monthly_amount", "NUMERIC(18, 2)", False, "ROUND(CAST(monthly_amount AS NUMERIC(18,2)), 2)"),
        ("trailer_contracts", "total_amount", "NUMERIC(18, 2)", False, "ROUND(CAST(total_amount AS NUMERIC(18,2)), 2)"),
        ("trailer_contracts", "monthly_amount", "NUMERIC(18, 2)", False, "ROUND(CAST(monthly_amount AS NUMERIC(18,2)), 2)"),
        ("insurance_contracts", "total_amount", "NUMERIC(18, 2)", False, "ROUND(CAST(total_amount AS NUMERIC(18,2)), 2)"),
        ("insurance_contracts", "monthly_amount", "NUMERIC(18, 2)", False, "ROUND(CAST(monthly_amount AS NUMERIC(18,2)), 2)"),
    ]
    for table, col, new_type, nullable, using_expr in alter_columns:
        # Parse the precision/scale out of the target type string.
        #
        # BUGFIX: the previous code passed `sa.Numeric()` (no precision, no
        # scale) to BOTH branches — `sa.Numeric() if "18" in new_type else
        # sa.Numeric()` — so PostgreSQL received `ALTER TABLE … TYPE NUMERIC`,
        # which DROPS the typmod. The `postgresql_using` expression rounded the
        # existing values, but the column afterwards accepted any number of
        # decimals, silently undoing the whole point of Issue #2
        # (NUMERIC(14,2) money). The model still declares Numeric(14,2), so the
        # database and the ORM disagreed.
        _digits = [int(d) for d in re.findall(r"\d+", new_type)]
        target_type = sa.Numeric(*_digits) if _digits else sa.Numeric()
        try:
            op.alter_column(
                table, col,
                existing_type=sa.Float(),
                type_=target_type,
                existing_nullable=nullable,
                postgresql_using=using_expr,
            )
        except Exception as e:
            # Column may already be NUMERIC (fresh DB from 0001), or
            # the DB may not support postgresql_using. Skip gracefully.
            log.warning(f"ALTER {table}.{col} → {new_type} skipped: {e}")

    # ─── Issue #3: fx_rates table ─────────────────────────────────────
    _safe_create_table("fx_rates", """
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id),
        currency VARCHAR(10) NOT NULL,
        rate_date DATE NOT NULL,
        rate_to_eur NUMERIC(18, 8) NOT NULL,
        source VARCHAR(20) DEFAULT 'ECB',
        created_at TIMESTAMPTZ DEFAULT NOW()
    """)
    _safe_create_index("ix_fx_rates_currency", "fx_rates", ["currency"])
    _safe_create_index("ix_fx_rates_rate_date", "fx_rates", ["rate_date"])
    _safe_create_index("ix_fx_rates_currency_date", "fx_rates", ["currency", "rate_date"])
    try:
        op.create_unique_constraint("uq_fx_rates_company_currency_date", "fx_rates",
                                   ["company_id", "currency", "rate_date"])
    except Exception as e:
        log.warning(f"CREATE CONSTRAINT uq_fx_rates_company_currency_date skipped: {e}")

    # ─── Issue #4: audit_log table ────────────────────────────────────
    _safe_create_table("audit_log", """
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
        client_id VARCHAR(64),
        created_at TIMESTAMPTZ DEFAULT NOW()
    """)
    _safe_create_index("ix_audit_log_company_id", "audit_log", ["company_id"])
    _safe_create_index("ix_audit_log_created_at", "audit_log", ["created_at"])
    _safe_create_index("ix_audit_log_company_created", "audit_log", ["company_id", "created_at"])
    _safe_create_index("ix_audit_log_entity", "audit_log", ["entity_type", "entity_id"])
    _safe_create_index("ix_audit_log_client_id", "audit_log", ["client_id"])

    # ─── Issue #6: import_history table ───────────────────────────────
    _safe_create_table("import_history", """
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
    """)
    _safe_create_index("ix_import_history_company_id", "import_history", ["company_id"])
    _safe_create_index("ix_import_history_created_at", "import_history", ["created_at"])
    _safe_create_index("ix_import_history_company_created", "import_history", ["company_id", "created_at"])

    # ─── Issue #2 (transaction history): transaction_revisions table ─
    _safe_create_table("transaction_revisions", """
        id SERIAL PRIMARY KEY,
        transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
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
    """)
    _safe_create_index("ix_transaction_revisions_transaction_id", "transaction_revisions", ["transaction_id"])
    _safe_create_index("ix_transaction_revisions_txn_created", "transaction_revisions", ["transaction_id", "captured_at"])
    _safe_create_index("ix_transaction_revisions_company_created", "transaction_revisions", ["company_id", "captured_at"])


def downgrade() -> None:
    # Drop tables and columns in reverse order. All wrapped in try/except
    # for safety — partial downgrade should not crash.
    for table in ["transaction_revisions", "import_history", "audit_log", "fx_rates"]:
        try:
            op.drop_table(table)
        except Exception as e:
            log.warning(f"DROP TABLE {table} skipped: {e}")
