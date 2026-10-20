"""Догоняющие миграции схемы при старте приложения.

Зачем отдельный модуль. Такие миграции писались как
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — синтаксис PostgreSQL, которого НЕ
понимает SQLite. Там оператор падал, а `except` только писал предупреждение, и
колонка молча не появлялась. В результате модель знала про `is_paid` и
`recurring_expense_id`, а база — нет: ЛЮБОЙ запрос к `transactions` падал с
«no such column», страницы показывали пустые списки, синхронизация отвечала 500.

Здесь колонка сначала ищется в описании таблицы, и только потом добавляется.
Работает одинаково на PostgreSQL и SQLite, повторный запуск безопасен, а
результат можно проверить тестом (см. tests/test_schema_sync.py).
"""
import logging

from sqlalchemy import text

logger = logging.getLogger(__name__)


async def table_columns(conn, table: str) -> set[str]:
    """Имена колонок таблицы. Пустое множество, если таблицы нет."""
    dialect = getattr(conn.dialect, "name", "")
    try:
        if dialect == "sqlite":
            rows = (await conn.execute(text(f"PRAGMA table_info({table})"))).all()
            return {r[1] for r in rows}
        rows = (await conn.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :t"
        ), {"t": table})).all()
        return {r[0] for r in rows}
    except Exception as e:  # таблицы нет или нет прав — это не ошибка синхронизации
        logger.warning(f"schema_sync: не удалось прочитать колонки {table}: {e}")
        return set()


async def ensure_column(conn, table: str, column: str, ddl_type: str) -> bool:
    """Добавить колонку, если её нет. True — колонка добавлена этим вызовом."""
    cols = await table_columns(conn, table)
    if not cols:
        return False          # таблицы ещё нет: её создаст create_all/alembic
    if column in cols:
        return False
    try:
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"))
        logger.info(f"schema_sync: добавлена {table}.{column}")
        return True
    except Exception as e:
        logger.warning(f"schema_sync: {table}.{column} не добавлена: {e}")
        return False


async def ensure_index(conn, name: str, table: str, column: str) -> None:
    """Индекс по колонке. CREATE INDEX IF NOT EXISTS понимают оба диалекта."""
    try:
        await conn.execute(text(
            f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({column})"))
    except Exception as e:
        logger.warning(f"schema_sync: индекс {name} не создан: {e}")


# Колонки, появившиеся ПОСЛЕ первого выпуска схемы. Список — единственное место,
# где перечислено, что нужно догонять на существующей базе; тест сверяет его с
# моделью, поэтому новая колонка в модели не сможет остаться без миграции.
TRANSACTION_COLUMNS = [
    ("is_paid", "BOOLEAN NOT NULL DEFAULT TRUE"),
    ("recurring_expense_id", "INTEGER"),
]


async def sync_transactions_schema(conn) -> None:
    for column, ddl_type in TRANSACTION_COLUMNS:
        await ensure_column(conn, "transactions", column, ddl_type)
    await ensure_index(conn, "ix_transactions_is_paid", "transactions", "is_paid")
    await ensure_index(conn, "ix_transactions_recurring_expense_id",
                       "transactions", "recurring_expense_id")


async def sync_users_schema(conn) -> None:
    """SEC-02 (аудит stage8): догоняющая миграция users.token_version.

    Колонка нужна механизму мгновенного отзыва access-токенов (см. deps.py).
    На свежей базе её создаст alembic/create_all; на существующей (dev без
    alembic) — этот блок. Тот же паттерн «сначала ищем, потом добавляем»,
    что и у transactions/recurring_expenses — работает на PG и SQLite.
    """
    await ensure_column(conn, "users", "token_version", "INTEGER NOT NULL DEFAULT 0")


RECURRING_EXPENSE_COLUMNS = [
    ("legacy_ref", "VARCHAR(40)"),
]


async def sync_recurring_expenses_schema(conn) -> None:
    for column, ddl_type in RECURRING_EXPENSE_COLUMNS:
        await ensure_column(conn, "recurring_expenses", column, ddl_type)
    await ensure_index(conn, "ix_recurring_expenses_legacy_ref", "recurring_expenses", "legacy_ref")
