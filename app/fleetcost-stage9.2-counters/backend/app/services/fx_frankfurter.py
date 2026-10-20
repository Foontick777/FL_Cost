"""Курсы валют, которых нет в архиве ЕЦБ, — из публичного сервиса Frankfurter.

ЗАЧЕМ
-----
ЕЦБ публикует ~41 валюту. BYN, RSD, UAH, MDL, GEL и другие приходилось вводить
руками на каждую дату. Frankfurter (https://frankfurter.dev, без ключа) отдаёт
посуточные курсы 160+ валют, поэтому недостающие валюты теперь докачиваются
автоматически — по той же схеме, что и ЕЦБ: курсы лежат в общей таблице
`fx_rates` (company_id IS NULL), суммы в EUR пересчитывает `fx_autoload`.

ЧТО ВАЖНО ЗНАТЬ (проверено по документации и ответам API)
--------------------------------------------------------
* Валюты ЕЦБ отсюда НЕ берутся — для них источник прежний. Вызывающий код обязан
  отфильтровать `fx_autoload.ECB_CURRENCIES`; здесь этого не делается вслепую.
* Курс по умолчанию — УСРЕДНЁННЫЙ по нескольким центробанкам (не официальный курс
  какого-то одного). Для BYN он отличается от курса Нацбанка Беларуси примерно на
  десятые доли процента. Нужен именно официальный — `FX_FRANKFURTER_PROVIDERS=NBRB`.
* Данные посуточные, включая выходные (для BYN), поэтому «курс предыдущего дня»
  понадобится реже, чем у ЕЦБ.
* Последние знаки курса за свежие даты могут чуть поправиться — поэтому ночная
  задача перезапрашивает последнюю неделю и обновляет изменившиеся строки.
  Уже посчитанные операции от этого не меняются (они хранят свой курс).
* SLA у публичного сервиса нет. Любой сбой — не ошибка операции: строки остаются
  без EUR (это видно в интерфейсе) и попадут в следующий заход.

МНОГОКОМПАНИЙНОСТЬ
------------------
Загруженные курсы — публичные данные и общие для всех (как курсы ЕЦБ). Курс,
введённый компанией вручную, лежит с её company_id и при совпадении даты имеет
приоритет (см. `fx_service.get_rate`). Одна компания не видит и не меняет курсы
другой.
"""
from __future__ import annotations

import logging
import math
import time
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Iterable, Optional

import httpx
from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.models import FxRate

logger = logging.getLogger(__name__)

SOURCE = "FRANKFURTER"
CHUNK_DAYS = 366                 # один запрос — не больше года посуточных данных
REQUEST_TIMEOUT = 30
SUPPORTED_TTL = 24 * 3600        # список валют сервиса меняется редко
FAILED_TTL = 600                 # после сбоя список не запрашиваем 10 минут
ACTIVE_WITHIN_DAYS = 60          # валюта «живая», если данные есть за последние 60 дней
MAX_CURRENCIES_PER_CALL = 12

# Для проверок: подменяемый транспорт (httpx.MockTransport) — сети в тестах нет.
_transport: Optional[httpx.AsyncBaseTransport] = None

_supported_cache: dict = {"at": 0.0, "ttl": 0.0, "data": {}}


class FrankfurterError(Exception):
    """Сервис недоступен или ответил непонятно — повторить позже."""


class UnsupportedCurrency(FrankfurterError):
    """Сервис не знает такую валюту (или нет данных за запрошенный период)."""


def enabled() -> bool:
    return bool(settings.FX_FRANKFURTER_ENABLED)


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=settings.FX_FRANKFURTER_URL.rstrip("/"),
        timeout=REQUEST_TIMEOUT,
        headers={"User-Agent": "FleetCost/1.0 (fx autoload)"},
        transport=_transport,
    )


def _providers() -> Optional[str]:
    raw = (settings.FX_FRANKFURTER_PROVIDERS or "").strip()
    return ",".join(p.strip() for p in raw.split(",") if p.strip()) or None


# ── Список валют сервиса ────────────────────────────────────────────────────
async def supported_currencies(force: bool = False) -> dict[str, tuple[Optional[date], Optional[date]]]:
    """{код: (первая дата, последняя дата)} для валют, по которым сервис отдаёт курс.

    Кэш на сутки; при сбое — прежнее значение (или пусто) и пауза 10 минут: список
    нужен часто (подписи в интерфейсе), и недоступный сервис не должен тормозить
    каждый запрос.
    """
    if not enabled():
        return {}
    now = time.time()
    if not force and _supported_cache["data"] is not None and (now - _supported_cache["at"]) < _supported_cache["ttl"]:
        return _supported_cache["data"]
    try:
        async with _client() as c:
            r = await c.get("/v2/currencies")
            r.raise_for_status()
            items = r.json()
        if not isinstance(items, list):
            raise ValueError("unexpected /v2/currencies shape")
        out: dict[str, tuple[Optional[date], Optional[date]]] = {}
        horizon = date.today() - timedelta(days=ACTIVE_WITHIN_DAYS)
        for it in items:
            code = str(it.get("iso_code") or "").upper()
            if len(code) != 3:
                continue
            start = _to_date(it.get("start_date"))
            end = _to_date(it.get("end_date"))
            if end is not None and end < horizon:
                continue        # валюта вышла из обращения / данных давно нет
            out[code] = (start, end)
        _supported_cache.update(at=now, ttl=SUPPORTED_TTL, data=out)
        return out
    except Exception as e:  # noqa: BLE001 — недоступный сервис не ломает вызывающего
        logger.warning(f"frankfurter: список валют не получен: {type(e).__name__}: {e}")
        _supported_cache.update(at=now, ttl=FAILED_TTL, data=_supported_cache["data"] or {})
        return _supported_cache["data"]


def reset_cache() -> None:
    _supported_cache.update(at=0.0, ttl=0.0, data={})


def _to_date(v) -> Optional[date]:
    try:
        return date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


# ── Загрузка ряда ───────────────────────────────────────────────────────────
async def fetch_series(currency: str, start: date, end: date) -> dict[date, Decimal]:
    """Посуточные курсы `currency`→EUR за [start, end] (EUR за 1 единицу валюты —
    ровно то, что хранит fx_rates.rate_to_eur). Большой отрезок режется на годы."""
    currency = currency.upper()
    if currency == "EUR":
        return {}
    out: dict[date, Decimal] = {}
    cur = start
    while cur <= end:
        chunk_end = min(end, cur + timedelta(days=CHUNK_DAYS - 1))
        out.update(await _fetch_chunk(currency, cur, chunk_end))
        cur = chunk_end + timedelta(days=1)
    return out


async def _fetch_chunk(currency: str, start: date, end: date) -> dict[date, Decimal]:
    params = {"base": currency, "quotes": "EUR", "from": start.isoformat(), "to": end.isoformat()}
    providers = _providers()
    if providers:
        params["providers"] = providers
    try:
        async with _client() as c:
            r = await c.get("/v2/rates", params=params)
    except httpx.HTTPError as e:
        raise FrankfurterError(f"{type(e).__name__}: {e}") from e
    if r.status_code in (400, 404, 422):
        raise UnsupportedCurrency(f"{currency}: HTTP {r.status_code}")
    if r.status_code >= 400:
        raise FrankfurterError(f"HTTP {r.status_code}")
    try:
        rows = r.json()
    except ValueError as e:
        raise FrankfurterError("ответ не JSON") from e
    if not isinstance(rows, list):
        raise FrankfurterError("неожиданная форма ответа")
    out: dict[date, Decimal] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        d = _to_date(row.get("date"))
        if d is None or str(row.get("quote") or "EUR").upper() != "EUR":
            continue
        try:
            rate = Decimal(str(row.get("rate")))
        except (InvalidOperation, TypeError):
            continue
        # Курс обязан быть конечным и положительным: нулевой/мусорный курс дал бы
        # нулевые суммы в EUR, а это хуже, чем «курса нет».
        if not rate.is_finite() or rate <= 0:
            continue
        out[d] = rate
    return out


# ── Хранение ────────────────────────────────────────────────────────────────
async def store_series(currency: str, series: dict[date, Decimal]) -> dict:
    """Записать ряд в общую таблицу курсов (company_id IS NULL).

    Чужие записи не трогаем: строку с другим источником (например, ЕЦБ) не
    перезаписываем. Строку FRANKFURTER обновляем, если курс поправился.
    """
    if not series:
        return {"new": 0, "updated": 0, "skipped": 0}
    currency = currency.upper()
    lo, hi = min(series), max(series)
    new = updated = skipped = 0
    async with AsyncSessionLocal() as db:
        existing = {
            r.rate_date: r for r in (await db.execute(
                select(FxRate).where(and_(
                    FxRate.currency == currency,
                    FxRate.company_id.is_(None),
                    FxRate.rate_date >= lo, FxRate.rate_date <= hi,
                ))
            )).scalars().all()
        }
        fresh: list[FxRate] = []
        for d, rate in series.items():
            row = existing.get(d)
            if row is None:
                fresh.append(FxRate(currency=currency, rate_date=d, rate_to_eur=rate, source=SOURCE))
                new += 1
            elif row.source == SOURCE:
                if Decimal(str(row.rate_to_eur)) != rate:
                    row.rate_to_eur = rate
                    updated += 1
            else:
                skipped += 1
        db.add_all(fresh)
        try:
            await db.commit()
        except IntegrityError:
            # Параллельная загрузка успела вставить те же даты — повторим по одной.
            await db.rollback()
            new = 0
            for d, rate in series.items():
                try:
                    async with db.begin_nested():
                        db.add(FxRate(currency=currency, rate_date=d, rate_to_eur=rate, source=SOURCE))
                    new += 1
                except IntegrityError:
                    continue
            await db.commit()
    return {"new": new, "updated": updated, "skipped": skipped}


async def fetch_and_store(currency: str, start: date, end: date) -> dict:
    """Скачать и сохранить. Не бросает: итог — словарь со статусом."""
    currency = currency.upper()
    out = {"currency": currency, "from": start.isoformat(), "to": end.isoformat()}
    try:
        series = await fetch_series(currency, start, end)
    except UnsupportedCurrency as e:
        return {**out, "status": "unsupported", "message": str(e), "new": 0, "updated": 0, "fetched": 0}
    except FrankfurterError as e:
        return {**out, "status": "error", "message": str(e), "new": 0, "updated": 0, "fetched": 0}
    stored = await store_series(currency, series)
    return {**out, "status": "ok", "fetched": len(series), **stored}


async def fetch_many(plan: dict[str, tuple[date, date]]) -> dict:
    """Загрузить несколько валют. {валюта: (с, по)} → сводка для API/журнала."""
    results = []
    for currency, (start, end) in list(plan.items())[:MAX_CURRENCIES_PER_CALL]:
        results.append(await fetch_and_store(currency, start, end))
    ok = [r for r in results if r["status"] == "ok"]
    errors = [r for r in results if r["status"] == "error"]
    if not results:
        status = "skipped"
    elif errors and not ok:
        status = "error"
    elif errors:
        status = "partial"
    else:
        status = "ok"
    return {
        "status": status,
        "source": SOURCE,
        "results": results,
        "new_rows": sum(r["new"] for r in results),
        "updated_rows": sum(r["updated"] for r in results),
        "message": "; ".join(f"{r['currency']}: {r['message']}" for r in errors) or None,
    }


def window_for(start: date, today: Optional[date] = None, slack_days: int = 3) -> tuple[date, date]:
    """Отрезок загрузки: от `start` (с небольшим запасом назад) до сегодня."""
    today = today or date.today()
    return (min(start, today) - timedelta(days=slack_days), today)
