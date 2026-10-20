"""Audit log endpoints (Issue #4).

  • GET /audit-log         — list audit entries for the current company (all
    roles can read; the audit log is the company's own accountability record).
  • GET /audit-log/count   — matching row count for pagination (same filters!)
  • GET /audit-log/export  — CSV export of the filtered journal (all roles)

Fixes applied to this module:
  • `date_to` was compared as the STRING "YYYY-MM-DD 23:59:59" against a
    TIMESTAMPTZ column, which PostgreSQL cannot cast implicitly — the filter
    could raise instead of returning rows. It is now built as an explicit
    timezone-aware datetime.
  • /count ignored `action` / `entity_type` / `user_id`, so the UI showed
    "показано 100 из 9734" while a filter was active and paginated into empty
    pages. Both endpoints now share one filter builder.
  • Ordering had no tie-breaker: rows written in the same transaction share
    `created_at`, and PostgreSQL may return them in a different order per
    query, so rows could appear twice or be skipped across pages. `id` is now
    the secondary sort key.
"""
import csv
import io
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from datetime import date, datetime, time, timezone

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.models import User, AuditLog
from app.schemas.schemas import AuditLogOut
from app.core.search import like_pattern

router = APIRouter(prefix="/audit-log", tags=["audit-log"])


def _build_filters(
    *,
    company_id: int,
    date_from: Optional[date],
    date_to: Optional[date],
    action: Optional[str],
    entity_type: Optional[str],
    user_id: Optional[int],
    search: Optional[str] = None,
) -> list:
    """One filter builder shared by list / count / export so the three can
    never drift apart again.

    `search` — свободный поиск (поле поиска в интерфейсе журнала): ищет по
    e-mail пользователя, IP-адресу, типу и идентификатору объекта. Раньше
    поиска не было вовсе, и найти запись по IP или по конкретной транзакции
    в журнале на тысячи строк было нельзя.
    """
    conds = [AuditLog.company_id == company_id]
    if date_from:
        # Inclusive lower bound, midnight UTC.
        conds.append(
            AuditLog.created_at >= datetime.combine(date_from, time.min, tzinfo=timezone.utc)
        )
    if date_to:
        # Exclusive upper bound = start of the NEXT day, so the whole
        # selected day is included without string/format guessing.
        conds.append(
            AuditLog.created_at
            < datetime.combine(date_to, time.min, tzinfo=timezone.utc)
        )
    if action:
        conds.append(AuditLog.action == action.upper())
    if entity_type:
        conds.append(AuditLog.entity_type == entity_type)
    if user_id is not None:
        conds.append(AuditLog.user_id == user_id)
    if search and search.strip():
        pat = like_pattern(search.strip())
        conds.append(
            or_(
                AuditLog.user_email.ilike(pat, escape="\\"),
                AuditLog.ip_address.ilike(pat, escape="\\"),
                AuditLog.entity_id.ilike(pat, escape="\\"),
                AuditLog.entity_type.ilike(pat, escape="\\"),
            )
        )
    return conds


@router.get("/", response_model=list[AuditLogOut])
async def list_audit(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    action: Optional[str] = Query(default=None),
    entity_type: Optional[str] = Query(default=None),
    user_id: Optional[int] = Query(default=None),
    search: Optional[str] = Query(default=None, max_length=120, description="Свободный поиск: e-mail, IP, тип или id объекта"),
    limit: int = Query(default=200, le=2000),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List audit entries for the current company, newest first.

    All roles (owner, manager, viewer) can read — the audit log is a
    shared accountability record. Write access happens only on the
    backend (via audit_service.log); there's no /audit-log POST endpoint.
    """
    conds = _build_filters(
        company_id=current_user.company_id,
        date_from=date_from,
        date_to=date_to,
        action=action,
        entity_type=entity_type,
        user_id=user_id,
        search=search,
    )
    q = (
        select(AuditLog)
        .where(and_(*conds))
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/count")
async def count_audit(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    action: Optional[str] = Query(default=None),
    entity_type: Optional[str] = Query(default=None),
    user_id: Optional[int] = Query(default=None),
    search: Optional[str] = Query(default=None, max_length=120),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Total count for pagination — honours the SAME filters as the list."""
    conds = _build_filters(
        company_id=current_user.company_id,
        date_from=date_from,
        date_to=date_to,
        action=action,
        entity_type=entity_type,
        user_id=user_id,
        search=search,
    )
    q = select(func.count(AuditLog.id)).where(and_(*conds))
    result = await db.execute(q)
    return {"total": result.scalar() or 0}


@router.get("/actions")
async def list_actions(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Actions actually present in this company's journal, with Russian
    labels — lets the UI build the filter dropdown from real data instead of
    a hard-coded list that silently misses new actions (e.g. LOGIN_FAILED)."""
    labels = {
        "CREATE": "Создание",
        "UPDATE": "Изменение",
        "DELETE": "Удаление",
        "CANCEL": "Отмена",
        "SYNC": "Синхронизация",
        "RECONCILE": "Перезапись месяца",
        "EXPORT": "Экспорт",
        "IMPORT": "Импорт",
        "LOGIN": "Вход",
        "LOGIN_FAILED": "Неудачный вход",
        "LOGOUT": "Выход",
    }
    q = (
        select(AuditLog.action, func.count(AuditLog.id))
        .where(AuditLog.company_id == current_user.company_id)
        .group_by(AuditLog.action)
        .order_by(func.count(AuditLog.id).desc())
    )
    rows = (await db.execute(q)).all()
    return {
        "actions": [
            {"value": a, "label": labels.get(a, a), "count": int(c)}
            for a, c in rows
        ]
    }


@router.get("/export")
async def export_audit(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    action: Optional[str] = Query(default=None),
    entity_type: Optional[str] = Query(default=None),
    user_id: Optional[int] = Query(default=None),
    search: Optional[str] = Query(default=None, max_length=120),
    limit: int = Query(default=10000, le=100000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """CSV export of the filtered journal.

    Previously the journal could not be exported at all, so an accountant or
    auditor had nothing to attach to a report. Kept as CSV (not XLSX) so it
    opens anywhere; values are quoted and prefixed so a `=`/`+`/`-`/`@` start
    can't be interpreted as a formula by Excel.
    """
    conds = _build_filters(
        company_id=current_user.company_id,
        date_from=date_from,
        date_to=date_to,
        action=action,
        entity_type=entity_type,
        user_id=user_id,
        search=search,
    )
    q = (
        select(AuditLog)
        .where(and_(*conds))
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(limit)
    )
    entries = (await db.execute(q)).scalars().all()

    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_ALL)
    writer.writerow([
        "id", "created_at", "user_email", "action", "entity_type", "entity_id",
        "ip_address", "client_id", "user_agent", "old_value", "new_value",
    ])

    def _safe(v) -> str:
        s = "" if v is None else str(v)
        # Neutralise spreadsheet formula injection.
        if s[:1] in ("=", "+", "-", "@"):
            s = "'" + s
        return s

    for e in entries:
        writer.writerow([
            e.id,
            e.created_at.isoformat() if e.created_at else "",
            _safe(e.user_email),
            _safe(e.action),
            _safe(e.entity_type),
            _safe(e.entity_id),
            _safe(e.ip_address),
            _safe(e.client_id),
            _safe(e.user_agent),
            _safe(e.old_value),
            _safe(e.new_value),
        ])

    buf.seek(0)
    filename = f"fleetcost-audit-{datetime.now(timezone.utc):%Y%m%d-%H%M}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
