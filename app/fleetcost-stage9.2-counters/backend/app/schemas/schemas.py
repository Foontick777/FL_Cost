from typing import Annotated

from pydantic import BaseModel, EmailStr, Field, StringConstraints, field_validator, model_validator, ConfigDict
from typing import Optional, Any
from datetime import datetime, date
import re


def _normalize_email(v: str) -> str:
    """Normalize email to lowercase + strip whitespace. Prevents creating
    duplicate accounts with different case (A@x.com vs a@x.com)."""
    if v is None:
        return v
    return v.strip().lower()


# ──────────────────────────────────────────────────────────────────────
# Issue #8: Backend password policy
# ──────────────────────────────────────────────────────────────────────
# SEC-03 (аудит stage8): раньше допускался пароль из 7 символов — при
# pbkdf2_sha256 это перебирается на потребительском железе за часы, если
# пароль фразового вида. Минимум поднят до 10, требования по классам
# сохранены (заглавная + цифра) и добавлен стоп-лист расхожих паролей:
# они проходят «буквенно-цифровую» проверку, но стоят в верхних строках
# всех словарей брутфорса.
# Валидация живёт в Pydantic на каждом запросе, поэтому правило нельзя
# обойти, вызвав API напрямую мимо фронтенда.
# ВНИМАНИЕ: правило проверяется ТОЛЬКО при создании пользователя и смене
# пароля — существующие аккаунты (в т.ч. со старыми короткими паролями)
# продолжают входить без изменений.
PASSWORD_POLICY_REGEX = re.compile(r"^(?=.*[A-Z])(?=.*\d).{10,}$")

# Стоп-лист: точные совпадения (без учёта регистра) и расхожие подстроки.
# Список намеренно короткий и консервативный — он режет только те варианты,
# которые заведомо стоят в верхних строках словарей перебора.
_COMMON_PASSWORDS_EXACT = {
    "password12", "password123", "password1234", "passw0rd123",
    "qwertyuiop1", "qwerty12345", "abc1234567", "1234567890a",
    "1qaz2wsx3edc", "qazwsxedcrfv", "iloveyou123", "admin12345",
    "welcome1234", "letmein1234", "master12345", "sunshine123",
}
_COMMON_PASSWORD_SUBSTRINGS = ("password", "qwerty", "12345678", "administrator")


def validate_password_complexity(v: str) -> str:
    if not v or not PASSWORD_POLICY_REGEX.match(v):
        raise ValueError(
            "Password must be at least 10 characters and contain at least "
            "one uppercase letter and one digit."
        )
    low = v.lower()
    if low in _COMMON_PASSWORDS_EXACT or any(s in low for s in _COMMON_PASSWORD_SUBSTRINGS):
        raise ValueError(
            "Password is too common. Choose something less predictable."
        )
    return v


class RegisterRequest(BaseModel):
    company_name: str
    email: EmailStr
    password: str
    full_name: Optional[str] = None

    @field_validator("email")
    @classmethod
    def _normalize(cls, v):
        return _normalize_email(v)

    @field_validator("password")
    @classmethod
    def _check_password(cls, v):
        return validate_password_complexity(v)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email")
    @classmethod
    def _normalize(cls, v):
        return _normalize_email(v)


class TokenResponse(BaseModel):
    """Returned by /auth/login and /auth/register.

    Issue #3 (security hardening): in production, `access_token` is
    omitted from the JSON response — the JWT lives ONLY in the HttpOnly
    cookie, which JavaScript cannot read (XSS cannot steal it). The
    frontend relies on the cookie + the `csrf_token` for state-changing
    requests (double-submit CSRF pattern).

    In development (`ENVIRONMENT=development`), `access_token` IS
    included so you can paste it into Swagger UI / curl for debugging.
    The auth endpoints below conditionally populate it based on
    settings.ENVIRONMENT.
    """
    access_token: Optional[str] = None
    token_type: str = "bearer"
    csrf_token: Optional[str] = None  # set when cookies are enabled


# ──────────────────────────────────────────────────────────────────────
# User (new — for the owner-only user-management page)
# ──────────────────────────────────────────────────────────────────────
class UserCreate(BaseModel):
    email: EmailStr
    password: str
    full_name: Optional[str] = None
    role: str = "viewer"  # owner | manager | viewer (defaults to viewer for safety)

    @field_validator("email")
    @classmethod
    def _normalize_email_field(cls, v):
        return _normalize_email(v)

    @field_validator("password")
    @classmethod
    def _check_password(cls, v):
        return validate_password_complexity(v)

    @field_validator("role")
    @classmethod
    def _check_role(cls, v):
        if v not in ("owner", "manager", "viewer"):
            raise ValueError("role must be one of: owner, manager, viewer")
        return v


# Трёхбуквенный код валюты. Регистр приводим к верхнему, длину ограничиваем:
# без этого в базу попадали «eur», «EURO» и опечатки (FC-026 в аудите).
CurrencyCode = Annotated[str, StringConstraints(to_upper=True, min_length=3, max_length=3)]

# ── Whitelist валют (P0-3) ────────────────────────────────────────────────
# Система умеет пересчитывать в EUR только валюты из известного набора:
# архив ЕЦБ + резервный список Frankfurter. Без whitelist прямым запросом к
# API можно было создать расход в валюте «ABC»: он попадал в отчёты как
# настоящий, но amount_eur у него оставался NULL навсегда — строка-призрак,
# которая портит сверку сумм. Держим набор зеркалом fx_autoload.ECB_CURRENCIES;
# тест test_p0_fixes сверяет оба списка при расхождении.
ECB_CURRENCIES = frozenset({
    "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CYP", "CZK", "DKK", "EEK",
    "GBP", "HKD", "HRK", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW",
    "LTL", "LVL", "MTL", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "ROL",
    "RON", "RUB", "SEK", "SGD", "SIT", "SKK", "THB", "TRL", "TRY", "USD", "ZAR",
})

# Валюты вне ЕЦБ: резервный набор Frankfurter (BYN, RSD, UAH, MDL, GEL) плюс
# коды, которые Frankfurter реально отдаёт и которые встречаются в перевозках по
# Европе/Востоку. Живой список сервиса отдаёт /fx-rates/sources; здесь —
# статический floor для валидации ввода. Тест test_p0_fixes сверяет набор с
# fx_autoload.ECB_CURRENCIES и фолбэком маршрута form-currencies.
NON_ECB_ALLOWED = frozenset({
    "BYN", "RSD", "UAH", "MDL", "GEL",          # фолбэк Frankfurter (ручной ввод)
    "ALL", "AMD", "BAM", "AZN", "KZT", "MKD",   # поддерживаются Frankfurter
    "EGP", "TRY", "ILS",                        # рынки рядом с маршрутами
    # ── Полный список пар Frankfurter/ECB (dev.frankfurter.app/currencies). ──
    # Добавлен после того, как whitelist отверг валидные коды (белый экран из-за
    # 422 + сырой объект detail во фронтенде). Валюты вне этого списка действительно
    # не имеют автоматического источника — для них остаётся ручной курс.
    "AUD", "BRL", "CAD", "CHF", "CNY", "HKD", "IDR", "ILS", "INR", "JPY",
    "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "SGD", "THB", "USD", "ZAR",
})

KNOWN_CURRENCIES = frozenset(ECB_CURRENCIES | NON_ECB_ALLOWED | {"EUR"})


def validate_known_currency(v: Any) -> str:
    """Проверка кода валюты на входе: формат + известность источника курса."""
    v = (v or "").strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", v):
        raise ValueError("currency must be a 3-letter ISO code, e.g. PLN")
    if v not in KNOWN_CURRENCIES:
        raise ValueError(
            f"Неизвестная валюта '{v}': курса для неё взять неоткуда "
            "(нет ни в архиве ЕЦБ, ни во Frankfurter)"
        )
    return v


class UserOut(BaseModel):
    id: int
    email: str
    full_name: Optional[str]
    role: str
    is_active: bool
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class UserPatch(BaseModel):
    full_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None


class VehicleCreate(BaseModel):
    plate_number: str
    description: Optional[str] = None
    driver_name: Optional[str] = None


class VehicleUpdate(BaseModel):
    description: Optional[str] = None
    driver_name: Optional[str] = None
    is_active: Optional[bool] = None


class VehicleOut(BaseModel):
    id: int
    plate_number: str
    description: Optional[str]
    driver_name: Optional[str]
    is_active: bool
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class E100CredentialCreate(BaseModel):
    label: Optional[str] = "e100"
    username: str
    password: str


class E100CredentialUpdate(BaseModel):
    """Правка существующего доступа e100 — без создания нового.

    e100 раз в несколько недель требует сменить пароль. Раньше это лечилось
    только «удалить доступ и добавить заново», а это теряет историю синхронизаций
    и связь с уже загруженными транзакциями (они ссылаются на credential_id).
    Оба поля необязательны: можно поправить только логин, только пароль или оба.
    """
    username: Optional[str] = None
    password: Optional[str] = None


class E100CredentialOut(BaseModel):
    id: int
    label: str
    username: str
    is_active: bool
    last_sync_at: Optional[datetime]
    last_sync_status: Optional[str]
    last_sync_error: Optional[str]
    password_changed_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class TransactionOut(BaseModel):
    id: int
    transaction_date: Optional[datetime]
    plate_number: Optional[str]
    driver_name: Optional[str]
    country: Optional[str]
    station_id: Optional[str]
    station_address: Optional[str]
    fuel_type: Optional[str]
    # Issue #2: NUMERIC exposes as Decimal from SQLAlchemy. We use `float`
    # in the output schema because Pydantic v2 serializes Decimal to a
    # STRING by default (to preserve precision) — but the frontend's JS
    # can only handle numbers, and calls like `(12.34).toFixed(2)` would
    # throw "toFixed is not a function" if the value arrived as a string.
    # The DB column stays NUMERIC(14,2) — only the JSON output is float.
    price: Optional[float] = None
    volume: Optional[float] = None
    amount: float
    currency: CurrencyCode
    source: str
    is_confirmed: bool
    inserted_at_source: Optional[datetime]
    # Поля, которые вводятся в форме расхода: без них введённое нигде не видно.
    comment: Optional[str] = None
    document_ref: Optional[str] = None
    trailer_plate: Optional[str] = None
    is_paid: Optional[bool] = None
    # Договор, по которому создано списание (для карточек «Регулярные» по объекту).
    recurring_expense_id: Optional[int] = None
    # Issue #3: expose EUR-converted amount + FX rate metadata
    amount_eur: Optional[float] = None
    fx_rate: Optional[float] = None
    fx_rate_date: Optional[date] = None
    fx_source: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class VehicleStats(BaseModel):
    plate_number: str
    driver_name: Optional[str]
    transaction_count: int
    total_pln: float
    total_eur: float
    by_currency: dict


class PeriodStatsEur(BaseModel):
    """Суммы в EUR по СОХРАНЁННОМУ историческому курсу каждой операции
    (transactions.amount_eur), а не по текущему курсу фронтенда.

    Зачем отдельный блок: `by_currency` отдаёт сырые суммы по валютам, и
    фронтенд пересчитывал их в EUR по текущим курсам — из-за этого дашборд и
    Excel-экспорт (который берёт amount_eur) показывали разные итоги по одним
    данным. Здесь те же группировки, но по курсу на дату операции.

    `missing_rate_count` — сколько операций остались без amount_eur (для валюты
    не нашлось курса на дату). Такие суммы в итоги не входят, и это видно
    счётчиком, а не молчанием.
    """
    expenses: float
    income: float
    profit: float
    expenses_by_vehicle: dict
    expenses_by_country: dict
    expenses_by_fuel_type: dict
    missing_rate_count: int


class PeriodStats(BaseModel):
    date_from: date
    date_to: date
    total_transactions: int
    by_vehicle: list[VehicleStats]
    by_currency: dict
    by_country: dict
    by_fuel_type: dict
    # Необязательное поле: старые клиенты его просто не читают.
    eur: Optional[PeriodStatsEur] = None


class TelegramSettingsUpdate(BaseModel):
    chat_id: Optional[str] = None
    notify_on_transaction: Optional[bool] = None
    notify_daily_summary: Optional[bool] = None
    daily_summary_time: Optional[str] = None
    is_active: Optional[bool] = None


class TelegramSettingsOut(BaseModel):
    chat_id: Optional[str]
    notify_on_transaction: bool
    notify_daily_summary: bool
    daily_summary_time: str
    is_active: bool
    model_config = ConfigDict(from_attributes=True)


class ScraperSettingsUpdate(BaseModel):
    interval_minutes: Optional[int] = None
    is_enabled: Optional[bool] = None
    lookback_days: Optional[int] = None


class ScraperSettingsOut(BaseModel):
    interval_minutes: int
    is_enabled: bool
    lookback_days: int
    model_config = ConfigDict(from_attributes=True)


# ── Recurring contracts (General Expenses: office rent / accounting / parking) ──
RECURRING_CATEGORIES = {"office", "accounting", "parking"}


class RecurringContractCreate(BaseModel):
    category: str                                  # office | accounting | parking
    description: str
    start_date: date
    end_date: date
    annual_amount: float
    currency: CurrencyCode = "EUR"
    day_of_month: int                             # 1..28


class RecurringContractOut(BaseModel):
    id: int
    category: str
    description: str
    start_date: date
    end_date: date
    annual_amount: float
    currency: CurrencyCode
    day_of_month: int
    monthly_amount: float
    is_active: bool
    cancelled_at: Optional[datetime]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# ── Leasing contracts (per-vehicle, term-based monthly payment) ──
class LeasingContractCreate(BaseModel):
    plate_number: str                              # required — leasing is per-vehicle
    description: Optional[str] = None              # e.g. "PKO Leasing (#9921)"
    start_date: date
    term_months: int                              # 1..100
    total_amount: float                            # full contract value, e.g. 112000 EUR
    currency: CurrencyCode = "EUR"
    day_of_month: int                             # 1..28


class LeasingContractOut(BaseModel):
    id: int
    vehicle_id: Optional[int]
    plate_number: str
    description: Optional[str]
    start_date: date
    term_months: int
    total_amount: float
    currency: CurrencyCode
    day_of_month: int
    monthly_amount: float
    is_active: bool
    cancelled_at: Optional[datetime]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# ── Trailer contracts (rented trailers: rental + insurance recurring) ──
TRAILER_CATEGORIES = {"rental", "insurance"}


class TrailerContractCreate(BaseModel):
    plate_number: str
    category: str                                  # rental | insurance
    description: Optional[str] = None
    start_date: date
    term_months: int
    total_amount: float
    currency: CurrencyCode = "EUR"
    day_of_month: int


class TrailerContractOut(BaseModel):
    id: int
    plate_number: str
    category: str
    description: Optional[str]
    start_date: date
    term_months: int
    total_amount: float
    currency: CurrencyCode
    day_of_month: int
    monthly_amount: float
    is_active: bool
    cancelled_at: Optional[datetime]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# ── Insurance contracts (per-vehicle) ──
# Вид страхования БОЛЬШЕ НЕ ограничен списком «polish | casco | belarus»:
# `category` — код категории раздела `insurance` (системной или созданной
# компанией), поэтому можно учесть любой вид страхования в любой стране.
# Список ниже оставлен только как справка по историческим кодам.
INSURANCE_LEGACY_CATEGORIES = {"polish", "casco", "belarus"}

# Код категории: ASCII, нижний регистр, цифры, подчёркивания. Тот же формат,
# что и у code в expense_categories (он попадает в fuel_type).
# 0..49 — ровно как `code = Column(String(50))` в модели. Было 60, и
# код из 55 символов проходил проверку схемы, а потом падал на вставке.
CATEGORY_CODE_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,49}$")


def validate_category_code(v: str) -> str:
    v = (v or "").strip().lower()
    if not CATEGORY_CODE_RE.match(v):
        raise ValueError(
            "category code must be lowercase ASCII letters/digits/underscore, "
            "1..60 chars (e.g. casco, carrier_liability)"
        )
    return v


class InsuranceContractCreate(BaseModel):
    plate_number: str
    category: str                                  # код категории раздела insurance
    country: Optional[str] = None                  # страна полиса (отдельный атрибут)
    policy_number: Optional[str] = None
    insurer: Optional[str] = None
    description: Optional[str] = None
    start_date: date
    term_months: int
    total_amount: float
    currency: CurrencyCode = "EUR"
    day_of_month: int

    @field_validator("category")
    @classmethod
    def _check_category(cls, v):
        return validate_category_code(v)


class InsuranceContractOut(BaseModel):
    id: int
    vehicle_id: Optional[int]
    plate_number: str
    category: str
    country: Optional[str] = None
    policy_number: Optional[str] = None
    insurer: Optional[str] = None
    description: Optional[str]
    start_date: date
    term_months: int
    total_amount: float
    currency: CurrencyCode
    day_of_month: int
    monthly_amount: float
    is_active: bool
    cancelled_at: Optional[datetime]
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# ──────────────────────────────────────────────────────────────────────
# SaaS-доработка: динамические категории расходов
# ──────────────────────────────────────────────────────────────────────
class ExpenseCategoryOut(BaseModel):
    """Категория расхода. `usage_count` — сколько операций её используют:
    нужно, чтобы в «Администрировании» было видно, можно ли категорию удалить
    физически или только отключить."""
    id: int
    section: str
    code: str
    name: str
    icon: Optional[str] = None
    color: Optional[str] = None
    object_scope: str = "any"
    is_system: bool
    is_active: bool
    sort_order: int = 0
    usage_count: int = 0
    created_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class ExpenseCategoryCreate(BaseModel):
    section: str
    name: str
    code: Optional[str] = None      # если не задан — соберём из name
    icon: Optional[str] = None
    color: Optional[str] = None
    object_scope: Optional[str] = None
    is_active: bool = True

    @field_validator("section")
    @classmethod
    def _check_section(cls, v):
        from app.services.category_service import SECTIONS
        v = (v or "").strip().lower()
        if v not in SECTIONS:
            raise ValueError(f"section must be one of: {', '.join(SECTIONS)}")
        return v

    @field_validator("name")
    @classmethod
    def _check_name(cls, v):
        v = (v or "").strip()
        if not v:
            raise ValueError("name is required")
        return v[:120]

    @field_validator("code")
    @classmethod
    def _check_code(cls, v):
        if v is None or not str(v).strip():
            return None
        return validate_category_code(v)


class ExpenseCategoryPatch(BaseModel):
    """Правка категории. `code` намеренно отсутствует: он входит в fuel_type
    уже записанных операций, и его изменение оторвало бы историю."""
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    object_scope: Optional[str] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None

    @field_validator("name")
    @classmethod
    def _check_name(cls, v):
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("name cannot be empty")
        return v[:120]


# ── Универсальные регулярные расходы (любая категория) ──
RECURRING_EXPENSE_FREQUENCIES = {"monthly", "quarterly", "yearly", "weekly"}
# Как пользователь задал сумму: за период / за год / всего за весь срок.
RECURRING_AMOUNT_MODES = {"period", "yearly", "total"}


class RecurringExpenseCreate(BaseModel):
    """Регулярный расход. Объект выбирается одним из трёх:
      • plate_number   — автомобиль (номер из справочника)
      • trailer_plate  — прицеп
      • ни то, ни другое — расход компании
    При открытии формы из карточки прицепа/автомобиля объект подставляется.
    """
    category_id: Optional[int] = None
    section: Optional[str] = None
    code: Optional[str] = None
    description: Optional[str] = None
    plate_number: Optional[str] = None
    trailer_plate: Optional[str] = None
    # `amount` — сумма ЗА ПЕРИОД (прежний способ ввода).
    # `input_amount` + `amount_mode` + `total_periods` — новый: «столько за год»
    # или «столько всего за N списаний» (лизинг: 90 000 за 48 месяцев).
    amount: Optional[float] = Field(default=None, gt=0)
    input_amount: Optional[float] = Field(default=None, gt=0)
    amount_mode: str = "period"
    down_payment: float = Field(default=0, ge=0)
    total_periods: Optional[int] = Field(default=None, ge=1, le=1200)
    currency: CurrencyCode = "EUR"
    frequency: str = "monthly"
    start_date: date
    end_date: Optional[date] = None
    day_of_month: int = Field(default=1, ge=1, le=28)
    # Полисные атрибуты — заполняются для раздела «Страхование».
    country: Optional[str] = None
    policy_number: Optional[str] = None
    insurer: Optional[str] = None
    document_ref: Optional[str] = Field(default=None, max_length=100)
    comment: Optional[str] = Field(default=None, max_length=500)

    @field_validator("frequency")
    @classmethod
    def _check_frequency(cls, v):
        v = (v or "monthly").strip().lower()
        if v not in RECURRING_EXPENSE_FREQUENCIES:
            raise ValueError(f"frequency must be one of: {', '.join(sorted(RECURRING_EXPENSE_FREQUENCIES))}")
        return v

    @field_validator("amount_mode")
    @classmethod
    def _check_amount_mode(cls, v):
        v = (v or "period").strip().lower()
        if v not in RECURRING_AMOUNT_MODES:
            raise ValueError(f"amount_mode must be one of: {', '.join(sorted(RECURRING_AMOUNT_MODES))}")
        return v

    # P0-3: whitelist валют на входе.
    @field_validator("currency")
    @classmethod
    def _check_currency(cls, v):
        return validate_known_currency(v)

    @model_validator(mode="after")
    def _require_some_amount(self):
        """Хотя бы один способ задать сумму обязателен.

        Без этого регулярный платёж на 0 EUR создавался бы молча: он попадал бы
        в график, давал нулевые списания и выглядел как «работает».
        """
        if not self.amount and not self.input_amount:
            raise ValueError("укажите amount (за период) или input_amount (с amount_mode)")
        if self.amount_mode == "total" and not self.total_periods:
            raise ValueError("для amount_mode='total' нужен total_periods (сколько всего списаний)")
        return self


class RecurringExpenseUpdate(BaseModel):
    """Изменение регулярного расхода (ТЗ §13, P2 ревью).

    Меняется ГРАФИК, а не история. Уже созданные списания — это деньги, которые
    реально ушли, и переписывать прошлое нельзя: отчёт за закрытый месяц обязан
    остаться тем же. Поэтому правка влияет на будущие периоды, а прошедшие
    остаются как есть. Если из-за правки график сократился до уже оплаченных
    платежей, договор считается завершённым.

    Все поля необязательные: приходит только то, что пользователь изменил.
    """
    section: Optional[str] = None
    code: Optional[str] = None
    category_id: Optional[int] = None
    description: Optional[str] = None
    plate_number: Optional[str] = None
    trailer_plate: Optional[str] = None
    amount: Optional[float] = Field(default=None, gt=0)
    input_amount: Optional[float] = Field(default=None, gt=0)
    amount_mode: Optional[str] = None
    down_payment: Optional[float] = Field(default=None, ge=0)
    total_periods: Optional[int] = Field(default=None, ge=1, le=1200)
    currency: Optional[CurrencyCode] = None
    frequency: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    day_of_month: Optional[int] = Field(default=None, ge=1, le=28)
    document_ref: Optional[str] = None
    comment: Optional[str] = Field(default=None, max_length=500)
    country: Optional[str] = None
    policy_number: Optional[str] = None
    insurer: Optional[str] = None

    @field_validator("amount_mode")
    @classmethod
    def _check_mode(cls, v):
        if v is None:
            return None
        v = v.strip().lower()
        if v not in RECURRING_AMOUNT_MODES:
            raise ValueError(f"amount_mode must be one of: {', '.join(sorted(RECURRING_AMOUNT_MODES))}")
        return v

    @field_validator("frequency")
    @classmethod
    def _check_freq(cls, v):
        if v is None:
            return None
        v = v.strip().lower()
        if v not in RECURRING_EXPENSE_FREQUENCIES:
            raise ValueError(f"frequency must be one of: {', '.join(sorted(RECURRING_EXPENSE_FREQUENCIES))}")
        return v

    # P0-3: whitelist валют (None = «валюту не меняли» — пропускаем).
    @field_validator("currency")
    @classmethod
    def _check_currency(cls, v):
        if v is None or not str(v).strip():
            return None
        return validate_known_currency(v)

    @model_validator(mode="after")
    def _check_monthly_total(self):
        if self.amount_mode == "total" and self.total_periods is None:
            raise ValueError("для суммы «всего за срок» укажите число платежей")
        return self


class RecurringExpenseOut(BaseModel):
    id: int
    category_id: int
    section: Optional[str] = None
    code: Optional[str] = None
    category_name: Optional[str] = None
    plate_number: Optional[str] = None
    trailer_plate: Optional[str] = None
    description: str
    amount: float
    input_amount: Optional[float] = None
    amount_mode: str = "period"
    down_payment: Optional[float] = 0
    currency: CurrencyCode
    frequency: str
    start_date: date
    end_date: Optional[date] = None
    day_of_month: int
    is_active: bool
    cancelled_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    country: Optional[str] = None
    policy_number: Optional[str] = None
    insurer: Optional[str] = None
    document_ref: Optional[str] = None
    comment: Optional[str] = None
    created_by: Optional[int] = None
    paused_at: Optional[datetime] = None
    # ─── График и остаток — считает СЕРВЕР ────────────────────────────
    # Клиент не должен выводить «осталось 6 месяцев» и остаток сам: иначе
    # экраны разойдутся между собой, а на суммах это заметно сразу.
    status: str = "active"                 # active | paused | completed
    display_status: str = "active"         # + upcoming (вкладки «Текущие/Будущие»)
    total_periods: Optional[int] = None
    paid_periods: int = 0
    remaining_periods: Optional[int] = None
    # §10 ревью: остаток разделён, потому что «обязательство» и «регулярные
    # платежи» — разные суммы. По лизингу 90 000 за 48 месяцев с разовым взносом
    # 10 000 (ещё не оплаченным) долг равен 94 375, а не 84 375: взнос — это тоже
    # обязательство, и без отдельного поля он пропадал из итога.
    remaining_period_amount: Optional[float] = None
    remaining_down_payment: Optional[float] = None
    remaining_total_obligation: Optional[float] = None
    # Пропущенные периоды: пауза или удалённое списание. Их нельзя
    # считать будущими платежами — они не будут оплачены никогда.
    skipped_periods: Optional[int] = 0
    # ─── Оплата начислений ────────────────────────────────────────────
    # Начисление считается оплаченным по умолчанию (оплачивается большинство
    # договоров), но отметку можно снять — тогда оно попадает в «не оплачено» и
    # снова оказывается в остатке обязательств.
    created_periods: Optional[int] = 0
    unpaid_periods: Optional[int] = 0
    unpaid_amount: Optional[float] = 0
    remaining_amount: Optional[float] = None
    # Остаток обязательств В ЕВРО по курсу на сегодня. None — курс неизвестен:
    # фронтенд показывает валюту договора без пересчёта, а не делит на
    # устаревший захардкоженный курс (дефект аудита stage9.1).
    remaining_amount_eur: Optional[float] = None
    next_charge_date: Optional[date] = None
    monthly_amount: Optional[float] = None   # приведение к «в месяц» для итога блока
    model_config = ConfigDict(from_attributes=True)


# ──────────────────────────────────────────────────────────────────────
# Issue #3: FX rate schemas
# ──────────────────────────────────────────────────────────────────────
class FxRateOut(BaseModel):
    id: int
    company_id: Optional[int] = None  # NULL = global ECB, non-NULL = company-specific
    currency: CurrencyCode
    rate_date: date
    rate_to_eur: float
    source: str
    created_at: datetime
    # Результат автоматического пересчёта после сохранения курса: сколько строк
    # пересчитано и что осталось без курса. Поле необязательное — в списке курсов
    # его нет, оно заполняется только в ответе на добавление курса.
    auto: Optional[dict] = None
    model_config = ConfigDict(from_attributes=True)


class FxRateCreate(BaseModel):
    """Manual FX rate. Owner may set any currency; manager — only a currency that
    the ECB archive does not provide at all (BYN, RSD, UAH…), because for ECB
    currencies the manual value would override the official rate.

    Stored with the current user's
    company_id — only affects that company's transactions (Issue #11)."""
    currency: str = Field(min_length=3, max_length=3)
    rate_date: date
    rate_to_eur: float = Field(gt=0, le=1000)
    source: str = "manual"

    @field_validator("currency")
    @classmethod
    def _normalise_currency(cls, v: str) -> str:
        # P0-3: whitelist вместо голого regex — курс вводится только для валют,
        # которые система способна опознать (ЕЦБ или Frankfurter-набор).
        return validate_known_currency(v)


class FxRateBulkCreate(BaseModel):
    """Один курс — сразу на несколько дат одной валюты (владелец и менеджер).

    Менеджеру доступно то, ради чего ввод и существует: валюта вне архива ЕЦБ.

    Нужен для валют, которых нет в архиве ЕЦБ (BYN, RSD, UAH, MDL…): курса в
    источнике для них не будет никогда, а вводить его по одной дате неудобно —
    курс действует 14 дней вперёд, поэтому окно из нескольких транзакций требует
    нескольких записей.

    ЭТО ФИНАНСОВОЕ РЕШЕНИЕ: одно и то же значение применяется ко всем перечисленным
    датам, даже если фактический курс менялся. Для валют без источника это
    осознанный компромисс, поэтому действие пишется в журнал одной записью с
    полным перечнем дат.
    """
    currency: str = Field(min_length=3, max_length=3)
    rate_to_eur: float = Field(gt=0, le=1000)
    # Даты принимаются как `date`: pydantic разберёт ISO-строки и отклонит мусор
    # ещё до маршрута — та же защита от «строки вместо даты», что и в §30.
    dates: list[date] = Field(min_length=1)
    source: str = "manual"

    @field_validator("currency")
    @classmethod
    def _normalise_currency(cls, v: str) -> str:
        # P0-3: тот же whitelist, что и в FxRateCreate.
        return validate_known_currency(v)


class FxConversionRequest(BaseModel):
    """Convert an amount in a foreign currency to EUR at a given date."""
    amount: float
    currency: CurrencyCode
    date: date


class FxConversionResponse(BaseModel):
    amount: float
    currency: CurrencyCode
    rate_date: date
    fx_rate: float
    amount_eur: float
    source: str


# ──────────────────────────────────────────────────────────────────────
# Issue #4: Audit log schemas
# ──────────────────────────────────────────────────────────────────────
class AuditLogOut(BaseModel):
    id: int
    company_id: int
    user_id: Optional[int]
    user_email: Optional[str]
    action: str
    entity_type: str
    entity_id: Optional[str]
    old_value: Optional[str]
    new_value: Optional[str]
    ip_address: Optional[str]
    user_agent: Optional[str]
    client_id: Optional[str] = None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)
