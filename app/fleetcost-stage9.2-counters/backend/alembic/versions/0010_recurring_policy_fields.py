"""Полисные атрибуты регулярного расхода: страна, номер полиса, страховая

Revision ID: 0010_recurring_policy_fields
Revises: 0009_unify_leasing_into_recurring
Create Date: 2026-10-02

Зачем
-----
Страна, номер полиса и страховая были только у старой модели InsuranceContract.
После объединения страховки с регулярными расходами (0006/0008) создавать полисы
можно только новым механизмом — а значит, вводить эти признаки стало некуда:
в учёте они терялись. Три необязательных поля закрывают это без отдельной модели.

Страна — именно признак ПОЛИСА, а не часть вида страхования: «КАСКО» в Польше и в
Германии оформляют разные страховщики по разным правилам, и одним кодом
категории это не выразить.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision = "0010_recurring_policy_fields"
down_revision = "0009_unify_leasing_into_recurring"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("country", sa.String(60)),
    ("policy_number", sa.String(100)),
    ("insurer", sa.String(200)),
)


def _columns(bind, table: str) -> set:
    try:
        return {c["name"] for c in sa.inspect(bind).get_columns(table)}
    except Exception:
        return set()


def upgrade() -> None:
    bind = op.get_bind()
    if "recurring_expenses" not in set(sa.inspect(bind).get_table_names()):
        return
    existing = _columns(bind, "recurring_expenses")
    for name, type_ in COLUMNS:
        if name not in existing:
            op.add_column("recurring_expenses", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    existing = _columns(bind, "recurring_expenses")
    for name, _ in COLUMNS:
        if name in existing:
            try:
                op.drop_column("recurring_expenses", name)
            except Exception:
                pass
