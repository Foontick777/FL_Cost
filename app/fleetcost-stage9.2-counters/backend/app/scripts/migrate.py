"""Smart migration runner: handles the case where the database already has
the old schema (created via Base.metadata.create_all) but no alembic_version
table — alembic doesn't know where to start.

Usage:
    python -m app.scripts.migrate

Logic:
  1. Connect to the database (sync URL — psycopg2, not asyncpg).
  2. Inspect existing tables.
  3. If `companies` exists but `alembic_version` doesn't → STAMP 0001_baseline
     (tells alembic "the baseline is already applied; trust me").
  4. Run `alembic upgrade head` — applies 0002_security_hardening on top of
     the existing schema (Float→Numeric, FX, audit_log, provenance).
  5. On a FRESH database (no tables at all) → just run `alembic upgrade head`,
     which creates everything via 0001_baseline.

Exits 0 on success, non-zero on failure. In production a non-zero exit stops
the container: the start command is `python -m app.scripts.migrate && uvicorn`
(Dockerfile, docker-compose), so the backend will not come up on a schema that
was not migrated. In development the previous behaviour is kept — uvicorn
starts and Base.metadata.create_all creates missing tables (it cannot add
columns to existing ones).
"""
import os
import sys

# Make `app` importable when this script runs from the backend/ directory
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _get_sync_url() -> str:
    """Convert the async DATABASE_URL to a sync URL for alembic.
    Handles both PostgreSQL (asyncpg → psycopg2) and SQLite (aiosqlite → sqlite3)."""
    url = os.environ.get("DATABASE_URL") or ""
    if not url:
        # Fall back to default — but this almost certainly won't connect in prod
        url = "postgresql+asyncpg://fleetcost:changeme@localhost:5432/fleetcost"
    return (
        url.replace("postgresql+asyncpg://", "postgresql+psycopg2://")
           .replace("postgresql://", "postgresql+psycopg2://")
           .replace("sqlite+aiosqlite://", "sqlite://")
    )


def _check_db_state(sync_url: str) -> dict:
    """Inspect the database. Returns {tables, has_companies, has_alembic_version}."""
    from sqlalchemy import create_engine, inspect
    engine = create_engine(sync_url)
    try:
        insp = inspect(engine)
        tables = insp.get_table_names()
    except Exception as e:
        # Can't even inspect — probably DB not running. Surface a clear error.
        print(f"❌ Cannot connect to database: {e}", file=sys.stderr)
        return {"tables": [], "has_companies": False, "has_alembic_version": False,
                "connect_error": str(e)}
    finally:
        engine.dispose()
    return {
        "tables": tables,
        "has_companies": "companies" in tables,
        "has_alembic_version": "alembic_version" in tables,
    }


def _is_production() -> bool:
    """Production ли это окружение.

    Читаем переменную напрямую, а не через settings: импорт конфига выполняет
    валидацию секретов, и в разработке без заполненного .env он бы упал ещё до
    миграций. Имя и значение по умолчанию — те же, что в core/config.py
    (ENVIRONMENT = "development").
    """
    return (os.getenv("ENVIRONMENT") or "development").strip().lower() == "production"


def main() -> int:
    sync_url = _get_sync_url()
    print(f"🔧 Migration runner starting")
    print(f"   DATABASE_URL (sync): {sync_url.replace('://'+(sync_url.split('://')[1].split('@')[0]+'@' if '@' in sync_url else ''),'://***@')}")

    state = _check_db_state(sync_url)
    if "connect_error" in state:
        # В production недоступная база — не «подождём и заработает»: приложение
        # поднялось бы на неполной схеме и писало бы в неё. Пусть контейнер
        # падает и перезапускается, ошибка останется в логах.
        if _is_production():
            print(f"❌ Database unreachable in production — refusing to start.", file=sys.stderr)
            return 1
        print(f"⚠️  Database unreachable, skipping migrations. Lifespan will retry.", file=sys.stderr)
        return 0

    tables = state["tables"]
    print(f"   Existing tables: {len(tables)} ({', '.join(sorted(tables)[:5])}{'...' if len(tables)>5 else ''})")
    print(f"   has 'companies': {state['has_companies']}")
    print(f"   has 'alembic_version': {state['has_alembic_version']}")

    # IMPORTANT: do NOT override os.environ["DATABASE_URL"] with the sync URL!
    # env.py's _sync_url() translates the async URL to sync on the fly.
    # If we overwrite it here, app.core.database loads with a sync URL
    # and create_async_engine() crashes: "The asyncio extension requires
    # an async driver to be used. The loaded 'psycopg2' is not async."

    # Make sure `app` package is importable so env.py can do its imports
    from alembic.config import Config
    from alembic import command

    # Find alembic.ini relative to this script (in backend/)
    backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    alembic_ini = os.path.join(backend_dir, "alembic.ini")
    script_loc = os.path.join(backend_dir, "alembic")

    cfg = Config(alembic_ini)
    cfg.set_main_option("script_location", script_loc)

    if state["has_companies"] and not state["has_alembic_version"]:
        # Pre-Alembic existing schema. Stamp the baseline so alembic knows
        # the tables 0001_baseline creates are already there, then apply
        # 0002_security_hardening on top.
        print(f"📌 Detected pre-Alembic schema (companies exists, alembic_version missing)")
        print(f"   Stamping baseline 0001_baseline...")
        try:
            command.stamp(cfg, "0001_baseline")
            print(f"   ✓ Stamped")
        except Exception as e:
            print(f"   ❌ Stamp failed: {e}", file=sys.stderr)
            return 1

    print(f"🚀 Running alembic upgrade head...")
    try:
        command.upgrade(cfg, "head")
        print(f"✓ Migration complete.")
        return 0
    except Exception as e:
        print(f"❌ alembic upgrade head failed: {e}", file=sys.stderr)
        # Контейнер стартует командой `python -m app.scripts.migrate && uvicorn ...`
        # (backend/Dockerfile:21, docker-compose.yml:55), поэтому non-zero exit
        # останавливает запуск. В production это и требуется: работать на
        # несовместимой схеме с финансовыми данными опаснее, чем не подняться.
        if _is_production():
            print(f"❌ Refusing to start on an unmigrated schema.", file=sys.stderr)
            return 1
        # В разработке сохраняем прежнее удобство: create_all создаст
        # недостающие таблицы (колонки он не добавляет — об этом предупреждаем).
        print(f"⚠️  Continuing anyway — lifespan will try Base.metadata.create_all as fallback.", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
