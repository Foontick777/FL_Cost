"""Проверки автозагрузки курсов и автопересчёта (app/services/fx_autoload.py).

Запуск без pytest и без базы (нужны только стандартная библиотека и SQLAlchemy —
второе лишь для того, чтобы НАПЕЧАТАТЬ SQL и убедиться, что условия отбора верные):

    cd backend && python3 tests/test_fx_autoload.py

Здесь закреплено три вещи, каждая из которых означала бы неверные суммы:

1. Набор валют, за которыми идём в архив ЕЦБ. Если в нём не хватает кода, докачка
   не запустится и строки навсегда останутся без EUR (молча, без ошибки). Если в нём
   лишний код (BYN, RSD…), архив будет скачиваться впустую на каждом импорте и
   ничего не даст. Набор сверен с самим файлом ЕЦБ — 41 валюта, ни одной лишней.

2. Отрезок докачки (`days_back_for`). Он должен закрывать дату операции и НИКОГДА не
   быть нулём для прошедшей даты: `days_back=0` в fx_service означает «весь архив с
   1999 года», то есть ровно тот медленный сценарий, ради обхода которого модуль и
   появился.

3. Условия отбора строк на пересчёт. Именно здесь разница между «пересчитали то, что
   стало точнее» и «каждый раз молотим одни и те же строки вхолостую».
"""
import os
import sys
import unittest
from datetime import date
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/db")

from app.services import fx_autoload as fa  # noqa: E402


class EcbCurrencySet(unittest.TestCase):
    """Набор валют архива ЕЦБ — сверен с eurofxref-hist.csv (41 колонка)."""

    def test_supported_currencies_are_present(self):
        for code in ("PLN", "USD", "CZK", "TRY", "RON", "HUF"):
            self.assertIn(code, fa.ECB_CURRENCIES)

    def test_currencies_absent_from_ecb_are_not_in_the_set(self):
        # Их в архиве ЕЦБ нет и не будет — курс только вручную.
        for code in ("BYN", "RSD", "UAH", "MDL", "GEL"):
            self.assertNotIn(code, fa.ECB_CURRENCIES)

    def test_set_size_matches_the_archive(self):
        # Ровно 41: в CSV 42 колонки, одна из них пустая (хвостовая запятая ЕЦБ).
        self.assertEqual(len(fa.ECB_CURRENCIES), 41)

    def test_only_manual_currencies_keeps_the_unknown_ones(self):
        self.assertEqual(fa.only_manual_currencies(["BYN", "pln", "RSD", "UAH"]),
                         ["BYN", "RSD", "UAH"])

    def test_ecb_currencies_in_ignores_case_and_duplicates(self):
        self.assertEqual(fa.ecb_currencies_in(["pln", "PLN", "byn", ""]), ["PLN"])
        self.assertEqual(fa.ecb_currencies_in([]), [])


class DownloadSpan(unittest.TestCase):
    """Отрезок докачки: закрывает дату и не превращается в «весь архив»."""

    def test_span_covers_the_operation_date_with_slack(self):
        days = fa.days_back_for(date(2026, 9, 20), today=date(2026, 9, 27))
        self.assertEqual(days, 7 + fa.DOWNLOAD_SLACK_DAYS)
        # Курс действует 14 дней назад — запаса должно хватать с избытком.
        self.assertGreater(days - 7, 14)

    def test_span_is_never_zero_for_a_past_date(self):
        # Ноль означал бы «скачать архив с 1999 года» — это и есть медленный путь.
        self.assertGreater(fa.days_back_for(date(2026, 9, 20), today=date(2026, 9, 20)), 0)

    def test_no_date_means_no_span(self):
        self.assertEqual(fa.days_back_for(None), 0)

    def test_future_date_does_not_produce_a_negative_span(self):
        self.assertEqual(fa.days_back_for(date(2027, 1, 1), today=date(2026, 9, 27)),
                         fa.DOWNLOAD_SLACK_DAYS)


class DownloadCooldown(unittest.TestCase):
    """Пауза между попытками докачки: недоступный ЕЦБ не должен тормозить импорт."""

    def setUp(self):
        fa.reset_cooldown()

    def tearDown(self):
        fa.reset_cooldown()

    def test_first_attempt_is_allowed(self):
        self.assertTrue(fa._cooldown_passed(now=1000.0))

    def test_second_attempt_inside_the_window_is_blocked(self):
        fa._mark_download(now=1000.0)
        self.assertFalse(fa._cooldown_passed(now=1000.0 + fa.DOWNLOAD_COOLDOWN_SECONDS - 1))

    def test_attempt_after_the_window_is_allowed(self):
        fa._mark_download(now=1000.0)
        self.assertTrue(fa._cooldown_passed(now=1000.0 + fa.DOWNLOAD_COOLDOWN_SECONDS))


class CooldownPolicy(unittest.TestCase):
    """Пауза после докачки: только сбой, никогда — успех.

    Проверка появилась после реальной ошибки в первой версии: пауза ставилась и после
    успешной загрузки, а она общая на процесс. В многоарендной установке это
    оставляло импорт другой компании без курсов на 10 минут — молча и с пустыми
    суммами в EUR.
    """

    def test_success_does_not_start_a_cooldown(self):
        self.assertFalse(fa.starts_cooldown({"status": "ok", "new_rows": 420}))

    def test_error_starts_a_cooldown(self):
        self.assertTrue(fa.starts_cooldown({"status": "error", "message": "timeout"}))

    def test_partial_download_starts_a_cooldown(self):
        # Часть батчей не прошла — причина системная, второй заход сразу не поможет.
        self.assertTrue(fa.starts_cooldown({"status": "partial"}))

    def test_no_attempt_no_cooldown(self):
        self.assertFalse(fa.starts_cooldown(None))


class NoteText(unittest.TestCase):
    """Текст сводки — единственное, что видит оператор."""

    def test_nothing_happened_no_note(self):
        self.assertIsNone(fa.build_note(downloaded=None, rates_added=0, recalculated=0,
                                        remaining=0, currencies=[]))

    def test_telegram_style_summary_when_rates_were_downloaded(self):
        note = fa.build_note(
            downloaded={"status": "ok", "earliest_date": "2026-09-15",
                        "latest_date": "2026-09-25"},
            rates_added=420, recalculated=17, remaining=0, currencies=[],
        )
        self.assertIn("2026-09-15", note)
        self.assertIn("420", note)
        self.assertIn("17", note)

    def test_remaining_currencies_are_named_with_their_dates(self):
        detail = [{"currency": "BYN", "rows": 3, "dates": ["2026-09-05"],
                   "needed_dates": ["2026-09-05"], "lookback_days": 14,
                   "advice": "Добавьте курс BYN на 05.09.2026."}]
        note = fa.build_note(downloaded=None, rates_added=0, recalculated=0,
                             remaining=3, currencies=["BYN"], detail=detail,
                             period={"from": "2026-09-05", "to": "2026-09-05"})
        self.assertIn("BYN", note)
        self.assertIn("05.09.2026", note)     # конкретная дата, а не только код валюты

    def test_download_without_new_dates_says_so(self):
        # Архив ответил «ok», но дат для этих строк в нём нет: без оговорки
        # «добавлено значений: 0» читалось бы как поломка докачки.
        note = fa.build_note(downloaded={"status": "ok", "new_rows": 0},
                             rates_added=0, recalculated=0, remaining=4,
                             currencies=["PLN"], detail=[])
        self.assertIn("архиве ЕЦБ дат", note)
        self.assertNotIn("добавлено значений: 0", note)

    def test_failed_download_still_produces_a_hint(self):
        # Сбой докачки (status:"error") не должен оставлять оператора без объяснения:
        # остаётся подсказка по валютам, которым курс нужен вручную.
        note = fa.build_note(downloaded={"status": "error", "message": "timeout"},
                             rates_added=0, recalculated=0, remaining=5,
                             currencies=["PLN"], detail=[])
        self.assertIn("PLN", note)
        self.assertIn("ЕЦБ", note)


class CurrencyEditPolicy(unittest.TestCase):
    """Кто какие курсы может задать вручную — и почему именно так.

    Менеджеру нужны валюты БЕЗ источника (BYN, RSD, UAH, MDL, GEL): иначе суммы в
    них вообще не попадают в EUR-аналитику. Но для валют ИЗ архива ЕЦБ ручной ввод
    перебивает официальный курс (поиск: company manual → global ECB) и молча меняет
    исторические суммы. Поэтому override — только у владельца, и проверка обязана
    быть на сервере: скрытая кнопка в интерфейсе защитой не является.
    """

    def test_owner_may_edit_any_currency(self):
        for code in ("BYN", "PLN", "USD", "EUR"):
            self.assertTrue(fa.may_edit_currency(code, "owner"), code)

    def test_manager_may_edit_only_currencies_absent_from_ecb(self):
        for code in ("BYN", "RSD", "UAH", "MDL", "GEL"):
            self.assertTrue(fa.may_edit_currency(code, "manager"), code)
        for code in ("PLN", "USD", "CZK", "GBP", "HUF"):
            self.assertFalse(fa.may_edit_currency(code, "manager"), code)

    def test_viewer_may_not_edit_anything(self):
        for role in ("viewer", None, "", "admin"):
            for code in ("BYN", "PLN"):
                self.assertFalse(fa.may_edit_currency(code, role), f"{role}/{code}")

    def test_role_may_arrive_as_an_enum(self):
        """Роль из модели — перечисление UserRole, а не строка.

        `str(UserRole.owner)` даёт «UserRole.owner», поэтому сравнение через `str()`
        ломает опознание роли: владелец не смог бы переопределить PLN, менеджер —
        получить отказ по PLN. Ошибка ловится ровно этими четырьмя строками.
        """
        from app.models.models import UserRole
        self.assertTrue(fa.may_edit_currency("PLN", UserRole.owner))
        self.assertTrue(fa.may_edit_currency("BYN", UserRole.owner))
        self.assertTrue(fa.may_edit_currency("BYN", UserRole.manager))
        self.assertFalse(fa.may_edit_currency("PLN", UserRole.manager))
        self.assertFalse(fa.may_edit_currency("BYN", UserRole.viewer))

    def test_case_and_spaces_do_not_defeat_the_rule(self):
        self.assertTrue(fa.may_edit_currency(" byn ", "manager"))
        self.assertFalse(fa.may_edit_currency("pln", "manager"))

    def test_empty_currency_is_rejected(self):
        self.assertFalse(fa.may_edit_currency("", "owner"))
        self.assertFalse(fa.may_edit_currency(None, "owner"))

    def test_refusal_explains_where_to_go(self):
        text = fa.currency_edit_refusal("PLN")
        self.assertIn("PLN", text)
        self.assertIn("владелец", text)   # к кому идти
        self.assertIn("ЕЦБ", text)        # почему нельзя
        self.assertIn("BYN", text)        # что менеджеру всё-таки можно


class RoutePermissions(unittest.TestCase):
    """Права на эндпоинтах курсов закреплены проверкой, а не договорённостью.

    Проверяем ПОВЕДЕНИЕ зависимости: вызываем её с пользователем нужной роли и
    смотрим, пропустила она его или отказала. Идентичность объектов сравнивать
    нельзя — `require_role` возвращает новую функцию на каждый вызов.

    Политика: страница «Курсы валют» целиком доступна владельцу и менеджеру —
    и ручной ввод, и загрузка истории, и пересчёт. Раньше это было разделено
    (менеджеру — только ручной ввод), но на практике это одна и та же работа, а
    разделение заставляло менеджера искать владельца ради одной кнопки.
    Просмотр (viewer) остаётся только на чтение.
    """

    @staticmethod
    def _dependency(name):
        from app.api.routes import fx_rates
        import inspect
        return inspect.signature(getattr(fx_rates, name)).parameters["current_user"].default.dependency

    def _allowed(self, name, role):
        """Пропускает ли эндпоинт пользователя этой роли."""
        import asyncio
        from types import SimpleNamespace
        from fastapi import HTTPException
        from app.models.models import UserRole
        user = SimpleNamespace(role=UserRole(role))
        try:
            asyncio.run(self._dependency(name)(user))
            return True
        except HTTPException as e:
            self.assertEqual(e.status_code, 403)
            return False

    def test_manager_can_add_and_override_currencies_manually(self):
        # Ради этого правило и менялось: менеджер сам вводит курс BYN (и любой другой
        # валюты, если понадобится) — без обращения к владельцу.
        self.assertTrue(self._allowed("add_manual_rate", "manager"))
        self.assertTrue(self._allowed("add_manual_rates_bulk", "manager"))

    def test_viewer_can_not_write_rates(self):
        self.assertFalse(self._allowed("add_manual_rate", "viewer"))
        self.assertFalse(self._allowed("add_manual_rates_bulk", "viewer"))

    def test_manager_gets_the_whole_fx_page(self):
        for name in ("sync_ecb", "sync_historical", "backfill_transactions"):
            self.assertTrue(self._allowed(name, "manager"), name)
            self.assertTrue(self._allowed(name, "owner"), name)

    def test_viewer_can_not_run_bulk_operations(self):
        for name in ("sync_ecb", "sync_historical", "backfill_transactions"):
            self.assertFalse(self._allowed(name, "viewer"), name)


class CurrencyGuardInsideHandlers(unittest.TestCase):
    """Правило по валютам стоит в САМИХ обработчиках, а не в зависимости.

    Зависимость (`require_manager`) проверяет только роль, поэтому тест прав её не
    поймает: убрать из тела функции строку с `may_edit_currency` — и менеджер снова
    сможет переопределить официальный курс PLN. Здесь вызываем обработчики напрямую:
      • отказ должен приходить ДО любого обращения к базе (иначе проверка бесполезна);
      • разрешённая валюта должна пройти дальше проверки.
    """

    class _DbTouched(Exception):
        """Сигнал «дошли до базы» — значит проверку валюты прошли."""

    class _Db:
        async def execute(self, *a, **kw):
            raise CurrencyGuardInsideHandlers._DbTouched()

    # ИМЯ ВАЖНО: `_outcome` в Python 3.11+ занято внутри TestCase — unittest
    # вызывает `self._outcome(...)`, и одноимённый метод ломает прогон
    # ошибкой «'_Outcome' object is not callable».
    def _call_handler(self, func_name, currency, role):
        import asyncio
        from types import SimpleNamespace
        from fastapi import HTTPException
        from app.api.routes import fx_rates
        from app.models.models import UserRole
        func = getattr(fx_rates, func_name)
        body = SimpleNamespace(currency=currency, rate_date=date(2026, 9, 20),
                               rate_to_eur=Decimal("0.29"), dates=[date(2026, 9, 20)])
        try:
            # company_id нужен обработчику для фильтра запроса; роль — для проверки.
            user = SimpleNamespace(role=UserRole(role), company_id=1, id=7, email="u@b.c")
            asyncio.run(func(request=None, body=body, db=self._Db(), current_user=user))
            return "прошло"
        except CurrencyGuardInsideHandlers._DbTouched:
            return "прошло"
        except HTTPException as e:
            return f"отказ {e.status_code}"

    def test_manager_is_refused_for_ecb_currency(self):
        for func in ("add_manual_rate", "add_manual_rates_bulk"):
            self.assertEqual(self._call_handler(func, "PLN", "manager"), "отказ 403", func)

    def test_manager_is_allowed_for_currency_absent_from_ecb(self):
        for func in ("add_manual_rate", "add_manual_rates_bulk"):
            self.assertEqual(self._call_handler(func, "BYN", "manager"), "прошло", func)

    def test_owner_is_allowed_for_ecb_currency(self):
        for func in ("add_manual_rate", "add_manual_rates_bulk"):
            self.assertEqual(self._call_handler(func, "PLN", "owner"), "прошло", func)

    def test_viewer_is_refused_for_anything(self):
        for func in ("add_manual_rate", "add_manual_rates_bulk"):
            self.assertEqual(self._call_handler(func, "BYN", "viewer"), "отказ 403", func)


class RefineSql(unittest.TestCase):
    """Условия отбора строк на пересчёт — печатаем SQL и проверяем состав.

    База не нужна: важен именно набор условий. Ошибка здесь не падает, а тихо
    оставляет суммы неверными, поэтому проверяется текстом запроса.
    """

    @staticmethod
    def _sql(company_id=7, **kwargs):
        q = fa.select_refine_batch(company_id, **kwargs)
        return str(q.compile(dialect=postgresql_dialect(),
                             compile_kwargs={"literal_binds": True}))

    def test_only_rows_that_can_change_are_selected(self):
        sql = self._sql()
        # Пустые строки…
        self.assertIn("transactions.amount_eur IS NULL", sql)
        # …или строки с курсом не на дату операции…
        self.assertIn("transactions.fx_rate_date", sql)
        # …но только если точный курс на дату операции уже есть.
        self.assertIn("fx_rates.rate_date", sql)
        self.assertIn("EXISTS", sql)

    def test_currency_of_the_company_has_priority_over_global(self):
        sql = self._sql()
        # Оба источника курса участвуют: свой (company_id) и глобальный ЕЦБ (NULL).
        self.assertIn("fx_rates.company_id = transactions.company_id", sql)
        self.assertIn("fx_rates.company_id IS NULL", sql)

    def test_eur_rows_and_empty_rows_are_left_alone(self):
        sql = self._sql()
        self.assertIn("transactions.currency != 'EUR'", sql)
        self.assertIn("transactions.currency IS NOT NULL", sql)
        self.assertIn("transactions.transaction_date IS NOT NULL", sql)

    def test_company_is_filtered(self):
        self.assertIn("transactions.company_id = 7", self._sql(company_id=7))
        self.assertNotIn("transactions.company_id = 7", self._sql(company_id=None))

    def test_dates_are_compared_in_utc(self):
        # Не cast(... as Date) и не func.date(): обе зависят от таймзоны сессии БД и
        # около полуночи уводят дату на сутки, то есть курс ищется не на ту дату.
        self.assertIn("timezone('UTC'", self._sql())

    def test_batch_is_bounded_and_cursor_driven(self):
        sql = self._sql(after_id=100, limit=50)
        self.assertIn("transactions.id > 100", sql)
        self.assertIn("LIMIT 50", sql)
        self.assertIn("ORDER BY transactions.id", sql)

    def test_without_nulls_the_null_branch_is_gone(self):
        # Так вызывает обычная кнопка «Пересчитать»: строки с NULL уже обработаны
        # отдельным проходом, здесь добираем только неточные.
        sql = self._sql(include_null=False)
        self.assertNotIn("amount_eur IS NULL", sql)

    def test_window_is_widened_by_a_day_on_both_ends(self):
        sql = self._sql(window=(date(2026, 9, 5), date(2026, 9, 20)))
        self.assertIn("'2026-09-04'", sql)   # левая граница с запасом на сутки
        self.assertIn("'2026-09-21'", sql)   # правая тоже

    def test_untranslatable_currency_without_manual_rate_is_excluded(self):
        # Курс BYN появиться не может, пока его не заведут руками — иначе такие
        # строки перебирались бы вхолостую на каждом пересчёте.
        sql = self._sql()
        self.assertIn("transactions.currency IN (", sql)  # список валют архива ЕЦБ


def postgresql_dialect():
    from sqlalchemy.dialects import postgresql
    return postgresql.dialect()


if __name__ == "__main__":
    unittest.main(verbosity=2)
