from fastapi import Depends, HTTPException, status, Request, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
import ipaddress

from app.core.database import get_db
from app.core.security import (
    decode_token,
    read_auth_cookie,
    verify_csrf,
)
from app.core.config import settings
from app.models.models import User, UserRole

bearer_scheme = HTTPBearer(auto_error=False)


async def _resolve_user_from_token(
    token: Optional[str],
    db: AsyncSession,
) -> Optional[User]:
    if not token:
        return None
    payload = decode_token(token)
    if not payload:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return None
    result = await db.execute(select(User).where(User.id == uid))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        return None
    # SEC-02 (аудит stage8): сверяем версию access-токена. Раньше токен жил 7 дней
    # и его нельзя было отозвать: деактивация пользователя закрывала только новые
    # запросы через is_active, а украденный cookie оставался валидным до истечения.
    # Теперь повышение User.token_version (смена пароля, деактивация, «выйти
    # на всех устройствах») мгновенно аннулирует все ранее выданные токены.
    # Токены без "ver" (выданные до этой правки) считаем устаревшими: их срок
    # всё равно истекает в течение 7 дней после деплоя — мягкой миграции нет.
    try:
        token_ver = int(payload.get("ver", -1))
    except (TypeError, ValueError):
        return None
    if token_ver != int(user.token_version or 0):
        return None
    return user


async def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Authenticate the user via either an HttpOnly cookie (preferred, Issue #5)
    OR a Bearer token in the Authorization header (legacy, kept for backward
    compat with any tooling that still uses localStorage).

    CSRF (double-submit cookie) is enforced only on state-changing methods
    (POST/PATCH/DELETE/PUT) when the request is authenticated via cookie —
    a Bearer-token request is exempt because it carries its own CSRF
    mitigation (Bearer tokens are not automatically sent by the browser,
    so cross-site requests can't ride on them).
    """
    token: Optional[str] = None
    cookie_token = read_auth_cookie(request)
    if cookie_token:
        # Cookie path — enforce CSRF for unsafe methods
        if request.method.upper() in {"POST", "PATCH", "PUT", "DELETE"}:
            if not verify_csrf(request):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="CSRF token missing or invalid",
                )
        token = cookie_token
    elif credentials and credentials.credentials:
        # Bearer path — no CSRF needed (Authorization header can't be
        # sent by a cross-site request without explicit JS opt-in).
        token = credentials.credentials

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = await _resolve_user_from_token(token, db)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    return user


# ──────────────────────────────────────────────────────────────────────
# Issue #1: Role dependencies
# ──────────────────────────────────────────────────────────────────────
# Permission matrix (matches the user's spec):
#   │ Action                       │ Owner │ Manager │ Viewer │
#   │──────────────────────────────┼───────┼─────────┼────────┤
#   │ Read (GET)                   │  ✅   │  ✅     │  ✅    │
#   │ Add expense / vehicle        │  ✅   │  ✅     │  ❌    │
#   │ Edit expense / vehicle       │  ✅   │  ✅     │  ❌    │
#   │ Delete expense / vehicle     │  ✅   │  ✅     │  ❌    │
#   │ Export                       │  ✅   │  ✅     │  ❌/✅  │
#   │ E100 credentials             │  ✅   │  ❌     │  ❌    │
#   │ Telegram settings            │  ✅   │  ❌     │  ❌    │
#   │ Scraper settings             │  ✅   │  ❌     │  ❌    │
#   │ Manual sync                  │  ✅   │  ❌     │  ❌    │
#   │ Contracts (all kinds)        │  ✅   │  ✅     │  ❌    │
#   │ Users management             │  ✅   │  ❌     │  ❌    │
#   │ FX rates (manual override)   │  ✅   │  ❌     │  ❌    │
#   │ Audit log (read)             │  ✅   │  ✅     │  ✅    │


def require_role(*allowed_roles: UserRole):
    """Return a dependency that allows only the listed roles. Usage:
        Depends(require_role(UserRole.owner, UserRole.manager))
    """
    async def _dep(user: User = Depends(get_current_user)) -> User:
        if user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Operation requires one of roles: "
                       f"{[r.value for r in allowed_roles]}; "
                       f"current user role is '{user.role.value if hasattr(user.role, 'value') else user.role}'",
            )
        return user
    return _dep


# Common role dependencies — pre-built for the routes' convenience.
require_owner = require_role(UserRole.owner)
require_manager = require_role(UserRole.owner, UserRole.manager)
require_manager_or_owner = require_manager  # alias for readability
require_any_authenticated = get_current_user  # viewer also OK (GET routes)


def _is_trusted_peer(host: str) -> bool:
    """True when the TCP peer is our own reverse proxy (private/loopback).

    Only then are proxy headers trusted. Without this check, any client could
    send `X-Forwarded-For: 1.2.3.4` and have that address written into the
    audit log forever, which destroys the log's value as evidence.
    """
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def _client_ip(request: Request) -> str:
    """Best-effort real client IP, resistant to header spoofing."""
    peer = request.client.host if request.client else "unknown"
    if not _is_trusted_peer(peer):
        # Direct (non-proxied) connection — the peer address IS the truth and
        # any forwarding header it sent is untrusted input.
        return peer[:64]

    # X-Real-IP is written by our nginx (`proxy_set_header X-Real-IP $remote_addr`),
    # so it cannot be forged by the client.
    real_ip = (request.headers.get("X-Real-IP") or "").strip()
    if real_ip:
        try:
            ipaddress.ip_address(real_ip)
            return real_ip[:64]
        except ValueError:
            pass

    # Fall back to the LAST entry of X-Forwarded-For. nginx appends the real
    # address with `$proxy_add_x_forwarded_for`, so the first entry is
    # attacker-controlled and only the last one is trustworthy.
    forwarded = request.headers.get("X-Forwarded-For", "")
    parts = [p.strip() for p in forwarded.split(",") if p.strip()]
    if parts:
        return parts[-1][:64]

    return peer[:64]


def get_request_context(request: Request) -> dict:
    """Extract IP + User-Agent + Client-ID from the request for audit logging."""
    ip = _client_ip(request)
    ua = (request.headers.get("User-Agent") or "")[:512]
    # Issue #6: stable per-browser UUID generated by the frontend on first
    # launch. Lets audit log distinguish between sessions on different
    # devices for the same user (e.g. "user logged in from Chrome on Mac
    # vs Safari on iPhone").
    client_id = (request.headers.get("X-Client-ID") or "")[:64] or None
    return {"ip": ip, "user_agent": ua, "client_id": client_id}
