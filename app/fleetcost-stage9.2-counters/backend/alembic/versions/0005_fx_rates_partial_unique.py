"""fx_rates_partial_unique: настоящее UNIQUE для глобальных курсов ЕЦБ (FC-008)

Revision ID: 0005_fx_rates_partial_unique
Revises: 0004_money_typmod_repair
Create Date: 2026-09-27

ЗАЧЕМ (FC-008 из аудита)
------------------------
С 0003 на `fx_rates` стоит обычное ограничение:

    UNIQUE (company_id, currency, rate_date)

Но у глобальных курсов ЕЦБ `company_id IS NULL`, а в PostgreSQL **NULL не равен
NULL** — для UNIQUE-ограничения две строки с (NULL, PLN, 2026-09-25) считаются
РАЗНЫМИ. То есть именно для тех строк, которых в таблице больше всего, ограничение
не работает вообще и допускает любое количество дублей за одну дату.

Последствия дублей:
  • поиск курса (`fx_service._get_rate_uncached`) для точной даты идёт без
    ORDER BY и берёт «первую» строку — какую именно, решает планировщик, то есть
    значение курса становится НЕДЕТЕРМИНИРОВАННЫМ: две вставки одного и того же
    дня могут дать разные суммы в отчёте;
  • `store_rates` и исторический загрузчик защищаются поиском существующей строки
    перед вставкой, но это защита уровня приложения: два параллельных запроса
    (ежедневная задача + ручная синхронизация) оба проходят проверку и вставляют
    по строке.

ЧТО ДЕЛАЕТ ЭТА МИГРАЦИЯ
-----------------------
Два ЧАСТИЧНЫХ уникальных индекса вместо одного неработающего ограничения:

    UNIQUE (currency, rate_date)               WHERE company_id IS NULL
    UNIQUE (company_id, currency, rate_date)   WHERE company_id IS NOT NULL

Теперь уникальность гарантирует сама база, в обеих ветках.

ПОРЯДОК (важен): сначала удаляются уже существующие дубли, потом создаются
индексы — иначе CREATE UNIQUE INDEX упадёт на первой же паре. Мультиарендность не
затронута: индекс для компаний включает company_id, поэтому ручные курсы разных
компаний за одну дату друг другу не мешают.

КОГО ОСТАВЛЯЕМ ПРИ ДЕДУПЛИКАЦИИ: строку с максимальным `id` — она вставлена
последней, то есть значение в ней самое свежее. Обновление существующей строки в
`store_rates` идёт UPDATE-ом и id не меняет, поэтому «последняя вставка» и «последнее
значение» здесь совпадают. Прежнее поведение (планировщик выбирал произвольно) в
любом случае недетерминировано, так что терять нечего.

Идемпотентность: индексы создаются только если их нет, старое ограничение снимается
только если оно есть, дедупликация на чистой базе не удаляет ничего.
"""
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

log = logging.getLogger(__name__)

revision: str = "0005_fx_rates_partial_unique"
down_revision: Union[str, None] = "0004_money_typmod_repair"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ── Дедупликация ─────────────────────────────────────────────────────────────
# Написана так, чтобы одинаково работала в PostgreSQL и в SQLite (на SQLite эти же
# строки проверяются тестом): `DELETE ... USING` и window-функции из PostgreSQL
# здесь были бы короче, но тогда логику нельзя проверить без поднятого сервера.
# `NOT IN (SELECT MAX(id) ...)` безопасен: подзапрос по непустой группе, NULL не
# возвращает, поэтому и «NOT IN + NULL» не съедает весь DELETE.
DEDUPE_SQL: list[str] = [
    # 1. Глобальные курсы ЕЦБ: ровно одна строка на (currency, rate_date).
    """
    DELETE FROM fx_rates
     WHERE company_id IS NULL
       AND id NOT IN (
           SELECT MAX(id) FROM fx_rates
            WHERE company_id IS NULL
            GROUP BY currency, rate_date
       )
    """,
    # 2. Ручные курсы компаний: ровно одна строка на (company_id, currency, rate_date).
    #    Здесь id в подзапросе группируется вместе с company_id, поэтому удаление в
    #    одной компании не затрагивает одноимённый курс другой.
    """
    DELETE FROM fx_rates
     WHERE company_id IS NOT NULL
       AND id NOT IN (
           SELECT MAX(id) FROM fx_rates
            WHERE company_id IS NOT NULL
            GROUP BY company_id, currency, rate_date
       )
    """,
]

# ── Индексы ──────────────────────────────────────────────────────────────────
# (имя, колонки, предикат) — предикаты вынесены сюда, чтобы тест мог сверить их
# текст: снятие или подмена предиката тихо возвращает баг FC-008 обратно.
INDEX_SPECS: list[tuple[str, list[str], str]] = [
    ("uq_fx_rates_global_currency_date", ["currency", "rate_date"], "company_id IS NULL"),
    ("uq_fx_rates_company_currency_date_partial",
     ["company_id", "currency", "rate_date"], "company_id IS NOT NULL"),
]

# Старое ограничение: для строк с company_id IS NULL не работает (NULL != NULL),
# поэтому после появления частичных индексов оно лишнее.
LEGACY_CONSTRAINT = "uq_fx_rates_company_currency_date"


def _indexes(table: str) -> set:
    try:
        return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}
    except Exception as e:  # noqa: BLE001 — инспекция не должна валить миграцию
        log.warning(f"inspect indexes {table} failed: {e}")
        return set()


def _unique_constraints(table: str) -> set:
    try:
        return {c["name"] for c in sa.inspect(op.get_bind()).get_unique_constraints(table)}
    except Exception as e:  # noqa: BLE001
        log.warning(f"inspect unique constraints {table} failed: {e}")
        return set()


def _add_partial_unique(name: str, table: str, cols: list, where_sql: str) -> None:
    if name in _indexes(table):
        log.info(f"UNIQUE INDEX {name} on {table} already exists — skip")
        return
    op.create_index(name, table, cols, unique=True,
                    postgresql_where=sa.text(where_sql),
                    sqlite_where=sa.text(where_sql))
    log.info(f"UNIQUE INDEX {name} on {table} created ({where_sql})")


def upgrade() -> None:
    bind = op.get_bind()
    table = "fx_rates"

    # 0. Дедупликация ДО создания индексов: иначе CREATE UNIQUE INDEX падает на
    #    первой же паре, и миграция откатывается целиком.
    for stmt in DEDUPE_SQL:
        result = bind.execute(sa.text(stmt))
        removed = getattr(result, "rowcount", None)
        if removed:
            log.info(f"fx_rates: удалено дублей — {removed}")

    # 1. Снять старое ограничение (после дедупликации оно не нужно).
    if LEGACY_CONSTRAINT in _unique_constraints(table):
        op.drop_constraint(LEGACY_CONSTRAINT, table, type_="unique")
        log.info(f"UNIQUE {LEGACY_CONSTRAINT} on {table} dropped")

    # 2. Создать два частичных уникальных индекса.
    for name, cols, where_sql in INDEX_SPECS:
        _add_partial_unique(name, table, cols, where_sql)


def downgrade() -> None:
    table = "fx_rates"
    for name, _cols, _where in INDEX_SPECS:
        if name in _indexes(table):
            op.drop_index(name, table_name=table)
            log.info(f"UNIQUE INDEX {name} on {table} dropped")
    # Возвращаем прежнее (частично нерабочее) ограничение, чтобы схема совпадала с
    # моделью того времени.
    if LEGACY_CONSTRAINT not in _unique_constraints(table):
        op.create_unique_constraint(LEGACY_CONSTRAINT, table,
                                    ["company_id", "currency", "rate_date"])
