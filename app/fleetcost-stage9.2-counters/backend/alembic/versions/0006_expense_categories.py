"""expense_categories: динамические категории расходов + универсальные регулярные

Revision ID: 0006_expense_categories
Revises: 0005_fx_rates_partial_unique
Create Date: 2026-09-30

Что делает
----------
1. Создаёт `expense_categories` — категории расходов внутри фиксированных
   разделов (other / trailer / general / salary / salary_tax / insurance).
   Системные категории создаёт FleetCost, пользовательские — компания; и те и
   другие далее работают одинаково.
2. Создаёт `recurring_expenses` + `recurring_expense_tombstones` — регулярный
   расход для ЛЮБОЙ категории (объект: автомобиль / прицеп / компания).
3. Добавляет в `transactions` связь с категорией и атрибуты операции:
   `category_id`, `expense_type`, `periodicity`, `comment`, `document_ref`.
4. Добавляет в `insurance_contracts` атрибуты полиса `country`,
   `policy_number`, `insurer` и расширяет `category` до VARCHAR(60) — вид
   страхования становится свободным кодом категории, а страна перестаёт быть
   частью вида страхования.

Существующие данные НЕ трогаются: `fuel_type` (`manual_{section}_{code}`)
остаётся как есть, поэтому все текущие отчёты, фильтры и аналитика продолжают
работать. `category_id` заполняется только у новых операций (и у старых —
лениво, при первом открытии списка категорий, см. category_service.backfill).

Миграция идемпотентна: на каждом шаге проверяется фактическое состояние схемы,
поэтому её можно применять и на свежей БД, и на работающей базе.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0006_expense_categories"
down_revision: Union[str, None] = "0005_fx_rates_partial_unique"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables(bind) -> set:
    return set(sa.inspect(bind).get_table_names())


def _columns(bind, table: str) -> set:
    try:
        return {c["name"] for c in sa.inspect(bind).get_columns(table)}
    except Exception:
        return set()


def _drop_index(name: str, table: str) -> None:
    """Снять индекс, если он есть.

    На SQLite индекс НАДО снять до DROP COLUMN, иначе драйвер откажется
    («error in index … after drop column»). На PostgreSQL удаление колонки
    снимает индекс само, поэтому здесь просто «нет индекса — нет проблемы».
    """
    try:
        op.drop_index(name, table_name=table)
    except Exception:
        pass


def upgrade() -> None:
    bind = op.get_bind()
    tables = _tables(bind)

    # ── 1. expense_categories ────────────────────────────────────────────
    if "expense_categories" not in tables:
        op.create_table(
            "expense_categories",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("company_id", sa.Integer, sa.ForeignKey("companies.id"), nullable=False),
            sa.Column("section", sa.String(30), nullable=False),
            sa.Column("code", sa.String(50), nullable=False),
            sa.Column("name", sa.String(120), nullable=False),
            sa.Column("icon", sa.String(16)),
            sa.Column("color", sa.String(20)),
            sa.Column("object_scope", sa.String(20), nullable=False, server_default="any"),
            sa.Column("is_system", sa.Boolean, nullable=False, server_default=sa.false()),
            sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
            sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id")),
            sa.Column("updated_at", sa.DateTime(timezone=True)),
            sa.UniqueConstraint("company_id", "section", "code",
                                name="uq_expense_categories_company_section_code"),
        )
    for idx_name, cols in (
        ("ix_expense_categories_company_id", ["company_id"]),
        ("ix_expense_categories_company_section", ["company_id", "section", "is_active"]),
    ):
        try:
            op.create_index(idx_name, "expense_categories", cols, if_not_exists=True)
        except TypeError:
            # Старые версии alembic/sqlalchemy не знают if_not_exists — просто
            # пробуем создать и игнорируем «уже существует».
            try:
                op.create_index(idx_name, "expense_categories", cols)
            except Exception:
                pass
        except Exception:
            pass

    # ── 2. transactions: связь с категорией и атрибуты операции ──────────
    txn_cols = _columns(bind, "transactions")
    if "category_id" not in txn_cols:
        # Диалект решаем ДО вызова, а не через try/except: alembic на SQLite
        # успевает добавить колонку и только потом падает на добавлении FK, так
        # что «обработка ошибки повтором» дала бы duplicate column.
        # SQLite нужна только для локальных проверок; боевая СУБД — PostgreSQL,
        # где внешний ключ создаётся.
        if bind.dialect.name == "sqlite":
            op.add_column("transactions", sa.Column("category_id", sa.Integer, nullable=True))
        else:
            op.add_column("transactions", sa.Column(
                "category_id", sa.Integer, sa.ForeignKey("expense_categories.id"), nullable=True))
    if "expense_type" not in txn_cols:
        op.add_column("transactions", sa.Column(
            "expense_type", sa.String(20), server_default="oneoff"))
    if "periodicity" not in txn_cols:
        op.add_column("transactions", sa.Column("periodicity", sa.String(20)))
    if "comment" not in txn_cols:
        op.add_column("transactions", sa.Column("comment", sa.String(500)))
    if "document_ref" not in txn_cols:
        op.add_column("transactions", sa.Column("document_ref", sa.String(255)))
    try:
        op.create_index("ix_transactions_category_id", "transactions", ["category_id"],
                        if_not_exists=True)
    except TypeError:
        try:
            op.create_index("ix_transactions_category_id", "transactions", ["category_id"])
        except Exception:
            pass
    except Exception:
        pass

    # ── 3. insurance_contracts: атрибуты полиса, свободный вид страхования ──
    ins_cols = _columns(bind, "insurance_contracts")
    if "country" not in ins_cols:
        op.add_column("insurance_contracts", sa.Column("country", sa.String(60)))
    if "policy_number" not in ins_cols:
        op.add_column("insurance_contracts", sa.Column("policy_number", sa.String(100)))
    if "insurer" not in ins_cols:
        op.add_column("insurance_contracts", sa.Column("insurer", sa.String(200)))
    # Расширяем категорию: пользовательские виды страхования длиннее прежних
    # жёстких «polish | casco | belarus».
    try:
        op.alter_column("insurance_contracts", "category",
                        existing_type=sa.String(30), type_=sa.String(60),
                        existing_nullable=False)
    except Exception:
        pass  # SQLite не умеет ALTER TYPE — там тип не ограничивает длину строки

    # ── 4. recurring_expenses ────────────────────────────────────────────
    if "recurring_expenses" not in tables:
        op.create_table(
            "recurring_expenses",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("company_id", sa.Integer, sa.ForeignKey("companies.id"), nullable=False),
            sa.Column("category_id", sa.Integer, sa.ForeignKey("expense_categories.id"),
                      nullable=False),
            sa.Column("vehicle_id", sa.Integer, sa.ForeignKey("vehicles.id")),
            sa.Column("trailer_plate", sa.String(20)),
            sa.Column("plate_number", sa.String(20)),
            sa.Column("description", sa.String(500), nullable=False),
            sa.Column("amount", sa.Numeric(18, 2), nullable=False),
            sa.Column("currency", sa.String(10), nullable=False, server_default="EUR"),
            sa.Column("frequency", sa.String(20), nullable=False, server_default="monthly"),
            sa.Column("start_date", sa.Date, nullable=False),
            sa.Column("end_date", sa.Date),
            sa.Column("day_of_month", sa.Integer, nullable=False, server_default="1"),
            sa.Column("next_run_at", sa.Date),
            sa.Column("last_run_at", sa.Date),
            sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
            sa.Column("cancelled_at", sa.DateTime(timezone=True)),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id")),
        )
    for idx_name, cols in (
        ("ix_recurring_expenses_company_id", ["company_id"]),
        ("ix_recurring_expenses_category_id", ["category_id"]),
        ("ix_recurring_expenses_company_active", ["company_id", "is_active"]),
    ):
        try:
            op.create_index(idx_name, "recurring_expenses", cols, if_not_exists=True)
        except TypeError:
            try:
                op.create_index(idx_name, "recurring_expenses", cols)
            except Exception:
                pass
        except Exception:
            pass

    # ── 5. recurring_expense_tombstones ──────────────────────────────────
    if "recurring_expense_tombstones" not in tables:
        op.create_table(
            "recurring_expense_tombstones",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("company_id", sa.Integer, sa.ForeignKey("companies.id"), nullable=False),
            sa.Column("contract_id", sa.Integer,
                      sa.ForeignKey("recurring_expenses.id", ondelete="CASCADE"), nullable=False),
            sa.Column("period_key", sa.String(10), nullable=False),
            sa.Column("external_id", sa.String(150), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.UniqueConstraint("company_id", "contract_id", "period_key",
                                name="uq_recurring_expense_tombstones_contract_period"),
        )
    try:
        op.create_index("ix_recurring_expense_tombstones_contract_id",
                        "recurring_expense_tombstones", ["contract_id"], if_not_exists=True)
    except TypeError:
        try:
            op.create_index("ix_recurring_expense_tombstones_contract_id",
                            "recurring_expense_tombstones", ["contract_id"])
        except Exception:
            pass
    except Exception:
        pass


def downgrade() -> None:
    """Откат. Данные категорий при этом теряются, поэтому по умолчанию
    рекомендуется откатываться только на резервной копии."""
    bind = op.get_bind()
    tables = _tables(bind)

    if "recurring_expense_tombstones" in tables:
        op.drop_table("recurring_expense_tombstones")
    if "recurring_expenses" in tables:
        op.drop_table("recurring_expenses")

    ins_cols = _columns(bind, "insurance_contracts")
    for col in ("insurer", "policy_number", "country"):
        if col in ins_cols:
            op.drop_column("insurance_contracts", col)

    txn_cols = _columns(bind, "transactions")
    if "category_id" in txn_cols:
        # Индекс снимаем ДО колонки: на SQLite иначе DROP COLUMN падает.
        _drop_index("ix_transactions_category_id", "transactions")
    for col in ("document_ref", "comment", "periodicity", "expense_type", "category_id"):
        if col in txn_cols:
            op.drop_column("transactions", col)

    if "expense_categories" in tables:
        op.drop_table("expense_categories")
