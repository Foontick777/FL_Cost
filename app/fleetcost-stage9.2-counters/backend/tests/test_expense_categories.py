"""Проверки SaaS-доработки: динамические категории расходов и универсальные
регулярные расходы (ТЗ «FleetCost — Универсальная система расходов»).

Запуск (нужны зависимости backend):

    cd backend && python3 tests/test_expense_categories.py

Проверяется не разметка, а ПОВЕДЕНИЕ: каждый пункт раздела 17 документа
(«Acceptance Criteria») превращён здесь в утверждение, которое должно быть
истинным на реальных маршрутах API.

Почему SQLite. Маршруты, права, категоризация и генерация списаний от СУБД не
зависят; на SQLite проверка идёт за секунды и не требует поднятого PostgreSQL.
Отдельно (в конце) проверяется, что индексы/типы компилируются в PostgreSQL —
чтобы «на SQLite прошло» не скрывало диалект-специфичную ошибку.
"""
import asyncio
import os
import sys
import unittest
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Должно быть выставлено ДО импорта app.*: ядро создаёт движок на импорте.
# ENVIRONMENT допускает только development|staging|production; «development»
# здесь означает «не production» — проверки боевой конфигурации не запускаются.
os.environ["ENVIRONMENT"] = "development"
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-saas-categories-suite")

import httpx  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from app.core.database import engine, Base, AsyncSessionLocal  # noqa: E402
from app.core.security import create_access_token, get_password_hash  # noqa: E402
from app.models.models import Company, User, ExpenseCategory, RecurringExpense, Transaction  # noqa: E402
from app.services import fx_autoload  # noqa: E402


# Набор должен быть герметичным: создание расхода доводит курсы до конца и при
# нехватке дат докачивает архив ЕЦБ. В тестах сети быть не должно (иначе прогон
# зависит от доступности ecb.europa.eu и занимает минуты), поэтому сама загрузка
# архива подменяется заглушкой. Всё остальное — поиск курса, запись fx_rate и
# amount_eur, сводка «что осталось без курса» — работает по-настоящему.
async def _offline_no_download(*_args, **_kwargs):
    return {"status": "error", "message": "offline (test suite)"}


fx_autoload.fx_service.fetch_and_store_historical_rates = _offline_no_download


class Api:
    """Тонкая обёртка над httpx: держит заголовок с токеном и разворачивает JSON."""

    def __init__(self, client, token):
        self._c = client
        self._h = {"Authorization": f"Bearer {token}"}

    async def get(self, url, **kw):
        r = await self._c.get(url, headers=self._h, **kw)
        return r.status_code, (r.json() if r.content else None)

    async def post(self, url, json=None, **kw):
        r = await self._c.post(url, headers=self._h, json=json, **kw)
        return r.status_code, (r.json() if r.content else None)

    async def patch(self, url, json=None, **kw):
        r = await self._c.patch(url, headers=self._h, json=json, **kw)
        return r.status_code, (r.json() if r.content else None)

    async def delete(self, url, **kw):
        r = await self._c.delete(url, headers=self._h, **kw)
        return r.status_code, (r.json() if r.content else None)


class SaasCategoriesSuite(unittest.IsolatedAsyncioTestCase):
    """Один прогон по всем пяти разделам на чистой базе."""

    async def asyncSetUp(self):
        # Чистая схема на каждый тест — тесты не должны влиять друг на другом.
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        from app.main import app
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")
        self.a, self.b = await self._make_tenant("Alpha Sp. z o.o.", "owner-a@example.com"), \
            await self._make_tenant("Beta GmbH", "owner-b@example.com")

    async def asyncTearDown(self):
        await self.client.aclose()

    # ── вспомогательное ────────────────────────────────────────────────
    async def _make_tenant(self, company_name, email):
        async with AsyncSessionLocal() as db:
            company = Company(name=company_name, is_active=True)
            db.add(company)
            await db.flush()
            user = User(
                company_id=company.id,
                email=email,
                hashed_password=get_password_hash("Test1234A"),
                full_name="Owner",
                role="owner",
                is_active=True,
            )
            db.add(user)
            await db.commit()
            await db.refresh(user)
            token = create_access_token({"sub": str(user.id)})
            return {"company_id": company.id, "user_id": user.id, "api": Api(self.client, token)}

    async def _cats(self, tenant, **params):
        q = "&".join(f"{k}={v}" for k, v in params.items())
        status, body = await tenant["api"].get(f"/api/expense-categories/?{q}")
        self.assertEqual(status, 200, body)
        return body

    def _find(self, cats, section, code):
        for c in cats:
            if c["section"] == section and c["code"] == code:
                return c
        return None

    # ── 17.1 Готовый набор + пользовательские категории в каждом разделе ──
    async def test_01_system_seed_and_custom_categories_in_all_sections(self):
        cats = await self._cats(self.a, include_inactive="true")
        # Системные категории создаются автоматически, без ручных действий.
        self.assertIsNotNone(self._find(cats, "other", "fine"), "нет системной «Штрафы»")
        self.assertIsNotNone(self._find(cats, "other", "parking"), "нет системной «Парковки»")
        self.assertIsNotNone(self._find(cats, "trailer", "rental"), "нет системной «Аренда»")
        self.assertIsNotNone(self._find(cats, "general", "office"), "нет системной «Аренда офиса»")
        self.assertIsNotNone(self._find(cats, "salary", "monthly"), "нет системной «Ежемесячная»")
        self.assertIsNotNone(self._find(cats, "insurance", "casco"), "нет системной «КАСКО»")
        self.assertTrue(all(c["is_system"] for c in cats if c["code"] in
                            ("fine", "rental", "office", "monthly", "casco")))

        # Пользовательская категория — в каждом из разделов.
        for section, name in (
            ("other", "GPS / Телематика"),
            ("trailer", "GPS-трекер прицепа"),
            ("general", "Программное обеспечение"),
            ("insurance", "Kfz-Versicherung"),
            ("salary_tax", "Lohnsteuer"),
        ):
            status, body = await self.a["api"].post("/api/expense-categories/", json={
                "section": section, "name": name,
            })
            self.assertEqual(status, 200, body)
            self.assertFalse(body["is_system"], "пользовательская категория помечена системной")
            self.assertTrue(body["is_active"])

        cats = await self._cats(self.a, include_inactive="true")
        gps = self._find(cats, "other", "gps")
        self.assertIsNotNone(gps, "категория GPS не создалась с ожидаемым кодом")
        self.assertEqual(gps["name"], "GPS / Телематика")
        self.assertIsNotNone(self._find(cats, "salary_tax", "lohnsteuer"))
        self.assertIsNotNone(self._find(cats, "insurance", "kfz_versicherung"))
        # Системные категории идут первыми — так требует §12 п.7. Гарантия
        # действует ВНУТРИ раздела (список сгруппирован по разделу), поэтому
        # проверяем по каждому разделу отдельно.
        by_section: dict[str, list] = {}
        for c in cats:
            by_section.setdefault(c["section"], []).append(c)
        for section, items in by_section.items():
            system_idx = [i for i, c in enumerate(items) if c["is_system"]]
            custom_idx = [i for i, c in enumerate(items) if not c["is_system"]]
            if system_idx and custom_idx:
                self.assertLess(max(system_idx), min(custom_idx),
                                f"в разделе «{section}» системные категории идут после пользовательских")

    # ── 17.2 Новая категория сразу доступна в форме расхода ──
    async def test_02_new_category_immediately_usable_for_expense(self):
        status, cat = await self.a["api"].post("/api/expense-categories/", json={
            "section": "other", "name": "Стоянка", "icon": "🅿️",
        })
        self.assertEqual(status, 200, cat)

        # Разовый расход сразу по новой категории (section + category_code).
        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()),
            "section": "other",
            "category_code": cat["code"],
            "description": "Стоянка на трассе",
            "amount": 30.0,
            "currency": "EUR",
            "type": "oneoff",
        })
        self.assertEqual(status, 200, res)
        self.assertEqual(res["kind"], "transaction")

        async with AsyncSessionLocal() as db:
            txn = (await db.execute(select(Transaction).where(Transaction.id == res["id"]))).scalar_one()
            self.assertEqual(txn.fuel_type, f"manual_other_{cat['code']}")
            self.assertEqual(txn.category_id, cat["id"])
            self.assertEqual(txn.expense_type, "oneoff")

        # И категория сразу видна в аналитике: usage_count растёт.
        cats = await self._cats(self.a)
        c = self._find(cats, "other", cat["code"])
        self.assertEqual(c["usage_count"], 1, "usage_count не увидел новую операцию")

    # ── 17.3 Системные категории продолжают работать ──
    async def test_03_system_categories_still_work(self):
        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()),
            "section": "other", "category_code": "fine",
            "description": "Штраф за парковку", "amount": 120.0, "currency": "EUR",
        })
        self.assertEqual(status, 200, res)
        async with AsyncSessionLocal() as db:
            txn = (await db.execute(select(Transaction).where(Transaction.id == res["id"]))).scalar_one()
            self.assertEqual(txn.fuel_type, "manual_other_fine")

        # Легаси-вызов (старый фронтенд/внешний код) продолжает работать и тоже
        # связывается с категорией.
        status, res2 = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()),
            "description": "Ремонт по старому вызову", "amount": 55.0,
            "currency": "EUR", "category": "other_repair",
        })
        self.assertEqual(status, 200, res2)
        async with AsyncSessionLocal() as db:
            txn2 = (await db.execute(select(Transaction).where(Transaction.id == res2["id"]))).scalar_one()
            self.assertEqual(txn2.fuel_type, "manual_other_repair")
            self.assertIsNotNone(txn2.category_id, "легаси-расход не связался с категорией")

    # ── 17.4 Отключить без удаления истории; удаление — если не используется ──
    async def test_04_deactivate_keeps_history_and_delete_is_guarded(self):
        status, cat = await self.a["api"].post("/api/expense-categories/", json={
            "section": "general", "name": "Реклама",
        })
        self.assertEqual(status, 200, cat)

        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "general",
            "category_code": cat["code"], "description": "Промо-кампания",
            "amount": 250.0, "currency": "EUR",
        })
        self.assertEqual(status, 200, res)

        # Отключаем — история остаётся, в выборе для новых операций нет.
        status, patched = await self.a["api"].patch(
            f"/api/expense-categories/{cat['id']}", json={"is_active": False})
        self.assertEqual(status, 200, patched)
        self.assertFalse(patched["is_active"])
        self.assertEqual(patched["usage_count"], 1, "история не должна теряться")

        active_only = await self._cats(self.a, section="general", include_inactive="false")
        self.assertIsNone(self._find(active_only, "general", cat["code"]),
                          "отключённая категория предлагается для новых операций")
        full = await self._cats(self.a, section="general")
        self.assertIsNotNone(self._find(full, "general", cat["code"]),
                             "отключённая категория исчезла из справочника вместе с историей")

        # Физическое удаление используемой категории запрещено.
        status, err = await self.a["api"].delete(f"/api/expense-categories/{cat['id']}")
        self.assertEqual(status, 409, err)
        self.assertIn("Отключите", str(err.get("detail", "")))

        # Неиспользуемую — можно удалить.
        status, tmp = await self.a["api"].post("/api/expense-categories/", json={
            "section": "other", "name": "Ошибочная категория",
        })
        self.assertEqual(status, 200, tmp)
        status, ok = await self.a["api"].delete(f"/api/expense-categories/{tmp['id']}")
        self.assertEqual(status, 200, ok)

    # ── 17.5/17.6 Любая активная категория: разовая и регулярная ──
    async def test_05_any_active_category_oneoff_and_recurring(self):
        status, cat = await self.a["api"].post("/api/expense-categories/", json={
            "section": "other", "name": "GPS-трекер", "code": "gps",
        })
        self.assertEqual(status, 200, cat)

        start = date.today().replace(day=1) - timedelta(days=70)
        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(start), "section": "other", "category_code": "gps",
            "plate_number": "BI422GV",
            "description": "GPS-трекер", "amount": 30.0, "currency": "EUR",
            "type": "recurring", "periodicity": "monthly", "start_date": str(start),
            "day_of_month": 1,
        })
        self.assertEqual(status, 200, res)
        self.assertEqual(res["kind"], "recurring")
        # Списания за уже наступившие месяцы создаются сразу, без кнопки «синхр.».
        self.assertGreaterEqual(res["generated"], 2, res)

        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(Transaction).where(Transaction.external_id.like(f"rexp_{res['id']}_%"))
            )).scalars().all()
            self.assertGreaterEqual(len(rows), 2)
            self.assertTrue(all(r.source == "recurring" for r in rows))
            self.assertTrue(all(r.fuel_type == "manual_other_gps" for r in rows))
            self.assertTrue(all(r.category_id == cat["id"] for r in rows))
            self.assertTrue(all(r.periodicity == "monthly" for r in rows))
            self.assertTrue(all(r.plate_number == "BI422GV" for r in rows))

        # Идемпотентность: повторная синхронизация не плодит дубли.
        status, sync1 = await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(status, 200, sync1)
        self.assertEqual(sync1["generated"], 0, "повторная синхронизация создала дубли")
        self.assertGreater(sync1["skipped"], 0)

        # Удаление одного списания не «всплывает» обратно после синхронизации.
        async with AsyncSessionLocal() as db:
            victim = (await db.execute(
                select(Transaction).where(Transaction.external_id.like(f"rexp_{res['id']}_%"))
            )).scalars().first()
            victim_id, victim_ext = victim.id, victim.external_id
        status, ok = await self.a["api"].delete(f"/api/expenses/{victim_id}")
        self.assertEqual(status, 200, ok)
        status, sync2 = await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(status, 200, sync2)
        async with AsyncSessionLocal() as db:
            again = (await db.execute(
                select(Transaction).where(Transaction.external_id == victim_ext)
            )).scalar_one_or_none()
            self.assertIsNone(again, "удалённое списание создано повторно — tombstone не работает")

    async def test_06_recurring_frequencies_and_company_scope(self):
        # Годовой платёж не должен размножаться на 12 списаний.
        year_start = date(date.today().year - 1, 1, 15)
        status, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "general", "code": "software",
            "description": "Лицензия ПО", "amount": 1200.0, "currency": "EUR",
            "frequency": "yearly", "start_date": str(year_start), "day_of_month": 15,
        })
        self.assertEqual(status, 200, res)
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(Transaction).where(Transaction.external_id.like(f"rexp_{res['id']}_%"))
            )).scalars().all()
        # Лицензия — расход компании: объект не выдумывается.
        self.assertIsNone(res["plate_number"])
        self.assertIsNone(res["trailer_plate"])
        self.assertLessEqual(len(rows), 2, "годовой платёж размножился")
        self.assertGreaterEqual(len(rows), 1)
        self.assertTrue(all(r.source == "recurring" for r in rows))

        # Прицепы: объект — номер прицепа, а не автомобиль.
        status, res2 = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "trailer", "code": "rental", "trailer_plate": "er1234",
            "description": "Аренда прицепа", "amount": 1250.0, "currency": "EUR",
            "frequency": "monthly", "start_date": str(date.today().replace(day=1)),
            "day_of_month": 1,
        })
        self.assertEqual(status, 200, res2)
        self.assertEqual(res2["trailer_plate"], "ER1234")
        # Прицепы в системе опознаются по номеру в plate_number (как и в
        # TrailerContract) — карточка прицепа группирует расходы именно по нему.
        self.assertEqual(res2["plate_number"], "ER1234")

    # ── 17.7 ZUS/PIT: не навязываются, но доступны; свои налоги добавляются ──
    async def test_07_salary_taxes_are_configurable(self):
        cats = await self._cats(self.a, section="salary_tax")
        zus = self._find(cats, "salary_tax", "zus")
        pit = self._find(cats, "salary_tax", "pit4")
        self.assertIsNotNone(zus, "ZUS отсутствует в разделе «Налоги и взносы»")
        self.assertIsNotNone(pit, "PIT отсутствует в разделе «Налоги и взносы»")
        self.assertTrue(zus["is_system"] and pit["is_system"])

        # Историческая совместимость: fuel_type налогов совпадает со старым.
        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "salary_tax", "category_code": "zus",
            "description": "ZUS за месяц", "amount": 800.0, "currency": "PLN",
        })
        self.assertEqual(status, 200, res)
        async with AsyncSessionLocal() as db:
            txn = (await db.execute(select(Transaction).where(Transaction.id == res["id"]))).scalar_one()
            self.assertEqual(txn.fuel_type, "manual_salary_zus")

        # Легаси-вызов налога тоже попадает в раздел налогов, а не в выплаты.
        status, res2 = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "category": "salary_pit4",
            "description": "PIT", "amount": 300.0, "currency": "PLN",
        })
        self.assertEqual(status, 200, res2)
        async with AsyncSessionLocal() as db:
            txn2 = (await db.execute(select(Transaction).where(Transaction.id == res2["id"]))).scalar_one()
            cat = (await db.execute(select(ExpenseCategory).where(
                ExpenseCategory.id == txn2.category_id))).scalar_one()
            self.assertEqual(cat.section, "salary_tax")

        # Свой налог другой страны.
        status, own = await self.a["api"].post("/api/expense-categories/", json={
            "section": "salary_tax", "name": "ФСЗН",
        })
        self.assertEqual(status, 200, own)
        status, res3 = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "salary_tax",
            "category_code": own["code"], "description": "ФСЗН за месяц",
            "amount": 500.0, "currency": "BYN",
        })
        self.assertEqual(status, 200, res3)
        async with AsyncSessionLocal() as db:
            txn3 = (await db.execute(select(Transaction).where(Transaction.id == res3["id"]))).scalar_one()
            self.assertEqual(txn3.fuel_type, f"manual_salary_{own['code']}")

    # ── 17.8/17.9 Страхование: страна ≠ вид; свой вид страхования ──
    async def test_08_insurance_custom_type_and_legacy_creation_closed(self):
        """Вид страхования — свободный, а создавать договоры можно ТОЛЬКО новым
        механизмом.

        Раньше здесь проверялось создание через /insurance-contracts/. По ревью
        этот путь закрыт: пока работали два механизма, один и тот же полис можно
        было завести дважды, и появлялись две независимые серии списаний по
        одному обязательству. Поэтому теперь проверяем две вещи: свой вид
        страхования по-прежнему можно завести, а старый путь создания честно
        отвечает 409 и подсказывает, где создавать.
        """
        status, own = await self.a["api"].post("/api/expense-categories/", json={
            "section": "insurance", "name": "Haftpflicht",
        })
        self.assertEqual(status, 200, own)

        # 1. Старый путь создания закрыт — и объясняет, куда идти.
        status, refused = await self.a["api"].post("/api/insurance-contracts/", json={
            "plate_number": "BI422GV", "category": own["code"],
            "start_date": str(date.today().replace(day=1)), "term_months": 12,
            "total_amount": 1500.0, "currency": "EUR", "day_of_month": 1,
        })
        self.assertEqual(status, 409, refused)
        self.assertIn("Регулярные платежи", refused["detail"])

        # 2. Через универсальный механизм свой вид страхования заводится свободно.
        status, rec = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "insurance", "code": own["code"], "plate_number": "BI422GV",
            "description": "Haftpflicht 12 мес", "amount": 125.0, "currency": "EUR",
            "frequency": "monthly", "start_date": str(date.today().replace(day=1)),
            "day_of_month": 1,
        })
        self.assertEqual(status, 200, rec)
        self.assertEqual(rec["code"], own["code"])
        self.assertEqual(rec["section"], "insurance")

        # 3. Категория и объект попали в списание этого же договора.
        status, sync = await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(status, 200, sync)
        async with AsyncSessionLocal() as db:
            row = (await db.execute(select(Transaction).where(
                Transaction.external_id.like(f"rexp_{rec['id']}_%")))).scalars().first()
        self.assertIsNotNone(row)
        self.assertEqual(row.fuel_type, f"manual_insurance_{own['code']}")
        self.assertEqual(row.category_id, own["id"])
        self.assertEqual(row.plate_number, "BI422GV")

    async def test_09_trailer_any_category_and_e100_service_fee(self):
        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "trailer",
            "category_code": "inspection", "trailer_plate": "SW12345",
            "description": "Технический осмотр прицепа", "amount": 80.0, "currency": "EUR",
        })
        self.assertEqual(status, 200, res)
        async with AsyncSessionLocal() as db:
            txn = (await db.execute(select(Transaction).where(Transaction.id == res["id"]))).scalar_one()
            self.assertEqual(txn.fuel_type, "manual_trailer_inspection")
            self.assertEqual(txn.plate_number, "SW12345")

        # Сервисный сбор E100 — отдельная системная категория с источником E100:
        # он приходит автоматически и не требует ручного создания.
        cats = await self._cats(self.a, section="other")
        fee = self._find(cats, "other", "e100_service_fee")
        self.assertIsNotNone(fee)
        self.assertTrue(fee["is_system"])
        # ... и по нему нельзя создать операцию вручную через форму.
        self.assertNotIn("manual", (fee["code"] or ""))

        # Импортированные из E100 строки связываются с этой категорией без
        # ручных действий (проверяем на прямом импорте строки).
        async with AsyncSessionLocal() as db:
            db.add(Transaction(
                company_id=self.a["company_id"], source="e100",
                external_id=f"e100_probe_{date.today()}", transaction_date=__import__("datetime").datetime.now(),
                amount=12.5, currency="EUR", fuel_type="Сервисный сбор E100", is_confirmed=True,
            ))
            await db.commit()
        status, sync = await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(status, 200, sync)

    # ── 17.11 Данные изолированы по company_id ──
    async def test_10_tenant_isolation(self):
        status, cat_a = await self.a["api"].post("/api/expense-categories/", json={
            "section": "other", "name": "Категория компании A",
        })
        self.assertEqual(status, 200, cat_a)

        # Компания B не видит категорию компании A.
        cats_b = await self._cats(self.b, section="other")
        self.assertIsNone(self._find(cats_b, "other", cat_a["code"]),
                          "категория компании A видна компании B")

        # И не может её изменить или удалить.
        status, err = await self.b["api"].patch(
            f"/api/expense-categories/{cat_a['id']}", json={"name": "Взлом"})
        self.assertEqual(status, 404, err)
        status, err = await self.b["api"].delete(f"/api/expense-categories/{cat_a['id']}")
        self.assertEqual(status, 404, err)

        # Свой расход с чужим category_id тоже невозможен.
        status, err = await self.b["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "category_id": cat_a["id"],
            "description": "Чужой расход", "amount": 10.0, "currency": "EUR",
        })
        self.assertEqual(status, 404, err)

    # ── 17.12 Права доступа ──
    async def test_11_role_permissions(self):
        async with AsyncSessionLocal() as db:
            viewer = User(company_id=self.a["company_id"], email="viewer@example.com",
                          hashed_password=get_password_hash("Test1234A"),
                          role="viewer", is_active=True)
            manager = User(company_id=self.a["company_id"], email="manager@example.com",
                           hashed_password=get_password_hash("Test1234A"),
                           role="manager", is_active=True)
            db.add_all([viewer, manager])
            await db.commit()
            await db.refresh(viewer)
            await db.refresh(manager)
            v_api = Api(self.client, create_access_token({"sub": str(viewer.id)}))
            m_api = Api(self.client, create_access_token({"sub": str(manager.id)}))

        # Viewer только читает.
        status, body = await v_api.get("/api/expense-categories/")
        self.assertEqual(status, 200, body)
        status, err = await v_api.post("/api/expense-categories/",
                                       json={"section": "other", "name": "Нельзя"})
        self.assertEqual(status, 403, err)
        status, err = await v_api.post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "other", "category_code": "fine",
            "description": "Нельзя", "amount": 1.0, "currency": "EUR"})
        self.assertEqual(status, 403, err)

        # Manager создаёт категорию и расход.
        status, cat = await m_api.post("/api/expense-categories/",
                                       json={"section": "other", "name": "Категория менеджера"})
        self.assertEqual(status, 200, cat)
        status, res = await m_api.post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "other",
            "category_code": cat["code"], "description": "Расход менеджера",
            "amount": 20.0, "currency": "EUR"})
        self.assertEqual(status, 200, res)

        # Удаление — только владелец.
        status, tmp = await m_api.post("/api/expense-categories/",
                                       json={"section": "other", "name": "Удалю позже"})
        self.assertEqual(status, 200, tmp)
        status, err = await m_api.delete(f"/api/expense-categories/{tmp['id']}")
        self.assertEqual(status, 403, err)
        status, ok = await self.a["api"].delete(f"/api/expense-categories/{tmp['id']}")
        self.assertEqual(status, 200, ok)

    # ── 17.13 Категории из истории не теряются ──
    async def test_12_backfill_from_existing_history(self):
        # Компания «с историей»: расходы уже есть, категорий ещё нет.
        async with AsyncSessionLocal() as db:
            from datetime import datetime
            company = Company(name="Gamma s.r.o.", is_active=True)
            db.add(company)
            await db.flush()
            user = User(company_id=company.id, email="owner-g@example.com",
                        hashed_password=get_password_hash("Test1234A"),
                        role="owner", is_active=True)
            db.add(user)
            await db.flush()
            for ft, ext in (("manual_other_vulkanizacia", "h1"),
                            ("manual_general_leasing_office", "h2")):
                db.add(Transaction(
                    company_id=company.id, source="manual", external_id=ext,
                    transaction_date=datetime.now(), amount=10, currency="EUR",
                    fuel_type=ft, is_confirmed=True))
            await db.commit()
            api = Api(self.client, create_access_token({"sub": str(user.id)}))

        cats = await self._cats({"api": api})
        self.assertIsNotNone(self._find(cats, "other", "vulkanizacia"),
                             "категория из истории не подхвачена")
        self.assertIsNotNone(self._find(cats, "general", "leasing_office"))
        # И такие категории помечены как пользовательские, а не системные.
        self.assertFalse(self._find(cats, "other", "vulkanizacia")["is_system"])

        # Исторический расход виден в счётчике использования.
        self.assertGreaterEqual(self._find(cats, "other", "vulkanizacia")["usage_count"], 1)

    # ── 17.14 Нераспределённые расходы и аналитика не сломаны ──
    async def test_13_analytics_pipeline_intact(self):
        # Нераспределённый расход (без привязки к авто) — как его видит страница
        # «Иные расходы»: source=manual, fuel_type=manual_other_*, пустой номер.
        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "other", "category_code": "e100_service_fee",
            "description": "Нераспределённый сбор", "amount": 727.82, "currency": "EUR",
        })
        self.assertEqual(status, 200, res)

        # Поля, на которые опирается вся существующая аналитика, остались на
        # месте и заполнены (проверяем на уровне ORM — чтение через
        # /api/transactions/ использует `AT TIME ZONE`, доступный только в
        # PostgreSQL, см. PostgresCompilationTest).
        async with AsyncSessionLocal() as db:
            txn = (await db.execute(select(Transaction).where(Transaction.id == res["id"]))).scalar_one()
        self.assertEqual(txn.source, "manual")
        self.assertIsNone(txn.plate_number, "нераспределённый расход не должен быть привязан к авто")
        self.assertIsNone(txn.vehicle_id)
        self.assertEqual(txn.fuel_type, "manual_other_e100_service_fee")
        self.assertEqual(float(txn.amount), 727.82)
        self.assertIsNotNone(txn.amount_eur, "amount_eur не заполнен — EUR-аналитика потеряла бы строку")
        self.assertTrue(txn.is_confirmed)

        if engine.dialect.name == "postgresql":
            today = str(date.today())
            status, stats = await self.a["api"].get(
                f"/api/transactions/stats?date_from={today}&date_to={today}")
            self.assertEqual(status, 200, stats)
            self.assertIn("by_fuel_type", stats)
            self.assertIn("by_vehicle", stats)
            self.assertIn("eur", stats)
            # Автоматическое распределение нераспределённых расходов опирается на
            # пустой номер у строки — она обязана быть видна в by_vehicle как Unknown.
            self.assertIn("Unknown", stats["eur"]["expenses_by_vehicle"])

            status, txns = await self.a["api"].get(
                f"/api/transactions/?date_from={today}&date_to={today}&limit=100")
            self.assertEqual(status, 200, txns)
            added = [t for t in txns if t["id"] == res["id"]]
            self.assertEqual(len(added), 1, "созданный расход не читается обратно")
            for field in ("amount", "currency", "source", "fuel_type", "amount_eur"):
                self.assertIn(field, added[0])


class FxAndDateRulesSuite(unittest.IsolatedAsyncioTestCase):
    """Курсы валют и правила дат оплаты — отдельно, потому что это два места, где
    ошибка не видна глазами: суммы в EUR просто молча становятся меньше, а
    бессрочный расход может увести итератор дат за пределы календаря."""

    async def asyncSetUp(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.main import app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.a = await self._make_tenant("Alpha", "fx-a@example.com")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def _make_tenant(self, name, email):
        async with AsyncSessionLocal() as db:
            company = Company(name=name, is_active=True)
            db.add(company)
            await db.flush()
            user = User(company_id=company.id, email=email,
                        hashed_password=get_password_hash("Test1234A"),
                        role="owner", is_active=True)
            db.add(user)
            await db.commit()
            await db.refresh(user)
            return {"company_id": company.id, "api": Api(self.client, create_access_token({"sub": str(user.id)}))}

    async def _add_rate(self, currency, rate_date, rate):
        async with AsyncSessionLocal() as db:
            from app.models.models import FxRate
            db.add(FxRate(currency=currency, rate_date=rate_date,
                          rate_to_eur=Decimal(str(rate)), source="ECB"))
            await db.commit()

    # ── Курс применяется к расходу ЛЮБОЙ категории, включая только что созданную ──
    async def test_14_fx_rate_applies_to_any_category(self):
        """Курс — свойство ОПЕРАЦИИ (валюта + дата), а не категории: у категорий
        валюты нет. Поэтому новая пользовательская категория считается ровно так
        же, как системная, — и это надо проверять, потому что иначе новые разделы
        молча выпадали бы из EUR-аналитики."""
        day = date.today() - timedelta(days=40)
        await self._add_rate("PLN", day, "0.2345")

        status, cat = await self.a["api"].post("/api/expense-categories/", json={
            "section": "other", "name": "GPS-трекер"})
        self.assertEqual(status, 200, cat)
        self.assertFalse(cat["is_system"])

        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(day), "section": "other", "category_code": cat["code"],
            "description": "GPS", "amount": 100.0, "currency": "PLN"})
        self.assertEqual(status, 200, res)

        async with AsyncSessionLocal() as db:
            txn = (await db.execute(select(Transaction).where(Transaction.id == res["id"]))).scalar_one()
        # 100 PLN × 0.2345 = 23.45 EUR, и курс записан на дату операции.
        self.assertIsNotNone(txn.fx_rate, "курс не применён к новой категории")
        self.assertEqual(float(txn.amount_eur), 23.45)
        self.assertEqual(txn.fx_rate_date, day, "курс взят не на дату операции")
        self.assertEqual(txn.fx_source, "ECB")

        # Замена валюты на EUR — курс 1.0, сумма равна исходной.
        status, res_eur = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(day), "section": "other", "category_code": cat["code"],
            "description": "GPS EUR", "amount": 40.0, "currency": "EUR"})
        self.assertEqual(status, 200, res_eur)
        async with AsyncSessionLocal() as db:
            t2 = (await db.execute(select(Transaction).where(Transaction.id == res_eur["id"]))).scalar_one()
        self.assertEqual(float(t2.amount_eur), 40.0)
        self.assertEqual(float(t2.fx_rate), 1.0)

    async def test_15_missing_rate_fails_closed_and_is_not_invented(self):
        """Нет курса в пределах окна — amount_eur остаётся NULL.

        Это осознанное «fail closed»: подставить «ближайший» или самый свежий курс
        значило бы показать в отчёте выдуманную сумму. Строка при этом видна в
        списке и в исходной валюте, а её EUR-сумма равна нулю — поэтому в
        интерфейсе есть отдельное предупреждение о строках без курса.

        Изначально тест использовал MDL, но с появлением автодогрузки Frankfurter
        MDL покрыт курсами (аудит stage8 зафиксировал устаревание теста), поэтому
        теперь используется заведомо не существующая валюта XYZ: у неё курса нет
        ни в ЕЦБ, ни во Frankfurter, ни вручную.
        """
        old = date.today() - timedelta(days=300)
        status, cat = await self.a["api"].post("/api/expense-categories/", json={
            "section": "other", "name": "Только ручной курс"})
        self.assertEqual(status, 200, cat)

        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(old), "section": "other", "category_code": cat["code"],
            "description": "Нет курса", "amount": 100.0, "currency": "XYZ"})
        self.assertEqual(status, 200, res)

        async with AsyncSessionLocal() as db:
            txn = (await db.execute(select(Transaction).where(Transaction.id == res["id"]))).scalar_one()
        self.assertIsNone(txn.amount_eur, "курс выдуман вместо честного NULL")
        self.assertIsNone(txn.fx_rate)
        # Исходная сумма сохранена — строка не потеряна.
        self.assertEqual(float(txn.amount), 100.0)
        self.assertEqual(txn.currency, "XYZ")

    async def test_16_recurring_charges_each_get_their_own_rate(self):
        """У каждого списания — курс НА ЕГО ДАТУ, а не «сегодняшний»."""
        # Курсы на первые числа пяти месяцев: списания лягут именно на них.
        months = []
        cursor = date.today().replace(day=1)
        for _ in range(6):
            months.append(cursor)
            cursor = (cursor - timedelta(days=1)).replace(day=1)
        for m in months:
            await self._add_rate("PLN", m, "0.25")

        status, cat = await self.a["api"].post("/api/expense-categories/", json={
            "section": "other", "name": "Аренда GPS"})
        self.assertEqual(status, 200, cat)
        start = months[-1]

        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(start), "section": "other", "category_code": cat["code"],
            "description": "GPS аренда", "amount": 40.0, "currency": "PLN",
            "type": "recurring", "periodicity": "monthly",
            "start_date": str(start), "day_of_month": 1})
        self.assertEqual(status, 200, res)
        self.assertEqual(res["kind"], "recurring")

        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(Transaction).where(Transaction.external_id.like(f"rexp_{res['id']}_%"))
                .order_by(Transaction.transaction_date)
            )).scalars().all()
        self.assertGreaterEqual(len(rows), 4, rows)
        for r in rows:
            self.assertIsNotNone(r.amount_eur, f"{r.external_id}: списание без курса")
            self.assertEqual(float(r.amount_eur), 10.0)   # 40 PLN × 0.25
            self.assertEqual(r.fx_rate_date, r.transaction_date.date(),
                             f"{r.external_id}: курс взят не на дату списания")

    # ── Бессрочный регулярный расход: итератор дат обязан быть конечным ──
    async def test_17_endless_recurring_is_bounded_and_dates_are_predictable(self):
        """Дата оплаты: списание ложится на `день месяца` в каждом периоде, начиная
        с первого такого дня не раньше даты старта; будущие периоды не создаются.

        Отдельно проверяется, что перебор дат для БЕССРОЧНОГО расхода конечен:
        раньше генератор уходил в год 10000 и падал ValueError у любого
        вызывающего, который просто перебирал значения без `break`.
        """
        from app.services.recurring_expense_service import iter_charge_dates, HORIZON_DATE

        # 1) Бессрочный расход: полный перебор не должен падать.
        dates = list(iter_charge_dates(date(2026, 1, 15), None, "monthly", 15))
        self.assertTrue(dates, "бессрочный расход не дал ни одной даты")
        self.assertLessEqual(dates[-1], HORIZON_DATE, "итератор вышел за горизонт")
        self.assertEqual(len(dates), 12 * (HORIZON_DATE.year - 2026) + 12, "неожиданное число периодов")
        # ...и продолжает идти с шагом в месяц
        self.assertEqual(dates[0], date(2026, 1, 15))
        self.assertEqual(dates[1], date(2026, 2, 15))
        self.assertEqual(dates[-1].day, 15)

        # 2) Первый платёж — не раньше даты старта, но в тот же месяц, если день совпал.
        self.assertEqual(list(iter_charge_dates(date(2026, 9, 15), None, "monthly", 15))[0],
                         date(2026, 9, 15))
        # Если день оплаты в месяце старта уже прошёл — первое списание в следующем месяце.
        self.assertEqual(list(iter_charge_dates(date(2026, 9, 20), None, "monthly", 15))[0],
                         date(2026, 10, 15))

        # 3) Ограничение по дате окончания соблюдается.
        self.assertEqual(
            list(iter_charge_dates(date(2026, 1, 15), date(2026, 3, 31), "monthly", 15)),
            [date(2026, 1, 15), date(2026, 2, 15), date(2026, 3, 15)])

        # 4) Годовой платёж не размножается на месяцы.
        yearly = list(iter_charge_dates(date(2026, 3, 15), date(2030, 3, 31), "yearly", 15))
        self.assertEqual(yearly, [date(2026, 3, 15), date(2027, 3, 15),
                                  date(2028, 3, 15), date(2029, 3, 15), date(2030, 3, 15)])

        # 5) Еженедельный — шаг 7 дней, и тоже конечен без даты окончания.
        weekly = list(iter_charge_dates(date(2026, 1, 1), date(2026, 1, 31), "weekly", 1))
        self.assertEqual(len(weekly), 5)
        self.assertEqual(weekly[1], date(2026, 1, 8))

        # 6) В реальном сценарии создаются только НАСТУПИВШИЕ списания.
        status, cat = await self.a["api"].post("/api/expense-categories/", json={
            "section": "general", "name": "Бухгалтерия (бессрочно)"})
        self.assertEqual(status, 200, cat)
        start = date.today().replace(day=1) - timedelta(days=75)
        status, res = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(start), "section": "general", "category_code": cat["code"],
            "description": "Бухгалтерия", "amount": 500.0, "currency": "EUR",
            "type": "recurring", "periodicity": "monthly",
            "start_date": str(start), "day_of_month": 1, "end_date": None})
        self.assertEqual(status, 200, res)
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(Transaction).where(Transaction.external_id.like(f"rexp_{res['id']}_%"))
            )).scalars().all()
        self.assertGreaterEqual(len(rows), 2)
        for r in rows:
            self.assertLessEqual(r.transaction_date.date(), date.today(),
                                 "создано списание в будущем")
        # У регулярного расхода без даты окончания в модели end_date = NULL —
        # значит, он действительно бессрочный, а не «на год по умолчанию».
        async with AsyncSessionLocal() as db:
            contract = (await db.execute(
                select(RecurringExpense).where(RecurringExpense.id == res["id"])
            )).scalar_one()
        self.assertIsNone(contract.end_date)

    # ── Даты оплаты: подпись «до 28-го» — почему именно так ──
    def test_18_day_of_month_is_capped_at_28(self):
        """Дата оплаты задаётся днём месяца 1…28 — как в уже существующих договорах.

        28 есть в любом месяце, поэтому списание никогда не «перескакивает» через
        февраль. Обратная сторона: выбрав в форме дату 29–31, пользователь получит
        день оплаты 28 (форма приводит его сама) — это стоит знать заранее.
        """
        from app.services.recurring_expense_service import iter_charge_dates
        # Февраль: день 28 существует, поэтому списание в феврале есть.
        f = list(iter_charge_dates(date(2026, 1, 28), date(2026, 2, 28), "monthly", 28))
        self.assertEqual(f, [date(2026, 1, 28), date(2026, 2, 28)])
        # Некорректный день приводится к 1, а не падает.
        self.assertEqual(list(iter_charge_dates(date(2026, 1, 1), date(2026, 1, 31), "monthly", 31)),
                         [date(2026, 1, 1)])


class PostgresCompilationTest(unittest.TestCase):
    """Диалект-специфичные ошибки не должны прятаться за SQLite-прогоном."""

    def test_schema_compiles_for_postgresql(self):
        from sqlalchemy.schema import CreateTable, CreateIndex
        from sqlalchemy.dialects import postgresql
        from app.models.models import (
            ExpenseCategory, RecurringExpense, RecurringExpenseTombstone, Transaction,
        )
        dialect = postgresql.dialect()
        for model in (ExpenseCategory, RecurringExpense, RecurringExpenseTombstone, Transaction):
            ddl = str(CreateTable(model.__table__).compile(dialect=dialect))
            self.assertIn("CREATE TABLE", ddl)
            for idx in model.__table__.indexes:
                str(CreateIndex(idx).compile(dialect=dialect))

    def test_fuel_type_contract(self):
        """fuel_type — это контракт со всей существующей историей и фильтрами."""
        from app.services.category_service import (
            fuel_type_for, parse_fuel_type, parse_legacy_category, SECTION_SALARY_TAX,
        )
        self.assertEqual(fuel_type_for("other", "fine"), "manual_other_fine")
        self.assertEqual(fuel_type_for("general", "office"), "manual_general_office")
        self.assertEqual(fuel_type_for("trailer", "rental"), "manual_trailer_rental")
        self.assertEqual(fuel_type_for("insurance", "casco"), "manual_insurance_casco")
        # Налоги делят пространство имён с выплатами — так сохранена история ZUS/PIT.
        self.assertEqual(fuel_type_for(SECTION_SALARY_TAX, "zus"), "manual_salary_zus")
        self.assertEqual(fuel_type_for(SECTION_SALARY_TAX, "pit4"), "manual_salary_pit4")

        self.assertEqual(parse_legacy_category("other_fine"), ("other", "fine"))
        self.assertEqual(parse_legacy_category("general_other"), ("general", "other"))
        self.assertEqual(parse_legacy_category("salary_zus"), ("salary", "zus"))
        self.assertEqual(parse_legacy_category("trailer_cmr"), ("trailer", "cmr"))
        self.assertEqual(parse_legacy_category("insurance_polish"), ("insurance", "polish"))
        # Не категории расхода — не должны давать пары (source/recurring и т.п.).
        self.assertIsNone(parse_legacy_category("fuel_manual"))
        self.assertIsNone(parse_legacy_category("income_fakturownia"))
        self.assertIsNone(parse_fuel_type("Сервисный сбор E100"))
        self.assertIsNone(parse_fuel_type("manual_salary"))
        self.assertEqual(parse_fuel_type("manual_other_e100"), ("other", "e100"))


def _months_back(n: int, day: int = 1) -> date:
    """Дата n месяцев назад с заданным числом месяца (день 1..28)."""
    t = date.today()
    total = (t.year * 12 + (t.month - 1)) - n
    return date(total // 12, total % 12 + 1, day)


def _months_forward(n: int, day: int = 1) -> date:
    return _months_back(-n, day)


class ScheduleSuite(unittest.IsolatedAsyncioTestCase):
    """График регулярного расхода: способы ввода суммы, пауза, остаток.

    Отдельный набор, потому что здесь проверяются не разделы и не категории, а
    арифметика договора и поведение кнопок «Остановить / Продолжить». Ошибка тут
    не видна в интерфейсе: договор выглядит нормально, но остаток и число
    списаний расходятся с реальностью.
    """

    async def asyncSetUp(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.main import app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                       base_url="http://test")
        self.a = await self._make_tenant("Alpha Sp. z o.o.", "sched-a@example.com")
        await self.a["api"].get("/api/expense-categories/")   # системный набор

    async def asyncTearDown(self):
        await self.client.aclose()

    async def _make_tenant(self, company_name, email):
        async with AsyncSessionLocal() as db:
            company = Company(name=company_name, is_active=True)
            db.add(company)
            await db.flush()
            user = User(company_id=company.id, email=email,
                        hashed_password=get_password_hash("Test1234A"),
                        full_name="Owner", role="owner", is_active=True)
            db.add(user)
            await db.commit()
            await db.refresh(user)
            return {"company_id": company.id,
                    "api": Api(self.client, create_access_token({"sub": str(user.id)}))}

    async def _contracts(self, **params):
        q = "&".join(f"{k}={v}" for k, v in params.items())
        status, body = await self.a["api"].get(f"/api/recurring-expenses/?{q}")
        self.assertEqual(status, 200, body)
        return body

    async def _charges(self, contract_id):
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(Transaction).where(
                    Transaction.external_id.like(f"rexp_{contract_id}_%"),
                    Transaction.source == "recurring",
                ).order_by(Transaction.transaction_date)
            )).scalars().all()
            return list(rows)

    # ── 1. «Всего за N списаний» + разовый взнос вначале ───────────────
    async def test_01_total_amount_with_down_payment(self):
        """Лизинг: 10 000 разово + 90 000 всего на 48 месяцев = 1 875 в месяц."""
        status, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "trailer", "code": "leasing", "description": "Лизинг ST5678",
            "trailer_plate": "ST5678",
            "input_amount": 90000, "amount_mode": "total", "total_periods": 48,
            "down_payment": 10000,
            "currency": "EUR", "frequency": "monthly",
            "start_date": str(_months_back(2)), "day_of_month": 1,
        })
        self.assertEqual(status, 200, res)
        self.assertAlmostEqual(res["amount"], 1875.00, places=2, msg="сумма за месяц")
        self.assertEqual(res["total_periods"], 48)
        self.assertAlmostEqual(res["input_amount"], 90000.00, places=2)
        self.assertAlmostEqual(res["down_payment"], 10000.00, places=2)
        # Дата окончания выведена из графика, а не оставлена пустой.
        self.assertIsNotNone(res["end_date"])
        self.assertEqual(res["end_date"], str(_months_forward(45)))
        self.assertEqual(res["status"], "active")
        self.assertEqual(res["display_status"], "active")

        charges = await self._charges(res["id"])
        down = [t for t in charges if t.external_id.endswith("_dp")]
        regular = [t for t in charges if not t.external_id.endswith("_dp")]
        self.assertEqual(len(down), 1, "разовый взнос должен быть создан один раз")
        self.assertAlmostEqual(float(down[0].amount), 10000.00, places=2)
        self.assertEqual(down[0].expense_type, "oneoff")
        # Разовый взнос НЕ считается периодом графика.
        self.assertEqual(res["paid_periods"], len(regular))
        self.assertEqual(len(regular), 3, "2 месяца назад, месяц назад и этот месяц")
        self.assertEqual(res["remaining_periods"], 48 - 3)
        self.assertAlmostEqual(res["remaining_amount"], 1875.00 * 45, places=2)
        # Итог блока «в месяц» — сумма одного списания для месячной частоты.
        self.assertAlmostEqual(res["monthly_amount"], 1875.00, places=2)

        # Повторная синхронизация не создаёт второй разовый взнос.
        await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(len([t for t in await self._charges(res["id"])
                              if t.external_id.endswith("_dp")]), 1)

    # ── 2. Ввод «за год» ───────────────────────────────────────────────
    async def test_02_yearly_amount_mode(self):
        """1 200 в год, списание помесячно → 100 в месяц."""
        status, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "insurance", "code": "casco", "plate_number": "BI422GV",
            "input_amount": 1200, "amount_mode": "yearly",
            "currency": "EUR", "frequency": "monthly",
            "start_date": str(_months_back(1)), "day_of_month": 10,
        })
        self.assertEqual(status, 200, res)
        self.assertAlmostEqual(res["amount"], 100.00, places=2)
        self.assertAlmostEqual(res["monthly_amount"], 100.00, places=2)

    # ── 3. Пауза и продолжение ─────────────────────────────────────────
    async def test_03_pause_stops_charges_and_resume_does_not_backcharge(self):
        """«Остановить» = следующих списаний нет; «Продолжить» не списывает
        задним числом за время паузы."""
        status, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "general", "code": "software", "description": "CRM",
            "amount": 50, "currency": "EUR", "frequency": "monthly",
            "start_date": str(_months_back(3)), "day_of_month": 1,
        })
        self.assertEqual(status, 200, res)
        cid = res["id"]
        self.assertEqual(len(await self._charges(cid)), 4)  # 3,2,1 мес. назад + этот

        # Имитируем паузу, которая началась два месяца назад: помечаем состояние
        # и убираем списания, которых «при паузе не было». Так проверяется само
        # правило, без ожидания реального времени.
        async with AsyncSessionLocal() as db:
            contract = (await db.execute(
                select(RecurringExpense).where(RecurringExpense.id == cid)
            )).scalar_one()
            contract.status = "paused"
            contract.is_active = False
            contract.paused_at = datetime.combine(_months_back(2), time(12, 0),
                                                 tzinfo=timezone.utc)
            # Убираем списания, которых «при паузе не было». Удаляем по id, а не
            # по сравнению дат: на SQLite даты хранятся текстом, и сравнение с
            # tz-aware параметром молча не находит строки.
            rows = (await db.execute(
                select(Transaction).where(
                    Transaction.source == "recurring",
                    Transaction.external_id.like(f"rexp\\_{cid}\\_%", escape="\\"),
                ).order_by(Transaction.transaction_date)
            )).scalars().all()
            for txn in rows[1:]:          # оставляем только самое раннее списание
                await db.delete(txn)
            await db.commit()
            kept = len(rows) - len(rows[1:])
        self.assertEqual(kept, 1, "подготовка теста: должно остаться одно списание")

        # Осталось одно списание — за месяц ДО начала паузы (3 месяца назад).
        self.assertEqual(len(await self._charges(cid)), 1)

        # Пока на паузе — синхронизация ничего не достраивает.
        st, sync = await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(st, 200, sync)
        self.assertEqual(len(await self._charges(cid)), 1,
                         "на паузе списаний появляться не должно")

        st, listed = await self.a["api"].get("/api/recurring-expenses/?status=current")
        row = next(r for r in listed if r["id"] == cid)
        self.assertEqual(row["display_status"], "paused")
        self.assertEqual(row["paid_periods"], 1)

        # Продолжаем: периоды, попавшие в паузу, НЕ создаются задним числом.
        st, resumed = await self.a["api"].patch(f"/api/recurring-expenses/{cid}/resume")
        self.assertEqual(st, 200, resumed)
        self.assertEqual(resumed["display_status"], "active")
        self.assertEqual(len(await self._charges(cid)), 1,
                         "за время паузы списания не должны появиться задним числом")
        self.assertEqual(resumed["paid_periods"], 1)

    # ── 4. Проверки ввода ──────────────────────────────────────────────
    async def test_04_validation_of_amount_modes(self):
        base = {"section": "other", "code": "fine", "currency": "EUR",
                "start_date": str(_months_back(1)), "day_of_month": 1}
        # «Всего за срок» без числа платежей — нечего делить.
        st, err = await self.a["api"].post("/api/recurring-expenses/",
                                          json={**base, "input_amount": 9000, "amount_mode": "total"})
        self.assertIn(st, (400, 422), err)
        # Сумма не задана вообще.
        st2, err2 = await self.a["api"].post("/api/recurring-expenses/", json={**base})
        self.assertIn(st2, (400, 422), err2)
        # Разовый расход без суммы.
        st3, err3 = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "other", "category_code": "fine",
            "description": "без суммы"})
        self.assertEqual(st3, 400, err3)

    # ── 5. Завершённые и будущие ───────────────────────────────────────
    async def test_05_completed_and_upcoming(self):
        # График на 2 платежа, оба в прошлом → завершён.
        st, done = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "general", "code": "bank", "description": "Банк",
            "amount": 30, "amount_mode": "period",
            "currency": "EUR", "frequency": "monthly",
            "start_date": str(_months_back(3)), "day_of_month": 1,
            "total_periods": 2,
        })
        self.assertEqual(st, 200, done)
        self.assertEqual(done["display_status"], "completed")
        self.assertEqual(done["remaining_periods"], 0)
        self.assertEqual(len(await self._charges(done["id"])), 2)
        self.assertFalse(any(r["id"] == done["id"] for r in await self._contracts(status="current")),
                         "завершённый договор не должен попадать во вкладку «Текущие»")
        self.assertTrue(any(r["id"] == done["id"] for r in await self._contracts(status="completed")))

        # Старт в будущем → «Будущие», списаний нет.
        st, future = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "general", "code": "legal", "description": "Юристы",
            "amount": 200, "currency": "EUR", "frequency": "monthly",
            "start_date": str(_months_forward(1)), "day_of_month": 5,
        })
        self.assertEqual(st, 200, future)
        self.assertEqual(future["display_status"], "upcoming")
        self.assertEqual(await self._charges(future["id"]), [])
        self.assertTrue(any(r["id"] == future["id"] for r in await self._contracts(status="upcoming")))

    # ── 6. Удаление регулярного расхода ────────────────────────────────
    async def test_06_delete_with_charges_is_refused_and_keeps_history(self):
        """PAY-01 (аудит stage8): удаление договора со списаниями больше не
        стирает проведённые операции. DELETE вернёт 409, списания и договор
        остаются; для остановки будущих начислений есть PATCH /pause."""
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "other", "code": "repair", "description": "Ремонт по абонементу",
            "amount": 120, "currency": "EUR", "frequency": "monthly",
            "start_date": str(_months_back(2)), "day_of_month": 3,
            "down_payment": 300,
        })
        self.assertEqual(st, 200, res)
        charges = await self._charges(res["id"])
        self.assertGreaterEqual(len(charges), 3)
        st, ok = await self.a["api"].delete(f"/api/recurring-expenses/{res['id']}")
        self.assertEqual(st, 409, ok)
        self.assertIn("Остановить", str(ok), "подсказка об альтернативе обязательна")
        self.assertEqual(len(await self._charges(res["id"])), len(charges),
                         "списания обязаны остаться на месте")
        st, listed = await self.a["api"].get("/api/recurring-expenses/")
        self.assertTrue(any(r["id"] == res["id"] for r in listed),
                        "договор без списаний после отказа 409 обязан остаться")

    async def test_07_delete_without_charges_succeeds(self):
        """PAY-01: договор, созданный ОШИБОЧНО и ещё не создавший ни одного
        списания, владелец удалить может — это безопасно."""
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "other", "code": "repair", "description": "Лишний договор",
            "amount": 120, "currency": "EUR", "frequency": "monthly",
            "start_date": str(_months_forward(2)), "day_of_month": 3,
        })
        self.assertEqual(st, 200, res)
        self.assertEqual(await self._charges(res["id"]), [])
        st, ok = await self.a["api"].delete(f"/api/recurring-expenses/{res['id']}")
        self.assertEqual(st, 200, ok)
        st, listed = await self.a["api"].get("/api/recurring-expenses/")
        self.assertFalse(any(r["id"] == res["id"] for r in listed))
class ReviewFixesSuite(unittest.IsolatedAsyncioTestCase):
    """Правки по код-ревью: разовый взнос, округление, пропущенные периоды,
    валидации и устойчивость кода категории. Каждый тест — на конкретный баг,
    а не «на всякий случай»: смысл этих проверок в том, чтобы ошибка не вернулась
    тихо, потому что все эти баги выглядят правдоподобно на экране."""

    async def asyncSetUp(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.main import app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                       base_url="http://test")
        self.a = await self._make_tenant("Alpha Sp. z o.o.", "owner-r@example.com")
        st, res = await self.a["api"].post("/api/vehicles", json={
            "plate_number": "AA1234", "driver_name": "Test", "is_active": True})
        assert st in (200, 201), res

    async def asyncTearDown(self):
        await self.client.aclose()

    async def _make_tenant(self, company_name, email):
        async with AsyncSessionLocal() as db:
            company = Company(name=company_name, is_active=True)
            db.add(company)
            await db.flush()
            user = User(company_id=company.id, email=email,
                        hashed_password=get_password_hash("Test1234A"),
                        full_name="Owner", role="owner", is_active=True)
            db.add(user)
            await db.commit()
            await db.refresh(user)
            return {"company_id": company.id,
                    "api": Api(self.client, create_access_token({"sub": str(user.id)}))}

    async def _charges(self, contract_id):
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(Transaction).where(
                    Transaction.external_id.like(f"rexp_{contract_id}_%"),
                    Transaction.source == "recurring",
                ).order_by(Transaction.transaction_date)
            )).scalars().all()
            return list(rows)

    async def _one(self, section, contract_id):
        st, lst = await self.a["api"].get(f"/api/recurring-expenses/?section={section}")
        self.assertEqual(st, 200, lst)
        return next(r for r in lst if r["id"] == contract_id)

    # ── P0-1: разовый взнос будущего договора не создаётся сегодня ──
    async def test_01_future_down_payment_not_created_today(self):
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "trailer", "code": "leasing", "trailer_plate": "ER9999",
            "description": "Лизинг прицепа (будущий)",
            "input_amount": 90000, "amount_mode": "total", "total_periods": 48,
            "down_payment": 10000, "frequency": "monthly",
            "start_date": str(_months_forward(2, 1)), "day_of_month": 1, "currency": "EUR",
        })
        self.assertEqual(st, 200, res)
        cid = res["id"]
        self.assertEqual(len(await self._charges(cid)), 0,
                         "у будущего договора не должно быть списаний сегодня")

        # Начало договора наступило — теперь обязаны появиться и взнос, и платежи.
        async with AsyncSessionLocal() as db:
            c = (await db.execute(
                select(RecurringExpense).where(RecurringExpense.id == cid))).scalar_one()
            c.start_date = _months_back(1, 1)
            await db.commit()
        st, sync = await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(st, 200, sync)
        rows = await self._charges(cid)
        dp = [t for t in rows if (t.external_id or "").endswith("_dp")]
        self.assertEqual(len(dp), 1, "после даты начала взнос обязан появиться")
        self.assertAlmostEqual(float(dp[0].amount), 10000.0, places=2)
        self.assertEqual(dp[0].expense_type, "oneoff")
        regular = [t for t in rows if not (t.external_id or "").endswith("_dp")]
        row = await self._one("trailer", cid)
        self.assertEqual(row["paid_periods"], len(regular),
                         "разовый взнос — не период графика, прогресс он не двигает")

    # ── P0-7: последний платёж закрывает договор ровно ──
    async def test_02_last_payment_rounds_to_total(self):
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "general", "code": "office",
            "description": "Договор 10 000 на 3 платежа",
            "input_amount": 10000, "amount_mode": "total", "total_periods": 3,
            "frequency": "monthly", "start_date": str(_months_back(3, 1)),
            "day_of_month": 1, "currency": "EUR",
        })
        self.assertEqual(st, 200, res)
        rows = await self._charges(res["id"])
        self.assertEqual(len(rows), 3, "должны быть все три периода")
        amounts = [float(t.amount) for t in rows]
        self.assertEqual(round(sum(amounts), 2), 10000.00,
                         f"сумма платежей обязана сойтись с суммой договора: {amounts}")
        self.assertEqual(amounts[-1], 3333.34,
                         "последний платёж компенсирует потерянную копейку")

    # ── P0-5: пропущенные периоды не считаются будущими платежами ──
    async def test_03_skipped_periods_counted_separately(self):
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "general", "code": "office", "description": "Зарплата офиса",
            "amount": 100, "frequency": "monthly",
            "start_date": str(_months_back(3, 1)), "day_of_month": 1, "currency": "EUR",
        })
        self.assertEqual(st, 200, res)
        cid = res["id"]
        rows = await self._charges(cid)
        self.assertEqual(len(rows), 4)
        for t in rows[-2:]:
            st, _ = await self.a["api"].delete(f"/api/expenses/{t.id}")
            self.assertEqual(st, 200)
        st, _ = await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(st, 200)
        row = await self._one("general", cid)
        self.assertEqual(row["skipped_periods"], 2)
        self.assertEqual(row["paid_periods"], 2)
        # Договор бессрочный: точного остатка нет, и это честно — не выдумываем.
        self.assertIsNone(row["remaining_periods"])
        self.assertEqual(row["display_status"], "active")

    # ── P1: валидации, которые раньше соблюдал только интерфейс ──
    async def test_04_server_side_validation(self):
        today = str(date.today())
        st, r = await self.a["api"].post("/api/expenses/", json={
            "expense_date": today, "section": "other", "category_code": "fine",
            "description": "минус", "amount": -500})
        self.assertEqual(st, 422, r)
        st, r = await self.a["api"].post("/api/expenses/", json={
            "expense_date": today, "section": "other", "category_code": "fine",
            "description": "два объекта", "amount": 10,
            "plate_number": "AA1234", "trailer_plate": "ER1234"})
        self.assertEqual(st, 400, r)
        st, r = await self.a["api"].post("/api/expenses/", json={
            "expense_date": today, "section": "general", "category_code": "office",
            "description": "офис на машину", "amount": 10, "plate_number": "AA1234"})
        self.assertEqual(st, 400, r)
        st, cats = await self.a["api"].get("/api/expense-categories/?section=other")
        target = next(c for c in cats if c["code"] == "fine")
        st, _ = await self.a["api"].patch(f"/api/expense-categories/{target['id']}",
                                         json={"is_active": False})
        self.assertEqual(st, 200)
        st, r = await self.a["api"].post("/api/expenses/", json={
            "expense_date": today, "section": "other", "category_code": "fine",
            "description": "в отключённую", "amount": 10})
        self.assertEqual(st, 400, r)
        st, r = await self.a["api"].post("/api/expenses/", json={
            "expense_date": today, "section": "other", "category_code": "parking",
            "description": "валюта", "amount": 10, "currency": "AB"})
        self.assertEqual(st, 422, r)

    # ── P0: удаление договора не задевает чужие списания ──
    async def test_06_delete_does_not_touch_other_contracts(self):
        """PAY-01 + защита от LIKE-дефекта: договор со списаниями удалить нельзя
        (409), и его списания обязаны остаться; чужие списания (rexp_15_*) —
        тем более. Раньше DELETE по договору №1 стирал и списания договора №15
        (символ «_» в LIKE — подстановочный знак). Теперь ничего не стирается.
        """
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "other", "code": "repair", "description": "Договор №1",
            "amount": 50, "frequency": "monthly",
            "start_date": str(_months_back(1, 1)), "day_of_month": 1, "currency": "EUR",
        })
        self.assertEqual(st, 200, res)
        first_id = res["id"]
        self.assertEqual(first_id, 1, "нумерация должна начинаться с 1")

        # Второй договор с ЯВНО «опасным» номером 15 — как в реальной базе.
        async with AsyncSessionLocal() as db:
            cats = (await db.execute(select(ExpenseCategory).where(
                ExpenseCategory.company_id == self.a["company_id"],
                ExpenseCategory.section == "other", ExpenseCategory.code == "repair"))).scalar_one()
            db.add(RecurringExpense(
                id=15, company_id=self.a["company_id"], category_id=cats.id,
                description="Договор №15", amount=Decimal("70"), currency="EUR",
                frequency="monthly", start_date=_months_back(1, 1), day_of_month=1,
                status="active", is_active=True, paid_periods=0,
            ))
            await db.commit()
        st, _ = await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(st, 200)

        async def ids_with(prefix):
            # Фильтр в Python по startswith, а НЕ через LIKE: шаблон `rexp_1_%`
            # в SQL совпадает и с `rexp_15_...`, то есть помощник теста повторял бы
            # ровно тот дефект, который тест и проверяет.
            async with AsyncSessionLocal() as db:
                rows = (await db.execute(select(Transaction).where(
                    Transaction.source == "recurring"))).scalars().all()
                return [t.external_id for t in rows
                        if (t.external_id or "").startswith(prefix)]

        self.assertTrue(await ids_with("rexp_15_"), "у договора №15 должны быть списания")
        first_charges = await ids_with("rexp_1_")
        self.assertTrue(first_charges, "у договора №1 тоже есть списания")

        # PAY-01: удаление договора со списаниями — 409, ничего не стирается.
        st, body = await self.a["api"].delete("/api/recurring-expenses/1")
        self.assertEqual(st, 409, body)
        self.assertEqual(await ids_with("rexp_1_"), first_charges,
                         "списания договора №1 обязаны остаться после 409")
        self.assertTrue(await ids_with("rexp_15_"),
                        "списания ЧУЖОГО договора обязаны остаться на месте")

    # ── P0-2 (продолжение): лизинг объединён с регулярными расходами ──
    async def test_07_leasing_section_seeded_and_legacy_creation_closed(self):
        """Лизинг был последней отдельной моделью. Теперь он — раздел справочника,
        а старый путь создания закрыт: иначе один договор заводился дважды."""
        st, cats = await self.a["api"].get("/api/expense-categories/?section=leasing")
        self.assertEqual(st, 200, cats)
        leasing = next((c for c in cats if c["code"] == "leasing"), None)
        self.assertIsNotNone(leasing, "в разделе «Лизинг» должна быть готовая категория")
        self.assertTrue(leasing["is_system"])

        # Старый путь создания закрыт и объясняет, куда идти.
        st, refused = await self.a["api"].post("/api/leasing-contracts/", json={
            "plate_number": "AA1234", "start_date": str(_months_back(3, 1)),
            "term_months": 48, "total_amount": 112000.0, "currency": "EUR",
            "day_of_month": 5,
        })
        self.assertEqual(st, 409, refused)
        self.assertIn("Лизинг", refused["detail"])

        # А через универсальный механизм лизинг заводится: сумма за период
        # считается из «всего 112 000 за 48 платежей».
        st, rec = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "leasing", "code": "leasing", "plate_number": "AA1234",
            "description": "PKO Leasing (#9921)", "input_amount": 112000,
            "amount_mode": "total", "total_periods": 48, "frequency": "monthly",
            "start_date": str(_months_back(3, 1)), "day_of_month": 5, "currency": "EUR",
        })
        self.assertEqual(st, 200, rec)
        self.assertAlmostEqual(rec["amount"], 2333.33, places=2)
        self.assertEqual(rec["total_periods"], 48)
        self.assertEqual(rec["display_status"], "active")

        st, _ = await self.a["api"].post("/api/recurring-expenses/sync")
        self.assertEqual(st, 200)
        rows = await self._charges(rec["id"])
        self.assertTrue(rows, "списания лизинга должны создаваться")
        self.assertEqual(rows[0].fuel_type, "manual_leasing_leasing")
        self.assertEqual(rows[0].category_id, leasing["id"])

    # ── P2: редактирование договора не переписывает прошлое ──
    async def test_08_edit_changes_future_not_history(self):
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "general", "code": "office", "description": "Аренда офиса",
            "amount": 1000, "frequency": "monthly",
            "start_date": str(_months_back(3, 1)), "day_of_month": 1, "currency": "EUR",
        })
        self.assertEqual(st, 200, res)
        cid = res["id"]
        before = await self._charges(cid)
        self.assertEqual(len(before), 4)
        self.assertEqual([float(t.amount) for t in before], [1000.0] * 4)

        # Меняем условия: 18 000 за 12 платежей (1 500 в месяц).
        st, upd = await self.a["api"].patch(f"/api/recurring-expenses/{cid}", json={
            "input_amount": 18000, "amount_mode": "total", "total_periods": 12,
        })
        self.assertEqual(st, 200, upd)
        self.assertAlmostEqual(upd["amount"], 1500.0, places=2)
        self.assertEqual(upd["total_periods"], 12)

        after = await self._charges(cid)
        self.assertEqual([float(t.amount) for t in after], [1000.0] * 4,
                         "прошлые списания — это ушедшие деньги, их нельзя переписать")
        self.assertEqual(upd["paid_periods"], 4)
        self.assertAlmostEqual(upd["remaining_amount"], 1500.0 * 8, places=2)

        # Сокращаем срок ниже уже оплаченного — договор становится завершённым.
        st, upd2 = await self.a["api"].patch(f"/api/recurring-expenses/{cid}", json={
            "total_periods": 2})
        self.assertEqual(st, 200, upd2)
        self.assertEqual(upd2["display_status"], "completed")

        # Дата окончания раньше начала — отказ.
        st, bad = await self.a["api"].patch(f"/api/recurring-expenses/{cid}", json={
            "start_date": str(date.today()), "end_date": str(_months_back(1, 1))})
        self.assertEqual(st, 400, bad)

    # ── Чистка: старые API договоров остались только для чтения ──
    async def test_09_all_legacy_contract_endpoints_are_read_only(self):
        """Ни через один старый путь нельзя завести новый договор.

        Проверяем ВСЕ четыре сразу: иначе легко починить три и забыть четвёртый —
        именно так лизинг и остался последней отдельной моделью. Списки при этом
        читаются, а закрытие/удаление ранее созданных договоров работает: старые
        данные не должны стать недоступными.
        """
        today = str(date.today().replace(day=1))
        payloads = {
            "/api/recurring-contracts/": {
                "category": "office", "description": "Офис",
                "start_date": today, "end_date": str(_months_forward(12, 1)),
                "annual_amount": 12000.0, "currency": "EUR", "day_of_month": 1},
            "/api/trailer-contracts/": {
                "plate_number": "ER1234", "category": "rental",
                "start_date": today, "term_months": 12,
                "total_amount": 6000.0, "currency": "EUR", "day_of_month": 1},
            "/api/insurance-contracts/": {
                "plate_number": "AA1234", "category": "casco",
                "start_date": today, "term_months": 12,
                "total_amount": 1500.0, "currency": "EUR", "day_of_month": 1},
            "/api/leasing-contracts/": {
                "plate_number": "AA1234", "start_date": today,
                "term_months": 48, "total_amount": 112000.0,
                "currency": "EUR", "day_of_month": 5},
        }
        for url, payload in payloads.items():
            st, body = await self.a["api"].post(url, json=payload)
            self.assertEqual(st, 409, f"{url}: создание должно быть закрыто, ответ {st} {body}")
            self.assertIn("Регулярные платежи", str(body.get("detail", "")),
                          f"{url}: отказ должен подсказывать, где создавать договор")
            st, listed = await self.a["api"].get(url)
            self.assertEqual(st, 200, f"{url}: список ранее созданных договоров должен читаться")

    # ── Импорт доходов: номер прицепа из пары «тягач/прицеп» ──
    async def test_10_income_import_captures_trailer(self):
        """В счетах описание содержит пару «тягач/прицеп», например BI329LF/QASB981.

        Раньше из неё брался только тягач, а номер прицепа выбрасывался — то есть
        связка «какой прицеп работал с какой машиной» приходила с каждым счётом и
        терялась. Теперь она сохраняется в строке дохода.
        """
        # Грузовики должны быть в парке: распознавание номера сверяется со списком
        # машин, иначе номер из счёта не подтверждается (так отсекаются номера
        # документов, похожие на номер машины).
        for plate in ("BI329LF", "BI724LE"):
            st, v = await self.a["api"].post("/api/vehicles", json={
                "plate_number": plate, "driver_name": "Test", "is_active": True})
            self.assertIn(st, (200, 201), v)

        header = ("numer,Sprzedający,Nabywca,Data wystawienia,Data sprzedaży,"
                  "Wartość brutto,Waluta,Produkt/usługa,Wartość brutto PLN")
        rows = [
            ('1001,SSCARGO,TS BIAŁYSTOK,2026-08-31,2026-08-31,1550.0,EUR,'
             '"Zlecenie transportowe Nr 1285/608/0154, CMR Nr10040627 dnia 28.08.2026, BI329LF/QASB981",6715.84'),
            ('1002,SSCARGO,LKW Walter,2026-08-31,2026-08-31,956.17,EUR,'
             '"Ridderkerk (NL) - TBC Berestovitsa (BY), BI724LE/QARP459",4142.89'),
            # Строка БЕЗ пары: номер документа «ZL1794/08/26» не должен стать прицепом.
            ('1003,SSCARGO,TS BIAŁYSTOK,2026-08-30,2026-08-30,100.0,EUR,'
             '"Zlecenie Nr 1285/608/0154, ZL1794/08/26",430.0'),
        ]
        # Перевод строки через chr(10), а не через обратный слэш-n в строке: в
        # исходнике теста такая запись осталась бы ДВУМЯ символами, и весь CSV
        # превратился бы в одну строку — импорт не увидел бы ни одной записи.
        csv_text = chr(10).join([header] + rows) + chr(10)
        st, res = await self.a["api"].post(
            "/api/import/income-csv",
            files={"file": ("income.csv", csv_text.encode("utf-8"), "text/csv")},
        )
        self.assertEqual(st, 200, res)

        async with AsyncSessionLocal() as db:
            found = (await db.execute(
                select(Transaction).where(
                    Transaction.company_id == self.a["company_id"],
                    Transaction.source == "csv_income",
                ).order_by(Transaction.external_id)
            )).scalars().all()
        self.assertEqual(len(found), 3, "должны импортироваться все три счёта")
        by_plate = {(t.plate_number or ""): (t.trailer_plate or "") for t in found}
        # Правило: из описания берём ТОЛЬКО тягач. Прицеп из пары не сохраняется.
        self.assertIn("BI329LF", by_plate, "номер тягача по-прежнему извлекается")
        self.assertIn("BI724LE", by_plate)
        self.assertEqual(set(by_plate.values()), {""},
                         "номер прицепа из импорта дохода не сохраняется")

    # ── P1: код категории детерминирован (без встроенного hash()) ──
    async def test_05_category_code_is_deterministic(self):
        from app.services.category_service import code_for_name
        self.assertEqual(code_for_name("ФСЗН"), "fszn")
        self.assertEqual(code_for_name("Mýto"), "myto")
        self.assertEqual(code_for_name("Software subscription"), "software_subscription")
        self.assertEqual(code_for_name("ФСЗН"), code_for_name("ФСЗН"))
        self.assertTrue(code_for_name("保险").startswith("cat_"))
        self.assertEqual(code_for_name("保险"), code_for_name("保险"))


class TrailerRegistrySuite(unittest.IsolatedAsyncioTestCase):
    """Реестр прицепов: ручное добавление, привязка периодом, исправление опечаток.

    Проверки опираются на то, что реально нашлось в выгрузках: прицеп работает с
    несколькими машинами (в т.ч. в одном месяце), а в номерах бывают опечатки
    («QARP49» вместо «QARP459»). Поэтому здесь и проверяется, что привязка — это
    период с историей, а опечатку можно исправить, не потеряв расходы.
    """

    async def asyncSetUp(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.main import app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                        base_url="http://test")
        self.a = await self._tenant("Alpha Sp. z o.o.", "trailer-owner@example.com")
        for plate in ("AA1234", "BI329LF", "BI724LE"):
            st, res = await self.a["api"].post("/api/vehicles", json={
                "plate_number": plate, "driver_name": "Test", "is_active": True})
            assert st in (200, 201), res

    async def asyncTearDown(self):
        await self.client.aclose()

    async def _tenant(self, name, email):
        async with AsyncSessionLocal() as db:
            company = Company(name=name, is_active=True)
            db.add(company)
            await db.flush()
            user = User(company_id=company.id, email=email,
                        hashed_password=get_password_hash("Test1234A"),
                        full_name="Owner", role="owner", is_active=True)
            db.add(user)
            await db.commit()
            await db.refresh(user)
            return {"company_id": company.id,
                    "api": Api(self.client, create_access_token({"sub": str(user.id)}))}

    async def _trailers(self):
        st, rows = await self.a["api"].get("/api/trailers")
        self.assertEqual(st, 200, rows)
        return {r["plate"]: r for r in rows}

    # ── ручное добавление и подсказка про опечатку ──
    async def test_01_manual_add_and_typo_hint(self):
        st, first = await self.a["api"].post("/api/trailers", json={"plate": "QARP459"})
        self.assertEqual(st, 201, first)

        # Номер с опечаткой: система его принимает, но подсказывает похожий.
        st, typo = await self.a["api"].post("/api/trailers", json={"plate": "qarp 49"})
        self.assertEqual(st, 201, typo)
        self.assertEqual(typo["plate"], "QARP49", "пробелы убираются, регистр приводится")
        self.assertIn("QARP459", typo["similar"],
                      "похожий номер должен быть показан как подсказка")

        # Точный дубликат — отказ.
        st, dup = await self.a["api"].post("/api/trailers", json={"plate": "QARP459"})
        self.assertEqual(st, 409, dup)

    # ── привязка закрывает предыдущую и сохраняет историю ──
    async def test_02_bind_closes_previous_keeps_history(self):
        st, tr = await self.a["api"].post("/api/trailers", json={"plate": "QASB981"})
        self.assertEqual(st, 201, tr)
        tid = tr["id"]

        st, b1 = await self.a["api"].post(f"/api/trailers/{tid}/bind",
                                         json={"plate_number": "AA1234", "from_date": "2026-06-01"})
        self.assertEqual(st, 200, b1)
        self.assertEqual(b1["closed_previous"], 0)

        # Переставили прицеп на другую машину — предыдущая привязка закрывается.
        st, b2 = await self.a["api"].post(f"/api/trailers/{tid}/bind",
                                         json={"plate_number": "BI329LF", "from_date": "2026-08-01"})
        self.assertEqual(st, 200, b2)
        self.assertEqual(b2["closed_previous"], 1)

        st, hist = await self.a["api"].get(f"/api/trailers/{tid}/bindings")
        self.assertEqual(st, 200, hist)
        self.assertEqual(len(hist), 2, "история привязок не стирается")
        closed = next(h for h in hist if h["plate_number"] == "AA1234")
        self.assertEqual(closed["to_date"], "2026-08-01")

        row = (await self._trailers())["QASB981"]
        self.assertEqual(row["binding"]["plate_number"], "BI329LF",
                         "текущей считается открытая привязка")

    # ── та же машина и другой прицеп: спрашиваем подтверждение ──
    async def test_03_truck_conflict_needs_confirmation(self):
        st, a1 = await self.a["api"].post("/api/trailers", json={"plate": "QARA778"})
        st, a2 = await self.a["api"].post("/api/trailers", json={"plate": "QARA784"})
        self.assertEqual((st, a2["id"]), (201, a2["id"]))

        st, _ = await self.a["api"].post(f"/api/trailers/{a1['id']}/bind",
                                        json={"plate_number": "BI724LE", "from_date": "2026-01-01"})
        self.assertEqual(st, 200)

        st, clash = await self.a["api"].post(f"/api/trailers/{a2['id']}/bind",
                                            json={"plate_number": "BI724LE", "from_date": "2026-02-01"})
        self.assertEqual(st, 409, clash)
        self.assertIn("QARA778", str(clash), "в отказе должен быть назван текущий прицеп")

        # Пользователь подтвердил, что у машины два прицепа (например, запасной).
        st, ok = await self.a["api"].post(f"/api/trailers/{a2['id']}/bind",
                                          json={"plate_number": "BI724LE", "from_date": "2026-02-01",
                                                "allow_parallel": True})
        self.assertEqual(st, 200, ok)

    # ── отвязка закрывает период, а не удаляет ──
    async def test_04_unbind_closes_period(self):
        st, tr = await self.a["api"].post("/api/trailers", json={"plate": "QASB983"})
        tid = tr["id"]
        st, _ = await self.a["api"].post(f"/api/trailers/{tid}/bind",
                                        json={"plate_number": "AA1234", "from_date": "2026-03-01"})
        self.assertEqual(st, 200)
        st, off = await self.a["api"].post(f"/api/trailers/{tid}/unbind",
                                          json={"to_date": "2026-09-30"})
        self.assertEqual(st, 200, off)
        row = (await self._trailers())["QASB983"]
        self.assertIsNone(row["binding"], "после отвязки текущей привязки нет")
        st, hist = await self.a["api"].get(f"/api/trailers/{tid}/bindings")
        self.assertEqual(len(hist), 1, "история сохраняется")
        self.assertEqual(hist[0]["to_date"], "2026-09-30")

    # ── исправление опечатки: расходы переезжают на правильный номер ──
    async def test_05_merge_moves_operations(self):
        st, good = await self.a["api"].post("/api/trailers", json={"plate": "QARP459"})
        st, bad = await self.a["api"].post("/api/trailers", json={"plate": "QARP49"})
        self.assertEqual(st, 201, bad)
        # Расход по «прицепу» с опечаткой — через обычную форму расхода.
        st, exp = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "trailer", "category_code": "rental",
            "description": "Аренда прицепа", "amount": 500, "trailer_plate": "QARP49"})
        self.assertEqual(st, 200, exp)

        st, merged = await self.a["api"].patch(f"/api/trailers/{bad['id']}",
                                              json={"merge_into": "QARP459"})
        self.assertEqual(st, 200, merged)
        self.assertEqual(merged["moved_operations"], 1)

        plates = await self._trailers()
        self.assertNotIn("QARP49", plates, "ошибочный номер удалён из реестра")
        async with AsyncSessionLocal() as db:
            row = (await db.execute(select(Transaction).where(
                Transaction.company_id == self.a["company_id"],
                Transaction.source == "manual"))).scalars().first()
        self.assertEqual(row.trailer_plate, "QARP459", "расход переехал на правильный прицеп")

    # ── удалять можно только пустой прицеп ──
    async def test_06_delete_guard(self):
        st, tr = await self.a["api"].post("/api/trailers", json={"plate": "QARA785"})
        tid = tr["id"]
        st, empty = await self.a["api"].post("/api/trailers", json={"plate": "QAPL005"})
        self.assertEqual(st, 201, empty)

        st, _ = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "trailer", "category_code": "repair",
            "description": "Ремонт прицепа", "amount": 120, "trailer_plate": "QARA785"})
        self.assertEqual(st, 200)

        st, refused = await self.a["api"].delete(f"/api/trailers/{tid}")
        self.assertEqual(st, 409, refused)
        self.assertIn("историю", str(refused))

        st, gone = await self.a["api"].delete(f"/api/trailers/{empty['id']}")
        self.assertEqual(st, 200, gone)
        self.assertNotIn("QAPL005", await self._trailers())

    # ── привязка к машине, которой нет в парке ──
    async def test_07_bind_needs_existing_truck(self):
        st, tr = await self.a["api"].post("/api/trailers", json={"plate": "QARA999"})
        st, bad = await self.a["api"].post(f"/api/trailers/{tr['id']}/bind",
                                          json={"plate_number": "ZZ9999", "from_date": "2026-01-01"})
        self.assertEqual(st, 400, bad)
        self.assertIn("парк", str(bad))

    # ── прицепы из счетов попадают в реестр сами ──
    async def test_08_import_does_not_touch_the_registry(self):
        header = ("numer,Sprzedający,Nabywca,Data wystawienia,Data sprzedaży,"
                  "Wartość brutto,Waluta,Produkt/usługa,Wartość brutto PLN")
        rows = ['1001,SSCARGO,TS BIAŁYSTOK,2026-08-31,2026-08-31,1550.0,EUR,'
                '"Zlecenie Nr 1285/608/0154, BI329LF/QASB981",6715.84']
        csv_text = chr(10).join([header] + rows) + chr(10)
        st, res = await self.a["api"].post(
            "/api/import/income-csv",
            files={"file": ("income.csv", csv_text.encode("utf-8"), "text/csv")})
        self.assertEqual(st, 200, res)

        plates = await self._trailers()
        self.assertNotIn("QASB981", plates,
                         "импорт дохода не заносит прицепы в реестр (только тягач)")


class Review2Suite(unittest.IsolatedAsyncioTestCase):
    """Правки по второму ревью: единые проверки на обоих входах, защита графика,
    остаток с разовым взносом, единый код категории.

    Смысл набора — закрепить, что правило одинаково работает и в форме расхода
    (/expenses/), и в отдельном ресурсе регулярных расходов (/recurring-expenses/).
    Пока проверки были только в одном месте, прямым запросом к API можно было
    создать «Аренду офиса → BI422GV» или налог, привязанный к машине.
    """

    async def asyncSetUp(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.main import app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                        base_url="http://test")
        self.a = await self._tenant("Alpha Sp. z o.o.", "review2@example.com")
        for plate in ("AA1234", "BI422GV"):
            st, res = await self.a["api"].post("/api/vehicles", json={
                "plate_number": plate, "driver_name": "Test", "is_active": True})
            assert st in (200, 201), res

    async def asyncTearDown(self):
        await self.client.aclose()

    async def _tenant(self, name, email):
        async with AsyncSessionLocal() as db:
            company = Company(name=name, is_active=True)
            db.add(company)
            await db.flush()
            user = User(company_id=company.id, email=email,
                        hashed_password=get_password_hash("Test1234A"),
                        full_name="Owner", role="owner", is_active=True)
            db.add(user)
            await db.commit()
            await db.refresh(user)
            return {"company_id": company.id,
                    "api": Api(self.client, create_access_token({"sub": str(user.id)}))}

    # ── §4, §5, §6: те же проверки на втором входе ──
    async def test_01_recurring_create_validations(self):
        base = {"description": "проверка", "amount": 100, "frequency": "monthly",
                "start_date": str(_months_back(1, 1)), "day_of_month": 1, "currency": "EUR"}

        # Общий расход (раздел компании) с машиной.
        st, r = await self.a["api"].post("/api/recurring-expenses/",
                                        json={**base, "section": "general", "code": "office",
                                              "plate_number": "BI422GV"})
        self.assertEqual(st, 400, r)

        # Налог, привязанный к машине.
        st, r = await self.a["api"].post("/api/recurring-expenses/",
                                        json={**base, "section": "salary_tax", "code": "zus",
                                              "plate_number": "BI422GV"})
        self.assertEqual(st, 400, r)

        # Раздел прицепов: расход прицепа нельзя привязать к МАШИНЕ ПАРКА.
        st, r = await self.a["api"].post("/api/recurring-expenses/",
                                        json={**base, "section": "trailer", "code": "rental",
                                              "plate_number": "BI422GV"})
        self.assertEqual(st, 400, r)

        # А настоящий прицеп — можно (номер прицепа по конвенции приходит в
        # plate_number, поэтому отдельного поля ждать не нужно).
        st, ok_trailer = await self.a["api"].post("/api/recurring-expenses/",
                                                 json={**base, "section": "trailer",
                                                       "code": "rental",
                                                       "trailer_plate": "QASB981"})
        self.assertEqual(st, 200, ok_trailer)

        # Отключённая категория — отказ.
        st, cats = await self.a["api"].get("/api/expense-categories/?section=other")
        target = next(c for c in cats if c["code"] == "fine")
        st, _ = await self.a["api"].patch(f"/api/expense-categories/{target['id']}",
                                         json={"is_active": False})
        self.assertEqual(st, 200)
        st, r = await self.a["api"].post("/api/recurring-expenses/",
                                        json={**base, "section": "other", "code": "fine"})
        self.assertEqual(st, 400, r)

    # ── §7: график заморожен, когда есть списания ──
    async def test_02_schedule_locked_after_charges(self):
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "other", "code": "repair", "description": "Ремонт",
            "amount": 100, "frequency": "monthly",
            "start_date": str(_months_back(2, 1)), "day_of_month": 1, "currency": "EUR"})
        self.assertEqual(st, 200, res)
        cid = res["id"]
        async with AsyncSessionLocal() as db:
            n = (await db.execute(select(Transaction).where(
                Transaction.company_id == self.a["company_id"]))).scalars().all()
        self.assertTrue(n, "списания должны существовать — иначе тест не о том")

        for payload, what in (
            ({"frequency": "quarterly"}, "частота"),
            ({"day_of_month": 15}, "день списания"),
            ({"start_date": str(_months_back(3, 1))}, "дата начала"),
        ):
            st, r = await self.a["api"].patch(f"/api/recurring-expenses/{cid}", json=payload)
            self.assertEqual(st, 400, f"{what}: изменение графика после списаний "
                                     f"обязано быть запрещено, ответ {st} {r}")

        # А описание и сумму менять можно — они не переписывают график.
        st, ok = await self.a["api"].patch(f"/api/recurring-expenses/{cid}",
                                          json={"description": "Ремонт (новое имя)",
                                                "input_amount": 150, "amount_mode": "period"})
        self.assertEqual(st, 200, ok)

    # ── §8, §9: дата окончания едет за числом платежей; null её очищает ──
    async def test_03_end_date_follows_total_periods_and_can_be_cleared(self):
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "other", "code": "repair", "description": "Договор",
            "amount": 100, "frequency": "monthly",
            "start_date": str(_months_back(1, 1)), "day_of_month": 1, "currency": "EUR"})
        self.assertEqual(st, 200, res)
        cid = res["id"]

        st, r1 = await self.a["api"].patch(f"/api/recurring-expenses/{cid}",
                                          json={"total_periods": 24})
        self.assertEqual(st, 200, r1)
        self.assertEqual(r1["total_periods"], 24)
        self.assertIsNotNone(r1["end_date"], "дата окончания должна появиться")
        # 24 платежа по месяцам от даты начала: последний — через 23 месяца.
        start_y, start_m = int(r1["start_date"][:4]), int(r1["start_date"][5:7])
        total = start_y * 12 + (start_m - 1) + 23
        self.assertEqual(r1["end_date"], f"{total // 12:04d}-{total % 12 + 1:02d}-01",
                         "дата окончания обязана соответствовать числу платежей")

        # Бессрочно: очищаем и дату, и число платежей.
        st, r2 = await self.a["api"].patch(f"/api/recurring-expenses/{cid}",
                                          json={"end_date": None, "total_periods": None})
        self.assertEqual(st, 200, r2)
        self.assertIsNone(r2["end_date"], "end_date=null должен ОЧИЩАТЬ дату, а не игнорироваться")
        self.assertIsNone(r2["total_periods"])
        self.assertIsNone(r2["remaining_periods"], "у бессрочного договора остатка в периодах нет")

    # ── §10: разовый взнос входит в обязательство ──
    async def test_04_remaining_includes_down_payment(self):
        st, res = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "leasing", "code": "leasing", "plate_number": "BI422GV",
            "description": "Лизинг", "input_amount": 90000, "amount_mode": "total",
            "total_periods": 48, "down_payment": 10000, "frequency": "monthly",
            "start_date": str(_months_forward(1, 5)), "day_of_month": 5, "currency": "EUR"})
        self.assertEqual(st, 200, res)
        self.assertAlmostEqual(res["amount"], 1875.0, places=2)
        # Договор ещё не начался: взнос впереди, регулярных платежей пока ноль.
        # Договор ещё не начался: впереди ВСЕ 48 платежей и разовый взнос.
        self.assertAlmostEqual(res["remaining_period_amount"], 1875.0 * 48, places=2)
        self.assertAlmostEqual(res["remaining_down_payment"], 10000.0, places=2)
        self.assertAlmostEqual(res["remaining_total_obligation"], 1875.0 * 48 + 10000.0, places=2)

        # Договор начался: взнос уже проведён, в обязательстве его нет.
        st, started = await self.a["api"].post("/api/recurring-expenses/", json={
            "section": "leasing", "code": "leasing", "plate_number": "BI422GV",
            "description": "Лизинг (начался)", "input_amount": 90000, "amount_mode": "total",
            "total_periods": 48, "down_payment": 10000, "frequency": "monthly",
            "start_date": str(_months_back(1, 5)), "day_of_month": 5, "currency": "EUR"})
        self.assertEqual(st, 200, started)
        self.assertEqual(started["remaining_down_payment"], 0,
                         "проведённый взнос не может оставаться в обязательстве")
        self.assertAlmostEqual(started["remaining_total_obligation"],
                              started["remaining_period_amount"], places=2)


    # ── P1 ревью: старые роуты синхронизации закрыты ──
    async def test_08_legacy_sync_routes_are_gone(self):
        """Старые /sync закрыты: иначе договор живёт в двух системах учёта.

        Миграция 0009 перенесла данные в общую модель, но роуты оставались
        открытыми — договор, созданный через старый API после миграции, уже не
        переносился, и по одному обязательству шли две серии платежей.

        Тип «410 Gone», а не 404: точка входа существовала и сознательно закрыта,
        и клиент должен понять, куда перейти. Чтение при этом работает — старые
        данные должны остаться видимыми.
        """
        for path in ("/api/recurring-contracts/sync", "/api/leasing-contracts/sync",
                     "/api/trailer-contracts/sync", "/api/insurance-contracts/sync"):
            st, body = await self.a["api"].post(path, json={"date_from": "2026-09-01",
                                                           "date_to": "2026-09-30"})
            self.assertEqual(st, 410, f"{path}: ожидался 410 Gone, получено {st} {body}")
            self.assertIn("recurring-expenses", str(body))

        # Чтение старых договоров не сломано.
        for path in ("/api/recurring-contracts/", "/api/leasing-contracts/",
                     "/api/trailer-contracts/", "/api/insurance-contracts/"):
            st, body = await self.a["api"].get(path)
            self.assertEqual(st, 200, f"{path}: чтение должно работать, получено {st}")


    # ── §13: /meta знает про лизинг ──
    async def test_05_meta_lists_leasing(self):
        st, meta = await self.a["api"].get("/api/expense-categories/meta")
        self.assertEqual(st, 200, meta)
        sections = [s["section"] for s in meta["sections"]]
        self.assertIn("leasing", sections,
                      "раздел «Лизинг» обязан быть в /meta — фронтенд берёт порядок оттуда")

    # ── §12: один механизм кода категории ──
    async def test_06_category_code_is_deterministic_everywhere(self):
        st, cat = await self.a["api"].post("/api/expense-categories/",
                                          json={"section": "salary_tax", "name": "ФСЗН"})
        self.assertEqual(st, 200, cat)
        self.assertEqual(cat["code"], "fszn",
                         "через админку код должен считаться так же, как через форму расхода")

    # ── §16: область применения нельзя менять у категории с историей ──
    async def test_07_object_scope_locked_with_usage(self):
        st, used = await self.a["api"].post("/api/expense-categories/",
                                           json={"section": "other", "name": "Тестовая с расходом"})
        self.assertEqual(st, 200, used)
        st, _ = await self.a["api"].post("/api/expenses/", json={
            "expense_date": str(date.today()), "section": "other", "category_code": used["code"],
            "description": "расход", "amount": 10})
        self.assertEqual(st, 200)

        st, refused = await self.a["api"].patch(f"/api/expense-categories/{used['id']}",
                                               json={"object_scope": "vehicle"})
        self.assertEqual(st, 409, refused)
        self.assertIn("истории", str(refused))

        st, empty = await self.a["api"].post("/api/expense-categories/",
                                            json={"section": "other", "name": "Пустая"})
        self.assertEqual(st, 200, empty)
        st, ok = await self.a["api"].patch(f"/api/expense-categories/{empty['id']}",
                                          json={"object_scope": "vehicle"})
        self.assertEqual(st, 200, ok)
        self.assertEqual(ok["object_scope"], "vehicle")


class PaidStateSuite(unittest.IsolatedAsyncioTestCase):
    """Оплата начислений: по умолчанию оплачено, опровергается точечно.

    Модель отражает порядок работы пользователя: почти все договоры оплачиваются
    (он оценивает это как 95%), поэтому подтверждать каждую строку — лишняя работа.
    Начисление сразу считается оплаченным, а по конкретной дате оплату снимают.
    """

    async def asyncSetUp(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.main import app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                        base_url="http://test")
        self.a = await self._tenant()
        st, v = await self.a["api"].post("/api/vehicles", json={
            "plate_number": "BI422GV", "driver_name": "T", "is_active": True})
        assert st in (200, 201), v

    async def asyncTearDown(self):
        await self.client.aclose()

    async def _tenant(self):
        async with AsyncSessionLocal() as db:
            co = Company(name="Lease Sp. z o.o.", is_active=True)
            db.add(co)
            await db.flush()
            u = User(company_id=co.id, email="paid@example.com",
                     hashed_password=get_password_hash("Test1234A"),
                     full_name="Owner", role="owner", is_active=True)
            db.add(u)
            await db.commit()
            await db.refresh(u)
            return {"company_id": co.id,
                    "api": Api(self.client, create_access_token({"sub": str(u.id)}))}

    async def _lease(self, **over):
        payload = {"section": "leasing", "code": "leasing", "plate_number": "BI422GV",
                   "description": "Лизинг", "amount": 8333.33, "frequency": "monthly",
                   "start_date": str(_months_back(3, 1)), "day_of_month": 1,
                   # Срок задаём: без него договор бессрочный, и остаток в периодах
                   # не определён — проверять «стало на один больше» не на чем.
                   "total_periods": 12, "currency": "EUR"}
        payload.update(over)
        return await self.a["api"].post("/api/recurring-expenses/", json=payload)

    async def _row(self, cid):
        st, rows = await self.a["api"].get("/api/recurring-expenses/?section=leasing")
        self.assertEqual(st, 200, rows)
        return next(r for r in rows if r["id"] == cid)

    # ── по умолчанию начисления оплачены ──
    async def test_01_charges_are_paid_by_default(self):
        st, res = await self._lease()
        self.assertEqual(st, 200, res)
        row = await self._row(res["id"])
        self.assertEqual(row["created_periods"], row["paid_periods"],
                         "только что созданные начисления считаются оплаченными")
        self.assertEqual(row["unpaid_periods"], 0)
        self.assertEqual(row["unpaid_amount"], 0)

        st, charges = await self.a["api"].get(f"/api/recurring-expenses/{res['id']}/charges")
        self.assertEqual(st, 200, charges)
        self.assertTrue(charges, "начисления должны быть видны списком")
        self.assertTrue(all(c["is_paid"] for c in charges),
                        "у всех начислений отметка оплаты стоит по умолчанию")
        self.assertTrue(all(c["kind"] == "period" for c in charges))

    # ── оплату можно опровергнуть по конкретной дате ──
    async def test_02_unconfirm_moves_charge_back_to_remaining(self):
        st, res = await self._lease()
        cid = res["id"]
        st, charges = await self.a["api"].get(f"/api/recurring-expenses/{cid}/charges")
        first = charges[0]
        before = await self._row(cid)

        st, off = await self.a["api"].post(f"/api/expenses/{first['id']}/paid",
                                          json={"is_paid": False})
        self.assertEqual(st, 200, off)
        self.assertFalse(off["is_paid"])

        after = await self._row(cid)
        self.assertEqual(after["unpaid_periods"], 1)
        self.assertEqual(after["paid_periods"], before["paid_periods"] - 1,
                         "снятая оплата больше не считается оплаченной")
        self.assertAlmostEqual(after["unpaid_amount"], before["amount"], places=2)
        # Оплату сняли — значит период снова должен оплачиваться, он в остатке.
        self.assertEqual(after["remaining_periods"], before["unpaid_periods"]
                         + before["remaining_periods"] + 1)

        # И вернуть отметку тоже можно.
        st, on = await self.a["api"].post(f"/api/expenses/{first['id']}/paid",
                                         json={"is_paid": True})
        self.assertEqual(st, 200, on)
        back = await self._row(cid)
        self.assertEqual(back["unpaid_periods"], 0)

    # ── разовый взнос виден в начислениях отдельно ──
    async def test_03_down_payment_visible_as_separate_charge(self):
        st, res = await self._lease(input_amount=100000, amount_mode="total",
                                    total_periods=12, down_payment=10000, amount=None)
        self.assertEqual(st, 200, res)
        st, charges = await self.a["api"].get(f"/api/recurring-expenses/{res['id']}/charges")
        self.assertEqual(st, 200, charges)
        dp = [c for c in charges if c["kind"] == "down_payment"]
        self.assertEqual(len(dp), 1, "разовый взнос должен быть виден как отдельная строка")
        self.assertAlmostEqual(dp[0]["amount"], 10000.0, places=2)

    # ── оплату банковских операций вручную не меняем ──
    async def test_04_external_rows_cannot_be_toggled(self):
        async with AsyncSessionLocal() as db:
            co = Company(name="X", is_active=True)
            db.add(co)
            await db.flush()
            txn = Transaction(company_id=co.id, source="e100", external_id="e100_x",
                              transaction_date=datetime.now(timezone.utc),
                              amount=Decimal("10"), currency="EUR", is_confirmed=True)
            db.add(txn)
            await db.commit()
            await db.refresh(txn)
            tid = txn.id

        st, r = await self.a["api"].post(f"/api/expenses/{tid}/paid", json={"is_paid": False})
        self.assertIn(st, (400, 404), r)


if __name__ == "__main__":
    unittest.main(verbosity=2)
