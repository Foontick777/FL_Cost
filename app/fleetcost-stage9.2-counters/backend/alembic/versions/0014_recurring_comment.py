"""Комментарий к регулярному расходу

Revision ID: 0014_recurring_comment
Revises: 0013_transaction_is_paid
Create Date: 2026-10-09

Форма принимала комментарий для регулярного платежа, но сохранять его было
некуда — текст терялся. Теперь он хранится в договоре и копируется в списания.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision = "0014_recurring_comment"
down_revision = "0013_transaction_is_paid"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if "recurring_expenses" not in set(sa.inspect(bind).get_table_names()):
        return
    cols = {c["name"] for c in sa.inspect(bind).get_columns("recurring_expenses")}
    if "comment" not in cols:
        op.add_column("recurring_expenses", sa.Column("comment", sa.String(500), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("recurring_expenses")}
    if "comment" in cols:
        op.drop_column("recurring_expenses", "comment")
