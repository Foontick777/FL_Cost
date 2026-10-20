from datetime import datetime, timedelta, timezone
from typing import Optional
import logging

from fastapi import APIRouter, HTTPException, Depends, Request, Response
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from slowapi.errors import RateLimitExceeded
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.database import get_db
from app.core.security import (
    get_password_hash,
    verify_password,
    create_access_token,
    set_auth_cookie,
    set_csrf_cookie,
    generate_refresh_token,
    hash_refresh_token,
    set_refresh_cookie,
    clear_refresh_cookie,
    read_refresh_cookie,
    clear_auth_cookie,
)
from app.core.config import settings
from app.api.deps import get_current_user, get_request_context, require_owner
from app.models.models import User, Company, TelegramSettings, ScraperSettings, UserRole, RefreshToken
from app.schemas.schemas import (
    RegisterRequest,
    LoginRequest,
    TokenResponse,
    UserCreate,
    UserOut,
    UserPatch,
)
from app.services import audit_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Per-IP rate limiter — prevents brute-force on login and registration
# spam. slowapi stores counters in-memory by default (lost on restart),
# which is fine for this use-case. Upgrade to Redis backend in production
# if you run multiple backend instances.
limiter = Limiter(key_func=get_remote_address)

# Rate limits are configurable so local testing over http://localhost:3000
# (where every request comes from 127.0.0.1 and therefore shares ONE bucket)
# is not blocked by the production defaults. Read once at import time.
from app.core.config import settings as _cfg  # noqa: E402

LOGIN_RATE_LIMIT = _cfg.RATE_LIMIT_LOGIN
REGISTER_RATE_LIMIT = _cfg.RATE_LIMIT_REGISTER


def _ratelimit_exceeded_handler(request: Request, exc: RateLimitExceeded):
    """Custom handler so the response body is JSON, not slowapi's default text."""
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=429,
        content={
            "detail": f"Rate limit exceeded: {exc.detail}. Try again later.",
        },
    )


# ──────────────────────────────────────────────────────────────────────
# SEC-02 (аудит stage8): выдача сессии
# ──────────────────────────────────────────────────────────────────────
# Единая точка выпуска пары «access + refresh»:
#   • access  — JWT на 30 минут (ACCESS_TOKEN_EXPIRE_MINUTES) с клеймами
#     jti/ver, живёт в HttpOnly cookie fc_at;
#   • refresh — непрозрачный случайный токен на 14 дней, в БД только SHA-256
#     хэш (отзывной, ротация при каждом /auth/refresh), HttpOnly cookie fc_rt.
# Обе функции (логин и регистрация) обязаны выдавать СЕССИЮ одинаково —
# раньше каждая собирала токен сама, и расхождение было делом времени.
async def _issue_session(
    db,
    request: Request,
    response: Response,
    user: User,
) -> tuple[str, str]:
    """Создать access+refresh, установить cookie. Вернуть (csrf, access).
    access возвращается для dev-режима (ENVIRONMENT=development кладёт его
    в JSON-ответ для Swagger/curl; в production он остаётся только в cookie)."""
    access = create_access_token({"sub": str(user.id), "ver": int(user.token_version or 0)})
    refresh = generate_refresh_token()
    db.add(RefreshToken(
        user_id=user.id,
        token_hash=hash_refresh_token(refresh),
        expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        user_agent=(request.headers.get("User-Agent") or "")[:512],
        ip=get_request_context(request)["ip"],
    ))
    set_auth_cookie(response, access)
    set_refresh_cookie(response, refresh)
    return set_csrf_cookie(response), access


async def _revoke_refresh_token(db, raw_token: str) -> Optional[RefreshToken]:
    """Отозвать конкретный refresh-токен (logout)."""
    row = (await db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw_token))
    )).scalar_one_or_none()
    if row and row.revoked_at is None:
        row.revoked_at = datetime.now(timezone.utc)
    return row


async def _revoke_all_user_tokens(db, user_id: int) -> int:
    """Отозвать ВСЕ refresh-сессии пользователя («выйти на всех устройствах»,
    деактивация, компрометация). Возвращает число отозванных строк."""
    rows = (await db.execute(
        select(RefreshToken).where(
            RefreshToken.user_id == user_id,
            RefreshToken.revoked_at.is_(None),
        )
    )).scalars().all()
    now = datetime.now(timezone.utc)
    for r in rows:
        r.revoked_at = now
    return len(rows)


# ──────────────────────────────────────────────────────────────────────
# /auth/register
# ──────────────────────────────────────────────────────────────────────
@router.post("/register", response_model=TokenResponse)
@limiter.limit(REGISTER_RATE_LIMIT)
async def register(
    request: Request,
    data: RegisterRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Register a new company + its first user (always role=owner).

    Issue #7: rate-limited to 3/min per IP. Combined with the backend
    password policy (Issue #8), this stops registration spam and weak
    passwords dead.
    """
    # Check email uniqueness
    existing = await db.execute(select(User).where(User.email == data.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    # Create company
    company = Company(name=data.company_name)
    db.add(company)
    await db.flush()

    # Create default settings
    db.add(TelegramSettings(company_id=company.id))
    db.add(ScraperSettings(company_id=company.id))

    # Create user
    user = User(
        company_id=company.id,
        email=data.email,
        hashed_password=get_password_hash(data.password),
        full_name=data.full_name,
        role=UserRole.owner,
    )
    db.add(user)

    # Audit log (CREATE Company + User) — attached to the same txn
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=company.id,
        user=user,
        action="CREATE",
        entity_type="Company",
        entity_id=company.id,
        new_value={"id": company.id, "name": company.name},
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )

    await db.commit()
    await db.refresh(user)

    # SEC-02: сессия = access (30 мин) + refresh (14 дней, отзывной).
    # ВАЖНО: _issue_session только ДОБАВЛЯЕТ refresh-строку в сессию —
    # commit ниже обязателен, иначе после ответа get_db() откатит
    # незакоммиченный INSERT и cookie fc_rt укажет на несуществующую строку
    # (первая же ротация вернёт 401 «Invalid or expired session»).
    csrf, access_token_value = await _issue_session(db, request, response, user)
    await db.commit()

    # Issue #3 (security hardening): in production, do NOT include the JWT
    # in the JSON response — it's already in the HttpOnly cookie, which
    # is the only place JavaScript SHOULD be able to send it from (XSS
    # can't read cookies). Including it in the JSON defeats the purpose
    # of HttpOnly. In dev, we include it for easier curl/Swagger testing.
    from app.core.config import settings as cfg
    if cfg.ENVIRONMENT != "development":
        access_token_value = None

    return TokenResponse(access_token=access_token_value, csrf_token=csrf)


# ──────────────────────────────────────────────────────────────────────
# /auth/login
# ──────────────────────────────────────────────────────────────────────
@router.post("/login", response_model=TokenResponse)
@limiter.limit(LOGIN_RATE_LIMIT)
async def login(
    request: Request,
    data: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Login. Issue #7: rate-limited to 10/min per IP. Returns the JWT both
    in the JSON body (in dev only — Issue #3) AND as an HttpOnly cookie."""
    result = await db.execute(select(User).where(User.email == data.email))
    user = result.scalar_one_or_none()

    if not user or not verify_password(data.password, user.hashed_password):
        # A failed login used to leave NO trace at all — every entry in the
        # audit log was a successful LOGIN, so password guessing was invisible.
        # Record the attempt for accounts we know (company_id is mandatory in
        # audit_log). Unknown e-mails can't be attributed to a company, so they
        # only go to the server log — with hashed IP, not the raw address.
        ctx = get_request_context(request)
        if user is None:
            logger.warning(
                "Failed login for unknown e-mail %r from ip=%s ua=%s",
                data.email, ctx["ip"], ctx["user_agent"][:80],
            )
        else:
            try:
                await audit_service.log(
                    db,
                    company_id=user.company_id,
                    user=user,
                    action="LOGIN_FAILED",
                    entity_type="User",
                    entity_id=user.id,
                    new_value={
                        "reason": "bad_password",
                        "email": data.email,
                        "is_active": bool(user.is_active),
                    },
                    ip=ctx["ip"],
                    user_agent=ctx["user_agent"],
                    client_id=ctx.get("client_id"),
                )
                # Commit BEFORE raising: the 401 aborts the request, and
                # get_db() closes the session without committing, which would
                # silently drop the audit row.
                await db.commit()
            except Exception as e:
                # Never let audit trouble change the response to the caller.
                logger.error(f"Failed to write LOGIN_FAILED audit row: {e}")
                await db.rollback()
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.is_active:
        ctx = get_request_context(request)
        try:
            await audit_service.log(
                db,
                company_id=user.company_id,
                user=user,
                action="LOGIN_FAILED",
                entity_type="User",
                entity_id=user.id,
                new_value={"reason": "account_disabled"},
                ip=ctx["ip"],
                user_agent=ctx["user_agent"],
                client_id=ctx.get("client_id"),
            )
            await db.commit()
        except Exception as e:
            logger.error(f"Failed to write LOGIN_FAILED audit row: {e}")
            await db.rollback()
        raise HTTPException(status_code=403, detail="Account is disabled")

    # SEC-02: единая точка выдачи сессии (access + refresh + все три cookie)
    csrf, access_token_value = await _issue_session(db, request, response, user)

    # Audit log
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=user.company_id,
        user=user,
        action="LOGIN",
        entity_type="User",
        entity_id=user.id,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()

    # Issue #3: in production, omit access_token from JSON body — the
    # HttpOnly cookie is the only channel that should expose the JWT.
    from app.core.config import settings as cfg
    if cfg.ENVIRONMENT != "development":
        access_token_value = None

    return TokenResponse(access_token=access_token_value, csrf_token=csrf)


# ──────────────────────────────────────────────────────────────────────
# /auth/logout
# ──────────────────────────────────────────────────────────────────────
@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SEC-02: полный выход — раньше просто очищалась cookie, а украденный
    токен жил бы дальше. Теперь:
      • refresh-строка текущей сессии отзывается (revoked_at);
      • clear_auth_cookie + clear_refresh_cookie сбрасывают обе HttpOnly cookie;
      • access-токен остаётся валидным максимум до конца своих 30 минут
        (сравнимо с практикой Google/GitHub — короткий хвост access-токена).
    Bearer-пользователи (без cookie) получают no-op успех."""
    from app.core.security import clear_auth_cookie
    raw_refresh = read_refresh_cookie(request)
    if raw_refresh:
        try:
            await _revoke_refresh_token(db, raw_refresh)
        except Exception as e:
            logger.error(f"Failed to revoke refresh token on logout: {e}")
            await db.rollback()
    clear_auth_cookie(response)
    clear_refresh_cookie(response)
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="LOGOUT",
        entity_type="User",
        entity_id=current_user.id,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────
# SEC-02: POST /auth/refresh — ротация сессии
# ──────────────────────────────────────────────────────────────────────
@router.post("/refresh")
@limiter.limit("30/minute")
async def refresh_session(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Обменять refresh-токен на новую пару access+refresh (ротация).

    Токен приходит ТОЛЬКО из HttpOnly cookie fc_rt (JS его не видит —
    XSS не может ни украсть, ни использовать). В теле не принимается:
    иначе refresh превратился бы в обход защиты cookie.

    Обнаружение повторного использования (reuse detection): попытка
    обмена УЖЕ отозванным токеном — признак кражи/повтора. В ответ все
    сессии пользователя отзываются, злоумышленник (и честный клиент с
    устаревшей копией) обязан заново пройти логин.

    Ошибки не различают «нет токена / истёк / отозван» — 401 без деталей,
    чтобы не помогать перебору.
    """
    from fastapi import status as _status
    from app.core.security import verify_csrf as _verify_csrf

    # POST по cookie — CSRF обязателен (double-submit, как у остальных мутаций)
    if not _verify_csrf(request):
        raise HTTPException(
            status_code=_status.HTTP_403_FORBIDDEN,
            detail="CSRF token missing or invalid",
        )

    raw = read_refresh_cookie(request)
    if not raw:
        raise HTTPException(status_code=401, detail="Not authenticated")

    now = datetime.now(timezone.utc)
    row = (await db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw))
    )).scalar_one_or_none()

    if row is None:
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    # SQLite (dev/тесты) возвращает наивные datetime — нормализуем к UTC,
    # чтобы сравнение не падало с TypeError (на PostgreSQL timestamptz
    # приходит уже осведомлённым).
    expires_at = row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if row.revoked_at is not None or expires_at <= now:
        # Повторное использование отозванного токена — возможная кража:
        # отзываем ВСЕ сессии пользователя и выходим.
        if row.revoked_at is not None:
            await _revoke_all_user_tokens(db, row.user_id)
            await db.commit()
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = (await db.execute(select(User).where(User.id == row.user_id))).scalar_one_or_none()
    if not user or not user.is_active:
        row.revoked_at = now
        await db.commit()
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    # Ротация: старая строка отзывается, выдаётся новая пара.
    row.revoked_at = now
    csrf, access_token_value = await _issue_session(db, request, response, user)
    await db.commit()

    from app.core.config import settings as cfg
    if cfg.ENVIRONMENT != "development":
        access_token_value = None

    return TokenResponse(access_token=access_token_value, csrf_token=csrf)


# ──────────────────────────────────────────────────────────────────────
# SEC-02: POST /auth/logout-all — выйти на ВСЕХ устройствах
# ──────────────────────────────────────────────────────────────────────
@router.post("/logout-all")
async def logout_all(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Отозвать все refresh-сессии пользователя и повысить token_version —
    все ранее выданные access-токены перестают действовать мгновенно
    (обычно после потери ноутбука / подозрении на компрометацию)."""
    revoked = await _revoke_all_user_tokens(db, current_user.id)
    current_user.token_version = int(current_user.token_version or 0) + 1
    clear_auth_cookie(response)
    clear_refresh_cookie(response)
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="LOGOUT_ALL",
        entity_type="User",
        entity_id=current_user.id,
        new_value={"revoked_sessions": revoked, "token_version": current_user.token_version},
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True, "revoked_sessions": revoked}


# ──────────────────────────────────────────────────────────────────────
# /auth/csrf-token — get or refresh the CSRF token cookie
# ──────────────────────────────────────────────────────────────────────
@router.get("/csrf-token")
async def get_csrf_token(
    request: Request,
    response: Response,
):
    """Return the current CSRF token (or issue a fresh one if missing).

    Use this from the frontend on app boot to populate the in-memory CSRF
    token after a page reload. The browser auto-sends the fc_csrf cookie,
    but JS memory (window.__FLEETCOST_CSRF__) is cleared on reload — so
    the frontend needs to re-fetch the token to send in the X-CSRF-Token
    header on state-changing requests.

    If the cookie is already present, we return its value (no rotation).
    If it's missing or invalid, we issue a fresh one.

    No authentication required — the endpoint is safe to call from any
    context, since it only ever returns the CSRF nonce (not the auth JWT).
    """
    from app.core.security import CSRF_COOKIE_NAME, set_csrf_cookie, _generate_csrf_token
    existing = request.cookies.get(CSRF_COOKIE_NAME)
    if existing and len(existing) >= 16:
        # Cookie is present and looks valid — return its value without
        # rotating it (so other tabs that already have it cached stay
        # in sync).
        return {"csrf_token": existing}
    # No cookie (or too short to be valid) — issue a fresh one.
    token = set_csrf_cookie(response)
    return {"csrf_token": token}


# ──────────────────────────────────────────────────────────────────────
# /auth/me — current user + role (for frontend role-aware UI)
# ──────────────────────────────────────────────────────────────────────
@router.get("/me", response_model=UserOut)
async def get_me(
    current_user: User = Depends(get_current_user),
):
    """Return the currently authenticated user, including role. The frontend
    uses this to decide which UI controls to render (e.g. hide the "Delete"
    button for viewers)."""
    return current_user


# ──────────────────────────────────────────────────────────────────────
# User management (owner-only)
# ──────────────────────────────────────────────────────────────────────
# The /auth/users endpoints let an owner add managers and viewers to their
# company. A viewer gets read-only access (see deps.py role dependencies).
@router.get("/users", response_model=list[UserOut])
async def list_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """List users in the current company. Owner-only (Issue #10 — previously
    any authenticated user could list all company users)."""
    result = await db.execute(
        select(User).where(User.company_id == current_user.company_id).order_by(User.created_at.desc())
    )
    return result.scalars().all()


@router.post("/users", response_model=UserOut)
async def create_user(
    request: Request,
    data: UserCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Create a manager or viewer under the current owner's company.
    Owner-only (Issue #10). The new user can NOT be created with role=owner
    (security: only the registration flow creates owners).
    """
    if current_user.role != UserRole.owner:
        raise HTTPException(403, "Only owners can manage users")
    if data.role == "owner":
        raise HTTPException(400, "Cannot create a new owner — register a new company instead")

    existing = await db.execute(select(User).where(User.email == data.email))
    if existing.scalar_one_or_none():
        raise HTTPException(400, "Email already registered")

    user = User(
        company_id=current_user.company_id,
        email=data.email,
        hashed_password=get_password_hash(data.password),
        full_name=data.full_name,
        role=UserRole(data.role),
    )
    db.add(user)
    # flush до аудита: id выдаёт база, и без него entity_id уходил как NULL —
    # запись аудита теряла связь с созданным пользователем (FC-025 в аудите).
    await db.flush()

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="CREATE",
        entity_type="User",
        entity_id=user.id,
        new_value={"email": user.email, "role": user.role.value if hasattr(user.role, "value") else user.role},
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
async def patch_user(
    user_id: int,
    request: Request,
    data: UserPatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Update full_name / role / is_active on a user. Owner-only.

    Role transitions (Issue #9):
      • owner → manager: allowed (with self-demotion guard below)
      • manager → owner: FORBIDDEN — only the registration flow creates
        owners. Use a separate "transfer ownership" mechanism instead.
      • manager ↔ viewer: allowed
      • anything → owner: FORBIDDEN via this endpoint.

    An owner cannot demote themselves (would lock themselves out).
    """
    result = await db.execute(select(User).where(
        User.id == user_id,
        User.company_id == current_user.company_id,
    ))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")

    old_snapshot = audit_service.snapshot(user)
    if data.full_name is not None:
        user.full_name = data.full_name
    if data.role is not None:
        if data.role not in ("owner", "manager", "viewer"):
            raise HTTPException(400, "role must be one of: owner, manager, viewer")
        # Issue #9: forbid role escalation TO owner via this endpoint.
        # Only the registration flow can create owners. Existing owners
        # can be demoted to manager/viewer, but the reverse requires a
        # separate "transfer ownership" operation (not implemented here).
        if data.role == "owner" and user.role != UserRole.owner:
            raise HTTPException(
                400,
                "Cannot promote a non-owner to owner via PATCH /users. "
                "Use the registration flow for a new owner, or implement "
                "a separate transfer-ownership endpoint."
            )
        # Prevent self-demotion: if the user is the current owner, don't let
        # them change their own role (would lock themselves out).
        if user.id == current_user.id and data.role != user.role.value:
            raise HTTPException(400, "You cannot change your own role")
        user.role = UserRole(data.role)
    if data.is_active is not None:
        if user.id == current_user.id and not data.is_active:
            raise HTTPException(400, "You cannot disable your own account")
        if not data.is_active and user.is_active:
            # SEC-02: деактивация немедленно отзывает все сессии пользователя —
            # и refresh-строки, и уже выданные access-токены (через token_version).
            await _revoke_all_user_tokens(db, user.id)
            user.token_version = int(user.token_version or 0) + 1
        user.is_active = data.is_active

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="UPDATE",
        entity_type="User",
        entity_id=user.id,
        old_value=old_snapshot,
        new_value=audit_service.snapshot(user),
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(user)
    return user


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Delete a user. Owner-only (Issue #10). Cannot delete yourself.
    Also cannot delete the last owner (would leave the company without
    an admin — Issue #9)."""
    result = await db.execute(select(User).where(
        User.id == user_id,
        User.company_id == current_user.company_id,
    ))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")
    if user.id == current_user.id:
        raise HTTPException(400, "You cannot delete your own account")
    # Issue #9: don't allow deleting the last owner — would leave the
    # company without anyone who can manage users.
    if user.role == UserRole.owner:
        owners_count_result = await db.execute(
            select(func.count(User.id)).where(
                User.company_id == current_user.company_id,
                User.role == UserRole.owner,
                User.is_active == True,
            )
        )
        owners_count = owners_count_result.scalar() or 0
        if owners_count <= 1:
            raise HTTPException(
                400,
                "Cannot delete the last owner of the company — promote another "
                "user to owner first (via registration of a new company, then "
                "merge — feature not yet implemented)."
            )

    old_snapshot = audit_service.snapshot(user)
    # Мягкое удаление. Физическое падало на FK из audit_log и import_history
    # (обе ссылаются на users.id) и вместе с пользователем уносило историю: кто
    # именно вносил изменения и загружал файлы (FC-011 в аудите). Доступ
    # отзывается сразу: get_current_user отклоняет неактивных (api/deps.py).
    # Восстановление — тем же переключателем «Включить» в списке пользователей.
    # SEC-02: плюс мгновенный отзыв всех сессий и access-токенов.
    user.is_active = False
    await _revoke_all_user_tokens(db, user.id)
    user.token_version = int(user.token_version or 0) + 1

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="DELETE",
        entity_type="User",
        entity_id=user_id,
        old_value=old_snapshot,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True}
