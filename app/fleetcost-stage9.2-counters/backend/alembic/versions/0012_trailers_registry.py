"""Реестр прицепов и привязки «прицеп ↔ машина» периодом

Revision ID: 0012_trailers_registry
Revises: 0011_transactions_trailer_plate
Create Date: 2026-10-02

Зачем
-----
До этого прицепов как объектов не было: список на странице собирался из НОМЕРОВ
в расходах, поэтому прицеп без расходов для системы не существовал, а опечатка в
номере создавала «второй» прицеп.

Почему привязка ПЕРИОДОМ. Анализ 488 счетов (сен 2025 — сен 2026): 89
«прицепо-месяцев», из них 16 с двумя машинами, 2 с тремя и 1 с четырьмя. Прицеп
действительно работает с разными тягачами, поэтому одна ссылка «текущая машина»
переписывала бы историю: в отчёте за прошлый месяц прицеп оказался бы привязан к
машине, которой тогда рядом не было.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision = "0012_trailers_registry"
down_revision = "0011_transactions_trailer_plate"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "trailers" not in tables:
        op.create_table(
            "trailers",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("company_id", sa.Integer, sa.ForeignKey("companies.id"), nullable=False),
            sa.Column("plate", sa.String(20), nullable=False),
            sa.Column("note", sa.String(200)),
            sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
            sa.Column("origin", sa.String(20), nullable=False, server_default="manual"),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id")),
            sa.UniqueConstraint("company_id", "plate", name="uq_trailers_company_plate"),
        )
        op.create_index("ix_trailers_company_id", "trailers", ["company_id"])

    if "trailer_bindings" not in tables:
        op.create_table(
            "trailer_bindings",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("company_id", sa.Integer, sa.ForeignKey("companies.id"), nullable=False),
            sa.Column("trailer_id", sa.Integer,
                      sa.ForeignKey("trailers.id", ondelete="CASCADE"), nullable=False),
            sa.Column("vehicle_id", sa.Integer, sa.ForeignKey("vehicles.id")),
            sa.Column("plate_number", sa.String(20)),
            sa.Column("from_date", sa.Date, nullable=False),
            sa.Column("to_date", sa.Date),
            sa.Column("note", sa.String(200)),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id")),
        )
        op.create_index("ix_trailer_bindings_company_period", "trailer_bindings",
                        ["company_id", "from_date", "to_date"])
        op.create_index("ix_trailer_bindings_trailer", "trailer_bindings",
                        ["trailer_id", "from_date"])

    # Прицепы, которые уже встречаются в операциях, попадают в реестр сразу:
    # иначе после обновления список прицепов оказался бы пустым, хотя расходы по
    # ним есть.
    if "transactions" in tables:
        try:
            bind.execute(sa.text(
                "INSERT INTO trailers (company_id, plate, origin) "
                "SELECT DISTINCT company_id, UPPER(REPLACE(trailer_plate, ' ', '')), 'import' "
                "FROM transactions WHERE trailer_plate IS NOT NULL AND trailer_plate <> '' "
                "ON CONFLICT DO NOTHING"
            ))
        except Exception:
            # ON CONFLICT поддерживается не всеми СУБД в этом виде — установка
            # обязана продолжиться, реестр наполнится при следующем импорте.
            pass


def downgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    for name in ("trailer_bindings", "trailers"):
        if name in tables:
            try:
                op.drop_table(name)
            except Exception:
                pass
