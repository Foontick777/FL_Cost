from datetime import datetime, timedelta, timezone
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
from cryptography.fernet import Fernet, InvalidToken
import base64
import secrets
import hmac
import hashlib
from fastapi import Response, Request

from app.core.config import settings

# pbkdf2_sha256 — NO 72 byte limit unlike bcrypt
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


# ──────────────────────────────────────────────────────────────────────
# Password hashing & JWT
# ──────────────────────────────────────────────────────────────────────
def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta=None) -> str:
    """SEC-02: в клеймы добавляются `jti` (уникальный id токена) и `ver`
    (версия access-токенов пользователя, см. User.token_version).
    deps.get_current_user сверяет `ver` с актуальным значением в БД —
    повышение версии мгновенно отзывает все ранее выданные токены."""
    to_encode = data.copy()
    if "jti" not in to_encode:
        to_encode["jti"] = secrets.token_urlsafe(16)
    if "ver" not in to_encode:
        to_encode["ver"] = 0
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None


# ──────────────────────────────────────────────────────────────────────
# Fernet symmetric encryption for e100 credentials
# ──────────────────────────────────────────────────────────────────────
# Issue #9: previously the encryption key was derived from arbitrary text
# by taking [:32].ljust(32, b"0"), which silently truncated/garbled any
# user-supplied string into a 32-byte value that may or may not match
# what Fernet actually requires. Fernet wants a 32-byte key encoded as
# urlsafe-base64 (44 chars). We now:
#   1. Treat ENCRYPTION_KEY as that 44-char base64 string verbatim.
#   2. Fail loudly at startup if it's not a valid Fernet key.
#   3. Provide a helper script (`scripts/generate_fernet_key.py`) that
#      generates one with Fernet.generate_key().
# The legacy fallback below is kept ONLY so existing deployments that
# haven't rotated their key yet keep working — but it logs a warning so
# the operator knows to migrate. New deployments MUST use a real key.
_fernet_instance: Optional[Fernet] = None
_fernet_legacy_warning_logged = False


def _is_valid_fernet_key(key_str: str) -> bool:
    """True if `key_str` is a valid urlsafe-base64-encoded 32-byte key
    that Fernet can use directly."""
    if not key_str:
        return False
    try:
        Fernet(key_str.encode() if isinstance(key_str, str) else key_str)
        return True
    except (ValueError, base64.binascii.Error):
        return False


def _get_fernet() -> Fernet:
    """Return a singleton Fernet instance, deriving it once from the
    configured ENCRYPTION_KEY. Raises RuntimeError if the key is unset or
    invalid — this is a startup-time failure, NOT a silent degradation."""
    global _fernet_instance, _fernet_legacy_warning_logged
    if _fernet_instance is not None:
        return _fernet_instance

    key_str = settings.ENCRYPTION_KEY
    if not key_str:
        raise RuntimeError(
            "ENCRYPTION_KEY is not set. Generate one with: "
            "python -m app.scripts.generate_fernet_key"
        )

    if _is_valid_fernet_key(key_str):
        _fernet_instance = Fernet(key_str.encode())
        return _fernet_instance

    # Legacy fallback: derive a 32-byte key from the configured string.
    # We keep this ONLY to avoid breaking existing deployments that
    # haven't rotated their key yet. A loud warning is logged on first
    # use so the operator knows to migrate.
    import logging
    log = logging.getLogger(__name__)
    if not _fernet_legacy_warning_logged:
        log.warning(
            "ENCRYPTION_KEY is not a valid Fernet key — using legacy "
            "derive-by-truncation fallback. This is insecure and will "
            "be removed. Run: python -m app.scripts.generate_fernet_key "
            "and update ENCRYPTION_KEY, then re-encrypt e100 credentials "
            "via /api/credentials/e100 (delete + re-add)."
        )
        _fernet_legacy_warning_logged = True

    key_bytes = key_str.encode()[:32].ljust(32, b"0")
    _fernet_instance = Fernet(base64.urlsafe_b64encode(key_bytes))
    return _fernet_instance


def encrypt_credentials(data: str) -> str:
    return _get_fernet().encrypt(data.encode()).decode()


def decrypt_credentials(data: str) -> str:
    try:
        return _get_fernet().decrypt(data.encode()).decode()
    except InvalidToken as e:
        raise RuntimeError(
            "Failed to decrypt credential — the ENCRYPTION_KEY has likely "
            "been rotated or corrupted. Re-enter the e100 credential."
        ) from e


# ──────────────────────────────────────────────────────────────────────
# Cookie helpers (Issue #5)
# ──────────────────────────────────────────────────────────────────────
AUTH_COOKIE_NAME = "fc_at"  # FleetCost auth token


def set_auth_cookie(response: Response, token: str) -> None:
    """Set the JWT as an HttpOnly Secure SameSite cookie on the response."""
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=True,
        secure=settings.SECURE_COOKIES,
        samesite=settings.COOKIE_SAMESITE,
        domain=settings.COOKIE_DOMAIN or None,
        path="/",
    )


def clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(
        key=AUTH_COOKIE_NAME,
        domain=settings.COOKIE_DOMAIN or None,
        path="/",
    )


def read_auth_cookie(request: Request) -> Optional[str]:
    return request.cookies.get(AUTH_COOKIE_NAME)


# ──────────────────────────────────────────────────────────────────────
# Refresh-токен (SEC-02, аудит stage8)
# ──────────────────────────────────────────────────────────────────────
# Непрозрачный случайный токен (не JWT): 32 байта энтропии, в БД лежит
# только SHA-256-хэш. Живёт в HttpOnly cookie fc_rt наравне с fc_at;
# ротация выполняется на каждом POST /auth/refresh.
REFRESH_COOKIE_NAME = "fc_rt"


def generate_refresh_token() -> str:
    """Непрозрачный refresh-токен: 256 бит энтропии, url-safe."""
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    """SHA-256 hex — в базе хранится только хэш (утечка дампа не выдаёт сессии).
    Медленный KDF не нужен: токен — 384 бита случайности, перебор бессмыслен."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        httponly=True,
        secure=settings.SECURE_COOKIES,
        samesite=settings.COOKIE_SAMESITE,
        domain=settings.COOKIE_DOMAIN or None,
        path="/",
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        domain=settings.COOKIE_DOMAIN or None,
        path="/",
    )


def read_refresh_cookie(request: Request) -> Optional[str]:
    return request.cookies.get(REFRESH_COOKIE_NAME)


# ──────────────────────────────────────────────────────────────────────
# CSRF protection (Issue #5, double-submit cookie pattern)
# ──────────────────────────────────────────────────────────────────────
# Double-submit pattern: server sets a non-HttpOnly CSRF cookie; the
# frontend reads it and sends the same value in the X-CSRF-Token header
# on every state-changing request. Server compares the two — if they
# match, the request originated from a context that could read the
# cookie (same-origin) and is therefore legitimate.
CSRF_COOKIE_NAME = "fc_csrf"
CSRF_HEADER_NAME = "X-CSRF-Token"


def _generate_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def set_csrf_cookie(response: Response) -> str:
    """Set (or refresh) the CSRF cookie. Returns the token so the caller
    can include it in the response body if it wants to."""
    token = _generate_csrf_token()
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=token,
        # CSRF-кука обязана жить не короче сессии (refresh-токена): раньше её
        # срок был привязан к access-токену (7 дней → 30 минут после SEC-02),
        # и она умирала раньше fc_rt — двойная отправка ломалась до конца сессии.
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        httponly=False,  # frontend JS must read this to send back in header
        secure=settings.SECURE_COOKIES,
        samesite=settings.COOKIE_SAMESITE,
        domain=settings.COOKIE_DOMAIN or None,
        path="/",
    )
    return token


def verify_csrf(request: Request) -> bool:
    """Verify that the X-CSRF-Token header matches the CSRF cookie.
    Returns True if the request is safe to proceed (or if CSRF protection
    is implicitly satisfied because the user is unauthenticated and the
    endpoint is GET/HEAD/OPTIONS)."""
    cookie_token = request.cookies.get(CSRF_COOKIE_NAME)
    header_token = request.headers.get(CSRF_HEADER_NAME)
    if not cookie_token or not header_token:
        return False
    return hmac.compare_digest(cookie_token, header_token)
