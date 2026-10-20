"""Регрессионные тесты аудита stage 9.1 (дефекты платежей и курсов).

Каждый тест закрывает конкретный дефект из отчёта аудита:

  1. PATCH суммы регулярного платежа: форма всегда шлёт amount_mode вместе с
     amount — сервер игнорировал новую сумму (критический).
  2. Полисные атрибуты страхования терялись при создании договора.
  3. «Не оплачено» складывалось без учёта валюты (долг в PLN выглядел как EUR).
  4. Неоплаченный разовый взнос выпадал из «остатка обязательств».
  5. Строки валют Frankfurter не пересчитывались при появлении курса за
     соседний день (plausible-фильтр не знал про глобальные курсы).
  6. Округление «всего за срок» переплачивало на малых суммах.
  7. Отрицательный down_payment принимался через /expenses/.
  8. Пауза/возобновление в день списания помечало оплаченный период
     «пропущенным».

Тесты автономны по сети: загрузки курсов заблокированы патчем кулдаунов
(setUpModule), курсы вносятся прямо в таблицу fx_rates.
"""
from __future__ import annotations

import os
import sys
import unittest
from datetime import date, timedelta
from decimal import Decimal

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.database import AsyncSessionLocal, Base, engine
from app.core.security import create_access_token, get_password_hash
from app.models.models import Company, FxRate, Transaction, User
from app.schemas.schemas import RecurringExpenseCreate  # noqa: F401  (импорт схемы)
from app.services import fx_autoload
from app.services.recurring_expense_service import (
    compute_amount, last_period_amount, plan_schedule, schedule_remaining_amount,
)


def setUpModule():
    """Блокируем сетевые загрузки курсов на время модуля.

    Без этого создание расхода через API тянуло бы живой архив ЕЦБ, и
    собственные курсы теста (0.25 PLN и т.п.) перезаписывались реальными.
    """
    fx_autoload.reset_cooldown()
    fx_autoload.reset_frankfurter_state()
    fx_autoload._ORIG_COOLDOWN = fx_autoload._cooldown_passed
    fx_autoload._ORIG_FR_COOLDOWN = fx_autoload._frankfurter_cooldown_passed
    fx_autoload._cooldown_passed = lambda now=None: False
    fx_autoload._frankfurter_cooldown_passed = lambda now=None: False


def tearDownModule():
    fx_autoload._cooldown_passed = fx_autoload._ORIG_COOLDOWN
    fx_autoload._frankfurter_cooldown_passed = fx_autoload._ORIG_FR_COOLDOWN
    fx_autoload.reset_cooldown()
    fx_autoload.reset_frankfurter_state()


class _ApiHarness(unittest.IsolatedAsyncioTestCase):
    """Общий стенд: чистая база, владелец компании, HTTP-клиент к приложению."""

    async def asyncSetUp(self):
        from app.main import app
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        async with AsyncSessionLocal() as db:
            company = Company(name="AuditFixCo", is_active=True)
            db.add(company)
            await db.flush()
            user = User(company_id=company.id, email="audit-fix@example.com",
                        hashed_password=get_password_hash("AuditFix123!"),
                        full_name="Auditor", role="owner", is_active=True)
            db.add(user)
            await db.commit()
            await db.refresh(user)
            self.company_id = company.id
            self.user_id = user.id
        self.headers = {"Authorization": f"Bearer {create_access_token({'sub': str(self.user_id)})}"}
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        await engine.dispose()

    # ── helpers ──
    async def api(self, method, path, json_body=None):
        r = await self.client.request(method, f"/api{path}", json=json_body,
                                      headers=self.headers)
        try:
            body = r.json()
        except Exception:
            body = r.text
        return r.status_code, body

    async def add_rate(self, currency: str, rate: str, on: date, company_id=None):
        async with AsyncSessionLocal() as db:
            db.add(FxRate(currency=currency, rate_date=on,
                          rate_to_eur=rate, source="manual" if company_id else "ECB",
                          company_id=company_id))
            await db.commit()

    async def recurring_out(self, contract_id):
        st, lst = await self.api("GET", "/recurring-expenses/")
        self.assertEqual(st, 200)
        found = [c for c in lst if c["id"] == contract_id]
        self.assertTrue(found, "договор не найден в списке")
        return found[0]

    async def create_contract(self, **over):
        today = date.today()
        body = {
            "section": "other", "code": "other", "description": "Audit fix",
            "amount": 100, "amount_mode": "period", "frequency": "monthly",
            "day_of_month": today.day, "start_date": today.isoformat(),
            "total_periods": 12, "currency": "EUR",
        }
        body.update(over)
        st, r = await self.api("POST", "/recurring-expenses/", body)
        self.assertEqual(st, 200, r)
        return r


# ─── 1. Критический: PATCH суммы с amount_mode ─────────────────────────────

class PatchAmountSuite(_ApiHarness):
    """Правка суммы регулярного платежа из интерфейса обязана применяться.

    Форма (ExpenseForm.jsx patchPayload) ВСЕГДА отправляет amount_mode вместе
    с amount: для режима «за период» сумма уходит в amount при input_amount=null.
    Прежний сервер брал новую сумму только при amount_mode=None — правка
    молча игнорировалась, договор оставался со старой суммой.
    """

    async def test_patch_amount_with_amount_mode_applies(self):
        created = await self.create_contract(amount=100, total_periods=12)
        cid = created["id"]
        self.assertEqual(created["amount"], 100.0)

        # Ровно так, как шлёт форма: amount + amount_mode вместе.
        st, r = await self.api("PATCH", f"/recurring-expenses/{cid}", {
            "description": "Audit fix", "input_amount": None, "amount": 150,
            "amount_mode": "period", "total_periods": 12, "down_payment": 0,
            "currency": "EUR", "frequency": "monthly",
            "start_date": created["start_date"], "end_date": None,
            "day_of_month": created["day_of_month"], "document_ref": None,
            "comment": "", "plate_number": None, "trailer_plate": None,
        })
        self.assertEqual(st, 200, r)
        self.assertEqual(r["amount"], 150.0,
                         "новая сумма «за период» проигнорирована при PATCH")
        self.assertEqual(r["input_amount"], 150.0)
        # Итог блока «регулярные платежи» тоже берёт новую сумму.
        self.assertEqual(r["monthly_amount"], 150.0)

    async def test_patch_amount_only_still_works(self):
        """Прежний путь API (только amount, без amount_mode) не сломан."""
        created = await self.create_contract(amount=100, total_periods=12)
        st, r = await self.api("PATCH", f"/recurring-expenses/{created['id']}",
                               {"amount": 170})
        self.assertEqual(st, 200, r)
        self.assertEqual(r["amount"], 170.0)

    async def test_patch_amount_with_mode_change(self):
        """amount + amount_mode='yearly' — сумма трактуется как «за год»."""
        created = await self.create_contract(amount=100, total_periods=12)
        st, r = await self.api("PATCH", f"/recurring-expenses/{created['id']}", {
            "amount": 1200, "amount_mode": "yearly"})
        self.assertEqual(st, 200, r)
        self.assertEqual(r["amount"], 100.0, "1200 за год = 100 за месяц")

    async def test_patch_without_amount_keeps_old(self):
        """Сумму не трогали (только комментарий) — сумма сохраняется."""
        created = await self.create_contract(amount=100, total_periods=12)
        st, r = await self.api("PATCH", f"/recurring-expenses/{created['id']}",
                               {"comment": "новый комментарий"})
        self.assertEqual(st, 200, r)
        self.assertEqual(r["amount"], 100.0)


# ─── 2. Полисные атрибуты страхования ──────────────────────────────────────

class PolicyAttrsSuite(_ApiHarness):
    """country/policy_number/insurer больше не теряются при создании договора."""

    async def test_policy_attrs_via_expenses_endpoint(self):
        today = date.today()
        st, r = await self.api("POST", "/expenses/", {
            "section": "insurance", "category_code": "casco",
            "type": "recurring", "expense_date": today.isoformat(),
            "start_date": today.isoformat(), "amount": 100,
            "amount_mode": "period", "frequency": "monthly",
            "day_of_month": today.day, "total_periods": 12,
            "currency": "EUR", "country": "PL", "policy_number": "POL-123",
            "insurer": "PZU", "description": "КАСКО",
        })
        self.assertEqual(st, 200, r)
        contract = await self.recurring_out(r["id"])
        self.assertEqual(contract["country"], "PL")
        self.assertEqual(contract["policy_number"], "POL-123")
        self.assertEqual(contract["insurer"], "PZU")

    async def test_policy_attrs_via_recurring_endpoint(self):
        today = date.today()
        st, r = await self.api("POST", "/recurring-expenses/", {
            "section": "insurance", "code": "casco", "description": "КАСКО",
            "amount": 100, "amount_mode": "period", "frequency": "monthly",
            "day_of_month": today.day, "start_date": today.isoformat(),
            "total_periods": 12, "currency": "EUR",
            "country": "DE", "policy_number": "DE-777", "insurer": "Allianz",
        })
        self.assertEqual(st, 200, r)
        contract = await self.recurring_out(r["id"])
        self.assertEqual(contract["country"], "DE")
        self.assertEqual(contract["policy_number"], "DE-777")
        self.assertEqual(contract["insurer"], "Allianz")


# ─── 3. «Не оплачено» в EUR ────────────────────────────────────────────────

class UnpaidEurSuite(_ApiHarness):
    """unpaid_amount — сумма в ЕВРО, а не «сколько-то в валюте договора»."""

    async def test_unpaid_sum_is_eur(self):
        today = date.today()
        # Курс PLN на сегодня: 4 PLN = 1 EUR.
        await self.add_rate("PLN", "0.25", today)
        created = await self.create_contract(amount=100, currency="PLN",
                                            total_periods=3)
        # Списание 100 PLN создано и сконвертировано: 100 × 0.25 = 25 EUR.
        st, charges = await self.api("GET",
                                     f"/recurring-expenses/{created['id']}/charges")
        self.assertEqual(st, 200)
        self.assertEqual(len(charges), 1)
        # Снимаем оплату — списание попадает в «не оплачено».
        st, _ = await self.api("POST", f"/expenses/{charges[0]['id']}/paid",
                               {"is_paid": False})
        self.assertEqual(st, 200)
        contract = await self.recurring_out(created["id"])
        self.assertEqual(contract["unpaid_periods"], 1)
        # ДО фикса: 100 (исходные PLN, показывались как EUR).
        # ПОСЛЕ: 25.0 — сумма amount_eur неоплаченного списания.
        self.assertAlmostEqual(contract["unpaid_amount"], 25.0, places=2,
                               msg="«не оплачено» должно быть в EUR")


# ─── 4. Неоплаченный разовый взнос в обязательствах ────────────────────────

class UnpaidDownPaymentSuite(_ApiHarness):
    """Взнос, по которому снята оплата, остаётся в «остатке обязательств»."""

    async def test_unpaid_down_payment_stays_in_obligations(self):
        today = date.today()
        created = await self.create_contract(
            input_amount=600, amount_mode="total", total_periods=6,
            down_payment=500)
        st, charges = await self.api("GET",
                                     f"/recurring-expenses/{created['id']}/charges")
        self.assertEqual(st, 200)
        dp = [c for c in charges if c["kind"] == "down_payment"]
        self.assertEqual(len(dp), 1, "разовый взнос должен быть создан")
        # Снимаем оплату с взноса.
        st, _ = await self.api("POST", f"/expenses/{dp[0]['id']}/paid",
                               {"is_paid": False})
        self.assertEqual(st, 200)
        contract = await self.recurring_out(created["id"])
        # Взнос не оплачен → он в обязательствах: 500 (взнос) + 500 (5×100
        # регулярных). До фикса remaining_total_obligation был 500 — взнос
        # молча выпадал после даты начала.
        self.assertEqual(contract["remaining_down_payment"], 500.0)
        self.assertGreaterEqual(contract["remaining_total_obligation"], 1000.0)

    async def test_paid_down_payment_not_in_obligations(self):
        today = date.today()
        created = await self.create_contract(
            input_amount=600, amount_mode="total", total_periods=6,
            down_payment=500)
        contract = await self.recurring_out(created["id"])
        # Взнос оплачен (по умолчанию) → в обязательствах только график.
        self.assertEqual(contract["remaining_down_payment"], 0.0)
        self.assertLess(contract["remaining_total_obligation"], 1000.0)


# ─── 5. Автопересчёт для валют Frankfurter ────────────────────────────────

class RefineFrankfurterSuite(_ApiHarness):
    """Строка без EUR пересчитывается, когда появился глобальный курс валюты."""

    async def test_global_frankfurter_rate_refines_null_row(self):
        today = date.today()
        # Строка BYN без курса — как «создана, пока источник был недоступен».
        st, r = await self.api("POST", "/expenses/", {
            "section": "other", "category_code": "other", "type": "oneoff",
            "expense_date": today.isoformat(), "amount": 100, "currency": "BYN"})
        self.assertEqual(st, 200, r)
        # …и глобальный курс BYN за ВЧЕРА (соседний день, окно 14 дней).
        await self.add_rate("BYN", "0.25", today - timedelta(days=1))
        # Пересчёт без сети: rates_changed=True, allow_download=False.
        res = await fx_autoload.ensure_rates_and_recalculate(
            self.company_id, allow_download=False, rates_changed=True)
        self.assertGreaterEqual(res.get("recalculated", 0), 1,
                                "строка BYN должна была пересчитаться")
        async with AsyncSessionLocal() as db:
            from sqlalchemy import select
            txn = (await db.execute(select(Transaction).where(
                Transaction.currency == "BYN"))).scalars().first()
            self.assertIsNotNone(txn)
            self.assertAlmostEqual(float(txn.amount_eur), 25.0, places=2,
                                  msg="100 BYN × 0.25 = 25 EUR")


# ─── 6. Округление «всего за срок» ────────────────────────────────────────

class RoundingSuite(unittest.TestCase):
    """График не переплачивает: сумма платежей сходится с договором."""

    def test_per_payment_rounds_down_in_total_mode(self):
        self.assertEqual(compute_amount("total", "10000", "monthly", 3),
                         Decimal("3333.33"))

    def test_schedule_sums_exactly(self):
        per = compute_amount("total", "10000", "monthly", 3)

        class C:
            amount = per
            amount_mode = "total"
            total_periods = 3
            input_amount = "10000"

        last = last_period_amount(C(), 2)
        self.assertEqual(last, Decimal("3333.34"))
        self.assertEqual(per * 2 + last, Decimal("10000.00"),
                         "график обязан закрыть договор ровно")

    def test_remaining_matches_schedule(self):
        per = compute_amount("total", "10000", "monthly", 3)

        class C:
            amount = per
            amount_mode = "total"
            total_periods = 3
            input_amount = "10000"
            paid_periods = 1

        from app.services.recurring_expense_service import remaining_periods
        left = remaining_periods(C())
        self.assertEqual(left, 2)
        self.assertEqual(schedule_remaining_amount(C(), left), Decimal("6666.67"))

    def test_untotalable_amount_rejected(self):
        """0.02 на 3 платежа нельзя разбить в центах — отказ, а не переплата."""
        per = compute_amount("total", "0.02", "monthly", 3)
        self.assertEqual(per, Decimal("0.00"),
                        "сумма одного списания обязана округляться вниз")
        with self.assertRaises(ValueError) as ctx:
            plan_schedule(start_date=date(2026, 1, 1), frequency="monthly",
                         day_of_month=1, input_amount=Decimal("0.02"),
                         amount_mode="total", total_periods=3)
        self.assertIn("больше нуля", str(ctx.exception))

    def test_yearly_mode_unchanged(self):
        self.assertEqual(compute_amount("yearly", "1200", "monthly", None),
                         Decimal("100.00"))


# ─── 7. Отрицательный down_payment ───────────────────────────────────────

class NegativeDownPaymentSuite(_ApiHarness):
    async def test_negative_down_payment_rejected(self):
        today = date.today()
        st, r = await self.api("POST", "/expenses/", {
            "section": "other", "category_code": "other", "type": "recurring",
            "expense_date": today.isoformat(), "start_date": today.isoformat(),
            "amount": 100, "amount_mode": "period", "frequency": "monthly",
            "day_of_month": today.day, "total_periods": 12,
            "currency": "EUR", "down_payment": -5000,
        })
        self.assertEqual(st, 422, r)


# ─── 8. Пауза/возобновление в день списания ───────────────────────────────

class PauseResumeSuite(_ApiHarness):
    """Оплаченный период не помечается «пропущенным» после pause/resume."""

    async def test_paid_period_not_counted_skipped(self):
        today = date.today()
        created = await self.create_contract(amount=50, total_periods=6)
        cid = created["id"]
        st, charges = await self.api("GET", f"/recurring-expenses/{cid}/charges")
        self.assertEqual(st, 200)
        self.assertEqual(len(charges), 1, "списание за сегодня должно быть создано")

        st, _ = await self.api("PATCH", f"/recurring-expenses/{cid}/pause")
        self.assertEqual(st, 200)
        st, _ = await self.api("PATCH", f"/recurring-expenses/{cid}/resume")
        self.assertEqual(st, 200)

        contract = await self.recurring_out(cid)
        # До фикса: skipped=1 при paid=1 — оплаченный период считался дважды.
        self.assertEqual(contract["skipped_periods"], 0,
                         "оплаченный период не должен считаться пропущенным")
        st, charges2 = await self.api("GET", f"/recurring-expenses/{cid}/charges")
        self.assertEqual(len(charges2), 1, "дублей списания быть не должно")


# ─── 9. Остаток обязательств в EUR от сервера ─────────────────────────────

class RemainingEurSuite(_ApiHarness):
    """remaining_amount_eur считает сервер — фронтенд не делит на свой курс."""

    async def test_remaining_amount_eur_present(self):
        today = date.today()
        await self.add_rate("PLN", "0.25", today)
        # Договор в будущем: 12 × 100 PLN, списаний ещё нет.
        created = await self.create_contract(
            amount=100, currency="PLN", total_periods=12,
            start_date=(today + timedelta(days=30)).isoformat())
        contract = await self.recurring_out(created["id"])
        self.assertIsNotNone(contract["remaining_amount_eur"],
                             "EUR-остаток должен быть посчитан сервером")
        # 12 × 100 PLN × 0.25 = 300 EUR.
        self.assertAlmostEqual(contract["remaining_amount_eur"], 300.0, places=2)

    async def test_remaining_amount_eur_absent_without_rate(self):
        today = date.today()
        # Валюта без курса в базе — EUR-остатка быть не должно (None),
        # а не деление на устаревший курс фронтенда.
        created = await self.create_contract(
            amount=100, currency="XYZ", total_periods=12,
            start_date=(today + timedelta(days=30)).isoformat())
        contract = await self.recurring_out(created["id"])
        self.assertIsNone(contract["remaining_amount_eur"])


if __name__ == "__main__":
    unittest.main()
