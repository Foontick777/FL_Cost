"""integrity_constraints: UNIQUE constraints on critical dedup keys

Revision ID: 0003_integrity_constraints
Revises: 0002_security_hardening
Create Date: 2026-09-20

Issue #2 from user code review: previously, dedup was enforced only via
Python code (application-level checks). Two parallel requests could both
pass the "does this plate already exist?" check and both insert, because
the DB itself had no UNIQUE constraint.

This migration adds real UNIQUE constraints on the canonical dedup keys:

  Vehicle                       UNIQUE(company_id, plate_number)
  Mileage                       UNIQUE(company_id, external_id)
  MileageSegment                UNIQUE(company_id, external_id)
  RecurringTombstone            UNIQUE(company_id, contract_id, year_month)
  LeasingTombstone              UNIQUE(company_id, contract_id, year_month)
  TrailerTombstone              UNIQUE(company_id, contract_id, year_month)
  InsuranceTombstone            UNIQUE(company_id, contract_id, year_month)
  E100Credential                UNIQUE(company_id, source_account)
                                (only when source_account IS NOT NULL)
  Transaction                   UNIQUE(company_id, credential_id, external_id)
                                (only when credential_id + external_id IS NOT NULL)

⚠️ ORIGINAL BUG (fixed here): this file used `try/except` around DDL calls
inside Alembic's single migration transaction. On PostgreSQL the first error
aborts the whole transaction, so every later statement failed with
InFailedSQLTransactionError and the whole migration rolled back — permanently.
Concretely, 0002 already creates `uq_fx_rates_company_currency_date`, so the
plain `op.create_unique_constraint(...)` below raised DuplicateObject on EVERY
fresh install, 0003 rolled back, `alembic_version` stayed at 0002 and the dedup
indexes (including `uq_transactions_company_credential_external`) were never
created. All operations are now guarded by an inspector check, which makes the
migration genuinely idempotent instead of pretending to be.

NOTE for existing deployments: if you have duplicate rows in any of these
tables (because there was no UNIQUE constraint before), this migration will
FAIL with a constraint violation on the corresponding CREATE. You need to
manually deduplicate first. The most common duplicates are Vehicles with the
same plate — usually safe to delete (keep the oldest, reassign transactions).

A helper SQL snippet to find duplicate vehicles:

  SELECT company_id, plate_number, count(*)
  FROM vehicles
  GROUP BY company_id, plate_number
  HAVING count(*) > 1;

To delete the newer duplicates:

  DELETE FROM vehicles WHERE id NOT IN (
    SELECT MIN(id) FROM vehicles GROUP BY company_id, plate_number
  );
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

log = logging.getLogger(__name__)

revision: str = "0003_integrity_constraints"
down_revision: Union[str, None] = "0002_security_hardening"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ── Inspector-based guards (no try/except: a failed statement in PostgreSQL
#    poisons the surrounding transaction and silently kills the rest) ──────
def _columns(table: str) -> set:
    try:
        return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}
    except Exception as e:
        log.warning(f"inspect columns {table} failed: {e}")
        return set()


def _unique_constraints(table: str) -> set:
    try:
        return {c["name"] for c in sa.inspect(op.get_bind()).get_unique_constraints(table)}
    except Exception as e:
        log.warning(f"inspect unique constraints {table} failed: {e}")
        return set()


def _indexes(table: str) -> set:
    try:
        return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}
    except Exception as e:
        log.warning(f"inspect indexes {table} failed: {e}")
        return set()


def _add_unique(name: str, table: str, cols: list) -> None:
    if name in _unique_constraints(table):
        log.info(f"UNIQUE {name} on {table} already exists — skip")
        return
    op.create_unique_constraint(name, table, cols)
    log.info(f"UNIQUE {name} on {table} created")


def _add_unique_partial_index(name: str, table: str, cols: list, where_sql: str) -> None:
    if name in _indexes(table):
        log.info(f"UNIQUE INDEX {name} on {table} already exists — skip")
        return
    op.create_index(name, table, cols, unique=True, postgresql_where=sa.text(where_sql))
    log.info(f"UNIQUE INDEX {name} on {table} created")


def _drop_unique_if_exists(name: str, table: str) -> None:
    if name not in _unique_constraints(table):
        log.info(f"UNIQUE {name} on {table} does not exist — nothing to drop")
        return
    op.drop_constraint(name, table, type_="unique")


def upgrade() -> None:
    # ── Vehicles ──────────────────────────────────────────────────────
    _add_unique("uq_vehicles_company_plate", "vehicles", ["company_id", "plate_number"])

    # ── Mileage / segments ────────────────────────────────────────────
    _add_unique("uq_mileage_company_external", "mileage", ["company_id", "external_id"])
    _add_unique("uq_mileage_segments_company_external", "mileage_segments",
                ["company_id", "external_id"])

    # ── Tombstones ────────────────────────────────────────────────────
    # These prevent the sync endpoint from re-creating a tombstoned month.
    _add_unique("uq_recurring_tombstones_contract_month", "recurring_tombstones",
                ["company_id", "contract_id", "year_month"])
    _add_unique("uq_leasing_tombstones_contract_month", "leasing_tombstones",
                ["company_id", "contract_id", "year_month"])
    _add_unique("uq_trailer_tombstones_contract_month", "trailer_tombstones",
                ["company_id", "contract_id", "year_month"])
    _add_unique("uq_insurance_tombstones_contract_month", "insurance_tombstones",
                ["company_id", "contract_id", "year_month"])

    # ── e100 credentials: unique per (company, source_account) when set ──
    # Partial unique index — the "only when NOT NULL" behaviour we want.
    _add_unique_partial_index(
        "uq_e100_credentials_company_source_account", "e100_credentials",
        ["company_id", "source_account"],
        "source_account IS NOT NULL",
    )

    # ── The canonical transaction dedup key ───────────────────────────
    # Without this, two parallel e100 syncs can both insert the same row.
    _add_unique_partial_index(
        "uq_transactions_company_credential_external", "transactions",
        ["company_id", "credential_id", "external_id"],
        "credential_id IS NOT NULL AND external_id IS NOT NULL",
    )

    # ── FxRate: company_id column + company-aware uniqueness ──────────
    if "company_id" not in _columns("fx_rates"):
        op.add_column(
            "fx_rates",
            sa.Column("company_id", sa.Integer(),
                      sa.ForeignKey("companies.id"), nullable=True),
        )
        log.info("fx_rates.company_id added")
    else:
        log.info("fx_rates.company_id already present — skip")

    # The legacy UNIQUE(currency, rate_date) blocks company-specific
    # overrides for a date that already has an ECB row → drop it, then add
    # the company-aware constraint (NULL company_id = global ECB rate).
    _drop_unique_if_exists("uq_fx_rates_currency_date", "fx_rates")
    _add_unique("uq_fx_rates_company_currency_date", "fx_rates",
                ["company_id", "currency", "rate_date"])


def downgrade() -> None:
    # Drop in reverse order, idempotently.
    _drop_unique_if_exists("uq_fx_rates_company_currency_date", "fx_rates")
    if "company_id" in _columns("fx_rates"):
        op.drop_column("fx_rates", "company_id")

    for name, table in [
        ("uq_transactions_company_credential_external", "transactions"),
        ("uq_e100_credentials_company_source_account", "e100_credentials"),
    ]:
        if name in _indexes(table):
            op.drop_index(name, table_name=table)

    for name, table in [
        ("uq_insurance_tombstones_contract_month", "insurance_tombstones"),
        ("uq_trailer_tombstones_contract_month", "trailer_tombstones"),
        ("uq_leasing_tombstones_contract_month", "leasing_tombstones"),
        ("uq_recurring_tombstones_contract_month", "recurring_tombstones"),
        ("uq_mileage_segments_company_external", "mileage_segments"),
        ("uq_mileage_company_external", "mileage"),
        ("uq_vehicles_company_plate", "vehicles"),
    ]:
        _drop_unique_if_exists(name, table)
