"""Перенос договоров старого формата в регулярные платежи.

    cd backend && python3 -m pytest -q tests/test_legacy_migration.py
"""
import os
import sys
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_legacy_migration.db")
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-legacy-migration")

from sqlalchemy import select  # noqa: E402

from app.core.database import engine, Base, AsyncSessionLocal  # noqa: E402
from app.models.models import (  # noqa: E402
    Company, LeasingContract, LeasingTombstone, TrailerContract, InsuranceContract,
    RecurringContract, RecurringExpense, RecurringExpenseTombstone, Transaction,
)
from app.services import legacy_migration_service as lm  # noqa: E402
from app.services import recurring_expense_service as rs  # noqa: E402


def _tx(company_id, ext, d, amount, fuel="manual_leasing_payment", plate="BI422GV"):
    return Transaction(
        company_id=company_id, source="recurring", external_id=ext,
        transaction_date=datetime(d.year, d.month, d.day, tzinfo=timezone.utc),
        plate_number=plate, amount=Decimal(amount), currency="EUR",
        amount_eur=Decimal(amount), fx_rate=Decimal("1"), fx_rate_date=d, fx_source="fixed",
        fuel_type=fuel, is_confirmed=True)


class LegacyMigration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        async with AsyncSessionLocal() as db:
            a = Company(name="A", is_active=True)
            b = Company(name="B", is_active=True)
            db.add_all([a, b])
            await db.flush()
            self.a, self.b = a.id, b.id
            # Лизинг: 12 платежей по 1000 с января 2026, день 5; созданы 3 месяца,
            # февраль удалён пользователем (tombstone).
            lc = LeasingContract(company_id=a.id, plate_number="BI422GV", description="PKO",
                                 start_date=date(2026, 1, 1), term_months=12,
                                 total_amount=Decimal("12000"), currency="EUR", day_of_month=5,
                                 monthly_amount=Decimal("1000"))
            tc = TrailerContract(company_id=a.id, plate_number="SW12345", category="rental",
                                 description="Аренда", start_date=date(2026, 1, 10), term_months=6,
                                 total_amount=Decimal("600"), currency="EUR", day_of_month=3,
                                 monthly_amount=Decimal("100"))
            ic = InsuranceContract(company_id=a.id, plate_number="BI422GV", category="casco",
                                   country="PL", policy_number="P-1", insurer="PZU",
                                   description="КАСКО", start_date=date(2026, 1, 1), term_months=12,
                                   total_amount=Decimal("1200"), currency="EUR", day_of_month=1,
                                   monthly_amount=Decimal("100"))
            gc = RecurringContract(company_id=a.id, category="parking", description="Парковка офиса",
                                   start_date=date(2026, 1, 1), end_date=date(2026, 12, 31),
                                   annual_amount=Decimal("1200"), currency="EUR", day_of_month=1,
                                   monthly_amount=Decimal("100"))
            other = LeasingContract(company_id=b.id, plate_number="XX1", description="чужой",
                                    start_date=date(2026, 1, 1), term_months=3,
                                    total_amount=Decimal("300"), currency="EUR", day_of_month=1,
                                    monthly_amount=Decimal("100"))
            db.add_all([lc, tc, ic, gc, other])
            await db.flush()
            self.lc, self.tc = lc.id, tc.id
            db.add_all([
                _tx(a.id, f"leasing_{lc.id}_2026-01", date(2026, 1, 5), "1000"),
                _tx(a.id, f"leasing_{lc.id}_2026-03", date(2026, 3, 5), "1000"),
                _tx(a.id, f"trailer_{tc.id}_2026-01", date(2026, 1, 3), "100",
                    fuel="manual_trailer_rental", plate="SW12345"),
                _tx(a.id, f"insurance_{ic.id}_2026-01", date(2026, 1, 1), "100",
                    fuel="manual_insurance_casco"),
                _tx(a.id, f"recurring_{gc.id}_2026-01", date(2026, 1, 1), "100",
                    fuel="manual_general_parking", plate=None),
            ])
            db.add(LeasingTombstone(company_id=a.id, contract_id=lc.id, year_month="2026-02",
                                    external_id=f"leasing_{lc.id}_2026-02"))
            await db.commit()

    async def _run(self, company, apply):
        async with AsyncSessionLocal() as db:
            return await lm.migrate_company(db, company, apply=apply)

    async def test_dry_run_changes_nothing(self):
        rep = await self._run(self.a, apply=False)
        self.assertEqual(rep["migrated"], 4, rep)
        async with AsyncSessionLocal() as db:
            n = (await db.execute(select(RecurringExpense))).scalars().all()
            self.assertEqual(n, [], "пробный прогон не должен создавать договоры")
            t = (await db.execute(select(Transaction.external_id).where(
                Transaction.company_id == self.a))).scalars().all()
            self.assertTrue(all(not e.startswith("rexp_") for e in t))

    async def test_apply_moves_contracts_charges_and_tombstones(self):
        rep = await self._run(self.a, apply=True)
        self.assertEqual((rep["migrated"], rep["errors"]), (4, 0), rep)
        self.assertEqual(rep["charges_relinked"], 5)
        self.assertEqual(rep["tombstones_moved"], 1)
        async with AsyncSessionLocal() as db:
            lease = (await db.execute(select(RecurringExpense).where(
                RecurringExpense.legacy_ref == f"leasing:{self.lc}"))).scalar_one()
            self.assertEqual(lease.total_periods, 12)
            self.assertEqual(lease.amount_mode, "total")
            self.assertEqual(Decimal(str(lease.input_amount)), Decimal("12000"))
            # Первый платёж — 05.01, как и был: старт сдвинут на день платежа.
            self.assertEqual(lease.start_date, date(2026, 1, 5))
            self.assertEqual(lease.end_date, rs.nth_charge_date(date(2026, 1, 5), "monthly", 5, 12))
            charges = (await db.execute(select(Transaction).where(
                Transaction.recurring_expense_id == lease.id))).scalars().all()
            self.assertEqual({c.external_id for c in charges},
                             {f"rexp_{lease.id}_2026-01", f"rexp_{lease.id}_2026-03"})
            self.assertTrue(all(c.expense_type == "recurring" and c.category_id == lease.category_id
                                and Decimal(str(c.amount_eur)) == Decimal("1000") for c in charges),
                            "суммы и EUR не должны меняться")
            tomb = (await db.execute(select(RecurringExpenseTombstone).where(
                RecurringExpenseTombstone.contract_id == lease.id))).scalars().all()
            self.assertEqual([t.period_key for t in tomb], ["2026-02"])
            self.assertEqual(lease.paid_periods, 2)

            trailer = (await db.execute(select(RecurringExpense).where(
                RecurringExpense.legacy_ref == f"trailer:{self.tc}"))).scalar_one()
            self.assertEqual(trailer.trailer_plate, "SW12345")
            self.assertEqual(trailer.start_date, date(2026, 1, 3))  # день 3 < 10: сдвиг к первому платежу

            ins = (await db.execute(select(RecurringExpense).where(
                RecurringExpense.legacy_ref.like("insurance:%")))).scalar_one()
            self.assertEqual((ins.policy_number, ins.insurer, ins.country), ("P-1", "PZU", "PL"))

            gen = (await db.execute(select(RecurringExpense).where(
                RecurringExpense.legacy_ref.like("general:%")))).scalar_one()
            self.assertEqual(gen.amount_mode, "yearly")
            self.assertEqual(gen.total_periods, 12)
            self.assertEqual(Decimal(str(gen.amount)), Decimal("100"))

    async def test_no_duplicates_after_generation(self):
        await self._run(self.a, apply=True)
        async with AsyncSessionLocal() as db:
            contracts = (await db.execute(select(RecurringExpense).where(
                RecurringExpense.company_id == self.a))).scalars().all()
            before = len((await db.execute(select(Transaction.id).where(
                Transaction.company_id == self.a))).all())
            await rs.generate_for_contracts(db, self.a, contracts, today=date(2026, 4, 30))
            await db.commit()
            rows = (await db.execute(select(Transaction).where(
                Transaction.company_id == self.a, Transaction.source == "recurring"))).scalars().all()
            ext = [r.external_id for r in rows]
            self.assertEqual(len(ext), len(set(ext)))
            lease = next(c for c in contracts if c.legacy_ref.startswith("leasing:"))
            lease_ext = {r.external_id for r in rows if r.recurring_expense_id == lease.id}
            # Январь и март — перенесённые, апрель — новый; февраль удалён и не вернулся.
            self.assertEqual(lease_ext, {f"rexp_{lease.id}_2026-01", f"rexp_{lease.id}_2026-03",
                                         f"rexp_{lease.id}_2026-04"})
            self.assertGreater(len(rows), before - 1)

    async def test_idempotent_and_isolated_by_company(self):
        await self._run(self.a, apply=True)
        rep2 = await self._run(self.a, apply=True)
        self.assertEqual((rep2["migrated"], rep2["already"], rep2["charges_relinked"]), (0, 4, 0), rep2)
        async with AsyncSessionLocal() as db:
            self.assertEqual(len((await db.execute(select(RecurringExpense))).scalars().all()), 4)
            counts = await lm.legacy_counts(db, self.b)
            self.assertEqual(counts["leasing"], 1, "компания B не затронута")

    async def test_cancelled_legacy_contract_becomes_paused(self):
        async with AsyncSessionLocal() as db:
            c = await db.get(LeasingContract, self.lc)
            c.is_active = False
            c.cancelled_at = datetime(2026, 3, 10, tzinfo=timezone.utc)
            await db.commit()
        await self._run(self.a, apply=True)
        async with AsyncSessionLocal() as db:
            lease = (await db.execute(select(RecurringExpense).where(
                RecurringExpense.legacy_ref == f"leasing:{self.lc}"))).scalar_one()
            self.assertEqual(lease.status, "paused")
            self.assertIsNotNone(lease.paused_at)


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import httpx  # noqa: E402
import test_expense_categories as tec  # noqa: E402


class LegacyMigrationApi(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.main import app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        helper = tec.SaasCategoriesSuite("test_01_system_seed_and_custom_categories_in_all_sections")
        helper.client = self.client
        self.t = await helper._make_tenant("Alpha", "owner-lm@example.com")
        async with AsyncSessionLocal() as db:
            db.add(LeasingContract(company_id=self.t["company_id"], plate_number="BI422GV",
                                   description="PKO", start_date=date(2026, 1, 1), term_months=6,
                                   total_amount=Decimal("600"), currency="EUR", day_of_month=1,
                                   monthly_amount=Decimal("100")))
            await db.commit()

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_status_dry_run_then_apply(self):
        api = self.t["api"]
        st, r = await api.get("/api/recurring-expenses/legacy-status")
        self.assertEqual((st, r["total"]), (200, 1), r)
        st, r = await api.post("/api/recurring-expenses/migrate-legacy")
        self.assertEqual((st, r["migrated"], r["apply"]), (200, 1, False), r)
        st, r = await api.get("/api/recurring-expenses/legacy-status")
        self.assertEqual(r["total"], 1, "пробный прогон ничего не переносит")
        st, r = await api.post("/api/recurring-expenses/migrate-legacy?apply=true")
        self.assertEqual((st, r["migrated"]), (200, 1), r)
        st, r = await api.get("/api/recurring-expenses/legacy-status")
        self.assertEqual(r["total"], 0)
        st, rows = await api.get("/api/recurring-expenses/?section=leasing")
        self.assertEqual(st, 200, rows)
        self.assertEqual(len(rows), 1)
        # Перенесённый договор получил списания за прошедшие месяцы сразу после переноса.
        self.assertGreaterEqual(rows[0]["created_periods"], 1)



if __name__ == "__main__":
    unittest.main()
