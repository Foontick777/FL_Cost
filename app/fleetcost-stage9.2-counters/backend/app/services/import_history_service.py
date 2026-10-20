"""Import history service — records every import operation (CSV/XLSX/sync)
to the import_history table, capturing per-file metrics (new/updated/
skipped/failed rows, duration, status, date range in file).

Much richer than the single IMPORT entry in audit_log — gives the user
a dedicated Import Center page with detailed history.
"""
import logging
import time
from datetime import datetime, timezone, date
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.core.database import AsyncSessionLocal
from app.models.models import ImportHistory, User

logger = logging.getLogger(__name__)


async def record_import(
    *,
    company_id: int,
    user: Optional[User],
    source: str,  # e100 | q8 | fakturownia | navby_mileage
    filename: Optional[str] = None,
    total_rows: int = 0,
    new_rows: int = 0,
    updated_rows: int = 0,
    skipped_rows: int = 0,
    failed_rows: int = 0,
    file_date_from: Optional[date] = None,
    file_date_to: Optional[date] = None,
    duration_ms: Optional[int] = None,
    status: str = "success",  # success | partial | failed
    error_message: Optional[str] = None,
) -> None:
    """Insert one row in import_history. Never raises — failures are logged
    but don't break the actual import operation."""
    try:
        async with AsyncSessionLocal() as db:
            entry = ImportHistory(
                company_id=company_id,
                user_id=user.id if user else None,
                user_email=user.email if user else None,
                source=source,
                filename=filename,
                total_rows=total_rows,
                new_rows=new_rows,
                updated_rows=updated_rows,
                skipped_rows=skipped_rows,
                failed_rows=failed_rows,
                file_date_from=file_date_from,
                file_date_to=file_date_to,
                duration_ms=duration_ms,
                status=status,
                error_message=error_message,
            )
            db.add(entry)
            await db.commit()
    except Exception as e:
        logger.error(f"Failed to record import history: {e}", exc_info=True)


class ImportTimer:
    """Context manager that measures wall-clock duration of an import.
    Usage:
        with ImportTimer() as t:
            ... do the import ...
        # t.duration_ms is now populated
    """
    def __init__(self):
        self.start = None
        self.duration_ms = None

    def __enter__(self):
        self.start = time.monotonic()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.start is not None:
            self.duration_ms = int((time.monotonic() - self.start) * 1000)
        return False  # don't suppress exceptions


async def list_imports(
    company_id: int,
    *,
    source: Optional[str] = None,
    limit: int = 100,
) -> list[ImportHistory]:
    """List recent imports for a company, newest first."""
    async with AsyncSessionLocal() as db:
        q = select(ImportHistory).where(
            ImportHistory.company_id == company_id
        ).order_by(ImportHistory.created_at.desc()).limit(limit)
        if source:
            q = q.where(ImportHistory.source == source)
        r = await db.execute(q)
        return list(r.scalars().all())
