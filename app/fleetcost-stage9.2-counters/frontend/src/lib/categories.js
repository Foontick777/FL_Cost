/**
 * Динамические категории расходов: сеть, кеш и производные выборки.
 *
 * Зачем отдельный модуль. До этой доработки каждый экран знал «свой» закрытый
 * набор категорий, зашитый в разметку (штрафы/парковки/ремонты, аренда/CMR,
 * офис/бухгалтерия/стоянка, ZUS/PIT, польская/белорусская страховка). Из-за
 * этого продукт выглядел рассчитанным на одну страну и одну бизнес-модель.
 *
 * Теперь раздел (section) фиксирован — это область учёта, — а категории внутри
 * раздела приходят из API (`/api/expense-categories/`). Компания получает
 * готовый системный набор и может добавить любой свой.
 *
 * Кеш общий на всё приложение: список категорий запрашивается один раз, а
 * подписчики (экраны) обновляются, если категорию создали/переименовали/
 * отключили. Без этого после «+ Создать категорию» в одном месте форма на
 * другом экране не увидела бы новую категорию до перезагрузки.
 */
import { useEffect, useState } from "react";
import { apiFetch, apiGet } from "./api.js";

// Разделы: порядок и подписи. Иконки — только для заголовков разделов, у самых
// категорий иконка своя (её задаёт компания или системный набор).
export const SECTION_ORDER = ["other", "trailer", "general", "salary", "salary_tax", "insurance", "leasing", ];

export const SECTION_META = {
  other:      { icon: "💼", scope: "vehicle", ru: "Иные расходы",      en: "Other expenses" },
  trailer:    { icon: "🚛", scope: "trailer", ru: "Прицепы",           en: "Trailers" },
  general:    { icon: "🏢", scope: "company", ru: "Общие расходы",     en: "General expenses" },
  salary:     { icon: "👤", scope: "vehicle", ru: "Зарплата",          en: "Salary" },
  salary_tax: { icon: "🏛️", scope: "company", ru: "Налоги и взносы",   en: "Taxes & contributions" },
  // scope = "any": на бэкенде SECTION_OBJECT_SCOPE["insurance"] = "any". Пока
  // здесь стояло "vehicle", интерфейс и сервер говорили разное, и правила
  // приходилось держать в голове. Полис может быть и на машину, и на прицеп,
  // и на компанию (страхование сотрудников) — это один и тот же объект полиса.
  insurance:  { icon: "🛡️", scope: "any",     ru: "Страхование",       en: "Insurance" },
  // scope = "vehicle": раздел «Лизинг» — только автомобили; лизинг прицепа ведётся
  // в разделе «Прицепы» (на бэкенде SECTION_OBJECT_SCOPE["leasing"] = "vehicle"). Ключи подписи — ru/en,
  // как у остальных разделов: с labelRu/labelEn sectionLabel() возвращал undefined.
  leasing:    { icon: "📄", scope: "vehicle", ru: "Лизинг",           en: "Leasing" },
};

// ── Объект расхода (к чему относится расход) ────────────────────────────────
//
// `SECTION_META[section].scope` — это ОПИСАНИЕ допустимых объектов ("company",
// "vehicle", "trailer", "any"), а не значение поля. Пока значение "any" попадало
// в состояние формы, список объектов не совпадал ни с одним вариантом: на
// «Лизинге» вообще нельзя было выбрать автомобиль, а расход молча уходил на
// компанию. Поэтому решения вынесены в функции с проверками
// (scripts/check-behaviour.mjs).
const SCOPE_VEHICLE   = { id: "vehicle", ru: "Автомобиль", en: "Vehicle" };
const SCOPE_TRAILER   = { id: "trailer", ru: "Прицеп", en: "Trailer" };
const SCOPE_COMPANY_ANYPREFIX = { id: "company", ru: "Компания (без привязки)", en: "Company (unassigned)" };
const SCOPE_COMPANY   = { id: "company", ru: "Компания", en: "Company" };
const SCOPE_COMPANY_AUTO = { id: "company", ru: "Без привязки к авто", en: "Unassigned" };

export const sectionScope = (section) => (SECTION_META[section] || {}).scope || "company";

/**
 * Какие объекты расхода допустимы в разделе.
 *
 * `allowedScopes` сужает список для конкретной вкладки: договор лизинга
 * заключается на машину, поэтому на вкладке «Лизинг» прицеп предлагать не нужно
 * (прицепы ведут в своём разделе). Пустой список игнорируется — форма без
 * вариантов хуже, чем форма с лишним вариантом.
 */
export function scopeOptionsFor(section, allowedScopes = null) {
  let all;
  if (section === "trailer") all = [SCOPE_TRAILER, SCOPE_COMPANY_ANYPREFIX];
  else if (section === "general" || section === "salary_tax") all = [SCOPE_COMPANY];
  else if (sectionScope(section) === "any") {
    // Лизинг и страхование: договор бывает на тягач, на прицеп и на компанию.
    all = [SCOPE_VEHICLE, SCOPE_TRAILER, SCOPE_COMPANY_ANYPREFIX];
  } else all = [SCOPE_VEHICLE, SCOPE_COMPANY_AUTO];

  if (!allowedScopes || !allowedScopes.length) return all;
  const allow = new Set(allowedScopes);
  const filtered = all.filter((o) => allow.has(o.id));
  return filtered.length ? filtered : all;
}

/** Начальный объект расхода. НИКОГДА не "any" — и всегда входит в варианты. */
export function initialScopeFor(section, { fixedPlate = null, fixedTrailer = null,
                                         defaultScope = null, allowedScopes = null } = {}) {
  const ids = scopeOptionsFor(section, allowedScopes).map((o) => o.id);
  const metaScope = sectionScope(section);
  const wanted = fixedTrailer ? "trailer" : fixedPlate ? "vehicle"
    : (defaultScope && defaultScope !== "any"
        ? defaultScope
        : (metaScope === "any" ? "vehicle" : metaScope));
  return ids.includes(wanted) ? wanted : ids[0];
}

export const sectionLabel = (section, lang) => {
  const m = SECTION_META[section];
  if (!m) return section || "";
  return lang === "RU" ? m.ru : m.en;
};

/**
 * Префикс fuel_type раздела. Единственное исключение — налоги: они живут в
 * `manual_salary_*`, как и исторические ZUS/PIT, иначе старые строки
 * «оторвались» бы от своих категорий. Та же логика на бэкенде
 * (app/services/category_service.py).
 */
export const sectionPrefix = (section) => (section === "salary_tax" ? "salary" : section);

export const fuelTypeFor = (section, code) => `manual_${sectionPrefix(section)}_${code}`;

/** `manual_other_fine` → { section:"other", code:"fine" }. null — если не категория. */
export function parseFuelType(fuelType) {
  const ft = (fuelType || "").trim().toLowerCase();
  if (!ft.startsWith("manual_")) return null;
  if (ft === "manual_other") return { section: "other", code: "other" };
  const simple = /^manual_(fine|parking|repair)$/.exec(ft);
  if (simple) return { section: "other", code: simple[1] };
  const m = /^manual_([a-z_]+?)_(.+)$/.exec(ft);
  if (!m) return null;
  const [, prefix, code] = m;
  if (["fuel", "adblue", "income"].includes(prefix)) return null;
  // «leasing» добавлен: без него строки вида manual_leasing_leasing (они есть
  // у договоров, созданных до появления category_id) не распознавались вовсе.
  if (!["other", "trailer", "general", "insurance", "salary", "leasing"].includes(prefix)) return null;
  return { section: prefix, code };
}

/** Код налога/выплаты из fuel_type: `manual_salary_zus` → `zus`. */
export function salaryCodeOf(fuelType) {
  const m = /^manual_salary_(.+)$/.exec(fuelType || "");
  return m ? m[1] : null;
}

// Коды, которые считались налогами до этой доработки. Нужны как страховка:
// если список категорий ещё не загрузился, экран не должен внезапно посчитать
// ZUS зарплатой водителя.
export const LEGACY_TAX_CODES = ["zus", "pit4"];

// ── Хранилище ────────────────────────────────────────────────────────────
// { list, byKey: {"section:code": cat}, byFuel: {"manual_...": cat}, loadedAt }
let _state = { list: null, byKey: {}, byFuel: {}, loadedAt: 0, loading: false };
const _listeners = new Set();

function _index(list) {
  const byKey = {}, byFuel = {};
  (list || []).forEach((c) => {
    byKey[`${c.section}:${c.code}`] = c;
    byFuel[fuelTypeFor(c.section, c.code)] = c;
  });
  return { list: list || [], byKey, byFuel, loadedAt: Date.now(), loading: false };
}

function _emit(next) {
  _state = next;
  _listeners.forEach((fn) => { try { fn(_state); } catch (e) {} });
}

export function subscribeCategories(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function getCategoryState() { return _state; }

/** Загрузить категории (по умолчанию — из кеша, если он свежее минуты). */
export async function loadCategories({ force = false, maxAgeMs = 60000 } = {}) {
  if (!force && _state.list && Date.now() - _state.loadedAt < maxAgeMs) return _state;
  if (_state.loading) return _state;
  _emit({ ..._state, loading: true });
  const data = await apiGet("/expense-categories/?include_inactive=true");
  if (Array.isArray(data)) {
    _emit(_index(data));
  } else {
    // Бэкенд недоступен — не подменяем данные пустым списком молча: экраны
    // покажут пустой выбор, но кеш останется прежним, а тост уже сообщит об ошибке.
    _emit({ ..._state, loading: false });
  }
  return _state;
}

/**
 * Хук: подписка на список категорий с авто-загрузкой.
 * Возвращает {list, byKey, byFuel, loading, reload}.
 */
/** Раздел операции — единственный источник истины для ручных и регулярных строк.

    Почему не по `fuel_type`. Название категории придумывает пользователь, и она
    попадает в fuel_type: категория «Налоги» в разделе «Налоги и взносы» и
    выплата «Ежемесячная» дают похожие строки, а подстрока в названии («toll»,
    «adblue») вообще уводит расход в чужой раздел. Поэтому сначала спрашиваем
    справочник: `category_id → section`. Если у старой строки ссылки нет — тогда
    и только тогда разбираем fuel_type и уточняем налог по списку кодов.
    */
export function sectionOf(state, tx){
  if(!tx) return null;
  const cat=categoryOfTransaction(state, tx);
  if(cat&&cat.section) return cat.section;
  const parsed=parseFuelType(tx.fuel_type);
  if(!parsed) return null;
  if(parsed.section==="salary"&&taxCodesOf(state).has(parsed.code)) return "salary_tax";
  return parsed.section;
}

export function useCategories() {
  const [state, setState] = useState(_state);
  useEffect(() => {
    const unsub = subscribeCategories(setState);
    loadCategories();
    return unsub;
  }, []);
  return {
    list: state.list,
    byKey: state.byKey,
    byFuel: state.byFuel,
    loading: state.loading,
    reload: (opts) => loadCategories({ force: true, ...(opts || {}) }),
  };
}

// ── Мутации ──────────────────────────────────────────────────────────────
export async function createCategory({ section, name, code = null, icon = null, color = null, objectScope = null }) {
  const res = await apiFetch("/expense-categories/", {
    method: "POST",
    body: JSON.stringify({ section, name, code, icon, color, object_scope: objectScope }),
  });
  let data = null;
  try { data = await res.clone().json(); } catch (e) {}
  if (!res.ok) return { ok: false, error: (data && data.detail) || `HTTP ${res.status}` };
  await loadCategories({ force: true });
  return { ok: true, category: data };
}

export async function patchCategory(id, patch) {
  const res = await apiFetch(`/expense-categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  let data = null;
  try { data = await res.clone().json(); } catch (e) {}
  if (!res.ok) return { ok: false, error: (data && data.detail) || `HTTP ${res.status}` };
  await loadCategories({ force: true });
  return { ok: true, category: data };
}

export async function deleteCategory(id) {
  const res = await apiFetch(`/expense-categories/${id}`, { method: "DELETE" });
  let data = null;
  try { data = await res.clone().json(); } catch (e) {}
  if (!res.ok) return { ok: false, error: (data && data.detail) || `HTTP ${res.status}` };
  await loadCategories({ force: true });
  return { ok: true };
}

// ── Производные выборки ──────────────────────────────────────────────────
/** Категории раздела. Системные первыми, затем по имени (§12 п.7). */
export function categoriesForSection(state, section, { includeInactive = false } = {}) {
  const list = (state && state.list) || [];
  return list
    .filter((c) => c.section === section && (includeInactive || c.is_active))
    .sort((a, b) => {
      if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return (a.name || "").localeCompare(b.name || "");
    });
}

/** Категория по fuel_type операции — так в таблицах показывается её имя/иконка. */
export function categoryOfTransaction(state, tx) {
  if (!tx) return null;
  if (tx.category_id && state && state.list) {
    const byId = state.list.find((c) => c.id === tx.category_id);
    if (byId) return byId;
  }
  const parsed = parseFuelType(tx.fuel_type);
  if (!parsed) return null;
  return (state && state.byFuel && state.byFuel[fuelTypeFor(parsed.section, parsed.code)]) || null;
}

/** Имя категории для строки таблицы: категория → иначе «хвост» fuel_type. */
export function categoryLabel(state, tx, lang) {
  const cat = categoryOfTransaction(state, tx);
  if (cat) return cat.name;
  const ft = tx && tx.fuel_type;
  if (!ft) return "—";
  // Для импортированных извне строк (e100, Q8) fuel_type — это фактическое
  // описание услуги, его и показываем.
  if (!String(ft).startsWith("manual_")) return ft;
  const parsed = parseFuelType(ft);
  return parsed ? parsed.code.replace(/_/g, " ") : String(ft).replace(/^manual_/, "").replace(/_/g, " ");
}

/** Набор кодов налогов компании (раздел salary_tax). Нужен, чтобы отличить
 *  налог от прямой выплаты: у них общий префикс fuel_type. */
export function taxCodesOf(state) {
  const codes = categoriesForSection(state, "salary_tax", { includeInactive: true }).map((c) => c.code);
  return codes.length ? codes : LEGACY_TAX_CODES;
}

/** Является ли операция налогом/взносом, а не выплатой водителю. */
export function isTaxForState(state, tx) {
  const code = salaryCodeOf(tx && tx.fuel_type);
  if (code === null) return false;
  return taxCodesOf(state).includes(code);
}
