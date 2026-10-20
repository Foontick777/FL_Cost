from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.core.database import get_db, AsyncSessionLocal
from app.core.security import encrypt_credentials
from app.api.deps import (
    get_current_user,
    require_owner,
    require_manager,
    get_request_context,
)
from app.models.models import (
    User, Vehicle, E100Credential,
    TelegramSettings, ScraperSettings, UserRole,
)
from app.schemas.schemas import (
    VehicleCreate, VehicleUpdate, VehicleOut,
    E100CredentialCreate, E100CredentialOut, E100CredentialUpdate,
    TelegramSettingsUpdate, TelegramSettingsOut,
    ScraperSettingsUpdate, ScraperSettingsOut,
)
from app.services import audit_service, fx_service

router = APIRouter(tags=["settings"])

# Сам пароль не попадает в журнал никогда. Значения в журнале держим
# машинными (подписи полей переводит интерфейс), а «пароль изменился»
# передаём флагом password_changed.
_REDACTED_PASSWORD = "***"


# ── Vehicles (owner + manager) ────────────────────────
@router.get("/vehicles", response_model=list[VehicleOut])
async def list_vehicles(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Vehicle).where(Vehicle.company_id == current_user.company_id)
    )
    return result.scalars().all()


@router.post("/vehicles", response_model=VehicleOut)
async def add_vehicle(
    request: Request,
    data: VehicleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Add a vehicle. Owner or manager only (Issue #1 — viewer is forbidden)."""
    vehicle = Vehicle(
        company_id=current_user.company_id,
        plate_number=data.plate_number.upper(),
        description=data.description,
        driver_name=data.driver_name,
    )
    db.add(vehicle)
    await db.flush()
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="CREATE",
        entity_type="Vehicle",
        entity_id=vehicle.id,
        new_value=audit_service.snapshot(vehicle),
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(vehicle)
    return vehicle


@router.patch("/vehicles/{vehicle_id}", response_model=VehicleOut)
async def update_vehicle(
    vehicle_id: int,
    request: Request,
    data: VehicleUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    result = await db.execute(
        select(Vehicle).where(
            Vehicle.id == vehicle_id,
            Vehicle.company_id == current_user.company_id,
        )
    )
    vehicle = result.scalar_one_or_none()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    old_snapshot = audit_service.snapshot(vehicle)
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(vehicle, field, value)

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="UPDATE",
        entity_type="Vehicle",
        entity_id=vehicle.id,
        old_value=old_snapshot,
        new_value=audit_service.snapshot(vehicle),
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(vehicle)
    return vehicle


@router.delete("/vehicles/{vehicle_id}")
async def delete_vehicle(
    vehicle_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    result = await db.execute(
        select(Vehicle).where(
            Vehicle.id == vehicle_id,
            Vehicle.company_id == current_user.company_id,
        )
    )
    vehicle = result.scalar_one_or_none()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    old_snapshot = audit_service.snapshot(vehicle)
    # Мягкое удаление: машина уходит из работы, но история остаётся целой —
    # физическое удаление рвало ссылки из mileage, mileage_segments и договоров
    # (FC-012 в аудите). Восстановление — переключателем «Включить» в списке
    # автомобилей.
    vehicle.is_active = False
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="DELETE",
        entity_type="Vehicle",
        entity_id=vehicle_id,
        old_value=old_snapshot,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True}


# ── E100 Credentials (owner-only) ────────────────────
@router.get("/credentials/e100", response_model=list[E100CredentialOut])
async def list_e100_credentials(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    result = await db.execute(
        select(E100Credential).where(
            E100Credential.company_id == current_user.company_id
        )
    )
    return result.scalars().all()


@router.post("/credentials/e100", response_model=E100CredentialOut)
async def add_e100_credential(
    request: Request,
    data: E100CredentialCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Add e100 credentials. Owner-only (Issue #1)."""
    cred = E100Credential(
        company_id=current_user.company_id,
        label=data.label,
        username=data.username,
        encrypted_password=encrypt_credentials(data.password),
        source_account=fx_service.hash_source_account(data.username),
    )
    db.add(cred)
    await db.flush()
    # Don't snapshot the encrypted_password — it's sensitive.
    snapshot = audit_service.snapshot(cred)
    snapshot.pop("encrypted_password", None)
    snapshot["encrypted_password"] = "***"
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="CREATE",
        entity_type="E100Credential",
        entity_id=cred.id,
        new_value=snapshot,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(cred)
    return cred


@router.patch("/credentials/e100/{cred_id}", response_model=E100CredentialOut)
async def update_e100_credential(
    cred_id: int,
    request: Request,
    data: E100CredentialUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Change the login and/or the password of an EXISTING e100 credential.

    Зачем: e100 раз в несколько недель требует сменить пароль. Раньше правка
    сводилась к «удалить доступ и добавить заново», а это удаляло историю
    синхронизаций (last_sync_at / last_sync_status) и оставляло транзакции без
    ссылки на доступ. Здесь id доступа не меняется, поэтому история и связь
    с уже загруженными транзакциями сохраняются, а следующая синхронизация
    заходит с новыми данными — сборщик читает логин и расшифровывает пароль
    на каждом запуске.

    Body: {"username": "...", "password": "..."} — оба поля необязательны.

    Owner-only (Issue #1).
    """
    username = data.username.strip() if isinstance(data.username, str) else None
    password = data.password if isinstance(data.password, str) else None

    if username is None and password is None:
        raise HTTPException(400, "Nothing to update: pass username and/or password")
    if username is not None and not username:
        raise HTTPException(400, "Username cannot be empty")
    if password is not None and len(password) < 4:
        raise HTTPException(400, "Password too short (min 4 chars)")

    result = await db.execute(
        select(E100Credential).where(
            E100Credential.id == cred_id,
            E100Credential.company_id == current_user.company_id,
        )
    )
    cred = result.scalar_one_or_none()
    if not cred:
        raise HTTPException(404, "Credential not found")

    # «Было» — для журнала. Пароль в снимок не попадает никогда: в снимке
    # остаётся только факт его наличия.
    old_snapshot = audit_service.snapshot(cred)
    old_snapshot.pop("encrypted_password", None)
    old_snapshot["password"] = _REDACTED_PASSWORD

    login_changed = username is not None and username != cred.username
    if login_changed:
        cred.username = username
        # source_account — хеш логина: он попадёт в новые транзакции как признак
        # аккаунта-источника. Уникальность (company_id, source_account) держит БД,
        # поэтому повтор логина ловим как 409 ниже, а не молчаливым дублем.
        cred.source_account = fx_service.hash_source_account(username)

    if password is not None:
        cred.encrypted_password = encrypt_credentials(password)
        # Дата видна пользователю в настройках и в журнале: по ней понятно,
        # что доступ обновлён после требования e100 сменить пароль.
        cred.password_changed_at = datetime.now(timezone.utc)

    if not (login_changed or password is not None):
        return cred          # ничего не изменилось — журнал не засоряем

    # Следующая синхронизация обязана зайти с новыми данными: прошлый результат
    # входа больше не действителен (была ошибка «пароль неверный» — она уйдёт).
    cred.last_sync_status = None
    cred.last_sync_error = None

    new_snapshot = audit_service.snapshot(cred)
    new_snapshot.pop("encrypted_password", None)
    new_snapshot["password"] = _REDACTED_PASSWORD
    if password is not None:
        # Флаг, а не текст: срок и подпись («Пароль изменён») ставит интерфейс,
        # поэтому запись читается и в русском, и в английском виде.
        new_snapshot["password_changed"] = True

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        # Отдельное действие, а не UPDATE: смену пароля ищут в журнале глазами
        # («когда меняли пароль e100»), и она не должна теряться среди правок
        # других объектов.
        action="PASSWORD_CHANGE" if password is not None else "UPDATE",
        entity_type="E100Credential",
        entity_id=cred.id,
        old_value=old_snapshot,
        new_value=new_snapshot,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    try:
        await db.commit()
    except IntegrityError:
        # Тот же логин уже добавлен этим же доступом компании.
        await db.rollback()
        raise HTTPException(409, "Этот логин уже добавлен в другом доступе e100")
    await db.refresh(cred)
    return cred


@router.delete("/credentials/e100/{cred_id}")
async def delete_e100_credential(
    cred_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
    hard: bool = Query(default=True, description="True (default)=physically delete the row. "
                       "If transactions reference this credential, returns 409 with details. "
                       "Pass hard=false for soft-delete (sets is_active=false, keeps history)."),
):
    """Delete an e100 credential. Owner-only (Issue #1).

    Default behavior (Issue #8 fix): HARD delete. If the credential has
    been used by transactions, returns 409 Conflict with a message telling
    the user to use soft-delete (is_active=false) instead — that way the
    historical transactions still reference a valid credential_id.

    The previous version (soft-delete by default) confused users — they
    clicked "delete", the credential disappeared from the UI, but it was
    still in the DB. On next page load it came back, and they couldn't
    figure out why. Now: hard delete by default, explicit soft-delete
    only when there are FK references.
    """
    result = await db.execute(
        select(E100Credential).where(
            E100Credential.id == cred_id,
            E100Credential.company_id == current_user.company_id,
        )
    )
    cred = result.scalar_one_or_none()
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    old_snapshot = audit_service.snapshot(cred)
    old_snapshot.pop("encrypted_password", None)

    if hard:
        # Check if any transactions reference this credential — if yes,
        # refuse (would orphan them).
        from app.models.models import Transaction
        tx_count_result = await db.execute(
            select(func.count(Transaction.id)).where(
                Transaction.credential_id == cred_id,
            )
        )
        tx_count = tx_count_result.scalar() or 0
        if tx_count > 0:
            # Auto-fallback to soft delete with clear messaging
            cred.is_active = False
            ctx = get_request_context(request)
            await audit_service.log(
                db,
                company_id=current_user.company_id,
                user=current_user,
                action="UPDATE",
                entity_type="E100Credential",
                entity_id=cred_id,
                old_value=old_snapshot,
                new_value={"is_active": False, "reason": "soft-delete (had txns)"},
                ip=ctx["ip"],
                user_agent=ctx["user_agent"],
                client_id=ctx.get("client_id"),
            )
            await db.commit()
            return {
                "ok": True,
                "deleted": False,
                "mode": "soft",
                "is_active": False,
                "message": f"Нельзя физически удалить: {tx_count} транзакций ссылаются на "
                           f"этот credential. Вместо этого аккаунт отключён (is_active=false). "
                           f"Исторические транзакции сохранены.",
                "transactions_referenced": tx_count,
            }
        await db.delete(cred)
        ctx = get_request_context(request)
        await audit_service.log(
            db,
            company_id=current_user.company_id,
            user=current_user,
            action="DELETE",
            entity_type="E100Credential",
            entity_id=cred_id,
            old_value=old_snapshot,
            ip=ctx["ip"],
            user_agent=ctx["user_agent"],
            client_id=ctx.get("client_id"),
        )
        await db.commit()
        return {"ok": True, "deleted": True, "mode": "hard"}
    else:
        # Explicit soft delete — preserve the row, just mark inactive.
        cred.is_active = False
        ctx = get_request_context(request)
        await audit_service.log(
            db,
            company_id=current_user.company_id,
            user=current_user,
            action="UPDATE",
            entity_type="E100Credential",
            entity_id=cred_id,
            old_value=old_snapshot,
            new_value={"is_active": False},
            ip=ctx["ip"],
            user_agent=ctx["user_agent"],
            client_id=ctx.get("client_id"),
        )
        await db.commit()
        return {"ok": True, "deleted": False, "mode": "soft", "is_active": False}


# ── Telegram Settings (owner-only mutations) ─────────
@router.get("/telegram", response_model=TelegramSettingsOut)
async def get_telegram_settings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    result = await db.execute(
        select(TelegramSettings).where(
            TelegramSettings.company_id == current_user.company_id
        )
    )
    settings = result.scalar_one_or_none()
    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")
    return settings


@router.patch("/telegram", response_model=TelegramSettingsOut)
async def update_telegram_settings(
    request: Request,
    data: TelegramSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Update Telegram settings. Owner-only (Issue #1)."""
    result = await db.execute(
        select(TelegramSettings).where(
            TelegramSettings.company_id == current_user.company_id
        )
    )
    settings = result.scalar_one_or_none()
    if not settings:
        settings = TelegramSettings(company_id=current_user.company_id)
        db.add(settings)

    old_snapshot = audit_service.snapshot(settings)
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(settings, field, value)

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="UPDATE",
        entity_type="TelegramSettings",
        entity_id=settings.id,
        old_value=old_snapshot,
        new_value=audit_service.snapshot(settings),
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(settings)
    return settings


# ── Scraper Settings (owner-only mutations, reschedules scheduler) ──
@router.get("/scraper", response_model=ScraperSettingsOut)
async def get_scraper_settings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    result = await db.execute(
        select(ScraperSettings).where(
            ScraperSettings.company_id == current_user.company_id
        )
    )
    settings = result.scalar_one_or_none()
    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")
    return settings


@router.patch("/scraper", response_model=ScraperSettingsOut)
async def update_scraper_settings(
    request: Request,
    data: ScraperSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Update scraper settings. Owner-only (Issue #1).
    Issue #11: also reschedules the per-company scheduler job.
    """
    result = await db.execute(
        select(ScraperSettings).where(
            ScraperSettings.company_id == current_user.company_id
        )
    )
    settings = result.scalar_one_or_none()
    if not settings:
        settings = ScraperSettings(company_id=current_user.company_id)
        db.add(settings)

    old_snapshot = audit_service.snapshot(settings)
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(settings, field, value)

    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="UPDATE",
        entity_type="ScraperSettings",
        entity_id=settings.id,
        old_value=old_snapshot,
        new_value=audit_service.snapshot(settings),
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(settings)

    # Issue #11: reschedule this company's sync job with the new interval/enabled
    # state. We do this AFTER the commit so the scheduler reads the latest state.
    try:
        from app.main import _reschedule_per_company_jobs
        await _reschedule_per_company_jobs()
    except Exception as e:
        # Scheduler reschedule failure is non-fatal — settings were saved.
        import logging
        logging.getLogger(__name__).warning(f"Scheduler reschedule failed: {e}")

    return settings


# ── Manual Sync (owner-only) ─────────────────────────
@router.post("/sync")
async def trigger_sync(
    request: Request,
    current_user: User = Depends(require_owner),
):
    """Manually trigger e100 sync for current company. Owner-only (Issue #1).

    CONCURRENCY (user feedback #1): acquires an in-memory sync lock for
    this company. If another user (or another tab) is already syncing,
    returns 409 Conflict instead of starting a parallel sync that would
    create duplicate transactions. The lock auto-releases after 30 minutes
    (in case the sync crashed without releasing it).
    """
    from app.services.sync_lock import acquire_sync_lock, release_sync_lock, SYNC_LOCK_TTL_SECONDS
    acquired, locked_by_uid = acquire_sync_lock(current_user.company_id, current_user.id)
    if not acquired:
        # Locked by someone else — find who
        from sqlalchemy import select as sa_select
        from app.models.models import User as UserModel
        async with AsyncSessionLocal() as lock_db:
            r = await lock_db.execute(sa_select(UserModel).where(UserModel.id == locked_by_uid))
            other_user = r.scalar_one_or_none()
        other_name = other_user.email if other_user else f"user_id={locked_by_uid}"
        raise HTTPException(
            status_code=409,
            detail=f"Синхронизация уже запущена пользователем {other_name}. "
                   f"Дождитесь завершения или подождите {SYNC_LOCK_TTL_SECONDS // 60} минут — "
                   f"лок снимется автоматически."
        )

    try:
        from app.scraper.service import sync_company
        ctx = get_request_context(request)
        # We log BEFORE the sync so even if it crashes we have a record of who tried.
        async with AsyncSessionLocal() as log_db:
            await audit_service.log(
                log_db,
                company_id=current_user.company_id,
                user=current_user,
                action="SYNC",
                entity_type="Company",
                entity_id=current_user.company_id,
                ip=ctx["ip"],
                user_agent=ctx["user_agent"],
                client_id=ctx.get("client_id"),
            )
            await log_db.commit()
        result = await sync_company(current_user.company_id)
        # Синхронизация пишет транзакции — значит, как и импорт, она может оставить
        # строки без EUR, если курса на дату операции ещё не было. Дозагружаем
        # недостающие даты и пересчитываем; сбой докачки не превращает удачную
        # синхронизацию в ошибку (см. fx_autoload.auto_finish).
        from app.services import fx_autoload
        result["auto"] = await fx_autoload.auto_finish(current_user.company_id)
        return result
    finally:
        release_sync_lock(current_user.company_id, current_user.id)


@router.get("/sync/status")
async def sync_status(
    current_user: User = Depends(require_owner),
):
    """Check whether a sync is currently in progress for this company.
    Returns {locked: bool, locked_by: user_id|null, locked_by_email: str|null}.

    Frontend polls this to show "sync in progress by <user>" indicator."""
    from app.services.sync_lock import get_sync_lock_holder
    from sqlalchemy import select as sa_select
    from app.models.models import User as UserModel
    holder_uid = get_sync_lock_holder(current_user.company_id)
    if holder_uid is None:
        return {"locked": False, "locked_by": None, "locked_by_email": None}
    async with AsyncSessionLocal() as db:
        r = await db.execute(sa_select(UserModel).where(UserModel.id == holder_uid))
        other_user = r.scalar_one_or_none()
    return {
        "locked": True,
        "locked_by": holder_uid,
        "locked_by_email": other_user.email if other_user else None,
    }
