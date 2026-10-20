"""Модель и база не должны расходиться.

Поводом послужил реальный сбой: колонки `is_paid` и `recurring_expense_id`
появились в модели, но миграции писались через `ADD COLUMN IF NOT EXISTS` —
синтаксис, которого нет в SQLite. Там оператор падал, `except` писал только
предупреждение, и колонки не появлялись. Любой запрос к `transactions` начинал
падать с «no such column»: страницы показывали пустые списки («Нет данных за
период»), а синхронизация отвечала 500.

Тесты ниже закрывают ровно этот класс ошибок:
1. любая колонка модели либо есть в исходной схеме, либо зарегистрирована как
   догоняющая — забыть миграцию для новой колонки больше нельзя;
2. на «старой» таблице догоняющая миграция действительно добавляет недостающее,
   и запрос через ORM после неё проходит.
"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["ENVIRONMENT"] = "development"
os.environ["SECRET_KEY"] = "test-secret-key-0123456789abcdef"

from sqlalchemy import select, text
from sqlalchemy.dialects import sqlite as sqlite_dialect
from sqlalchemy.schema import CreateTable
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core import schema_sync
from app.core.database import Base
from app.models.models import Transaction


# Колонки таблицы transactions в ИСХОДНОЙ схеме (до появления is_paid и
# recurring_expense_id). Список заморожен намеренно: если выводить его из модели
# или из schema_sync.TRANSACTION_COLUMNS, тест станет пустым — он будет проверять
# ровно то, что сам же и построил. Именно так первая версия этого теста пропускала
# ошибку. Обновлять список не нужно: он описывает прошлое.
LEGACY_COLUMNS = (
    "id", "company_id", "vehicle_id", "source", "external_id",
    "credential_id", "source_account", "transaction_date", "card_number",
    "card_shortname", "plate_number", "trailer_plate", "driver_name",
    "country", "station_id", "station_address", "station_region", "price",
    "volume", "amount", "currency", "fx_rate", "amount_eur", "fx_rate_date",
    "fx_source", "service_category", "fuel_type", "category_code",
    "category_id", "expense_type", "periodicity", "comment", "document_ref",
    "is_confirmed", "e100_mobility", "inserted_at_source", "created_at",
)


async def _create_legacy_transactions(conn) -> None:
    """Пересоздать transactions в том виде, в каком она была до 0013.

    Типы намеренно простые: проверяется НАЛИЧИЕ колонки, а не её тип, поэтому
    достаточно, чтобы ORM-запрос не падал. `id` — первичный ключ, иначе ORM не
    сможет собрать строку.
    """
    cols = []
    for name in LEGACY_COLUMNS:
        if name == "id":
            cols.append("id INTEGER PRIMARY KEY")
        else:
            cols.append(f"{name} TEXT")
    await conn.execute(text("DROP TABLE transactions"))
    await conn.execute(text(f"CREATE TABLE transactions ({', '.join(cols)})"))


class SchemaSyncSuite(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine(os.environ["DATABASE_URL"])
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()
        # Общий файл БД прогона (conftest) не удаляем.

    async def test_01_every_model_column_is_covered(self):
        """Новая колонка модели обязана быть в списке догоняющих миграций."""
        model_cols = {c.name for c in Transaction.__table__.columns}
        async with self.engine.connect() as conn:
            # схема, созданная create_all, знает все колонки — но это схема С НУЛЯ.
            # Сравниваем модель со «старой» таблицей: всё, чего там нет, должно быть
            # зарегистрировано в schema_sync.TRANSACTION_COLUMNS.
            await _create_legacy_transactions(conn)
            legacy_cols = await schema_sync.table_columns(conn, "transactions")

        registered = {c for c, _ in schema_sync.TRANSACTION_COLUMNS}
        self.assertEqual(set(LEGACY_COLUMNS), legacy_cols,
                         "«Старая» таблица собрана не по замороженному списку")
        unregistered = model_cols - set(LEGACY_COLUMNS) - registered
        self.assertEqual(
            unregistered, set(),
            f"Колонки модели без догоняющей миграции: {sorted(unregistered)}. "
            "Добавьте их в schema_sync.TRANSACTION_COLUMNS, иначе на существующей "
            "базе запросы будут падать с «no such column».")

        stale = registered - (model_cols - set(LEGACY_COLUMNS))
        self.assertEqual(stale, set(),
                         f"В TRANSACTION_COLUMNS есть лишнее: {sorted(stale)}")

    async def test_02_migration_adds_missing_and_query_works(self):
        """Догоняющая миграция добавляет колонки, после чего ORM-запрос проходит."""
        async with self.engine.begin() as conn:
            await _create_legacy_transactions(conn)
            before = await schema_sync.table_columns(conn, "transactions")
            await schema_sync.sync_transactions_schema(conn)
            after = await schema_sync.table_columns(conn, "transactions")

        for column, _ in schema_sync.TRANSACTION_COLUMNS:
            self.assertNotIn(column, before, f"{column} не должна быть в старой таблице")
            self.assertIn(column, after, f"{column} обязана появиться после миграции")

        # Главное: запрос через ORM, который до миграции падал с «no such column».
        async with self.Session() as db:
            rows = (await db.execute(select(Transaction).limit(5))).scalars().all()
        self.assertEqual(rows, [])

    async def test_03_migration_is_idempotent(self):
        """Повторный запуск не ломается и ничего не дублирует."""
        async with self.engine.begin() as conn:
            await _create_legacy_transactions(conn)
            await schema_sync.sync_transactions_schema(conn)
            first = await schema_sync.table_columns(conn, "transactions")
            await schema_sync.sync_transactions_schema(conn)   # второй раз
            await schema_sync.sync_transactions_schema(conn)   # и третий
            second = await schema_sync.table_columns(conn, "transactions")
        self.assertEqual(first, second)

    async def test_04_ensure_column_on_missing_table_is_silent(self):
        """Таблицы ещё нет (первый запуск) — миграция не должна падать."""
        async with self.engine.begin() as conn:
            added = await schema_sync.ensure_column(
                conn, "no_such_table", "col", "INTEGER")
        self.assertFalse(added)


class RouteContractSuite(unittest.TestCase):
    """Мелкие, но реальные дефекты в роуте транзакций.

    Оба нашлись при разборе «пустых списков»: один давал 500 вместо 404, второй
    молча игнорировал параметр запроса.
    """

    def test_debug_income_has_httpexception_imported(self):
        """B1: HTTPException использовался, но не был импортирован.

        Ветка «вернуть 404» выполнялась `raise HTTPException(...)` без имени в
        модуле — в production это NameError, то есть 500 вместо честного 404.
        """
        from app.api.routes import transactions
        self.assertTrue(hasattr(transactions, "HTTPException"),
                        "HTTPException обязан быть импортирован в роуте транзакций")

    def test_confirmed_only_parameter_is_honored(self):
        """P3: параметр confirmed_only объявлен и обязан влиять на запрос.

        Раньше в список жёстко передавалось False, и `?confirmed_only=true`
        возвращал неподтверждённые строки — API противоречил своему описанию.
        Проверяем на компиляции для PostgreSQL: `AT TIME ZONE` в этом фильтре
        недоступен в SQLite (см. комментарий в date_filter).
        """
        from datetime import date
        from sqlalchemy import select
        from sqlalchemy.dialects import postgresql
        from app.api.routes.transactions import date_filter
        from app.models.models import Transaction

        dialect = postgresql.dialect()
        # Смотрим ТОЛЬКО условие: в списке выбираемых колонок is_confirmed есть
        # всегда, поэтому по полному SQL такую проверку не сделать.
        only_confirmed = str(date_filter(date(2026, 9, 1), date(2026, 9, 30), 1,
                                         confirmed_only=True).compile(dialect=dialect))
        self.assertIn("is_confirmed", only_confirmed)

        all_rows = str(date_filter(date(2026, 9, 1), date(2026, 9, 30), 1,
                                   confirmed_only=False).compile(dialect=dialect))
        self.assertNotIn("is_confirmed", all_rows)


if __name__ == "__main__":
    unittest.main(verbosity=2)
