"""money_typmod_repair: enforce the REAL NUMERIC(p, s) types on existing DBs

Revision ID: 0004_money_typmod_repair
Revises: 0003_integrity_constraints
Create Date: 2026-09-22

WHY THIS EXISTS (applies to every database created before this patch)
--------------------------------------------------------------------
Migration 0002 was supposed to convert the money columns from DOUBLE PRECISION
to fixed-scale NUMERIC. It ran this:

    op.alter_column("transactions", "amount",
                    existing_type=sa.Float(),
                    type_=sa.Numeric() if "18" in new_type else sa.Numeric(),
                    ...)

Both branches are identical and pass `sa.Numeric()` with NO precision/scale, so
PostgreSQL received `ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC`.
That command **drops the typmod**: the column becomes unbounded `numeric`
instead of `numeric(14, 2)`. The `postgresql_using=ROUND(...)` expression did
round the values that existed at conversion time, but from that moment on the
database happily accepted `12.3456789` in an amount column and never rounded
anything.

What this means for an OLD database:
  • your historical rows are fine — they were rounded once during 0002;
  • but the column itself is not what the SQLAlchemy model declares, so
    `Column(Numeric(14, 2))` and the real DB disagree;
  • every write goes through Python float/Decimal conversion with no DB-level
    guarantee, which is exactly the drift Issue #2 was meant to end.

This migration re-applies the intended types. It reads the ACTUAL typmod from
information_schema first and only touches columns that differ, so:
  • on a DB that already has the right types (fresh install) it does nothing;
  • running it twice does nothing (idempotent);
  • it works whether the column is currently `numeric` (unbounded) or still
    `double precision` (if 0002 never reached that column).

⚠️ If a value does not fit the target precision (e.g. an amount above
   999 999 999 999.99 in numeric(14,2)), PostgreSQL aborts with
   "numeric field overflow" and the whole migration rolls back — nothing is
   lost. Find the offending rows with:

     SELECT id, amount FROM transactions ORDER BY abs(amount) DESC LIMIT 20;
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

log = logging.getLogger(__name__)

revision: str = "0004_money_typmod_repair"
down_revision: Union[str, None] = "0003_integrity_constraints"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, column, precision, scale) — taken from app/models/models.py, which is
# the source of truth for what the application expects.
TARGETS: list[tuple[str, str, int, int]] = [
    # transactions: money and measured quantities
    ("transactions", "price", 12, 4),
    ("transactions", "volume", 12, 3),
    ("transactions", "amount", 14, 2),
    ("transactions", "fx_rate", 18, 8),
    ("transactions", "amount_eur", 14, 2),
    # revision snapshots keep the same precision, otherwise "было/стало"
    # comparisons start flapping on rounding differences
    ("transaction_revisions", "amount", 14, 2),
    ("transaction_revisions", "fx_rate", 18, 8),
    ("transaction_revisions", "amount_eur", 14, 2),
    # odometer / fuel
    ("mileage", "km", 12, 3),
    ("mileage", "fuel_liters", 12, 3),
    ("mileage_segments", "km", 12, 3),
    # contracts (auto-generated monthly charges are derived from these)
    ("recurring_contracts", "annual_amount", 18, 2),
    ("recurring_contracts", "monthly_amount", 18, 2),
    ("leasing_contracts", "total_amount", 18, 2),
    ("leasing_contracts", "monthly_amount", 18, 2),
    ("trailer_contracts", "total_amount", 18, 2),
    ("trailer_contracts", "monthly_amount", 18, 2),
    ("insurance_contracts", "total_amount", 18, 2),
    ("insurance_contracts", "monthly_amount", 18, 2),
    # FX rates: 1 unit of currency = rate_to_eur EUR
    ("fx_rates", "rate_to_eur", 18, 8),
]


def _current_types() -> dict[tuple[str, str], tuple[str | None, int | None, int | None]]:
    """{(table, column): (data_type, numeric_precision, numeric_scale)}"""
    rows = op.get_bind().execute(sa.text(
        """
        SELECT table_name, column_name, data_type,
               numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = current_schema()
        """
    )).all()
    return {
        (r[0], r[1]): (r[2], r[3], r[4])
        for r in rows
    }


def upgrade() -> None:
    existing = _current_types()
    fixed, skipped, missing = [], [], []

    for table, column, precision, scale in TARGETS:
        info = existing.get((table, column))
        if info is None:
            # Column/table not present (older DB, or table created later) —
            # nothing to repair, and creating it here is not this migration's
            # job.
            missing.append(f"{table}.{column}")
            continue

        data_type, cur_precision, cur_scale = info
        if data_type == "numeric" and cur_precision == precision and cur_scale == scale:
            skipped.append(f"{table}.{column}")
            continue

        log.info(
            "0004: %s.%s %s(%s,%s) → numeric(%s,%s)",
            table, column, data_type, cur_precision, cur_scale, precision, scale,
        )
        op.alter_column(
            table,
            column,
            type_=sa.Numeric(precision, scale),
            # Works from double precision AND from unbounded numeric. ROUND
            # guarantees the conversion to a smaller scale cannot fail on
            # normal values (PostgreSQL would otherwise round half-up itself,
            # but being explicit keeps the intent obvious).
            postgresql_using=f"ROUND(CAST({column} AS NUMERIC({precision},{scale})), {scale})",
            existing_nullable=True,
        )
        fixed.append(f"{table}.{column}")

    log.info(
        "0004 money typmod repair: fixed=%d already-correct=%d absent=%d",
        len(fixed), len(skipped), len(missing),
    )
    if fixed:
        log.info("0004 fixed: %s", ", ".join(fixed))
    if missing:
        log.info("0004 absent (skipped): %s", ", ".join(missing))


def downgrade() -> None:
    """Deliberately a no-op.

    Reverting to FLOAT / unbounded NUMERIC would silently reintroduce the
    rounding problem this migration exists to fix, and cannot restore values
    that were already rounded to 2/3/4 decimals. Restore from a backup instead.
    """
    log.warning(
        "0004 downgrade is a no-op on purpose — restoring float money columns "
        "would bring back the precision bug. Restore from a database backup."
    )
