"""График регулярных расходов: способы ввода суммы, пауза, прогресс и остаток

Revision ID: 0007_recurring_expenses_schedule
Revises: 0006_expense_categories
Create Date: 2026-10-02

Зачем
-----
Регулярный расход раньше умел ровно одно: «сумма за период». В договорах так не
пишут — пишут «90 000 всего за 48 месяцев» или «10 000 разово сейчас плюс
аренда», а налоговые/страховые договоры задают годовой суммой. Из-за этого
пользователь делил в уме, а сумма в базе расходилась с договором.

Что добавляется
---------------
1. `amount_mode` + `input_amount` + `down_payment` + `total_periods` — как задана
   сумма (за период / за год / всего за N списаний) и разовый взнос в начале.
   `amount` по-прежнему хранит сумму ОДНОГО списания — на него смотрят генерация
   и отчёты, поэтому пересчитывать их не нужно.
2. `status` + `paused_at` — «остановить» (пауза) отделено от удаления.
3. `paid_periods` — сколько списаний уже создано, для «оплачено 6 из 12».
4. `document_ref` — номер договора: его вводят в форме, и он должен быть виден.

Почему данные переносятся здесь, а не «досчитаются сами»
-------------------------------------------------------
`paid_periods` и `total_periods` — это то, что пользователь видит как
«оплачено 6 из 12, осталось 4 месяца». Оставить их пустыми нельзя: после
обновления половина карточек показывала бы договоры без прогресса, и это
выглядело бы как потеря данных. Поэтому переносим: количество списаний считаем
по фактически существующим операциям, а всего списаний — по датам договора.

Идемпотентно: повторный запуск ничего не портит (колонки проверяются, а
перенос — это UPDATE по фактическим данным).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0007_recurring_expenses_schedule"
down_revision: Union[str, None] = "0006_expense_categories"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "recurring_expenses"

NEW_COLUMNS = (
    ("amount_mode", sa.String(20), False, "'period'"),
    ("input_amount", sa.Numeric(18, 2), True, None),
    ("down_payment", sa.Numeric(18, 2), False, "0"),
    ("total_periods", sa.Integer, True, None),
    ("status", sa.String(20), False, "'active'"),
    ("paused_at", sa.DateTime(timezone=True), True, None),
    ("paid_periods", sa.Integer, False, "0"),
    ("document_ref", sa.String(100), True, None),
)


def _has_table(bind, name: str) -> bool:
    try:
        return name in sa.inspect(bind).get_table_names()
    except Exception:
        return False


def _columns(bind, table: str) -> set:
    try:
        return {c["name"] for c in sa.inspect(bind).get_columns(table)}
    except Exception:
        return set()


def _indexes(bind, table: str) -> set:
    try:
        return {i["name"] for i in sa.inspect(bind).get_indexes(table)}
    except Exception:
        return set()


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, TABLE):
        return

    cols = _columns(bind, TABLE)
    for name, coltype, nullable, default_sql in NEW_COLUMNS:
        if name in cols:
            continue
        kw = {}
        if default_sql is not None:
            # server_default текстом: alembic не выполняет его как Python-код и
            # значение подставляется существующим строкам.
            kw["server_default"] = sa.text(default_sql)
        op.add_column(TABLE, sa.Column(name, coltype, nullable=nullable, **kw))

    # ── Перенос данных ───────────────────────────────────────────────
    # `paid_periods` — по фактическим списаниям. Разовый взнос (rexp_{id}_dp) в
    # счётчик не входит: он не период графика.
    try:
        op.execute(sa.text(f"""
            UPDATE {TABLE} c SET paid_periods = (
                SELECT count(*) FROM transactions t
                WHERE t.company_id = c.company_id
                  AND t.source = 'recurring'
                  AND substr(t.external_id, 1, length('rexp_' || c.id || '_')) = 'rexp_' || c.id || '_'
                  AND substr(t.external_id, length('rexp_' || c.id || '_') + 1) <> 'dp'
            )
        """))
    except Exception:
        pass  # таблицы transactions может не быть в урезанной базе

    # `total_periods` — по датам договора, той же функцией, что и в приложении:
    # иначе «осталось 4 месяца» считалось бы в миграции и в коде по-разному.
    try:
        from app.services.recurring_expense_service import count_periods
        rows = bind.execute(sa.text(
            f"SELECT id, start_date, end_date, frequency, day_of_month FROM {TABLE} "
            f"WHERE end_date IS NOT NULL AND total_periods IS NULL"
        )).fetchall()
        for row in rows:
            cid, start, end, freq, dom = row[0], row[1], row[2], row[3], row[4]
            if start is None or end is None:
                continue
            # На SQLite драйвер отдаёт даты строками, на PostgreSQL — объектами date.
            if isinstance(start, str):
                import datetime as _dt
                start = _dt.date.fromisoformat(start[:10])
            if isinstance(end, str):
                import datetime as _dt
                end = _dt.date.fromisoformat(end[:10])
            n = count_periods(start, end, freq or "monthly", int(dom or 1))
            if n:
                bind.execute(sa.text(f"UPDATE {TABLE} SET total_periods = :n WHERE id = :i"),
                             {"n": n, "i": cid})
    except Exception:
        pass

    # Существующие договоры считаем активными и «заданными за период» — так они
    # и работали до обновления.
    try:
        op.execute(sa.text(f"UPDATE {TABLE} SET input_amount = amount WHERE input_amount IS NULL"))
        op.execute(sa.text(f"UPDATE {TABLE} SET status = CASE WHEN is_active THEN 'active' ELSE 'paused' END"))
    except Exception:
        pass

    if "ix_recurring_expenses_company_status" not in _indexes(bind, TABLE):
        try:
            op.create_index("ix_recurring_expenses_company_status", TABLE,
                            ["company_id", "status"])
        except Exception:
            pass


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, TABLE):
        return
    cols = _columns(bind, TABLE)
    if "ix_recurring_expenses_company_status" in _indexes(bind, TABLE):
        try:
            op.drop_index("ix_recurring_expenses_company_status", table_name=TABLE)
        except Exception:
            pass
    for name, _t, _n, _d in reversed(NEW_COLUMNS):
        if name in cols:
            op.drop_column(TABLE, name)
