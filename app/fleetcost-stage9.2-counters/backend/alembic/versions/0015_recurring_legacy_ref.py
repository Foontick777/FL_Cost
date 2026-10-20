"""Отметка «перенесено из старого договора» у регулярного расхода

Revision ID: 0015_recurring_legacy_ref
Revises: 0014_recurring_comment
Create Date: 2026-10-14

Старые договоры (лизинг, прицепы, страхование, общие) переносятся в единую
модель регулярных расходов. `legacy_ref` ("leasing:12") делает перенос
идемпотентным.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision = "0015_recurring_legacy_ref"
down_revision = "0014_recurring_comment"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if "recurring_expenses" not in set(sa.inspect(bind).get_table_names()):
        return
    cols = {c["name"] for c in sa.inspect(bind).get_columns("recurring_expenses")}
    if "legacy_ref" not in cols:
        op.add_column("recurring_expenses", sa.Column("legacy_ref", sa.String(40), nullable=True))
    idx = {i["name"] for i in sa.inspect(bind).get_indexes("recurring_expenses")}
    if "ix_recurring_expenses_legacy_ref" not in idx:
        op.create_index("ix_recurring_expenses_legacy_ref", "recurring_expenses", ["legacy_ref"])


def downgrade() -> None:
    bind = op.get_bind()
    idx = {i["name"] for i in sa.inspect(bind).get_indexes("recurring_expenses")}
    if "ix_recurring_expenses_legacy_ref" in idx:
        op.drop_index("ix_recurring_expenses_legacy_ref", table_name="recurring_expenses")
    cols = {c["name"] for c in sa.inspect(bind).get_columns("recurring_expenses")}
    if "legacy_ref" in cols:
        op.drop_column("recurring_expenses", "legacy_ref")
