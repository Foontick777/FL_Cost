/**
 * Универсальная форма «Добавить расход» — одна на все разделы.
 *
 * Раньше у каждой вкладки была своя форма со своим закрытым набором категорий:
 * на «Иных расходах» — штраф/парковка/ремонт/прочее, у прицепов — аренда/CMR,
 * в «Общих» — офис/бухгалтерия/стоянка, у страховки — польская/КАСКО/
 * белорусская, а налоги были только ZUS/PIT. Теперь форма одна, а различия —
 * это объект расхода и список категорий раздела.
 *
 * Ключевое здесь — ТИП (разовый / регулярный) и то, КАК задана сумма.
 * В договорах не пишут «1 875 в месяц»: пишут «90 000 всего за 48 месяцев» или
 * «10 000 разово и 90 000 за 48 месяцев». Заставлять пользователя делить в уме —
 * это прямые ошибки в данных, поэтому сумма вводится так, как написано в
 * договоре, а сумма одного списания считается сама.
 *
 * Считаем и на клиенте, и на сервере. На клиенте — чтобы человек видел
 * «≈ 1 875,00 EUR в месяц» ДО сохранения; на сервере — потому что сервер
 * источник истины, и расчёт при сохранении повторяется. Формула одна и та же,
 * и её изменение потребует правки в обоих местах (см. plan_schedule в
 * backend/app/services/recurring_expense_service.py).
 */
import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal.jsx";
import { s } from "./styles.js";
import { CategorySelect } from "./CategorySelect.jsx";
import { apiFetch, reportUiError } from "../lib/api.js";
import { useCurrencyList } from "../lib/currencies.js";
import { sectionLabel, SECTION_META, useCategories, initialScopeFor, scopeOptionsFor } from "../lib/categories.js";
import { AMOUNT_MODES, FREQUENCIES, fmtMoney, countPastCharges } from "../lib/recurring.js";

// FX-01 (аудит stage8): список валют больше не захардкожен — он приходит
// с бэкенда (/fx-rates/form-currencies) и кэшируется. Раньше здесь стояло
// 13 валют без CHF/RSD/MDL/GEL, из-за чего операции в этих валютах
// нельзя было внести вручную.

// Недавно использованные номера прицепов: вводятся руками, и каждый раз печатать
// один и тот же номер заново — главная неудобность формы. Хранится только в
// браузере (подсказка, не данные): без localStorage форма работает как прежде.
const RECENT_TRAILERS_KEY = "fc_recent_trailers";
function readRecentTrailers() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_TRAILERS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x).slice(0, 15) : [];
  } catch (e) { return []; }
}
function rememberTrailer(plate) {
  const p = String(plate || "").toUpperCase().replace(/[\s\-_.]+/g, "");
  if (!p) return;
  try {
    const next = [p, ...readRecentTrailers().filter((x) => x !== p)].slice(0, 15);
    localStorage.setItem(RECENT_TRAILERS_KEY, JSON.stringify(next));
  } catch (e) { /* приватный режим — не критично */ }
}

const PERIODS_PER_YEAR = { monthly: 12, quarterly: 4, yearly: 1, weekly: 52 };

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * @param section       раздел учёта (other | trailer | general | salary | salary_tax | insurance)
 * @param catState      состояние списка категорий (из useCategories)
 * @param vehicles      справочник автомобилей [{id, plate_number, driver_name}]
 * @param defaultScope  "vehicle" | "trailer" | "company"
 * @param fixedPlate    номер, который нельзя менять (форма открыта из карточки)
 * @param fixedTrailer  номер прицепа, который нельзя менять
 * @param initialType   "oneoff" | "recurring" — каким открыть форму
 * @param onSaved       вызывается после успешного сохранения (обновить данные)
 */
export function ExpenseFormModal({
  onClose,
  initial = null,
  section,
  catState: catStateProp,
  vehicles = [],
  lang = "RU",
  defaultScope,
  fixedPlate,
  fixedTrailer,
  // Какие объекты расхода предлагать на этой вкладке, например ["vehicle"] для
  // лизинга. Пусто/не задано — все допустимые для раздела.
  allowedScopes,
  defaultCategory,
  initialType = "oneoff",
  onSaved,
  titleOverride,
}) {
  // Категории берём сами, если их не передали: без этого форма падала белым
  // экраном, когда её открывали не со страницы с уже загруженным справочником
  // (блок регулярных платежей, страница лизинга). Подробнее — в CategorySelect.
  const catStateOwn = useCategories();

  const ru = lang === "RU";
  const meta = SECTION_META[section] || {};
  // FX-01 (аудит stage8): динамический список валют с бэкенда (кэш в localStorage).
  const CURRENCIES = useCurrencyList();
  // Объект расхода: допустимые значения и начальное значение считает
  // lib/categories.js (scopeOptionsFor / initialScopeFor). Раньше здесь стояло
  // `defaultScope || meta.scope || "company"`, и для лизинга/страхования в форме
  // оказывалось значение "any" — селект пустовал, автомобиль выбрать было нельзя.
  const initialScope = initialScopeFor(section, { fixedPlate, fixedTrailer, defaultScope, allowedScopes });

  const [form, setForm] = useState({
    expense_date: iso(new Date()),
    category_code: defaultCategory || "",
    scope: initialScope,
    plate_number: fixedPlate || "",
    trailer_plate: fixedTrailer || (initialScope === "trailer" ? (readRecentTrailers()[0] || "") : ""),
    description: "",
    amount: "",
    currency: "EUR",
    type: initialType,
    periodicity: "monthly",
    amount_mode: "period",
    total_periods: "",
    down_payment: "",
    charge_day: "",
    end_date: "",
    comment: "",
    document_ref: "",
    // Полисные атрибуты — только для раздела «Страхование».
    country: "",
    policy_number: "",
    insurer: "",
  });

  // Редактирование существующего договора: поля заполняются тем, что в нём уже
  // есть. Сумма показывается так, как её вводил пользователь (за период / за год
  // / всего за срок) — иначе при открытии «18 000 за 12 платежей» он увидел бы
  // «1 500» и решил, что сумма потерялась.
  const initialForm = initial ? {
    type: "recurring",
    scope: initial.trailer_plate ? "trailer" : (initial.plate_number ? "vehicle" : "company"),
    plate_number: initial.plate_number || "",
    trailer_plate: initial.trailer_plate || "",
    category_code: initial.code || "",
    category_id: initial.category_id || null,
    // YYYY-MM-DD по местному времени (sv-SE даёт именно такой формат).
    // Раньше здесь стоял необъявленный todayStr — форма падала с ReferenceError,
    // если дата начала пустая.
    expense_date: initial.start_date || new Date().toLocaleDateString("sv-SE"),
    amount: String((initial.amount_mode && initial.amount_mode !== "period")
      ? (initial.input_amount ?? initial.amount ?? "")
      : (initial.amount ?? "")),
    amount_mode: initial.amount_mode || "period",
    total_periods: initial.total_periods ? String(initial.total_periods) : "",
    down_payment: initial.down_payment ? String(initial.down_payment) : "",
    currency: initial.currency || "EUR",
    periodicity: initial.frequency || "monthly",
    end_date: initial.end_date || "",
    charge_day: initial.day_of_month ? String(initial.day_of_month) : "",
    description: initial.description || "",
    comment: initial.comment || "",
    document_ref: initial.document_ref || "",
    country: initial.country || "",
    policy_number: initial.policy_number || "",
    insurer: initial.insurer || "",
  } : null;

  const [busy, setBusy] = useState(false);

  // Подставляем значения договора один раз, при открытии формы.
  useEffect(() => {
    if (initialForm) setForm((f) => ({ ...f, ...initialForm }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial ? initial.id : null]);
  const [error, setError] = useState("");

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Объект расхода: у «Общих расходов» и налогов — компания (привязка к
  // автомобилю бессмысленна), у прицепов — прицеп, у остальных — автомобиль.
  const scopeLocked = Boolean(fixedPlate || fixedTrailer) || section === "general" || section === "salary_tax";
  // Зависимость — строка, а не массив: массив в пропе создаёт новую ссылку на
  // каждом рендере, и useMemo пересчитывался бы постоянно.
  const allowedKey = (allowedScopes || []).join("|");
  const scopeOptions = useMemo(() => scopeOptionsFor(section, allowedScopes),
                                [section, allowedKey]);

  useEffect(() => {
    // Область применения обязана быть одним из предложенных вариантов. Раньше
    // здесь было жёсткое «company для общих расходов и налогов», и значение "any"
    // (описание раздела) оставалось в форме как есть — селект пустовал, а расход
    // уходил на компанию даже при выбранном автомобиле.
    if (!scopeOptions.some((o) => o.id === form.scope)) {
      set({ scope: scopeOptions[0].id });
    }
  }, [scopeOptions]);

  const isRecurring = form.type === "recurring";
  const dayFromDate = Math.max(1, Math.min(28, Number((form.expense_date || "").slice(8, 10)) || 1));
  // День списания: по умолчанию — день выбранной даты, но его можно задать явно.
  const chargeDay = Number(form.charge_day) || dayFromDate;

  /**
   * Сколько получится за одно списание — тот же расчёт, что делает сервер.
   *
   * Разовый взнос НЕ вычитается из общей суммы: в лизинге он идёт сверху
   * («10 000 сейчас + 90 000 за 48 месяцев»), и вычитание испортило бы расчёт.
   */
  const preview = useMemo(() => {
    if (!isRecurring) return null;
    const value = Number(form.amount);
    if (!value || value <= 0) return null;
    const perYear = PERIODS_PER_YEAR[form.periodicity] || 12;
    let per = value;
    let periods = null;
    if (form.amount_mode === "yearly") {
      per = value / perYear;
    } else if (form.amount_mode === "total") {
      periods = Number(form.total_periods);
      if (!periods || periods < 1) return null;
      per = value / periods;
    }
    // Итого по договору: регулярная часть + разовый взнос. Для «за период» и
    // «за год» общая сумма зависит от числа платежей, поэтому считается только
    // когда график известен (есть «Платить до» или число платежей).
    const down = Number(form.down_payment) || 0;
    let contractTotal = null;
    if (periods) {
      contractTotal = per * periods + down;
    } else if (form.amount_mode === "period" && form.end_date) {
      // Число платежей по графику — зеркало iter_charge_dates сервера
      // (countPastCharges от даты начала до даты окончания включительно).
      // Раньше здесь показывали ОДИН платёж + взнос: предпросмотр «всего по
      // договору» врал в разы меньше (дефект аудита stage9.1).
      const n = countPastCharges({
        startIso: form.expense_date, todayIso: form.end_date,
        periodicity: form.periodicity, day: chargeDay,
        endIso: form.end_date,
      });
      contractTotal = n > 0 ? per * n + down : null;
    } else if (form.amount_mode === "yearly" && form.total_periods) {
      const n = Number(form.total_periods);
      if (n > 0) contractTotal = per * n + down;
    }
    return { per, periods, value, contractTotal };
  }, [isRecurring, form.amount, form.amount_mode, form.total_periods, form.periodicity,
      form.down_payment, form.end_date]);

  const [notice, setNotice] = useState("");
  const [recentTrailers, setRecentTrailers] = useState(() => readRecentTrailers());
  // Номера из расходов и регулярных платежей компании — общие для всех устройств;
  // локальная история остаётся запасным вариантом, если запрос не удался.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await apiFetch("/expenses/trailer-plates");
        if (!r.ok) return;
        const d = await r.json();
        const remote = Array.isArray(d.plates) ? d.plates : [];
        if (alive && remote.length) {
          setRecentTrailers((cur) => [...remote, ...cur.filter((x) => !remote.includes(x))].slice(0, 100));
        }
      } catch (e) { /* подсказка не критична */ }
    })();
    return () => { alive = false; };
  }, []);

  async function submit(keepOpen = false) {
    if (!form.category_code) {
      setError(ru ? "Выберите категорию" : "Select a category");
      return;
    }
    const amount = Number(form.amount);
    if (!amount || amount <= 0) {
      setError(ru ? "Укажите сумму больше нуля" : "Enter an amount greater than zero");
      return;
    }
    if (isRecurring && form.amount_mode === "total" && !(Number(form.total_periods) > 0)) {
      setError(ru ? "Укажите, за сколько платежей эта сумма" : "Enter how many payments the total covers");
      return;
    }
    if (form.scope === "vehicle" && !form.plate_number && !fixedPlate) {
      setError(ru ? "Выберите автомобиль" : "Select a vehicle");
      return;
    }
    if (form.scope === "trailer" && !form.trailer_plate.trim()) {
      setError(ru ? "Укажите номер прицепа" : "Enter the trailer plate");
      return;
    }

    const mode = isRecurring ? form.amount_mode : "period";
    const payload = {
      expense_date: form.expense_date,
      section,
      category_code: form.category_code,
      description: form.description.trim() || null,
      // Для режимов «за год» и «всего за срок» сумма уходит как input_amount:
      // сервер сам приведёт её к сумме одного списания.
      amount: mode === "period" ? amount : null,
      input_amount: mode === "period" ? null : amount,
      amount_mode: mode,
      total_periods: mode === "total" ? Number(form.total_periods) : null,
      down_payment: isRecurring && Number(form.down_payment) > 0 ? Number(form.down_payment) : 0,
      currency: form.currency,
      type: form.type,
      periodicity: isRecurring ? form.periodicity : null,
      start_date: isRecurring ? form.expense_date : null,
      // «Всего за срок»: дата окончания считается сервером из числа платежей.
      end_date: isRecurring && mode !== "total" && form.end_date ? form.end_date : null,
      day_of_month: isRecurring ? chargeDay : 1,
      comment: form.comment.trim() || null,
      document_ref: form.document_ref.trim() || null,
      // Полисные атрибуты отправляем только для страхования — в других разделах
      // сервер их и не ждёт.
      ...(section === "insurance" ? {
        country: form.country.trim() || null,
        policy_number: form.policy_number.trim() || null,
        insurer: form.insurer.trim() || null,
      } : {}),
      plate_number: form.scope === "vehicle" ? (fixedPlate || form.plate_number) : null,
      trailer_plate: form.scope === "trailer" ? (fixedTrailer || form.trailer_plate.trim()) : null,
    };

    // В PATCH уходят только поля графика: тип и раздел у существующего договора
    // не меняются, а объект передаём целиком, чтобы смена привязки работала.
    const patchPayload = {
      description: form.description.trim() || null,
      input_amount: mode === "period" ? null : amount,
      amount: mode === "period" ? amount : null,
      amount_mode: mode,
      total_periods: mode === "total" ? Number(form.total_periods) : null,
      down_payment: Number(form.down_payment) > 0 ? Number(form.down_payment) : 0,
      currency: form.currency,
      frequency: form.periodicity,
      start_date: form.expense_date,
      document_ref: form.document_ref.trim() || null,
      comment: form.comment.trim(),   // пустая строка очищает комментарий
      plate_number: form.scope === "vehicle" ? (fixedPlate || form.plate_number) : null,
      trailer_plate: form.scope === "trailer" ? (fixedTrailer || form.trailer_plate.trim()) : null,
      ...(section === "insurance" ? {
        country: form.country.trim() || null,
        policy_number: form.policy_number.trim() || null,
        insurer: form.insurer.trim() || null,
      } : {}),
    };

    // P0-5 (аудит stage9.2): «вычисленные» значения вместо фактических теряли
    // данные. Раньше сюда всегда уходили day_of_month = chargeDay (при очистке
    // поля — день из даты начала) и end_date = null (в режиме «за год» очистка
    // «Платить до» делала договор бессрочным молча). Теперь ключ отправляется
    // ТОЛЬКО если значение реально отличается от исходного договора; явная
    // очистка уходит как null — сервер различает «не прислали» / «прислали null».
    if (initial) {
      const origDay = initial.day_of_month ?? null;
      const newDay = form.charge_day === "" ? null : Number(form.charge_day);
      if (origDay !== newDay) patchPayload.day_of_month = newDay;

      const origEnd = initial.end_date || "";
      const newEnd = mode !== "total" && form.end_date ? form.end_date : null;
      if (origEnd !== (newEnd || "")) {
        // Очистка «Платить до» в режимах «за год»/«за период» делает договор
        // бессрочным — это осознанный выбор, прошлые списания при этом не
        // трогаются, но спросить надо до отправки.
        if (origEnd && !newEnd) {
          const q = ru
            ? `Дата окончания будет снята, договор станет бессрочным (будущие платежи продолжатся после прежней даты). Уже созданные списания не изменятся. Продолжить?`
            : `The end date will be removed and the contract becomes open-ended (future charges continue past the old end date). Existing charges are untouched. Continue?`;
          if (!window.confirm(q)) { setBusy(false); return; }
        }
        patchPayload.end_date = newEnd;
      }
    } else {
      patchPayload.day_of_month = isRecurring ? chargeDay : 1;
      patchPayload.end_date = mode !== "total" && form.end_date ? form.end_date : null;
    }

    // Дата начала в прошлом: все прошедшие списания создаются сразу и сразу
    // попадают в расходы. Это должен быть осознанный выбор, а не побочный эффект.
    if (isRecurring && !initial) {
      const past = countPastCharges({
        startIso: form.expense_date, todayIso: iso(new Date()), periodicity: form.periodicity,
        day: chargeDay, endIso: form.amount_mode === "total" ? "" : form.end_date,
        maxCount: form.amount_mode === "total" ? Number(form.total_periods) : 0,
      });
      if (past > 1) {
        const q = ru
          ? `Дата начала в прошлом: сразу будет создано ${past} списаний за прошедшие периоды (как оплаченные). Продолжить?\n\nЕсли платежи до сегодняшнего дня уже учтены иначе — нажмите «Отмена» и поставьте ближайшую дату начала.`
          : `The start date is in the past: ${past} charges for past periods will be created right away (as paid). Continue?\n\nIf earlier payments are already recorded elsewhere, cancel and set the nearest start date.`;
        if (!window.confirm(q)) return;
      }
    }

    setBusy(true);
    setError("");
    // Редактирование идёт в PATCH и влияет только на БУДУЩИЙ график: прошлые
    // списания — ушедшие деньги, их переписывать нельзя.
    const res = initial
      ? await apiFetch(`/recurring-expenses/${initial.id}`, { method: "PATCH", body: JSON.stringify(patchPayload) })
      : await apiFetch("/expenses/", { method: "POST", body: JSON.stringify(payload) });
    let data = null;
    try { data = await res.clone().json(); } catch (e) {}
    setBusy(false);
    if (!res.ok) {
      const detail = (data && data.detail) || `HTTP ${res.status}`;
      const text = Array.isArray(detail) ? detail.map((d) => d.msg).join("; ") : String(detail);
      setError(text);
      reportUiError(text);
      return;
    }
    if (form.scope === "trailer") rememberTrailer(fixedTrailer || form.trailer_plate);
    if (onSaved) onSaved(data);
    if (keepOpen && !initial) {
      // Тот же объект, раздел, дата, валюта и номер прицепа — меняются только
      // категория/сумма/описание: не печатать всё заново для серии платежей.
      setForm((f) => ({ ...f, amount: "", description: "", comment: "", document_ref: "" }));
      setNotice(ru ? "Сохранено. Можно добавить следующий." : "Saved. You can add another.");
      return;
    }
    onClose();
  }

  const title = titleOverride || (ru ? "Добавить расход" : "Add expense");
  const freqLabel = (FREQUENCIES.find((f) => f.id === form.periodicity) || FREQUENCIES[0]);

  // Полисные поля показываем только для страхования: в других разделах
  // страна, номер полиса и страховая смысла не имеют.
  const isInsuranceSection = section === "insurance";

  return (
    <Modal onClose={onClose} maxWidth={660} label={title}>
      <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "var(--c-text)" }}>
        {meta.icon} {title}
      </h3>
      <div style={{ fontSize: 12, color: "var(--c-muted-2)", marginBottom: 14 }}>
        {ru ? "Раздел: " : "Section: "}<b>{sectionLabel(section, lang)}</b>
      </div>

      {/* Тип — первым полем: от него зависит весь остальной набор. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, background: "var(--c-surface-2)", padding: 3, borderRadius: 10 }}>
        {/* Переменная цикла названа `opt`, а не `t`: буквой `t` в проекте
            обозначен словарь переводов, и проверка модулей принимает обращение
            к её полям за ключи словаря, которых не существует. */}
        {[{ id: "oneoff", ru: "Разовый", en: "One-off" }, { id: "recurring", ru: "Регулярный", en: "Recurring" }].map((opt) => (
          <button key={opt.id} type="button" onClick={() => set({ type: opt.id })} aria-pressed={form.type === opt.id}
                  style={{
                    flex: 1, padding: "7px 10px", border: "none", borderRadius: 8, cursor: "pointer",
                    fontFamily: "inherit", fontSize: 12.5, fontWeight: 700,
                    background: form.type === opt.id ? "var(--c-brand-solid)" : "transparent",
                    color: form.type === opt.id ? "var(--c-on-brand)" : "var(--c-muted-2)",
                  }}>{ru ? opt.ru : opt.en}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ gridColumn: "1/-1" }}>
          <label style={s.label} htmlFor="fc-ef-cat">{ru ? "Категория" : "Category"}</label>
          <CategorySelect
            id="fc-ef-cat"
            section={section}
            catState={catStateProp || catStateOwn}
            value={form.category_code}
            onChange={(code) => set({ category_code: code })}
            lang={lang}
          />
        </div>

        <div>
          <label style={s.label} htmlFor="fc-ef-scope">{ru ? "Объект расхода" : "Applies to"}</label>
          <select id="fc-ef-scope" style={s.input} value={form.scope} disabled={scopeLocked}
                  onChange={(e) => set({ scope: e.target.value })}>
            {scopeOptions.map((o) => (
              <option key={o.id} value={o.id}>{ru ? o.ru : o.en}</option>
            ))}
          </select>
        </div>

        {form.scope === "vehicle" && (
          <div>
            <label style={s.label} htmlFor="fc-ef-plate">{ru ? "Автомобиль" : "Vehicle"}</label>
            {fixedPlate ? (
              <input id="fc-ef-plate" style={s.input} value={fixedPlate} disabled />
            ) : (
              <select id="fc-ef-plate" style={s.input} value={form.plate_number}
                      onChange={(e) => set({ plate_number: e.target.value })}>
                <option value="">{ru ? "— выберите —" : "— select —"}</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.plate_number}>
                    {v.plate_number}{v.driver_name ? ` (${v.driver_name})` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {form.scope === "trailer" && (
          <div>
            <label style={s.label} htmlFor="fc-ef-trailer">{ru ? "Номер прицепа" : "Trailer plate"}</label>
            <input id="fc-ef-trailer" style={s.input} placeholder="SW12345" list="fc-ef-trailer-list"
                   autoComplete="off" value={form.trailer_plate} disabled={Boolean(fixedTrailer)}
                   onChange={(e) => set({ trailer_plate: e.target.value })} />
            <datalist id="fc-ef-trailer-list">
              {recentTrailers.map((p) => <option key={p} value={p} />)}
            </datalist>
          </div>
        )}

        <div>
          <label style={s.label} htmlFor="fc-ef-date">
            {isRecurring
              /* «Дата первого списания» вводила в заблуждение: это дата НАЧАЛА
                 договора, а первое регулярное списание может быть позже — оно
                 зависит от «Дня регулярного списания» ниже. */
              ? (ru ? "Дата начала" : "Start date")
              : (ru ? "Дата" : "Date")}
          </label>
          <input id="fc-ef-date" type="date" style={s.input} value={form.expense_date}
                 onChange={(e) => set({ expense_date: e.target.value })} />
        </div>

        {isRecurring && form.periodicity === "weekly" && (
          <div>
            {/* Для недельного графика день месяца не используется вообще: списание
                идёт каждые 7 дней от даты начала. Раньше поле «День списания»
                показывалось и здесь — пользователь ставил «15-е» и ждал списания
                15-го, которого не будет. */}
            <label style={s.label}>{ru ? "Расписание" : "Schedule"}</label>
            <div style={{ ...s.input, display: "flex", alignItems: "center", color: "var(--c-muted-2)" }}>
              {ru ? "каждые 7 дней от даты начала" : "every 7 days from the start date"}
            </div>
          </div>
        )}

        {isRecurring && form.periodicity !== "weekly" && (
          <div>
            {/* День списания задаётся явно: «начало с 1 сентября, списание 15-го»
                — обычная формулировка договора, и её нельзя вывести из даты. */}
            <label style={s.label} htmlFor="fc-ef-day">
              {ru ? "День регулярного списания" : "Charge day"}
              <span style={{ fontWeight: 400, color: "var(--c-muted-2)" }}> {ru ? "(1–28)" : "(1–28)"}</span>
            </label>
            <input id="fc-ef-day" type="number" min="1" max="28" style={s.input}
                   placeholder={String(dayFromDate)} value={form.charge_day}
                   onChange={(e) => set({ charge_day: e.target.value })} />
          </div>
        )}

        {isRecurring ? (
          <>
            <div>
              <label style={s.label} htmlFor="fc-ef-mode">{ru ? "Сумма указана" : "Amount is"}</label>
              <select id="fc-ef-mode" style={s.input} value={form.amount_mode}
                      onChange={(e) => set({ amount_mode: e.target.value })}>
                {AMOUNT_MODES.map((m) => (
                  <option key={m.id} value={m.id}>{ru ? m.ru : m.en}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={s.label} htmlFor="fc-ef-amount">
                {form.amount_mode === "total"
                  ? (ru ? "Общая сумма по договору" : "Total contract amount")
                  : form.amount_mode === "yearly"
                    ? (ru ? "Сумма за год" : "Amount per year")
                    : (ru ? "Сумма за период" : "Amount per period")}
              </label>
              <input id="fc-ef-amount" type="number" step="0.01" min="0" style={s.input}
                     value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
            </div>
            {form.amount_mode === "total" && (
              <div>
                <label style={s.label} htmlFor="fc-ef-periods">
                  {ru ? "За сколько платежей" : "Number of payments"}
                </label>
                <input id="fc-ef-periods" type="number" min="1" max="1200" style={s.input}
                       placeholder="48" value={form.total_periods}
                       onChange={(e) => set({ total_periods: e.target.value })} />
              </div>
            )}
            <div>
              <label style={s.label} htmlFor="fc-ef-freq">{ru ? "Периодичность" : "Frequency"}</label>
              <select id="fc-ef-freq" style={s.input} value={form.periodicity}
                      onChange={(e) => set({ periodicity: e.target.value })}>
                {FREQUENCIES.map((f) => (
                  <option key={f.id} value={f.id}>{ru ? f.ru : f.en}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={s.label} htmlFor="fc-ef-dp">
                {ru ? "Разовый взнос вначале (необязательно)" : "Initial one-off payment (optional)"}
              </label>
              <input id="fc-ef-dp" type="number" step="0.01" min="0" style={s.input}
                     placeholder="0" value={form.down_payment}
                     onChange={(e) => set({ down_payment: e.target.value })} />
            </div>
            <div>
              <label style={s.label} htmlFor="fc-ef-until">
                {ru ? "Платить до (необязательно)" : "Until (optional)"}
              </label>
              <input id="fc-ef-until" type="date" style={s.input}
                     value={form.amount_mode === "total" ? "" : form.end_date}
                     disabled={form.amount_mode === "total"}
                     onChange={(e) => set({ end_date: e.target.value })} />
              {form.amount_mode === "total" && (
                <div style={{ fontSize: 11.5, color: "var(--c-muted-2)", marginTop: 4 }}>
                  {ru ? "Считается из числа платежей" : "Calculated from the number of payments"}
                </div>
              )}
            </div>
          </>
        ) : (
          <div>
            <label style={s.label} htmlFor="fc-ef-amount-o">{ru ? "Сумма" : "Amount"}</label>
            <input id="fc-ef-amount-o" type="number" step="0.01" min="0" style={s.input}
                   value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
          </div>
        )}

        <div>
          <label style={s.label} htmlFor="fc-ef-currency">{ru ? "Валюта" : "Currency"}</label>
          <select id="fc-ef-currency" style={s.input} value={form.currency}
                  onChange={(e) => set({ currency: e.target.value })}>
            {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>

        <div style={{ gridColumn: "1/-1" }}>
          <label style={s.label} htmlFor="fc-ef-desc">{ru ? "Название / описание" : "Title / description"}</label>
          <input id="fc-ef-desc" style={s.input} value={form.description}
                 placeholder={ru ? "Напр. GPS-трекер, аренда прицепа, КАСКО" : "e.g. GPS tracker, trailer rent, CASCO"}
                 onChange={(e) => set({ description: e.target.value })} />
        </div>

        <div>
          <label style={s.label} htmlFor="fc-ef-doc">{ru ? "Номер документа" : "Document number"}</label>
          <input id="fc-ef-doc" style={s.input} value={form.document_ref}
                 placeholder={ru ? "Напр. AR-2026-12" : "e.g. AR-2026-12"}
                 onChange={(e) => set({ document_ref: e.target.value })} />
        </div>
        <div>
          <label style={s.label} htmlFor="fc-ef-comment">{ru ? "Комментарий" : "Comment"}</label>
          <input id="fc-ef-comment" style={s.input} value={form.comment}
                 onChange={(e) => set({ comment: e.target.value })} />
        </div>

        {/* P0-1 (аудит stage9.2): раньше grid-контейнер закрывался ДО этого
            блока, и три полисных поля рендерились наружи сетки — на всю
            ширину модалки, визуально отрываясь от формы. Теперь они внутри
            grid: два поля в ряд, страховая компания — на всю ширину, чтобы
            не оставлять «одинокую» ячейку. */}
        {isInsuranceSection && (
          <>
            <div>
              <label style={s.label} htmlFor="fc-ef-country">{ru ? "Страна полиса" : "Policy country"}</label>
              <input id="fc-ef-country" style={s.input} placeholder={ru ? "например, PL" : "e.g. PL"}
                     maxLength={60} value={form.country}
                     onChange={(e) => set({ country: e.target.value })} />
            </div>
            <div>
              <label style={s.label} htmlFor="fc-ef-policy">{ru ? "Номер полиса" : "Policy number"}</label>
              <input id="fc-ef-policy" style={s.input} maxLength={100} value={form.policy_number}
                     onChange={(e) => set({ policy_number: e.target.value })} />
            </div>
            <div style={{ gridColumn: "1/-1" }}>
              <label style={s.label} htmlFor="fc-ef-insurer">{ru ? "Страховая компания" : "Insurer"}</label>
              <input id="fc-ef-insurer" style={s.input} maxLength={200} value={form.insurer}
                     onChange={(e) => set({ insurer: e.target.value })} />
            </div>
          </>
        )}
      </div>

      {isRecurring && preview && (
        <div style={{
          marginTop: 12, background: "var(--c-info-bg)", border: "1px solid var(--c-info-border)",
          borderRadius: 8, padding: "10px 14px", fontSize: 12.5, color: "var(--c-info)", lineHeight: 1.6,
        }}>
          {ru ? "Итог: " : "Result: "}
          <b>{fmtMoney(preview.per, form.currency, lang)}</b>{" "}
          {ru ? freqLabel.perRu : freqLabel.perEn}
          {preview.periods ? <> · <b>{preview.periods}</b> {ru ? "платежей" : "payments"}</> : null}
          {form.end_date && form.amount_mode !== "total"
            ? ` · ${ru ? "до" : "until"} ${form.end_date}`
            : (preview.periods ? "" : ` · ${ru ? "бессрочно" : "no end date"}`)}
          {Number(form.down_payment) > 0 && (
            <>
              <br />
              {ru ? "Плюс разово вначале: " : "Plus a one-off upfront payment: "}
              <b>{fmtMoney(Number(form.down_payment), form.currency, lang)}</b>
              {` ${ru ? "в дату начала" : "on the start date"}`}
            </>
          )}
          {/* Итог по договору целиком — иначе непонятно, входит ли разовый взнос
              в «90 000 за 48 месяцев»: пользователь может понять это и так, и так,
              а от понимания зависит, верную ли сумму он ввёл. */}
          {preview.contractTotal != null && (
            <>
              <br />
              <span style={{ fontWeight: 700 }}>
                {ru ? "Итого по договору: " : "Contract total: "}
                {fmtMoney(preview.contractTotal, form.currency, lang)}
              </span>
              {preview.periods
                ? ` (${preview.periods} × ${fmtMoney(preview.per, form.currency, lang)}`
                  + (Number(form.down_payment) > 0
                     ? ` + ${fmtMoney(Number(form.down_payment), form.currency, lang)})`
                     : ")")
                : ""}
            </>
          )}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--c-danger-strong)" }}>⚠ {error}</div>
      )}
      {notice && !error && (
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--c-info)" }}>✓ {notice}</div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
        <button type="button" className="fc-btn" style={s.btn} onClick={onClose}>
          {ru ? "Отмена" : "Cancel"}
        </button>
        {!initial && (
          <button type="button" className="fc-btn" style={s.btn} onClick={() => submit(true)} disabled={busy}>
            {ru ? "Сохранить и добавить ещё" : "Save and add another"}
          </button>
        )}
        <button type="button" className="fc-btn" style={s.btnPrimary} onClick={() => submit(false)} disabled={busy}>
          {busy ? "…" : (ru ? "Сохранить" : "Save")}
        </button>
      </div>
    </Modal>
  );
}
