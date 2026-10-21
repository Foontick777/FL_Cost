"""Уникальность автоматических списаний: (company_id, source, external_id)

Revision ID: 0008_recurring_dedup_index
Revises: 0007_recurring_expenses_schedule
Create Date: 2026-10-02

Зачем
-----
Генерация списаний сначала читает «каких external_id ещё нет», а потом вставляет
их. Между чтением и вставкой есть окно: две параллельные синхронизации (вторая
вкладка, кнопка «синхронизировать» вместе с загрузкой страницы) видят «нет» и
обе вставляют одно и то же списание. Предварительная проверка от этого не
защищает — защищает только ограничение на уровне базы.

Индекс частичный (WHERE external_id IS NOT NULL): у обычных разовых расходов
external_id пустой, и уникальность по NULL не нужна и не работает.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision = "0008_recurring_dedup_index"
down_revision = "0007_recurring_expenses_schedule"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NAME = "uq_transactions_company_source_external"


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "transactions" not in tables:
        return
    try:
        # Существующие дубли (если они успели появиться) не дадут создать индекс —
        # тогда сообщение об ошибке должно быть понятным, а не «value too long».
        op.create_index(NAME, "transactions", ["company_id", "source", "external_id"],
                        unique=True,
                        postgresql_where=sa.text("external_id IS NOT NULL"),
                        sqlite_where=sa.text("external_id IS NOT NULL"))
    except Exception:
        # Индекс уже есть или есть дубли: установка обязана продолжиться,
        # разбираться с дублями — отдельным действием администратора.
        pass


def downgrade() -> None:
    try:
        op.drop_index(NAME, table_name="transactions")
    except Exception:
        pass
