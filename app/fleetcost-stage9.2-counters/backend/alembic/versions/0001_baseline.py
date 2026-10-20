"""baseline: all v2 tables (with security hardening already applied)

Revision ID: 0001_baseline
Revises:
Create Date: 2026-09-20

This is the BASELINE migration for a fresh FleetCost deployment — it
creates every table in its v2 form (with NUMERIC money columns, fx_rates,
audit_log, credential_id on transactions, etc.).

For an EXISTING deployment that was running on the old Float-based schema
and Base.metadata.create_all, use migration 0002_security_hardening
instead — it ALTERs the existing tables in place.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── companies ──────────────────────────────────────
    op.create_table(
        "companies",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("is_active", sa.Boolean(), default=True),
    )

    # ── users ───────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(255)),
        sa.Column("role", sa.Enum("owner", "manager", "viewer", name="userrole"), nullable=False),
        sa.Column("is_active", sa.Boolean(), default=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── vehicles ─────────────────────────────────────────
    op.create_table(
        "vehicles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("plate_number", sa.String(20), nullable=False),
        sa.Column("description", sa.String(255)),
        sa.Column("driver_name", sa.String(255)),
        sa.Column("is_active", sa.Boolean(), default=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── e100_credentials ────────────────────────────────
    op.create_table(
        "e100_credentials",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("label", sa.String(100), default="e100"),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("encrypted_password", sa.Text(), nullable=False),
        # Issue #12: source_account (hashed username) for provenance
        sa.Column("source_account", sa.String(255)),
        sa.Column("is_active", sa.Boolean(), default=True),
        sa.Column("last_sync_at", sa.DateTime(timezone=True)),
        sa.Column("last_sync_status", sa.String(50)),
        sa.Column("last_sync_error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── transactions (with all v2 fields) ───────────────
    op.create_table(
        "transactions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("vehicle_id", sa.Integer(), sa.ForeignKey("vehicles.id"), nullable=True),
        sa.Column("source", sa.String(50), default="e100"),
        sa.Column("external_id", sa.String(100)),
        # Issue #12: provenance fields
        sa.Column("credential_id", sa.Integer(), sa.ForeignKey("e100_credentials.id"), nullable=True),
        sa.Column("source_account", sa.String(255), nullable=True),
        sa.Column("transaction_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("card_number", sa.String(50)),
        sa.Column("card_shortname", sa.String(30)),
        sa.Column("plate_number", sa.String(20)),
        sa.Column("driver_name", sa.String(255)),
        sa.Column("country", sa.String(5)),
        sa.Column("station_id", sa.String(30)),
        sa.Column("station_address", sa.Text()),
        sa.Column("station_region", sa.String(100)),
        # Issue #2: NUMERIC money columns (was Float)
        sa.Column("price", sa.Numeric(12, 4)),
        sa.Column("volume", sa.Numeric(12, 3)),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False),
        # Issue #3: FX-rate tracking
        sa.Column("fx_rate", sa.Numeric(18, 8), nullable=True),
        sa.Column("amount_eur", sa.Numeric(14, 2), nullable=True),
        sa.Column("fx_rate_date", sa.Date(), nullable=True),
        sa.Column("fx_source", sa.String(20), nullable=True),
        sa.Column("service_category", sa.Integer()),
        sa.Column("fuel_type", sa.String(100)),
        sa.Column("category_code", sa.Integer()),
        sa.Column("is_confirmed", sa.Boolean(), default=True),
        sa.Column("e100_mobility", sa.Boolean(), default=False),
        sa.Column("inserted_at_source", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index(
        "ix_transactions_company_credential_ext",
        "transactions", ["company_id", "credential_id", "external_id"],
    )
    op.create_index("ix_transactions_credential_id", "transactions", ["credential_id"])

    # ── mileage ─────────────────────────────────────────
    op.create_table(
        "mileage",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("vehicle_id", sa.Integer(), sa.ForeignKey("vehicles.id"), nullable=True),
        sa.Column("plate_number", sa.String(20), nullable=False),
        sa.Column("date", sa.DateTime(timezone=True), nullable=False),
        # Issue #2: NUMERIC km and fuel_liters (was Float)
        sa.Column("km", sa.Numeric(12, 3), nullable=False, default=0),
        sa.Column("fuel_liters", sa.Numeric(12, 3), nullable=True),
        sa.Column("source", sa.String(50), default="navby_xlsx"),
        sa.Column("external_id", sa.String(150)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── mileage_segments ────────────────────────────────
    op.create_table(
        "mileage_segments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("vehicle_id", sa.Integer(), sa.ForeignKey("vehicles.id"), nullable=True),
        sa.Column("plate_number", sa.String(20), nullable=False),
        sa.Column("date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("time_from", sa.String(8)),
        sa.Column("time_to", sa.String(8)),
        sa.Column("status", sa.String(20), nullable=False),
        # Issue #2: NUMERIC km (was Float)
        sa.Column("km", sa.Numeric(12, 3), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=False, default=0),
        sa.Column("source", sa.String(50), default="navby_xlsx"),
        sa.Column("external_id", sa.String(200)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── telegram_settings ───────────────────────────────
    op.create_table(
        "telegram_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"),
                  unique=True, nullable=False),
        sa.Column("chat_id", sa.String(50)),
        sa.Column("notify_on_transaction", sa.Boolean(), default=True),
        sa.Column("notify_daily_summary", sa.Boolean(), default=False),
        sa.Column("daily_summary_time", sa.String(5), default="08:00"),
        sa.Column("is_active", sa.Boolean(), default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── scraper_settings ────────────────────────────────
    op.create_table(
        "scraper_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"),
                  unique=True, nullable=False),
        sa.Column("interval_minutes", sa.Integer(), default=60),
        sa.Column("is_enabled", sa.Boolean(), default=True),
        sa.Column("lookback_days", sa.Integer(), default=30),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── recurring_contracts + tombstones ──────────────
    op.create_table(
        "recurring_contracts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("category", sa.String(30), nullable=False),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        # Issue #2: NUMERIC
        sa.Column("annual_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False, default="EUR"),
        sa.Column("day_of_month", sa.Integer(), nullable=False),
        sa.Column("monthly_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("is_active", sa.Boolean(), default=True, nullable=False),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_recurring_contracts_company_id", "recurring_contracts", ["company_id"])

    op.create_table(
        "recurring_tombstones",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("contract_id", sa.Integer(),
                  sa.ForeignKey("recurring_contracts.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("year_month", sa.String(7), nullable=False),
        sa.Column("external_id", sa.String(150), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_recurring_tombstones_company_id", "recurring_tombstones", ["company_id"])
    op.create_index("ix_recurring_tombstones_contract_id", "recurring_tombstones", ["contract_id"])

    # ── leasing_contracts + tombstones ────────────────
    op.create_table(
        "leasing_contracts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("vehicle_id", sa.Integer(), sa.ForeignKey("vehicles.id"), nullable=True),
        sa.Column("plate_number", sa.String(20), nullable=False),
        sa.Column("description", sa.String(500)),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("term_months", sa.Integer(), nullable=False),
        sa.Column("total_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False, default="EUR"),
        sa.Column("day_of_month", sa.Integer(), nullable=False),
        sa.Column("monthly_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("is_active", sa.Boolean(), default=True, nullable=False),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_leasing_contracts_company_id", "leasing_contracts", ["company_id"])

    op.create_table(
        "leasing_tombstones",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("contract_id", sa.Integer(),
                  sa.ForeignKey("leasing_contracts.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("year_month", sa.String(7), nullable=False),
        sa.Column("external_id", sa.String(150), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_leasing_tombstones_company_id", "leasing_tombstones", ["company_id"])
    op.create_index("ix_leasing_tombstones_contract_id", "leasing_tombstones", ["contract_id"])

    # ── trailer_contracts + tombstones ─────────────────
    op.create_table(
        "trailer_contracts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("plate_number", sa.String(20), nullable=False),
        sa.Column("category", sa.String(30), nullable=False),
        sa.Column("description", sa.String(500)),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("term_months", sa.Integer(), nullable=False),
        sa.Column("total_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False, default="EUR"),
        sa.Column("day_of_month", sa.Integer(), nullable=False),
        sa.Column("monthly_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("is_active", sa.Boolean(), default=True, nullable=False),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_trailer_contracts_company_id", "trailer_contracts", ["company_id"])

    op.create_table(
        "trailer_tombstones",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("contract_id", sa.Integer(),
                  sa.ForeignKey("trailer_contracts.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("year_month", sa.String(7), nullable=False),
        sa.Column("external_id", sa.String(150), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_trailer_tombstones_company_id", "trailer_tombstones", ["company_id"])
    op.create_index("ix_trailer_tombstones_contract_id", "trailer_tombstones", ["contract_id"])

    # ── insurance_contracts + tombstones ───────────────
    op.create_table(
        "insurance_contracts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("vehicle_id", sa.Integer(), sa.ForeignKey("vehicles.id"), nullable=True),
        sa.Column("plate_number", sa.String(20), nullable=False),
        sa.Column("category", sa.String(30), nullable=False),
        sa.Column("description", sa.String(500)),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("term_months", sa.Integer(), nullable=False),
        sa.Column("total_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False, default="EUR"),
        sa.Column("day_of_month", sa.Integer(), nullable=False),
        sa.Column("monthly_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("is_active", sa.Boolean(), default=True, nullable=False),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_insurance_contracts_company_id", "insurance_contracts", ["company_id"])

    op.create_table(
        "insurance_tombstones",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("contract_id", sa.Integer(),
                  sa.ForeignKey("insurance_contracts.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("year_month", sa.String(7), nullable=False),
        sa.Column("external_id", sa.String(150), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_insurance_tombstones_company_id", "insurance_tombstones", ["company_id"])
    op.create_index("ix_insurance_tombstones_contract_id", "insurance_tombstones", ["contract_id"])

    # ── Issue #3: fx_rates ──────────────────────────────
    op.create_table(
        "fx_rates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("currency", sa.String(10), nullable=False),
        sa.Column("rate_date", sa.Date(), nullable=False),
        sa.Column("rate_to_eur", sa.Numeric(18, 8), nullable=False),
        sa.Column("source", sa.String(20), default="ECB"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("currency", "rate_date", name="uq_fx_rates_currency_date"),
    )
    op.create_index("ix_fx_rates_currency", "fx_rates", ["currency"])
    op.create_index("ix_fx_rates_rate_date", "fx_rates", ["rate_date"])
    op.create_index("ix_fx_rates_currency_date", "fx_rates", ["currency", "rate_date"])

    # ── Issue #4: audit_log ─────────────────────────────
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("user_email", sa.String(255), nullable=True),
        sa.Column("action", sa.String(30), nullable=False),
        sa.Column("entity_type", sa.String(50), nullable=False),
        sa.Column("entity_id", sa.String(64), nullable=True),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=True),
        sa.Column("ip_address", sa.String(64), nullable=True),
        sa.Column("user_agent", sa.String(512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_audit_log_company_id", "audit_log", ["company_id"])
    op.create_index("ix_audit_log_created_at", "audit_log", ["created_at"])
    op.create_index("ix_audit_log_company_created", "audit_log", ["company_id", "created_at"])
    op.create_index("ix_audit_log_entity", "audit_log", ["entity_type", "entity_id"])


def downgrade() -> None:
    # Drop in reverse-dependency order
    for tbl in [
        "audit_log", "fx_rates",
        "insurance_tombstones", "insurance_contracts",
        "trailer_tombstones", "trailer_contracts",
        "leasing_tombstones", "leasing_contracts",
        "recurring_tombstones", "recurring_contracts",
        "scraper_settings", "telegram_settings",
        "mileage_segments", "mileage",
        "transactions", "e100_credentials",
        "vehicles", "users", "companies",
    ]:
        op.drop_table(tbl)
