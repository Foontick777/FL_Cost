"""Проверки правил исторического импорта курсов (app/services/fx_history.py).

Запуск без pytest и без базы (нужна только стандартная библиотека):

    cd backend && python3 tests/test_fx_history.py

Здесь закреплены два реальных сбоя этого импорта:

1. «All 442 batches failed» при СУЩЕСТВУЮЩЕЙ таблице `fx_rates`. Причина — даты
   подставлялись в параметр DATE строками, а драйвер `postgresql+asyncpg`
   строго типизирован и строку не принимает: падал каждый батч. Сообщение при
   этом отправляло применять миграции, потому что «ни один батч не прошёл»
   трактовалось как «таблицы нет».
2. Догадка вместо факта в тексте ошибки (см. `TestSummarizeBatchFailures`).
"""
import os
import sys
import unittest
from datetime import date, timedelta
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services import fx_history as fr  # noqa: E402


class TestBuildItems(unittest.TestCase):
    """Форма данных для записи: даты обязаны быть объектами date."""

    def test_dates_are_date_objects_not_strings(self):
        items = fr.build_items({"1999-01-04": {"USD": Decimal("0.92")}})
        self.assertEqual(len(items), 1)
        d_obj, cur, rate = items[0]
        self.assertIsInstance(d_obj, date)
        self.assertNotIsInstance(d_obj, str)
        self.assertEqual(cur, "USD")
        self.assertEqual(rate, Decimal("0.92"))

    def test_flattens_every_date_and_currency(self):
        items = fr.build_items({"2026-01-02": {"USD": 1, "PLN": 2},
                                "2026-01-03": {"USD": 3}})
        self.assertEqual(len(items), 3)
        self.assertEqual(sorted({i[0].isoformat() for i in items}),
                         ["2026-01-02", "2026-01-03"])

    def test_empty_input_gives_nothing(self):
        self.assertEqual(fr.build_items({}), [])

    def test_guard_rejects_string_dates_loudly(self):
        # Страховка обязана падать громко: молчаливый сбой здесь стоит дороже.
        with self.assertRaises(TypeError):
            fr.assert_items_are_typed([("1999-01-04", "USD", Decimal("0.92"))])

    def test_guard_accepts_proper_items(self):
        fr.assert_items_are_typed(fr.build_items({"1999-01-04": {"USD": Decimal("0.92")}}))


class TestNormalizeBulkDates(unittest.TestCase):
    """Подготовка дат для массового ввода курса (одно значение на много дат)."""

    def test_deduplicates_and_sorts(self):
        dates, dropped = fr.normalize_bulk_dates([date(2026, 9, 7), date(2026, 8, 14),
                                                  date(2026, 8, 14)])
        self.assertEqual(dates, [date(2026, 8, 14), date(2026, 9, 7)])
        self.assertEqual(dropped, 0)

    def test_none_entries_are_ignored(self):
        dates, _ = fr.normalize_bulk_dates([date(2026, 8, 14), None])
        self.assertEqual(dates, [date(2026, 8, 14)])

    def test_empty_input(self):
        self.assertEqual(fr.normalize_bulk_dates([]), ([], 0))

    def test_limit_is_reported_not_silently_swallowed(self):
        raw = [date(2026, 1, 1) + timedelta(days=i) for i in range(12)]
        dates, dropped = fr.normalize_bulk_dates(raw, max_dates=10)
        self.assertEqual(len(dates), 10)
        self.assertEqual(dropped, 2)      # пользователю скажем, что часть не применена

    def test_exactly_at_limit_drops_nothing(self):
        raw = [date(2026, 1, 1) + timedelta(days=i) for i in range(10)]
        dates, dropped = fr.normalize_bulk_dates(raw, max_dates=10)
        self.assertEqual(len(dates), 10)
        self.assertEqual(dropped, 0)


class TestAbortEarly(unittest.TestCase):

    def test_aborts_when_nothing_succeeds(self):
        self.assertTrue(fr.should_abort_early(0, 3))
        self.assertTrue(fr.should_abort_early(0, 100))

    def test_does_not_abort_before_the_limit(self):
        self.assertFalse(fr.should_abort_early(0, 2))

    def test_does_not_abort_while_something_succeeds(self):
        """Если часть батчей пишется, причина может быть в конкретных данных."""
        self.assertFalse(fr.should_abort_early(1, 50))
        self.assertFalse(fr.should_abort_early(200, 3))


class TestDiagnosticsText(unittest.TestCase):

    def test_existing_table_reports_counts(self):
        text = fr.format_diagnostics({"table_exists": True, "rows": 217000, "global_rows": 217000})
        self.assertIn("fx_rates есть", text)
        self.assertIn("217000", text)
        self.assertNotIn("НЕТ", text)

    def test_missing_table_says_so_and_names_the_migration(self):
        text = fr.format_diagnostics({"table_exists": False})
        self.assertIn("НЕТ", text)
        self.assertIn("alembic upgrade head", text)

    def test_unknown_table_is_admitted_not_guessed(self):
        text = fr.format_diagnostics({"table_exists": None})
        self.assertIn("не удалось", text)

    def test_missing_company_id_and_revision_are_reported(self):
        text = fr.format_diagnostics(
            {"table_exists": True, "has_company_id": False, "alembic_version_missing": True})
        self.assertIn("company_id", text)
        self.assertIn("alembic_version", text)

    def test_no_diagnostics_gives_no_text(self):
        # Нет данных — нет и текста: пустая формулировка «Проверка схемы: .»
        # в ответе пользователю выглядела бы как незаполненный шаблон.
        self.assertEqual(fr.format_diagnostics(None), "")
        self.assertEqual(fr.format_diagnostics({}), "")
        # А вот «проверить не удалось» — уже факт, его надо сказать.
        self.assertIn("не удалось", fr.format_diagnostics({"table_exists": None}))


class TestSummarizeBatchFailures(unittest.TestCase):

    def _msg(self, **kw):
        base = dict(batches_ok=0, batches_failed=442, total_items=221000,
                    first_error="DataError: invalid input for query argument $1: "
                                "'1999-01-04' (expected a datetime.date, got 'str')")
        base.update(kw)
        return fr.summarize_batch_failures(**base)

    def test_shows_the_real_database_error(self):
        """Текст ошибки базы обязан попадать в ответ, а не только в логи."""
        self.assertIn("expected a datetime.date", self._msg())

    def test_regression_does_not_blame_a_missing_table_when_it_exists(self):
        """РЕГРЕССИЯ: раньше при существующей таблице всё равно отправляли к миграциям."""
        text = self._msg(diagnostics={"table_exists": True, "rows": 215000, "global_rows": 215000})
        self.assertNotIn("таблицы нет", text.lower())
        self.assertNotIn("Run `alembic upgrade head`", text)
        self.assertNotIn("Что делать: выполнить", text)
        self.assertIn("fx_rates есть", text)
        self.assertIn("Historical FX batch", text)

    def test_points_to_migrations_only_when_the_table_is_really_absent(self):
        text = self._msg(first_error='ProgrammingError: relation "fx_rates" does not exist',
                         diagnostics={"table_exists": False})
        self.assertIn("Что делать: выполнить `alembic upgrade head`", text)

    def test_marks_early_abort_as_planned_not_as_lost_work(self):
        self.assertIn("это не потеря работы", self._msg(aborted_early=True))

    def test_says_retry_is_safe(self):
        self.assertIn("не создаёт дубликатов", self._msg())

    def test_partial_success_is_reported_as_partial(self):
        text = self._msg(batches_ok=400, batches_failed=42)
        self.assertIn("Записалось 400", text)
        self.assertIn("не записалось 42", text)

    def test_missing_error_text_is_admitted(self):
        text = self._msg(first_error=None, diagnostics={"table_exists": True})
        self.assertIn("текст не получен", text)


class TestSummarizePartial(unittest.TestCase):

    def test_partial_is_not_presented_as_full_success(self):
        text = fr.summarize_partial(batches_ok=400, batches_failed=42,
                                    first_error="OperationalError: statement timeout")
        self.assertIn("не полностью", text)
        self.assertIn("400", text)
        self.assertIn("42", text)
        self.assertIn("statement timeout", text)
        self.assertIn("продолжит", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
