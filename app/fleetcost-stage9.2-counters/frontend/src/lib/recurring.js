/**
 * Регулярные платежи: сеть и производные значения.
 *
 * Раньше каждый экран сам решал, что показать в блоке регулярных платежей, и
 * договоры жили в четырёх разных сущностях (офис/бухгалтерия/стоянка, аренда
 * прицепа, страховка, лизинг). Теперь договор один — регулярный расход, — а
 * этот модуль даёт общий ответ на три вопроса: как его создать, как показать и
 * что с ним можно сделать (остановить, продолжить, удалить).
 *
 * Остаток и «оплачено N из M» НЕ считаются здесь: их считает сервер
 * (`remaining_periods`, `remaining_amount`, `paid_periods`). Если бы каждый экран
 * выводил остаток сам, страховка и прицепы показывали бы по одному договору
 * разные суммы.
 */
import { apiFetch, apiGet } from "./api.js";

/** Периодичность. `per` — как писать «в месяц / в квартал» в карточке. */
export const FREQUENCIES = [
  { id: "monthly",   ru: "Ежемесячно",   en: "Monthly",   perRu: "в месяц",   perEn: "per month",   months: 1 },
  { id: "quarterly", ru: "Ежеквартально", en: "Quarterly", perRu: "в квартал", perEn: "per quarter", months: 3 },
  { id: "yearly",    ru: "Ежегодно",     en: "Yearly",     perRu: "в год",     perEn: "per year",    months: 12 },
  { id: "weekly",    ru: "Еженедельно",  en: "Weekly",     perRu: "в неделю",  perEn: "per week",    months: 0.25 },
];

export function frequency(id) {
  return FREQUENCIES.find((f) => f.id === id) || FREQUENCIES[0];
}

/** Как задана сумма: за период, за год или всего за весь срок. */
export const AMOUNT_MODES = [
  { id: "period", ru: "За период", en: "Per period" },
  { id: "yearly", ru: "За год", en: "Per year" },
  { id: "total",  ru: "Всего за весь срок", en: "Total for the term" },
];

export const STATUS_LABELS = {
  active:    { ru: "Активен",  en: "Active",    tone: "ok" },
  upcoming:  { ru: "Скоро",    en: "Upcoming",  tone: "info" },
  paused:    { ru: "На паузе", en: "Paused",    tone: "warn" },
  completed: { ru: "Завершён", en: "Completed", tone: "muted" },
};

export function statusLabel(status, lang) {
  const meta = STATUS_LABELS[status] || STATUS_LABELS.active;
  return lang === "RU" ? meta.ru : meta.en;
}

/** «Текущие» на экране — идущие и приостановленные: пауза не завершение. */
export function isCurrent(payment) {
  return payment.display_status === "active" || payment.display_status === "paused";
}

// ── Сеть ────────────────────────────────────────────────────────────────
export async function fetchRecurring({ section, status, activeOnly } = {}) {
  const q = new URLSearchParams();
  if (section) q.set("section", section);
  if (status) q.set("status", status);
  if (activeOnly) q.set("active_only", "true");
  const qs = q.toString();
  const res = await apiGet(`/recurring-expenses/${qs ? `?${qs}` : ""}`);
  return Array.isArray(res) ? res : [];
}

export async function syncRecurring() {
  const r = await apiFetch("/recurring-expenses/sync", { method: "POST" });
  const data = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, ...data } : { ok: false, error: data?.detail || `HTTP ${r.status}` };
}

export async function createRecurring(payload) {
  const r = await apiFetch("/recurring-expenses/", {
    method: "POST", body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, contract: data };
  const detail = data?.detail;
  return { ok: false, error: Array.isArray(detail) ? detail.map((d) => d.msg).join("; ") : (detail || `HTTP ${r.status}`) };
}

/** «Остановить» — следующих списаний не будет; история и прогресс остаются. */
export async function pauseRecurring(id) {
  return _patch(`/recurring-expenses/${id}/pause`);
}

/** «Продолжить» — списания возобновляются; за время паузы задним числом не списываем. */
export async function resumeRecurring(id) {
  return _patch(`/recurring-expenses/${id}/resume`);
}

async function _patch(url) {
  const r = await apiFetch(url, { method: "PATCH" });
  const data = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, contract: data } : { ok: false, error: data?.detail || `HTTP ${r.status}` };
}

export async function deleteRecurring(id) {
  const r = await apiFetch(`/recurring-expenses/${id}`, { method: "DELETE" });
  if (r.ok) return { ok: true };
  const data = await r.json().catch(() => ({}));
  return { ok: false, error: data?.detail || `HTTP ${r.status}` };
}

// ── Производные значения для карточки ──────────────────────────────────
/** Сумма месячных списаний по активным договорам — для итога блока. */
/**
 * Итог «в месяц» — ОТДЕЛЬНО ПО КАЖДОЙ ВАЛЮТЕ.
 *
 * Раньше суммы складывались в одно число: 1 000 EUR + 4 000 PLN + 500 USD давали
 * «5 500», и подпись рядом с этим числом выбиралась одна из трёх. Для финансового
 * интерфейса это прямая ложь: валюты нельзя складывать без курса. Показываем
 * честно: «2 000 EUR/мес · 333 PLN/мес». Пересчёт в EUR требует курса на дату и
 * появится отдельно — выдумывать его здесь нельзя.
 */
export function monthlyByCurrency(payments) {
  const map = new Map();
  payments
    .filter((p) => p.display_status === "active" || p.display_status === "upcoming")
    .forEach((p) => {
      const cur = (p.currency || "EUR").toUpperCase();
      map.set(cur, (map.get(cur) || 0) + (p.monthly_amount || 0));
    });
  return Array.from(map.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/** Совместимость: одна валюта в списке — одно число, иначе null (итог не определён). */
export function monthlyTotal(payments) {
  const by = monthlyByCurrency(payments);
  if (by.length === 0) return 0;
  if (by.length === 1) return by[0].amount;
  return null;
}

/** Ближайшая дата списания среди активных договоров. */
export function nearestChargeDate(payments) {
  const dates = payments
    .filter((p) => p.display_status === "active" && p.next_charge_date)
    .map((p) => p.next_charge_date)
    .sort();
  return dates[0] || null;
}

/** Человеческое «Списание 5-го числа». */
export function chargeDayLabel(day, lang) {
  if (!day) return "";
  return lang === "RU" ? `Списание ${day}-го числа` : `Charged on the ${day}${_ordinal(day)}`;
}

function _ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Сколько осталось — «6 мес · 11 250,00 EUR».
 *
 * Показываем и срок, и деньги: по одному сроку нельзя понять, сколько ещё
 * предстоит заплатить, а по одной сумме — как долго это будет длиться. Именно
 * этой пары не хватало в блоке регулярных платежей.
 */
export function remainingLabel(payment, lang) {
  const periods = payment.remaining_periods;
  if (periods === null || periods === undefined) {
    return lang === "RU" ? "Бессрочно" : "No end date";
  }
  if (periods <= 0) return lang === "RU" ? "Выполнено" : "Completed";
  const freq = frequency(payment.frequency);
  const unit = lang === "RU" ? _periodWord(freq.id, periods) : `${periods} ${_periodWordEn(freq.id, periods)}`;
  const amount = (payment.remaining_amount || 0).toLocaleString(lang === "RU" ? "ru-RU" : "en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${unit} · ${amount} ${payment.currency}`;
}

/** Слово периода с числом: «12 месяцев» / «12 months» — для «Оплачено N из M» в карточках. */
export function periodWord(freqId, n, lang) {
  return lang === "RU" ? _periodWord(freqId, n) : `${n} ${_periodWordEn(freqId, n)}`;
}

function _periodWord(freqId, n) {
  const forms = {
    monthly: ["месяц", "месяца", "месяцев"],
    quarterly: ["квартал", "квартала", "кварталов"],
    yearly: ["год", "года", "лет"],
    weekly: ["неделя", "недели", "недель"],
  };
  const [a, b, c] = forms[freqId] || forms.monthly;
  const n10 = n % 10, n100 = n % 100;
  const word = n10 === 1 && n100 !== 11 ? a : (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20) ? b : c);
  return `${n} ${word}`;
}

function _periodWordEn(freqId, n) {
  const word = { monthly: "month", quarterly: "quarter", yearly: "year", weekly: "week" }[freqId] || "month";
  return n === 1 ? word : `${word}s`;
}

export function progressPct(payment) {
  if (!payment.total_periods) return null;
  return Math.round(((payment.paid_periods || 0) / payment.total_periods) * 100);
}

export function fmtDay(iso, lang) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return lang === "RU" ? `${d}.${m}.${y}` : `${y}-${m}-${d}`;
}

export function fmtMoney(value, currency, lang) {
  const n = Number(value || 0);
  return `${n.toLocaleString(lang === "RU" ? "ru-RU" : "en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || "EUR"}`;
}


/**
 * Регулярный расход → форма «договора» для существующих экранов.
 *
 * Зачем. Страницы (лизинг, прицепы, страховка, общие) исторически рисуют договоры
 * из старых сущностей: LeasingContract, TrailerContract, InsuranceContract,
 * RecurringContract. Новый механизм — единственный источник для НОВЫХ договоров,
 * но переписывать разметку всех карточек сразу рискованно. Поэтому приводим
 * регулярный расход к тому же виду и показываем вместе: так экран перестаёт
 * противоречить сам себе («в блоке платежей договор есть, а в KPI его нет»),
 * а старые договоры остаются на месте.
 */
/**
 * Адреса действий для карточки договора из ЕДИНОГО списка.
 *
 * В списке лежат и старые договоры (свои таблицы), и новые — регулярные расходы.
 * Id живут в РАЗНЫХ пространствах, а кнопки на страницах всегда били в старый
 * ресурс: у нового договора удаление уходило в `/leasing-contracts/{id}` и не
 * срабатывало (404) — «удалить нельзя». Хуже: при совпадении id оно могло удалить
 * ЧУЖОЙ старый договор. Поэтому адрес выбирается по пометке источника, которую
 * ставит toContractShape.
 */
export function contractEndpoints(contract, legacyBase) {
  const isRecurring = Boolean(contract && contract._source === "recurring");
  const base = isRecurring ? "/recurring-expenses" : `/${legacyBase}`;
  const id = contract ? contract.id : null;
  return {
    isRecurring,
    cancel: `${base}/${id}/cancel`,
    remove: `${base}/${id}`,
  };
}

export function toContractShape(r) {
  const periods = r.total_periods || null;
  const monthly = r.monthly_amount != null ? r.monthly_amount : r.amount;
  const total = r.input_amount != null && r.amount_mode !== "period"
    ? r.input_amount
    : (periods && r.amount != null ? r.amount * periods : null);
  return {
    // Идентификация: id из другого пространства — помечаем источником, чтобы
    // правки/удаление шли в правильный ресурс.
    id: r.id,
    _source: "recurring",
    _recurring: r,
    plate_number: r.plate_number || r.trailer_plate || null,
    vehicle_id: r.vehicle_id || null,
    category: r.code || null,
    description: r.description || null,
    start_date: r.start_date || null,
    end_date: r.end_date || null,
    term_months: periods,
    day_of_month: r.day_of_month || 1,
    monthly_amount: monthly,
    total_amount: total,
    is_active: (r.display_status || "active") === "active"
      || (r.display_status || "") === "upcoming",
    display_status: r.display_status,
    paid_periods: r.paid_periods || 0,
    total_periods: periods,
    remaining_amount: r.remaining_total_obligation != null
      ? r.remaining_total_obligation : r.remaining_amount,
    // Остаток в EUR — посчитан сервером по курсу на сегодня. Раньше фронтенд
    // делил сам на устаревший захардкоженный курс (дефект аудита stage9.1).
    remaining_amount_eur: r.remaining_amount_eur != null ? r.remaining_amount_eur : null,
    currency: r.currency,
  };
}


/**
 * Сколько списаний «уже наступило» к дате `todayIso` — зеркало iter_charge_dates
 * на сервере (день списания, не раньше даты начала, не позже даты окончания,
 * не больше числа платежей). Нужно для предупреждения «будет создано N списаний».
 * Даты — строки YYYY-MM-DD, сравниваются как строки.
 */
export function countPastCharges({ startIso, todayIso, periodicity, day, endIso, maxCount }) {
  if (!startIso || !todayIso || startIso > todayIso) return 0;
  const pad2 = (n) => String(n).padStart(2, "0");
  let count = 0;
  const limit = maxCount > 0 ? maxCount : 1200;
  if (periodicity === "weekly") {
    let cur = new Date(startIso + "T00:00:00Z");
    for (;;) {
      const iso = cur.toISOString().slice(0, 10);
      if (iso > todayIso || (endIso && iso > endIso) || count >= limit) break;
      count += 1;
      cur = new Date(cur.getTime() + 7 * 86400000);
    }
    return count;
  }
  const dom = day >= 1 && day <= 28 ? day : 1;
  const step = periodicity === "yearly" ? 12 : periodicity === "quarterly" ? 3 : 1;
  const sy = Number(startIso.slice(0, 4));
  const sm = Number(startIso.slice(5, 7)) - 1;
  for (let i = 0; i < 1200 && count < limit; i += 1) {
    const total = sy * 12 + sm + i * step;
    const iso = `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}-${pad2(dom)}`;
    if (iso > todayIso || (endIso && iso > endIso)) break;
    if (iso >= startIso) count += 1;
  }
  return count;
}
