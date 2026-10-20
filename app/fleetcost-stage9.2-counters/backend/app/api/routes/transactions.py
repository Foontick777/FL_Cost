# HTTPException обязателен: без него ветка 404 в /transactions/debug-income падала
# с NameError, и вместо понятного ответа пользователь получал 500.
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func, and_, not_, cast, Date, text
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import date
from typing import Optional
import io

from app.core.database import get_db
from app.api.deps import get_current_user, require_manager, get_request_context
from app.models.models import User, Transaction, Vehicle
from app.schemas.schemas import TransactionOut, PeriodStats, PeriodStatsEur, VehicleStats
from app.services import audit_service

router = APIRouter(prefix="/transactions", tags=["transactions"])

SORT_OPTIONS = {
    "date_desc": Transaction.transaction_date.desc(),
    "date_asc": Transaction.transaction_date.asc(),
    "amount_desc": Transaction.amount.desc(),
    "amount_asc": Transaction.amount.asc(),
    "plate_asc": Transaction.plate_number.asc(),
}


def date_filter(date_from: date, date_to: date, company_id: int, confirmed_only: bool = True):
    """Filter by date (timezone-safe).

    CRITICAL: PostgreSQL cast(... as Date) on a timezone-aware timestamp
    converts to the SESSION timezone first, then extracts the date. If the
    server timezone is UTC-5 (e.g. America/New_York), then a midnight-UTC
    datetime becomes 7pm the PREVIOUS day in local timezone, and the date
    shifts. This caused income transactions to "disappear" from the wrong
    month.

    Fix: use (transaction_date AT TIME ZONE 'UTC')::date to force UTC
    interpretation, so the date is always what the parser intended.

    Issue #8 (this fix): also use bind parameters instead of f-string
    interpolation — both to prevent SQL injection and to make the SQL
    valid on PostgreSQL (the f-string approach worked, but only because
    date objects stringify cleanly to 'YYYY-MM-DD' format).
    """
    filters = [
        Transaction.company_id == company_id,
        # Use bind parameters (not f-strings) to prevent SQL injection.
        # The text() expression is wrapped in a boolean comparison that
        # works on PostgreSQL. SQLite doesn't support `AT TIME ZONE`, so
        # this filter only works on PostgreSQL — which is what we use in
        # production.
        text("(transaction_date AT TIME ZONE 'UTC')::date >= :df").bindparams(df=date_from),
        text("(transaction_date AT TIME ZONE 'UTC')::date <= :dt").bindparams(dt=date_to),
    ]
    if confirmed_only:
        filters.append(Transaction.is_confirmed == True)
    return and_(*filters)


@router.get("/", response_model=list[TransactionOut])
async def list_transactions(
    date_from: date = Query(default=None),
    date_to: date = Query(default=None),
    plate_number: Optional[str] = None,
    currency: Optional[str] = None,
    country: Optional[str] = None,
    source: Optional[str] = None,
    sort: str = Query(default="date_desc"),
    confirmed_only: bool = False,  # show all by default, filter in frontend
    limit: int = Query(default=100, le=50000),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    today = date.today()
    df = date_from or today.replace(day=1)
    dt = date_to or today

    # Параметр не игнорируем: он объявлен в сигнатуре, значит должен работать.
    # Раньше здесь было жёсткое False, и запрос ?confirmed_only=true возвращал
    # неподтверждённые строки — API противоречил собственному описанию.
    q = select(Transaction).where(date_filter(df, dt, current_user.company_id,
                                              confirmed_only=confirmed_only))
    if plate_number:
        q = q.where(Transaction.plate_number == plate_number)
    if currency:
        q = q.where(Transaction.currency == currency)
    if country:
        q = q.where(Transaction.country == country)
    if source:
        q = q.where(Transaction.source == source)

    order = SORT_OPTIONS.get(sort, SORT_OPTIONS["date_desc"])
    q = q.order_by(order).limit(limit).offset(offset)
    result = await db.execute(q)
    transactions = result.scalars().all()

    # Resolve driver name live from the vehicles table (Vehicle.driver_name is
    # editable after the fact; Transaction.driver_name is just whatever e100
    # reported at import time and is usually empty). Fall back to the stored
    # value if there's no matching vehicle or it has no driver set.
    plates = {t.plate_number for t in transactions if t.plate_number}
    if plates:
        veh_result = await db.execute(
            select(Vehicle.plate_number, Vehicle.driver_name)
            .where(Vehicle.company_id == current_user.company_id, Vehicle.plate_number.in_(plates))
        )
        driver_by_plate = {p: d for p, d in veh_result.all() if d}
        for t in transactions:
            if t.plate_number in driver_by_plate:
                t.driver_name = driver_by_plate[t.plate_number]

    return transactions


@router.get("/count")
async def count_transactions(
    date_from: date = Query(default=None),
    date_to: date = Query(default=None),
    source: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Count ALL transactions (including blocked) for consistent pagination."""
    today = date.today()
    df = date_from or today.replace(day=1)
    dt = date_to or today
    company_id = current_user.company_id

    # Use confirmed_only=False to match the list endpoint
    base = date_filter(df, dt, company_id, confirmed_only=False)
    filters = [base]
    if source:
        filters.append(Transaction.source == source)
    combined = and_(*filters) if len(filters) > 1 else filters[0]

    result = await db.execute(select(func.count(Transaction.id)).where(combined))
    return {"total": result.scalar() or 0}


@router.get("/debug-income")
async def debug_income(
    date_from: date = Query(default=None),
    date_to: date = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Debug endpoint: returns raw count and sample of csv_income transactions
    for the given period, so the user can verify what's actually in the DB
    vs. what the frontend shows.

    Issue #1: restricted to manager/owner (was open to anyone authenticated).

    Hardened: this returns the first 10 income rows (amounts, customers,
    invoice numbers) and the database timezone — diagnostic data that must not
    be reachable on a real deployment, and the frontend used to call it after
    EVERY income import and dump the payload into the browser console. It now
    returns 404 unless ENVIRONMENT=development, so the route cannot be used as
    an information-disclosure endpoint in production even by a manager.
    """
    from app.core.config import settings as _cfg
    if _cfg.ENVIRONMENT != "development":
        raise HTTPException(404, "Not Found")

    today = date.today()
    df = date_from or today.replace(day=1)
    dt = date_to or today

    # ── Check PostgreSQL session timezone — this is the ROOT CAUSE of date
    # shifting. If the server timezone is not UTC, cast(... as Date) on a
    # midnight-UTC datetime returns the previous day in local timezone.
    tz_result = await db.execute(select(func.current_setting("TimeZone")))
    db_timezone = tz_result.scalar() or "unknown"
    now_result = await db.execute(select(func.now()))
    db_now = str(now_result.scalar())

    # Count ALL csv_income transactions for this period (timezone-safe)
    from sqlalchemy import text as sql_text
    count_result = await db.execute(
        sql_text("""
            SELECT COUNT(*) FROM transactions
            WHERE company_id = :cid AND source = 'csv_income'
              AND (transaction_date AT TIME ZONE 'UTC')::date >= :df
              AND (transaction_date AT TIME ZONE 'UTC')::date <= :dt
        """),
        {"cid": current_user.company_id, "df": df, "dt": dt}
    )
    total_count = count_result.scalar() or 0

    # Also count WITHOUT date filter — total csv_income in DB
    all_count_result = await db.execute(
        select(func.count(Transaction.id)).where(
            Transaction.company_id == current_user.company_id,
            Transaction.source == "csv_income",
        )
    )
    all_count = all_count_result.scalar() or 0

    # Get first 10 sample transactions (any date) to see raw date values
    sample_result = await db.execute(
        select(Transaction).where(
            Transaction.company_id == current_user.company_id,
            Transaction.source == "csv_income",
        ).order_by(Transaction.transaction_date.asc()).limit(10)
    )
    samples = sample_result.scalars().all()

    # Per-month breakdown — use raw SQL with AT TIME ZONE 'UTC' to force UTC
    # date interpretation (so months match what the parser intended)
    from sqlalchemy import text as sql_text
    month_result = await db.execute(
        sql_text("""
            SELECT to_char(transaction_date AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
                   COUNT(*) AS count,
                   COALESCE(SUM(amount), 0) AS total_amount,
                   COALESCE(SUM(price), 0) AS total_pln
            FROM transactions
            WHERE company_id = :cid AND source = 'csv_income'
            GROUP BY month
            ORDER BY month
        """),
        {"cid": current_user.company_id}
    )
    monthly = [
        {
            "month": r.month,
            "count": r.count,
            "total_amount": float(r.total_amount or 0),
            "total_pln": float(r.total_pln or 0),
        }
        for r in month_result.all()
    ]

    return {
        "period": f"{df} to {dt}",
        "csv_income_count_for_period": total_count,
        "csv_income_count_total": all_count,
        "db_timezone": db_timezone,
        "db_now": db_now,
        "samples_first_10": [
            {
                "id": t.id,
                "raw_date": str(t.transaction_date),
                "date_part": str(t.transaction_date.date()) if t.transaction_date else None,
                "amount": t.amount,
                "currency": t.currency,
                "price_pln": t.price,
                "fuel_type": t.fuel_type,
                "source": t.source,
                "plate": t.plate_number,
                "external_id": t.external_id,
            }
            for t in samples
        ],
        "all_months_in_db": monthly,
    }


@router.get("/stats", response_model=PeriodStats)
async def get_stats(
    date_from: date = Query(default=None),
    date_to: date = Query(default=None),
    source: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    today = date.today()
    df = date_from or today.replace(day=1)
    dt = date_to or today
    company_id = current_user.company_id

    # ALL transactions including blocked (blocked = money will still be charged)
    base_filter_parts = [date_filter(df, dt, company_id, confirmed_only=False)]
    if source:
        base_filter_parts.append(Transaction.source == source)
    base_filter = and_(*base_filter_parts) if len(base_filter_parts) > 1 else base_filter_parts[0]

    # Exclude income from by_vehicle — this widget shows EXPENSES only
    expense_filter = and_(base_filter, not_(Transaction.fuel_type.ilike("%income%")))

    # By vehicle + currency (EXPENSES ONLY — no income)
    by_vehicle_result = await db.execute(
        select(Transaction.plate_number, Transaction.currency,
               func.sum(Transaction.amount).label("total"),
               func.count(Transaction.id).label("count"))
        .where(expense_filter)
        .group_by(Transaction.plate_number, Transaction.currency)
    )

    vehicle_map: dict[str, dict] = {}
    for plate, currency, total, count in by_vehicle_result.all():
        plate = plate or "Unknown"
        if plate not in vehicle_map:
            vehicle_map[plate] = {"count": 0, "pln": 0.0, "eur": 0.0, "by_currency": {}}
        vehicle_map[plate]["count"] += count
        vehicle_map[plate]["by_currency"][currency] = (
            vehicle_map[plate]["by_currency"].get(currency, 0) + float(total or 0)
        )
        if currency == "PLN":
            vehicle_map[plate]["pln"] += float(total or 0)
        elif currency == "EUR":
            vehicle_map[plate]["eur"] += float(total or 0)

    # Get driver names from vehicles table
    vehicle_result = await db.execute(
        select(Vehicle.plate_number, Vehicle.driver_name)
        .where(Vehicle.company_id == company_id)
    )
    driver_map = {row.plate_number: row.driver_name for row in vehicle_result.all()}

    by_vehicle = [
        VehicleStats(
            plate_number=plate,
            driver_name=driver_map.get(plate),
            transaction_count=data["count"],
            total_pln=round(float(data["pln"]), 2),
            total_eur=round(float(data["eur"]), 2),
            by_currency={k: round(float(v), 2) for k, v in data["by_currency"].items()},
        )
        for plate, data in vehicle_map.items()
    ]

    # By currency (ALL transactions including income)
    currency_result = await db.execute(
        select(Transaction.currency, func.sum(Transaction.amount))
        .where(base_filter).group_by(Transaction.currency)
    )
    by_currency = {cur: round(float(total or 0), 2) for cur, total in currency_result.all()}

    # By country with currency breakdown (ALL transactions)
    country_result = await db.execute(
        select(Transaction.country, Transaction.currency, func.sum(Transaction.amount))
        .where(base_filter).group_by(Transaction.country, Transaction.currency)
    )
    by_country: dict = {}
    for country, currency, total in country_result.all():
        if not country:
            continue
        if country not in by_country:
            by_country[country] = {}
        by_country[country][currency] = round(float(total or 0), 2)

    # By fuel type with currency breakdown (ALL transactions — income shown as separate type)
    ftype_result = await db.execute(
        select(Transaction.fuel_type, Transaction.currency, func.sum(Transaction.amount))
        .where(base_filter).group_by(Transaction.fuel_type, Transaction.currency)
    )
    by_fuel_type: dict = {}
    for ft, currency, total in ftype_result.all():
        if not ft:
            continue
        if ft not in by_fuel_type:
            by_fuel_type[ft] = {}
        by_fuel_type[ft][currency] = round(float(total or 0), 2)

    count_result = await db.execute(
        select(func.count(Transaction.id)).where(base_filter)
    )

    # ── EUR по историческому курсу каждой операции (FC-001) ───────────────
    # Те же группировки, что выше, но по сохранённому amount_eur: курс взят на
    # дату операции, поэтому итог не меняется задним числом при обновлении
    # курсов. Excel-экспорт берёт то же поле, так что дашборд и экспорт теперь
    # считают одинаково.
    income_filter = and_(base_filter, Transaction.fuel_type.ilike("%income%"))

    eur_expenses = (await db.execute(
        select(func.sum(Transaction.amount_eur)).where(expense_filter)
    )).scalar()
    eur_income = (await db.execute(
        select(func.sum(Transaction.amount_eur)).where(income_filter)
    )).scalar()
    # Суммы без курса на дату операции: в итоги не входят, поэтому их число
    # отдаём счётчиком, а не молчанием.
    missing_rate_count = (await db.execute(
        select(func.count(Transaction.id)).where(
            and_(base_filter, Transaction.amount_eur.is_(None),
                 Transaction.amount.isnot(None), Transaction.amount != 0)
        )
    )).scalar() or 0

    eur_by_vehicle = {row[0] or "Unknown": float(row[1] or 0) for row in (await db.execute(
        select(Transaction.plate_number, func.sum(Transaction.amount_eur))
        .where(expense_filter).group_by(Transaction.plate_number)
    )).all()}
    eur_by_country = {row[0]: float(row[1] or 0) for row in (await db.execute(
        select(Transaction.country, func.sum(Transaction.amount_eur))
        .where(and_(expense_filter, Transaction.country.isnot(None)))
        .group_by(Transaction.country)
    )).all()}
    eur_by_fuel_type = {row[0]: float(row[1] or 0) for row in (await db.execute(
        select(Transaction.fuel_type, func.sum(Transaction.amount_eur))
        .where(and_(base_filter, Transaction.fuel_type.isnot(None)))
        .group_by(Transaction.fuel_type)
    )).all()}

    expenses_eur = round(float(eur_expenses or 0), 2)
    income_eur = round(float(eur_income or 0), 2)
    eur_stats = PeriodStatsEur(
        expenses=expenses_eur,
        income=income_eur,
        profit=round(income_eur - expenses_eur, 2),
        expenses_by_vehicle={k: round(v, 2) for k, v in eur_by_vehicle.items()},
        expenses_by_country={k: round(v, 2) for k, v in eur_by_country.items()},
        expenses_by_fuel_type={k: round(v, 2) for k, v in eur_by_fuel_type.items()},
        missing_rate_count=max(0, int(missing_rate_count)),
    )

    return PeriodStats(
        date_from=df, date_to=dt,
        total_transactions=count_result.scalar() or 0,
        by_vehicle=by_vehicle,
        by_currency=by_currency,
        by_country=by_country,
        by_fuel_type=by_fuel_type,
        eur=eur_stats,
    )


@router.get("/export/excel")
async def export_excel(
    request: Request,
    date_from: date = Query(default=None),
    date_to: date = Query(default=None),
    plate_number: Optional[str] = None,
    source: Optional[str] = None,
    country: Optional[str] = None,
    limit: int = Query(default=50000, le=200000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Export filtered transactions to XLSX. Owner or manager only (Issue #1
    — viewer cannot export, matching the user's permission matrix).
    Issue #4: export is audit-logged so we know who downloaded what.

    `source` / `country` / `limit` were added because the file previously
    ignored the filters visible on screen: the user could be looking at
    "только Q8, только Германия" and download a completely different data set
    without noticing.
    """
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment

    today = date.today()
    df = date_from or today.replace(day=1)
    dt = date_to or today

    q = (select(Transaction)
         .where(date_filter(df, dt, current_user.company_id, confirmed_only=True))
         .order_by(Transaction.transaction_date.desc())
         .limit(limit))
    if plate_number:
        q = q.where(Transaction.plate_number == plate_number)
    if source:
        q = q.where(Transaction.source == source)
    if country:
        q = q.where(Transaction.country == country)

    result = await db.execute(q)
    transactions = result.scalars().all()

    plates = {t.plate_number for t in transactions if t.plate_number}
    if plates:
        veh_result = await db.execute(
            select(Vehicle.plate_number, Vehicle.driver_name)
            .where(Vehicle.company_id == current_user.company_id, Vehicle.plate_number.in_(plates))
        )
        driver_by_plate = {p: d for p, d in veh_result.all() if d}
        for t in transactions:
            if t.plate_number in driver_by_plate:
                t.driver_name = driver_by_plate[t.plate_number]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Transactions"

    headers = ["Date", "Plate", "Driver", "Type", "Country", "Price",
               "Volume", "Amount", "Currency", "Amount EUR", "Station", "Status"]
    hfont = Font(bold=True, color="FFFFFF")
    hfill = PatternFill("solid", fgColor="4f46e5")
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.font = hfont
        cell.fill = hfill
        cell.alignment = Alignment(horizontal="center")

    def _text(v):
        """Neutralise spreadsheet formula injection.

        openpyxl writes a string starting with '=' as a FORMULA. Station
        names / addresses / driver names come from CSV imports and e100, i.e.
        they are external input — a value like `=cmd|'/c calc'!A1` would be
        executed (or at least mangled) when the accountant opens the export in
        Excel. Prefixing with an apostrophe forces text.
        """
        if v is None:
            return ""
        s = str(v)
        return "'" + s if s[:1] in ("=", "+", "-", "@") else s

    for row_num, txn in enumerate(transactions, 2):
        ws.cell(row=row_num, column=1, value=txn.transaction_date.strftime("%d.%m.%Y %H:%M") if txn.transaction_date else "")
        ws.cell(row=row_num, column=2, value=_text(txn.plate_number))
        ws.cell(row=row_num, column=3, value=_text(txn.driver_name))
        ws.cell(row=row_num, column=4, value=_text(txn.fuel_type))
        ws.cell(row=row_num, column=5, value=_text(txn.country))
        ws.cell(row=row_num, column=6, value=float(txn.price) if txn.price is not None else None)
        ws.cell(row=row_num, column=7, value=float(txn.volume) if txn.volume is not None else None)
        ws.cell(row=row_num, column=8, value=float(txn.amount))
        ws.cell(row=row_num, column=9, value=_text(txn.currency))
        ws.cell(row=row_num, column=10, value=float(txn.amount_eur) if txn.amount_eur is not None else None)
        ws.cell(row=row_num, column=11, value=_text(txn.station_address or txn.station_id))
        ws.cell(row=row_num, column=12, value="confirmed" if txn.is_confirmed else "blocked")

    for col in ws.columns:
        max_len = max(len(str(cell.value or "")) for cell in col)
        ws.column_dimensions[col[0].column_letter].width = min(max_len + 2, 40)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    # Audit log — record that this export happened. Use the request's DB
    # session so it rides along the same transaction.
    ctx = get_request_context(request)
    await audit_service.log(
        db,
        company_id=current_user.company_id,
        user=current_user,
        action="EXPORT",
        entity_type="Transaction",
        entity_id=None,
        new_value={"date_from": str(df), "date_to": str(dt), "plate": plate_number,
                   "source": source, "country": country,
                   "rows": len(transactions)},
        ip=ctx["ip"],
        user_agent=ctx["user_agent"],
        client_id=ctx.get("client_id"),
    )
    await db.commit()

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheet.sheet",
        headers={"Content-Disposition": f'attachment; filename="fleetcost_{df}_{dt}.xlsx"'},
    )