/**
 * Разбор ответа «действий с курсами» (сегодня / архив / пересчёт) и текст итога.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ
 * ----------------------
 * Здесь ветвление, а не разметка. Три кнопки на странице «Курсы валют»
 * обрабатывают ответ одинаково, и именно в этом месте было две ошибки сразу:
 *
 * 1. Обрыв по таймауту приходит как HTTP 502 — и это ответ nginx, а не
 *    приложения. Раньше фронт показывал «Error» (тело не JSON, `r.json()`
 *    бросал исключение), а плашка сверху сообщала «бэкенд недоступен».
 *    На самом деле сервер работал, просто не успел за `proxy_read_timeout 120s`.
 * 2. Сбой загрузки курсов из ЕЦБ приходит как `{"status":"error"}` с кодом
 *    **200**. Проверки `if(!r.ok)` его не видели: неудачная загрузка архива
 *    выглядела успешной («undefined new rows»), курс в таблицу не попадал, а
 *    следующий пересчёт объявлял «500 without rate» — без всякого объяснения,
 *    почему курса нет.
 *
 * Поэтому разбор ответа — чистая функция, и её поведение закреплено проверками
 * в `scripts/check-behaviour.mjs` (`npm run check:logic`).
 */

/** Статусы, которые приходят от прокси/шлюза, а не от приложения. */
export const GATEWAY_STATUSES = [502, 503, 504];

/**
 * Что произошло с запросом.
 * @returns {"ok"|"network"|"gateway"|"ecb"|"http"|"partial"}
 */
export function fxOutcome(res, data) {
  const status = (res && res.status) || 0;
  if (!res || !res.ok) {
    if (status === 0) return "network";          // запрос не ушёл вообще
    if (GATEWAY_STATUSES.includes(status)) return "gateway";
    return "http";
  }
  // HTTP 200, но приложение само сообщает о сбое загрузки курсов.
  if (data && data.status === "error") return "ecb";
  // Загрузилось не всё: часть батчей не записалась. Это не отказ и не успех —
  // показать полным успехом нельзя, иначе архив считается загруженным.
  if (data && data.status === "partial") return "partial";
  return "ok";
}

/**
 * Показывать ли как отказ. «partial» — не отказ: работа частично сделана, нужно
 * показать результат и предупреждение, а не красную ошибку.
 */
export function fxIsFatal(kind) {
  return kind === "network" || kind === "gateway" || kind === "http" || kind === "ecb";
}

/** Текст для оператора по типу неудачи. Всегда говорит, что делать дальше. */
export function fxErrorMessage(kind, res, data) {
  const status = (res && res.status) || 0;
  switch (kind) {
    case "network":
      return "Нет связи с сервером — запрос не ушёл. Проверьте, что сервис запущен, и повторите.";
    case "gateway":
      // Важно не пугать «бэкенд недоступен»: работа могла частично выполниться,
      // и повтор её ПРОДОЛЖАЕТ (пересчёт идёт по возрастающему id).
      return `Запрос прерван шлюзом (HTTP ${status}): сервер не ответил за 2 минуты. `
           + `Часть работы могла уже выполниться — нажмите кнопку ещё раз, обработка продолжится с места остановки.`;
    case "ecb":
      // Текст приходит от бэкенда и содержит ФАКТЫ: реальную ошибку базы и
      // результат проверки схемы. Раньше здесь была догадка про отсутствующую
      // таблицу, из-за которой шли применять миграции вместо реальной причины.
      return `Не удалось загрузить курсы ЕЦБ: ${(data && data.message) || "причина не указана"} `
           + `Пока архив не загрузится, пересчёт будет оставлять строки без курса.`;
    case "partial":
      return (data && data.message)
          || "Загрузилось не всё: часть данных не записалась. Повторный запуск продолжится.";
    default:
      return (data && (data.detail || data.error)) || `HTTP ${status}`;
  }
}

/**
 * Однострочный итог пересчёта: что сделано, что осталось и почему.
 * «осталось 500» без объяснения выглядит как недоделка приложения, хотя курса
 * для этих валют в архиве ЕЦБ нет и не будет.
 */
export function backfillSummary(d) {
  // Без «✅»: вызывающий сам добавляет контекст («Курс BYN применён к 2 датам · …»),
  // иначе галочка оказывается в середине строки.
  const parts = [`Пересчитано: ${(d && d.backfilled) || 0}`];
  if (d && d.failed) parts.push(`ошибок: ${d.failed}`);
  if (d && d.invalid_rows) parts.push(`без суммы/валюты/даты: ${d.invalid_rows}`);
  if (d && d.no_rate_rows) parts.push(`без курса: ${d.no_rate_rows}`);
  if (d && d.truncated) parts.push("часть не успела — нажмите ещё раз");
  parts.push(`осталось без EUR: ${(d && d.remaining) || 0}`);
  return parts.join(" · ");
}

/**
 * Строка про автопересчёт курсов после импорта/синхронизации — или "" если делать
 * было нечего (тогда сообщение не меняется вовсе).
 *
 * Бэкенд после записи данных сам докачивает недостающие курсы и пересчитывает
 * строки (app/services/fx_autoload.py). Оператору важно видеть три числа: сколько
 * курсов добавили, сколько строк пересчитали и сколько строк осталось без курса.
 * Последнее требует ручного ввода, поэтому не должно потеряться в тексте.
 */
export function fxAutoSummary(auto) {
  if (!auto) return "";
  if (auto.ok === false) return auto.note || "автопересчёт курсов не выполнился";
  const parts = [];
  if (auto.rates_added) parts.push(`курсы: +${auto.rates_added}`);
  if (auto.recalculated) parts.push(`пересчитано строк: ${auto.recalculated}`);
  if (auto.remaining) {
    const cur = Array.isArray(auto.unrated_currencies) ? auto.unrated_currencies.join(", ") : "";
    parts.push(`без курса: ${auto.remaining}` + (cur ? ` (${cur})` : ""));
  }
  return parts.join(" · ");
}

/**
 * Строка про загрузку валют вне ЕЦБ (Frankfurter) для итогового сообщения кнопок.
 * Пусто, если загружать было нечего; при сбое — понятная оговорка, а не молчание
 * (сбой этого источника не отменяет результат ЕЦБ).
 */
export function fxOtherSummary(other) {
  if (!other || other.status === "skipped" && !other.message) return "";
  if (other.status === "skipped") return ` · Frankfurter: ${other.message}`;
  if (other.status === "error") return ` · Frankfurter: не загружено (${other.message || "источник недоступен"})`;
  const n = (other.new_rows || 0) + (other.updated_rows || 0);
  const codes = (other.results || []).filter(r => r.status === "ok").map(r => r.currency).join(", ");
  const warn = other.status === "partial" ? " (часть валют не загрузилась)" : "";
  return ` · Frankfurter: +${n}${codes ? ` (${codes})` : ""}${warn}`;
}

/**
 * Подсказка «что осталось без курса и на какую дату его вводить» — или "".
 * Это текст бэкенда: в нём уже есть конкретная дата, без которой оператор вводит
 * курс «на сегодня» и не понимает, почему старые строки снова «без курса».
 */
export function fxAutoNote(auto) {
  return (auto && auto.note) || "";
}

/**
 * Может ли эта роль задать курс валюты вручную — то же правило, что на сервере.
 *
 * Нужно, чтобы НЕ показывать кнопку, которая гарантированно вернёт 403: валюту из
 * архива ЕЦБ переопределяет только владелец, потому что ручное значение перебивает
 * официальный курс (поиск идёт как «company manual → global ECB») и молча меняет
 * уже посчитанные исторические суммы.
 *
 * ⚠️ Источник истины — сервер (`fx_autoload.may_edit_currency`). Здесь правило
 * продублировано исключительно ради интерфейса; проверки в check-behaviour.mjs
 * следят, чтобы эти две формулировки не разъехались.
 */
export function mayEnterRate(role, currency, ecbCurrencies) {
  const code = String(currency || "").trim().toUpperCase();
  if (code.length !== 3) return true;   // поле ещё заполняется — не мешаем
  if (role === "owner") return true;
  if (role !== "manager") return false; // viewer и прочие: только чтение
  const ecb = ecbCurrencies instanceof Set ? ecbCurrencies : new Set(ecbCurrencies || []);
  return !ecb.has(code);
}

/**
 * Что делать с валютами, для которых курса не нашлось — с учётом роли.
 *
 * Страница «Курсы валют» доступна владельцу (вкладкой в «Администрировании») и
 * менеджеру (отдельным пунктом меню), поэтому в подсказке важен не столько адрес,
 * сколько ДАТА: курс действует на свою дату и 14 дней вперёд, и ввод «на сегодня»
 * старые строки не закрывает. Просмотру (viewer) курс задать нельзя вообще — ему
 * называем, к кому идти.
 */
export function fxAutoAction(auto) {
  if (!auto || !auto.remaining) return "";
  const role = (typeof window !== "undefined" && window.__FLEETCOST_ROLE__) || "viewer";
  const list = Array.isArray(auto.unrated) ? auto.unrated : [];
  const first = list.find((x) => x && x.currency
    && Array.isArray(x.needed_dates) && x.needed_dates.length > 0);
  const date = first ? String(first.needed_dates[0]).split("-").reverse().join(".") : "";
  const cur = (first && first.currency)
    || (Array.isArray(auto.unrated_currencies) && auto.unrated_currencies[0]) || "";
  // «BYN на 05.09.2026» — дата обязательна: курс действует вперёд, и курс,
  // добавленный «сегодня», старые строки не закрывает.
  const target = [cur, date].filter(Boolean).join(" на ");
  const what = target ? `Курс ${target}` : "Курс";
  // Валюту из архива ЕЦБ менеджер ввести не вправе: ручное значение перебило бы
  // официальный курс и молча изменило исторические суммы. Флаг `manual_only`
  // приходит с сервера вместе с разбором «без курса»; его отсутствие трактуем как
  // «можно» — так подсказка не отправит менеджера к владельцу без причины.
  const manualOnly = !first || first.manual_only !== false;
  const canEnter = role === "owner" || (role === "manager" && manualOnly);
  if (canEnter) return `${what}: откройте «Курсы валют» и добавьте.`;
  if (manualOnly) return `${what} может добавить владелец или менеджер («Курсы валют»).`;
  return `${what}: вручную может переопределить только владелец («Курсы валют»).`;
}

/**
 * Кнопки «ввести курс» из ответа пересчёта: только те записи, у которых известна
 * дата. Дата обязательна — именно её подставляем в форму, и именно её отсутствие
 * приводило к тому, что пользователь вводил курс «на сегодня» и не понимал,
 * почему старые транзакции остаются без курса.
 * Устойчиво к отсутствующему полю (старый ответ бэкенда) и к не-массиву.
 */
export function rateActions(detail) {
  if (!Array.isArray(detail)) return [];
  return detail
    .filter((x) => x && x.currency
                   && Array.isArray(x.needed_dates) && x.needed_dates.length > 0)
    .map((x) => ({
      currency: String(x.currency),
      // Первая нужная дата — для кнопки «ввести вручную».
      date: String(x.needed_dates[0]),
      // И ВЕСЬ набор: массовый ввод отправляет его одним запросом. Пропустить это
      // поле нельзя — кнопка массового ввода читает needed_dates.length и
      // отправляет список; без него был бы undefined, 422 и падение разметки.
      needed_dates: x.needed_dates.map(String),
      rows: Number(x.rows) || 0,
      advice: x.advice || "",
      // Курс задаётся только вручную (валюты нет в архиве ЕЦБ). Менеджеру поле
      // ввода показываем лишь для таких записей: для PLN он получит 403.
      // Отсутствие флага (старый ответ бэкенда) трактуем как «можно».
      manual_only: x.manual_only !== false,
    }));
}

/**
 * Число из поля ввода курса. Принимает и «0,29», и «0.29».
 *
 * Запятая здесь не мелочь: в русской раскладке её пишут естественно, а
 * `parseFloat("0,29")` возвращает 0 — и пользователь получал бы «укажите курс
 * больше нуля», введя корректное значение. Пустое или нечисловое значение —
 * null, чтобы вызывающий отличал «не введено» от «ноль».
 */
export function parseRateInput(raw) {
  const text = String(raw ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}
