"""Проверки политики обхода очереди «без amount_eur» (app/services/backfill_plan.py).

Запуск без pytest и без базы (нужна только стандартная библиотека):

    cd backend && python3 tests/test_backfill_plan.py

Главная проверка здесь — воспроизведение реального сбоя: источник батчей
повторяет одни и те же 500 строк, не двигая курсор. Прежний код в этом случае
шёл до таймаута nginx (в логах — «backfill batch 268: 0 ok, 0 failed, 500
without rate» и так далее), потому что исключались только строки, бросившие
исключение, а не строки без курса. Теперь обход обязан остановиться сразу.
"""
import asyncio
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services import backfill_plan as bp  # noqa: E402


class Queue:
    """Очередь строк с корректным курсором: строки с id > after_id."""

    def __init__(self, rows):
        # rows: [(id, convertible, currency, rate_date)]
        self.rows = sorted(rows, key=lambda r: r[0])
        self.calls = 0

    async def __call__(self, after_id, limit):
        self.calls += 1
        sel = [r for r in self.rows if after_id is None or r[0] > after_id][:limit]
        out = []
        for rid, ok, cur, d in sel:
            if ok == "raise":
                raise RuntimeError("boom")  # обработчик ловит и считает failed
            status = bp.OK if ok is True else (bp.INVALID if ok == "invalid" else bp.NO_RATE)
            out.append((rid, status, cur, d))
        return out


class FailingHandlerQueue(Queue):
    """Как Queue, но исключение бросает сам обработчик, а не подготовка строки."""

    def __init__(self, rows, fail_ids):
        super().__init__(rows)
        self.fail_ids = set(fail_ids)

    async def __call__(self, after_id, limit):
        rows = await super().__call__(after_id, limit)
        if not rows:
            return rows
        # эмулируем падение: строку помечаем как failed на стороне вызывающего
        return [(rid, bp.FAILED if rid in self.fail_ids else st, cur, d)
                for rid, st, cur, d in rows]


class StuckQueue:
    """Повторяет ОДИН И ТОТ ЖЕ батч, не двигая курсор — воспроизведение сбоя."""

    def __init__(self, n=500, currency="RSD"):
        self.n = n
        self.currency = currency
        self.calls = 0

    async def __call__(self, after_id, limit):
        self.calls += 1
        cnt = min(self.n, limit)
        return [(i + 1, bp.NO_RATE, self.currency, date(2026, 1, 1)) for i in range(cnt)]


def run(coro):
    return asyncio.run(coro)


class TestDrainBatches(unittest.TestCase):

    def test_all_convertible(self):
        q = Queue([(i, True, "PLN", date(2026, 1, 1)) for i in range(1, 1201)])
        r = run(bp.drain_batches(q, batch_size=500))
        self.assertEqual(r["backfilled"], 1200)
        self.assertEqual(r["no_rate_rows"], 0)
        self.assertFalse(r["truncated"])
        self.assertEqual(r["truncated_reason"], None)
        # 1200 строк / 500 → 3 батча (третий короче batch_size, на нём и остановка)
        self.assertEqual(r["batches_processed"], 3)

    def test_rows_without_rate_are_left_alone_and_reported(self):
        """Строки без курса не должны мешать пройти очередь до конца."""
        rows = []
        for i in range(1, 1001):
            if i % 2 == 0:
                rows.append((i, False, "RSD", date(2026, 2, 10)))   # курса нет
            else:
                rows.append((i, True, "PLN", date(2026, 1, 1)))     # переводится
        r = run(bp.drain_batches(Queue(rows), batch_size=500))
        self.assertEqual(r["backfilled"], 500)
        self.assertEqual(r["no_rate_rows"], 500)
        self.assertEqual(r["no_rate_currencies"], ["RSD"])
        self.assertEqual(r["no_rate_period"], {"from": "2026-02-10", "to": "2026-02-10"})
        self.assertFalse(r["truncated"])

    def test_regression_same_batch_repeated_forever_stops_immediately(self):
        """РЕГРЕССИЯ: «backfill batch 268: 0 ok, 0 failed, 500 without rate».

        Источник не двигает курсор. Прежний код крутился до таймаута nginx и
        отдавал 502. Теперь цикл обязан остановиться, сказать об этом и не
        сделать больше пары обращений.
        """
        q = StuckQueue(n=500)
        r = run(bp.drain_batches(q, batch_size=500, time_budget_seconds=None))
        self.assertTrue(r["truncated"])
        self.assertEqual(r["truncated_reason"], "no_progress")
        self.assertLessEqual(q.calls, 3, "цикл должен остановиться сразу, а не молотить")
        self.assertEqual(r["no_rate_rows"], 500)
        self.assertEqual(r["no_rate_currencies"], ["RSD"])

    def test_exceptions_counted_as_failed_and_queue_still_drains(self):
        q = FailingHandlerQueue([(i, True, "PLN", date(2026, 1, 1)) for i in range(1, 601)],
                                fail_ids={2, 5})
        r = run(bp.drain_batches(q, batch_size=500))
        self.assertEqual(r["failed"], 2)
        self.assertEqual(r["backfilled"], 598)
        self.assertFalse(r["truncated"])

    def test_invalid_rows_are_not_reported_as_missing_rate(self):
        """Нет суммы/валюты/даты — это не «нет курса», и подсказки разные."""
        q = Queue([(1, "invalid", None, None), (2, False, "RSD", date(2026, 3, 1))])
        r = run(bp.drain_batches(q, batch_size=500))
        self.assertEqual(r["invalid_rows"], 1)
        self.assertEqual(r["no_rate_rows"], 1)
        self.assertEqual(r["no_rate_currencies"], ["RSD"])

    def test_max_batches_is_a_backstop(self):
        q = Queue([(i, True, "PLN", date(2026, 1, 1)) for i in range(1, 5001)])
        r = run(bp.drain_batches(q, batch_size=100, max_batches=3, time_budget_seconds=None))
        self.assertTrue(r["truncated"])
        self.assertEqual(r["truncated_reason"], "max_batches")
        self.assertEqual(r["batches_processed"], 3)
        self.assertEqual(r["backfilled"], 300)

    def test_time_budget_is_a_backstop(self):
        """Ответ должен успеть вернуться раньше proxy_read_timeout=120s у nginx."""
        ticks = {"t": 0.0}

        def clock():
            ticks["t"] += 10.0
            return ticks["t"]

        q = Queue([(i, True, "PLN", date(2026, 1, 1)) for i in range(1, 20001)])
        r = run(bp.drain_batches(q, batch_size=100, time_budget_seconds=25.0, monotonic=clock))
        self.assertTrue(r["truncated"])
        self.assertEqual(r["truncated_reason"], "time_budget")

    def test_empty_queue_finishes_without_work(self):
        q = Queue([])
        r = run(bp.drain_batches(q))
        self.assertEqual(r["batches_processed"], 0)
        self.assertFalse(r["truncated"])
        self.assertEqual(r["backfilled"], 0)


class TestMinimalRateDates(unittest.TestCase):
    """Сколько ручных курсов реально нужно.

    Курс действует на свою дату и 14 дней вперёд (см. get_rate), поэтому одна
    запись покрывает окно, а не один день. Без этого пользователь вводит курс на
    сегодняшнюю дату, видит его в списке и не понимает, почему пересчёт старых
    транзакций снова сообщает «без курса».
    """

    def test_single_rate_covers_a_short_window(self):
        # Реальный случай: транзакции за 08–11 июня, курс вводился на 24 сентября.
        self.assertEqual(
            bp.minimal_rate_dates([date(2026, 6, 8), date(2026, 6, 9),
                                   date(2026, 6, 10), date(2026, 6, 11)]),
            [date(2026, 6, 8)])

    def test_long_gap_needs_more_than_one_rate(self):
        self.assertEqual(
            bp.minimal_rate_dates([date(2026, 1, 1), date(2026, 2, 1)]),
            [date(2026, 1, 1), date(2026, 2, 1)])

    def test_boundary_of_the_lookback_window(self):
        # Ровно 14 дней — ещё покрывается, 15 — уже нет.
        self.assertEqual(bp.minimal_rate_dates([date(2026, 1, 1), date(2026, 1, 15)]),
                         [date(2026, 1, 1)])
        self.assertEqual(bp.minimal_rate_dates([date(2026, 1, 1), date(2026, 1, 16)]),
                         [date(2026, 1, 1), date(2026, 1, 16)])

    def test_duplicates_and_disorder_are_handled(self):
        self.assertEqual(bp.minimal_rate_dates([date(2026, 6, 11), date(2026, 6, 8),
                                                date(2026, 6, 8)]), [date(2026, 6, 8)])

    def test_empty_input(self):
        self.assertEqual(bp.minimal_rate_dates([]), [])


class TestUnratedDetail(unittest.TestCase):

    def _detail(self):
        return bp.build_unrated_detail({"BYN": {"rows": 12, "dates": {
            date(2026, 6, 8), date(2026, 6, 9), date(2026, 6, 10), date(2026, 6, 11)},
            "truncated": False}})

    def test_names_the_date_to_enter(self):
        d = self._detail()[0]
        self.assertEqual(d["currency"], "BYN")
        self.assertEqual(d["rows"], 12)
        # Именно самая ранняя дата окна: она покрывает весь отрезок.
        self.assertEqual(d["needed_dates"], ["2026-06-08"])

    def test_advice_says_how_far_it_covers(self):
        self.assertIn("08.06.2026", self._detail()[0]["advice"])
        self.assertIn("22.06.2026", self._detail()[0]["advice"])

    def test_advice_explains_why_todays_rate_did_not_help(self):
        self.assertIn("не покрывает", self._detail()[0]["advice"])

    def test_empty_input_gives_no_rows(self):
        self.assertEqual(bp.build_unrated_detail({}), [])


class TestOperatorHint(unittest.TestCase):

    def test_hint_names_currencies_and_says_why(self):
        text = bp.describe_unrated(["rsd", "UAH"], {"from": "2026-01-01", "to": "2026-02-01"})
        self.assertIn("RSD", text)
        self.assertIn("UAH", text)
        self.assertIn("2026-01-01", text)
        self.assertIn("ЕЦБ", text)          # объясняем причину, а не только факт
        self.assertIn("вручную", text)      # и даём следующий шаг

    def test_hint_includes_the_concrete_date(self):
        detail = bp.build_unrated_detail({"BYN": {"rows": 3, "dates": {date(2026, 6, 8)},
                                                  "truncated": False}})
        text = bp.describe_unrated(["BYN"], {"from": "2026-06-08", "to": "2026-06-08"}, detail)
        self.assertIn("08.06.2026", text)      # конкретная дата, а не только валюта
        self.assertIn("ЕЦБ", text)

    def test_no_hint_when_nothing_is_missing(self):
        self.assertIsNone(bp.describe_unrated([], None))
        self.assertIsNone(bp.describe_unrated([""], None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
