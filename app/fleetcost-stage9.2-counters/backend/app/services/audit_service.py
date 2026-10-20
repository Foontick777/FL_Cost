"""Audit log helper.

AuditLog records are written via this service. The route handler owns
the old/new value snapshots (since only the route knows the entity shape);
this service just persists them with the current user, IP and timestamp.
"""
import json
import logging
from decimal import Decimal
from typing import Any, Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, func
from datetime import datetime, timezone, timedelta

from app.core.database import AsyncSessionLocal
from app.models.models import AuditLog, User
from app.core.config import settings

logger = logging.getLogger(__name__)


def _safe_json_serialize(value: Any) -> Optional[str]:
    """Convert any object to a JSON string for storage. Returns None on
    failure rather than raising — audit logging must never break the
    user's actual operation."""
    if value is None:
        return None
    try:
        return json.dumps(value, default=str, ensure_ascii=False)
    except Exception as e:
        logger.warning(f"AuditLog serialize failed: {e}")
        return str(value)[:1000]


# Columns that must NEVER be written into the audit log. The snapshots end up
# in `audit_log.old_value` / `new_value`, which is readable by EVERY role
# (including `viewer`), so a password hash or an encrypted credential logged
# there is effectively published inside the app. `User.hashed_password` was
# leaked this way by PATCH/DELETE /auth/users before this allowlist existed.
_REDACTED = "***REDACTED***"
_SENSITIVE_FIELD_NAMES = {
    "hashed_password",
    "encrypted_password",
    "password",
    "password_hash",
    "password_salt",
    "secret",
    "secret_key",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "bot_token",
}
# Any column ending with one of these is treated as sensitive too, so a new
# `..._token` / `..._secret` column added later is redacted by default.
_SENSITIVE_FIELD_SUFFIXES = ("_password", "_token", "_secret", "_api_key", "_hash")


def _is_sensitive(column_name: str) -> bool:
    name = column_name.lower()
    return name in _SENSITIVE_FIELD_NAMES or name.endswith(_SENSITIVE_FIELD_SUFFIXES)


def _entity_to_dict(obj: Any) -> dict:
    """Best-effort dict-of-public-fields from a SQLAlchemy ORM instance.

    • Sensitive columns are replaced with a placeholder (never logged).
    • `Decimal` values are kept as strings — converting them to float (as the
      first implementation did) silently rounded money in the "было/стало"
      snapshots, so the audit trail could disagree with the database by cents.
    """
    if obj is None:
        return {}
    out = {}
    try:
        cols = obj.__table__.columns
        for c in cols:
            v = getattr(obj, c.name, None)
            if _is_sensitive(c.name):
                # Keep the fact that a value exists, but not the value itself.
                if v not in (None, ""):
                    out[c.name] = _REDACTED
                continue
            if v is None or isinstance(v, (int, float, str, bool)):
                out[c.name] = v
            elif isinstance(v, Decimal):
                out[c.name] = str(v)
            elif hasattr(v, "isoformat"):
                out[c.name] = v.isoformat()
            elif hasattr(v, "__float__"):
                out[c.name] = float(v)
            else:
                out[c.name] = str(v)
    except Exception as e:
        # Fallback — just dump whatever we can (still redacted)
        logger.warning(f"_entity_to_dict fallback for {type(obj).__name__}: {e}")
        out = {"_repr": repr(obj)[:1000]}
    return out


async def log(
    db: AsyncSession,
    *,
    company_id: int,
    user: Optional[User],
    action: str,
    entity_type: str,
    entity_id: Optional[Any] = None,
    old_value: Any = None,
    new_value: Any = None,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    client_id: Optional[str] = None,
) -> None:
    """Write a single audit record. NEVER swallows exceptions — if audit
    logging fails (e.g. table missing, JSON serialization broken), the
    exception propagates to the caller's DB transaction, which rolls back
    together with the business operation.

    Issue #4 (transactional audit): previously audit failures were caught
    and logged, meaning the user's mutation could succeed while the audit
    trail silently lost data. For financial applications this is wrong —
    if the audit log can't be written, the operation MUST fail so the
    user knows something went wrong and can retry / investigate.

    The caller (route handler) is expected to wrap its mutations + audit
    log call in a single `await db.commit()` — if audit fails, the commit
    fails, and the user's mutation is also rolled back.

    The exception types that propagate:
      • SQLAlchemyError — DB connection issues, FK violations, etc.
      • ValueError / TypeError — JSON serialization of weird Python objects
      • Any other unexpected error

    Routes that don't want this strict behavior can catch the exception
    explicitly. By default, every critical mutation (CREATE / UPDATE /
    DELETE on Transaction / User / Contract / Credential / FxRate) will
    be transactional with its audit trail.
    """
    entry = AuditLog(
        company_id=company_id,
        user_id=user.id if user else None,
        user_email=user.email if user else None,
        action=action.upper(),
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id is not None else None,
        old_value=_safe_json_serialize(old_value),
        new_value=_safe_json_serialize(new_value),
        ip_address=ip,
        user_agent=user_agent,
        client_id=client_id,
    )
    db.add(entry)
    # We deliberately DON'T commit here — the caller (route handler)
    # commits its own transaction and the audit row rides along. If
    # the operation rolls back, the audit row also disappears.
    # If audit logging itself fails (e.g. AuditLog table missing), the
    # exception propagates → caller's commit fails → operation rolls back.


async def log_external(
    company_id: int,
    *,
    user: Optional[User],
    action: str,
    entity_type: str,
    entity_id: Optional[Any] = None,
    old_value: Any = None,
    new_value: Any = None,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    client_id: Optional[str] = None,
) -> None:
    """Same as log(), but opens its OWN session — for use in background
    jobs (scheduler, sync) where there's no request-scoped session to
    attach to. Always commits immediately, even if the caller rolls back."""
    try:
        async with AsyncSessionLocal() as db:
            await log(
                db,
                company_id=company_id,
                user=user,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                old_value=old_value,
                new_value=new_value,
                ip=ip,
                user_agent=user_agent,
                client_id=client_id,
            )
            await db.commit()
    except Exception as e:
        logger.error(f"External audit log failed: {e}", exc_info=True)


async def purge_old_logs(days: int) -> int:
    """Delete audit_log rows older than `days` days. Returns the row count.
    Called by the nightly APScheduler job when AUDIT_LOG_RETENTION_DAYS > 0."""
    if days <= 0:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    async with AsyncSessionLocal() as db:
        result = await db.execute(delete(AuditLog).where(AuditLog.created_at < cutoff))
        await db.commit()
        return result.rowcount or 0


def snapshot(obj: Any) -> Optional[dict]:
    """Public helper for routes — wraps _entity_to_dict for the `old_value`
    field before the route modifies the entity."""
    return _entity_to_dict(obj)
