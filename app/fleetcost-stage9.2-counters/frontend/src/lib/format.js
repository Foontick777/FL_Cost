/**
 * Форматирование чисел, денег, дат и длительностей.
 *
 * Вынесено из App.jsx. Важно различать два вида времени:
 *   • fmtInstant — РЕАЛЬНЫЙ момент времени (created_at, last_sync_at):
 *     показывается в часовом поясе браузера;
 *   • fmtDate / fmtDateTime — business-даты (дата операции, дата курса,
 *     дата из файла импорта): это местное «настенное» время, и сдвигать
 *     его по часовому поясу нельзя.
 */
export function fmtDateTime(s) {
  if (!s) return "—";
  const t = String(s).replace("T"," ").slice(0,16);
  const [d,time] = t.split(" ");
  if (!d) return "—";
  const [y,m,dd] = d.split("-");
  return `${dd}.${m}.${y}${time?", "+time:""}`;
}
// ── Время в часовом поясе пользователя ───────────────────────────────
// created_at / last_sync_at — это РЕАЛЬНЫЕ моменты времени (в БД timestamptz,
// приходят как "2026-09-23T06:45:00+00:00"). Старый fmtDateTime просто обрезал
// строку, поэтому у пользователя в GMT+3 журнал показывал время на 3 часа
// раньше реального.
//
// ⚠️ Применять ТОЛЬКО к моментам времени. Для business-дат (transaction_date,
// rate_date, даты из файлов импорта) это делать НЕЛЬЗЯ: они хранятся как
// местное «настенное» время и любой сдвиг пояса их сломает.
export function fmtInstant(s) {
  if (!s) return "—";
  const raw = String(s);
  // Без указания пояса считаем строку UTC — бэкенд всегда отдаёт aware-datetime.
  const iso = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fmtDateTime(raw);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Тот же момент времени, но без года, если год текущий: «21.09, 16:50».
 *
 *  Для плотных мест (карточки источников импорта) год в каждой строке — шум:
 *  подавляющая часть записей из этого года. Год показываем только когда он
 *  отличается, иначе дату легко принять за свежую.
 *  Пояс обрабатывается ровно так же, как в fmtInstant, — здесь только укорачивание.
 */
export function fmtInstantShort(s) {
  const full = fmtInstant(s);
  if (full === "—") return full;
  const year = String(new Date().getFullYear());
  return full.includes(`.${year},`) ? full.replace(`.${year},`, ",") : full;
}
export function fmtDate(s) {
  if (!s) return "—";
  const [y,m,d] = String(s).slice(0,10).split("-");
  return `${d}.${m}.${y}`;
}
export function fmtDuration(totalSeconds, lang) {
  if (totalSeconds===null||totalSeconds===undefined||!isFinite(totalSeconds)) return "—";
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s/86400), hours = Math.floor((s%86400)/3600), mins = Math.floor((s%3600)/60);
  const dLbl = lang==="RU"?"дн":"d", hLbl = lang==="RU"?"ч":"h", mLbl = lang==="RU"?"мин":"m";
  const parts=[];
  if (days>0) parts.push(`${days} ${dLbl}`);
  if (hours>0||days>0) parts.push(`${hours} ${hLbl}`);
  parts.push(`${mins} ${mLbl}`);
  return parts.join(" ");
}
export function fmtDurationShort(totalSeconds, lang) {
  if (totalSeconds===null||totalSeconds===undefined||!isFinite(totalSeconds)) return "—";
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s/86400), hours = Math.floor((s%86400)/3600);
  const dLbl = lang==="RU"?"дн":"d", hLbl = lang==="RU"?"ч":"h";
  return days>0 ? `${days} ${dLbl} • ${hours} ${hLbl}` : `${hours} ${hLbl}`;
}

export const MONO="'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

// ── Единое форматирование чисел и денег ──────────────────────────────
// Раньше в одном экране встречались `1234.56` (toFixed) и `1 234,56`
// (toLocaleString). Эти хелперы дают один формат с разрядами; язык берётся
// из APP_LANG, который App выставляет при переключении RU/EN, поэтому их
// можно вызывать откуда угодно, не прокидывая `lang` через пропсы.
let APP_LANG = "RU";
export function setAppLang(l){ APP_LANG = (l === "EN" ? "EN" : "RU"); }
const _loc = () => (APP_LANG === "EN" ? "en-US" : "ru-RU");
export const fmtMoney = (v, cur = "EUR") => (v == null || v === "" ? "—"
  : `${Number(v).toLocaleString(_loc(),{minimumFractionDigits:2,maximumFractionDigits:2})}${cur ? " " + cur : ""}`);
export const fmtQty = (v, d = 2) => (v == null || v === "" ? "—"
  : Number(v).toLocaleString(_loc(),{minimumFractionDigits:d,maximumFractionDigits:d}));
export const fmtInt = (v) => Number(v || 0).toLocaleString(_loc());

export const greeting=()=>{const h=new Date().getHours();return h<12?"greetingMorning":h<17?"greetingDay":"greetingEvening";};

/**
 * Имя для приветствия: «Иван Петров» → «Иван».
 *
 * Источник — full_name: его вводят при регистрации, а владелец задаёт менеджеру
 * и вьюверу (PATCH /auth/users). Если имени нет, берём часть адреса до «@» — это
 * единственное, что о человеке известно, и это лучше, чем подставлять роль.
 * Пустая строка означает «имени нет вообще»: тогда приветствие печатается без
 * обращения, а не с заглушкой «Admin» — она читалась как настоящее имя.
 */
export function greetName(user){
  const full=(user&&user.full_name||"").trim();
  if(full) return full.split(/\s+/)[0];
  const email=(user&&user.email||"").trim();
  if(!email) return "";
  const at=email.indexOf("@");
  return at>0?email.slice(0,at):email;
}

/**
 * Подбор кегля для суммы в центре кольцевой диаграммы.
 *
 * Сумма рисуется моноширинным шрифтом (JetBrains Mono, шаг знака 0.6em), поэтому
 * ширину строки можно посчитать точно, без измерения в браузере: len × size × 0.6.
 * Раньше кегль выбирался по одному порогу длины (12 знаков), и на больших суммах
 * строка вылезала за отверстие кольца: «€» уходил на вторую строку, а длинная
 * сумма налезала на саму диаграмму. Здесь размер считается из РАЗРЕШЁННОЙ ШИРИНЫ,
 * поэтому этого не происходит при любой сумме.
 */
export const MONO_ADVANCE=0.6;

/** Ширина под сумму внутри отверстия кольца: 136 − 2×25 (inset) − 2×4 (padding). */
export const DONUT_AMOUNT_MAX_W=76;

/**
 * Кегль, при котором строка из `len` знаков занимает не больше `maxW`.
 *
 * `min` — НЕ «жёсткий пол», а минимальный удобный размер: по умолчанию 0, то
 * есть функция всегда возвращает размер, при котором строка помещается. Так
 * требование «сумма не налезает на кольцо» выполняется при любой длине, а
 * читаемость обеспечивает donutAmount() — он решает, можно ли ещё уменьшать
 * или пора убрать копейки.
 */
export function amountFontSize(len,maxW=DONUT_AMOUNT_MAX_W,base=13,min=0){
  if(!len||len<1) return base;
  const fit=Math.floor(maxW/(len*MONO_ADVANCE));
  return Math.max(min,Math.min(base,fit));
}

/** Помещается ли строка такой длины при таком кегле. */
export function amountFits(len,size,maxW=DONUT_AMOUNT_MAX_W){
  return len*size*MONO_ADVANCE<=maxW+0.01;
}

/** Ниже этого кегля сумма в центре кольца читается плохо — от него считаем «не влезает». */
export const DONUT_AMOUNT_MIN=9;

/**
 * Текст суммы для центра кольца и его кегль.
 *
 * Двумя шагами, потому что одного кегля мало. Сначала подбираем размер под
 * полный текст с копейками; если для этого пришлось бы уйти ниже удобного
 * минимума (9px), убираем копейки — «123 456,78 €» → «123 456 €»: на таких
 * суммах они ничего не решают, а место освобождают заметно. Если и это не
 * влезает читаемо, отдаём ТОЧНЫЙ размер (сколько бы он ни вышел): строка
 * обязана поместиться внутри кольца, а читаемость тут уже ничем не помочь.
 */
export function donutAmount(value,opts={}){
  const {base=13,min=DONUT_AMOUNT_MIN,maxW=DONUT_AMOUNT_MAX_W}=opts;
  const full=fmtMoney(value,"€");
  const sizeFull=amountFontSize(full.length,maxW,base,0);
  if(sizeFull>=min) return {text:full,size:sizeFull};
  // Без копеек: на таких суммах они ничего не решают, а место освобождают заметно.
  const short=`${fmtQty(value,0)} €`;
  return {text:short,size:amountFontSize(short.length,maxW,base,0)};
}
export function normalizeCompanyName(name){return (name||"—").replace(/\s+/g,' ').trim();}
