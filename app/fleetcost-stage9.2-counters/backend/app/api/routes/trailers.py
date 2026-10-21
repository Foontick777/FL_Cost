"""Реестр прицепов: список, ручное добавление, привязка к машинам.

Почему отдельный ресурс
-----------------------
До него прицепов как объектов не было: список на странице собирался из НОМЕРОВ в
расходах. Прицеп без расходов для системы не существовал, а опечатка в номере
создавала «второй» прицеп. Здесь прицеп — объект, а связь с машиной — ПЕРИОД.

Что показал анализ выгрузок (488 счетов, сен 2025 — сен 2026)
-------------------------------------------------------------
• 89 «прицепо-месяцев»: 70 с одной машиной, 16 с двумя, 2 с тремя, 1 с четырьмя.
  То есть прицеп реально работает с разными тягачами, и в том числе В ОДНОМ
  месяце. Фиксированная привязка «прицеп → машина» была бы неверна.
• В данных есть опечатки номеров: «QARP49» вместо «QARP459», «BU422GV» вместо
  «BI422GV», «BI4866GS» вместо «BI866GS», «BI866LL» вместо «BI886LL»,
  «BI329LE» вместо «BI329LF», «BI724LE/BI724LF». Часть «многомашинных» месяцев
  объясняется именно ими, а не реальной ротацией.
• 27 счетов (5,5%) вообще без пары «тягач/прицеп» (например, Nota obciążona за
  отмену заявки) — для них прицеп определить нечем.

Отсюда два вывода, которые определили устройство:
1. Равномерное распределение расходов по прицепам остаётся ОСНОВНЫМ: связать
   расход с конкретной машиной можно не всегда, и ошибка в привязке хуже, чем
   равная доля.
2. Ручная привязка нужна там, где пользователь знает точно, — и она хранится
   периодом, чтобы не переписывать прошлое.
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_request_context, require_manager
from app.core.database import get_db
from app.models.models import Trailer, TrailerBinding, Transaction, User, Vehicle
from app.services import audit_service

router = APIRouter(prefix="/trailers", tags=["trailers"])


def normalize_plate(value: Optional[str]) -> str:
    """Привести номер к единому виду: без пробелов, в верхнем регистре.

    Пробелы и регистр — самый частый источник «разных» номеров у одного прицепа:
    «qasb 981» и «QASB981» должны быть одним прицепом.
    """
    return "".join((value or "").split()).upper()


class TrailerCreate(BaseModel):
    plate: str = Field(min_length=2, max_length=20)
    note: Optional[str] = None

    @field_validator("plate")
    @classmethod
    def _check(cls, v):
        v = normalize_plate(v)
        if len(v) < 2:
            raise ValueError("номер прицепа слишком короткий")
        return v


class TrailerPatch(BaseModel):
    plate: Optional[str] = None
    note: Optional[str] = None
    is_active: Optional[bool] = None
    # Исправление опечатки: перенести всё с этого прицепа на существующий.
    merge_into: Optional[str] = None


class BindRequest(BaseModel):
    plate_number: Optional[str] = None      # номер машины
    vehicle_id: Optional[int] = None
    from_date: date
    to_date: Optional[date] = None
    note: Optional[str] = None
    # Если у машины уже есть другой прицеп — по умолчанию спрашиваем подтверждение.
    allow_parallel: bool = False

    @field_validator("plate_number")
    @classmethod
    def _norm(cls, v):
        return normalize_plate(v) if v else None


class UnbindRequest(BaseModel):
    to_date: Optional[date] = None


async def ensure_trailer(db: AsyncSession, company_id: int, plate: str,
                         origin: str = "import") -> Optional[Trailer]:
    """Найти прицеп по номеру или завести его. Идемпотентно.

    Вызывается из импорта счетов и из ручного расхода: так реестр наполняется
    тем, что реально встречается в данных, и пользователю не нужно вручную
    заводить одиннадцать прицепов, чтобы начать работу.
    """
    plate = normalize_plate(plate)
    if not plate:
        return None
    row = (await db.execute(
        select(Trailer).where(Trailer.company_id == company_id, Trailer.plate == plate)
    )).scalar_one_or_none()
    if row:
        return row
    row = Trailer(company_id=company_id, plate=plate, origin=origin)
    db.add(row)
    await db.flush()
    return row


def _similar(existing: list[str], plate: str, limit: int = 3) -> list[str]:
    """Похожие номера — подсказка про опечатку.

    В данных встречается «QARP49» рядом с «QARP459»: это один прицеп, но для
    системы два. Молча объединять нельзя (можно ошибиться и слить два разных
    прицепа), поэтому показываем подсказку и решение принимает пользователь.
    """
    scored = []
    for other in existing:
        if other == plate:
            continue
        ratio = SequenceMatcher(None, other, plate).ratio()
        # Короткие номера сравниваем строже: у «QARP49» и «QARP459» совпадение
        # высокое именно из-за длины, поэтому порог ниже для длинных номеров.
        if ratio >= 0.85 and abs(len(other) - len(plate)) <= 2:
            scored.append((ratio, other))
    scored.sort(reverse=True)
    return [p for _r, p in scored[:limit]]


async def _usage(db: AsyncSession, company_id: int, plates: list[str]):
    """Сколько операций и какие даты связаны с прицепами — одним запросом."""
    if not plates:
        return {}
    rows = (await db.execute(
        select(
            Transaction.trailer_plate,
            func.count(),
            func.min(Transaction.transaction_date),
            func.max(Transaction.transaction_date),
        ).where(
            Transaction.company_id == company_id,
            Transaction.trailer_plate.in_(plates),
        ).group_by(Transaction.trailer_plate)
    )).all()
    out = {}
    for plate, count, first_dt, last_dt in rows:
        out[plate] = {
            "operations": int(count or 0),
            "first_seen": first_dt.date().isoformat() if hasattr(first_dt, "date") else None,
            "last_seen": last_dt.date().isoformat() if hasattr(last_dt, "date") else None,
        }
    return out


async def _current_bindings(db: AsyncSession, company_id: int, trailer_ids: list[int]):
    if not trailer_ids:
        return {}
    rows = (await db.execute(
        select(TrailerBinding).where(
            TrailerBinding.company_id == company_id,
            TrailerBinding.trailer_id.in_(trailer_ids),
            TrailerBinding.to_date.is_(None),
        ).order_by(TrailerBinding.from_date.desc())
    )).scalars().all()
    out = {}
    for b in rows:
        out.setdefault(b.trailer_id, b)
    return out


@router.get("")
async def list_trailers(
    include_inactive: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Список прицепов компании с текущей привязкой и подсказками про опечатки."""
    q = select(Trailer).where(Trailer.company_id == current_user.company_id)
    if not include_inactive:
        q = q.where(Trailer.is_active == True)
    rows = (await db.execute(q.order_by(Trailer.plate))).scalars().all()
    plates = [t.plate for t in rows]
    usage = await _usage(db, current_user.company_id, plates)
    bindings = await _current_bindings(db, current_user.company_id, [t.id for t in rows])
    out = []
    for t in rows:
        b = bindings.get(t.id)
        out.append({
            "id": t.id,
            "plate": t.plate,
            "note": t.note,
            "origin": t.origin,
            "is_active": t.is_active,
            "binding": ({
                "id": b.id,
                "vehicle_id": b.vehicle_id,
                "plate_number": b.plate_number,
                "from_date": b.from_date.isoformat() if b.from_date else None,
                "to_date": b.to_date.isoformat() if b.to_date else None,
                "note": b.note,
            } if b else None),
            "similar": _similar(plates, t.plate),
            **usage.get(t.plate, {"operations": 0, "first_seen": None, "last_seen": None}),
        })
    return out


@router.get("/{trailer_id}/bindings")
async def list_bindings(
    trailer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """История привязок прицепа — чтобы было видно, с какими машинами он работал."""
    trailer = await _get(db, current_user.company_id, trailer_id)
    rows = (await db.execute(
        select(TrailerBinding).where(
            TrailerBinding.company_id == current_user.company_id,
            TrailerBinding.trailer_id == trailer.id,
        ).order_by(TrailerBinding.from_date.desc())
    )).scalars().all()
    return [{
        "id": b.id, "vehicle_id": b.vehicle_id, "plate_number": b.plate_number,
        "from_date": b.from_date.isoformat() if b.from_date else None,
        "to_date": b.to_date.isoformat() if b.to_date else None, "note": b.note,
    } for b in rows]


async def _get(db: AsyncSession, company_id: int, trailer_id: int) -> Trailer:
    row = (await db.execute(
        select(Trailer).where(Trailer.id == trailer_id, Trailer.company_id == company_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Trailer not found")
    return row


@router.post("", status_code=201)
async def create_trailer(
    data: TrailerCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Добавить прицеп вручную.

    Нужно, когда прицеп только взяли в аренду и расходов по нему ещё нет: без
    этого он не существовал бы в системе до первого расхода.
    """
    plate = normalize_plate(data.plate)
    existing = (await db.execute(
        select(Trailer).where(Trailer.company_id == current_user.company_id,
                              Trailer.plate == plate)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(409, f"Прицеп {plate} уже есть в списке")
    all_plates = [p for (p,) in (await db.execute(
        select(Trailer.plate).where(Trailer.company_id == current_user.company_id)
    )).all()]
    trailer = Trailer(company_id=current_user.company_id, plate=plate,
                      note=(data.note or "").strip() or None,
                      origin="manual", created_by=current_user.id)
    db.add(trailer)
    await db.flush()
    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user,
        action="create", entity_type="Trailer", entity_id=trailer.id,
        new_value=audit_service.snapshot(trailer),
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    await db.refresh(trailer)
    return {"id": trailer.id, "plate": trailer.plate, "note": trailer.note,
            "origin": trailer.origin, "similar": _similar(all_plates, plate)}


@router.patch("/{trailer_id}")
async def update_trailer(
    trailer_id: int,
    data: TrailerPatch,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Переименовать прицеп или объединить с другим (исправление опечатки).

    Объединение переносит операции и привязки на целевой прицеп. Это нужно именно
    потому, что в счетах встречаются опечатки: «QARP49» и «QARP459» — один прицеп,
    и после исправления расходы по нему должны быть в одном месте.
    """
    trailer = await _get(db, current_user.company_id, trailer_id)
    before = audit_service.snapshot(trailer)

    if data.merge_into:
        target_plate = normalize_plate(data.merge_into)
        target = (await db.execute(
            select(Trailer).where(Trailer.company_id == current_user.company_id,
                                  Trailer.plate == target_plate,
                                  Trailer.id != trailer.id)
        )).scalar_one_or_none()
        if not target:
            raise HTTPException(404, f"Прицеп {target_plate} не найден")
        # Переносим операции (в них номер хранится строкой) и привязки.
        moved_tx = (await db.execute(
            select(func.count()).select_from(Transaction).where(
                Transaction.company_id == current_user.company_id,
                Transaction.trailer_plate == trailer.plate)
        )).scalar() or 0
        await db.execute(
            Transaction.__table__.update()
            .where(Transaction.company_id == current_user.company_id,
                   Transaction.trailer_plate == trailer.plate)
            .values(trailer_plate=target.plate)
        )
        await db.execute(
            TrailerBinding.__table__.update()
            .where(TrailerBinding.trailer_id == trailer.id)
            .values(trailer_id=target.id)
        )
        await db.delete(trailer)
        ctx = get_request_context(request)
        await audit_service.log(
            db, company_id=current_user.company_id, user=current_user,
            action="merge", entity_type="Trailer", entity_id=target.id,
            old_value=before, new_value={"merged_into": target.plate, "moved_operations": int(moved_tx)},
            ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
        )
        await db.commit()
        return {"ok": True, "merged_into": target.plate, "moved_operations": int(moved_tx)}

    if data.plate is not None:
        new_plate = normalize_plate(data.plate)
        if new_plate != trailer.plate:
            clash = (await db.execute(
                select(Trailer).where(Trailer.company_id == current_user.company_id,
                                      Trailer.plate == new_plate, Trailer.id != trailer.id)
            )).scalar_one_or_none()
            if clash:
                raise HTTPException(409, f"Номер {new_plate} уже занят другим прицепом")
            # Операции хранят номер строкой — переименование должно их догнать,
            # иначе расходы остались бы на «старом» прицепе, которого уже нет.
            await db.execute(
                Transaction.__table__.update()
                .where(Transaction.company_id == current_user.company_id,
                       Transaction.trailer_plate == trailer.plate)
                .values(trailer_plate=new_plate)
            )
            trailer.plate = new_plate
    if data.note is not None:
        trailer.note = (data.note or "").strip() or None
    if data.is_active is not None:
        trailer.is_active = bool(data.is_active)

    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user,
        action="update", entity_type="Trailer", entity_id=trailer.id,
        old_value=before, new_value=audit_service.snapshot(trailer),
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"id": trailer.id, "plate": trailer.plate, "note": trailer.note,
            "is_active": trailer.is_active}


@router.post("/{trailer_id}/bind")
async def bind_trailer(
    trailer_id: int,
    data: BindRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Привязать прицеп к машине с даты (и, если нужно, по дату).

    Правила, которые здесь заложены:
    • машина должна быть в парке — иначе привязка «в никуда», и расходы уйдут в
      никому не принадлежащий объект;
    • предыдущая ОТКРЫТАЯ привязка этого прицепа закрывается датой начала новой:
      прицеп не может висеть на двух машинах одновременно (физически его
      переставили);
    • если у машины уже есть другой прицеп, ответ 409 со списком конфликта:
      в реальности у тягача бывает запасной прицеп, поэтому запрещать нельзя, но
      и молча создавать вторую привязку тоже — пользователь должен подтвердить.
    """
    trailer = await _get(db, current_user.company_id, trailer_id)

    vehicle = None
    if data.vehicle_id:
        vehicle = (await db.execute(
            select(Vehicle).where(Vehicle.id == data.vehicle_id,
                                  Vehicle.company_id == current_user.company_id)
        )).scalar_one_or_none()
    elif data.plate_number:
        vehicle = (await db.execute(
            select(Vehicle).where(Vehicle.company_id == current_user.company_id,
                                  Vehicle.plate_number == data.plate_number)
        )).scalar_one_or_none()
    if not vehicle:
        raise HTTPException(400, "Машина не найдена в парке — сначала добавьте её в «Автомобили»")

    if data.to_date and data.to_date < data.from_date:
        raise HTTPException(400, "Дата окончания раньше даты начала")

    # Конфликт по машине: у неё уже есть другой прицеп без даты окончания.
    clash = (await db.execute(
        select(TrailerBinding).where(
            TrailerBinding.company_id == current_user.company_id,
            TrailerBinding.vehicle_id == vehicle.id,
            TrailerBinding.trailer_id != trailer.id,
            TrailerBinding.to_date.is_(None),
        )
    )).scalars().all()
    if clash and not data.allow_parallel:
        other = (await db.execute(
            select(Trailer.plate).where(Trailer.id == clash[0].trailer_id)
        )).scalar()
        raise HTTPException(409, {
            "detail": (f"К машине {vehicle.plate_number} уже привязан прицеп {other}. "
                       "Заменить его или оставить оба?"),
            "conflict": {
                "vehicle": vehicle.plate_number,
                "bound_trailer": other,
                "binding_id": clash[0].id,
                "from_date": clash[0].from_date.isoformat() if clash[0].from_date else None,
            },
        })

    # Закрываем предыдущую привязку ЭТОГО прицепа.
    prev = (await db.execute(
        select(TrailerBinding).where(
            TrailerBinding.company_id == current_user.company_id,
            TrailerBinding.trailer_id == trailer.id,
            TrailerBinding.to_date.is_(None),
        )
    )).scalars().all()
    for b in prev:
        if b.from_date and b.from_date > data.from_date:
            raise HTTPException(
                400,
                f"Новая привязка начинается раньше текущей ({b.from_date}). "
                "Сначала закройте текущую, чтобы не переписывать историю задним числом.",
            )
        b.to_date = data.from_date

    binding = TrailerBinding(
        company_id=current_user.company_id, trailer_id=trailer.id,
        vehicle_id=vehicle.id, plate_number=vehicle.plate_number,
        from_date=data.from_date, to_date=data.to_date,
        note=(data.note or "").strip() or None, created_by=current_user.id,
    )
    db.add(binding)
    await db.flush()
    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user,
        action="bind", entity_type="TrailerBinding", entity_id=binding.id,
        new_value={"trailer": trailer.plate, "vehicle": vehicle.plate_number,
                   "from": data.from_date.isoformat(),
                   "to": data.to_date.isoformat() if data.to_date else None},
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True, "binding_id": binding.id, "trailer": trailer.plate,
            "vehicle": vehicle.plate_number,
            "from_date": data.from_date.isoformat(),
            "closed_previous": len(prev)}


@router.post("/{trailer_id}/unbind")
async def unbind_trailer(
    trailer_id: int,
    data: UnbindRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Отвязать прицеп от машины. Привязка не удаляется, а ЗАКРЫВАЕТСЯ датой —
    история сохраняется (см. ответ про удаление: прошлое не переписываем)."""
    trailer = await _get(db, current_user.company_id, trailer_id)
    rows = (await db.execute(
        select(TrailerBinding).where(
            TrailerBinding.company_id == current_user.company_id,
            TrailerBinding.trailer_id == trailer.id,
            TrailerBinding.to_date.is_(None),
        )
    )).scalars().all()
    if not rows:
        raise HTTPException(404, "У прицепа нет активной привязки")
    closing = data.to_date or date.today()
    for b in rows:
        if b.from_date and closing < b.from_date:
            raise HTTPException(400, "Дата отвязки раньше даты привязки")
        b.to_date = closing
    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user,
        action="unbind", entity_type="TrailerBinding", entity_id=rows[0].id,
        new_value={"trailer": trailer.plate, "to": closing.isoformat()},
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True, "closed": len(rows), "to_date": closing.isoformat()}


@router.delete("/{trailer_id}")
async def delete_trailer(
    trailer_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Удалить прицеп можно только «пустой»: без операций и привязок.

    Иначе история расходов осталась бы без объекта, а привязки — без прицепа.
    Для «больше не используем» есть отключение (is_active=false).
    """
    trailer = await _get(db, current_user.company_id, trailer_id)
    ops = (await db.execute(
        select(func.count()).select_from(Transaction).where(
            Transaction.company_id == current_user.company_id,
            Transaction.trailer_plate == trailer.plate)
    )).scalar() or 0
    binds = (await db.execute(
        select(func.count()).select_from(TrailerBinding).where(
            TrailerBinding.trailer_id == trailer.id)
    )).scalar() or 0
    if ops or binds:
        raise HTTPException(
            409,
            f"По прицепу {trailer.plate} есть операции ({int(ops)}) или привязки "
            f"({int(binds)}) — удаление стёрло бы историю. Отключите его или "
            "объедините с другим прицепом, если это опечатка.",
        )
    before = audit_service.snapshot(trailer)
    await db.delete(trailer)
    ctx = get_request_context(request)
    await audit_service.log(
        db, company_id=current_user.company_id, user=current_user,
        action="delete", entity_type="Trailer", entity_id=trailer_id,
        old_value=before,
        ip=ctx["ip"], user_agent=ctx["user_agent"], client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True}
