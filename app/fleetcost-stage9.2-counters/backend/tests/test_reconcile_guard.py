"""Проверки охраны вокруг destructive-сверки периодов (FC-002).

Запуск (нужны зависимости backend — sqlalchemy и прочее):

    cd backend && python3 tests/test_reconcile_guard.py

Суть: сверка месяца сравнивает ПОЛНЫЙ агрегат e100 с тем, что успели получить,
и при расхождении удаляет все сохранённые строки месяца. Если загрузка была
неполной (не пустил в систему один из credential, упал на середине), такое
сравнение удалило бы корректные операции — это и была тихая потеря данных,
описанная в аудите как FC-002.

Здесь проверяется, что при переданных причинах неполноты функция выходит
сразу и НЕ обращается к базе. «База» — объект-ловушка: любое обращение к нему
означает, что охрана не сработала.
"""
import asyncio
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.scraper.service import reconcile_period  # noqa: E402


class PoisonDb:
    """Любое обращение к «БД» — провал проверки, а не ошибка окружения."""

    def __getattr__(self, name):
        raise AssertionError(
            f"reconcile_period обратился к базе ({name}) при неполной загрузке"
        )


class ReconcileGuardTest(unittest.TestCase):
    def test_skips_and_returns_reasons(self):
        """При неполной загрузке сверка не выполняется и возвращает причины."""
        reasons = ["credential #2: login failed", "credential #7: HTTPError"]
        result = asyncio.run(reconcile_period(
            PoisonDb(), 1, date(2026, 9, 1), date(2026, 9, 30), [],
            incomplete_reasons=reasons,
        ))
        self.assertEqual(result["months_rewritten"], [])
        self.assertEqual(result["months_checked"], 0)
        self.assertEqual(result["skipped_incomplete"], reasons)

    def test_empty_reasons_keeps_old_behaviour(self):
        """Пустой список причин не мешает обычной работе (обратная совместимость)."""
        result = asyncio.run(reconcile_period(
            PoisonDb(), 1, date(2026, 9, 1), date(2026, 9, 30), [],
            incomplete_reasons=[],
        ))
        self.assertEqual(result["months_checked"], 0)
        self.assertNotIn("skipped_incomplete", result)

    def test_reasons_default_is_absent(self):
        """Аргумент необязателен: старые вызовы без него работают как раньше."""
        result = asyncio.run(reconcile_period(
            PoisonDb(), 1, date(2026, 9, 1), date(2026, 9, 30), [],
        ))
        self.assertNotIn("skipped_incomplete", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
