"""In-memory per-company sync lock.

When owner clicks "Sync e100", we don't want another user (or another tab
of the same user) to start a second sync in parallel — that would create
duplicate transactions (the dedup logic in save_transactions handles
within-fetch duplicates, but two parallel syncs of the same credential
could both insert the same transactions before either sees the other's
inserts).

This is intentionally in-memory (not in the DB) — sync locks are
ephemeral, and a backend restart should clear them. The TTL (30 min)
protects against a crashed sync leaving a permanent lock.

For multi-instance deployments (multiple backend containers), this
would need to be backed by Redis or similar. For the typical
single-container Docker Compose setup, in-memory is sufficient.
"""
import threading
import time
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# company_id -> (locked_at_monotonic, user_id)
_sync_locks: dict[int, tuple[float, int]] = {}
_lock_mutex = threading.Lock()
SYNC_LOCK_TTL_SECONDS = 30 * 60  # 30 minutes — auto-release if a sync crashed


def acquire_sync_lock(company_id: int, user_id: int) -> tuple[bool, Optional[int]]:
    """Try to acquire a sync lock for `company_id` on behalf of `user_id`.

    Returns (acquired: bool, locked_by_user_id: Optional[int]).
    If acquired=True, the caller MUST call release_sync_lock when done
    (typically in a `finally` block).
    If acquired=False, locked_by_user_id is the user who currently holds
    the lock — the caller can show "sync in progress by <user>".
    """
    now = time.monotonic()
    with _lock_mutex:
        # Clear expired locks first — protects against a sync that crashed
        # without releasing its lock.
        expired = [
            cid for cid, (locked_at, _) in _sync_locks.items()
            if now - locked_at > SYNC_LOCK_TTL_SECONDS
        ]
        for cid in expired:
            _, expired_uid = _sync_locks[cid]
            del _sync_locks[cid]
            logger.warning(
                f"Released expired sync lock for company {cid} "
                f"(was held by user {expired_uid}, exceeded {SYNC_LOCK_TTL_SECONDS}s TTL)"
            )
        # Check if this company is already locked
        if company_id in _sync_locks:
            _, locked_by = _sync_locks[company_id]
            # Раньше повторный запрос ТОГО ЖЕ пользователя считался «своим», и
            # лок просто продлевался — то есть два синка могли идти
            # одновременно (двойной клик, две вкладки), а вместе с ними и
            # сверка месяцев. Лок существует ровно для того, чтобы этого не
            # было, поэтому отвечаем «занято» (FC-005 в аудите).
            return False, locked_by
        # Acquire
        _sync_locks[company_id] = (now, user_id)
        return True, user_id


def release_sync_lock(company_id: int, user_id: int) -> None:
    """Release the sync lock for `company_id`. Only releases if the
    current lock is held by `user_id` (no accidental release of someone
    else's lock)."""
    with _lock_mutex:
        if company_id in _sync_locks:
            _, locked_by = _sync_locks[company_id]
            if locked_by == user_id:
                del _sync_locks[company_id]
            else:
                logger.warning(
                    f"release_sync_lock: company {company_id} is locked by "
                    f"user {locked_by}, not {user_id} — not releasing"
                )


def get_sync_lock_holder(company_id: int) -> Optional[int]:
    """Return the user_id currently holding the sync lock for `company_id`,
    or None if no lock is held. Used by the frontend to show
    "sync in progress by <user>"."""
    now = time.monotonic()
    with _lock_mutex:
        if company_id not in _sync_locks:
            return None
        locked_at, locked_by = _sync_locks[company_id]
        if now - locked_at > SYNC_LOCK_TTL_SECONDS:
            # Lock is expired — treat as not held
            del _sync_locks[company_id]
            return None
        return locked_by
