"""Import history endpoints (Issue #6 — Import Center page).

  • GET /imports/history — list recent imports with detailed metrics
  • GET /imports/sources  — list of all known import sources (for UI dropdown)
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from datetime import datetime, date
from decimal import Decimal

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.models import User, ImportHistory
from app.services import import_history_service
from pydantic import BaseModel, ConfigDict

router = APIRouter(prefix="/imports", tags=["imports"])


class ImportHistoryOut(BaseModel):
    id: int
    company_id: int
    user_id: Optional[int]
    user_email: Optional[str]
    source: str
    filename: Optional[str]
    total_rows: int
    new_rows: int
    updated_rows: int
    skipped_rows: int
    failed_rows: int
    file_date_from: Optional[date]
    file_date_to: Optional[date]
    duration_ms: Optional[int]
    status: str
    error_message: Optional[str]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


@router.get("/history", response_model=list[ImportHistoryOut])
async def list_import_history(
    source: Optional[str] = Query(default=None,
        description="Filter by source: e100 | q8 | fakturownia | navby_mileage"),
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List recent imports for the current company, newest first.

    All roles (owner, manager, viewer) can read — the import history
    is a shared accountability record.
    """
    q = select(ImportHistory).where(
        ImportHistory.company_id == current_user.company_id
    ).order_by(ImportHistory.created_at.desc()).limit(limit).offset(offset)
    if source:
        q = q.where(ImportHistory.source == source)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/history/count")
async def count_import_history(
    source: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Total count for pagination."""
    q = select(func.count(ImportHistory.id)).where(
        ImportHistory.company_id == current_user.company_id
    )
    if source:
        q = q.where(ImportHistory.source == source)
    r = await db.execute(q)
    return {"total": r.scalar() or 0}


@router.get("/sources")
async def list_sources(
    current_user: User = Depends(get_current_user),
):
    """Return the list of known import sources with display names."""
    return {
        "sources": [
            {"key": "e100", "label": "E100 (auto sync)"},
            {"key": "q8", "label": "Q8 Truck CSV"},
            {"key": "fakturownia", "label": "Fakturownia (income CSV)"},
            {"key": "navby_mileage", "label": "nav.by XLSX (mileage)"},
        ]
    }


@router.get("/last-sync")
async def last_sync_per_source(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get the LATEST ImportHistory entry per source — gives the user an
    at-a-glance view of "did the program actually get fresh data recently?".

    Returns: {sources: [{source, last_import: {created_at, period, counts, status}}]}
    """
    from sqlalchemy import func, and_
    from app.models.models import ImportHistory as IH

    # Get the most recent entry per source using a window function
    # (DISTINCT ON is Postgres-specific; this works on SQLite too)
    sources_to_check = ["e100", "q8", "fakturownia", "navby_mileage"]
    result = []
    for source in sources_to_check:
        # Get the latest entry for this source
        q = (select(IH)
             .where(IH.company_id == current_user.company_id, IH.source == source)
             .order_by(IH.created_at.desc())
             .limit(1))
        r = await db.execute(q)
        entry = r.scalar_one_or_none()
        if entry:
            result.append({
                "source": source,
                "label": {"e100": "E100", "q8": "Q8", "fakturownia": "Fakturownia",
                          "navby_mileage": "nav.by"}.get(source, source),
                "last_import": {
                    "id": entry.id,
                    "created_at": entry.created_at.isoformat() if entry.created_at else None,
                    "filename": entry.filename,
                    "period": f"{entry.file_date_from} to {entry.file_date_to}" if entry.file_date_from and entry.file_date_to else None,
                    "file_date_from": entry.file_date_from.isoformat() if entry.file_date_from else None,
                    "file_date_to": entry.file_date_to.isoformat() if entry.file_date_to else None,
                    "total_rows": entry.total_rows,
                    "new_rows": entry.new_rows,
                    "updated_rows": entry.updated_rows,
                    "skipped_rows": entry.skipped_rows,
                    "failed_rows": entry.failed_rows,
                    "duration_ms": entry.duration_ms,
                    "status": entry.status,
                    "error_message": entry.error_message,
                    "user_email": entry.user_email,
                },
            })
        else:
            result.append({
                "source": source,
                "label": {"e100": "E100", "q8": "Q8", "fakturownia": "Fakturownia",
                          "navby_mileage": "nav.by"}.get(source, source),
                "last_import": None,
            })
    return {"sources": result}
