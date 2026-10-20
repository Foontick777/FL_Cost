"""Frankfurter как второй источник курсов (валюты вне ЕЦБ). Сети нет: MockTransport.

    cd backend && python3 -m pytest -q tests/test_frankfurter.py
"""
import asyncio
import os
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_frankfurter.db")
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-frankfurter-suite")

import httpx  # noqa: E402

CIDS = (987101, 987102)


def _mock(calls, fail=False, byn_start=None):
    def handler(req: httpx.Request):
        calls.append(str(req.url))
        if fail:
            return httpx.Response(503)
        if req.url.path == "/v2/currencies":
            return httpx.Response(200, json=[
                {"iso_code": "BYN", "start_date": "2000-01-01", "end_date": date.today().isoformat()},
                {"iso_code": "PLN", "start_date": "1999-01-04", "end_date": date.today().isoformat()},
                {"iso_code": "OLD", "start_date": "1990-01-01", "end_date": "2001-01-01"},
            ])
        if req.url.path == "/v2/rates":
            p = req.url.params
            a, b = date.fromisoformat(p["from"]), date.fromisoformat(p["to"])
            out, d = [], a
            while d <= b:
                out.append({"date": d.isoformat(), "base": p["base"], "quote": "EUR", "rate": "0.30"})
                d += timedelta(days=1)
            return httpx.Response(200, json=out)
        return httpx.Response(404)
    return httpx.MockTransport(handler)


class FrankfurterSuite(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app.core.database import engine, Base
        from app.services import fx_frankfurter as ff, fx_autoload as fa
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        ff.reset_cache()
        fa.reset_frankfurter_state()
        self.calls = []
        ff._transport = _mock(self.calls)

    async def asyncTearDown(self):
        from app.services import fx_frankfurter as ff
        ff._transport = None
        ff.reset_cache()

    async def _tx(self, cid, ext, op, cur="BYN", eur=None, rate=None, rdate=None, src=None):
        from app.core.database import AsyncSessionLocal
        from app.models.models import Transaction
        async with AsyncSessionLocal() as db:
            db.add(Transaction(
                company_id=cid, source="manual", external_id=ext,
                transaction_date=datetime(op.year, op.month, op.day, tzinfo=timezone.utc),
                amount=Decimal("100"), currency=cur, amount_eur=eur, fx_rate=rate,
                fx_rate_date=rdate, fx_source=src, fuel_type="manual_other_other"))
            await db.commit()

    async def _get(self, cid, ext):
        from sqlalchemy import select
        from app.core.database import AsyncSessionLocal
        from app.models.models import Transaction
        async with AsyncSessionLocal() as db:
            return (await db.execute(select(Transaction).where(
                Transaction.company_id == cid, Transaction.external_id == ext))).scalar_one()

    async def test_auto_currencies_exclude_ecb_and_dead(self):
        from app.services import fx_autoload as fa
        auto = await fa.auto_currencies()
        self.assertIn("BYN", auto)
        self.assertNotIn("PLN", auto)   # ЕЦБ остаётся на ЕЦБ
        self.assertNotIn("OLD", auto)   # данные давно закончились

    async def test_missing_byn_loaded_in_one_range_request_and_recalculated(self):
        from app.services import fx_autoload as fa
        d1 = date.today() - timedelta(days=40)
        d2 = date.today() - timedelta(days=10)
        await self._tx(CIDS[0], "a", d1)
        await self._tx(CIDS[0], "b", d2)
        res = await fa.ensure_rates_and_recalculate(CIDS[0])
        rates_calls = [c for c in self.calls if "/v2/rates" in c]
        self.assertEqual(len(rates_calls), 1, rates_calls)          # диапазон, не по дате
        self.assertIn("base=BYN", rates_calls[0])
        self.assertEqual(res["remaining"], 0, res)
        row = await self._get(CIDS[0], "a")
        self.assertEqual(row.amount_eur, Decimal("30.00"))
        self.assertEqual(row.fx_source, "FRANKFURTER")
        self.assertEqual(row.fx_rate_date, d1)

    async def test_ecb_currency_never_requested_from_frankfurter(self):
        from app.services import fx_autoload as fa
        await self._tx(CIDS[0], "p", date.today() - timedelta(days=3), cur="PLN")
        await fa.ensure_rates_and_recalculate(CIDS[0], allow_download=True)
        self.assertFalse([c for c in self.calls if "base=PLN" in c])

    async def test_company_manual_rate_beats_frankfurter(self):
        from app.core.database import AsyncSessionLocal
        from app.models.models import FxRate
        from app.services import fx_autoload as fa
        d = date.today() - timedelta(days=5)
        async with AsyncSessionLocal() as db:
            db.add(FxRate(currency="BYN", rate_date=d, rate_to_eur=Decimal("0.5"),
                          source="manual", company_id=CIDS[0]))
            await db.commit()
        await self._tx(CIDS[0], "m", d)
        await self._tx(CIDS[1], "g", d)
        await fa.ensure_rates_and_recalculate(CIDS[0], rates_changed=True)
        await fa.ensure_rates_and_recalculate(CIDS[1])
        m, g = await self._get(CIDS[0], "m"), await self._get(CIDS[1], "g")
        self.assertEqual(m.amount_eur, Decimal("50.00"))     # свой ручной курс
        self.assertEqual(g.amount_eur, Decimal("30.00"))     # другая компания не зависит от первой

    async def test_failure_is_tolerated_and_cooldown_stops_hammering(self):
        from app.services import fx_autoload as fa, fx_frankfurter as ff
        ff._transport = _mock(self.calls, fail=True)
        ff.reset_cache()
        await self._tx(CIDS[0], "x", date.today() - timedelta(days=5))
        r = await fa.ensure_rates_and_recalculate(CIDS[0])
        self.assertTrue(r["ok"])
        self.assertEqual(r["remaining"], 1)
        n = len(self.calls)
        await fa.ensure_rates_and_recalculate(CIDS[0])
        self.assertEqual(len(self.calls), n)     # пауза после сбоя: повторов нет

    async def test_stale_data_kept_when_service_down_later(self):
        from app.services import fx_frankfurter as ff
        r = await ff.fetch_and_store("BYN", date.today() - timedelta(days=3), date.today())
        self.assertEqual(r["status"], "ok")
        again = await ff.fetch_and_store("BYN", date.today() - timedelta(days=3), date.today())
        self.assertEqual((again["new"], again["updated"]), (0, 0))   # идемпотентно

    async def test_foreign_source_row_not_overwritten(self):
        from sqlalchemy import select
        from app.core.database import AsyncSessionLocal
        from app.models.models import FxRate
        from app.services import fx_frankfurter as ff
        d = date.today() - timedelta(days=2)
        async with AsyncSessionLocal() as db:
            db.add(FxRate(currency="BYN", rate_date=d, rate_to_eur=Decimal("0.99"), source="ECB"))
            await db.commit()
        await ff.fetch_and_store("BYN", d, d)
        async with AsyncSessionLocal() as db:
            row = (await db.execute(select(FxRate).where(
                FxRate.currency == "BYN", FxRate.rate_date == d))).scalar_one()
        self.assertEqual(row.rate_to_eur, Decimal("0.99"))

    async def test_manual_sync_other_currencies_scoped_to_company(self):
        from app.services import fx_autoload as fa
        await self._tx(CIDS[0], "s", date.today() - timedelta(days=20))
        r = await fa.sync_other_currencies(CIDS[1], history=True)       # у компании 2 нет BYN
        self.assertEqual(r["status"], "skipped")
        self.assertFalse([c for c in self.calls if "/v2/rates" in c])
        r = await fa.sync_other_currencies(CIDS[0], history=True)
        self.assertEqual(r["status"], "ok")
        r2 = await fa.sync_other_currencies(CIDS[0], history=True)      # троттлинг
        self.assertEqual(r2["status"], "skipped")

    async def test_unrated_overview_flags_auto(self):
        from app.services import fx_autoload as fa
        await self._tx(CIDS[0], "u", date.today() - timedelta(days=5))
        ov = await fa.unrated_overview(CIDS[0])
        item = [i for i in ov["detail"] if i["currency"] == "BYN"][0]
        self.assertTrue(item["auto"])
        self.assertFalse(item["manual_only"])


if __name__ == "__main__":
    unittest.main()
