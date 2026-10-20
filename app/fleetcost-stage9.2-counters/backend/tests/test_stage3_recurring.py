"""Регрессия по ревью: согласованность графика, остаток «всего за срок»,
номера прицепов и запуск докачки курсов для приблизительных строк.

    cd backend && python3 -m pytest -q tests/test_stage3_recurring.py
"""
import asyncio
import os
import sys
import unittest
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_stage3.db")
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-stage3-suite")

from app.services import recurring_expense_service as rs  # noqa: E402
from app.services.plates import normalize_trailer_plate  # noqa: E402
from app.services import category_service  # noqa: E402


class PlanScheduleConsistency(unittest.TestCase):
    base = dict(start_date=date(2026, 1, 1), frequency="monthly", day_of_month=1)

    def test_count_and_end_that_disagree_are_rejected(self):
        with self.assertRaises(ValueError):
            rs.plan_schedule(**self.base, input_amount=12000, amount_mode="total",
                             total_periods=12, end_date=date(2026, 6, 30))

    def test_count_and_matching_end_are_accepted(self):
        p = rs.plan_schedule(**self.base, input_amount=12000, amount_mode="total",
                             total_periods=6, end_date=date(2026, 6, 30))
        self.assertEqual(p["total_periods"], 6)
        self.assertEqual(p["amount"], Decimal("2000.00"))

    def test_count_only_derives_end_date(self):
        p = rs.plan_schedule(**self.base, input_amount=12000, amount_mode="total", total_periods=12)
        self.assertEqual(p["end_date"], date(2026, 12, 1))

    def test_end_only_derives_count(self):
        p = rs.plan_schedule(**self.base, input_amount=600, amount_mode="period",
                             end_date=date(2026, 6, 30))
        self.assertEqual(p["total_periods"], 6)

    def test_total_without_term_is_rejected(self):
        with self.assertRaises(ValueError):
            rs.plan_schedule(**self.base, input_amount=1000, amount_mode="total")


class RemainingAmount(unittest.TestCase):
    def _contract(self, paid):
        return SimpleNamespace(amount=Decimal("3333.33"), input_amount=Decimal("10000"),
                               amount_mode="total", total_periods=3, paid_periods=paid,
                               frequency="monthly", down_payment=Decimal("0"))

    def test_remaining_for_whole_term_is_exact(self):
        self.assertEqual(rs.schedule_remaining_amount(self._contract(0), 3), Decimal("10000.00"))

    def test_remaining_after_one_payment(self):
        self.assertEqual(rs.schedule_remaining_amount(self._contract(1), 2), Decimal("6666.67"))

    def test_remaining_zero_when_done(self):
        self.assertEqual(rs.schedule_remaining_amount(self._contract(3), 0), Decimal("0.00"))

    def test_open_ended_has_no_remaining(self):
        self.assertIsNone(rs.schedule_remaining_amount(self._contract(0), None))


class TrailerPlates(unittest.TestCase):
    def test_variants_collapse_to_one_plate(self):
        for raw in ("SW 12345", "sw-12345", "SW12345", " sw.12345 "):
            self.assertEqual(normalize_trailer_plate(raw), "SW12345")

    def test_empty_is_none(self):
        self.assertIsNone(normalize_trailer_plate("  "))
        self.assertIsNone(normalize_trailer_plate(None))


class LeasingScope(unittest.TestCase):
    def test_leasing_section_rejects_trailers(self):
        self.assertFalse(category_service.object_allowed("leasing", False, True))
        self.assertTrue(category_service.object_allowed("leasing", True, False, plate_is_vehicle=True))


class ApproxFx(unittest.TestCase):
    """Строка с EUR по курсу предыдущего дня должна попадать в докачку архива,
    но только если день будний и точного курса в базе нет."""

    CID = 987001

    def _run(self, coro):
        return asyncio.run(coro)

    async def _scenario(self):
        from sqlalchemy import delete
        from app.core.database import engine, Base, AsyncSessionLocal
        from app.models.models import Transaction, FxRate
        from app.services import fx_autoload as fa
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        fa._approx_checked.clear()

        def tx(ext, d, rate_d):
            from datetime import datetime, timezone
            return Transaction(
                company_id=self.CID, source="manual", external_id=ext,
                transaction_date=datetime(d.year, d.month, d.day, tzinfo=timezone.utc),
                amount=Decimal("100"), currency="PLN", amount_eur=Decimal("23"),
                fx_rate=Decimal("0.23"), fx_rate_date=rate_d, fx_source="ecb",
                fuel_type="manual_other_other")
        async with AsyncSessionLocal() as db:
            await db.execute(delete(Transaction).where(Transaction.company_id == self.CID))
            await db.execute(delete(FxRate).where(FxRate.company_id == self.CID))
            # Четверг 15.01.2026 по курсу среды 14.01 (приблизительно, будний день)
            db.add(tx("a1", date(2026, 1, 15), date(2026, 1, 14)))
            # Суббота 17.01.2026 по курсу пятницы — норма, качать нечего
            db.add(tx("a2", date(2026, 1, 17), date(2026, 1, 16)))
            await db.commit()
        try:
            res = await fa.approx_overview(self.CID)
            self.assertEqual(res["dates"], {date(2026, 1, 15)})
            self.assertEqual(res["rows"], 1)
            self.assertEqual(res["currencies"], ["PLN"])
            # Появился точный курс — строка больше не «приблизительная»
            async with AsyncSessionLocal() as db:
                db.add(FxRate(company_id=None, currency="PLN", rate_date=date(2026, 1, 15),
                              rate_to_eur=Decimal("0.2300"), source="ecb"))
                await db.commit()
            res2 = await fa.approx_overview(self.CID)
            self.assertEqual(res2["rows"], 0)
        finally:
            async with AsyncSessionLocal() as db:
                await db.execute(delete(Transaction).where(Transaction.company_id == self.CID))
                await db.execute(delete(FxRate).where(FxRate.currency == "PLN",
                                                      FxRate.rate_date == date(2026, 1, 15)))
                await db.commit()

    def test_weekday_approx_row_is_found_weekend_is_not(self):
        self._run(self._scenario())


class AutoFinishScenario(unittest.TestCase):
    """Весь путь: строка с приблизительным курсом → докачка архива → пересчёт."""

    CID = 987002

    async def _scenario(self):
        from datetime import datetime, timezone
        from unittest import mock
        from sqlalchemy import delete, select
        from app.core.database import engine, Base, AsyncSessionLocal
        from app.models.models import Transaction, FxRate
        from app.services import fx_autoload as fa

        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        fa._approx_checked.clear()

        async with AsyncSessionLocal() as db:
            await db.execute(delete(Transaction).where(Transaction.company_id == self.CID))
            await db.execute(delete(FxRate).where(FxRate.currency == "PLN"))
            # Курс среды 14.01 есть, четверга 15.01 нет: операция 15.01 посчитана по среде.
            db.add(FxRate(company_id=None, currency="PLN", rate_date=date(2026, 1, 14),
                          rate_to_eur=Decimal("0.2000"), source="ecb"))
            db.add(Transaction(
                company_id=self.CID, source="manual", external_id="af1",
                transaction_date=datetime(2026, 1, 15, tzinfo=timezone.utc),
                amount=Decimal("100"), currency="PLN", amount_eur=Decimal("20.00"),
                fx_rate=Decimal("0.2"), fx_rate_date=date(2026, 1, 14), fx_source="ecb",
                fuel_type="manual_other_other"))
            await db.commit()

        calls = []

        async def fake_download(days_back=None, **_kw):
            calls.append(days_back)
            async with AsyncSessionLocal() as db:
                db.add(FxRate(company_id=None, currency="PLN", rate_date=date(2026, 1, 15),
                              rate_to_eur=Decimal("0.2500"), source="ecb"))
                await db.commit()
            return {"status": "ok", "new_rows": 1, "updated_rows": 0}

        try:
            with mock.patch.object(fa.fx_service, "fetch_and_store_historical_rates", fake_download):
                res = await fa.auto_finish(self.CID, force_download=True)
            self.assertEqual(len(calls), 1, "архив должен быть запрошен")
            self.assertGreaterEqual(res["recalculated"], 1)
            async with AsyncSessionLocal() as db:
                t = (await db.execute(select(Transaction).where(
                    Transaction.company_id == self.CID))).scalar_one()
            self.assertEqual(t.fx_rate_date, date(2026, 1, 15))
            self.assertEqual(Decimal(str(t.amount_eur)).quantize(Decimal("0.01")), Decimal("25.00"))

            # Теперь всё точно: повторный заход архив не трогает.
            calls.clear()
            with mock.patch.object(fa.fx_service, "fetch_and_store_historical_rates", fake_download):
                await fa.auto_finish(self.CID, force_download=True)
            self.assertEqual(calls, [])
        finally:
            async with AsyncSessionLocal() as db:
                await db.execute(delete(Transaction).where(Transaction.company_id == self.CID))
                await db.execute(delete(FxRate).where(FxRate.currency == "PLN"))
                await db.commit()

    def test_approximate_row_triggers_download_and_gets_exact_rate(self):
        asyncio.run(self._scenario())


class LastPaymentClosed(unittest.TestCase):
    def test_remaining_without_last_adjustment_when_last_period_is_closed(self):
        c = SimpleNamespace(amount=Decimal("3333.33"), input_amount=Decimal("10000"),
                            amount_mode="total", total_periods=3, paid_periods=0)
        self.assertEqual(rs.schedule_remaining_amount(c, 2, last_closed=True), Decimal("6666.66"))
        self.assertEqual(rs.schedule_remaining_amount(c, 2, last_closed=False), Decimal("6666.67"))


class PlanScheduleEdges(unittest.TestCase):
    base = dict(start_date=date(2026, 3, 1), frequency="monthly", day_of_month=1)

    def test_end_before_start_rejected(self):
        with self.assertRaises(ValueError):
            rs.plan_schedule(**self.base, input_amount=100, amount_mode="period",
                             end_date=date(2026, 2, 1))

    def test_end_without_any_charge_rejected(self):
        with self.assertRaises(ValueError):
            rs.plan_schedule(start_date=date(2026, 3, 20), frequency="monthly", day_of_month=5,
                             input_amount=100, amount_mode="period", end_date=date(2026, 3, 25))

    def test_zero_periods_rejected(self):
        with self.assertRaises(ValueError):
            rs.plan_schedule(**self.base, input_amount=100, amount_mode="total", total_periods=0)



class NightlyApproxCompanies(unittest.TestCase):
    """Ночная задача находит компании со строками на курсе предыдущего дня."""

    CID = 987003

    async def _scenario(self):
        from datetime import datetime, timedelta, timezone
        from sqlalchemy import delete
        from app.core.database import engine, Base, AsyncSessionLocal
        from app.models.models import Transaction
        from app.services import fx_autoload as fa
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        # Ближайший будний день не позже вчера: надёжно «недавно» и не выходной.
        d = date.today() - timedelta(days=1)
        while d.weekday() >= 5:
            d -= timedelta(days=1)

        def tx(ext, op, rate_d):
            return Transaction(
                company_id=self.CID, source="manual", external_id=ext,
                transaction_date=datetime(op.year, op.month, op.day, tzinfo=timezone.utc),
                amount=Decimal("10"), currency="PLN", amount_eur=Decimal("2"),
                fx_rate=Decimal("0.2"), fx_rate_date=rate_d, fx_source="ecb",
                fuel_type="manual_other_other")
        async with AsyncSessionLocal() as db:
            await db.execute(delete(Transaction).where(Transaction.company_id == self.CID))
            db.add(tx("n1", d, d - timedelta(days=1)))
            await db.commit()
        try:
            self.assertIn(self.CID, await fa.companies_with_approx_rows())
            async with AsyncSessionLocal() as db:
                await db.execute(delete(Transaction).where(Transaction.company_id == self.CID))
                db.add(tx("n2", d, d))   # курс ровно на дату — приблизительности нет
                await db.commit()
            self.assertNotIn(self.CID, await fa.companies_with_approx_rows())
        finally:
            async with AsyncSessionLocal() as db:
                await db.execute(delete(Transaction).where(Transaction.company_id == self.CID))
                await db.commit()

    def test_companies_with_approx_rows(self):
        asyncio.run(self._scenario())



# ── Через настоящие маршруты API (тот же стенд, что в test_expense_categories) ──
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import httpx  # noqa: E402
import test_expense_categories as tec  # noqa: E402


class ApiRulesSuite(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app.core.database import engine, Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.main import app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        helper = tec.SaasCategoriesSuite("test_01_system_seed_and_custom_categories_in_all_sections")
        helper.client = self.client
        self.a = await helper._make_tenant("Alpha", "owner-s3@example.com")

    async def asyncTearDown(self):
        await self.client.aclose()

    def _body(self, **over):
        b = {"section": "leasing", "code": "leasing", "plate_number": "BI422GV",
             "description": "Лизинг", "input_amount": 6000, "amount_mode": "total",
             "total_periods": 6, "frequency": "monthly", "day_of_month": 1,
             "start_date": "2026-01-01", "currency": "EUR"}
        b.update(over)
        return b

    async def test_end_before_start_and_count_mismatch_rejected(self):
        st, r = await self.a["api"].post("/api/recurring-expenses/", json=self._body(
            amount_mode="period", input_amount=None, amount=100, total_periods=None,
            end_date="2025-12-01"))
        self.assertEqual(st, 400, r)
        st, r = await self.a["api"].post("/api/recurring-expenses/", json=self._body(
            total_periods=12, end_date="2026-06-30"))
        self.assertEqual(st, 400, r)

    async def test_leasing_rejects_trailer(self):
        st, r = await self.a["api"].post("/api/recurring-expenses/", json=self._body(
            plate_number=None, trailer_plate="SW 12345"))
        self.assertEqual(st, 400, r)

    async def test_partial_patch_keeps_end_date_and_comment_can_be_cleared(self):
        from sqlalchemy import update
        from app.core.database import AsyncSessionLocal
        from app.models.models import RecurringExpense
        st, r = await self.a["api"].post("/api/recurring-expenses/", json=self._body(comment="первый"))
        self.assertEqual(st, 200, r)
        cid = r["id"]
        self.assertEqual(r.get("comment"), "первый")
        # Дата окончания, заданная «по концу месяца», тем же числом платежей (6).
        async with AsyncSessionLocal() as db:
            await db.execute(update(RecurringExpense).where(RecurringExpense.id == cid)
                             .values(end_date=date(2026, 6, 30)))
            await db.commit()
        st, r = await self.a["api"].patch(f"/api/recurring-expenses/{cid}", json={"comment": "второй"})
        self.assertEqual(st, 200, r)
        self.assertEqual(r["end_date"], "2026-06-30", "частичная правка не должна менять дату окончания")
        self.assertEqual(r["comment"], "второй")
        st, r = await self.a["api"].patch(f"/api/recurring-expenses/{cid}", json={"comment": ""})
        self.assertEqual(st, 200, r)
        self.assertFalse(r.get("comment"))
        st, rows = await self.a["api"].get("/api/recurring-expenses/?section=leasing")
        row = next(x for x in rows if x["id"] == cid)
        # Все 6 периодов давно в прошлом (2026-01..06): остатка нет, неоплаченных нет.
        self.assertEqual(row["unpaid_periods"], 0)
        self.assertAlmostEqual(row["unpaid_amount"], 0.0, places=2)

    async def test_trailer_plate_suggestions_come_from_expenses(self):
        st, r = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "trailer", "category_code": "rental",
            "amount": 50, "currency": "EUR", "type": "oneoff", "trailer_plate": "sw-12345"})
        self.assertEqual(st, 200, r)
        st, r = await self.a["api"].get("/api/expenses/trailer-plates")
        self.assertEqual(st, 200, r)
        self.assertIn("SW12345", r["plates"])



if __name__ == "__main__":
    unittest.main()
