"""Проверки FC-008: уникальность курсов на уровне базы.

Запуск без PostgreSQL (нужны стандартная библиотека, SQLAlchemy и alembic):

    cd backend && python3 tests/test_fx_rates_unique.py

ПОЧЕМУ ЗДЕСЬ SQLITE. Проверяем не сервер, а ЛОГИКУ миграции:

  • дедупликацию — это DELETE, который в миграции удаляет данные, и ошибиться в
    нём (например, снести курсы разных компаний за одну дату) стоит дорого;
  • сами частичные индексы — что их предикаты реально запрещают дубль в своей
    ветке и НЕ мешают другой ветке.

Логика миграции написана переносимо (`NOT IN (SELECT MAX(id) …)` вместо
`DELETE … USING`), поэтому её можно выполнить на SQLite и убедиться в результате.
Заявление «на PostgreSQL будет то же самое» подтверждается отдельно: индексы из
модели компилируются в диалект PostgreSQL с теми же предикатами.
"""
import importlib.util
import os
import sys
import unittest

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# `app` лежит в корне backend — как в остальных тестах проекта.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/db")


# ── Загрузка модуля миграции (имя файла начинается с цифры — импортом не берётся)
def _load_migration():
    path = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions",
                        "0005_fx_rates_partial_unique.py")
    spec = importlib.util.spec_from_file_location("migration_0005", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MIGRATION = _load_migration()


class DedupeSQL(unittest.TestCase):
    """Дедупликация оставляет одну строку на ключ — и именно последнюю."""

    def setUp(self):
        self.engine = sa.create_engine("sqlite://")
        with self.engine.begin() as conn:
            conn.execute(sa.text("""
                CREATE TABLE fx_rates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    company_id INTEGER,
                    currency TEXT NOT NULL,
                    rate_date DATE NOT NULL,
                    rate_to_eur NUMERIC(18, 8) NOT NULL,
                    source TEXT
                )
            """))
            rows = [
                # (company_id, currency, rate_date, rate, source)
                # ── глобальные дубли (ECB): NULL не равен NULL в UNIQUE ──
                (None, "PLN", "2026-09-25", "0.23000000", "ECB"),
                (None, "PLN", "2026-09-25", "0.23500000", "ECB"),   # ← последняя
                (None, "USD", "2026-09-25", "0.91000000", "ECB"),
                # ── дубли внутри одной компании ──
                (1, "BYN", "2026-09-10", "0.27000000", "manual"),
                (1, "BYN", "2026-09-10", "0.29000000", "manual"),    # ← последняя
                # ── та же валюта и дата, но ДРУГАЯ компания: удалять нельзя ──
                (2, "BYN", "2026-09-10", "0.31000000", "manual"),
                # ── строки без дублей: должны остаться как есть ──
                (None, "CZK", "2026-09-24", "0.04000000", "ECB"),
                (1, "BYN", "2026-09-11", "0.29000000", "manual"),
            ]
            for cid, cur, d, rate, src in rows:
                conn.execute(sa.text(
                    "INSERT INTO fx_rates (company_id, currency, rate_date, rate_to_eur, source) "
                    "VALUES (:c, :cur, :d, :r, :s)"),
                    {"c": cid, "cur": cur, "d": d, "r": rate, "s": src})

    def _run_dedupe(self):
        with self.engine.begin() as conn:
            for stmt in MIGRATION.DEDUPE_SQL:
                conn.execute(sa.text(stmt))

    def _rows(self):
        with self.engine.connect() as conn:
            return conn.execute(sa.text(
                "SELECT id, company_id, currency, rate_date, rate_to_eur "
                "FROM fx_rates ORDER BY id")).all()

    def test_global_duplicates_collapse_to_one_row(self):
        self._run_dedupe()
        pol = [r for r in self._rows() if r[1] is None and r[2] == "PLN"]
        self.assertEqual(len(pol), 1, "глобальный дубль PLN не схлопнулся")
        self.assertAlmostEqual(float(pol[0][4]), 0.235,
                               msg="оставлена не последняя (самая свежая) строка")

    def test_company_duplicates_collapse_to_one_row(self):
        self._run_dedupe()
        byn = [r for r in self._rows() if r[1] == 1 and r[2] == "BYN" and str(r[3]) == "2026-09-10"]
        self.assertEqual(len(byn), 1, "дубль компании не схлопнулся")
        self.assertAlmostEqual(float(byn[0][4]), 0.29,
                               msg="оставлена не последняя строка")

    def test_other_company_keeps_its_rate(self):
        """Одинаковые валюта и дата у РАЗНЫХ компаний — это не дубль."""
        self._run_dedupe()
        other = [r for r in self._rows() if r[1] == 2 and r[2] == "BYN"]
        self.assertEqual(len(other), 1)
        self.assertAlmostEqual(float(other[0][4]), 0.31,
                               msg="курс второй компании пострадал")

    def test_unique_rows_are_untouched(self):
        self._run_dedupe()
        rows = self._rows()
        # 8 строк в setUp, из них 2 дубля (глобальный PLN и BYN компании 1)
        self.assertEqual(len(rows), 6, f"ожидалось 6 строк после дедупликации, получено {len(rows)}")
        kept = {(r[1], r[2], str(r[3])) for r in rows}
        for expected in [(None, "USD", "2026-09-25"), (None, "CZK", "2026-09-24"),
                         (1, "BYN", "2026-09-11"), (1, "BYN", "2026-09-10"),
                         (2, "BYN", "2026-09-10")]:
            self.assertIn(expected, kept, f"пропала строка {expected}")

    def test_dedupe_is_idempotent(self):
        self._run_dedupe()
        before = self._rows()
        self._run_dedupe()
        self.assertEqual(before, self._rows(), "повторный прогон что-то изменил")


class PartialIndexes(unittest.TestCase):
    """Частичные индексы действительно запрещают дубль — и в нужной ветке."""

    def setUp(self):
        self.engine = sa.create_engine("sqlite://")
        with self.engine.begin() as conn:
            conn.execute(sa.text("""
                CREATE TABLE fx_rates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    company_id INTEGER,
                    currency TEXT NOT NULL,
                    rate_date DATE NOT NULL,
                    rate_to_eur NUMERIC(18, 8) NOT NULL,
                    source TEXT
                )
            """))
            for name, cols, where in MIGRATION.INDEX_SPECS:
                conn.execute(sa.text(
                    f"CREATE UNIQUE INDEX {name} ON fx_rates ({', '.join(cols)}) WHERE {where}"))

    def _insert(self, company_id, currency, rate_date, rate="0.29000000"):
        with self.engine.begin() as conn:
            conn.execute(sa.text(
                "INSERT INTO fx_rates (company_id, currency, rate_date, rate_to_eur) "
                "VALUES (:c, :cur, :d, :r)"),
                {"c": company_id, "cur": currency, "d": rate_date, "r": rate})

    def test_second_global_row_for_same_day_is_rejected(self):
        self._insert(None, "PLN", "2026-09-25")
        with self.assertRaises(sa.exc.IntegrityError):
            self._insert(None, "PLN", "2026-09-25")

    def test_second_company_row_for_same_day_is_rejected(self):
        self._insert(1, "BYN", "2026-09-10")
        with self.assertRaises(sa.exc.IntegrityError):
            self._insert(1, "BYN", "2026-09-10")

    def test_two_companies_may_share_currency_and_date(self):
        self._insert(1, "BYN", "2026-09-10")
        self._insert(2, "BYN", "2026-09-10")   # не должно бросить

    def test_company_rate_does_not_conflict_with_global_one(self):
        """Ручной курс компании обязан сосуществовать с курсом ЕЦБ (Issue #11)."""
        self._insert(None, "PLN", "2026-09-25")
        self._insert(1, "PLN", "2026-09-25")   # не должно бросить


class ModelDeclaresTheSameRules(unittest.TestCase):
    """Модель объявляет те же правила (иначе create_all даст другую схему)."""

    def test_indexes_compile_to_postgres_with_predicates(self):
        from app.models.models import FxRate
        ddl = []
        for index in FxRate.__table__.indexes:
            if not index.unique:
                continue
            ddl.append(str(sa.schema.CreateIndex(index).compile(
                dialect=postgresql.dialect())))
        text = "\n".join(ddl)
        self.assertIn("UNIQUE INDEX uq_fx_rates_global_currency_date", text)
        self.assertIn("WHERE company_id IS NULL", text)
        self.assertIn("UNIQUE INDEX uq_fx_rates_company_currency_date_partial", text)
        self.assertIn("WHERE company_id IS NOT NULL", text)

    def test_model_no_longer_has_the_null_blind_constraint(self):
        """UNIQUE(company_id, currency, rate_date) для NULL-строк бесполезен."""
        import io
        path = os.path.join(os.path.dirname(__file__), "..", "app", "models", "models.py")
        src = io.open(path, encoding="utf-8").read()
        self.assertNotIn('UniqueConstraint("company_id", "currency", "rate_date"', src)
        self.assertIn("text,", src, "в модели нет импорта text для предикатов")

    def test_migration_names_match_the_model(self):
        from app.models.models import FxRate
        model_names = {i.name for i in FxRate.__table__.indexes if i.unique}
        migration_names = {name for name, _c, _w in MIGRATION.INDEX_SPECS}
        self.assertEqual(model_names, migration_names,
                         "имена индексов в модели и в миграции разошлись")
        self.assertEqual(MIGRATION.LEGACY_CONSTRAINT,
                         "uq_fx_rates_company_currency_date")


if __name__ == "__main__":
    unittest.main(verbosity=2)
