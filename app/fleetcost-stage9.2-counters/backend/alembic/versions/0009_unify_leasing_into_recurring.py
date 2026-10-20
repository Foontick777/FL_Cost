"""Объединить лизинг с регулярными расходами

Revision ID: 0009_unify_leasing_into_recurring
Revises: 0008_recurring_dedup_index
Create Date: 2026-10-02

Зачем
-----
Лизинг оставался последней «отдельной» моделью: у него была своя таблица
`leasing_contracts` и своя серия списаний с внешними ключами
`leasing_{id}_{YYYY-MM}`. Пока рядом жил универсальный механизм регулярных
расходов, один и тот же договор можно было завести дважды, и в учёте появлялись
две независимые серии платежей по одному обязательству.

Что делает миграция
-------------------
1. Заводит (если нет) категорию «Лизинг» в разделе `leasing`.
2. Для каждого договора лизинга создаёт регулярный расход с той же суммой,
   сроком и графиком: сумма за один платёж = `monthly_amount`, общая сумма =
   `total_amount`, число платежей = `term_months`.
3. ПЕРЕНОМЕРОВЫВАЕТ уже созданные списания: `leasing_{старый}_{YYYY-MM}` →
   `rexp_{новый}_{YYYY-MM}` и связывает их с категорией. Без этого после переноса
   генерация создала бы по каждому прошлому месяцу ВТОРУЮ строку — история
   задвоилась бы, а суммы в отчётах выросли бы вдвое.
4. Удаляет исходную строку договора: данные не теряются (они в п.2–3), но
   исчезает второй источник истины, и договор больше не показывается дважды.

Ключ идемпотентности: `document_ref = 'leasing:{id}'`. Повторный запуск
миграции не создаёт второй регулярный расход.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision = "0009_unify_leasing_into_recurring"
down_revision = "0008_recurring_dedup_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MARK = "leasing:"


def _parse_date(value):
    import datetime
    if value is None:
        return None
    if isinstance(value, str):
        return datetime.date.fromisoformat(value[:10])
    if isinstance(value, datetime.datetime):
        return value.date()
    return value


def _add_months(start, months: int, day: int):
    """Дата через `months` месяцев с числом `day` (1..28 — как в графике)."""
    import datetime
    total = (start.year * 12 + (start.month - 1)) + months
    day = max(1, min(28, day or 1))
    return datetime.date(total // 12, total % 12 + 1, day)


def upgrade() -> None:
    import datetime

    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())
    if "leasing_contracts" not in tables or "recurring_expenses" not in tables:
        return  # база без лизинга или без нового механизма — нечего переносить

    contracts = bind.execute(sa.text(
        "SELECT id, company_id, vehicle_id, plate_number, description, start_date, "
        "term_months, total_amount, currency, day_of_month, monthly_amount, is_active "
        "FROM leasing_contracts ORDER BY id"
    )).mappings().all()
    if not contracts:
        return

    for c in contracts:
        company_id = c["company_id"]
        # 1. категория «Лизинг» в разделе leasing
        cat_id = bind.execute(sa.text(
            "SELECT id FROM expense_categories WHERE company_id = :co AND section = 'leasing' "
            "AND code = 'leasing'"
        ), {"co": company_id}).scalar()
        if not cat_id:
            cat_id = bind.execute(sa.text(
                "INSERT INTO expense_categories (company_id, section, code, name, icon, "
                "object_scope, is_system, is_active, sort_order) VALUES (:co, 'leasing', "
                "'leasing', 'Лизинг', '📄', 'any', TRUE, TRUE, 0) RETURNING id"
            ), {"co": company_id}).scalar()
        if not cat_id:
            continue

        mark = f"{MARK}{c['id']}"
        already = bind.execute(sa.text(
            "SELECT id FROM recurring_expenses WHERE company_id = :co AND document_ref = :mark"
        ), {"co": company_id, "mark": mark}).scalar()
        if already:
            continue

        start = _parse_date(c["start_date"])
        if start is None:
            continue
        term = int(c["term_months"] or 0)
        day = int(c["day_of_month"] or 1)
        end = _add_months(start, max(term - 1, 0), day) if term else None

        new_id = bind.execute(sa.text(
            "INSERT INTO recurring_expenses (company_id, category_id, vehicle_id, "
            "plate_number, description, amount, input_amount, amount_mode, down_payment, "
            "currency, frequency, start_date, end_date, day_of_month, total_periods, "
            "status, is_active, paid_periods, document_ref) VALUES "
            "(:co, :cat, :veh, :plate, :descr, :amount, :input_amount, 'total', 0, "
            ":cur, 'monthly', :start, :end, :day, :term, :status, :active, 0, :mark) "
            "RETURNING id"
        ), {
            "co": company_id, "cat": cat_id, "veh": c["vehicle_id"],
            "plate": c["plate_number"],
            "descr": (c["description"] or "Лизинг"),
            "amount": c["monthly_amount"], "input_amount": c["total_amount"],
            "cur": c["currency"], "start": start, "end": end, "day": day,
            "term": term,
            "status": "active" if (c["is_active"] and (end is None or end >= datetime.date.today()))
                      else ("completed" if c["is_active"] else "paused"),
            "active": bool(c["is_active"]),
            "mark": mark,
        }).scalar()
        if not new_id:
            continue

        # 3. Перенумеровать уже созданные списания — иначе они задвоятся.
        old_prefix = f"leasing_{c['id']}_"
        new_prefix = f"rexp_{new_id}_"
        bind.execute(sa.text(
            "UPDATE transactions SET external_id = :new_prefix || "
            "substr(external_id, :cut), category_id = :cat, expense_type = 'recurring', "
            "periodicity = 'monthly' "
            "WHERE company_id = :co AND source = 'recurring' "
            "AND substr(external_id, 1, :plen) = :old_prefix"
        ), {
            "new_prefix": new_prefix, "cut": len(old_prefix) + 1, "cat": cat_id,
            "co": company_id, "plen": len(old_prefix), "old_prefix": old_prefix,
        })

        # Счётчик «оплачено N из M» — по факту перенесённых списаний.
        paid = bind.execute(sa.text(
            "SELECT count(*) FROM transactions WHERE company_id = :co AND source = 'recurring' "
            "AND substr(external_id, 1, :plen) = :new_prefix"
        ), {"co": company_id, "plen": len(new_prefix), "new_prefix": new_prefix}).scalar() or 0
        bind.execute(sa.text("UPDATE recurring_expenses SET paid_periods = :paid WHERE id = :id"),
                     {"paid": int(paid), "id": new_id})

        # 4. Исходная строка больше не нужна: договор живёт в recurring_expenses.
        bind.execute(sa.text("DELETE FROM leasing_contracts WHERE id = :id"), {"id": c["id"]})


def downgrade() -> None:
    """Обратный перенос не восстанавливается.

    Договор и его списания не удаляются, а меняют форму (см. п.2–3), поэтому
    «откатить» можно только вручную. Пустая реализация честнее, чем вид
    рабочего отката, который на самом деле теряет созданные после миграции
    платежи.
    """
    pass
