"""Динамические категории расходов (универсальная модель для SaaS).

РАЗДЕЛЫ (section) — ФИКСИРОВАНЫ: это области учёта, совпадающие с вкладками
меню и с префиксом `fuel_type` транзакции:

    other        — «Иные расходы»
    trailer      — «Прицепы»
    general      — «Общие расходы»
    salary       — «Зарплата» (прямые выплаты водителям)
    salary_tax   — «Налоги и взносы» (ZUS / PIT / ФСЗН / Lohnsteuer / …)
    insurance    — «Страхование»

КАТЕГОРИИ внутри раздела — ДИНАМИЧЕСКИЕ. Компания получает готовый системный
набор для быстрого старта и может добавить любую свою категорию. Системные и
пользовательские категории далее работают одинаково (расходы, аналитика,
регулярные платежи).

Связь с историей (`fuel_type`)
-----------------------------
`fuel_type` транзакции = `manual_{prefix}_{code}`, где

    prefix = SECTION_PREFIX.get(section, section)

исключение одно: у раздела `salary_tax` префикс равен `salary`. Сделано
намеренно — благодаря этому уже сохранённые строки ZUS/PIT продолжают
классифицироваться: `manual_salary_zus`, `manual_salary_pit4`. Новая категория
налога, например «ФСЗН» (code `fszn`), даёт `manual_salary_fszn`, то есть
остаётся в том же пространстве имён и не ломает ни один из существующих
фильтров (`isSalary`, отчёты, экспорт).

`code` — машинный идентификатор категории (ASCII, нижний регистр). Он попадает
в `fuel_type`, поэтому после создания менять его нельзя (иначе «оторвётся»
история). Переименование меняет только отображаемое `name`.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import ExpenseCategory, Transaction

# ── Разделы ────────────────────────────────────────────────────────────────
SECTION_OTHER = "other"
SECTION_TRAILER = "trailer"
SECTION_GENERAL = "general"
SECTION_SALARY = "salary"
SECTION_SALARY_TAX = "salary_tax"
# Лизинг и аренда техники. Раздел появился, чтобы лизинг перестал быть
# отдельной моделью (LeasingContract) со своей серией списаний: один и
# тот же договор можно было завести и там, и в регулярных расходах.
SECTION_LEASING = "leasing"
SECTION_INSURANCE = "insurance"

SECTIONS = (
    SECTION_OTHER,
    SECTION_TRAILER,
    SECTION_GENERAL,
    SECTION_SALARY,
    SECTION_SALARY_TAX,
    SECTION_INSURANCE,
    SECTION_LEASING,
)

# Раздел → префикс в fuel_type. Единственное исключение — налоги: они живут в
# том же пространстве `manual_salary_*`, что и прямые выплаты, ради совместимости
# с историческими строками ZUS/PIT.
SECTION_PREFIX = {SECTION_SALARY_TAX: SECTION_SALARY}

# Раздел → область применения по умолчанию (к чему относится расход).
SECTION_OBJECT_SCOPE = {
    SECTION_OTHER: "any",
    SECTION_TRAILER: "trailer",
    SECTION_GENERAL: "company",
    SECTION_SALARY: "vehicle",
    SECTION_SALARY_TAX: "company",
    # Раздел «Лизинг» — только автомобили парка. Лизинг прицепа ведётся в
    # разделе «Прицепы» (категория trailer/leasing).
    SECTION_LEASING: "vehicle",
    SECTION_INSURANCE: "any",
}

# Разделы, расходы которых по смыслу принадлежат компании, а не автомобилю.
COMPANY_LEVEL_SECTIONS = {SECTION_GENERAL, SECTION_SALARY_TAX}


def fuel_prefix(section: str) -> str:
    """Префикс `fuel_type` для раздела."""
    return SECTION_PREFIX.get(section, section)


def fuel_type_for(section: str, code: str) -> str:
    """`manual_{prefix}_{code}` — единственное место, где собирается fuel_type."""
    return f"manual_{fuel_prefix(section)}_{code}"


# ── Готовые (системные) категории для быстрого старта ──────────────────────
# (section, code, name, icon, is_system)
DEFAULT_CATEGORIES: list[tuple[str, str, str, str, bool]] = [
    # ── Иные расходы ──
    (SECTION_OTHER, "fine", "Штрафы", "🚨", True),
    (SECTION_OTHER, "parking", "Парковки", "🅿️", True),
    (SECTION_OTHER, "repair", "Ремонты", "🔧", True),
    (SECTION_OTHER, "wash", "Мойка", "🚿", True),
    (SECTION_OTHER, "tire", "Шиномонтаж", "🛞", True),
    (SECTION_OTHER, "other", "Прочее", "📦", True),
    # Сервисные сборы E100 приходят автоматически (source = e100) и не
    # создаются вручную — категория существует, чтобы аналитика по категориям
    # не теряла эту строку.
    (SECTION_OTHER, "e100_service_fee", "Сервисные сборы E100", "🧾", True),
    # ── Прицепы ──
    (SECTION_TRAILER, "rental", "Аренда", "🏢", True),
    (SECTION_TRAILER, "insurance", "Страхование", "🛡️", True),
    (SECTION_TRAILER, "cmr", "CMR", "📄", True),
    (SECTION_TRAILER, "repair", "Ремонт", "🔧", True),
    (SECTION_TRAILER, "tire", "Шиномонтаж", "🛞", True),
    (SECTION_TRAILER, "wash", "Мойка", "🚿", True),
    (SECTION_TRAILER, "inspection", "Технический осмотр", "🔎", True),
    (SECTION_TRAILER, "leasing", "Лизинг", "💳", True),
    (SECTION_TRAILER, "other", "Прочее", "📦", True),
    # ── Общие расходы ──
    (SECTION_GENERAL, "office", "Аренда офиса", "🏢", True),
    (SECTION_GENERAL, "accounting", "Бухгалтерия", "🧮", True),
    (SECTION_GENERAL, "utilities", "Коммунальные услуги", "💡", True),
    (SECTION_GENERAL, "internet", "Интернет", "🌐", True),
    (SECTION_GENERAL, "telephony", "Телефония", "📱", True),
    (SECTION_GENERAL, "bank", "Банк", "🏦", True),
    (SECTION_GENERAL, "legal", "Юридические услуги", "⚖️", True),
    (SECTION_GENERAL, "software", "Программное обеспечение", "💻", True),
    (SECTION_GENERAL, "ads", "Реклама", "📣", True),
    (SECTION_GENERAL, "cleaning", "Уборка", "🧹", True),
    (SECTION_GENERAL, "security", "Охрана", "🛡️", True),
    (SECTION_GENERAL, "other", "Прочее", "📦", True),
    # ── Зарплата (прямые выплаты) ──
    (SECTION_SALARY, "monthly", "Ежемесячная", "🗓️", True),
    (SECTION_SALARY, "bonus", "Премия", "🎁", True),
    (SECTION_SALARY, "advance", "Аванс", "💵", True),
    # ── Налоги и взносы ──
    # ZUS и PIT сохранены ровно с теми же code, что и раньше: fuel_type
    # `manual_salary_zus` / `manual_salary_pit4` продолжает совпадать со старой
    # историей. У остальных стран — свои налоги, добавляются пользователем.
    (SECTION_SALARY_TAX, "zus", "ZUS (Польша)", "🏛️", True),
    (SECTION_SALARY_TAX, "pit4", "PIT-4 (Польша)", "🏛️", True),
    # ── Страхование ──
    # ── Лизинг и аренда ──
    (SECTION_LEASING, "leasing", "Лизинг", "📄", True),
    (SECTION_LEASING, "buyout", "Выкуп предмета лизинга", "🏁", False),
    (SECTION_LEASING, "other", "Прочие лизинговые платежи", "🧾", False),
    (SECTION_INSURANCE, "casco", "КАСКО", "🛡️", True),
    (SECTION_INSURANCE, "oc", "ОСАГО / ОСГО / аналог", "📑", True),
    (SECTION_INSURANCE, "trailer_insurance", "Страхование прицепа", "🚛", True),
    (SECTION_INSURANCE, "cmr", "CMR", "📄", True),
    (SECTION_INSURANCE, "carrier_liability", "Ответственность перевозчика", "⚖️", True),
    (SECTION_INSURANCE, "cargo", "Страхование груза", "📦", True),
    (SECTION_INSURANCE, "employee", "Страхование сотрудников", "👥", True),
    (SECTION_INSURANCE, "other", "Другое", "➕", True),
    # Исторические «польская» / «белорусская» больше НЕ жёстко заданные виды
    # страховки: они остаются как готовые категории для тех, у кого уже есть
    # такие договоры, но по умолчанию неактивны, чтобы не создавать ощущения
    # «программа только про Польшу». Существующие договоры и расходы
    # продолжают отображаться и считаться (история не теряется).
    (SECTION_INSURANCE, "polish", "Польская (историч.)", "🇵🇱", True),
    (SECTION_INSURANCE, "belarus", "Белорусская (историч.)", "🇧🇾", True),
]

# Категории, которые создаются неактивными (исторические, для совместимости).
INACTIVE_BY_DEFAULT = {("insurance", "polish"), ("insurance", "belarus")}

# Разделы, которые не являются «пользовательскими расходами» — по ним нельзя
# создавать операции вручную (E100-сбор приходит только из источника E100).
NON_MANUAL_CODES = {("other", "e100_service_fee")}

_LEGACY_SIMPLE = {"fine": "other", "parking": "other", "repair": "other"}
_FUEL_LIKE_PREFIXES = {"fuel", "adblue", "income"}

_FT_RE = re.compile(r"^manual_([a-z_]+?)_(.+)$")
_FT_SIMPLE_RE = re.compile(r"^manual_(fine|parking|repair)$")


def parse_fuel_type(fuel_type: Optional[str]) -> Optional[tuple[str, str]]:
    """`fuel_type` → (section, code) или None, если строка не про категорию.

    Понимает и новый формат (`manual_{section}_{code}`), и исторические
    сокращения (`manual_fine`, `manual_parking`, `manual_repair`, `manual_other`).
    """
    if not fuel_type:
        return None
    ft = fuel_type.strip().lower()
    if ft == "manual_other":
        return (SECTION_OTHER, "other")
    m = _FT_SIMPLE_RE.match(ft)
    if m:
        return (_LEGACY_SIMPLE[m.group(1)], m.group(1))
    m = _FT_RE.match(ft)
    if not m:
        return None
    prefix, code = m.group(1), m.group(2)
    if prefix in _FUEL_LIKE_PREFIXES:
        return None
    if prefix not in (SECTION_OTHER, SECTION_TRAILER, SECTION_GENERAL,
                      SECTION_INSURANCE, SECTION_SALARY):
        return None
    # У `manual_salary_*` раздел уточняется по code: zus/pit4 и любые налоги,
    # которые компания завела в salary_tax, — это налоги, а не выплаты.
    return (prefix, code)


def section_of_salary_code(code: str, tax_codes: Iterable[str]) -> str:
    """Для `manual_salary_<code>`: налог это или прямая выплата."""
    return SECTION_SALARY_TAX if code in set(tax_codes) else SECTION_SALARY


def prettify_code(code: str) -> str:
    """Человекочитаемое имя для категории, найденной только в истории."""
    return code.replace("_", " ").strip().capitalize()


def slugify(name: str) -> str:
    """Имя → code. ASCII-транслитерация минимальная: всё, что не латиница и не
    цифра, превращается в `_`; если латиницы нет вовсе (например, «ФСЗН»),
    получается пустой код — вызывающий код обязан подставить fallback."""
    s = re.sub(r"[^a-z0-9]+", "_", (name or "").strip().lower())
    return s.strip("_")[:40]


_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya", "і": "i", "ї": "i", "є": "e", "ў": "u", "ґ": "g", "ć": "c", "č": "c",
    "š": "s", "ž": "z", "ł": "l", "ń": "n", "ó": "o", "ą": "a", "ę": "e", "ś": "s",
    "ż": "z", "ź": "z", "ä": "a", "ö": "o", "ü": "u", "ß": "ss", "å": "a", "æ": "ae",
    "ø": "o", "đ": "d", "ř": "r", "ě": "e", "ů": "u", "ý": "y", "á": "a", "é": "e",
    "í": "i", "ú": "u", "ô": "o", "ľ": "l", "ĺ": "l", "ť": "t", "ž": "z",
}


def transliterate(name: str) -> str:
    """Кириллица/диакритика → латиница. «ФСЗН» → «fszn», «Mýto» → «myto»."""
    out = []
    for ch in (name or "").strip().lower():
        if ch in _TRANSLIT:
            out.append(_TRANSLIT[ch])
        elif ch.isascii():
            out.append(ch)
        else:
            out.append(" ")
    return re.sub(r"[^a-z0-9]+", "_", "".join(out)).strip("_")


def code_for_name(name: str) -> str:
    """Устойчивый код категории из её названия.

    Транслитерация даёт читаемый код (`fszn`), а если латиницы всё равно нет
    (например, только иероглифы) — берётся sha256 от нормализованного имени.
    Хеш берётся из ОДНОЙ реализации (sha256), а не из `hash()`: встроенный
    `hash()` разный в разных процессах, поэтому после перезапуска сервера та же
    категория «ФСЗН» могла получить ДРУГОЙ код и разъехаться с историей.
    """
    base = transliterate(name)
    if base:
        return base[:40]
    import hashlib
    digest = hashlib.sha256((name or "").strip().lower().encode("utf-8")).hexdigest()[:10]
    return f"cat_{digest}"


def object_allowed(section: str, has_vehicle: bool, has_trailer: bool,
                   plate_is_vehicle: bool = False) -> bool:
    """Разрешён ли такой объект для раздела.

    Раньше это правило соблюдал только интерфейс (для «Общих расходов» он прятал
    выбор автомобиля), а API принимал что угодно — и общий расход с номером машины
    уезжал в карточку этой машины, хотя расход компании к ней не относится.

    Про прицепы: отдельной таблицы прицепов нет, и номер прицепа по всей системе
    передаётся в `plate_number` (так его читают карточки прицепов и
    extractTrailerPlates). Поэтому для раздела с областью «trailer» наличие
    номера — это норма, а не ошибка: важно лишь, чтобы туда не попал прицеп у
    автомобильного раздела.
    """
    scope = SECTION_OBJECT_SCOPE.get(section, "any")
    if scope == "company":
        return not has_vehicle and not has_trailer
    if scope == "vehicle":
        return not has_trailer
    if scope == "trailer":
        # Раздел прицепов: объект — ПРИЦЕП, а не машина.
        #
        # Номер прицепа по конвенции проекта приходит в `plate_number` (так его
        # читают карточки прицепов и extractTrailerPlates), поэтому наличие номера
        # само по себе не ошибка. Ошибка — привязка расхода прицепа к МАШИНЕ ПАРКА:
        # тогда расход уехал бы в карточку автомобиля и потерялся в отчёте по
        # прицепам. Отличить одно от другого можно только по справочнику машин,
        # поэтому нужен признак `plate_is_vehicle`.
        if has_trailer:
            return True
        return not (has_vehicle and plate_is_vehicle)
    return True


# ── Работа с БД ────────────────────────────────────────────────────────────
async def existing_index(db: AsyncSession, company_id: int) -> dict[tuple[str, str], ExpenseCategory]:
    """{(section, code): ExpenseCategory} по компании (включая неактивные)."""
    rows = (await db.execute(
        select(ExpenseCategory).where(ExpenseCategory.company_id == company_id)
    )).scalars().all()
    return {(c.section, c.code): c for c in rows}


async def ensure_seeded(db: AsyncSession, company_id: int) -> int:
    """Досоздать отсутствующие СИСТЕМНЫЕ категории компании. Идемпотентно.

    Возвращает число созданных строк (0, если всё уже на месте). Вызывается на
    чтении списка категорий и при создании расхода, чтобы компания, заведённая
    до этой доработки, получила готовый набор без ручных действий.
    """
    idx = await existing_index(db, company_id)
    created = 0
    for order, (section, code, name, icon, is_system) in enumerate(DEFAULT_CATEGORIES):
        if (section, code) in idx:
            continue
        db.add(ExpenseCategory(
            company_id=company_id,
            section=section,
            code=code,
            name=name,
            icon=icon,
            object_scope=SECTION_OBJECT_SCOPE.get(section, "any"),
            is_system=is_system,
            is_active=(section, code) not in INACTIVE_BY_DEFAULT,
            sort_order=order,
        ))
        created += 1
    if created:
        try:
            # Сохранение внутри savepoint: если параллельный запрос (страница
            # расходов и страница категорий открыты одновременно) успел создать
            # те же системные категории, уникальный индекс отклонит вставку.
            # Без savepoint это откатило бы ВСЮ транзакцию и первый запрос упал
            # бы с 500 у нового пользователя — то есть ровно там, где это
            # заметнее всего.
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            return 0
    return created


async def active_salary_tax_codes(db: AsyncSession, company_id: int) -> set[str]:
    """code налогов/взносов компании — нужны, чтобы отличить налог от выплаты."""
    rows = (await db.execute(
        select(ExpenseCategory.code).where(
            ExpenseCategory.company_id == company_id,
            ExpenseCategory.section == SECTION_SALARY_TAX,
        )
    )).all()
    return {r[0] for r in rows}


async def backfill_from_transactions(db: AsyncSession, company_id: int) -> int:
    """Завести категории для расходов, которые уже есть в истории, но категории
    ещё нет.

    Зачем: до этой доработки пользователь мог завести расход строкой
    `fuel_type`, которой нет в системном наборе (например, `manual_other_gps`).
    Без этого шага такой расход отображался бы в таблице, но «выпадал» из
    аналитики по категориям и не был доступен для выбора в форме.

    Вызывается один раз — при первой выдаче списка категорий компании.
    """
    idx = await existing_index(db, company_id)
    tax_codes = {code for (sec, code) in idx if sec == SECTION_SALARY_TAX}
    rows = (await db.execute(
        select(Transaction.fuel_type)
        .where(Transaction.company_id == company_id, Transaction.fuel_type.isnot(None))
        .distinct()
    )).all()

    created = 0
    for (ft,) in rows:
        parsed = parse_fuel_type(ft)
        if not parsed:
            continue
        section, code = parsed
        # Налоги и выплаты ходят в одном префиксе — раздел уточняем по коду.
        if section == SECTION_SALARY:
            section = section_of_salary_code(code, tax_codes)
        if (section, code) in idx:
            continue
        if (section, code) in NON_MANUAL_CODES:
            continue
        db.add(ExpenseCategory(
            company_id=company_id,
            section=section,
            code=code,
            name=prettify_code(code),
            icon="🏷️",
            object_scope=SECTION_OBJECT_SCOPE.get(section, "any"),
            is_system=False,
            is_active=True,
            sort_order=500 + created,
        ))
        idx[(section, code)] = True  # type: ignore[assignment]
        created += 1
    if created:
        await db.flush()
    return created


async def resolve_category(
    db: AsyncSession,
    company_id: int,
    section: str,
    code: str,
    name: Optional[str] = None,
    icon: Optional[str] = None,
    create: bool = True,
) -> Optional[ExpenseCategory]:
    """Найти категорию (section, code) или создать её.

    `is_active` НЕ учитывается: операцию можно записать в отключённую
    категорию (так проходят регулярные платежи по историческим категориям и
    так переносятся импорты), но в списках формы она не предлагается.
    """
    code = (code or "").strip().lower()
    if not section or not code:
        return None
    row = (await db.execute(
        select(ExpenseCategory).where(
            ExpenseCategory.company_id == company_id,
            ExpenseCategory.section == section,
            ExpenseCategory.code == code,
        )
    )).scalar_one_or_none()
    if row or not create:
        return row
    row = ExpenseCategory(
        company_id=company_id,
        section=section,
        code=code,
        name=(name or "").strip() or prettify_code(code),
        icon=icon or "🏷️",
        object_scope=SECTION_OBJECT_SCOPE.get(section, "any"),
        is_system=False,
        is_active=True,
        sort_order=900,
    )
    db.add(row)
    await db.flush()
    return row


def parse_legacy_category(category: Optional[str]) -> Optional[tuple[str, str]]:
    """Старый параметр `category` из формы («other_fine», «general_other»,
    «salary_zus», «insurance_casco», «trailer_cmr»…) → (section, code).

    Нужен для совместимости: существующий фронтенд и внешние вызовы API
    передают `category`, а не `section`+`category_code`.
    """
    if not category:
        return None
    cat = category.strip().lower()
    if cat in _FUEL_LIKE_PREFIXES or cat.startswith(("fuel_", "adblue_", "income_")):
        return None
    return parse_fuel_type(f"manual_{cat}")
