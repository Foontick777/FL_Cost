from pydantic_settings import BaseSettings
from typing import Optional, Literal
import logging

log = logging.getLogger(__name__)


# Sentinel values that indicate "the user didn't change the default" — used
# for fail-closed startup validation (Issue #7).
_INSECURE_SECRET_KEY = "change_this_secret_key_in_production"
_INSECURE_ENCRYPTION_KEY = ""  # empty by default; user must generate one

# Substrings that mark a value as a placeholder rather than a real secret.
# Checking the exact sentinel alone was not enough: .env.example ships
# `SECRET_KEY=replace_with_random_hex`, so copying the file and forgetting to
# edit it produced a production deployment signed with a PUBLIC key — anyone
# who read the repo could mint a JWT for any user id.
_PLACEHOLDER_MARKERS = (
    "change_this_secret_key",
    "replace_with_random_hex",
    "your_secret",
    "your-secret",
    "placeholder",
    "changeme",
    "change_me",
    "example",
    "todo",
    "insert_",
    "xxxx",
)
# Weak database passwords (lower-cased, exact match).
_WEAK_DB_PASSWORDS = {
    "",
    "changeme",
    "changeme_strong_password_here",
    "postgres",
    "password",
    "fleetcost",
    "secret",
    "admin",
}


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://fleetcost:changeme@localhost:5432/fleetcost"

    # Security — JWT signing
    SECRET_KEY: str = _INSECURE_SECRET_KEY
    ALGORITHM: str = "HS256"
    # SEC-02 (аудит stage8): раньше access-токен жил 7 дней и не отзывался —
    # украденный cookie оставался валидным неделю. Теперь access живёт 30 минут,
    # а долгоживущую сессию держит отзывной refresh-токен (см. RefreshToken):
    # украденный access теряет силу максимум через полчаса, а logout/смена
    # пароля/деактивация пользователя отзывают сессию мгновенно.
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    # Срок жизни refresh-токена (сессии). Ротация при каждом /auth/refresh;
    # выход из строя Frankfurter/ЕЦБ на срок жизни сессии не влияет.
    REFRESH_TOKEN_EXPIRE_DAYS: int = 14

    # Encryption key for storing e100 credentials. Must be a valid Fernet key
    # (32 url-safe base64-encoded bytes — i.e. 44 ASCII chars).
    # Generate one with:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # DO NOT store this key alongside DB backups — see README "Security notes".
    ENCRYPTION_KEY: str = _INSECURE_ENCRYPTION_KEY

    # Telegram bot
    TELEGRAM_BOT_TOKEN: Optional[str] = None

    # Scraper defaults
    DEFAULT_SCRAPE_INTERVAL_MINUTES: int = 60

    # ─── Security hardening (added in security-v2) ────────────────────────

    # Environment name — controls whether /docs /redoc /openapi.json are exposed.
    # "development"  → docs open
    # "staging"/"production" → docs closed (404)
    ENVIRONMENT: Literal["development", "staging", "production"] = "development"

    # Cookie-based JWT (Issue #5). When True, /auth/login and /auth/register
    # set an HttpOnly Secure SameSite=Lax cookie in addition to returning
    # the token in the JSON body (backward-compat with the existing SPA).
    # The frontend should stop reading localStorage and rely on the cookie.
    SECURE_COOKIES: bool = False  # set True in production (HTTPS-only)
    COOKIE_DOMAIN: Optional[str] = None  # e.g. "fleetcost.example.com" or None for host-only
    COOKIE_SAMESITE: Literal["lax", "strict", "none"] = "lax"

    # FX rates (Issue #3). ECB daily reference rates are fetched from:
    #   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
    # No API key required. Cached in the fx_rates table.
    FX_ECB_URL: str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
    FX_FALLBACK_RATE: float = 0.0  # 0.0 means "fail loud if currency unknown"

    # Курсы валют, которых нет в архиве ЕЦБ (BYN, RSD, UAH, MDL, GEL…): публичный
    # сервис Frankfurter (https://frankfurter.dev), без ключа. Валюты ЕЦБ по-прежнему
    # берутся из ЕЦБ — этот источник для них не используется.
    #   FX_FRANKFURTER_ENABLED   — выключатель: false → такие валюты только вручную.
    #   FX_FRANKFURTER_URL       — адрес; при росте нагрузки сервис можно развернуть
    #                              у себя (открытый код, Docker) и указать здесь.
    #   FX_FRANKFURTER_PROVIDERS — необязательно: список источников через запятую
    #                              (например NBRB — официальный курс Нацбанка Беларуси).
    #                              Пусто = усреднённый курс сервиса.
    FX_FRANKFURTER_ENABLED: bool = True
    FX_FRANKFURTER_URL: str = "https://api.frankfurter.dev"
    FX_FRANKFURTER_PROVIDERS: str = ""

    # Audit log retention (days) — rows older than this are purged by a
    # nightly APScheduler job. 0 = keep forever.
    AUDIT_LOG_RETENTION_DAYS: int = 0

    # ── Rate limits (slowapi syntax: "10/minute", "3/hour", "100/day") ──
    # Configurable mainly for local testing: on http://localhost:3000 every
    # request comes from 127.0.0.1, so all logins share ONE bucket and the
    # production default of 10/minute is easy to hit while clicking around.
    RATE_LIMIT_LOGIN: str = "10/minute"
    RATE_LIMIT_REGISTER: str = "3/minute"

    class Config:
        env_file = ".env"
        # Tolerate extra env vars (e.g. POSTGRES_USER from docker-compose)
        extra = "ignore"


settings = Settings()


# ──────────────────────────────────────────────────────────────────────
# Issue #7: fail-closed startup validation
# ──────────────────────────────────────────────────────────────────────
def _validate_production_security() -> None:
    """In production, refuse to start with insecure defaults. Better to
    fail loudly at startup than to silently run with a known-compromised
    SECRET_KEY / ENCRYPTION_KEY / cookie configuration.

    Called once at app startup (in main.py lifespan). Errors here are
    fatal — the app will not start, which is exactly the point.
    """
    if (settings.ENVIRONMENT or "").lower() == "development":
        # Послабление только для локальной разработки. Раньше пропускались ВСЕ
        # окружения кроме production, поэтому staging мог жить со слабыми
        # секретами и небезопасными cookie (FC-020 в аудите).
        return

    problems = []

    # ── SECRET_KEY ────────────────────────────────────────────────────
    # Reject: empty, the sentinel, any known placeholder, anything shorter
    # than 32 chars. `secrets.token_hex(32)` produces 64 hex chars.
    sk = (settings.SECRET_KEY or "").strip()
    sk_lower = sk.lower()
    if (
        not sk
        or sk == _INSECURE_SECRET_KEY
        or len(sk) < 32
        or any(m in sk_lower for m in _PLACEHOLDER_MARKERS)
    ):
        problems.append(
            f"SECRET_KEY is empty, too short ({len(sk)} chars, need >= 32) or still a "
            "placeholder. Generate one with: "
            "python -c \"import secrets; print(secrets.token_hex(32))\""
        )

    if not settings.ENCRYPTION_KEY or settings.ENCRYPTION_KEY == _INSECURE_ENCRYPTION_KEY:
        problems.append(
            "ENCRYPTION_KEY is empty. Generate one with: "
            "python -m app.scripts.generate_fernet_key"
        )

    if not settings.SECURE_COOKIES:
        problems.append(
            "SECURE_COOKIES=false in production — auth cookies would be sent "
            "over plain HTTP, exposing the JWT to network eavesdroppers."
        )

    # ── Database password ─────────────────────────────────────────────
    # Previously this checked `DATABASE_URL.endswith("changeme@localhost:5432/fleetcost")`,
    # which never matched the docker-compose default (`...@postgres:5432/...`).
    # Parse the password out of the URL instead of pattern-matching the host.
    db_pwd = ""
    try:
        _creds = settings.DATABASE_URL.split("://", 1)[1].split("@", 1)[0]
        db_pwd = _creds.split(":", 1)[1] if ":" in _creds else ""
    except Exception:
        db_pwd = ""
    if db_pwd.lower() in _WEAK_DB_PASSWORDS or "changeme" in db_pwd.lower():
        problems.append(
            "The database password in DATABASE_URL is a default/weak value "
            f"({db_pwd!r}). Set POSTGRES_PASSWORD to a strong unique value."
        )

    if problems:
        msg = "\n".join(f"  ✗ {p}" for p in problems)
        raise RuntimeError(
            f"\n\n🔒 Refusing to start in production with insecure configuration:\n{msg}\n\n"
            f"Fix these in your .env file and restart.\n"
        )


# Run the validation at import time so the failure is loud, not silent.
_validate_production_security()
