/** Классификация транзакций: топливо/AdBlue/платные дороги/доходы/зарплата
 *  и статус строки (OK / Delayed / Blocked).
 *  Вынесено из App.jsx — это доменная логика учёта, её полезно тестировать
 *  отдельно от разметки. */
/** Строка пришла из внешнего источника (e100/q8/импорт), а не создана человеком. */
export function isExternalSrc(ft){return !/^manual_/i.test(ft||"");}
// Ключевые слова e100 — только для строк e100. Пользователь вправе назвать свою
// категорию «Toll insurance» или «Software subscription», и тогда fuel_type
// получается `manual_insurance_toll` / `manual_general_software_subscription`.
// Поиск подстроки по всему fuel_type отправлял такие расходы в «Платные дороги»
// и в «сервисные сборы» — то есть в чужой раздел и в чужие итоги.
export function isSvcFee(ft){return isExternalSrc(ft)&&/сервисный сбор|service fee|agency fee|commission fee|fee$|subscription|абонент/i.test(ft||"");}
// ── Centralized e100 category map ──
// Instead of scattering regex across isToll/isAdBlue/isCarWash/isParking,
// we have ONE place that maps e100 ftype strings to categories.
// This makes it easy to add new e100 services without breaking classification.
//
// Architecture note: Ideally this should be a DB column `source_category`
// populated by the scraper, with a separate `expense_categories` table.
// For now, this centralized map is a pragmatic improvement over scattered regex.
// To add a new e100 service, just add it to the right category array below.

export function isToll(ft){
  if(isParking(ft)) return false;  // parking takes precedence
  return _e100CategoryMatches(ft, "TOLL") && !isSvcFee(ft);
}

// Ручной AdBlue хранится как `manual_adblue`. Сопоставление по подстроке для
// manual_* отключено намеренно (см. _e100CategoryMatches), поэтому ручную запись
// узнаём по точному префиксу — иначе она не видна ни на странице AdBlue, ни на
// странице «Топливо», а на дашборде попадает в «Топливо».
export function isAdBlue(ft){return /^manual_adblue/i.test(ft||"")||_e100CategoryMatches(ft, "ADBLUE");}

export function isSalary(ft){return /manual_salary/.test(ft||"");}

export function isIncome(ft){return /^manual_income/.test(ft||"");}

export function txStatus(tx){
  if(!tx.is_confirmed) return {icon:"🔴",label:"Blocked"};
  if(tx.transaction_date&&tx.inserted_at_source){
    const h=(new Date(tx.inserted_at_source)-new Date(tx.transaction_date))/3600000;
    if(h>24) return {icon:"🟡",label:"Delayed"};
  }
  return {icon:"🟢",label:"OK"};
}

export function _e100CategoryMatches(ftype, category) {
  const ft = (ftype || "").toLowerCase();
  // См. isSvcFee: сопоставление по подстроке допустимо ТОЛЬКО для внешних строк.
  // Для ручных и регулярных расходов раздел берётся из справочника категорий
  // (category_id → section), а не угадывается по названию.
  if (ft.startsWith("manual_")) return false;
  return E100_CATEGORY_MAP[category].some(kw => ft.includes(kw));
}
// Parking check MUST happen before Toll, because "Parking truck E-BOX (FR)"
// contains "e-box" (which would match TOLL) but is actually a PARKING expense.

export function isParking(ft){return _e100CategoryMatches(ft, "PARKING");}
// isToll: matches motorway/highway tolls, electronic toll systems, tunnels.
// Excludes parking (checked separately, takes precedence).

export function isCarWash(ft){return _e100CategoryMatches(ft, "CAR_WASH");}
// isOther: manual other expenses (fines/parking/repair/other) AND e100 car wash
// AND e100 parking (e.g. "Parking truck E-BOX (FR)"). All of these belong to
// the "Иные расходы" category for KPI/dashboard purposes — they are NOT fuel,
// NOT toll, NOT adblue.

export const E100_CATEGORY_MAP = {
  TOLL: [
    "toll", "дороги", "motorway", "highway", "e-box", "ebox", "viapass",
    "tunnel", "liefken", "autobahn", "péage", "pedaggio", "maut",
    // NOTE: "parking" is NOT here — parking transactions (even with E-BOX)
    // belong to PARKING, checked BEFORE TOLL.
  ],
  ADBLUE: ["adblue", "ad blue", "адблу", "адблю", "разливное"],
  CAR_WASH: ["car wash", "carwash", "myjnia", "mycie"],
  PARKING: ["parking", "parking truck", "parkowanie", "postój"],
  SVC_FEE: ["сервисный сбор", "service fee", "agency fee", "commission fee", "subscription", "абонент"],
};

export function isOther(ft){return /^manual_other|^manual_fine|^manual_parking|^manual_repair/.test(ft||"")||isCarWash(ft)||isParking(ft);}
export function isInsurance(ft){return /^manual_insurance/.test(ft||"");}
export function isLeasing(ft){return /^manual_leasing/.test(ft||"");}
export function isTrailer(ft){return /^manual_trailer/.test(ft||"");}
export function isGeneral(ft){return /^manual_general/.test(ft||"");}
export function isFuel(ft,src,plate){
  if(src==="csv_income") return false;
  if(src==="manual") return /^manual_fuel/.test(ft||"");
  // Recurring-source transactions (leasing, trailer, insurance, general) are
  // NEVER fuel — they belong to their own tabs. Without this check, leasing
  // and trailer transactions would pollute the Fuel page and inflate the
  // vehicle count on the dashboard.
  if(src==="recurring") return false;
  // Manual-category transactions (salary, other, insurance, leasing, trailer,
  // general, income) entered via the various expense forms are also not fuel.
  // isOther now also matches e100 car wash — so car wash is NOT fuel.
  // isParking matches e100 "Parking truck E-BOX" — so parking is NOT fuel.
  if(isSalary(ft)||isOther(ft)||isParking(ft)||isInsurance(ft)||isLeasing(ft)||isTrailer(ft)||isGeneral(ft)||isIncome(ft)) return false;
  if(isToll(ft)||isAdBlue(ft)||isSvcFee(ft)) return false;
  return true;
}
export function isManual(src){return src==="manual"||src==="csv_income"||src==="recurring";}
// Extract the set of trailer plates from a transaction batch.
// Trailers are NOT vehicles — they must be excluded from the "active vehicles"
// count on every page, otherwise they inflate the redistribution denominator.
/**
 * Активные авто для перераспределения расходов (общих, прицепных, страховых).
 *
 * Основной источник — пробег за период: если машина ездила, она есть в
 * `/mileage/stats`. Но если пробег за период вообще не ведут, список активных
 * оказывается ПУСТЫМ, и распределение не происходит совсем: расходы прицепов
 * (и общие) просто висят нераспределёнными, хотя баннер обещает деление.
 *
 * Поэтому при пустом пробеге активными считаются машины, у которых есть
 * операции в этом периоде — так решил пользователь. Правило одно на все
 * страницы, иначе одинаковые цифры считались бы по-разному на каждой вкладке.
 */
export const ALLOCATION_EXCLUDED_PLATES = ["TRUCK", "Unknown"];

export function activePlatesForAllocation({
  mileageByVehicle = {},
  operationPlates = [],
  trailerPlates = new Set(),
  excludedPlates = ALLOCATION_EXCLUDED_PLATES,
} = {}) {
  // Принимаем и Set, и массив: один источник приходит из extractTrailerPlates
  // (Set), другой может прийти списком — падать на этом не должно.
  const excluded = excludedPlates instanceof Set ? excludedPlates : new Set(excludedPlates);
  const trailers = trailerPlates instanceof Set ? trailerPlates : new Set(trailerPlates || []);
  const usable = (p) => Boolean(p) && !excluded.has(p) && !trailers.has(p);

  const byMileage = Object.entries(mileageByVehicle || {})
    .filter(([p, km]) => Number(km) > 0 && usable(p))
    .map(([p]) => p);
  const source = byMileage.length ? byMileage : (operationPlates || []).filter(usable);
  return Array.from(new Set(source)).sort();
}

export function extractTrailerPlates(allTxns){
  const s=new Set();
  (allTxns||[]).forEach(tx=>{
    if(isTrailer(tx.fuel_type)&&tx.plate_number) s.add(tx.plate_number);
  });
  return s;
}
