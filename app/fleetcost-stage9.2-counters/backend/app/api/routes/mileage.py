from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, func, and_, cast, delete, Date
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import date
from typing import Optional
import re

from app.core.database import get_db
from app.api.deps import get_current_user, require_manager, get_request_context
from app.models.models import User, Mileage, MileageSegment, Transaction
from app.services import audit_service

router = APIRouter(prefix="/mileage", tags=["mileage"])

# Mirrors the fuel-transaction classification in the frontend (isFuel /
# isToll / isAdBlue / isSvcFee / isParking / isCarWash in App.jsx) so
# "Ср. расход топлива" on this tab always matches what the Fuel tab counts
# as fuel.
#
# Centralized category map — same as E100_CATEGORY_MAP in App.jsx.
# To add a new e100 service, just add it to the right category list.
_SVC_FEE_RE = re.compile(r"сервисный сбор|service fee|agency fee|commission fee|fee$|subscription|абонент", re.I)
_TOLL_RE = re.compile(r"toll|дороги|motorway|highway|e-box|ebox|viapass|tunnel|liefken|autobahn|péage|pedaggio|maut", re.I)
_ADBLUE_RE = re.compile(r"adblue|ad blue|адблу|адблю|разливное", re.I)
_CAR_WASH_RE = re.compile(r"car wash|carwash|myjnia|mycie", re.I)
# Parking — checked BEFORE toll (Parking truck E-BOX contains "e-box" but is parking)
_PARKING_RE = re.compile(r"parking|parking truck|parkowanie|postój", re.I)


def _is_fuel_transaction(fuel_type: Optional[str], source: Optional[str]) -> bool:
    ft = fuel_type or ""
    if source == "csv_income":
        return False
    if source == "manual":
        return ft.startswith("manual_fuel")
    is_svc = bool(_SVC_FEE_RE.search(ft))
    is_parking = bool(_PARKING_RE.search(ft))
    # Parking takes precedence over toll (Parking truck E-BOX is parking, NOT toll)
    is_toll = bool(_TOLL_RE.search(ft)) and not is_svc and not is_parking
    is_adblue = bool(_ADBLUE_RE.search(ft))
    is_car_wash = bool(_CAR_WASH_RE.search(ft))
    # Car wash and parking are NOT fuel (they're "Иные расходы")
    if is_car_wash or is_parking:
        return False
    return not (is_toll or is_adblue or is_svc)


# `cast(col, Date)` uses the DB SESSION timezone, so a mileage record saved at
# 00:30 could land in the previous day and silently disappear from a report.
# Force UTC explicitly (same idiom as the transaction filters).
def _utc_date(col):
    return cast(func.timezone("UTC", col), Date)


def date_filter(date_from: date, date_to: date, company_id: int):
    return and_(
        Mileage.company_id == company_id,
        _utc_date(Mileage.date) >= date_from,
        _utc_date(Mileage.date) <= date_to,
    )


def segment_date_filter(date_from: date, date_to: date, company_id: int):
    return and_(
        MileageSegment.company_id == company_id,
        _utc_date(MileageSegment.date) >= date_from,
        _utc_date(MileageSegment.date) <= date_to,
    )


@router.get("/")
async def list_mileage(
    date_from: date = Query(default=None),
    date_to: date = Query(default=None),
    limit: int = Query(default=2000, le=50000),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    today = date.today()
    df = date_from or today.replace(day=1)
    dt = date_to or today
    q = (select(Mileage)
         .where(date_filter(df, dt, current_user.company_id))
         .order_by(Mileage.date.desc(), Mileage.plate_number.asc())
         .limit(limit).offset(offset))
    result = await db.execute(q)
    rows = result.scalars().all()
    return [
        {"id": r.id, "date": r.date, "plate_number": r.plate_number,
         "km": r.km, "fuel_liters": r.fuel_liters, "source": r.source}
        for r in rows
    ]


@router.get("/segments")
async def list_mileage_segments(
    date_from: date = Query(default=None),
    date_to: date = Query(default=None),
    plate_number: Optional[str] = None,
    status: Optional[str] = None,
    sort: str = Query(default="date_desc"),
    limit: int = Query(default=50, le=5000),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Detailed movement/stop interval log (nav.by 'Подробный' export detail
    rows) for the 'Детальный журнал интервалов' table on the Mileage tab."""
    today = date.today()
    df = date_from or today.replace(day=1)
    dt = date_to or today
    filters = [segment_date_filter(df, dt, current_user.company_id)]
    if plate_number:
        filters.append(MileageSegment.plate_number == plate_number)
    if status:
        filters.append(MileageSegment.status == status)

    order = {
        "date_desc": (MileageSegment.date.desc(), MileageSegment.time_from.desc()),
        "date_asc": (MileageSegment.date.asc(), MileageSegment.time_from.asc()),
        "km_desc": (MileageSegment.km.desc().nullslast(),),
        "km_asc": (MileageSegment.km.asc().nullsfirst(),),
    }.get(sort, (MileageSegment.date.desc(), MileageSegment.time_from.desc()))

    q = (select(MileageSegment).where(and_(*filters))
         .order_by(*order).limit(limit).offset(offset))
    result = await db.execute(q)
    rows = result.scalars().all()
    return [
        {"id": r.id, "date": r.date, "plate_number": r.plate_number,
         "time_from": r.time_from, "time_to": r.time_to, "status": r.status,
         "km": r.km, "duration_seconds": r.duration_seconds}
        for r in rows
    ]


@router.get("/segments/count")
async def count_mileage_segments(
    date_from: date = Query(default=None),
    date_to: date = Query(default=None),
    plate_number: Optional[str] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    today = date.today()
    df = date_from or today.replace(day=1)
    dt = date_to or today
    filters = [segment_date_filter(df, dt, current_user.company_id)]
    if plate_number:
        filters.append(MileageSegment.plate_number == plate_number)
    if status:
        filters.append(MileageSegment.status == status)
    result = await db.execute(select(func.count(MileageSegment.id)).where(and_(*filters)))
    return {"total": result.scalar() or 0}


@router.get("/stats")
async def mileage_stats(
    date_from: date = Query(default=None),
    date_to: date = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Fleet + per-vehicle mileage analytics.

    ``km`` is summed directly from "Движение" segments (not the nav.by daily
    summary row) — this matches the original spec ("Сумма значений колонки
    Пробег для всех строк со статусом Движение") and, importantly, avoids a
    vehicle showing trip/time data with 0 km whenever a given day's summary
    row fails to parse but its detail rows still come through fine.

    ``fuel_liters`` is summed from actual fuel purchases (E100 + Q8 +
    manual entries on the Fuel tab), NOT from the nav.by export — that
    column is frequently empty or wrong there. This keeps "Ср. расход" on
    this tab consistent with the Fuel tab's own consumption figures.

    ``by_vehicle`` (plate -> km) is kept for backward compatibility with
    pages that only need the mileage number (Dashboard, Unit Economics).
    ``vehicles`` (plate -> full metrics dict) is the new richer payload the
    Mileage tab uses for time balance / КТУ / avg speed / fuel efficiency.
    """
    today = date.today()
    df = date_from or today.replace(day=1)
    dt = date_to or today

    tx_result = await db.execute(
        select(Transaction.plate_number, Transaction.fuel_type, Transaction.source, Transaction.volume)
        .where(
            Transaction.company_id == current_user.company_id,
            _utc_date(Transaction.transaction_date) >= df,
            _utc_date(Transaction.transaction_date) <= dt,
        )
    )
    fuel_by_vehicle = {}
    for plate, ft, src, vol in tx_result.all():
        if not plate or not vol or not _is_fuel_transaction(ft, src):
            continue
        p = plate.upper()
        fuel_by_vehicle[p] = fuel_by_vehicle.get(p, 0.0) + float(vol)

    seg_result = await db.execute(
        select(
            MileageSegment.plate_number,
            MileageSegment.status,
            func.sum(MileageSegment.duration_seconds),
            func.count(MileageSegment.id),
            func.sum(MileageSegment.km),
        )
        .where(segment_date_filter(df, dt, current_user.company_id))
        .group_by(MileageSegment.plate_number, MileageSegment.status)
    )
    seg_by_vehicle = {}
    for plate, status, dur, cnt, km in seg_result.all():
        v = seg_by_vehicle.setdefault(plate, {
            "km": 0.0, "moving_seconds": 0, "stopped_seconds": 0, "sessions_count": 0, "stops_count": 0,
        })
        if status == "Движение":
            v["moving_seconds"] = dur or 0
            v["sessions_count"] = cnt or 0
            v["km"] = float(km or 0)
        elif status == "Стоянка":
            v["stopped_seconds"] = dur or 0
            v["stops_count"] = cnt or 0

    # Only vehicles with actual mileage segments belong on this tab — a
    # vehicle that only has fuel purchases (no nav.by tracking) shouldn't
    # show an empty-looking card here; it still appears on the Fuel tab.
    plates = set(seg_by_vehicle)
    vehicles = {}
    for plate in plates:
        fuel = fuel_by_vehicle.get(plate, 0.0)
        seg = seg_by_vehicle.get(plate, {
            "km": 0.0, "moving_seconds": 0, "stopped_seconds": 0, "sessions_count": 0, "stops_count": 0,
        })
        km = float(seg["km"] or 0)
        moving_s, stopped_s = seg["moving_seconds"], seg["stopped_seconds"]
        total_s = moving_s + stopped_s
        vehicles[plate] = {
            "km": round(km, 1),
            "fuel_liters": round(float(fuel or 0), 1) if fuel else 0.0,
            "moving_seconds": moving_s,
            "stopped_seconds": stopped_s,
            "utilization_pct": round(moving_s / total_s * 100, 1) if total_s > 0 else None,
            "avg_speed_kmh": round(km / (moving_s / 3600), 1) if moving_s > 0 and km > 0 else None,
            "fuel_per_100km": round(float(fuel or 0) / km * 100, 1) if km > 0 and fuel else None,
            "sessions_count": seg["sessions_count"],
            "stops_count": seg["stops_count"],
        }

    by_vehicle = {plate: float(v["km"]) for plate, v in vehicles.items()}
    total_km = round(sum(by_vehicle.values()), 1)
    total_fuel = round(sum(float(v["fuel_liters"]) for v in vehicles.values()), 1)
    total_moving = sum(v["moving_seconds"] for v in vehicles.values())
    total_stopped = sum(v["stopped_seconds"] for v in vehicles.values())
    total_s = total_moving + total_stopped

    return {
        "date_from": df, "date_to": dt,
        "total_km": total_km,
        "by_vehicle": by_vehicle,
        "vehicles": vehicles,
        "total_fuel_liters": total_fuel,
        "total_moving_seconds": total_moving,
        "total_stopped_seconds": total_stopped,
        "fleet_utilization_pct": round(total_moving / total_s * 100, 1) if total_s > 0 else None,
        "fleet_fuel_per_100km": round(total_fuel / total_km * 100, 1) if total_km > 0 and total_fuel else None,
    }


@router.delete("/{mileage_id}")
async def delete_mileage(
    mileage_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Delete a single mileage record. Owner or manager only (Issue #1).
    Issue #4: audit-logged."""
    result = await db.execute(
        select(Mileage).where(
            Mileage.id == mileage_id,
            Mileage.company_id == current_user.company_id,
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Mileage record not found")
    old_snapshot = audit_service.snapshot(row)
    # Сегменты движения/стоянок связаны с записью пробега не FK, а парой
    # (company_id, plate_number, date) — см. MileageSegment. Без этой чистки
    # после удаления сводки оставались «висячие» сегменты, и аналитика времени
    # и КТУ продолжала их считать (FC-030 в аудите).
    await db.execute(
        delete(MileageSegment).where(
            MileageSegment.company_id == row.company_id,
            MileageSegment.plate_number == row.plate_number,
            MileageSegment.date == row.date,
        )
    )
    await db.delete(row)
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="DELETE",
        entity_type="Mileage",
        entity_id=mileage_id,
        old_value=old_snapshot,
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()
    return {"ok": True}
