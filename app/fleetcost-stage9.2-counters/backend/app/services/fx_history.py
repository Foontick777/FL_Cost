"""Правила исторического импорта курсов — без обращений к БД.

Две вещи, которые нельзя проверять тестом, стоя внутри сервиса с базой:
форма данных и текст сбоя. Обе уже приводили к неверному диагнозу, поэтому
живут здесь, где их можно покрыть проверками (`tests/test_fx_history.py`).

ЗАЧЕМ
-----
Раньше на сбой импорта архивa ЕЦБ приложение отвечало одной догадкой:

    All 442 batches failed — likely the fx_rates table doesn't exist.
    Run `alembic upgrade head`.

Это утверждение выводилось из одного лишь факта «ни один батч не записался», а
настоящая ошибка базы оставалась только в логах контейнера строкой
`Historical FX batch 0-500 failed: …`. В этом проекте таблицу создаёт ещё и
`safety net` в `main.py` (`Base.metadata.create_all` при старте), поэтому
«таблицы нет» — маловероятная причина, а показывалась именно она: пользователь
шёл применять миграции вместо того, чтобы увидеть реальную причину.

Здесь текст собирается из ФАКТОВ: что ответила проверка схемы, какой была первая
ошибка, сколько батчей записалось. Никаких предположений в утвердительной форме —
только «таблица есть / таблицы нет / проверка не удалась».

Модуль без сторонних зависимостей, поэтому проверяется тестами без базы —
см. `tests/test_fx_failure_report.py`.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Iterable, Optional

# ──────────────────────────────────────────────────────────────────────────────
# Форма данных для записи
# ──────────────────────────────────────────────────────────────────────────────
def build_items(rates_by_date: dict[str, dict[str, Decimal]]) -> list[tuple[date, str, Decimal]]:
    """Разворачивает разобранный архив в список элементов для записи.

    КОНТРАКТ ТИПОВ — здесь была причина сбоя «All 442 batches failed».

    Даты обязаны быть объектами `datetime.date`, а НЕ строками. Раньше ключи
    разбора (`"1999-01-04"`) подставлялись прямо в условие запроса
    (`FxRate.rate_date.in_(chunk_dates)`), и сервис падал на КАЖДОМ батче с
    ошибкой драйвера:

        asyncpg.exceptions.DataError: invalid input for query argument $1:
        '1999-01-04' (expected a datetime.date …, got 'str')

    Драйвер — `postgresql+asyncpg` (см. app/core/database.py) — строго
    типизирован: он не делает неявных преобразований строка → дата, в отличие от
    psycopg2. Поэтому «работает у меня» тут не значит «работает у всех»: смена
    драйвера ломает такой код, а не только исторический импорт.

    Отсюда же следствие: импорт архива не работал никогда, таблица курсов
    наполнялась только ежедневной синхронизацией, и пересчёт старых транзакций
    объявлял «500 without rate» — а сообщение при этом отправляло применять
    миграции, потому что «ни один батч не прошёл» трактовалось как «нет таблицы».

    Возвращает список `(date, currency, rate)`; один элемент — одна строка.
    """
    items: list[tuple[date, str, Decimal]] = []
    for d_str, cur_map in rates_by_date.items():
        # Ключи уже проверены при разборе CSV (date.fromisoformat не бросил).
        d_obj = date.fromisoformat(d_str)
        for cur, rate in cur_map.items():
            items.append((d_obj, cur, rate))
    return items


def assert_items_are_typed(items: Iterable[tuple]) -> None:
    """Дешёвая страховка перед записью: строка вместо даты снова всё сломает.

    Проверка намеренно громкая: молчаливый сбой здесь стоит дороже падения.
    """
    for d_obj, _cur, _rate in items:
        if not isinstance(d_obj, date):
            raise TypeError(
                "build_items вернул дату типом "
                f"{type(d_obj).__name__} — драйвер asyncpg принимает только "
                "datetime.date (см. app/services/fx_history.py)"
            )


# Предел на число дат в одном массовом вводе курса: защита от запроса, который
# «применит курс» к тысячам дат одной кнопкой.
MAX_BULK_DATES = 200


def normalize_bulk_dates(dates: Iterable[date],
                         max_dates: int = MAX_BULK_DATES) -> tuple[list[date], int]:
    """Приводит список дат к виду для массового ввода курса.

    Возвращает `(даты, сколько_отброшено)`.

    Дубликаты убираются: пользователь может нажать кнопку массового ввода повторно,
    и без дедупликации одна и та же дата обрабатывалась бы несколько раз, а в
    журнале появлялись бы дубли записей.
    Отбрасывание сверх предела — не ошибка ввода, а защита: сообщаем количество,
    чтобы вызывающий мог сказать пользователю, что часть дат не применена.
    """
    uniq = sorted({d for d in dates if d is not None})
    if len(uniq) <= max_dates:
        return uniq, 0
    return uniq[:max_dates], len(uniq) - max_dates


# Сколько неудачных батчей подряд при нуле успешных считаем системной причиной.
# 442 батча по 500 строк — это 442 лишних round-trip к БД, если причина общая
# (нет прав, нет таблицы, сработал лимит времени). Дубликатов досрочная
# остановка не создаёт: перед вставкой наличие курса проверяется.
ABORT_AFTER_FAILED_BATCHES = 3


def should_abort_early(batches_ok: int, batches_failed: int,
                       limit: int = ABORT_AFTER_FAILED_BATCHES) -> bool:
    """Пора ли прекратить долбить базу, если причина явно системная.

    Останавливаемся, только когда НИ ОДИН батч не прошёл: если часть батчей
    записывается, сбой может быть привязан к конкретным данным (например, к
    одной кривой строке), и остальные батчи имеет смысл обработать.
    """
    return batches_ok == 0 and batches_failed >= limit


def format_diagnostics(diag: Optional[dict]) -> str:
    """Факты о схеме одной строкой. Возвращает "" если фактов нет."""
    if not diag:
        return ""
    bits: list[str] = []
    exists = diag.get("table_exists")
    if exists is True:
        rows = diag.get("rows")
        global_rows = diag.get("global_rows")
        detail = f" строк: {rows}" if isinstance(rows, int) else ""
        if isinstance(global_rows, int):
            detail += f", глобальных (ЕЦБ): {global_rows}"
        bits.append(f"таблица fx_rates есть{detail}")
    elif exists is False:
        bits.append("таблицы fx_rates НЕТ — её создаёт миграция (`alembic upgrade head`)")
    else:
        bits.append("проверить таблицу fx_rates не удалось")
    if diag.get("has_company_id") is False:
        bits.append("колонки company_id нет — миграции применены не до конца")
    if diag.get("alembic_version_missing") is True:
        bits.append("таблицы alembic_version нет — миграции, похоже, не запускались")
    if diag.get("alembic_revision"):
        bits.append(f"ревизия alembic: {diag['alembic_revision']}")
    if diag.get("probe_error"):
        bits.append(f"сама проверка схемы вернула ошибку: {diag['probe_error']}")
    return "Проверка схемы: " + "; ".join(bits) + "."


def summarize_batch_failures(*, batches_ok: int, batches_failed: int, total_items: int,
                             first_error: Optional[str], diagnostics: Optional[dict] = None,
                             aborted_early: bool = False) -> str:
    """Связный текст: что произошло, что об этом известно точно и что делать."""
    parts: list[str] = []
    if batches_ok == 0:
        parts.append(f"Не записался ни один батч из {batches_failed} "
                     f"(всего курсов к записи: {total_items}).")
    else:
        parts.append(f"Записалось {batches_ok} батчей, не записалось {batches_failed} "
                     f"(всего курсов к записи: {total_items}).")

    # Настоящая ошибка базы — до всего остального: остальное лишь контекст.
    parts.append(f"Ошибка базы: {first_error}." if first_error
                 else "Ошибка базы: текст не получен (смотрите логи сервиса).")

    diag_text = format_diagnostics(diagnostics)
    if diag_text:
        parts.append(diag_text)

    if aborted_early:
        parts.append("Остановлено досрочно: первые батчи падали одинаково, поэтому "
                     "остальные не отправлялись — это не потеря работы.")

    # Дальнейшие шаги — по фактам, а не по догадке.
    if diagnostics and diagnostics.get("table_exists") is False:
        parts.append("Что делать: выполнить `alembic upgrade head` в контейнере backend.")
    elif diagnostics and diagnostics.get("has_company_id") is False:
        parts.append("Что делать: довести миграции до конца (`alembic upgrade head`).")
    else:
        parts.append("Что делать: смотреть `docker compose logs backend` по строке "
                     "«Historical FX batch … failed» — там первичная ошибка базы. "
                     "Частые причины при существующей таблице: у пользователя БД нет прав "
                     "на INSERT, схема расходится с моделью после неполных миграций, "
                     "сработал лимит времени запроса.")
    parts.append("Повторный запуск не создаёт дубликатов: перед вставкой наличие курса "
                 "за этой датой проверяется, поэтому уже записанное просто обновится.")
    return " ".join(parts)


def summarize_partial(*, batches_ok: int, batches_failed: int, first_error: Optional[str]) -> str:
    """Случай «часть батчей записалась»: нельзя показывать как полный успех."""
    text = (f"Архив загружен не полностью: записалось {batches_ok} батчей, "
            f"не записалось {batches_failed}.")
    if first_error:
        text += f" Первая ошибка: {first_error}."
    text += (" Повторный запуск продолжит: уже записанные курсы обновятся, "
             "пропущенные добавятся.")
    return text
