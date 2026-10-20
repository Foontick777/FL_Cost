"""Категории расходов — CRUD для «Администрирования».

Разделы (section) фиксированы (см. app/services/category_service.py), категории
внутри раздела — динамические. Компания получает готовый системный набор и
может добавлять свои категории прямо из формы расхода («+ Создать категорию»).

Права (§16 ТЗ):
  • Owner   — полный доступ (создание, переименование, отключение, удаление).
  • Manager — создание и использование категорий.
  • Viewer  — только чтение.

Правила, которые нельзя нарушить:
  • `code` не меняется — он входит в `fuel_type` уже записанных операций.
  • Категорию с историческими операциями нельзя удалить физически: отдаём 409
    и подсказываем отключить (история при этом сохраняется).
  • Все изменения пишутся в журнал действий (audit log).
  • Данные строго изолированы по company_id.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone
from typing import Optional

from app.core.database import get_db
from app.api.deps import get_current_user, require_manager, require_owner, get_request_context
from app.models.models import User, ExpenseCategory, Transaction, RecurringExpense
from app.schemas.schemas import (
    ExpenseCategoryOut, ExpenseCategoryCreate, ExpenseCategoryPatch,
)
from app.services import audit_service, category_service
from app.services.category_service import (
    SECTIONS, SECTION_PREFIX, SECTION_OBJECT_SCOPE, fuel_type_for, slugify,
)

router = APIRouter(prefix="/expense-categories", tags=["expense-categories"])

VALID_SCOPES = {"vehicle", "trailer", "company", "employee", "any"}


async def _usage_map(db: AsyncSession, company_id: int) -> dict[int, int]:
    """{category_id: число операций} одним запросом.

    Операция считается относящейся к категории, если у неё проставлен
    `category_id` ИЛИ её `fuel_type` равен `manual_{section}_{code}` (так
    выглядят строки, записанные до появления категорий). Обе выборки берём
    одной группировкой по паре (category_id, fuel_type) и складываем аккуратно,
    чтобы строка, у которой заполнено и то и другое, не посчиталась трижды.
    """
    rows = (await db.execute(
        select(Transaction.category_id, Transaction.fuel_type, func.count(Transaction.id))
        .where(Transaction.company_id == company_id)
        .group_by(Transaction.category_id, Transaction.fuel_type)
    )).all()

    by_cat: dict[int, int] = {}
    by_ft: dict[str, int] = {}
    pair: dict[tuple[Optional[int], Optional[str]], int] = {}
    for cat_id, ft, n in rows:
        n = int(n or 0)
        if cat_id is not None:
            by_cat[cat_id] = by_cat.get(cat_id, 0) + n
        if ft:
            by_ft[ft] = by_ft.get(ft, 0) + n
        pair[(cat_id, ft)] = pair.get((cat_id, ft), 0) + n
    return {"by_cat": by_cat, "by_ft": by_ft, "pair": pair}  # type: ignore[return-value]


def _usage_for(cat: ExpenseCategory, usage: dict) -> int:
    ft = fuel_type_for(cat.section, cat.code)
    return (usage["by_cat"].get(cat.id, 0)
            + usage["by_ft"].get(ft, 0)
            - usage["pair"].get((cat.id, ft), 0))


@router.get("/meta")
async def categories_meta():
    """Справочник разделов для интерфейса (порядок вкладок, область применения,
    префикс fuel_type). Читается всеми ролями — это не данные компании."""
    # Порядок берём из SECTIONS, а не повторяем списком: пока он дублировался,
    # раздел «Лизинг» в /meta просто отсутствовал — фронтенд его не видел.
    order = list(SECTIONS)
    return {
        "sections": [
            {
                "section": s,
                "prefix": SECTION_PREFIX.get(s, s),
                "object_scope": SECTION_OBJECT_SCOPE.get(s, "any"),
            }
            for s in order if s in SECTIONS
        ],
        "frequencies": ["monthly", "quarterly", "yearly", "weekly"],
        "object_scopes": sorted(VALID_SCOPES),
    }


@router.get("/", response_model=list[ExpenseCategoryOut])
async def list_categories(
    section: Optional[str] = Query(default=None),
    include_inactive: bool = Query(default=True),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Категории компании. При первом обращении компания получает системный
    набор, а категории, найденные только в истории расходов, заводятся
    автоматически — иначе уже введённые расходы выпали бы из аналитики."""
    company_id = current_user.company_id

    # Первый вызов для компании: засеять системные категории и подтянуть те,
    # что уже встречаются в сохранённых расходах.
    has_any = (await db.execute(
        select(ExpenseCategory.id).where(ExpenseCategory.company_id == company_id).limit(1)
    )).scalar_one_or_none()
    if has_any is None:
        created = await category_service.ensure_seeded(db, company_id)
        created += await category_service.backfill_from_transactions(db, company_id)
        if created:
            await db.commit()
    else:
        # Системные категории могли появиться в новой версии — досоздаём
        # недостающие, ничего не ломая.
        if await category_service.ensure_seeded(db, company_id):
            await db.commit()

    q = select(ExpenseCategory).where(ExpenseCategory.company_id == company_id)
    if section:
        q = q.where(ExpenseCategory.section == section)
    if not include_inactive:
        q = q.where(ExpenseCategory.is_active == True)
    q = q.order_by(ExpenseCategory.section,
                   ExpenseCategory.is_system.desc(),
                   ExpenseCategory.sort_order,
                   ExpenseCategory.name)
    cats = (await db.execute(q)).scalars().all()

    usage = await _usage_map(db, company_id)
    out = []
    for c in cats:
        item = ExpenseCategoryOut.model_validate(c, from_attributes=True)
        item.usage_count = _usage_for(c, usage)
        out.append(item)
    return out


@router.post("/", response_model=ExpenseCategoryOut)
async def create_category(
    request: Request,
    data: ExpenseCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Создать категорию. Owner и manager (§16 ТЗ: manager может создавать
    категории в рамках своих прав)."""
    company_id = current_user.company_id

    code = data.code or slugify(data.name)
    if not code:
        # Имя без латиницы (например, «ФСЗН») — собираем код из транслита или
        # из порядкового номера, чтобы он гарантированно был ASCII.
        # Один механизм на все точки создания: иначе через админку категория
        # «ФСЗН» получала СЛУЧАЙНЫЙ код (hash() разный в разных процессах), а
        # через форму расхода — «fszn». Две категории вместо одной.
        code = category_service.code_for_name(data.name)
    code = code[:50]

    scope = (data.object_scope or SECTION_OBJECT_SCOPE.get(data.section, "any")).strip().lower()
    if scope not in VALID_SCOPES:
        raise HTTPException(400, f"object_scope must be one of {sorted(VALID_SCOPES)}")

    # Раздел `salary_tax` делит пространство имён fuel_type с `salary` —
    # проверяем уникальность кода с учётом этого, иначе два разных налога
    # «склеятся» в одну категорию.
    existing = (await db.execute(
        select(ExpenseCategory).where(
            ExpenseCategory.company_id == company_id,
            ExpenseCategory.code == code,
        )
    )).scalars().all()
    for e in existing:
        if e.section == data.section or {e.section, data.section} == {"salary", "salary_tax"}:
            raise HTTPException(
                409,
                f"Категория с кодом «{code}» уже существует в разделе "
                f"«{e.section}» (код участвует в типе операции и должен быть уникальным)",
            )

    cat = ExpenseCategory(
        company_id=company_id,
        section=data.section,
        code=code,
        name=data.name.strip(),
        icon=(data.icon or "").strip() or "🏷️",
        color=(data.color or "").strip() or None,
        object_scope=scope,
        is_system=False,
        is_active=bool(data.is_active),
        sort_order=900,
        created_by=current_user.id,
    )
    db.add(cat)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, f"Категория с кодом «{code}» уже существует")

    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=company_id, user=current_user, action="CREATE",
        entity_type="ExpenseCategory", entity_id=cat.id,
        new_value=audit_service.snapshot(cat),
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(cat)

    out = ExpenseCategoryOut.model_validate(cat, from_attributes=True)
    out.usage_count = 0
    return out


@router.patch("/{category_id}", response_model=ExpenseCategoryOut)
async def patch_category(
    category_id: int,
    request: Request,
    data: ExpenseCategoryPatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Переименовать / отключить / включить категорию, поменять иконку и цвет.

    `code` не меняется сознательно: он входит в `fuel_type` уже записанных
    операций — смена кода оторвала бы историю от категории.
    """
    cat = (await db.execute(
        select(ExpenseCategory).where(
            ExpenseCategory.id == category_id,
            ExpenseCategory.company_id == current_user.company_id,
        )
    )).scalar_one_or_none()
    if not cat:
        raise HTTPException(404, "Category not found")

    if data.object_scope is not None and data.object_scope.strip().lower() not in VALID_SCOPES:
        raise HTTPException(400, f"object_scope must be one of {sorted(VALID_SCOPES)}")

    old = audit_service.snapshot(cat)
    if data.name is not None:
        cat.name = data.name
    if data.icon is not None:
        cat.icon = (data.icon or "").strip() or None
    if data.color is not None:
        cat.color = (data.color or "").strip() or None
    if data.object_scope is not None:
        new_scope = data.object_scope.strip().lower()
        if new_scope != (cat.object_scope or "any"):
            # Смена области применения у категории с операциями противоречит
            # истории: справочник начнёт говорить «только автомобиль», а пятьсот
            # уже созданных расходов останутся расходами компании — и правило
            # будет спорить с данными. Меняем только у пустой категории.
            usage = (await db.execute(
                select(func.count()).select_from(Transaction).where(
                    Transaction.company_id == current_user.company_id,
                    or_(Transaction.category_id == cat.id,
                        Transaction.fuel_type == f"manual_{SECTION_PREFIX.get(cat.section, cat.section)}_{cat.code}"),
                )
            )).scalar() or 0
            if usage:
                raise HTTPException(
                    409,
                    f"По категории уже есть операции ({int(usage)}) — смена области "
                    "применения противоречила бы истории. Создайте новую категорию.",
                )
        cat.object_scope = new_scope
    if data.is_active is not None:
        cat.is_active = bool(data.is_active)
    if data.sort_order is not None:
        cat.sort_order = int(data.sort_order)
    cat.updated_at = datetime.now(timezone.utc)

    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user, action="UPDATE",
        entity_type="ExpenseCategory", entity_id=cat.id,
        old_value=old, new_value=audit_service.snapshot(cat),
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(cat)

    usage = await _usage_map(db, current_user.company_id)
    out = ExpenseCategoryOut.model_validate(cat, from_attributes=True)
    out.usage_count = _usage_for(cat, usage)
    return out


@router.delete("/{category_id}")
async def delete_category(
    category_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Удалить категорию. Owner only.

    Физическое удаление разрешено ТОЛЬКО когда на категорию не ссылается ни одна
    операция и ни один регулярный платёж — иначе история потеряла бы категорию,
    а отчёты «поплыли». В этом случае возвращаем 409 и подсказываем отключить.
    """
    cat = (await db.execute(
        select(ExpenseCategory).where(
            ExpenseCategory.id == category_id,
            ExpenseCategory.company_id == current_user.company_id,
        )
    )).scalar_one_or_none()
    if not cat:
        raise HTTPException(404, "Category not found")

    usage = await _usage_map(db, current_user.company_id)
    used = _usage_for(cat, usage)
    recurring_used = (await db.execute(
        select(func.count(RecurringExpense.id)).where(
            RecurringExpense.company_id == current_user.company_id,
            RecurringExpense.category_id == cat.id,
        )
    )).scalar() or 0

    if used or recurring_used:
        raise HTTPException(
            409,
            f"Категория «{cat.name}» используется: операций — {used}, "
            f"регулярных платежей — {recurring_used}. Удаление стёрло бы "
            f"историю. Отключите категорию (is_active=false) — она исчезнет из "
            f"выбора для новых операций, а старые расходы сохранятся.",
        )

    old = audit_service.snapshot(cat)
    await db.delete(cat)
    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user, action="DELETE",
        entity_type="ExpenseCategory", entity_id=category_id, old_value=old,
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True}
