"""Регулярный платёж, добавленный на вкладке «Прицепы», должен появляться в списке
раздела, а списания — отдавать номер договора (для карточки «Регулярные»).

    cd backend && python3 -m pytest -q tests/test_trailer_recurring_visible.py
"""
import os
import sys
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_trailer_rec.db")
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-trailer-rec-suite")

import httpx  # noqa: E402
import test_expense_categories as tec  # noqa: E402


class TrailerRecurringVisible(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app.core.database import engine, Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.main import app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        helper = tec.SaasCategoriesSuite("test_01_system_seed_and_custom_categories_in_all_sections")
        helper.client = self.client
        self.a = await helper._make_tenant("Alpha", "owner-trl@example.com")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_trailer_contract_listed_and_charges_carry_contract_id(self):
        start = date.today() - timedelta(days=40)
        st, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(start), "section": "trailer", "category_code": "rental",
            "trailer_plate": "SW12345", "description": "Аренда", "amount": 100,
            "currency": "EUR", "type": "recurring", "periodicity": "monthly",
            "start_date": str(start), "day_of_month": 1,
        })
        self.assertEqual(st, 200, res)
        st, rows = await self.a["api"].get("/api/recurring-expenses/?section=trailer")
        self.assertEqual(st, 200)
        self.assertEqual([r["id"] for r in rows], [res["id"]])
        self.assertEqual(rows[0]["trailer_plate"], "SW12345")
        # /transactions использует выражения PostgreSQL, в SQLite их нет, поэтому
        # проверяем схему ответа на строках из базы напрямую.
        from sqlalchemy import select
        from app.core.database import AsyncSessionLocal
        from app.models.models import Transaction
        from app.schemas.schemas import TransactionOut
        async with AsyncSessionLocal() as db:
            rec = (await db.execute(select(Transaction).where(
                Transaction.source == "recurring"))).scalars().all()
            outs = [TransactionOut.model_validate(t) for t in rec]
        self.assertTrue(outs)
        self.assertTrue(all(o.recurring_expense_id == res["id"] for o in outs))


if __name__ == "__main__":
    unittest.main()
