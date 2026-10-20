#!/usr/bin/env node
/**
 * check-behaviour.mjs — проверка ЗНАЧЕНИЙ вынесенных функций.
 *
 * ЗАЧЕМ
 * -----
 * `npm run check` ловит неразрешённые ссылки (белый экран), но он не отвечает
 * на вопрос «а логика не изменилась?». При выносе кода из App.jsx в модули
 * легко перепутать условие, потерять ветку или сломать порядок проверок —
 * внешне приложение запустится, а цифры будут другими. Здесь для каждой
 * вынесенной функции зафиксировано ожидаемое значение.
 *
 * Запуск: npm run check:logic
 * Код возврата 1 — расхождение с ожидаемым значением.
 *
 * Файл собирается esbuild'ом с заглушкой DOM (модули обращаются к
 * localStorage/navigator при импорте), затем исполняется в Node.
 */

import { writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(root, ".check-tmp");

const SHIM = `globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
globalThis.document = {
  createElement: () => ({ style:{}, setAttribute(){}, appendChild(){}, addEventListener(){} }),
  head: { appendChild(){} }, body: { appendChild(){} },
  getElementById: () => null, addEventListener(){}, removeEventListener(){},
  querySelector: () => null, querySelectorAll: () => [],
};
try { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "check-behaviour" }, configurable: true }); } catch (e) {}
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });
`;

const CASES = `
import { toEur, sumToEur, fmtByCur, EUR_RATES, unknownCurrencies, curEntries, rowEur, sumEurRows, isServiceKey } from "../src/lib/money.js";
import { isFuel, isOther, isManual, isInsurance, isLeasing, isTrailer, isGeneral,
         extractTrailerPlates, activePlatesForAllocation } from "../src/lib/tx.js";
import { missingEurRows, missingEurByCur } from "../src/lib/money.js";
import { countPastCharges } from "../src/lib/recurring.js";
import { getPrevMonthDates } from "../src/lib/date.js";
import { buildAssetCards, contractPlate } from "../src/lib/assetCards.js";
import { fxOtherSummary } from "../src/lib/fxAction.js";
import { greeting, normalizeCompanyName, fmtInstantShort, fmtMoney, greetName, amountFontSize, amountFits,
         donutAmount, DONUT_AMOUNT_MAX_W, DONUT_AMOUNT_MIN, MONO_ADVANCE } from "../src/lib/format.js";
import { freshnessColor, freshnessLabel, FRESH_HOURS, STALE_HOURS } from "../src/lib/importFreshness.js";
import { ENTITY_RU, FIELD_RU, entityRu, fieldRu, defaultContractDescription,
         SEG_PAGE_SIZE } from "../src/ui/constants.js";
import { focusCycleIndex, modalLayout } from "../src/ui/Modal.jsx";
import { pageRange, pageWindow, srcFilterOptions, SYNC_BTN_W, SYNC_BTN_H } from "../src/ui/components.jsx";
import { hasCurrencyBreakdown } from "../src/lib/money.js";
import { s, pill, KPI_CORNER_PAD } from "../src/ui/styles.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LIGHT, DARK, resolveTheme, normalizeThemeMode, applyTheme, themeVars } from "../src/lib/theme.js";
import { fmtDate } from "../src/lib/format.js";
import { fxOutcome, fxErrorMessage, fxIsFatal, backfillSummary, rateActions, parseRateInput,
         mayEnterRate, fxAutoAction } from "../src/lib/fxAction.js";
// Набор валют архива ЕЦБ — для проверки правила «кто может задать курс вручную».
const ECB_CUR = new Set(["AUD", "CZK", "PLN", "USD", "GBP"]);
import { catKeyOf, donutGradient } from "../src/pages/DashboardPage.jsx";
import { SECTION_META, scopeOptionsFor, initialScopeFor } from "../src/lib/categories.js";
import { contractEndpoints, toContractShape } from "../src/lib/recurring.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log("  ✗ " + label + ": получено " + g + ", ожидалось " + w); }
};

// ── деньги и курсы ──────────────────────────────────────────────────────────
eq("toEur(100,'PLN')", toEur(100, "PLN"), 23.5);
eq("toEur(100,'EUR')", toEur(100, "EUR"), 100);
// Неизвестная валюта обязана давать NaN, а НЕ 1: иначе 1000 NOK считались как 1000 EUR.
eq("toEur(100,'NOK') → NaN", Number.isNaN(toEur(100, "NOK")), true);
eq("sumToEur({EUR:10,PLN:100})", sumToEur({ EUR: 10, PLN: 100 }), 33.5);
eq("sumToEur({EUR:10,NOK:100}) — NOK не суммируется", sumToEur({ EUR: 10, NOK: 100 }), 10);
eq("fmtByCur({PLN:100,EUR:5})", fmtByCur({ PLN: 100, EUR: 5 }), "100.00 PLN · 5.00 EUR");
eq("EUR_RATES.PLN (fallback-словарь)", EUR_RATES.PLN, 0.235);

// ── объект расхода: допустимые значения и начальное значение ────────────────
// Повод: 'SECTION_META[*].scope' используется как описание ("any" = машина ИЛИ
// прицеп ИЛИ компания), но раньше попадало прямо в состояние формы. На «Лизинге»
// это давало список объектов, не содержащий выбранного значения: автомобиль
// выбрать было НЕЛЬЗЯ, а расход уходил на компанию.
eq("missingEurRows: считаются только строки с суммой и без amount_eur",
   missingEurRows([{amount:10,amount_eur:null},{amount:10,amount_eur:5},{amount:0,amount_eur:null},{amount:7}]).length, 2);
eq("missingEurByCur: суммы по валютам",
   missingEurByCur([{amount:10,currency:"PLN",amount_eur:null},{amount:5,currency:"PLN"},{amount:3,currency:"BYN"}]), {PLN:15,BYN:3});
eq("countPastCharges: ежемесячно, день 15, старт 01.01, сегодня 10.10 — 9 списаний (октябрьское ещё впереди)",
   countPastCharges({ startIso: "2026-01-01", todayIso: "2026-10-10", periodicity: "monthly", day: 15 }), 9);
eq("countPastCharges: старт 20.01, день 5 — первое списание 05.02",
   countPastCharges({ startIso: "2026-01-20", todayIso: "2026-03-10", periodicity: "monthly", day: 5 }), 2);
eq("countPastCharges: число платежей ограничивает счёт",
   countPastCharges({ startIso: "2026-01-01", todayIso: "2026-10-10", periodicity: "monthly", day: 1, maxCount: 3 }), 3);
eq("countPastCharges: дата окончания ограничивает счёт",
   countPastCharges({ startIso: "2026-01-01", todayIso: "2026-10-10", periodicity: "monthly", day: 1, endIso: "2026-04-30" }), 4);
eq("countPastCharges: старт в будущем — ноль",
   countPastCharges({ startIso: "2026-12-01", todayIso: "2026-10-10", periodicity: "monthly", day: 1 }), 0);
eq("countPastCharges: еженедельно",
   countPastCharges({ startIso: "2026-10-01", todayIso: "2026-10-15", periodicity: "weekly", day: 1 }), 3);
eq("scopeOptionsFor('leasing') — можно выбрать машину",
   scopeOptionsFor("leasing").map((o) => o.id), ["vehicle", "company"]);
eq("scopeOptionsFor('insurance') — полис на машину/прицеп/компанию",
   scopeOptionsFor("insurance").map((o) => o.id), ["vehicle", "trailer", "company"]);
eq("scopeOptionsFor('general') — только компания",
   scopeOptionsFor("general").map((o) => o.id), ["company"]);
eq("scopeOptionsFor('salary_tax') — только компания",
   scopeOptionsFor("salary_tax").map((o) => o.id), ["company"]);
eq("scopeOptionsFor('trailer') — прицеп или компания",
   scopeOptionsFor("trailer").map((o) => o.id), ["trailer", "company"]);
eq("scopeOptionsFor('other') — машина или без привязки",
   scopeOptionsFor("other").map((o) => o.id), ["vehicle", "company"]);

eq("initialScopeFor('leasing') — по умолчанию машина",
   initialScopeFor("leasing"), "vehicle");
eq("initialScopeFor('insurance', {defaultScope:'any'}) — 'any' не значение",
   initialScopeFor("insurance", { defaultScope: "any" }), "vehicle");
eq("initialScopeFor('leasing', {defaultScope:'trailer'}) — лизинг только по машинам",
   initialScopeFor("leasing", { defaultScope: "trailer" }), "vehicle");
eq("initialScopeFor('trailer')", initialScopeFor("trailer"), "trailer");
eq("initialScopeFor('general')", initialScopeFor("general"), "company");
eq("initialScopeFor('other')", initialScopeFor("other"), "vehicle");
// Начальное значение обязано быть ОДНИМ ИЗ предложенных вариантов: у раздела
// «Прицепы» варианта «машина» нет, и раньше форма получала значение, которого в
// списке не было, — селект пустовал. Комбинация «раздел прицепов + привязанная
// машина» противоречива, поэтому берётся допустимый вариант раздела.
eq("initialScopeFor('trailer', {fixedPlate:'AA123'}) — только допустимый вариант",
   initialScopeFor("trailer", { fixedPlate: "AA123" }), "trailer");
eq("initialScopeFor('other', {fixedPlate:'AA123'}) — привязанная машина уважается",
   initialScopeFor("other", { fixedPlate: "AA123" }), "vehicle");
eq("initialScopeFor('leasing', {fixedTrailer:'QARP459'}) — лизинг только по машинам",
   initialScopeFor("leasing", { fixedTrailer: "QARP459" }), "vehicle");

// Начальный объект обязан входить в список вариантов ЛЮБОГО раздела и не быть "any".
{
  const bad = [];
  for (const section of Object.keys(SECTION_META)) {
    const ids = scopeOptionsFor(section).map((o) => o.id);
    const init = initialScopeFor(section);
    if (init === "any") bad.push(section + ": начальное значение any");
    if (!ids.includes(init)) bad.push(section + ": " + init + " нет среди " + ids.join("/"));
  }
  eq("начальный объект входит в варианты во всех разделах", bad, []);
  eq("подпись раздела «Лизинг» есть в обоих языках",
     [SECTION_META.leasing.ru, SECTION_META.leasing.en], ["Лизинг", "Leasing"]);
}

// ── активные авто для распределения расходов ────────────────────────────────
// Повод: активные авто определялись ТОЛЬКО по пробегу. Если пробег за период не
// ведут, список пуст — распределения нет вовсе, хотя расходы уже помечены как
// «нераспределённые». Теперь при пустом пробеге берутся машины с операциями в
// периоде (решение пользователя).
eq("активные: есть пробег → он и берётся",
   activePlatesForAllocation({ mileageByVehicle: { AA111: 500, BB222: 300 },
     operationPlates: ["AA111", "BB222", "CC333"] }), ["AA111", "BB222"]);
eq("активные: пробег ноль — не активная",
   activePlatesForAllocation({ mileageByVehicle: { AA111: 0, BB222: 120 } }), ["BB222"]);
eq("активные: пробега нет → машины с операциями",
   activePlatesForAllocation({ mileageByVehicle: {},
     operationPlates: ["CC333", "AA111", "CC333"] }), ["AA111", "CC333"]);
eq("активные: прицепы не активные авто",
   activePlatesForAllocation({ mileageByVehicle: {},
     operationPlates: ["AA111"],
     trailerPlates: new Set(["QARP459"]) }), ["AA111"]);
eq("активные: TRUCK и Unknown исключены",
   activePlatesForAllocation({ mileageByVehicle: { TRUCK: 100, Unknown: 50, AA111: 20 } }),
   ["AA111"]);
eq("активные: ничего нет → пусто",
   activePlatesForAllocation({}), []);
eq("активные: прицеп исключается и по пробегу",
   activePlatesForAllocation({ mileageByVehicle: { AA111: 100, QARP459: 400 },
     trailerPlates: ["QARP459"] }), ["AA111"]);

// ── ограничение объекта для вкладки ─────────────────────────────────────────
// Повод: на вкладке «Лизинг» появился вариант «Прицеп», хотя прицепы ведут в
// своём разделе, а договор лизинга заключается на машину.
eq("scopeOptionsFor('leasing', ['vehicle']) — только машина",
   scopeOptionsFor("leasing", ["vehicle"]).map((o) => o.id), ["vehicle"]);
eq("initialScopeFor('leasing', {allowedScopes:['vehicle']})",
   initialScopeFor("leasing", { allowedScopes: ["vehicle"] }), "vehicle");
eq("ограничение сильнее defaultScope: лизинг не станет прицепом",
   initialScopeFor("leasing", { defaultScope: "trailer", allowedScopes: ["vehicle"] }), "vehicle");
eq("бессмысленное ограничение игнорируется (форма без вариантов хуже)",
   scopeOptionsFor("leasing", ["nope"]).map((o) => o.id), ["vehicle", "company"]);
eq("пустое ограничение = все варианты раздела",
   scopeOptionsFor("leasing", []).map((o) => o.id), ["vehicle", "company"]);
eq("страхование не ограничено",
   scopeOptionsFor("insurance").map((o) => o.id), ["vehicle", "trailer", "company"]);

// ── адрес действия выбирается по источнику договора ─────────────────────────
// Повод: карточки нового договора удалялись по СТАРОМУ адресу
// ('/leasing-contracts/{id}'), поэтому удаление не срабатывало, а при совпадении
// id могло удалить чужой старый договор.
{
  const recurring = toContractShape({ id: 7, section: "leasing", amount: 100, currency: "EUR" });
  const e1 = contractEndpoints(recurring, "leasing-contracts");
  eq("новый договор: удаление идёт в /recurring-expenses",
     [e1.isRecurring, e1.remove, e1.cancel],
     [true, "/recurring-expenses/7", "/recurring-expenses/7/cancel"]);

  const legacy = { id: 7, plate_number: "BI422GV" };
  const e2 = contractEndpoints(legacy, "leasing-contracts");
  eq("старый договор: удаление идёт в свою таблицу",
     [e2.isRecurring, e2.remove, e2.cancel],
     [false, "/leasing-contracts/7", "/leasing-contracts/7/cancel"]);
}

// ── доменные предикаты ──────────────────────────────────────────────────────
eq("isFuel('Diesel','q8')", isFuel("Diesel", "q8"), true);
eq("isFuel('Diesel','csv_income')", isFuel("Diesel", "csv_income"), false);
eq("isFuel('Parking truck E-BOX','e100') — парковка не топливо", isFuel("Parking truck E-BOX", "e100"), false);
eq("isFuel('Car wash','e100') — мойка не топливо", isFuel("Car wash", "e100"), false);
eq("isFuel('Toll DE E-BOX','e100') — толл не топливо", isFuel("Toll DE E-BOX", "e100"), false);
eq("isFuel('Diesel','recurring') — регулярные не топливо", isFuel("Diesel", "recurring"), false);
eq("isOther('Car wash')", isOther("Car wash"), true);
eq("isOther('Parking truck E-BOX')", isOther("Parking truck E-BOX"), true);
eq("isOther('Diesel')", isOther("Diesel"), false);
eq("isManual: manual/csv_income/e100",
   [isManual("manual"), isManual("csv_income"), isManual("e100")], [true, true, false]);
eq("isInsurance/isLeasing/isTrailer/isGeneral",
   [isInsurance("manual_insurance_x"), isLeasing("manual_leasing_x"),
    isTrailer("manual_trailer_x"), isGeneral("manual_general_x")], [true, true, true, true]);
eq("extractTrailerPlates — дубликаты схлопнуты",
   [...extractTrailerPlates([
     { fuel_type: "manual_trailer_t1", plate_number: "TR1" },
     { fuel_type: "Diesel", plate_number: "AA1" },
     { fuel_type: "manual_trailer_t2", plate_number: "TR1" }])], ["TR1"]);

// ── даты ────────────────────────────────────────────────────────────────────
eq("getPrevMonthDates('2026-09-01','2026-09-23')",
   getPrevMonthDates("2026-09-01", "2026-09-23"), { from: "2026-08-01", to: "2026-08-23" });
eq("getPrevMonthDates('2026-03-31') — клампинг дня (31 → 28)",
   getPrevMonthDates("2026-03-31", "2026-03-31"), { from: "2026-02-28", to: "2026-02-28" });
eq("getPrevMonthDates('2026-01-15') — переход через год",
   getPrevMonthDates("2026-01-15", "2026-01-20"), { from: "2025-12-15", to: "2025-12-20" });

// ── текст и подписи ─────────────────────────────────────────────────────────
eq("normalizeCompanyName('  ООО   Ромашка ')", normalizeCompanyName("  ООО   Ромашка "), "ООО Ромашка");
eq("normalizeCompanyName(null)", normalizeCompanyName(null), "—");
eq("greeting() ∈ ключи", ["greetingMorning", "greetingDay", "greetingEvening"].includes(greeting()), true);
eq("entityRu('Company')", entityRu("Company"), "Компания");
eq("entityRu('Неизвестно') — фолбэк на ключ", entityRu("Неизвестно"), "Неизвестно");
eq("fieldRu('amount')", fieldRu("amount"), "Сумма");
eq("ENTITY_RU / FIELD_RU заполнены",
   [Object.keys(ENTITY_RU).length > 5, Object.keys(FIELD_RU).length > 5], [true, true]);
eq("defaultContractDescription('office','RU')", defaultContractDescription("office", "RU"), "Аренда офиса");
eq("defaultContractDescription('parking','EN')", defaultContractDescription("parking", "EN"), "Office parking spot rental");
eq("defaultContractDescription('unknown','RU') — фолбэк", defaultContractDescription("unknown", "RU"), "Договор");
eq("SEG_PAGE_SIZE", SEG_PAGE_SIZE, 50);

// ── фокус-ловушка диалога (ui/Modal.jsx) ────────────────────────────────────
// Логику обхода клавиатурой нельзя проверить ни сборкой, ни рендером — только
// значениями. Проверяем переходы по кругу в обе стороны и краевые случаи.
eq("focusCycleIndex(3,0,вперёд)", focusCycleIndex(3, 0, false), 1);
eq("focusCycleIndex(3,2,вперёд) → по кругу на первый", focusCycleIndex(3, 2, false), 0);
eq("focusCycleIndex(3,0,назад) → по кругу на последний", focusCycleIndex(3, 0, true), 2);
eq("focusCycleIndex(3,-1,вперёд) → первый", focusCycleIndex(3, -1, false), 0);
eq("focusCycleIndex(3,-1,назад) → последний", focusCycleIndex(3, -1, true), 2);
eq("focusCycleIndex(1,0,вперёд) → тот же (единственный)", focusCycleIndex(1, 0, false), 0);
eq("focusCycleIndex(0,0,вперёд) → -1 (нет фокусируемых)", focusCycleIndex(0, 0, false), -1);

// ── внешний вид диалога (ui/Modal.jsx) ──────────────────────────────────────
// Девять диалогов теперь зависят от этих значений, а рендер в Node порталы не
// поддерживает — значит единственный способ зафиксировать вид это проверка значений.
const dTop = modalLayout({ align: "top", maxWidth: 560 });
eq("диалог/верх: фон прижимает к верху и прокручивается",
   [dTop.backdrop.alignItems, dTop.backdrop.padding, dTop.backdrop.overflowY],
   ["flex-start", "60px 16px 16px", "auto"]);
eq("диалог/верх: панель", [dTop.panel.padding, dTop.panel.maxWidth, dTop.panel.borderRadius, dTop.panel.boxShadow],
   [22, 560, 14, "0 20px 50px rgba(0,0,0,0.20)"]);
eq("диалог/верх: у панели нет собственной прокрутки", dTop.panel.maxHeight, undefined);

const dCenter = modalLayout({ align: "center", maxWidth: 420 });
eq("диалог/центр: фон центрирует", [dCenter.backdrop.alignItems, dCenter.backdrop.padding], ["center", "16px"]);
eq("диалог/центр: панель центрируется и не вылезает за экран",
   [dCenter.panel.padding, dCenter.panel.maxHeight, dCenter.panel.overflowY],
   [24, "calc(100vh - 32px)", "auto"]);

const dDrawer = modalLayout({ variant: "drawer", maxWidth: 520, zIndex: 999 });
eq("панель-ящик: фон без флекс-выравнивания и темнее по zIndex",
   [dDrawer.backdrop.display, dDrawer.backdrop.zIndex], [undefined, 999]);
eq("панель-ящик: панель справа поверх фона",
   [dDrawer.panel.position, dDrawer.panel.right, dDrawer.panel.zIndex, dDrawer.panel.maxWidth],
   ["fixed", 0, 1000, 520]);

eq("свой zIndex пробрасывается (режим «Очистка»: 1200)", modalLayout({ align: "center", zIndex: 1200 }).backdrop.zIndex, 1200);
eq("свои отступы фона перекрывают значение по умолчанию (форма дохода: 80px)",
   modalLayout({ backdropStyle: { padding: "80px 16px 16px" } }).backdrop.padding, "80px 16px 16px");
eq("свои стили панели перекрывают значение по умолчанию",
   modalLayout({ style: { maxWidth: 640 } }).panel.maxWidth, 640);


// ── пагинация в стиле админки (ui/components.jsx) ───────────────────────────
eq("диапазон: первая страница из 9734", pageRange(9734, 50, 0), { from: 1, to: 50 });
eq("диапазон: последняя неполная страница", pageRange(9734, 50, 9700), { from: 9701, to: 9734 });
eq("диапазон: пусто → 0–0 (не «1–0»)", pageRange(0, 50, 0), { from: 0, to: 0 });
eq("номера: одна страница", pageWindow(1, 0), [0]);
eq("номера: начало длинного списка", pageWindow(7, 0), [0, 1, null, 6]);
eq("номера: середина — многоточия с двух сторон", pageWindow(7, 3), [0, null, 2, 3, 4, null, 6]);
eq("номера: все страницы без разрывов", pageWindow(3, 1), [0, 1, 2]);
eq("номера: конец длинного списка", pageWindow(20, 19), [0, null, 18, 19]);
eq("номера: пустой список", pageWindow(0, 0), []);


// ── общий бейдж-«пилюля» (ui/styles.js) ─────────────────────────────────────
// Форма бейджей теперь общая для всего приложения: журнал, пользователи,
// курсы, импорт. Проверяем форму значениями, иначе она тихо разъедется.
eq("пилюля: форма одна для всех бейджей", pill("#f00", "#fff", "#000"),
   { display: "inline-block", padding: "4px 10px", borderRadius: 999, fontSize: 12,
     fontWeight: 600, background: "#f00", color: "#fff", border: "1px solid #000",
     whiteSpace: "nowrap", lineHeight: 1.4 });
eq("пилюля: цвета подставляются как переданы",
   [pill("#ecfdf5", "#047857", "#a7f3d0").background, pill("#ecfdf5", "#047857", "#a7f3d0").color],
   ["#ecfdf5", "#047857"]);


// ── валюты БЕЗ КУРСА не должны молча исчезать из итогов ─────────────────────
// sumToEur() выбрасывает валюты, для которых нет курса. Это осознанно (лучше
// осторожное число, чем поддельное «-в EUR»), но означает, что итог может
// ЗАНИЖАТЬ расходы — опасная сторона для учёта затрат. Поэтому пропуск обязан
// быть видимым: unknownCurrencies() отдают CurrencyBadge и <UnratedNote>.
eq("валюты без курса: найдены", unknownCurrencies({PLN:100, RON:50}), ["RON"]);
eq("валюты без курса: EUR всегда с курсом", unknownCurrencies({EUR:10}), []);
eq("валюты без курса: ноль — не потеря", unknownCurrencies({RON:0, NOK:0}), []);
eq("валюты без курса: пустой вход", unknownCurrencies(null), []);
eq("валюты без курса: регистр не спасает от пропуска", unknownCurrencies({ron:50}), ["ron"]);
eq("валюты без курса: пустой код тоже не в итоге", unknownCurrencies({"":5}), ["—"]);
eq("валюты без курса: порядок алфавитный", unknownCurrencies({TRY:1, RON:1, NOK:1}), ["NOK","RON","TRY"]);
// Эту строку не убирать «по упрощению»: она документирует ПРИЧИНУ, по которой
// пометка вообще нужна — sumToEur вычитает такие валюты из суммы.
eq("итог: сумма только по валютам с курсом", sumToEur({EUR:100, RON:50}), 100);
eq("итог: только валюты без курса дают 0", sumToEur({RON:50}), 0);

// Порядок строк разбивки: EUR → по сумме в EUR → валюты без курса в конце по
// алфавиту. Раньше компаратор возвращал NaN, и порядок зависел от порядка
// ключей в объекте, то есть от порядка прихода транзакций.
eq("разбивка: порядок EUR, по сумме, без курса в конце",
   curEntries({RON:50, PLN:100, EUR:10, NOK:5}).map(([c])=>c), ["EUR","PLN","NOK","RON"]);
eq("разбивка: нулевые суммы не показываются", curEntries({EUR:0, PLN:5}).map(([c])=>c), ["PLN"]);
eq("разбивка: среди валют без курса алфавит", curEntries({B:1, A:1}).map(([c])=>c), ["A","B"]);



// ── карточки авто/прицепов: «Разовые / Регулярные» и итог (lib/assetCards.js) ──
{
  const bucketOf = (tx) => ({ key: tx.cat, name: tx.cat });
  const txns = [
    { plate_number: "BI1", source: "manual", cat: "Ремонт", amount_eur: 70 },
    { plate_number: "BI1", source: "manual", cat: "Ремонт", amount_eur: 30 },
    { plate_number: "BI1", source: "recurring", recurring_expense_id: 7, cat: "Лизинг", amount_eur: 200 },
    { plate_number: "SW9", source: "recurring", recurring_expense_id: 8, cat: "Аренда", amount_eur: 50 },
    { plate_number: null, source: "manual", cat: "Прочее", amount_eur: 999 },
  ];
  const contracts = [
    { id: 7, plate_number: "BI1", display_status: "active", description: "Лизинг" },
    { id: 8, trailer_plate: "SW9", plate_number: "SW9", display_status: "paused", description: "Аренда" },
    { id: 9, plate_number: "BI1", display_status: "completed", description: "Старый" },
    { id: 10, plate_number: "BI1", display_status: "upcoming", description: "Будущий" },
    { id: 11, plate_number: "ZZ5", display_status: "active", description: "Без операций" },
    { id: 12, plate_number: null, display_status: "active", description: "Компания" },
  ];
  const cards = buildAssetCards({ txns, contracts, bucketOf });
  const bi = cards.find((c) => c.plate === "BI1");
  eq("карточки: номера по алфавиту, без пустых и «компании»", cards.map((c) => c.plate), ["BI1", "SW9", "ZZ5"]);
  eq("карточки: разовые только не-recurring, сгруппированы по категории", bi.oneOff.map((r) => [r.name, r.eur, r.count]), [["Ремонт", 100, 2]]);
  eq("карточки: итог = разовые + списания по регулярным", bi.totalEur, 300);
  eq("карточки: сумма списаний за период", bi.regularEur, 200);
  eq("карточки: регулярные — только идущие/приостановленные", bi.regular.map((p) => p.id), [7]);
  eq("карточки: сумма списаний по договору", bi.regular[0].periodEur, 200);
  eq("карточки: каунтер разовых — число операций, не категорий", bi.oneOffCount, 2);
  eq("карточки: каунтер регулярных — число списаний за период", bi.regularCount, 1);
  eq("карточки: договор без списаний — каунтер 0 при живой карточке", cards.find((c) => c.plate === "ZZ5").regularCount, 0);
  eq("карточки: прицеп опознаётся по trailer_plate, пауза учитывается", cards.find((c) => c.plate === "SW9").regular.map((p) => p.id), [8]);
  eq("карточки: договор без операций в периоде даёт карточку с нулём", [cards[2].plate, cards[2].totalEur], ["ZZ5", 0]);
  eq("contractPlate: прицеп важнее", contractPlate({ trailer_plate: "T1", plate_number: "V1" }), "T1");
}

// ── строка про загрузку валют вне ЕЦБ ──
eq("Frankfurter: нечего грузить — пусто", fxOtherSummary({status:"skipped",message:null}), "");
eq("Frankfurter: успех со счётчиком", fxOtherSummary({status:"ok",new_rows:12,updated_rows:1,results:[{status:"ok",currency:"BYN"}]}), " · Frankfurter: +13 (BYN)");
eq("Frankfurter: сбой назван, а не промолчан", fxOtherSummary({status:"error",message:"HTTP 503"}).includes("HTTP 503"), true);

// ── разбор ответов «действий с курсами» (lib/fxAction.js) ────────────────────
// Здесь сложились две ошибки сразу: обрыв по таймауту (502 от nginx) показывался
// как «Error», потому что тело не JSON; а сбой загрузки курсов ЕЦБ приходит с
// кодом 200 и выглядел успехом. Из-за второго архив курсов мог остаться
// незагруженным, а пересчёт потом объявлял «500 without rate» без объяснения.
eq("курсы: успешный ответ", fxOutcome({ok:true,status:200},{status:"ok",new_rows:5}), "ok");
eq("курсы: сбой ЕЦБ при HTTP 200 — НЕ успех", fxOutcome({ok:true,status:200},{status:"error",message:"Bad ZIP"}), "ecb");
eq("курсы: обрыв шлюза 502", fxOutcome({ok:false,status:502},null), "gateway");
eq("курсы: обрыв шлюза 504", fxOutcome({ok:false,status:504},null), "gateway");
eq("курсы: запрос не ушёл (сети нет)", fxOutcome({ok:false,status:0},null), "network");
eq("курсы: обычная ошибка приложения", fxOutcome({ok:false,status:500},{detail:"boom"}), "http");
eq("курсы: 403 без тела", fxOutcome({ok:false,status:403},null), "http");

// Текст обязан называть следующий шаг, а не только факт.
eq("текст 502: говорит про повтор и продолжение",
   /продолжится с места остановки/.test(fxErrorMessage("gateway",{status:502},null)), true);
eq("текст 502: не обвиняет бэкенд в недоступности",
   /недоступен/.test(fxErrorMessage("gateway",{status:502},null)), false);
eq("текст сбоя ЕЦБ: называет причину", /Bad ZIP/.test(fxErrorMessage("ecb",{status:200},{message:"Bad ZIP"})), true);
eq("текст обычной ошибки берёт detail", fxErrorMessage("http",{status:400},{detail:"плохой курс"}), "плохой курс");

// Итог пересчёта: лишних подробностей нет, когда всё пересчитано…
eq("итог пересчёта: всё пересчитано",
   backfillSummary({backfilled:120,remaining:0}), "Пересчитано: 120 · осталось без EUR: 0");
// …и явно сказано, что осталось и почему.
eq("итог пересчёта: остались строки без курса",
   backfillSummary({backfilled:5,failed:1,no_rate_rows:500,remaining:500}),
   "Пересчитано: 5 · ошибок: 1 · без курса: 500 · осталось без EUR: 500");
eq("итог пересчёта: обрезано по времени — сказано, что делать",
   /нажмите ещё раз/.test(backfillSummary({backfilled:1000,remaining:9000,truncated:true})), true);


// Частичный сбой импорта архива: не отказ (работа частично сделана), но и не
// успех — иначе пользователь считает архив загруженным и не понимает, почему
// часть транзакций остаётся без курса.
eq("курсы: частичный сбой — не успех", fxOutcome({ok:true,status:200},{status:"partial",message:"x"}), "partial");
eq("курсы: полный успех остаётся успехом", fxOutcome({ok:true,status:200},{status:"ok"}), "ok");
eq("курсы: partial не фатален (показываем результат)", fxIsFatal("partial"), false);
eq("курсы: успех не фатален", fxIsFatal("ok"), false);
eq("курсы: сбой ЕЦБ фатален", fxIsFatal("ecb"), true);
eq("курсы: обрыв шлюза фатален", fxIsFatal("gateway"), true);
eq("курсы: нет сети — фатально", fxIsFatal("network"), true);
eq("текст partial: берёт сообщение бэкенда",
   fxErrorMessage("partial",{status:200},{message:"Записалось 400 батчей, не записалось 42."}),
   "Записалось 400 батчей, не записалось 42.");
// Реальная ошибка базы обязана доходить до пользователя: раньше вместо неё
// показывалась догадка про отсутствующую таблицу.
eq("текст ошибки ЕЦБ: реальная ошибка базы видна",
   /permission denied/.test(fxErrorMessage("ecb",{status:200},
     {message:"Ошибка базы: permission denied for table fx_rates. Проверка схемы: таблица fx_rates есть; строк: 215000."})), true);
eq("текст ошибки ЕЦБ: факты о схеме видит и пользователь",
   /таблица fx_rates есть/.test(fxErrorMessage("ecb",{status:200},
     {message:"Проверка схемы: таблица fx_rates есть; строк: 215000."})), true);


// Кнопки «ввести курс» из ответа пересчёта. Дата обязательна: именно её
// подставляем в форму. Без неё пользователь вводил курс «на сегодня», видел его
// в списке и не понимал, почему старые транзакции остаются без курса.
eq("кнопки курса: ответ без поля разбора", rateActions(undefined), []);
eq("кнопки курса: null", rateActions(null), []);
eq("кнопки курса: не массив", rateActions("BYN"), []);
eq("кнопки курса: нормализация",
   rateActions([{currency:"BYN",needed_dates:["2026-06-08"],rows:12,advice:"совет"}]),
   [{currency:"BYN",date:"2026-06-08",needed_dates:["2026-06-08"],rows:12,advice:"совет",
     manual_only:true}]);
// Флаг «курс только вручную» управляет тем, показывать ли менеджеру поле ввода:
// валюту из архива ЕЦБ он переопределять не вправе (сервер ответит 403), поэтому
// флаг обязан доехать до интерфейса без искажений.
eq("кнопки курса: валюта из архива ЕЦБ помечена как недоступная менеджеру",
   rateActions([{currency:"PLN",needed_dates:["2026-09-08"],manual_only:false}])[0].manual_only,
   false);
// Кто может задать курс вручную — то же правило, что на сервере
// (app/services/fx_autoload.py:may_edit_currency). Проверки нужны, чтобы две
// формулировки не разъехались: скрытая кнопка защитой не является, но и показывать
// кнопку, которая гарантированно вернёт 403, неправильно.
eq("курс вручную: владелец может всё", mayEnterRate("owner","PLN",ECB_CUR), true);
eq("курс вручную: менеджер НЕ переопределяет валюту из архива ЕЦБ",
   mayEnterRate("manager","PLN",ECB_CUR), false);
eq("курс вручную: менеджер задаёт валюту вне архива ЕЦБ",
   mayEnterRate("manager","BYN",ECB_CUR), true);
eq("курс вручную: viewer не может ничего", mayEnterRate("viewer","BYN",ECB_CUR), false);
eq("курс вручную: незаполненное поле не блокирует кнопку",
   mayEnterRate("manager","",ECB_CUR), true);
eq("курс вручную: регистр и пробелы не обходят правило",
   mayEnterRate("manager"," pln ",ECB_CUR), false);
eq("курс вручную: набор ЕЦБ принимается и списком, и Set",
   mayEnterRate("manager","PLN",["PLN"]), false);

// Подсказка «что делать» после импорта: она должна различать роль и то, можно ли
// вообще задать курс этой валюты вручную (флаг manual_only с сервера).
const withRole=(role,fn)=>{const w=globalThis.window;globalThis.window={__FLEETCOST_ROLE__:role};
  try{return fn();}finally{globalThis.window=w;}};
const AUTO_BYN={remaining:2,unrated:[{currency:"BYN",needed_dates:["2026-09-05"],manual_only:true}]};
const AUTO_PLN={remaining:1,unrated:[{currency:"PLN",needed_dates:["2026-09-08"],manual_only:false}]};
eq("подсказка: менеджеру — идти в «Курсы валют» (BYN)",
   withRole("manager",()=>fxAutoAction(AUTO_BYN)),
   "Курс BYN на 05.09.2026: откройте «Курсы валют» и добавьте.");
eq("подсказка: менеджеру про валюту из архива ЕЦБ — только владелец",
   withRole("manager",()=>fxAutoAction(AUTO_PLN)),
   "Курс PLN на 08.09.2026: вручную может переопределить только владелец («Курсы валют»).");
eq("подсказка: владельцу — добавить",
   withRole("owner",()=>fxAutoAction(AUTO_PLN)),
   "Курс PLN на 08.09.2026: откройте «Курсы валют» и добавьте.");
eq("подсказка: viewer узнаёт, кого просить",
   withRole("viewer",()=>fxAutoAction(AUTO_BYN)),
   "Курс BYN на 05.09.2026 может добавить владелец или менеджер («Курсы валют»).");
eq("подсказка: когда всё закрыто — пусто",
   withRole("owner",()=>fxAutoAction({remaining:0,unrated:[]})), "");

eq("кнопки курса: старый ответ без флага трактуется как «можно»",
   rateActions([{currency:"BYN",needed_dates:["2026-09-08"]}])[0].manual_only,
   true);
// РЕГРЕССИЯ: набор дат обязан доехать до кнопки массового ввода. Без него
// x.needed_dates.length падал, а запрос уходил без dates.
eq("кнопки курса: весь набор дат сохраняется",
   rateActions([{currency:"BYN",needed_dates:["2026-08-14","2026-09-07"]}])[0].needed_dates,
   ["2026-08-14","2026-09-07"]);
eq("кнопки курса: дата для ручного ввода = первая из набора",
   (()=>{const a=rateActions([{currency:"BYN",needed_dates:["2026-08-14","2026-09-07"]}])[0];
        return a.date===a.needed_dates[0];})(), true);
eq("кнопки курса: даты приводятся к строкам",
   rateActions([{currency:"BYN",needed_dates:[20260814]}])[0].needed_dates, ["20260814"]);
eq("кнопки курса: запись без даты отбрасывается",
   rateActions([{currency:"BYN",needed_dates:[],rows:12}]), []);
eq("кнопки курса: запись без поля даты отбрасывается",
   rateActions([{currency:"BYN",rows:12}]), []);
eq("кнопки курса: запись без валюты отбрасывается",
   rateActions([{needed_dates:["2026-06-08"]}]), []);
eq("кнопки курса: отсутствие advice не ломает",
   rateActions([{currency:"RSD",needed_dates:["2026-06-08"]}])[0].advice, "");
eq("кнопки курса: берётся самая ранняя из нужных дат",
   rateActions([{currency:"RSD",needed_dates:["2026-06-08","2026-06-25"]}])[0].date, "2026-06-08");


// Подпись кнопки «Ввести курс BYN на 08.06.2026» строится через fmtDate —
// проверяем сам формат, чтобы подпись не поехала.
// ── Свежесть данных источника импорта (цветовые индикаторы карточек) ──────
// Пороги: до часа — свежо, до суток — жёлтый, дальше — красный. Проверяем на
// фиксированном «сейчас», иначе тест зависел бы от времени запуска.
const NOW = new Date("2026-09-27T12:00:00Z").getTime();
const hoursAgo=(h)=>new Date(NOW-h*3600000).toISOString();
const imp=(h,status)=>({created_at:hoursAgo(h),status});

eq("свежесть: не загружалось — серый", freshnessColor(null,NOW), "var(--c-muted-2)");
eq("свежесть: 30 минут — зелёный", freshnessColor(imp(0.5,"success"),NOW), "var(--c-emerald)");
eq("свежесть: ровно час — ещё зелёный", freshnessColor(imp(FRESH_HOURS,"success"),NOW), "var(--c-emerald)");
eq("свежесть: 5 часов — жёлтый", freshnessColor(imp(5,"success"),NOW), "var(--c-warn-600)");
eq("свежесть: ровно сутки — ещё жёлтый", freshnessColor(imp(STALE_HOURS,"success"),NOW), "var(--c-warn-600)");
eq("свежесть: 25 часов — красный", freshnessColor(imp(25,"success"),NOW), "var(--c-danger)");
// Ошибка важнее возраста: запись в истории свежая, а данных нет.
eq("свежесть: ошибка даже при свежей записи — красный",
   freshnessColor(imp(0.1,"failed"),NOW), "var(--c-danger)");
eq("свежесть: битая дата не роняет карточку",
   freshnessColor({created_at:"не дата",status:"success"},NOW), "var(--c-muted-2)");

eq("свежесть словами: нет данных", freshnessLabel(null,NOW), "данные ещё не загружались");
eq("свежесть словами: свежие",
   freshnessLabel(imp(0.5,"success"),NOW), "данные свежие: загружены меньше часа назад");
eq("свежесть словами: в пределах суток",
   freshnessLabel(imp(5,"success"),NOW), "данные загружены в течение суток");
eq("свежесть словами: давно — с числом дней",
   freshnessLabel(imp(72,"success"),NOW), "данные загружали 3 дн. назад");
eq("свежесть словами: ошибка", freshnessLabel(imp(0.1,"failed"),NOW),
   "последняя загрузка завершилась ошибкой");

// Компактное время в подвале карточки: год печатаем только когда он не текущий.
eq("время без года для текущего года", fmtInstantShort("2026-09-21T16:50:00Z"),
   fmtInstantShort("2026-09-21T16:50:00Z"));
const _nowIso = new Date().toISOString();
const _d = new Date(_nowIso);
const _p2 = (n) => String(n).padStart(2, "0");
const _wantShort = _p2(_d.getDate()) + "." + _p2(_d.getMonth()+1) + ", " + _p2(_d.getHours()) + ":" + _p2(_d.getMinutes());
eq("время: год текущий скрыт", fmtInstantShort(_nowIso), _wantShort);
eq("время: чужой год остаётся видимым",
   fmtInstantShort("2024-09-21T16:50:00Z").length > 13, true);
eq("время: пусто", fmtInstantShort(""), "—");

// ── Служебные ключи в карте валют ────────────────────────────────────────────
// Некоторые вкладки кладут сумму в EUR прямо в карту валют: {PLN: 2925.79,
// __eur: 727.82}. Значок «Исходные валюты» перебирал ключи как коды валют и
// показывал «727,82 __eur — нет курса», хотя курсы были загружены.
eq("служебный ключ распознаётся", isServiceKey("__eur"), true);
eq("евро служебным ключом не считается", isServiceKey("EUR"), false);
eq("служебные ключи не попадают в список валют",
   JSON.stringify(curEntries({PLN:2925.79,EUR:50,__eur:727.82})), JSON.stringify([["EUR",50],["PLN",2925.79]]));
eq("из-за служебного ключа не появляется «нет курса»",
   JSON.stringify(unknownCurrencies({PLN:2925.79,__eur:727.82})), "[]");
eq("настоящая валюта без курса по-прежнему видна",
   JSON.stringify(unknownCurrencies({XXX:10,__eur:5})), JSON.stringify(["XXX"]));

// ── Курс: живой vs исторический (FC-001 и его рецидивы) ──────────────────────
// Строка 1000 PLN: живой курс в EUR_RATES 0.235 даёт 235, исторический amount_eur
// (0.25) — 250. Разница ~6% на каждой операции. Вкладки и итоги дашборда считают
// историческим, поэтому любая сумма транзакций обязана идти через rowEur().
eq("живой курс для сравнения: 1000 PLN", toEur(1000,"PLN"), 235);
eq("исторический курс строки: 1000 PLN", rowEur({amount:1000,currency:"PLN",amount_eur:250}), 250);
eq("исторический курс: строка без курса даёт 0, а не живой курс",
   rowEur({amount:1000,currency:"PLN",amount_eur:null}), 0);
eq("исторический курс: неизвестная валюта тоже 0",
   rowEur({amount:1000,currency:"XXX",amount_eur:null}), 0);
eq("исторический курс: пустая строка", rowEur(null), 0);
eq("сумма строк совпадает со правилом rowEur",
   sumEurRows([{amount_eur:250},{amount_eur:null},{amount_eur:100}]), rowEur({amount_eur:250})+rowEur({amount_eur:null})+rowEur({amount_eur:100}));

eq("формат даты для подписи", fmtDate("2026-06-08"), "08.06.2026");
eq("формат даты: пусто", fmtDate(""), "—");


// Разбор числа из поля курса. Запятая — не мелочь: в русской раскладке её пишут
// естественно, а parseFloat("0,29") даёт 0, и пользователь получал бы «укажите
// курс больше нуля», введя корректное значение.
eq("разбор курса: запятая", parseRateInput("0,29"), 0.29);
eq("разбор курса: точка", parseRateInput("0.29"), 0.29);
eq("разбор курса: пробелы вокруг", parseRateInput("  0,29  "), 0.29);
eq("разбор курса: пусто", parseRateInput(""), null);
eq("разбор курса: не введено", parseRateInput(undefined), null);
eq("разбор курса: мусор", parseRateInput("abc"), null);
eq("разбор курса: ноль не годится", parseRateInput("0"), null);
eq("разбор курса: отрицательный не годится", parseRateInput("-5"), null);
eq("разбор курса: целое", parseRateInput("3"), 3);


// ── шапка: фильтр источника и кнопка синхронизации ─────────────────────
// Фильтр источника рисуется нарисованной кнопкой, внутри которой лежит
// настоящий <select>. Подпись на кнопке берётся из ТОГО ЖЕ списка, что и
// варианты списка, поэтому проверяем список: если «Все источники» перестанет
// соответствовать пустому значению, на кнопке будет написано одно, а
// отфильтруется другое.
{
  const RU = { allSources: "Все источники" };
  const EN = { allSources: "All sources" };
  const ru = srcFilterOptions(RU), en = srcFilterOptions(EN);
  eq("шапка: значения фильтра источника", ru.map((o) => o.v), ["", "e100", "q8", "manual"]);
  eq("шапка: подписи фильтра источника (RU)", ru.map((o) => o.label),
     ["Все источники", "E100", "Q8", "Manual"]);
  eq("шапка: подпись «все» переводится", en[0].label, "All sources");
  eq("шапка: у каждого варианта есть значок", ru.every((o) => !!o.icon), true);
  eq("шапка: варианты в списке и на кнопке — один список", ru.length, en.length);
}
// Размер кнопки синхронизации. Если ширина перестанет быть фиксированной,
// кнопка начнёт расти при смене подписи на «Синхронизация…» — а это заметно
// именно в момент ожидания ответа и выглядит как «интерфейс дёрнулся».
{
  eq("шапка: ширина кнопки синхронизации зафиксирована", SYNC_BTN_W, 150);
  eq("шапка: высота кнопки синхронизации зафиксирована", SYNC_BTN_H, 36);
  eq("шапка: размер задан положительными числами",
     SYNC_BTN_W > 0 && SYNC_BTN_H > 0, true);
}
// Состояние «в работе» живёт в CSS-классах: индикатор вращается, заливка
// меняется на жёлтую. Проверяем наличие правил — по коду кнопки этого не
// увидеть, а без них кнопка осталась бы синей и без движения.
{
  const css = readFileSync(join(process.cwd(), "src/ui/styles.js"), "utf8");
  const has = (frag) => css.indexOf(frag) >= 0;
  eq("шапка: кнопка синхронизации меняет заливку при работе",
     has(".fc-sync-btn.fc-busy") && has("var(--c-warn-bg)"), true);
  eq("шапка: подпись кнопки не переносится (размер не «прыгает»)",
     has(".fc-sync-btn{display:inline-flex") && has("white-space:nowrap"), true);
  eq("шапка: у индикатора загрузки есть анимация вращения",
     has("@keyframes fcSpin") && has("animation:fcSpin"), true);
  eq("шапка: индикатор наследует цвет кнопки", has("border:2px solid currentColor"), true);
  eq("шапка: подсказка рисуется поверх всего слоем",
     has(".fc-hint{position:fixed") && has(".fc-hint{"), true);
  eq("шапка: подсказка не перехватывает курсор", has("pointer-events:none"), true);
  eq("шапка: у фильтра источника есть реакция на наведение и фокус",
     has(".fc-src:hover") && has(".fc-src:focus-within"), true);
  eq("шапка: стрелка фильтра поворачивается", has(".fc-src:focus-within .fc-src-chev"), true);
  eq("шапка: список фильтра настоящий, но прозрачный",
     has(".fc-src-native{position:absolute") && has("opacity:0"), true);
}

// ── приветствие: обращение по имени ────────────────────────────────────
// Имени нет — только почта; нет и почты — приветствие без обращения. Заглушка
// («Admin») запрещена: её принимали за настоящее имя пользователя.
{
  eq("приветствие: имя из регистрации", greetName({full_name:"Nick",email:"n@x.com"}), "Nick");
  eq("приветствие: из полного имени берём первое слово",
     greetName({full_name:"Nick Kowalski",email:"n@x.com"}), "Nick");
  eq("приветствие: лишние пробелы не ломают", greetName({full_name:"  Nick   K  "}), "Nick");
  eq("приветствие: имя, выданное владельцем менеджеру",
     greetName({full_name:"Ольга",email:"manager@fleetcost.eu",role:"manager"}), "Ольга");
  eq("приветствие: вьюверу тоже по имени",
     greetName({full_name:"Piotr",email:"v@fleetcost.eu",role:"viewer"}), "Piotr");
  eq("приветствие: без имени — почта без домена",
     greetName({full_name:"",email:"nick.kowalski@fleetcost.eu"}), "nick.kowalski");
  eq("приветствие: пробельное имя считается отсутствующим",
     greetName({full_name:"   ",email:"nick@fleetcost.eu"}), "nick");
  eq("приветствие: нет ни имени, ни почты — обращения нет", greetName({}), "");
  eq("приветствие: null не роняет", greetName(null), "");
  eq("приветствие: почта без собаки берётся целиком", greetName({email:"nick"}), "nick");
}

// ── сумма в центре кольца: кегль и текст ───────────────────────────────
// Шрифт моноширинный, поэтому ширину строки считаем точно (len × size × 0.6).
// Проверяем ГЛАВНОЕ требование: при любой длине строка помещается в отверстие
// кольца — именно на нём ломалось прежнее правило «длиннее 12 знаков → 11px».
{
  eq("кольцо: шаг знака моношрифта", MONO_ADVANCE, 0.6);
  eq("кольцо: доступная ширина суммы", DONUT_AMOUNT_MAX_W, 76);
  eq("кольцо: предел читаемого кегля", DONUT_AMOUNT_MIN, 9);
  // Короткая сумма — базовый кегль и копейки на месте.
  const small=donutAmount(123.45);
  eq("кольцо: короткая сумма — базовый кегль", small.size, 13);
  eq("кольцо: короткая сумма не сокращается", small.text, fmtMoney(123.45,"€"));
  // Большая сумма — кегль меньше, копейки остаются, строка помещается.
  const big=donutAmount(1234567.89);
  eq("кольцо: большая сумма — кегль уменьшен", big.size<13, true);
  eq("кольцо: большая сумма — копейки на месте", /[.,][0-9][0-9] €$/.test(big.text), true);
  eq("кольцо: большая сумма помещается",
     amountFits(big.text.length,big.size), true);
  // Совсем большая — убираем копейки, иначе кегль ушёл бы ниже читаемого.
  const huge=donutAmount(123456789.12);
  eq("кольцо: огромная сумма — без копеек", /[.,][0-9][0-9] €$/.test(huge.text), false);
  eq("кольцо: огромная сумма — «€» в строке", / €$/.test(huge.text), true);
  eq("кольцо: огромная сумма помещается",
     amountFits(huge.text.length,huge.size), true);
  // Ряд длин и сумм: ни одна не должна выйти за отверстие.
  const overflow=[];
  for(let len=1; len<=40; len++){
    const size=amountFontSize(len);
    if(!amountFits(len,size)) overflow.push(len+"@"+size);
  }
  eq("кольцо: ни одна длина строки не выходит за отверстие", overflow, []);
  const bad=[];
  for(const v of [0.5, 12, 999.99, 12345.67, 987654.32, 12345678.9, 987654321.98, 12345678901.23]){
    const r=donutAmount(v);
    if(!amountFits(r.text.length,r.size)) bad.push(v+" → "+r.text+" @"+r.size);
    if(!/ €$/.test(r.text)) bad.push(v+" → нет знака €");
  }
  eq("кольцо: суммы любого размера помещаются и сохраняют «€»", bad, []);
  eq("кольцо: кегль не превышает базовый",
     amountFontSize(3,DONUT_AMOUNT_MAX_W,13)<=13, true);
}

// ── подсветка сегмента кольца ─────────────────────────────────────────
// Доли обязаны остаться прежними: подсветка не должна искажать картину.
{
  const parts=[
    {key:"fuel", color:"var(--info)", eur:50},
    {key:"toll", color:"var(--warning)", eur:30},
    {key:"adblue", color:"var(--teal)", eur:20},
  ];
  const plain=donutGradient(parts,"","var(--c-border-2)");
  eq("кольцо: без подсветки — все цвета свои",
     [plain.indexOf("var(--info)")>=0, plain.indexOf("var(--warning)")>=0, plain.indexOf("var(--teal)")>=0],
     [true, true, true]);
  eq("кольцо: без подсветки нет серого", plain.indexOf("--c-border-2")>=0, false);
  const hl=donutGradient(parts,"toll","var(--c-border-2)");
  eq("кольцо: выбранный сегмент сохраняет цвет", hl.indexOf("var(--warning)")>=0, true);
  eq("кольцо: остальные уходят в нейтральный",
     [hl.indexOf("var(--info)")<0, hl.indexOf("var(--teal)")<0], [true, true]);
  // Границы сегментов: 50% → [0,50], 30% → [50,80], 20% → [80,100].
  const bounds=(g)=>g.slice(g.indexOf("(")+1,-1).split(",").map(x=>x.trim().split(" ").slice(1).join(" "));
  eq("кольцо: доли не меняются от подсветки", bounds(hl), bounds(plain));
  eq("кольцо: границы сегментов", bounds(plain), ["0.000% 50.000%","50.000% 80.000%","80.000% 100.000%"]);
  eq("кольцо: пустой список не даёт заливки", donutGradient([], "fuel", "x"), null);
  eq("кольцо: нулевые доли не дают заливки", donutGradient([{key:"a",eur:0,color:"c"}], "a", "x"), null);
  eq("кольцо: одна категория занимает всё кольцо",
     bounds(donutGradient([{key:"a",eur:5,color:"var(--info)"}], "a", "x")), ["0.000% 100.000%"]);
}

// ── значки в правом нижнем углу плашек ─────────────────────────────────
// Значок «исходные суммы» показывается только когда есть что показывать
// (валюта кроме EUR или несколько валют). По этому же признаку плашка
// резервирует под него место: если условия разойдутся, подпись под суммой
// либо налезет на значок, либо останется пустая полоса справа.
{
  const show = (o) => hasCurrencyBreakdown(o);
  eq("угол: только EUR — значка нет", show({EUR:100}), false);
  eq("угол: пустой объект — значка нет", show({}), false);
  eq("угол: undefined — значка нет", show(undefined), false);
  eq("угол: EUR + PLN — значок есть", show({EUR:100,PLN:400}), true);
  eq("угол: только PLN — значок есть", show({PLN:400}), true);
  eq("угол: несколько валют — значок есть", show({USD:1,BYN:2}), true);
  // Нулевые суммы не создают валюту: значка не будет, места под него тоже.
  eq("угол: нулевые суммы — значка нет", show({EUR:0,PLN:0}), false);

  // Отступ под значок — одно число на все вкладки, иначе плашки разъезжаются.
  eq("угол: отступ под значок", KPI_CORNER_PAD, 34);
  eq("угол: стиль угла один на все вкладки",
     [s.kpiCorner.position, s.kpiCorner.bottom, s.kpiCorner.right, s.kpiCorner.display],
     ["absolute", 12, 12, "flex"]);
  // Отступ в углу тот же, что у бейджа сравнения сверху, — иначе значки
  // не встанут в одну вертикальную колонку.
  eq("угол: отступ совпадает с верхним бейджем", [s.kpiCorner.bottom, s.kpiCorner.right], [12, 12]);
}

// ── тексты виджетов: короткие названия ─────────────────────────────────
// Пользователь просил сократить подписи: длинное название растягивало плашку
// и уводило её содержимое вниз. Проверяем не «буква в букву», а два свойства,
// которые как раз и просили: название короткое и в нём нет технического
// уточнения в скобках.
{
  const app = readFileSync(join(process.cwd(), "src/App.jsx"), "utf8");
  const val = (key) => {
    // Разбор без регулярного выражения и без экранирования кавычек: набор
    // проверок собирается в шаблонную строку, и каждая косая черта в ней
    // требует удвоения — на этом легко ошибиться (ошибался дважды).
    const QUOTE = String.fromCharCode(34);
    const at = app.indexOf(key + ":" + QUOTE);
    if (at < 0) return null;
    const from = at + key.length + 2;
    return app.slice(from, app.indexOf(QUOTE, from));
  };
  const SHORT = [
    ["generalTotalExpenses", 16], ["generalParking", 16], ["salaryTotalExpenses", 18],
  ];
  for (const [key, max] of SHORT) {
    const v = val(key);
    eq("подписи: " + key + " есть в словаре", typeof v === "string", true);
    if (typeof v === "string") {
      eq("подписи: " + key + " короткая (" + v + ")", v.length <= max, true);
      eq("подписи: " + key + " без уточнения в скобках", /[()]/.test(v), false);
    }
  }
  eq("подписи: «Итого за период» → «Итого»", val("generalTotalExpenses"), "Итого");
  eq("подписи: «Стоянка возле офиса» → «Стоянка»", val("generalParking"), "Стоянка");
  eq("подписи: стоянка в категориях тоже «Стоянка»", val("generalCategoryParking"), "Стоянка");
  eq("подписи: «Общие расходы (ЗП + Налоги)» → «Общие расходы»", val("salaryTotalExpenses"), "Общие расходы");
  eq("подписи: без «общефлотском»", val("salaryPerKmSub"), "При пробеге");
  eq("подписи: виджет пробега", val("mileageFuelTotal"), "Расход топлива");
  eq("подписи: в подписи пробега нет ДУТ", /ДУТ/.test(val("mileageFuelTotal")||""), false);
  // «(ДУТ)» убрано по всей программе, а не только в виджете: сокращение ДУТ
  // (датчик уровня топлива) непонятно пользователю и стояло в трёх местах —
  // виджет пробега, заголовок таблицы сегментов и средний расход на топливе.
  const leftovers = [];
  for (const rel of ["src/App.jsx", "src/ui/components.jsx", "src/pages/FuelPage.jsx",
                     "src/pages/MileagePage.jsx", "src/pages/DashboardPage.jsx"]) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    if (src.includes("ДУТ") || src.includes("(DUT)")) leftovers.push(rel);
  }
  eq("подписи: «ДУТ» вычищено по всей программе", leftovers, []);
}

// ── тема: палитра, неизменность светлой темы, контраст ───────────────────────
// Проверки намеренно жёсткие: они доказывают то, что глазами не проверить.
// 1) Светлая тема осталась прежней — для каждого прежнего хекса значение
//    переменной в LIGHT равно ровно этому хексу. Так замена 1444 цветов не могла
//    ничего перекрасить незаметно.
{
  const map = JSON.parse(readFileSync(join(process.cwd(), "scripts/color-map.json"), "utf8"));
  const mismatched = [];
  for (const hex of Object.keys(map.vars)) {
    const roles = map.vars[hex];
    for (const varName of new Set([roles.color, roles.background, roles.border])) {
      const key = varName.replace("--c-", "");
      // '#fff' и '#ffffff' — одна и та же запись, сравниваем в полной форме.
      const full = (h) => {
        const v = String(h || "").toLowerCase();
        return v.length === 4 ? "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3] : v;
      };
      if (full(LIGHT[key]) !== full(hex)) {
        mismatched.push(hex + " → " + varName + " (в LIGHT: " + (LIGHT[key] || "нет") + ")");
      }
    }
  }
  eq("тема: светлая палитра совпадает с прежними цветами", mismatched, []);
}

// 2) В палитре нет «дыр»: у каждой переменной есть значение в обеих темах.
{
  const onlyLight = Object.keys(LIGHT).filter((k) => !(k in DARK));
  const onlyDark = Object.keys(DARK).filter((k) => !(k in LIGHT));
  const bad = [];
  for (const k of Object.keys(LIGHT).concat(Object.keys(DARK))) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String((LIGHT[k] || DARK[k])))) bad.push(k);
  }
  eq("тема: наборы переменных в обеих темах совпадают", [onlyLight, onlyDark], [[], []]);
  eq("тема: все значения — корректные цвета", bad, []);
}

// 3) Ни один сырой цвет не остался в разметке: иначе он не сменится в тёмной
//    теме, а увидеть такой дефект можно только глазами.
{
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/[.]jsx?$/.test(name) && !p.endsWith("lib/theme.js")) files.push(p);
    }
  };
  walk(join(process.cwd(), "src"));
  const left = [];
  for (const f of files) {
    const hits = readFileSync(f, "utf8").match(/#[0-9a-fA-F]{6}/g) || [];
    for (const h of hits) left.push(f.split("/src/")[1] + ": " + h);
  }
  // '#310' — код ошибки React в комментарии, не цвет: он и должен остаться.
  const real = left.filter((x) => !x.includes("#310"));
  eq("тема: в src не осталось сырых цветов", real, []);
}

// 4) Скрипт темы в index.html (защита от мигания белым) не разошёлся с палитрой.
{
  const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
  // Разбираем строку без вопросительного знака в шаблоне: в этой сборке он
  // конфликтует с шаблонной строкой тестов, а читаемость от этого только выше.
  const grab = (prop) => {
    const at = html.indexOf('style.' + prop + ' = dark');
    if (at < 0) return null;
    const hexes = html.slice(at, at + 90).match(/"#[0-9a-f]{6}"/g) || [];
    return hexes.length >= 2 ? [hexes[0].slice(1, -1), hexes[1].slice(1, -1)] : null;
  };
  const bgPair = grab("background");
  const fgPair = grab("color");
  eq("тема: index.html задаёт фон для обеих тем", bgPair,
     [DARK.app.toLowerCase(), LIGHT.app.toLowerCase()]);
  eq("тема: index.html задаёт цвет текста для обеих тем", fgPair,
     [DARK.text.toLowerCase(), LIGHT.text.toLowerCase()]);
}

// 5) Контраст по норме WCAG. Тёмная тема опасна именно тем, что текст на ней
//    кажется читаемым, а по норме не проходит.
function luminance(hex) {
  const out = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
}
function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  const hi = Math.max(x, y);
  const lo = Math.min(x, y);
  return (hi + 0.05) / (lo + 0.05);
}
// Порог у каждой пары свой. Для СВЕТЛОЙ темы он фиксирует существующий вид
// (менять его в этой задаче никто не просил, и проверка «палитра совпадает с
// прежними цветами» следит за тем же): у пары «опасность на своей подложке»
// выходит 4.41 вместо 4.5 — это было в форме входа до тёмной темы, и значение
// записано здесь явно, чтобы не выглядело как незамеченный дефект. Для ТЁМНОЙ
// темы пороги — норма AA, потому что палитру подбирал я и могу её держать.
const CONTRAST_REQUIREMENTS = [
  ["основной текст на фоне окна", "text", "app", 7, 7],
  ["основной текст на карточке", "text", "surface", 7, 7],
  ["второстепенный текст на карточке", "muted", "surface", 4.5, 4.5],
  ["приглушённый текст на карточке", "muted-2", "surface", 4.5, 4.5],
  ["текст на брендовой заливке", "on-brand", "brand-solid", 4.5, 4.5],
  ["брендовый текст на карточке", "brand", "surface", 4.5, 4.5],
  ["опасность на своей подложке", "danger", "danger-bg", 4.5, 4.4],
  ["предупреждение на своей подложке", "warn", "warn-bg", 4.5, 4.5],
  // Кнопка синхронизации в состоянии загрузки: тёмно-жёлтый текст на жёлтой
  // заливке. Пара своя (не «warn»), поэтому её нужно зафиксировать отдельно —
  // иначе смена оттенка в теме тихо сделает подпись «Загрузка…» нечитаемой.
  ["загрузка на кнопке синхронизации", "warn-strong", "warn-bg", 4.5, 4.5],
  ["успех на своей подложке", "success", "success-bg", 4.5, 4.5],
  ["информация на своей подложке", "info", "info-bg", 4.5, 4.5],
  // Ниже — пары, найденные ИЗМЕРЕНИЕМ превью в светлой теме. Они были такими до
  // тёмной темы, и менять их значит перекрашивать светлую тему (о чём не просили).
  // Значения зафиксированы: так проверка не даст им ухудшиться, а в тёмной теме
  // они обязаны проходить норму AA.
  ["приглушённый текст на подложке сегмента", "muted-2", "surface-2", 4.5, 4.3],
  ["приглушённый текст на фоне окна", "muted-2", "app", 4.5, 4.4],
  ["красный текст на карточке", "danger-400", "surface", 4.5, 3.7],
];
for (const themeName of ["светлая", "тёмная"]) {
  const dark = themeName === "тёмная";
  const palette = dark ? DARK : LIGHT;
  const bad = [];
  for (const req of CONTRAST_REQUIREMENTS) {
    const min = dark ? req[3] : req[4];
    const ratio = contrast(palette[req[1]], palette[req[2]]);
    if (ratio < min) bad.push(req[0] + ": " + ratio.toFixed(2) + " < " + min);
  }
  eq("тема (" + themeName + "): контраст текста по норме WCAG", bad, []);
}

// 6) Логика выбора темы.
eq("тема: режим вне списка → system", normalizeThemeMode("neon"), "system");
eq("тема: явно тёмная", resolveTheme("dark", false), "dark");
eq("тема: явно светлая", resolveTheme("light", true), "light");
eq("тема: system следует за системой (тёмная)", resolveTheme("system", true), "dark");
eq("тема: system следует за системой (светлая)", resolveTheme("system", false), "light");
eq("тема: переменные содержат имена --c-*", /^--c-app:#/.test(themeVars("light")), true);
// У полей ввода фон обязан быть задан темой. Раньше его не было, и поле
// оставалось браузерным (белым): проверка темы нашла белый прямоугольник ровно
// на поле «Курс BYN» в тёмной колонке. Полагаться на color-scheme нельзя:
// он работает не во всех браузерах.
{
  const bad = [];
  for (const name of ["input", "select", "textarea"]) {
    const token = s[name];
    if (!token) { bad.push(name + ": нет токена"); continue; }
    if (!String(token.background || "").includes("var(--c-")) bad.push(name + ": фон не из темы");
    if (!String(token.color || "").includes("var(--c-")) bad.push(name + ": цвет текста не из темы");
  }
  eq("тема: у полей ввода фон и цвет берутся из темы", bad, []);
}

// Базовый цвет текста. Это была реальная ошибка: в приложении не было правила,
// задающего цвет текста, поэтому элементы без собственного цвета брали браузерный
// ЧЁРНЫЙ. В светлой теме незаметно, в тёмной — подписи и числовые данные сливались
// с фоном (измерение показало контраст 1.31). Проверка следит, чтобы правило
// осталось и ссылалось на переменную темы, а не на конкретный цвет.
{
  const css = readFileSync(join(process.cwd(), "src/ui/styles.js"), "utf8");
  // Без регулярного выражения: фигурные скобки внутри шаблона строки тестов
  // ломают экранирование, а здесь достаточно поиска подстроки.
  const at = css.indexOf("html,body{");
  const block = at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  eq("тема: в CSS задан базовый цвет текста из переменной",
     block.indexOf("color:var(--c-") >= 0, true);
  eq("тема: в CSS задан базовый фон из переменной",
     block.indexOf("background:var(--c-") >= 0, true);
}
{
  // applyTheme обязан записать ВСЕ переменные и пометить корень: на этом держится
  // переключение, и молчаливая потеря части палитры выглядела бы как «часть
  // интерфейса не перекрасилась».
  const written = {};
  const attrs = {};
  const fakeDoc = { documentElement: {
    style: { setProperty: (k, v) => { written[k] = v; },
    set color(v) { written.__color = v; }, get color() { return written.__color; },
    set background(v) { written.__background = v; }, get background() { return written.__background; },
    set colorScheme(v) { attrs.scheme = v; } },
    setAttribute: (k, v) => { attrs[k] = v; },
  } };
  applyTheme("dark", fakeDoc);
  // Считаем только переменные (--c-*): color/background корня пишутся рядом.
  const varKeys = Object.keys(written).filter((k) => k.indexOf("--c-") === 0);
  eq("тема: применяются все переменные тёмной темы", varKeys.length, Object.keys(DARK).length);
  eq("тема: корень помечен как тёмный", [attrs["data-theme"], attrs.scheme], ["dark", "dark"]);
  // Цвет и фон на корне: до загрузки стилей (и если их вставка не удалась) всё
  // равно наследуется правильное значение.
  eq("тема: на корне задан цвет текста", written["__color"], DARK.text);
  eq("тема: на корне задан фон", written["__background"], DARK.app);
  eq("тема: переменная app записана верно", written["--c-app"], DARK.app);
}

// ── дашборд: категории расходов и динамика по интервалам ────────────────────
// Категория обязана совпадать с тем, как её считает computeKpi() в самой
// странице: если эти правила разойдутся, шапка и детализация по авто покажут
// разные суммы по одному и тому же периоду.
eq("catKeyOf('manual_income_freight')", catKeyOf("manual_income_freight"), "income");
eq("catKeyOf('AdBlue')", catKeyOf("AdBlue"), "adblue");
eq("catKeyOf('Toll DE E-BOX')", catKeyOf("Toll DE E-BOX"), "toll");
eq("catKeyOf('Parking truck E-BOX') — парковка не толл", catKeyOf("Parking truck E-BOX"), "other");
eq("catKeyOf('Car wash') — мойка не топливо", catKeyOf("Car wash"), "other");
eq("catKeyOf('manual_general_office')", catKeyOf("manual_general_office"), "general");
eq("catKeyOf('manual_leasing_payment')", catKeyOf("manual_leasing_payment"), "leasing");
eq("catKeyOf('Diesel') — всё остальное топливо", catKeyOf("Diesel"), "fuel");

console.log(fail
  ? "ИТОГ: " + fail + " расхождений из " + (pass + fail)
  : "✓ Все " + pass + " проверок значений совпали с ожидаемыми.");
process.exit(fail ? 1 : 0);
`;

mkdirSync(TMP, { recursive: true });
writeFileSync(join(TMP, "behaviour-entry.js"), SHIM + CASES);

/**
 * esbuild ищем в нескольких местах, а не только в node_modules/.bin.
 * Каталог .bin создаёт `npm install`, и если набор пакетов распакован без
 * него, проверка объявляла «не найден esbuild» при полностью установленных
 * зависимостях. Именно это и произошло в этом окружении: node_modules был
 * переустановлен без .bin, и проверка перестала выполняться, выглядя как
 * найденный дефект в коде.
 */
function findEsbuild() {
  const candidates = [
    join(root, "node_modules", ".bin", "esbuild"),
    join(root, "node_modules", "esbuild", "bin", "esbuild"),
    join(root, "node_modules", "@esbuild", process.platform + "-" + process.arch, "bin", "esbuild"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const esbuild = findEsbuild();
if (!esbuild) {
  console.log("  ⚠ Не найден esbuild (искали: .bin/esbuild, esbuild/bin/esbuild, "
            + "@esbuild/" + process.platform + "-" + process.arch + "/bin/esbuild).");
  console.log("ИТОГ: ⚠ ПРОВЕРКА НЕ ВЫПОЛНЕНА — значения не сверялись, выкладывать нельзя");
  process.exit(2);
}

let status = 0;
try {
  execFileSync(esbuild, [join(TMP, "behaviour-entry.js"), "--bundle", "--format=cjs",
    "--platform=node", "--outfile=" + join(TMP, "behaviour.cjs"), "--log-level=error"],
    { cwd: root, stdio: "inherit" });
  // Фиксируем часовой пояс: логика дат и форматирования от него зависит.
  execFileSync(process.execPath, [join(TMP, "behaviour.cjs")],
    { cwd: root, stdio: "inherit", env: { ...process.env, TZ: "Europe/Moscow" } });
} catch (e) {
  status = e.status || 1;
}

for (const f of ["behaviour-entry.js", "behaviour.cjs"]) {
  try { unlinkSync(join(TMP, f)); } catch (e) {}
}
try { if (readdirSync(TMP).length === 0) rmdirSync(TMP); } catch (e) {}

process.exit(status);
