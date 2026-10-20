#!/usr/bin/env node
/**
 * check-modules.mjs — защита от «белого экрана» после разбиения App.jsx на модули.
 *
 * ПОЧЕМУ ЭТО НУЖНО
 * ----------------
 * Сборщик (Vite/esbuild/rollup) НЕ считает ошибкой обращение к имени, которого
 * нет ни в модуле, ни в импортах: для него это «глобальная переменная». Поэтому
 * такой код успешно собирается и падает уже в браузере:
 *     Uncaught ReferenceError: MONO is not defined      → белый экран
 *     Uncaught ReferenceError: isCarWash is not defined
 *
 * Оба случая реально произошли при разбиении файла. Этот скрипт ловит их ДО деплоя.
 *
 * ЧТО ПРОВЕРЯЕТ
 * -------------
 * 1. СТАТИЧЕСКИ — по ВСЕМУ файлу (не только по телу `App`) и во всех
 *    направлениях, включая «модуль → модуль»: именно там прятался `isCarWash`.
 * 2. ИСПОЛНЕНИЕМ — модули собираются esbuild'ом и загружаются в Node с
 *    заглушкой DOM (ловит ошибки уровня модуля, как было с `MONO`), затем
 *    компоненты рендерятся через react-dom/server.
 *
 * ЗАПУСК
 * ------
 *   npm run check
 *   node frontend/scripts/check-modules.mjs
 *
 * Код возврата 1 — деплой ломать нельзя. Зависимостей не добавляет: esbuild и
 * react-dom уже есть в node_modules Vite.
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { dirname, join, basename, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src");
const APP = join(SRC, "App.jsx");
const TMP = join(root, ".check-tmp");

const problems = [];
const note = (msg) => problems.push(msg);
// Отдельно от «замечаний к коду»: причины, по которым проверка вообще не
// может выполниться. Смешивать нельзя — «не смогла запуститься» и «нашла
// проблему» требуют разных действий (поставить зависимости vs править код).
const blockers = [];
const blocker = (msg) => blockers.push(msg);

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


// ─────────────────────────────────────────────────────────────────────────────
// 1. СТАТИЧЕСКАЯ ПРОВЕРКА ССЫЛОК — на настоящем парсере (@babel/parser + traverse)
// ─────────────────────────────────────────────────────────────────────────────
//
// ПОЧЕМУ ПАРСЕР, А НЕ РЕГУЛЯРКИ.
// Первая версия этой проверки «разбирала» код регулярками и трижды оказалась
// слепой — ровно в тех случаях, ради которых была написана:
//   • `const isParking = tx => …` внутри компонента маскировал отсутствующий
//     импорт того же имени на уровне модуля;
//   • spread `{...s.page}` заставлял считать `s` «именем свойства»;
//   • текст в JSX/шаблонах (русские подписи, скобки, кавычки, апострофы)
//     ломал подсчёт скобок и маскировал целые участки кода.
// Babel даёт настоящие области видимости: если имя не связано ни в одной
// видимой области — это ровно то, что в браузере даёт ReferenceError и белый экран.

import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";

const traverse = traverseImport.default || traverseImport;

/** API React/react-dom: всегда требуют явного импорта (глобалами не являются). */
const REACT_API = new Set(`useState useEffect useRef useCallback useMemo useReducer useLayoutEffect
useId useTransition useDeferredValue useSyncExternalStore createContext useContext forwardRef memo
Fragment StrictMode Children cloneElement createElement isValidElement Component PureComponent
createRoot hydrateRoot createPortal`.split(/\s+/));

/** Имена, экспортируемые модулем (включая default). */
function exportedNames(ast) {
  const out = new Set();
  for (const node of ast.program.body) {
    if (node.type === "ExportDefaultDeclaration") out.add("default");
    else if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        const d = node.declaration;
        if (d.declaration && d.declaration.id) out.add(d.declaration.id.name);          // export const / function / class
        if (d.id) out.add(d.id.name);
        for (const v of d.declarations || []) if (v.id.type === "Identifier") out.add(v.id.name);
      }
      for (const sp of node.specifiers || []) out.add(sp.exported.name || sp.exported.value);
    }
  }
  return out;
}

/** Имена, ОБЪЯВЛЕННЫЕ на верхнем уровне (в том числе без `export`). */
function declaredNames(ast) {
  const out = new Set();
  const fromPattern = (pat) => {
    if (!pat) return;
    if (pat.type === "Identifier") out.add(pat.name);
    else if (pat.type === "ObjectPattern") for (const pr of pat.properties) fromPattern(pr.value || pr.argument);
    else if (pat.type === "ArrayPattern") for (const el of pat.elements) fromPattern(el);
    else if (pat.type === "AssignmentPattern") fromPattern(pat.left);
    else if (pat.type === "RestElement") fromPattern(pat.argument);
  };
  for (const node of ast.program.body) {
    let n = node;
    if (node.type === "ExportNamedDeclaration" && node.declaration) n = node.declaration;
    if (n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") { if (n.id) out.add(n.id.name); }
    else if (n.type === "VariableDeclaration") for (const d of n.declarations) fromPattern(d.id);
  }
  return out;
}

/** Разбор файла; null — если файл не парсится (о таком сообщаем отдельно). */
function parseModule(src) {
  return parse(src, { sourceType: "module", plugins: ["jsx"], errorRecovery: false });
}

/** Диалоги без доступного имени и самодельные role="dialog" — по AST.
 *
 * Раньше это был текстовый поиск, и он ложно срабатывал на упоминаниях в
 * КОММЕНТАРИЯХ: фраза «обеспечивает <Modal>, поэтому …» распознавалась как
 * настоящий диалог без имени. AST видит только реальный код. */
function dialogIssues(ast) {
  const noName = [];
  const manualRole = [];
  traverse(ast, {
    JSXOpeningElement(path) {
      const n = path.node.name;
      if (!(n && n.type === "JSXIdentifier")) return;
      const line = path.node.loc ? path.node.loc.start.line : "?";
      if (n.name === "Modal") {
        const named = path.node.attributes.some(
          (a) => a.type === "JSXAttribute" && a.name && (a.name.name === "label" || a.name.name === "labelledBy"));
        if (!named) noName.push(line);
      }
      for (const a of path.node.attributes) {
        if (a.type !== "JSXAttribute" || !a.name || a.name.name !== "role") continue;
        const v = a.value;
        const literal = v && (v.type === "StringLiteral" ? v.value
          : (v.type === "JSXExpressionContainer" && v.expression.type === "StringLiteral" ? v.expression.value : null));
        if (literal === "dialog") manualRole.push(line);
      }
    },
  });
  return { noName, manualRole };
}

function staticCheck(files) {
  const modules = [];        // {file, src, ast, exported}
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    let ast;
    try { ast = parseModule(src); }
    catch (e) { note(`${relative(root, file)}: не удалось разобрать — ${e.message}`); continue; }
    modules.push({ file, src, ast, exported: exportedNames(ast), declared: declaredNames(ast) });
  }

  // Реестр: имя → файлы, которые его ЭКСПОРТИРУЮТ (не просто объявляют).
  const exportedBy = new Map();
  const declaredBy = new Map();
  for (const m of modules) {
    for (const n of m.exported) {
      if (!exportedBy.has(n)) exportedBy.set(n, new Set());
      exportedBy.get(n).add(m.file);
    }
    for (const n of m.declared) {
      if (!declaredBy.has(n)) declaredBy.set(n, new Set());
      declaredBy.get(n).add(m.file);
    }
  }

  for (const m of modules) {
    const imported = new Set();
    const rel = (p) => relative(root, p);
    let traversed = null;

    // Проверка связей: имя, не связанное ни в одной видимой области.
    const referencer = (node, name) => {
      if (!name || traversed === null) return;
      const owners = [...(declaredBy.get(name) || [])];
      if (!owners.length) return;                              // неизвестное имя: браузерный глобал / JSX-тег
      if (owners.every((o) => o === m.file)) return;            // объявлено в этом же файле
      if (imported.has(name)) return;                           // импортировано — связь есть
      const exp = exportedBy.get(name) || new Set();
      const where = owners.map((o) => (exp.has(o) ? `${rel(o)}` : `${rel(o)} (НЕ экспортируется)`));
      traversed.add(`${name} ← ${where.join(", ")}`);
    };

    const ast = parseModule(m.src);
    // Импорты и проверка «целевой модуль действительно это экспортирует»
    for (const node of ast.program.body) {
      if (node.type !== "ImportDeclaration") continue;
      const source = node.source.value;
      const target = source.startsWith(".") ? pathResolve(pathDirname(m.file), source) : null;
      const targetModule = target ? modules.find((x) => x.file === target) : null;
      for (const sp of node.specifiers) {
        imported.add(sp.local.name);
        if (sp.type === "ImportSpecifier" && targetModule) {
          const wanted = sp.imported.name || sp.imported.value;
          if (!targetModule.exported.has(wanted)) {
            note(`${rel(m.file)} импортирует ${wanted} из ${source}, но этот модуль его не экспортирует`);
          }
        }
      }
    }

    traverse(ast, {
      ReferencedIdentifier(path) {
        if (traversed === null) traversed = new Set();
        const name = path.node.name;
        if (path.scope.getBinding(name)) return;                 // имя связано в видимой области видимости
        referencer(path.node, name);
      },
    });

    if (traversed && traversed.size) {
      note(`${rel(m.file)} использует без импорта: ${[...traversed].join("; ")}`);
    }

    // ── Совсем неизвестные имена ────────────────────────────────────────────
    // Проверка выше намеренно молчит про имена, которых нет ни в одном модуле:
    // так выглядят JSX-теги и браузерные глобалы. Но в ДВУХ местах неизвестное имя
    // почти всегда означает опечатку или потерянную переменную, а сборщик такое
    // пропускает (для него это «глобальная переменная») — и приложение падает уже
    // в браузере:
    //   · значение JSX-атрибута:   <Form catState={catState} />
    //   · сокращённая запись поля: { catState }
    // Ровно так выглядела поломка, когда форма категорий осталась без справочника.
    const GLOBAL_OK = new Set(["undefined", "NaN", "Infinity", "arguments", "this"]);
    {
      const unknown = new Set();
      const check = (node, name, where) => {
        if (!name || GLOBAL_OK.has(name)) return;
        if (!node || node.type === "JSXElement" || node.type === "JSXFragment") return;
        if (node.scope && node.scope.getBinding(name)) return;
        unknown.add(`${name} (${where})`);
      };
      traverse(ast, {
        JSXAttribute(p) {
          const v = p.node.value;
          if (v && v.type === "JSXExpressionContainer" && v.expression.type === "Identifier") {
            check(p, v.expression.name, p.node.name && p.node.name.name);
          }
        },
        ObjectProperty(p) {
          if (!p.node.shorthand) return;
          const key = p.node.key;
          if (key && key.type === "Identifier") check(p, key.name, "сокращённое поле");
        },
      });
      if (unknown.size) {
        note(`${rel(m.file)}: необъявленные имена — ${[...unknown].join("; ")}`);
      }
    }

    // React/react-dom API обязаны быть импортированы явно: для сборщика это
    // «просто неизвестное имя», поэтому файл падает уже в браузере.
    const hooksMissing = [...REACT_API].filter((n) => {
      if (imported.has(n)) return false;
      let used = false;
      traverse(ast, { ReferencedIdentifier(p) { if (p.node.name === n) used = true; } });
      return used;
    });
    if (hooksMissing.length) {
      note(`${rel(m.file)} использует без импорта (react/react-dom): ${hooksMissing.join(", ")}`);
    }

    // ── Правила диалогов ────────────────────────────────────────────────────
    // Диалог можно показать только через <Modal>: он один реализует Escape,
    // фокус-ловушку, возврат фокуса и блокировку прокрутки фона. Своя копипаста
    // разметки с role="dialog" — это ровно то, из-за чего доступность была
    // заявлена, но не работала.
    {
      const { noName, manualRole } = dialogIssues(m.ast);
      if (!m.file.endsWith("ui/Modal.jsx")) {
        for (const line of manualRole) {
          note(`${rel(m.file)}:${line}: role="dialog" вне ui/Modal.jsx — диалоги должны идти через <Modal>`);
        }
      }
      for (const line of noName) {
        note(`${rel(m.file)}:${line}: <Modal> без доступного имени — добавьте label=… или labelledBy=…`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ПРОВЕРКА ИСПОЛНЕНИЕМ
// ─────────────────────────────────────────────────────────────────────────────

function runtimeCheck(modules) {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "shim.js"), `globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
globalThis.document = {
  createElement: () => ({ style:{}, setAttribute(){}, appendChild(){}, addEventListener(){} }),
  head: { appendChild(){} }, body: { appendChild(){} },
  getElementById: () => null, addEventListener(){}, removeEventListener(){},
  querySelector: () => null, querySelectorAll: () => [],
};
try { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "check-modules" }, configurable: true }); } catch (e) {}
// Заглушка сети: модули при импорте дергают /api/fx-rates (загрузка курсов).
// Без заглушки Node ругается ERR_INVALID_URL и засоряет вывод проверки.
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });
`);

  const imports = [], loads = [], renders = [];
  modules.forEach(([dir, abs], i) => {
    imports.push(`import * as M${i} from ${JSON.stringify("../src/" + dir + "/" + basename(abs))};`);
    loads.push(`try { Object.keys(M${i}); ok++; } catch (e) { fail++; console.log("  ✗ ${dir}/${basename(abs)}: " + e.message); }`);
    if (!abs.endsWith(".jsx")) return;   // страницы тоже рендерим: они берут всё из props
    const comps = [...readFileSync(abs, "utf8").matchAll(/^export function ([A-Z][\w]*)\s*\(/gm)].map((m) => m[1]);
    for (const c of comps) {
      // ReferenceError = неразрешённая ссылка → дефект, роняем проверку.
      // Остальные ошибки = не хватило данных для рендера → пропускаем.
      renders.push(`  try { renderToString(React.createElement(M${i}.${c}, PROPS)); ok++; }
  catch (e) {
    if (e instanceof ReferenceError || /is not defined/.test(e.message)) { fail++; console.log("  ✗ ${basename(abs)} → ${c}: " + e.message); }
    else { skipped++; }
  }`);
    }
  });

  const entry = `${imports.join("\n")}
import { renderToString } from "react-dom/server";
import React from "react";
// Тестовые транзакции обязательны: с пустым массивом тела .map()/.filter()/
// forEach() не исполняются, и ошибки внутри них (как missing isParking) не
// проявляются. Покрываем все источники и «особые» категории.
const TX = [
  { id:1, source:"e100", fuel_type:"Toll DE E-BOX", transaction_date:"2026-09-23T10:00:00Z",
    amount:12.5, currency:"EUR", volume:10, price:1.25, plate_number:"AA123", country:"DE",
    is_confirmed:true, station_address:"x", inserted_at_source:"2026-09-23T11:00:00Z" },
  { id:2, source:"e100", fuel_type:"Parking truck E-BOX", transaction_date:"2026-09-22T10:00:00Z",
    amount:5, currency:"EUR", volume:null, plate_number:"AA123", country:"FR", is_confirmed:true },
  { id:3, source:"e100", fuel_type:"Car wash", transaction_date:"2026-09-21T10:00:00Z",
    amount:7, currency:"PLN", plate_number:"AA123", is_confirmed:false },
  { id:4, source:"q8", fuel_type:"Diesel", transaction_date:"2026-09-20T10:00:00Z",
    amount:400, currency:"PLN", volume:80, price:5, plate_number:"AA123", is_confirmed:true },
  { id:5, source:"manual", fuel_type:"manual_general_parking", transaction_date:"2026-09-19T10:00:00Z",
    amount:20, currency:"EUR", plate_number:"AA123", is_confirmed:true },
  { id:6, source:"manual", fuel_type:"manual_salary", transaction_date:"2026-09-18T10:00:00Z",
    amount:2000, currency:"EUR", plate_number:"AA123", is_confirmed:true },
  { id:7, source:"csv_income", fuel_type:"income_freight", transaction_date:"2026-09-17T10:00:00Z",
    amount:1906.5, currency:"EUR", plate_number:"AA123", is_confirmed:true },
];
const PROPS = { t:{}, lang:"RU", txns:TX, transactions:TX, total:TX.length, page:0, totalPages:1,
  vehicles:[{id:1,plate_number:"AA123",driver_name:"Driver",is_active:true}], countries:["PL","DE","FR"],
  period:{from:"2026-09-01",to:"2026-09-23"}, custom:{from:"2026-09-01",to:"2026-09-23"},
  periodKey:"this_month", value:"", onChange(){}, embedded:true, srcFilter:"", vehicleFilter:"",
  countryFilter:"", sortMode:"date_desc", setPage(){}, setPeriod(){}, setVehicleFilter(){},
  setCountryFilter(){}, setSortMode(){}, onSelect(){}, mileage:[], stats:null, loading:false,
  prevStats:null, onImport(){}, setTab(){}, tab:"", user:{role:"owner",email:"a@b.c"} };
let ok = 0, fail = 0, skipped = 0;
console.log("── загрузка модулей (${modules.length}):");
${loads.join("\n")}
console.log("── рендер компонентов:");
${renders.join("\n")}

// ── ЦЕЛЕВЫЕ ПРОВЕРКИ: обязаны не падать ─────────────────────────────────────
// Общий прогон выше считает ошибкой только ReferenceError, а TypeError относит к
// «не хватило данных» и пропускает. Из-за этого белый экран от
// catState.list у непереданного состояния категорий прошёл проверку незамеченным:
// форма категорий открывалась без справочника (блок регулярных платежей, страница
// лизинга), и стоило в поле появиться сохранённому коду, как рендер падал.
// Здесь состояние задаётся намеренно неполным: если компонент снова начнёт
// падать на отсутствующем пропе, проверка это покажет. Модальные окна сюда не
// входят: они используют портал и в Node без настоящего DOM не рендерятся — их
// стережёт статическое правило ниже.
import { CategorySelect } from ${JSON.stringify(join(SRC, "ui", "CategorySelect.jsx"))};

const EMPTY_CAT_STATE = { list: null, byKey: {}, byFuel: {}, loadedAt: 0, loading: false };
const TARGETED = [
  ["CategorySelect: catState не передан, значение заполнено",
   () => React.createElement(CategorySelect, { section: "leasing", value: "leasing",
     onChange() {}, lang: "RU" })],
  ["CategorySelect: список пуст, значение заполнено",
   () => React.createElement(CategorySelect, { section: "leasing", catState: EMPTY_CAT_STATE,
     value: "leasing", onChange() {}, lang: "RU" })],
  ["CategorySelect: значений нет, но и справочника нет",
   () => React.createElement(CategorySelect, { section: "general", onChange() {}, lang: "RU" })],
];
console.log("── целевые проверки (белый экран недопустим):");
for (const [name, make] of TARGETED) {
  try { renderToString(make()); ok++; }
  catch (e) { fail++; console.log("  ✗ " + name + ": " + e.message); }
}
console.log("");
// Машинный результат — родительский процесс печатает по нему ЕДИНЫЙ вердикт
// последней строкой. Без этого вывод заканчивался строкой «✓ Модули загружаются…»
// даже когда статическая проверка нашла ошибку: последняя строка выглядела
// зелёной при красном результате, и ошибку было легко не заметить.
try { require("node:fs").writeFileSync(${JSON.stringify(join(TMP, "result.json"))}, JSON.stringify({ ok, fail, skipped })); } catch (e) {}
if (fail) { console.log("рендер: " + fail + " ошибок (подробности выше)"); process.exit(1); }
console.log("✓ Модули загружаются, компоненты рендерятся (" + ok + " проверок, " + skipped + " пропущено из-за отсутствия данных).");
`;
  writeFileSync(join(TMP, "entry.js"), `import "./shim.js";\n` + entry);

  const esbuild = findEsbuild();
  if (!esbuild) {
    blocker("Не найден esbuild (искали: .bin/esbuild, esbuild/bin/esbuild, "
          + "@esbuild/" + process.platform + "-" + process.arch + "/bin/esbuild). "
          + "Проверка рендера НЕ ВЫПОЛНЕНА — выполните `npm install` в папке frontend.");
    return { status: 0, ok: 0, fail: 0, skipped: 0, ran: false };
  }
  let status = 0;
  try {
    execFileSync(esbuild, [join(TMP, "entry.js"), "--bundle", "--format=cjs", "--platform=node",
      "--jsx=automatic", "--loader:.jsx=jsx", "--outfile=" + join(TMP, "out.cjs"), "--log-level=error"],
      { cwd: root, stdio: "inherit" });
    execFileSync(process.execPath, [join(TMP, "out.cjs")], { cwd: root, stdio: "inherit" });
  } catch (e) {
    status = e.status || 1;
  }
  let result = { ok: 0, fail: 0, skipped: 0 };
  try { result = JSON.parse(readFileSync(join(TMP, "result.json"), "utf8")); } catch (e) {}
  for (const f of ["shim.js", "entry.js", "out.cjs", "result.json"]) { try { unlinkSync(join(TMP, f)); } catch (e) {} }
  try { if (readdirSync(TMP).length === 0) rmdirSync(TMP); } catch (e) {}
  return { status, ...result };
}

// ─────────────────────────────────────────────────────────────────────────────

const modules = [];
for (const dir of ["lib", "ui", "pages"]) {
  const abs = join(SRC, dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs).sort()) if (/\.(js|jsx)$/.test(f)) modules.push([dir, join(abs, f)]);
}

console.log(`── статическая проверка ссылок (${modules.length + 1} файлов, все направления):`);
// ── Финансовые правила, которые нельзя нарушать молча ────────────────────────
// Два класса ошибок, уже случавшихся в этом проекте:
//   1) сумму ТРАНЗАКЦИИ считают живым курсом toEur() вместо исторического
//      amount_eur — и тогда вкладка и дашборд показывают по одним и тем же строкам
//      разные числа (FC-001 и его рецидивы);
//   2) объект-накопитель получает поле `eur: 0`, но нигде его не увеличивает —
//      виджет рисует нули. Так «Платные дороги» потеряли суммы по машинам.
// Проверка чисто статическая: читаем исходники страниц, ничего не запускаем.
function moneyRulesCheck(files) {
  const liveRate = /toEur\(\s*(?:Math\.abs\(\s*)?(?:tx|t|r)\.amount/;
  // Модуль к сумме строки: знак несёт смысл (возврат по дорогам — отрицательная
  // строка). Дашборд брал Math.abs и показывал по дорогам 2 492,15 там, где
  // вкладка считала 2 486,83 — разница ровно 2×|возврат|.
  const absRow = /Math\.abs\(\s*(?:rowEur|toEur)\s*\(/;
  const eurInit = /\beur\s*:\s*0\b/;
  let pages = 0, found = 0;
  for (const [, abs] of files) {
    if (!/[\\/]pages[\\/]/.test(abs)) continue;
    pages++;
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (liveRate.test(line)) {
        found++;
        note(abs + ":" + (i + 1) + " сумма транзакции считается живым курсом toEur() — нужен rowEur(tx) (исторический курс, FC-001)");
      }
      if (absRow.test(line)) {
        found++;
        note(abs + ":" + (i + 1) + " модуль к сумме строки — знак несёт смысл: возвраты и сторно должны уменьшать итог");
      }
    });
    lines.forEach((line, i) => {
      if (!eurInit.test(line)) return;
      const win = lines.slice(i, i + 60).join("\n");
      const grows = /\.eur\s*\+=/.test(win) || /eur\s*:\s*[\w$]+\.eur\s*\+/.test(win);
      if (!grows) {
        found++;
        note(abs + ":" + (i + 1) + " поле eur инициализировано нулём и нигде не увеличивается — виджет покажет 0");
      }
    });
  }
  console.log("  " + (found ? "✗" : "✓") + ` финансовые правила (страниц ${pages}):` +
    (found ? ` замечаний ${found}` : " живой курс к суммам транзакций не применяется, накопители eur заполняются"));
}

// ── Плашки главных показателей: значки в правом нижнем углу ───────────────
// «Исходные суммы» (CurrencyBadge) показывают разбивку по валютам и раньше
// стояли в строке подписи, из-за чего на каждой вкладке значок был на своём
// месте и сдвигал подпись. Теперь он живёт в правом нижнем углу, ровно под
// бейджем сравнения в правом верхнем углу. Проверяем разметку по всем
// страницам: значок в строке подписи или забытый `kpiCorner` — регрессия,
// которую глазами замечаешь только на одной из восьми вкладок.
/**
 * Категории, пришедшие ПРОПОМ, нельзя читать без проверки.
 *
 * Повод: `CategorySelect` делал `catState.list.find(...)`, а на двух путях
 * (блок регулярных платежей и страница лизинга) состояние категорий вообще не
 * передавалось. Пока поле было пустым, всё работало; но стоило в нём оказаться
 * сохранённому коду категории (редактирование договора или создание категории
 * прямо из списка), как форма падала с «Cannot read properties of undefined
 * (reading 'list')» — белый экран вместо формы.
 *
 * Правило: в компонентах, принимающих `catState` пропом, обращение к `catState.list`
 * напрямую запрещено — нужен локальный список с значением по умолчанию
 * (`(catState && catState.list) || []`) или собственный источник данных.
 * Страницы, которым состояние отдаёт хук, правило не касается: там объект есть
 * всегда.
 */
function categoryPropGuardCheck(files) {
  const uiFiles = files.filter(([, abs]) => /[\\/]src[\\/]ui[\\/]/.test(abs));
  let checked = 0;
  for (const [name, abs] of uiFiles) {
    const src = readFileSync(abs, "utf8");
    const short = basename(abs);
    // Только компоненты, где catState приходит снаружи.
    if (!/catState\s*:\s*catStateProp|catState\s*,/.test(src)) continue;
    checked++;
    // Комментарии не код: они тоже упоминают catState.list (объясняя правило), и
    // без этой очистки проверка ругалась на собственное пояснение.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const unguarded = [...code.matchAll(/catState\.list/g)]
      .filter((m) => !/catState\s*&&\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index)));
    if (unguarded.length) {
      note(`${short}: обращение к catState.list без проверки — при отсутствии пропа это белый экран`
           + ` (используйте локальный список со значением по умолчанию)`);
    }
    if (!/useCategories\(\)/.test(src) && !/\(catState && catState\.list\)/.test(src)) {
      note(`${short}: принимает catState пропом, но не имеет ни своего источника`
           + ` категорий, ни проверки на отсутствие пропа`);
    }
  }
  if (!checked) note("не найдено ни одного компонента с catState пропом — проверка потеряла смысл");
}

function kpiBadgeCheck(files) {
  const pages = files.filter(([, abs]) => /[\/]pages[\/]/.test(abs));
  const inFlow = [];        // значок остался в строке подписи
  const emptyCorner = [];   // обёртка угла без значка
  let badges = 0, corners = 0;
  for (const [name, abs] of pages) {
    const src = readFileSync(abs, "utf8");
    const short = name.split("/").pop();
    // A. Значок «исходные суммы» больше не должен стоять в строке подписи:
    //    именно из-за этого он был на своём месте на каждой вкладке.
    for (const m of src.matchAll(/<CurrencyBadge\b[^>]*\/>/g)) {
      badges++;
      const before = src.slice(Math.max(0, m.index - 220), m.index);
      if (/kpiCorner/.test(before)) continue;
      if (/kpiSub/.test(before)) inFlow.push(short);
    }
    // B. Обёртка угла обязана что-то содержать: пустая обёртка означает
    //    потерянный значок (или забытый UnratedIcon на дашборде).
    for (const m of src.matchAll(/<div style=\{\{\.\.\.kpiCorner\}\}>/g)) {
      corners++;
      const after = src.slice(m.index, m.index + 400);
      if (!/<CurrencyBadge|<UnratedIcon|plnRef/.test(after)) emptyCorner.push(short);
    }
  }
  const uniq = (a) => [...new Set(a)].map((x) => x + " ×" + a.filter((y) => y === x).length);
  console.log("  " + (badges && !inFlow.length ? "✓" : "✗") +
    ` плашки: значков «исходные суммы» — ${badges}, в углу — ${corners}`);
  if (inFlow.length) {
    note(`значок «исходные суммы» остался в строке подписи (${uniq(inFlow).join(", ")}) — ` +
         "он должен стоять в правом нижнем углу плашки");
  }
  if (emptyCorner.length) {
    note(`обёртка kpiCorner без значка (${uniq(emptyCorner).join(", ")}) — значок потерян`);
  }
}


// ── Словарь: ключи и переводы ────────────────────────────────────────────────
// Три класса ошибок, которые видны пользователю, но не ломают сборку:
//   1) `t.нетТакогоКлюча` — рендерится как «undefined» посреди русского текста;
//   2) ключ есть только в RU (или только в EN) — во втором языке «undefined»;
//   3) текст написан прямо в разметке страницы — при переключении языка остаётся
//      русским (именно так и появились подзаголовки на странице курсов).
function i18nCheck(files, appSrc) {
  const keyOf = (block) => new Set([...block.matchAll(/\b([a-zA-Z][a-zA-Z0-9_]*)\s*:/g)].map(m => m[1]));
  const ru = keyOf(appSrc.split("RU:{")[1].split("EN:{")[0]);
  const en = keyOf(appSrc.split("EN:{")[1].split("RU:{")[0]);
  const used = new Map();
  for (const [, abs] of files) {
    // Словарь `t` приходит пропсом только в страницы и компоненты; в lib/ бывает
    // своя локальная переменная `t` (например в format.js), и её поля — не ключи.
    if (!/[\\/](pages|ui)[\\/]/.test(abs)) continue;
    const src = readFileSync(abs, "utf8");
    for (const m of src.matchAll(/\bt\.([a-zA-Z][a-zA-Z0-9_]*)/g)) {
      if (!used.has(m[1])) used.set(m[1], abs.split("/").pop());
    }
  }
  let found = 0;
  for (const [k, file] of used) {
    if (!ru.has(k) || !en.has(k)) {
      found++;
      note(`${file}: ключ t.${k} отсутствует в словаре${!ru.has(k) ? " RU" : ""}${!en.has(k) ? " EN" : ""} — на экране будет «undefined»`);
    }
  }
  console.log("  " + (found ? "✗" : "✓") + ` словарь: ключей в RU ${ru.size}, в EN ${en.size}, используется ${used.size}` +
    (found ? `, замечаний ${found}` : " — все ключи на месте"));
}

// Страница курсов переведена целиком: русского текста прямо в разметке быть не
// должно. Проверяем строковые литералы, а не комментарии — они на русском и это
// нормально.
function translatedPageCheck(abs) {
  const src = readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const bad = [];
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/["'`]([^"'`]*[А-Яа-яЁё][^"'`]*)["'`]/g)) bad.push(`${i + 1}: ${m[1].slice(0, 50)}`);
  });
  if (bad.length) {
    for (const b of bad.slice(0, 8)) note(`${abs.split("/").pop()} — русский текст в разметке (${b}) — вынесите в словарь`);
  } else {
    console.log("  ✓ страница курсов: текстов прямо в разметке нет, всё через словарь");
  }
}

const appSrc = readFileSync(APP, "utf8");
i18nCheck(modules, appSrc);
const fxPage = modules.find(([, abs]) => /FxRatesPage\.jsx$/.test(abs));
if (fxPage) translatedPageCheck(fxPage[1]);

staticCheck([APP, ...modules.map(([, abs]) => abs)]);

// ── Подвал бокового меню ─────────────────────────────────────────────────
// Оформление и язык разнесены по краям (space-between), а профиль и «Выход»
// лежат ОДНОЙ серой карточкой. Обе вещи легко «починить обратно» при правке
// соседнего кода, а заметно это только глазами и не на каждой странице.
function sidebarFooterCheck() {
  const src = readFileSync(join(process.cwd(), "src/ui/Sidebar.jsx"), "utf8");
  const has = (frag) => src.indexOf(frag) >= 0;
  // 1. Переключатели: тема слева, язык справа.
  if (!has('justifyContent:"space-between"')) {
    note("подвал меню: переключатели темы и языка не разнесены по краям " +
         "(нет justifyContent space-between) — они снова слипнутся в один блок");
  }
  // 2. Один серый блок на профиль и выход: обе переменные в одном style.
  const card = src.match(/style=\{\{[^}]*c-surface-2[^}]*c-border-2[^}]*\}\}/);
  if (!card) {
    note("подвал меню: нет общей серой карточки под профиль и выход " +
         "(ожидались --c-surface-2 и --c-border-2 в одном блоке стилей)");
  } else {
    // Окно с запасом: между стилем карточки и кнопкой выхода лежит блок
    // имени с почтой (~1 КБ), на 900 знаках кнопка не попадала в проверку.
    const after = src.slice(card.index, card.index + 1500);
    if (!/<LogoutButton[^>]*compact/.test(after)) {
      note("подвал меню: кнопка выхода вынесена из карточки профиля — " +
           "она должна быть встроена в тот же серый блок справа");
    }
  }
  console.log("  " + (has('justifyContent:"space-between"') && card ? "✓" : "✗") +
              " подвал меню: разнесение по краям и общая карточка профиля");
}

// Проверки, требующие доступа к исходникам страниц.
// Замечания складывает note() — итоговый счёт берётся из общего problems.
kpiBadgeCheck(modules.filter(([, abs]) => /[\\/]pages[\\/]/.test(abs)));
categoryPropGuardCheck(modules);
sidebarFooterCheck();
if (problems.length) {
  console.log("");
  for (const p of problems) console.log("  ✗ " + p);
} else {
  console.log("  ✓ неразрещённых ссылок нет");
}
moneyRulesCheck(modules);

const rt = runtimeCheck(modules);

// ── ЕДИНЫЙ ВЕРДИКТ ───────────────────────────────────────────────────────────
// Всегда последняя строка и всегда однозначная: «замечаний нет» либо «замечаний N».
// Раньше вывод заканчивался строкой «✓ Модули загружаются…» даже при найденной
// статической ошибке, и достаточно было посмотреть на последнюю строку (или
// прогнать вывод через `tail`), чтобы решить, что всё в порядке. Так и произошло
// с `MONO` в SettingsPage: проверка нашла ошибку, а я её не увидел.
// Три состояния, а не два: чисто / есть замечания / проверить не удалось.
// «Не удалось» обязано выглядеть иначе, чем «чисто» и иначе, чем «есть
// замечания», чтобы было понятно: править код или ставить зависимости.
const staticFails = problems.length;
const renderFails = rt.fail || 0;
const total = staticFails + renderFails;
const renderRan = rt.ran !== false;
console.log("");
if (blockers.length) {
  for (const b of blockers) console.log("  ⚠ " + b);
  console.log("");
  console.log(`ИТОГ: ⚠ ПРОВЕРКА НЕ ВЫПОЛНЕНА ПОЛНОСТЬЮ (статических замечаний: ${staticFails}; `
            + `рендер: ${renderRan ? "выполнен" : "НЕ выполнялся"}) — результат недостоверен, выкладывать нельзя`);
  process.exit(2);
}
if (total === 0) {
  console.log(`ИТОГ: ✓ замечаний нет (статических: 0, при рендере: 0; проверок ${rt.ok}, пропущено ${rt.skipped})`);
} else {
  console.log(`ИТОГ: ✗ замечаний ${total} (статических: ${staticFails}, при рендере: ${renderFails}) — ВЫКЛАДЫВАТЬ НЕЛЬЗЯ`);
  if (staticFails) console.log(`     строки со статическими замечаниями начинаются с «  ✗ » (см. выше)`);
}
process.exit(total === 0 ? 0 : (rt.status || 1));
