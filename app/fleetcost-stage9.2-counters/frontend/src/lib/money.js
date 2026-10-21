import { API, CLIENT_ID } from "./api.js";

// Issue #3: EUR conversion rates.
//
// This is the FALLBACK rate dictionary — used only until the backend's
// /api/fx-rates/sync endpoint has populated the fx_rates table. Once
// the app boots, _loadLiveFxRates() overrides these with the actual
// server-side rates (sourced from the European Central Bank daily).
//
// CRITICAL FIX (was a serious financial bug): unknown currencies used
// to silently fall through with `|| 1` — meaning 1000 NOK (not in the
// dict) was treated as 1000 EUR. Now unknown currencies return NaN,
// which forces the caller's .toFixed() to render "NaN" instead of an
// inflated fake-EUR figure.
export const EUR_RATES = {EUR:1,PLN:0.235,CZK:0.040,HUF:0.0026,GBP:1.15,USD:0.92,CHF:1.08,SEK:0.088,DKK:0.134,LU:1,LUF:1,BYN:0.29};
export function toEur(amount,currency){
  if(!currency) return NaN;
  const c = currency.toUpperCase();
  if(c === "EUR") return amount;
  const rate = EUR_RATES[c];
  if(rate === undefined || rate === null) return NaN;  // unknown currency — DO NOT silently default to 1
  return amount * rate;
}
/** Сумма в EUR по ИСТОРИЧЕСКОМУ курсу: складывает amount_eur строк.

    Раньше вкладки («Топливо», «Платные дороги», «AdBlue», «Доходы») считали
    итог как sumToEur(byCur) — то есть по ТЕКУЩИМ курсам из таблицы выше, и их
    суммы расходились с дашбордом, который считает по сохранённому курсу на дату
    операции (FC-001 в аудите). Строки без курса (amount_eur = null) в сумму не
    входят — ровно как в итогах дашборда, чтобы числа совпадали.
 */
export const sumEurRows=(rows)=>(rows||[]).reduce((s,tx)=>s+Number(tx.amount_eur||0),0);

/** EUR ОДНОЙ строки по историческому курсу (amount_eur).

    Замена `toEur(tx.amount, tx.currency)` везде, где складываются ТРАНЗАКЦИИ:
    toEur считает по текущему курсу из EUR_RATES выше и потому расходится с
    вкладками и итогами дашборда, которые берут сохранённый курс на дату операции
    (FC-001). Одна и та же строка, посчитанная двумя способами, давала в карточках
    «Топливо» и в раскрытой строке «Финансы по авто» разные суммы — при живом курсе
    PLN 0.235 против исторического 0.25 расхождение ~6% на каждой операции.

    Строки без курса дают 0 — ровно как в sumEurRows, поэтому числа совпадают
    везде, где суммируются одни и те же строки.
 */
export const rowEur=(tx)=>Number(tx?.amount_eur||0);

export function sumToEur(byCur){
  // Sum every currency we HAVE a rate for. Returns a plain number so the ~40
  // call sites (KPI cards, chart legends, per-vehicle tables) stay unchanged.
  //
  // ВАЖНО: валюты без курса в сумму НЕ входят, то есть итог полон ровно
  // настолько, насколько полон EUR_RATES. Это сделано осознанно (лучше
  // осторожное число, чем поддельное «-в EUR», см. toEur), но означает, что
  // итог может ЗАНИЖАТЬ расходы — а для учёта затрат это опасная сторона.
  // Поэтому UI обязан показывать, что именно не попало в сумму: см.
  // unknownCurrencies() — его используют CurrencyBadge и <UnratedNote>.
  //
  // Прежний комментарий здесь утверждал, что неизвестные валюты «копятся
  // отдельно, чтобы предупредить пользователя». Это было неправдой: кроме
  // суммы функция ничего не возвращала, и ни одна страница ни о чём не
  // предупреждала — суммы по всему приложению молча уменьшались.
  let sum = 0;
  for(const [c, v] of Object.entries(byCur || {})) {
    const eur = toEur(v, c);
    if(!Number.isNaN(eur)) sum += eur;
  }
  return sum;
}

// Служебный ключ, который вкладки кладут В САМУ карту валют рядом с EUR:
// {PLN: 2925.79, __eur: 727.82}. Так хранится «сумма в EUR» в картах, ключи
// которых — коды валют.
//
// Отсюда и берётся странность из скриншота «727,82 __eur — нет курса»:
// CurrencyBadge перебирает ключи карты как валюты, а `__eur` — не валюта.
// Проверять «похоже ли на ISO-код» здесь нельзя (в данных встречаются и
// нестандартные коды), поэтому отсекаем ровно служебные ключи: они начинаются
// с двух подчёркиваний. Одна проверка на всех потребителей вместо правок в
// каждой вкладке.
export const isServiceKey=(code)=>String(code??"").startsWith("__");

// Валюты из `byCur`, для которых НЕТ курса, то есть которые sumToEur()
// выбросил из итога. Именно этот список делает пропуск видимым.
// Правила: ноль — не «потерянная» сумма (показывать нечего); пустой код
// валюты возвращается как «—», потому что строка без валюты тоже не попала
// в итог, и об этом честнее сказать, чем промолчать.
export function unknownCurrencies(byCur){
  const out = [];
  for(const [c, v] of Object.entries(byCur || {})) {
    if(isServiceKey(c)) continue;   // __eur — не валюта (см. выше)
    if(!v) continue;
    if(Number.isNaN(toEur(v, c))) out.push(c === "" ? "—" : String(c));
  }
  return out.sort((a,b)=>a.localeCompare(b));
}

// Строки разбивки для показа: только ненулевые суммы, EUR первым, дальше по
// убыванию суммы в EUR, а валюты БЕЗ курса — в конце и по алфавиту.
// Вынесено из CurrencyBadge: раньше компаратор возвращал NaN для валют без
// курса, а Array.prototype.sort трактует NaN как «порядок не меняем», поэтому
// их позиция зависела от порядка ключей в объекте (то есть от порядка
// прихода транзакций). Теперь порядок определён и покрыт проверкой.
/**
 * Есть ли смысл в значке «исходные суммы».
 *
 * Условие то же, что внутри CurrencyBadge: либо есть валюта кроме EUR, либо
 * валют больше одной. Отдельная функция нужна там, где значок перенесён в угол
 * плашки: подпись под суммой резервирует место под него, и делать это «на глаз»
 * нельзя — при одной валюте значка нет, и отступ остался бы пустым.
 */
export function hasCurrencyBreakdown(byCur){
  const entries=curEntries(byCur);
  return entries.some(([c])=>c!=="EUR")||entries.length>1;
}

export function curEntries(byCur){
  return Object.entries(byCur||{})
    .filter(([c])=>!isServiceKey(c))   // __eur — не валюта (см. выше)
    .filter(([c,v])=>v>0)
    .sort((a,b)=>{
      if(a[0]==="EUR") return -1;
      if(b[0]==="EUR") return 1;
      const ea=toEur(a[1],a[0]), eb=toEur(b[1],b[0]);
      const na=Number.isNaN(ea), nb=Number.isNaN(eb);
      if(na&&nb) return String(a[0]).localeCompare(String(b[0]));
      if(na) return 1;
      if(nb) return -1;
      return eb-ea;
    });
}

// Pull the latest FX rates from the backend (which fetches them from ECB).
// Called once on app startup; updates EUR_RATES in place so all downstream
// calls pick up the new values. On failure, the fallback rates above stay
// in use — the UI keeps working, just less accurately.
async function _loadLiveFxRates() {
  try {
    // Fetch the most recent rate per currency in one shot.
    const res = await fetch(`${API}/fx-rates?limit=500`, { credentials: "include", headers: {"X-Client-ID": CLIENT_ID} });
    if(!res.ok) return;
    const rates = await res.json();
    if(!Array.isArray(rates) || rates.length === 0) return;
    // Group by currency, keep the most recent rate_date
    const latest = {};
    for(const r of rates) {
      const cur = (r.currency || "").toUpperCase();
      if(!cur) continue;
      if(!latest[cur] || new Date(r.rate_date) > new Date(latest[cur].rate_date)) {
        latest[cur] = r;
      }
    }
    let updated = 0;
    for(const [cur, r] of Object.entries(latest)) {
      const rate = Number(r.rate_to_eur);
      if(Number.isFinite(rate) && rate > 0) {
        EUR_RATES[cur] = rate;
        updated++;
      }
    }
    console.info(`FX rates: ${updated} currencies loaded from backend`);
  } catch(e) {
    console.warn("FX rates: failed to load live rates, using fallback dict", e);
  }
}
// Kick off the load immediately on module import (don't await — let it
// resolve in the background; the UI renders with fallback rates meanwhile
// and re-renders naturally once EUR_RATES is mutated, since the next
// call to a fetch handler will read the updated values).
_loadLiveFxRates();

export function fmtByCur(byCur){return Object.entries(byCur||{}).map(([c,v])=>`${v.toFixed(2)} ${c}`).join(" · ");}


/** Строки, которые НЕ вошли в итоги в EUR: сумма есть, а amount_eur пуст (нет курса
 *  на дату операции). sumEurRows/rowEur считают такие строки нулём, поэтому без
 *  этой выборки итог молча занижается. */
export const missingEurRows=(rows)=>(rows||[]).filter(
  (tx)=>tx && tx.amount_eur==null && Number(tx.amount||0)!==0);

/** {валюта: сумма в исходной валюте} по строкам без EUR. */
export function missingEurByCur(rows){
  const out={};
  for(const tx of missingEurRows(rows)){
    const c=tx.currency||"—";
    out[c]=(out[c]||0)+Number(tx.amount||0);
  }
  return out;
}
