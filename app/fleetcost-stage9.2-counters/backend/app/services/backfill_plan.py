"""Политика обхода очереди «транзакции без amount_eur» — без обращений к БД.

ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ
----------------------
Сам обход — это чистая логика: что считать результатом, когда останавливаться,
как не проверять одну и ту же строку дважды. Здесь она не зависит ни от
SQLAlchemy, ни от httpx, поэтому её можно проверить без базы. Именно этого не
хватало раньше: цикл жил внутри `fx_service.py`, который импортирует SQLAlchemy,
и проверить его без поднятой базы было нельзя — а ошибка в цикле стоила
бесконечного запроса, 502 и сообщения «Изменения не сохранены» на фронте.

ЧТО БЫЛО СЛОМАНО
----------------
Первый вариант выбирал батч по «amount_eur IS NULL LIMIT 500» и запоминал
непереводимые строки в `no_rate_ids`, чтобы исключать их из следующих запросов.
Но исключение применялось только к строкам, которые бросили исключение
(`skip_ids`), а `amount_eur IS NULL` оставалось у непереводимых навсегда — то
есть те же 500 строк выбирались заново на каждой итерации:

    backfill batch 214: 0 ok, 0 failed, 500 without rate
    backfill batch 268: 0 ok, 0 failed, 500 without rate   ← те же 500, и так до таймаута

Курс для таких строк взять негде: приложение загружает курсы только из архива
ЕЦБ (`eurofxref-hist`), а там нет RSD, UAH, MDL, BYN и подобных валют. Хватало
одной кнопки при ≥500 таких транзакциях, чтобы занять воркер навсегда.

КАК СДЕЛАНО ТЕПЕРЬ
------------------
Обход идёт по ВОЗРАСТАЮЩЕМУ `id`, а не по «всем NULL сразу»:

    ... WHERE amount_eur IS NULL AND id > :after_id ORDER BY id LIMIT :limit

`after_id` строго растёт, поэтому каждая строка рассматривается не более одного
раза за запуск, а завершение гарантировано структурно: цикл не может выбрать то,
что уже прошёл. Списки исключений не нужны вообще — вместе с ними уходит и
дорогой `NOT IN (…)` на десятки тысяч идентификаторов.

Дополнительно есть защита `no_progress`: если источник батчей когда-нибудь снова
начнёт возвращать строки, не двигая курсор, цикл остановится, а не будет
молотить до таймаута. Это ровно тот сценарий, который случился в реальности,
и он закреплён проверкой в `tests/test_backfill_plan.py`.
"""
from __future__ import annotations

import time as _time
from datetime import date, timedelta
from typing import Any, Awaitable, Callable, Iterable, Optional

# Статусы одной строки. Возвращает их обработчик батча — так политика не знает
# ничего про БД, модели и валюты.
OK = "ok"            # amount_eur заполнен
NO_RATE = "no_rate"  # курса нет (в т.ч. валюты нет в архиве ЕЦБ) — так и останется NULL
INVALID = "invalid"  # нечего пересчитывать: нет суммы, валюты или даты
FAILED = "failed"    # обработка упала с исключением

RowResult = tuple[int, str, Optional[str], Optional[Any]]


async def drain_batches(
    process_batch: Callable[[Optional[int], int], Awaitable[list[RowResult]]],
    *,
    batch_size: int = 500,
    max_batches: int = 5000,
    time_budget_seconds: Optional[float] = 120.0,
    monotonic: Callable[[], float] = _time.monotonic,
    log: Optional[Callable[[str], None]] = None,
) -> dict:
    """Обходит очередь батчами, пока она не кончится.

    `process_batch(after_id, limit)` возвращает список
    `(row_id, status, currency, rate_date)` — строки с `row_id > after_id`,
    упорядоченные по возрастанию `row_id`, не более `limit` штук. Пустой список
    означает «очередь исчерпана».

    Останавливается по первому из условий:
      • источник вернул пустой батч — работа закончена (`truncated=False`);
      • батч короче `batch_size` — значит очередь кончилась;
      • исчерпан `time_budget_seconds` — важно, потому что запрос идёт через
        nginx с `proxy_read_timeout 120s`, и лучше вернуть честный ответ
        «осталось N», чем получить 502;
      • cursor не сдвинулся (`no_progress`) — защита от повторения прежней ошибки;
      • достигнут `max_batches`.

    Возвращает сводку; `remaining` добавляет вызывающий (ему нужен COUNT из БД).
    """
    started = monotonic()
    after_id: Optional[int] = None
    batch_num = 0
    backfilled = 0
    failed = 0
    invalid = 0
    no_rate = 0
    currencies: set[str] = set()
    first_no_rate_date = None
    last_no_rate_date = None
    # По валютам: сколько строк и на какие даты. Нужно, чтобы подсказка называла
    # КОНКРЕТНУЮ ДАТУ, а не только валюту: без даты пользователь добавляет курс
    # «сегодня», видит его в списке и не понимает, почему пересчёт снова
    # сообщает «без курса» (курс действует вперёд, а транзакции — в прошлом).
    unrated: dict[str, dict] = {}
    truncated = False
    reason: Optional[str] = None

    while True:
        if batch_num >= max_batches:
            truncated, reason = True, "max_batches"
            break
        if time_budget_seconds is not None and (monotonic() - started) >= time_budget_seconds:
            truncated, reason = True, "time_budget"
            break

        rows = await process_batch(after_id, batch_size)
        if not rows:
            break

        ids = [r[0] for r in rows]
        newest = max(ids)
        if after_id is not None and newest <= after_id:
            # Курсор не сдвинулся: источник вернул то, что уже пройдено. Раньше
            # именно это крутилось до таймаута — теперь останавливаемся и говорим
            # об этом прямо, потому что это ошибка в выборе строк, а не «всё готово».
            truncated, reason = True, "no_progress"
            if log:
                log(f"backfill: источник не двигает курсор (последний id={newest}), остановка")
            break
        after_id = newest
        batch_num += 1

        for _row_id, status, currency, rate_date in rows:
            if status == OK:
                backfilled += 1
            elif status == NO_RATE:
                no_rate += 1
                code = str(currency).upper() if currency else "—"
                currencies.add(code)
                info = unrated.setdefault(code, {"rows": 0, "dates": set(), "truncated": False})
                info["rows"] += 1
                if rate_date is not None:
                    if rate_date in info["dates"]:
                        pass
                    elif len(info["dates"]) < MAX_DATES_PER_CURRENCY:
                        info["dates"].add(rate_date)
                    else:
                        info["truncated"] = True
                if rate_date is not None:
                    if first_no_rate_date is None or rate_date < first_no_rate_date:
                        first_no_rate_date = rate_date
                    if last_no_rate_date is None or rate_date > last_no_rate_date:
                        last_no_rate_date = rate_date
            elif status == INVALID:
                invalid += 1
            else:
                failed += 1

        if log:
            # Формат строки сохранён прежним: по нему уже настроен взгляд в логи.
            log(f"backfill batch {batch_num}: {backfilled} ok, {failed} failed, {no_rate} without rate")

        if len(rows) < batch_size:
            break

    return {
        "backfilled": backfilled,
        "failed": failed,
        "invalid_rows": invalid,
        "no_rate_rows": no_rate,
        "no_rate_currencies": sorted(currencies),
        "no_rate_detail": build_unrated_detail(unrated),
        "no_rate_period": (
            {"from": str(first_no_rate_date), "to": str(last_no_rate_date)}
            if first_no_rate_date is not None else None
        ),
        "batches_processed": batch_num,
        "truncated": truncated,
        "truncated_reason": reason,
        "elapsed_seconds": round(monotonic() - started, 2),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Подсказка оператору: что делать с валютами, для которых курса нет
# ──────────────────────────────────────────────────────────────────────────────
# Курсы приходят только из архива ЕЦБ, поэтому у части валют курса не будет
# никогда. Оператору нужно сказать это словами и дать следующий шаг, иначе
# «осталось 500» выглядит как недоделка приложения.
# Сколько различных дат хранить на одну валюту для подсказки: для минимального
# набора этого более чем достаточно, а память остаётся предсказуемой.
MAX_DATES_PER_CURRENCY = 400


def minimal_rate_dates(dates: Iterable[date], lookback_days: int = 14) -> list[date]:
    """Минимальный набор дат, которые нужно завести вручную, чтобы покрыть все.

    СЕМАНТИКА ПОИСКА (fx_service.get_rate): для транзакции на дату T берётся самый
    поздний курс с датой в пределах [T - lookback_days, T]. Значит курс на дату R
    действует на транзакции с R по R + lookback_days.

    Практическое следствие, из-за которого функция и появилась: курс, добавленный
    «сегодня», НЕ покрывает старые транзакции — он действует только вперёд.
    Жадный проход по возрастанию: берём самую раннюю ещё не покрытую дату — курс
    на неё покрывает максимально длинный отрезок вперёд.
    """
    out: list[date] = []
    for d in sorted({d for d in dates if d is not None}):
        if not out or (d - out[-1]).days > lookback_days:
            out.append(d)
    return out


def _fmt(d: Optional[date]) -> str:
    return d.strftime("%d.%m.%Y") if d else "?"


def build_unrated_detail(unrated: dict[str, dict], lookback_days: int = 14) -> list[dict]:
    """Разбор по валютам: сколько строк, какие даты и что вводить вручную.

    `unrated` — {код: {"rows": int, "dates": set[date], "truncated": bool}}.
    Текст `advice` формируется здесь, чтобы фронтенд ничего не досчитывал и не
    дублировал формулировки.
    """
    out: list[dict] = []
    for code in sorted(unrated):
        info = unrated[code]
        dates = sorted(info.get("dates") or [])
        needed = minimal_rate_dates(dates, lookback_days=lookback_days)
        advice = None
        if needed:
            first = needed[0]
            covers = first + timedelta(days=lookback_days)
            advice = (f"Добавьте курс {code} на {_fmt(first)} — он покроет транзакции "
                      f"по {_fmt(covers)}, так как курс действует на свою дату и "
                      f"{lookback_days} дней вперёд. Курс, добавленный на сегодня, "
                      f"эти транзакции не покрывает.")
            if len(needed) > 1:
                advice += (f" Всего нужно значений: {len(needed)} — например "
                           + ", ".join(_fmt(d) for d in needed[:5])
                           + (" и другие." if len(needed) > 5 else "."))
        out.append({
            "currency": code,
            "rows": info.get("rows", 0),
            "dates": [d.isoformat() for d in dates],
            "dates_truncated": bool(info.get("truncated")),
            "needed_dates": [d.isoformat() for d in needed],
            "lookback_days": lookback_days,
            "advice": advice,
        })
    return out


ECB_ONLY_HINT = (
    "Курсы загружаются только из архива ЕЦБ, а там нет части валют "
    "(например, RSD, UAH, MDL, BYN, GEL). Для них курс нужно добавить вручную — "
    "после этого суммы пересчитываются автоматически."
)


def describe_unrated(currencies: Iterable[str], period: Optional[dict],
                     detail: Optional[list[dict]] = None) -> Optional[str]:
    """Текст-подсказка для сводки, или None если проблем нет."""
    codes = sorted({str(c).upper() for c in currencies if c})
    if not codes:
        return None
    where = f" ({period['from']} — {period['to']})" if period else ""
    text = f"Без курса: {', '.join(codes)}{where}. {ECB_ONLY_HINT}"
    # Конкретная дата важнее общего совета: без неё пользователь добавляет курс
    # «сегодня», видит его в списке — и пересчёт снова говорит «без курса».
    advices = [d.get("advice") for d in (detail or []) if d.get("advice")]
    if advices:
        text += " " + " ".join(advices)
    return text
