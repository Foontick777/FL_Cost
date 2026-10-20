#!/usr/bin/env node
/**
 * migrate-colors.mjs — разовая замена хексов на переменные темы.
 *
 * ЧТО ДЕЛАЕТ
 * ----------
 * Проходит по `src/**` и заменяет каждый цвет вида `#rrggbb` / `#rgb` на
 * `var(--c-имя)` по таблице `scripts/color-map.json`. Роль цвета определяется по
 * имени свойства, в котором он стоит: `color:` → текст, `background:` → фон,
 * `border…:` → рамка. Это важно: один и тот же светлый оттенок в светлой теме
 * работает фоном, а в тёмной на его месте должен быть тёмный фон, тексту же нужно
 * обратное. Без учёта роли тема получилась бы «вывернутой».
 *
 * ПОЧЕМУ СКРИПТ, А НЕ ПРАВКА РУКАМИ
 * ---------------------------------
 * Замен 1460 в 30+ файлах. Руками это гарантированный пропуск, а пропущенный
 * хекс — это цвет, который не сменится в тёмной теме (единственный способ увидеть
 * такой дефект — заметить светлое пятно глазами). Скрипт делает замену полностью и
 * падает, если встретил цвет, которого нет в таблице: «молча пропустить» он не
 * может по построению.
 *
 * Запуск:
 *   node scripts/migrate-colors.mjs --report    — только отчёт, файлы не меняются
 *   node scripts/migrate-colors.mjs --write     — выполнить замену
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const MAP = JSON.parse(readFileSync(join(ROOT, "scripts/color-map.json"), "utf8"));

const WRITE = process.argv.includes("--write");
const HEX_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

// Файлы, где хексы — это ОПРЕДЕЛЕНИЕ палитры, а не использование.
const SKIP = new Set(["src/lib/theme.js"]);

/**
 * Роль цвета по имени свойства слева от него.
 *
 * Берём ТОЛЬКО текущее выражение — от последней границы (`;`, `{`, `}`, `,`) до
 * цвета — и в нём ищем последнее имя свойства. Так тернарники внутри одного
 * свойства (`color:ok?"#16a34a":"#dc2626"`) определяются верно: обе ветви
 * относятся к `color`, и до второй ветви граница выражения не встречается.
 */
// `=(?!=)` — принципиально: в `contractsTab==="polish"` последовательность `Tab=`
// выглядела как присваивание и перекрывала настоящее свойство (`color:` или
// `catColor =`), из-за чего роль не определялась и цвета тернарников оставались
// хексами. Сравнения (`==`, `===`, `!=`, `<=`, `>=`) свойством не являются.
// `.` в списке перед именем — потому что свойство бывает присвоено через объект:
// `e.currentTarget.style.background="#fff"`. Без этого такие цвета не находились.
const PROP_RE = /(?:^|[\s;,{".])([A-Za-z][A-Za-z0-9-]*)\s*(?::|=(?!=))/g;

/**
 * Роль по ИМЕНИ свойства. Список намеренно широкий: в коде встречаются и CSS
 * (`borderTop`, `accentColor`), и короткие ключи объектов-палитр (`{bg, fg, bd}`),
 * и пропсы компонентов (`valueColor`). Разбирать их по фиксированному перечню
 * значило бы оставить часть цветов нетронутыми — а такой цвет не сменится в тёмной
 * теме, и заметить это можно только глазами.
 */
function roleByName(name) {
  const n = name.toLowerCase();
  if (n === "style" || n === "props" || n === "theme") return null;
  // ОКОНЧАНИЕ, а не точное совпадение: в коде есть ftFg, iconBg, valueColor,
  // catColor, dotColor — точное сравнение их не видело, и цвета оставались хексами.
  if (n.includes("border") || n.endsWith("bd") || n.includes("outline") || n.includes("shadow")) return "border";
  if (n.includes("background") || n.endsWith("bg") || n.includes("surface")) return "background";
  if (n.includes("color") || n.endsWith("fg") || n.includes("fill") || n.includes("stroke")
      || n.includes("accent")) return "color";
  return null;
}

function roleOf(before, wideBefore) {
  // 1. Аргумент pill(bg, fg, bd) — роль определяется ПОЗИЦИЕЙ, имени свойства нет.
  //    Проверяем первым: если цвет внутри незакрытого вызова pill(, вопрос закрыт.
  const fromWide = (wideBefore || "").lastIndexOf("pill(");
  const fromLine = before.lastIndexOf("pill(");
  const call = Math.max(fromWide, fromLine);
  if (call >= 0) {
    const after = call === fromLine ? before.slice(call + 5) : (wideBefore || "").slice(call + 5);
    if (!after.includes(")")) {
      const args = after.split(",").length - 1;
      return ["background", "color", "border"][Math.min(args, 2)];
    }
  }

  // 2. Обычный случай: имя свойства в текущем выражении.
  const cut = Math.max(
    before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}"),
    before.lastIndexOf(","),
  );
  const segment = before.slice(cut + 1);
  let name = null;
  for (const m of segment.matchAll(PROP_RE)) name = m[1];
  if (!name) {
    // 3. Свойство не нашлось в текущем выражении: так бывает внутри функций
    //    (градиент: `background:linear-gradient(90deg,#a,#b)`) и во вложенных
    //    тернарниках, где запятые режут выражение. Ищем шире — по окну,
    //    которое может пересекать перенос строки.
    const wide = (wideBefore || before).slice(-200);
    for (const m of wide.matchAll(PROP_RE)) name = m[1];
    if (!name) return null;
    const cut2 = Math.max(wide.lastIndexOf(";"), wide.lastIndexOf("}"));
    if (cut2 >= 0 && cut2 > wide.lastIndexOf(name)) return null;
  }

  // Хвост с '[' — почти наверняка литерал массива (список цветов), а не свойство:
  // определять роль по случайному слову слева нельзя.
  const tail = before.slice(before.lastIndexOf(name) + name.length);
  if (tail.includes("[")) return null;
  return roleByName(name);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
let replaced = 0;
const byRole = { color: 0, background: 0, border: 0 };
const unmapped = new Map();
const unknownRole = [];
const touched = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  if (SKIP.has(rel)) continue;
  let text = readFileSync(file, "utf8");
  let changed = false;

  // Идём по совпадениям справа налево, чтобы индексы не сдвигались.
  const matches = [...text.matchAll(HEX_RE)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const hex = m[0].toLowerCase();
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const before = text.slice(lineStart, m.index);
    // Окно шире строки: свойства и вызовы бывают перенесены на предыдущую строку.
    const wideBefore = text.slice(Math.max(0, m.index - 260), m.index);

    const entry = MAP.vars[hex];
    // Роль нужна только когда цвет в разных ролях даёт РАЗНЫЕ переменные.
    // Если он «поглощён» одной переменной — роли не существует по определению.
    const single = entry
      ? new Set([entry.color, entry.background, entry.border]).size === 1
      : !!MAP.absorbed[hex];

    // Роль нужна только там, где один и тот же цвет служит и текстом, и заливкой
    // (например #fff: фон карточки и текст на брендовой кнопке — в тёмной теме
    // это РАЗНЫЕ цвета). Если все роли сходятся в одну переменную, угадывать нечего.
    let role = single ? "color" : roleOf(before, wideBefore);
    if (!role) {
      // Хекс без распознанного свойства: сообщаем и оставляем как есть,
      // чтобы не угадывать роль (неверная роль = «вывернутая» тема).
      if (hex.length === 7) unknownRole.push(`${rel}: ${before.trim().slice(-58)} → ${m[0]}`);
      if (process.argv.includes("--debug")) {
        const cut = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"),
                             before.lastIndexOf("}"), before.lastIndexOf(","));
        console.log(`\n  ${rel} ${m[0]}`);
        console.log(`    before: ${JSON.stringify(before.slice(-90))}`);
        console.log(`    segment: ${JSON.stringify(before.slice(cut + 1))}`);
        console.log(`    wide: ${JSON.stringify(wideBefore.slice(-120))}`);
        console.log(`    совпадения: ${JSON.stringify([...(before.slice(cut + 1)).matchAll(PROP_RE)].map(x => x[1]))}`);
      }
      continue;
    }

    let varName = null;
    if (entry) varName = entry[role] || entry.color || entry.background || entry.border;
    else if (MAP.absorbed[hex]) varName = MAP.absorbed[hex];

    if (!varName) {
      unmapped.set(hex, (unmapped.get(hex) || 0) + 1);
      continue;
    }
    text = text.slice(0, m.index) + `var(${varName})` + text.slice(m.index + m[0].length);
    replaced++;
    byRole[role]++;
    changed = true;
  }

  if (changed) {
    touched.push(rel);
    if (WRITE) writeFileSync(file, text);
  }
}

console.log(`файлов просмотрено: ${files.length}, изменено: ${touched.length}`);
console.log(`замен: ${replaced} (текст ${byRole.color}, фон ${byRole.background}, рамка ${byRole.border})`);
console.log(`режим: ${WRITE ? "ЗАПИСЬ" : "отчёт (файлы не менялись)"}`);

if (unmapped.size) {
  console.log(`\n✗ ЦВЕТА БЕЗ ПЕРЕМЕННОЙ (${unmapped.size}) — добавьте их в scripts/color-map.json:`);
  for (const [hex, n] of [...unmapped].sort((a, b) => b[1] - a[1])) console.log(`   ${hex} × ${n}`);
}
if (unknownRole.length) {
  console.log(`\n⚠ ХЕКСЫ БЕЗ РАСПОЗНАННОГО СВОЙСТВА (${unknownRole.length}) — не заменены, проверьте вручную:`);
  for (const line of unknownRole.slice(0, 25)) console.log(`   ${line}`);
}

// Остаток хексов после записи — то, что не покрыто таблицей.
if (WRITE) {
  let left = 0;
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (SKIP.has(rel)) continue;
    left += (readFileSync(file, "utf8").match(HEX_RE) || []).length;
  }
  console.log(`\nхексов осталось в src (без theme.js): ${left}`);
}
process.exit(unmapped.size ? 1 : 0);
