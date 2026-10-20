"""Признак факта оплаты по начислению

Revision ID: 0013_transaction_is_paid
Revises: 0012_trailers_registry
Create Date: 2026-10-02

Зачем
-----
Регулярное списание — это НАЧИСЛЕНИЕ. Оно может быть оплачено, а может быть нет,
и до сих пор в системе эти состояния не различались: счётчик показывал «создано
списаний», но не «оплачено».

Почему отдельное поле, а не существующий `is_confirmed`. `is_confirmed` означает
подтверждение со стороны банка («False = blocked, exclude from accounting» —
так это описано в e100-клиенте). Если переиспользовать его, неоплаченное
начисление и заблокированная банковская операция станут неразличимы, и в
интерфейсе появится «Blocked» там, где на самом деле «ещё не заплатили».

Почему DEFAULT TRUE. Пользователь оценивает долю реально оплачиваемых договоров
как 95%, поэтому подтверждать каждую строку — лишняя работа. Начисление сразу
считается оплаченным, а опровергается точечно: нашёл дату и снял отметку.
Уже существующие строки тоже становятся оплаченными — для истории это верно.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision = "0013_transaction_is_paid"
down_revision = "0012_trailers_registry"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if "transactions" not in set(sa.inspect(bind).get_table_names()):
        return
    cols = {c["name"] for c in sa.inspect(bind).get_columns("transactions")}
    if "is_paid" not in cols:
        op.add_column("transactions", sa.Column(
            "is_paid", sa.Boolean, nullable=False, server_default=sa.true()))
    # Внешний ключ на договор регулярного расхода. Без него связь списания с
    # договором приходилось восстанавливать разбором external_id, и это дважды
    # приводило к ошибкам (LIKE с подстановочным «_» затрагивал чужой договор).
    # Именно эта колонка отсутствовала в базе, из-за чего запросы к transactions
    # падали и страницы показывали пустые списки.
    if "recurring_expense_id" not in cols:
        op.add_column("transactions", sa.Column(
            "recurring_expense_id", sa.Integer,
            sa.ForeignKey("recurring_expenses.id"), nullable=True))
    for name, cols_ in (("ix_transactions_is_paid", ["is_paid"]),
                        ("ix_transactions_recurring_expense_id", ["recurring_expense_id"])):
        try:
            op.create_index(name, "transactions", cols_)
        except Exception:
            pass


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("transactions")}
    if "is_paid" in cols:
        try:
            op.drop_index("ix_transactions_is_paid", table_name="transactions")
        except Exception:
            pass
        try:
            op.drop_column("transactions", "is_paid")
        except Exception:
            pass
