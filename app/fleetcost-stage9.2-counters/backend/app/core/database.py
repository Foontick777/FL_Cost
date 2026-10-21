from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.core.config import settings
import logging

log = logging.getLogger(__name__)


def _ensure_async_url(url: str) -> str:
    """If DATABASE_URL is a sync URL (psycopg2, sqlite), translate it to
    the async equivalent (asyncpg, aiosqlite). This protects against
    misconfiguration where someone sets DATABASE_URL=postgresql+psycopg2://...
    instead of postgresql+asyncpg://... — without this, create_async_engine()
    crashes at module load time with "The asyncio extension requires an async
    driver to be used. The loaded 'psycopg2' is not async."

    Also handles the bare 'postgresql://' case (defaults to psycopg2 in
    SQLAlchemy but needs asyncpg for the async engine)."""
    if not url:
        return url
    if url.startswith("postgresql+psycopg2://"):
        return url.replace("postgresql+psycopg2://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql://"):
        return "postgresql+asyncpg://" + url[len("postgresql://"):]
    if url.startswith("sqlite://"):
        return "sqlite+aiosqlite://" + url[len("sqlite://"):]
    return url


_async_url = _ensure_async_url(settings.DATABASE_URL)
if _async_url != settings.DATABASE_URL:
    log.warning(
        f"DATABASE_URL was a sync URL — auto-translated to async for the "
        f"app's async engine. Original: {settings.DATABASE_URL.split('@')[-1] if '@' in settings.DATABASE_URL else settings.DATABASE_URL}, "
        f"Translated: {_async_url.split('@')[-1] if '@' in _async_url else _async_url}"
    )

engine = create_async_engine(_async_url, echo=False)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()
