"""Отзывные refresh-токены и версия access-токенов (SEC-02, аудит stage8)

Revision ID: 0016_refresh_tokens
Revises: 0015_recurring_legacy_ref
Create Date: 2026-10-19

Зачем
-----
До этого спринта access-JWT жил 7 дней и не отзывался НИКАК: украденный
cookie оставался валидным неделю, выход из системы лишь очищал cookie в
браузере, деактивация пользователя закрывала только новые запросы.

Механизм после миграции:
  • users.token_version — версия access-токенов. Попадает в клейм "ver";
    get_current_user сверяет клейм с колонкой, повышение версии мгновенно
    аннулирует все ранее выданные токены пользователя.
  • refresh_tokens — отзывные сессии на 14 дней (в БД только SHA-256 хэш
    токена, вместе с user_agent/ip для будущего экрана «активные сессии»).
    Ротация при каждом /auth/refresh; reuse отозванного токена отзывает
    ВСЕ сессии пользователя (обнаружение кражи).

Все существующие пользователи получают token_version = 0 — их текущие
токены без клейма "ver" будут отклонены один раз (перелогин), дальше
механизм работает как обычно.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision = "0016_refresh_tokens"
down_revision = "0015_recurring_legacy_ref"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())

    if "users" in tables:
        cols = {c["name"] for c in sa.inspect(bind).get_columns("users")}
        if "token_version" not in cols:
            op.add_column("users", sa.Column(
                "token_version", sa.Integer, nullable=False,
                server_default=sa.text("0")))

    if "users" in tables and "refresh_tokens" not in tables:
        op.create_table(
            "refresh_tokens",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("user_id", sa.Integer,
                      sa.ForeignKey("users.id"), nullable=False),
            sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now()),
            sa.Column("user_agent", sa.String(512), nullable=True),
            sa.Column("ip", sa.String(64), nullable=True),
        )
        op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"])
        op.create_index("ix_refresh_tokens_token_hash", "refresh_tokens", ["token_hash"])


def downgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "refresh_tokens" in tables:
        op.drop_table("refresh_tokens")
    if "users" in tables:
        cols = {c["name"] for c in sa.inspect(bind).get_columns("users")}
        if "token_version" in cols:
            op.drop_column("users", "token_version")
