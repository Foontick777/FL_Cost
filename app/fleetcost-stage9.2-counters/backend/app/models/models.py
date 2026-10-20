from sqlalchemy import (
    Column, Integer, String, Float, Boolean, DateTime, Date,
    ForeignKey, Text, Enum as SAEnum, Numeric, Index, UniqueConstraint,
    text,          # предикаты частичных индексов (FC-008, см. FxRate.__table_args__)
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from app.core.database import Base


# ──────────────────────────────────────────────────────────────────────
# Issue #1: Roles
# ──────────────────────────────────────────────────────────────────────
class UserRole(str, enum.Enum):
    owner = "owner"       # Can manage company, credentials, see all data
    manager = "manager"   # Can see all data, export, manage vehicles/expenses
    viewer = "viewer"     # Read-only


class Company(Base):
    __tablename__ = "companies"

    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    is_active = Column(Boolean, default=True)

    users = relationship("User", back_populates="company")
    vehicles = relationship("Vehicle", back_populates="company")
    e100_credentials = relationship("E100Credential", back_populates="company")
    telegram_settings = relationship("TelegramSettings", back_populates="company", uselist=False)
    scraper_settings = relationship("ScraperSettings", back_populates="company", uselist=False)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    email = Column(String(255), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(255))
    role = Column(SAEnum(UserRole), default=UserRole.owner, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    # SEC-02 (аудит stage8): мгновенный отзыв access-токенов. Значение попадает
    # в JWT-клейм "ver" при выпуске; get_current_user сверяет его с колонкой.
    # Любое повышение (смена пароля, деактивация, «выйти на всех устройствах»)
    # делает все ранее выданные токены пользователя недействительными СРАЗУ,
    # не дожидаясь истечения их срока. Alembic: 0016_refresh_tokens.py.
    token_version = Column(Integer, nullable=False, server_default=text("0"), default=0)

    company = relationship("Company", back_populates="users")


class RefreshToken(Base):
    """SEC-02: отзывные refresh-токены (сессии).

    Живёт 14 дней (REFRESH_TOKEN_EXPIRE_DAYS), хранится ТОЛЬКО в виде
    SHA-256-хэша — утечка базы не даёт злоумышленнику готовые токены.
    Каждый /auth/refresh выполняет ротацию: старая строка помечается
    revoked_at, выдаётся новая. Пользователь с отозванным токеном обязан
    повторно пройти логин. Позволяет:
      • короткоживущий access (30 минут) без выбрасывания пользователя на экран
        логина каждые полчаса;
      • честный logout (строка отзывается), а не только очистку cookie;
      • будущий экран «активные сессии» (user_agent/ip уже сохраняются).
    """
    __tablename__ = "refresh_tokens"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String(64), unique=True, nullable=False, index=True)  # sha256 hex
    expires_at = Column(DateTime(timezone=True), nullable=False)
    revoked_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    # Контекст сессии — для будущего экрана «активные устройства» и расследований.
    user_agent = Column(String(512))
    ip = Column(String(64))


class Vehicle(Base):
    __tablename__ = "vehicles"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    plate_number = Column(String(20), nullable=False)   # e.g. BI855GS
    description = Column(String(255))                   # e.g. "Volvo FH 2022"
    driver_name = Column(String(255))                   # optional
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company = relationship("Company", back_populates="vehicles")
    transactions = relationship("Transaction", back_populates="vehicle")


class E100Credential(Base):
    """Encrypted e100.eu login credentials per company."""
    __tablename__ = "e100_credentials"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    label = Column(String(100), default="e100")          # for future multi-account
    username = Column(String(255), nullable=False)        # e100 login (email)
    encrypted_password = Column(Text, nullable=False)     # Fernet-encrypted
    # Issue #12: source_account identifies which E100 account returned a
    # transaction — used in the dedup unique key, so two accounts returning
    # the same transaction (card + date + category) don't overwrite each
    # other. Stored alongside the username hash so we don't have to decrypt
    # the password to know which credential produced a transaction.
    source_account = Column(String(255))                  # username hashed (SHA-256) for stability
    is_active = Column(Boolean, default=True)
    last_sync_at = Column(DateTime(timezone=True))
    last_sync_status = Column(String(50))                # "ok" / "error"
    last_sync_error = Column(Text)
    # Когда в последний раз меняли пароль этого доступа. Нужна пользователю:
    # e100 раз в несколько недель требует сменить пароль, и по этой дате видно,
    # что доступ обновлён (и когда именно) — не открывая журнал действий.
    password_changed_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company = relationship("Company", back_populates="e100_credentials")
    transactions = relationship("Transaction", back_populates="credential")


class Transaction(Base):
    """Single expense transaction (fuel, toll, service, etc.)"""
    __tablename__ = "transactions"
    __table_args__ = (
        # dedup uniqueness — company + credential + source_transaction_id.
        # The legacy external_id-based dedup is retained (the dedup logic in
        # save_transactions builds external_id from "e100_{vehicle}_{dt}_{cat}_n{idx}")
        # but if multiple credentials return the same vehicle+date+category, they
        # now also have distinct credential_id and source_account values, so the
        # unique constraint below catches the collision at the DB level too.
        Index("ix_transactions_company_credential_ext",
              "company_id", "credential_id", "external_id"),
        # Автоматические списания помечены external_id, и он обязан быть
        # уникальным: предварительная проверка «есть ли такое списание» не спасает
        # от двух параллельных синхронизаций (две вкладки, кнопка «синхронизировать»
        # вместе с загрузкой страницы) — обе видят «нет» и обе вставляют дубль.
        Index("uq_transactions_company_source_external",
              "company_id", "source", "external_id",
              unique=True,
              postgresql_where=text("external_id IS NOT NULL"),
              sqlite_where=text("external_id IS NOT NULL")),
    )

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)

    # Source tracking
    source = Column(String(50), default="e100")          # e100 / manual / excel / q8 / csv_income / recurring
    external_id = Column(String(100))                    # dedup key per-source

    # Issue #12: provenance — which credential produced this transaction.
    # NULL for manual / csv_income / recurring / q8 imports (no credential).
    credential_id = Column(Integer, ForeignKey("e100_credentials.id"), nullable=True, index=True)
    source_account = Column(String(255), nullable=True)  # hashed username from credential

    # Transaction data from e100
    transaction_date = Column(DateTime(timezone=True), nullable=False)
    card_number = Column(String(50))
    card_shortname = Column(String(30))
    plate_number = Column(String(20))                    # raw from e100
    # Номер ПРИЦЕПА. В счетах описание услуги содержит пару «тягач/прицеп»
    # (BI329LF/QASB981) — из неё берётся и машина, и прицеп. Без отдельной
    # колонки связка «какой прицеп работал с какой машиной» терялась: прицеп
    # нигде не хранился, и расходы прицепа нельзя было отнести к машине.
    trailer_plate = Column(String(20), index=True)
    driver_name = Column(String(255))
    country = Column(String(5))
    station_id = Column(String(30))
    station_address = Column(Text)
    station_region = Column(String(100))

    # ─── Issue #2: Financials are now NUMERIC, not Float ──────────────
    # Money columns: NUMERIC(14, 2)  → up to 999,999,999,999.99 — enough
    # for any reasonable company revenue/cost in any currency.
    # Volume (liters): NUMERIC(12, 3) — up to 999,999,999.999 liters.
    # Unit price: NUMERIC(12, 4) — fuel prices vary widely across currencies.
    price = Column(Numeric(12, 4))                        # unit price
    volume = Column(Numeric(12, 3))                       # quantity (liters)
    amount = Column(Numeric(14, 2), nullable=False)        # total sum in `currency`
    currency = Column(String(10), nullable=False)         # PLN / EUR / etc.

    # ─── Issue #3: FX-rate tracking (EUR conversion at operation date) ─
    # `fx_rate`    = multiplier (foreign → EUR). 1.0 if currency == EUR.
    # `amount_eur` = amount × fx_rate, rounded to 2 decimals.
    # `fx_rate_date` = the date the rate was sourced for (operation date).
    # `fx_source`  = "ECB" / "manual" / "legacy" (backfilled).
    fx_rate = Column(Numeric(18, 8), nullable=True)
    amount_eur = Column(Numeric(14, 2), nullable=True)
    fx_rate_date = Column(Date, nullable=True)
    fx_source = Column(String(20), nullable=True)        # ECB / manual / legacy

    # Category
    service_category = Column(Integer)
    fuel_type = Column(String(100))                      # "A2 motorway", "Toll DE E-BOX", etc.
    category_code = Column(Integer)                      # 1=toll, 2=fuel etc.

    # ─── SaaS-доработка: динамические категории расходов ───────────────
    # `category_id` — ссылка на expense_categories. NULL для строк
    # источника e100/q8/импорта (у них категория источника, не пользовательская)
    # и для исторических строк, которые ещё не связаны с категорией.
    # `fuel_type` продолжает хранить `manual_{section}_{code}` — он остаётся
    # рабочей «классификацией» для всех существующих отчётов и фильтров, а
    # category_id даёт связь с конкретной категорией (иконка, цвет, активность).
    category_id = Column(Integer, ForeignKey("expense_categories.id"), nullable=True, index=True)
    # oneoff — разовый расход; recurring — строка, созданная регулярным платежом.
    expense_type = Column(String(20), default="oneoff")
    # Периодичность регулярного платежа (для разового — NULL):
    # monthly | quarterly | yearly | weekly
    periodicity = Column(String(20), nullable=True)
    # Свободный комментарий к операции (в форме «Добавить расход» — отдельное
    # поле, не путать с названием/описанием в station_address).
    comment = Column(String(500), nullable=True)
    # Ссылка на документ (номер счёта / чека). Файлы не хранятся — только ссылка.
    document_ref = Column(String(255), nullable=True)

    # Meta
    is_confirmed = Column(Boolean, default=True)
    # ── Факт оплаты по начислению ─────────────────────────────────────────
    # ПОЧЕМУ ОТДЕЛЬНОЕ ПОЛЕ, А НЕ is_confirmed. `is_confirmed` означает другое:
    # подтверждение со стороны банка/провайдера («False = blocked, exclude from
    # accounting» в e100-клиенте). Если свести их вместе, неоплаченное начисление
    # и заблокированная банковская операция станут неразличимы — и в интерфейсе
    # появится «Blocked» там, где на самом деле «ещё не заплатили».
    #
    # По умолчанию True: почти все договоры оплачиваются (пользователь оценивает
    # это как 95%), поэтому требовать подтверждения по каждой строке — лишняя
    # работа. Опровергается точечно: нашёл дату и снял отметку.
    is_paid = Column(Boolean, default=True, nullable=False, server_default=text("TRUE"), index=True)
    # Ссылка на договор регулярного расхода, по которому создано это списание.
    # Зачем не разбирать external_id. Связь уже дважды ломалась именно на разборе
    # строки: сначала LIKE с подстановочным «_» (удаление договора №1 затрагивало
    # №15), потом подсчёт по префиксу. Внешний ключ делает связь данными: по нему
    # считается «оплачено / не оплачено» одним индексным запросом.
    recurring_expense_id = Column(Integer, ForeignKey("recurring_expenses.id"),
                                  nullable=True, index=True)
    e100_mobility = Column(Boolean, default=False)
    inserted_at_source = Column(DateTime(timezone=True)) # datetimeInsert from e100
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    vehicle = relationship("Vehicle", back_populates="transactions")
    credential = relationship("E100Credential", back_populates="transactions")


class Mileage(Base):
    """Daily mileage summary per vehicle, imported from nav.by XLSX exports."""
    __tablename__ = "mileage"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    plate_number = Column(String(20), nullable=False)
    date = Column(DateTime(timezone=True), nullable=False)
    # Issue #2: km and fuel as Numeric — Float drift on cumulative mileage
    # would make per-100km calculations unreliable over thousands of records.
    km = Column(Numeric(12, 3), nullable=False, default=0)
    fuel_liters = Column(Numeric(12, 3), nullable=True)  # "Расход ДУТ, л" from the daily summary row
    source = Column(String(50), default="navby_xlsx")
    external_id = Column(String(150))                    # plate+date, for dedup on re-import
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class MileageSegment(Base):
    """Individual movement/stop segment per vehicle/day, imported from the
    detail rows of nav.by's "Подробный" XLSX export (columns С/По/Состояние).
    Powers time-balance, utilization (КТУ), average speed and stop-count
    analytics on the Mileage tab."""
    __tablename__ = "mileage_segments"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    plate_number = Column(String(20), nullable=False)
    date = Column(DateTime(timezone=True), nullable=False)
    time_from = Column(String(8))                        # "HH:MM:SS"
    time_to = Column(String(8))                           # "HH:MM:SS"
    status = Column(String(20), nullable=False)           # "Движение" / "Стоянка"
    km = Column(Numeric(12, 3), nullable=True)            # only set for "Движение" segments
    duration_seconds = Column(Integer, nullable=False, default=0)
    source = Column(String(50), default="navby_xlsx")
    external_id = Column(String(200))                     # plate+date+from+to+status, for dedup
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class TelegramSettings(Base):
    """Telegram notification settings per company."""
    __tablename__ = "telegram_settings"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), unique=True, nullable=False)
    chat_id = Column(String(50))                         # owner's Telegram chat_id
    notify_on_transaction = Column(Boolean, default=True)
    notify_daily_summary = Column(Boolean, default=False)
    daily_summary_time = Column(String(5), default="08:00")  # HH:MM
    is_active = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company = relationship("Company", back_populates="telegram_settings")


class ScraperSettings(Base):
    """Scraping schedule settings per company."""
    __tablename__ = "scraper_settings"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), unique=True, nullable=False)
    interval_minutes = Column(Integer, default=60)
    is_enabled = Column(Boolean, default=True)
    lookback_days = Column(Integer, default=30)          # how many days back to fetch
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    company = relationship("Company", back_populates="scraper_settings")


class RecurringContract(Base):
    """Recurring fixed-cost contract for the «Общие расходы» page.

    Covers office rent, accounting services and office parking — the three
    recurring general-expense categories whose monthly amount is fixed and
    known in advance. The user enters the contract once (annual cost +
    day-of-month + validity period) and the system auto-generates one
    Transaction per month on the chosen day. «Иные расходы» (other) is NOT
    a recurring contract — those are entered manually as one-off expenses
    through the regular /expenses/ endpoint.

    Auto-generated transactions use:
      source     = "recurring"
      external_id = f"recurring_{contract_id}_{YYYY-MM}"  (dedup key)
      fuel_type  = f"manual_general_{category}"           (office/accounting/parking)
    """
    __tablename__ = "recurring_contracts"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)

    category = Column(String(30), nullable=False)        # office | accounting | parking
    description = Column(String(500), nullable=False)     # human label, e.g. "Аренда офиса"
    start_date = Column(Date, nullable=False)             # contract validity start
    end_date = Column(Date, nullable=False)               # contract validity end (inclusive)
    # Issue #2: NUMERIC(18, 2) for annual_amount — large contracts
    annual_amount = Column(Numeric(18, 2), nullable=False)  # cost per year (in `currency`)
    currency = Column(String(10), nullable=False, default="EUR")
    day_of_month = Column(Integer, nullable=False)        # 1..28 — day auto-charge fires
    monthly_amount = Column(Numeric(18, 2), nullable=False)  # annual_amount / 12, precomputed

    is_active = Column(Boolean, default=True, nullable=False)  # False once cancelled
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class RecurringTombstone(Base):
    """Marker for a (contract_id, year-month) pair whose auto-generated
    transaction was manually deleted by the user. The sync endpoint checks
    this table to avoid re-creating a transaction the user explicitly removed.

    Without this, deleting a single monthly auto-charge would be useless —
    the next page load would re-create it via sync.
    """
    __tablename__ = "recurring_tombstones"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    contract_id = Column(Integer, ForeignKey("recurring_contracts.id", ondelete="CASCADE"), nullable=False, index=True)
    year_month = Column(String(7), nullable=False)       # "YYYY-MM" — matches the external_id suffix
    external_id = Column(String(150), nullable=False)    # full dedup key, for fast lookup
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class LeasingContract(Base):
    """Leasing contract for a specific vehicle — fixed monthly payment.

    Unlike RecurringContract (office/accounting/parking — unassigned), a
    leasing contract is bound to a specific vehicle (plate_number is required).
    The user enters the vehicle, start date, total amount, term in months
    (1..100) and day-of-month (1..28). The system auto-generates one
    Transaction per month on the chosen day.

    Generated transactions use:
      source      = "recurring"
      external_id = f"leasing_{contract_id}_{YYYY-MM}"  (dedup key)
      fuel_type   = "manual_leasing_payment"
      plate_number = the leased vehicle's plate
    """
    __tablename__ = "leasing_contracts"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    plate_number = Column(String(20), nullable=False)    # required — leasing is per-vehicle
    description = Column(String(500))                   # e.g. "PKO Leasing (#9921)"
    start_date = Column(Date, nullable=False)            # first charge month
    term_months = Column(Integer, nullable=False)        # 1..100 — contract duration
    # Issue #2: NUMERIC(18, 2) — full contract value can be very large
    total_amount = Column(Numeric(18, 2), nullable=False)  # e.g. 112000 EUR (full contract value)
    currency = Column(String(10), nullable=False, default="EUR")
    day_of_month = Column(Integer, nullable=False)       # 1..28 — day auto-charge fires
    monthly_amount = Column(Numeric(18, 2), nullable=False)  # total_amount / term_months, precomputed

    is_active = Column(Boolean, default=True, nullable=False)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class LeasingTombstone(Base):
    """Tombstone for a deleted leasing auto-charge (parallel to RecurringTombstone
    but with FK to leasing_contracts). Prevents sync from re-creating a
    monthly charge the user explicitly removed.
    """
    __tablename__ = "leasing_tombstones"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    contract_id = Column(Integer, ForeignKey("leasing_contracts.id", ondelete="CASCADE"), nullable=False, index=True)
    year_month = Column(String(7), nullable=False)
    external_id = Column(String(150), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class TrailerContract(Base):
    """Recurring trailer contract — RENTAL or INSURANCE for a rented trailer.

    Trailers are NOT in the Vehicle table — they're identified by plate_number
    only (e.g. "SW12345"). Each contract is recurring (monthly auto-charge),
    with start date, term in months, total amount and day-of-month.

    Categories:
      • rental    — trailer rent (manual_trailer_rental)
      • insurance — trailer insurance (manual_trailer_insurance)

    One-off trailer expenses (e.g. repairs) are added via /expenses/ with
    category="trailer_other" → fuel_type="manual_trailer_other".
    """
    __tablename__ = "trailer_contracts"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    plate_number = Column(String(20), nullable=False)
    category = Column(String(30), nullable=False)        # rental | insurance
    description = Column(String(500))
    start_date = Column(Date, nullable=False)
    term_months = Column(Integer, nullable=False)
    total_amount = Column(Numeric(18, 2), nullable=False)
    currency = Column(String(10), nullable=False, default="EUR")
    day_of_month = Column(Integer, nullable=False)
    monthly_amount = Column(Numeric(18, 2), nullable=False)

    is_active = Column(Boolean, default=True, nullable=False)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class TrailerTombstone(Base):
    __tablename__ = "trailer_tombstones"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    contract_id = Column(Integer, ForeignKey("trailer_contracts.id", ondelete="CASCADE"), nullable=False, index=True)
    year_month = Column(String(7), nullable=False)
    external_id = Column(String(150), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class InsuranceContract(Base):
    """Recurring vehicle insurance.

    ВАЖНО (SaaS-доработка): вид страхования больше НЕ жёстко задан списком
    «polish | casco | belarus». `category` — код категории из раздела
    `insurance` (системной или созданной компанией), поэтому можно учесть любой
    вид страхования в любой стране. Страна полиса — отдельный атрибут
    (`country`), а не часть вида страхования.

    Per-vehicle, recurring monthly charges. Исторически используемые коды:
      • polish   — польское обязательное OC (остался для существующих данных)
      • casco    — КАСКО
      • belarus  — белорусское транзитное страхование
      • oc / cmr / cargo / carrier_liability / employee / other — готовые
        системные варианты, см. app/services/category_service.py
    """
    __tablename__ = "insurance_contracts"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    plate_number = Column(String(20), nullable=False)
    category = Column(String(60), nullable=False)        # код категории раздела insurance
    # Страна полиса — отдельный атрибут (Германия, Польша, …). Раньше страна
    # была «зашита» в вид страхования, из-за чего казалось, что продукт только
    # про одну страну.
    country = Column(String(60), nullable=True)
    # Номер полиса и страховая компания — атрибуты полиса, отдельные от вида.
    policy_number = Column(String(100), nullable=True)
    insurer = Column(String(200), nullable=True)
    description = Column(String(500))
    start_date = Column(Date, nullable=False)
    term_months = Column(Integer, nullable=False)
    total_amount = Column(Numeric(18, 2), nullable=False)
    currency = Column(String(10), nullable=False, default="EUR")
    day_of_month = Column(Integer, nullable=False)
    monthly_amount = Column(Numeric(18, 2), nullable=False)

    is_active = Column(Boolean, default=True, nullable=False)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class InsuranceTombstone(Base):
    __tablename__ = "insurance_tombstones"

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    contract_id = Column(Integer, ForeignKey("insurance_contracts.id", ondelete="CASCADE"), nullable=False, index=True)
    year_month = Column(String(7), nullable=False)
    external_id = Column(String(150), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ──────────────────────────────────────────────────────────────────────
# Issue #3: FX rate table (currency, date, rate_to_eur)
# ──────────────────────────────────────────────────────────────────────
class FxRate(Base):
    """Daily FX rate: 1 unit of `currency` = `rate_to_eur` EUR.

    Sourced primarily from the European Central Bank's daily reference
    rates (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml),
    which publish at around 16:00 CET on each TARGET2 business day.

    The rate stored here is the multiplier to convert from `currency`
    to EUR. EUR is always 1.0. ECB publishes "1 EUR = N currency", so
    we invert on ingest: rate_to_eur = 1 / ecb_rate.

    MULTI-TENANT (Issue #11): `company_id` is NULL for global ECB rates
    (shared across all companies) and non-NULL for company-specific
    manual rates (e.g. BYN entered by owner of company A doesn't affect
    company B). The lookup logic prefers company-specific rates first,
    falls back to global.

    Currencies not in the ECB list (e.g. BYN, UAH) can be entered
    manually via the /api/fx-rates endpoint (with company_id set).
    """
    __tablename__ = "fx_rates"
    __table_args__ = (
        # FC-008: ДВА частичных уникальных индекса вместо одного UNIQUE.
        #
        # UNIQUE(company_id, currency, rate_date) не защищает глобальные курсы ЕЦБ:
        # у них company_id IS NULL, а в PostgreSQL NULL не равен NULL, поэтому две
        # строки (NULL, PLN, 2026-09-25) для такого ограничения — РАЗНЫЕ. Именно
        # для самой многочисленной части таблицы ограничение не работало.
        #
        # Последствие дублей не косметическое: поиск курса на точную дату идёт без
        # ORDER BY и берёт «первую» строку, то есть какую именно — решает
        # планировщик, и суммы в отчёте становятся недетерминированными.
        Index("uq_fx_rates_global_currency_date", "currency", "rate_date",
              unique=True,
              postgresql_where=text("company_id IS NULL"),
              sqlite_where=text("company_id IS NULL")),
        Index("uq_fx_rates_company_currency_date_partial",
              "company_id", "currency", "rate_date",
              unique=True,
              postgresql_where=text("company_id IS NOT NULL"),
              sqlite_where=text("company_id IS NOT NULL")),
        # Обычные индексы оставлены: ими пользуются выборки курсов по валюте без
        # условия по компании (список на странице курсов).
        Index("ix_fx_rates_currency_date", "currency", "rate_date"),
        Index("ix_fx_rates_company_currency_date", "company_id", "currency", "rate_date"),
    )

    id = Column(Integer, primary_key=True)
    # NULL = global (ECB). Non-NULL = company-specific manual override.
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=True, index=True)
    currency = Column(String(10), nullable=False, index=True)  # PLN, CZK, ...
    rate_date = Column(Date, nullable=False, index=True)        # date the rate is for
    rate_to_eur = Column(Numeric(18, 8), nullable=False)         # 1 currency = rate_to_eur EUR
    source = Column(String(20), default="ECB")                  # ECB / manual
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ──────────────────────────────────────────────────────────────────────
# Issue #6: Import history (detailed audit trail of every CSV/XLSX import)
# ──────────────────────────────────────────────────────────────────────
class ImportHistory(Base):
    """One row per import operation (CSV/XLSX/sync). Much richer than the
    single IMPORT entry in audit_log — captures per-file metrics so the
    user can see "what was the last income CSV I imported, how many rows
    were new vs updated vs skipped, was it successful".

    Populated by the /import/q8-csv, /import/income-csv, /import/mileage-xlsx
    endpoints, and by the E100 sync (POST /sync).
    """
    __tablename__ = "import_history"
    __table_args__ = (
        Index("ix_import_history_company_created", "company_id", "created_at"),
    )

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    user_email = Column(String(255), nullable=True)  # denormalized

    source = Column(String(50), nullable=False)  # e100 | q8 | fakturownia | navby_mileage
    filename = Column(String(255), nullable=True)  # original filename or "" for E100 sync

    # Row counts (per file)
    total_rows = Column(Integer, default=0)        # rows in source file
    new_rows = Column(Integer, default=0)            # newly inserted
    updated_rows = Column(Integer, default=0)       # existing rows updated
    skipped_rows = Column(Integer, default=0)       # dedup skips + parse failures
    failed_rows = Column(Integer, default=0)        # rows that raised exceptions

    # Date range in the file (if applicable)
    file_date_from = Column(Date, nullable=True)
    file_date_to = Column(Date, nullable=True)

    # Performance
    duration_ms = Column(Integer, nullable=True)  # how long the import took
    status = Column(String(20), nullable=False)  # success | partial | failed
    error_message = Column(Text, nullable=True)   # populated if status=failed

    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


# ──────────────────────────────────────────────────────────────────────
# Issue #2 (transaction history): TransactionRevision — revisions of a
# transaction, written whenever E100 retroactively modifies an existing row.
# ──────────────────────────────────────────────────────────────────────
class TransactionRevision(Base):
    """Snapshot of a Transaction at a specific moment. When E100 syncs and
    discovers an existing transaction was changed (amount corrected, status
    shifted from "blocked" to "paid", etc.), we write a revision row here
    BEFORE applying the new values.

    Main `transactions` table always shows the CURRENT (latest) state —
    that's what users see in the dashboard. The audit/history view shows
    the full revision chain so a bookkeeper can answer "why did the France
    total change between September and October?".

    Layout per revision:
      transaction_id 12345
        ↓
        created_at   02.09 14:30   →  amount=120.00  currency=EUR  is_confirmed=False
        ↓ (2 weeks later, E100 sync)
        created_at   16.09 09:42   →  amount=117.43  currency=EUR  is_confirmed=True

    The first revision (oldest) represents the original state when the
    transaction was first inserted. Each subsequent revision is the NEW
    state at the time of update.
    """
    __tablename__ = "transaction_revisions"
    __table_args__ = (
        Index("ix_transaction_revisions_txn_created", "transaction_id", "captured_at"),
        Index("ix_transaction_revisions_company_created", "company_id", "captured_at"),
    )

    id = Column(Integer, primary_key=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id"), nullable=False, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    # When this revision was captured (server time, not E100's transaction_date)
    captured_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # Which source caused the revision — usually "e100" (a sync discovered a change),
    # could also be "manual" if the user edited a transaction via PATCH.
    source = Column(String(50), default="e100")

    # Snapshot of the financial + status fields at this revision
    amount = Column(Numeric(14, 2), nullable=True)
    currency = Column(String(10), nullable=True)
    is_confirmed = Column(Boolean, nullable=True)
    fx_rate = Column(Numeric(18, 8), nullable=True)
    amount_eur = Column(Numeric(14, 2), nullable=True)
    inserted_at_source = Column(DateTime(timezone=True), nullable=True)
    station_id = Column(String(30), nullable=True)
    station_address = Column(Text, nullable=True)
    station_region = Column(String(100), nullable=True)


# ──────────────────────────────────────────────────────────────────────
# Issue #4: Audit log
# ──────────────────────────────────────────────────────────────────────
class AuditLog(Base):
    """Append-only audit trail of every state-changing operation in the
    system — who, when, what entity, what changed.

    Population: every route that performs POST/PATCH/DELETE on a
    business entity (Transaction, contract, credential, settings, user)
    calls audit_service.log() with the before/after state.

    Retention: AUDIT_LOG_RETENTION_DAYS setting (0 = keep forever).
    A nightly APScheduler job purges old entries.
    """
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_log_company_created", "company_id", "created_at"),
        Index("ix_audit_log_entity", "entity_type", "entity_id"),
    )

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # NULL = system job
    user_email = Column(String(255), nullable=True)  # denormalized for display after user_id FK is gone
    action = Column(String(30), nullable=False)      # CREATE / UPDATE / DELETE / SYNC / CANCEL
    entity_type = Column(String(50), nullable=False)  # Transaction / Vehicle / E100Credential / ...
    entity_id = Column(String(64), nullable=True)     # string for polymorphic IDs
    old_value = Column(Text, nullable=True)          # JSON snapshot before
    new_value = Column(Text, nullable=True)          # JSON snapshot after
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(512), nullable=True)
    # Issue #6: stable per-browser UUID (frontend generates on first launch,
    # stores in localStorage). Lets audit log distinguish between sessions
    # on different devices for the same user.
    client_id = Column(String(64), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


# ──────────────────────────────────────────────────────────────────────
# SaaS-доработка: динамические категории расходов
# ──────────────────────────────────────────────────────────────────────
class ExpenseCategory(Base):
    """Категория расхода внутри раздела (section).

    Раздел ФИКСИРОВАН — это область учёта, совпадающая с вкладкой меню:
        other       «Иные расходы»
        trailer     «Прицепы»
        general     «Общие расходы»
        salary      «Зарплата» (прямые выплаты)
        salary_tax  «Налоги и взносы»
        insurance   «Страхование»

    Категории внутри раздела — ДИНАМИЧЕСКИЕ: системные создаёт FleetCost
    (`is_system=True`), пользовательские — сама компания. Дальше они работают
    одинаково (расходы, аналитика, регулярные платежи).

    `code` попадает в `fuel_type` транзакции (`manual_{section}_{code}`),
    поэтому после создания его нельзя менять — иначе «оторвётся» история.
    Переименование меняет только `name`.

    Категорию, на которую ссылаются исторические операции, нельзя удалить
    физически: она переводится в `is_active=False`, а старые расходы
    продолжают отображаться.
    """
    __tablename__ = "expense_categories"
    __table_args__ = (
        UniqueConstraint("company_id", "section", "code",
                         name="uq_expense_categories_company_section_code"),
        Index("ix_expense_categories_company_section",
              "company_id", "section", "is_active"),
    )

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    section = Column(String(30), nullable=False)
    code = Column(String(50), nullable=False)
    name = Column(String(120), nullable=False)
    icon = Column(String(16), nullable=True)
    color = Column(String(20), nullable=True)
    # К чему относится расход по умолчанию: vehicle | trailer | company | employee | any
    object_scope = Column(String(20), default="any", nullable=False)
    is_system = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=True)


class RecurringExpense(Base):
    """Универсальный регулярный расход — для ЛЮБОЙ активной категории.

    Отличие от RecurringContract (офис/бухгалтерия/стоянка, годовая сумма):
    здесь категория любая, объектом может быть автомобиль, прицеп или компания,
    а сумма задаётся за период (месяц / квартал / год / неделя). Система
    достраивает недостающие списания до сегодняшнего дня — идемпотентно, по
    `external_id` = `rexp_{id}_{period}`.

    Примеры (ТЗ §8): бухгалтерия 500 EUR/мес — компания; аренда прицепа
    1250 EUR/мес — ER1234; страхование 1200 EUR/год — BI422GV; GPS 30 EUR/мес.
    """
    __tablename__ = "recurring_expenses"
    __table_args__ = (
        Index("ix_recurring_expenses_company_active", "company_id", "is_active"),
        # Список фильтруется по разделу и состоянию («Текущие / Будущие /
        # Завершённые») — индекс именно под этот отбор.
        Index("ix_recurring_expenses_company_status", "company_id", "status"),
    )

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    category_id = Column(Integer, ForeignKey("expense_categories.id"), nullable=False, index=True)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    trailer_plate = Column(String(20), nullable=True)   # прицеп (не в таблице vehicles)
    plate_number = Column(String(20), nullable=True)    # номер авто/прицепа для показа
    description = Column(String(500), nullable=False)
    amount = Column(Numeric(18, 2), nullable=False)     # сумма ЗА ОДНО СПИСАНИЕ
    currency = Column(String(10), nullable=False, default="EUR")
    # monthly | quarterly | yearly | weekly
    frequency = Column(String(20), nullable=False, default="monthly")
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=True)              # NULL = бессрочно
    day_of_month = Column(Integer, nullable=False, default=1)   # 1..28
    next_run_at = Column(Date, nullable=True)
    last_run_at = Column(Date, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)

    # ─── Как задаётся сумма ───────────────────────────────────────────
    # Люди считают по-разному, и заставлять их делить в уме — это ошибки в
    # данных. Поэтому `amount` (за одно списание) ВЫЧИСЛЯЕТСЯ из того, что ввёл
    # пользователь:
    #   period — «столько за период»           → amount = input_amount
    #   yearly — «столько за год»              → amount = input_amount / периодов_в_году
    #   total  — «столько всего за N списаний» → amount = input_amount / total_periods
    # Пример из жизни (лизинг): разовый взнос 10 000 вначале + 90 000 всего на
    # 48 месяцев → 90 000 / 48 = 1 875 в месяц, а 10 000 списывается один раз в
    # дату начала (см. `down_payment`).
    amount_mode = Column(String(20), nullable=False, default="period")
    input_amount = Column(Numeric(18, 2), nullable=True)     # то, что ввёл пользователь
    down_payment = Column(Numeric(18, 2), nullable=False, default=0)  # разовый взнос вначале
    total_periods = Column(Integer, nullable=True)           # всего списаний (NULL = бессрочно)

    # ─── Состояние графика ────────────────────────────────────────────
    # active — списания идут; paused — остановлен пользователем (следующих
    # списаний не будет, график и история сохраняются); completed — график
    # выработан. `is_active` остаётся зеркалом active/paused для запросов и
    # индексов, которые существовали до этой доработки.
    status = Column(String(20), nullable=False, default="active")
    paused_at = Column(DateTime(timezone=True), nullable=True)
    paid_periods = Column(Integer, nullable=False, default=0)  # сколько списаний уже создано
    document_ref = Column(String(100), nullable=True)          # номер договора/документа
    # Комментарий к договору: раньше вводился в форме и молча терялся.
    comment = Column(String(500), nullable=True)
    # Откуда перенесён: "leasing:12" / "trailer:3" / "insurance:7" / "general:5" —
    # id договора старого формата. По этой отметке перенос идемпотентен: повторный
    # запуск не создаёт второй договор.
    legacy_ref = Column(String(40), nullable=True, index=True)
    # ── Полисные атрибуты (страхование) ──
    # Страна полиса, номер и страховая — ОТДЕЛЬНЫЕ признаки, а не часть вида
    # страхования. Раньше они были только у старой модели InsuranceContract, и
    # после её закрытия вводить их стало некуда.
    country = Column(String(60), nullable=True)
    policy_number = Column(String(100), nullable=True)
    insurer = Column(String(200), nullable=True)

    category = relationship("ExpenseCategory")

    @property
    def display_status(self) -> str:
        """Состояние для интерфейса: active | upcoming | paused | completed.

        Отдельно от `status`, потому что «ожидается» и «завершён» — следствия
        дат и количества списаний, а не то, что выбрал пользователь. Считать их
        на клиенте значило бы рассинхронизировать экраны между собой.
        """
        from datetime import date as _date
        if self.status == "paused":
            return "paused"
        if self.total_periods and (self.paid_periods or 0) >= self.total_periods:
            return "completed"
        if self.end_date and self.end_date < _date.today():
            return "completed"
        if self.start_date and self.start_date > _date.today():
            return "upcoming"
        return "active"


class RecurringExpenseTombstone(Base):
    """Месяц/период регулярного расхода, списание которого пользователь удалил.

    Без этой отметки синхронизация создала бы удалённое списание заново при
    следующей загрузке страницы — то есть удаление было бы бесполезным.
    """
    __tablename__ = "recurring_expense_tombstones"
    __table_args__ = (
        UniqueConstraint("company_id", "contract_id", "period_key",
                         name="uq_recurring_expense_tombstones_contract_period"),
    )

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    contract_id = Column(Integer, ForeignKey("recurring_expenses.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    period_key = Column(String(10), nullable=False)      # YYYY-MM | YYYY-Qn | YYYY | YYYY-Www
    external_id = Column(String(150), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ──────────────────────────────────────────────────────────────────────
# Реестр прицепов и привязки «прицеп ↔ машина»
# ──────────────────────────────────────────────────────────────────────
class Trailer(Base):
    """Прицеп как объект учёта.

    Зачем отдельная сущность. До неё прицепы существовали только как НОМЕРА в
    расходах: список прицепов на странице собирался из тех строк, где встретился
    раздел «Прицепы». Из-за этого прицеп, по которому ещё не было расхода, для
    системы не существовал, а опечатка в номере создавала «второй» прицеп.

    Номера прицепов приходят из счетов («BI329LF/QASB981») и вводятся вручную.
    """
    __tablename__ = "trailers"
    __table_args__ = (
        UniqueConstraint("company_id", "plate", name="uq_trailers_company_plate"),
    )

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    plate = Column(String(20), nullable=False)
    note = Column(String(200), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    # Откуда узнали о прицепе: import | manual. Нужно, чтобы показать источник и
    # не удалять автоматически найденный прицеп вместе с ручными данными.
    origin = Column(String(20), default="manual", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)


class TrailerBinding(Base):
    """Привязка прицепа к машине — ПЕРИОДОМ, а не «текущим состоянием».

    Почему период. По выгрузкам видно, что прицеп за год работает с несколькими
    тягачами (в 22% «прицепо-месяцев» больше одной машины), а машина меняет
    прицепы. Одно поле «текущая машина» переписывало бы историю: в отчёте за
    прошлый месяц прицеп оказался бы привязан к машине, которой тогда рядом не
    было. Поэтому привязка — интервал с датами, и старые интервалы остаются.
    """
    __tablename__ = "trailer_bindings"
    __table_args__ = (
        Index("ix_trailer_bindings_company_period", "company_id", "from_date", "to_date"),
        Index("ix_trailer_bindings_trailer", "trailer_id", "from_date"),
    )

    id = Column(Integer, primary_key=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=False, index=True)
    trailer_id = Column(Integer, ForeignKey("trailers.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    plate_number = Column(String(20), nullable=True)   # номер машины на момент привязки
    from_date = Column(Date, nullable=False)
    to_date = Column(Date, nullable=True)              # NULL = действует
    note = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
