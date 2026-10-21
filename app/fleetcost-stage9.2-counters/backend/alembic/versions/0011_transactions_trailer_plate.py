"""Номер прицепа в строке операции

Revision ID: 0011_transactions_trailer_plate
Revises: 0010_recurring_policy_fields
Create Date: 2026-10-02

Зачем
-----
В счетах описание услуги содержит пару «тягач/прицеп» — «BI329LF/QASB981».
Раньше из неё брался только тягач, а номер прицепа выбрасывался: информация о
том, какой прицеп работал с какой машиной, приходила с каждым счётом и терялась.
Отдельная колонка делает эту связку данными, а не текстом: по ней расходы прицепа
можно относить на машину, которая им пользовалась, а не раскидывать ровным счётом
на весь парк.

Индекс по колонке нужен для отчётов «расходы по прицепу» и «какой прицеп с какой
машиной работал».
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision = "0011_transactions_trailer_plate"
down_revision = "0010_recurring_policy_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if "transactions" not in set(sa.inspect(bind).get_table_names()):
        return
    cols = {c["name"] for c in sa.inspect(bind).get_columns("transactions")}
    if "trailer_plate" not in cols:
        op.add_column("transactions", sa.Column("trailer_plate", sa.String(20), nullable=True))
    try:
        op.create_index("ix_transactions_trailer_plate", "transactions", ["trailer_plate"])
    except Exception:
        # Индекс уже есть (или СУБД его не поддерживает так) — установка продолжается.
        pass


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("transactions")}
    if "trailer_plate" in cols:
        try:
            op.drop_index("ix_transactions_trailer_plate", table_name="transactions")
        except Exception:
            pass
        try:
            op.drop_column("transactions", "trailer_plate")
        except Exception:
            pass
