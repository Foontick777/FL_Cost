#!/usr/bin/env node
/**
 * build.mjs — собирает страницы превью темы (`npm run theme:preview`).
 *
 * ЧТО ДЕЛАЕТ
 * ----------
 * Берёт настоящий глобальный CSS приложения, рендерит настоящие компоненты и
 * собирает ДВЕ страницы — светлую и тёмную. На каждой переменные темы стоят на
 * `:root`, как в приложении (`applyTheme` пишет их в documentElement). Это важно
 * для достоверности: если поставить переменные на обёртку колонки, базовые
 * правила вида `html,body{color:var(--c-text)}` перестают их находить и измерение
 * показывает дефект, которого в приложении нет — на этом я один раз ошибся.
 *
 * Дальше страницу открывает `audit.js` (встроен в неё) и измеряет вид: светлые
 * фоны, невидимый текст, поля ввода. Отчёт кладётся в DOM, поэтому читается
 * headless-браузером без распознавания картинок.
 *
 * Запуск:
 *   npm run theme:preview
 *   # затем (пример для тёмной страницы):
 *   google-chrome --headless --disable-gpu --no-sandbox --virtual-time-budget=5000 \
 *     --dump-dom file://$PWD/.check-tmp/theme-preview-dark.html
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIGHT, DARK } from "../../src/lib/theme.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FE = join(HERE, "..", "..");
const OUT = join(FE, ".check-tmp");
const ESBUILD = [
  join(FE, "node_modules", ".bin", "esbuild"),
  join(FE, "node_modules", "esbuild", "bin", "esbuild"),
  join(FE, "node_modules", "@esbuild", `${process.platform}-${process.arch}`, "bin", "esbuild"),
].find((p) => existsSync(p));
if (!ESBUILD) {
  console.log("Не найден esbuild — выполните `npm install` в папке frontend.");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

// 1. Глобальный CSS — ровно тот текст, который вставляет useGlobalStyles.
const styles = readFileSync(join(FE, "src", "ui", "styles.js"), "utf8");
const cssStart = styles.indexOf("style.textContent=`") + "style.textContent=`".length;
const css = styles.slice(cssStart, styles.indexOf("`;", cssStart));

// 2. Переводы для Sidebar: подписи лежат в App.jsx блоком T.
const app = readFileSync(join(FE, "src", "App.jsx"), "utf8");
const ruBlock = app.slice(app.indexOf("const T={"), app.indexOf("EN:{", app.indexOf("const T={")));
const T = {};
for (const m of ruBlock.matchAll(/(\w+):"((?:[^"\\]|\\.)*)"/g)) T[m[1]] = m[2];

// 3. Сборка компонентов.
const shim = join(OUT, "theme-preview-shim.cjs");
writeFileSync(shim, [
  "globalThis.window = globalThis;",
  "globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };",
  "globalThis.document = { createElement: () => ({ style:{}, setAttribute(){}, appendChild(){},",
  "  addEventListener(){}, remove(){} }), head: { appendChild(){} }, body: { appendChild(){} },",
  "  getElementById: () => null, addEventListener(){}, removeEventListener(){},",
  "  querySelector: () => null, querySelectorAll: () => [] };",
  "try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'preview' }, configurable: true }); } catch (e) {}",
  "globalThis.fetch = async () => ({ ok:false, status:503, json: async () => ({}), text: async () => '' });",
  "globalThis.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){} });",
  `globalThis.__FC_T__ = ${JSON.stringify(T)};`,
  "",
].join("\n"), "utf8");

const bundle = join(OUT, "theme-preview.cjs");
execFileSync(ESBUILD, [join(HERE, "entry.jsx"),
  "--bundle", "--format=cjs", "--platform=node", "--jsx=automatic", "--loader:.jsx=jsx",
  `--outfile=${bundle}`, "--log-level=error",
  "--external:react", "--external:react-dom", "--external:react-dom/server",
  "--external:react/jsx-runtime"], { stdio: "inherit" });

const render = (theme) => {
  try {
    return JSON.parse(execFileSync(process.execPath,
      ["-e", `require(${JSON.stringify(shim)}); require(${JSON.stringify(bundle)});`],
      { cwd: FE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FC_THEME: theme } })).markup;
  } catch (e) {
    console.log("Рендер превью не удался:");
    console.log(String(e.stderr || e.message).slice(0, 2000));
    process.exit(1);
  }
};

// 4. Страницы: по одной на тему, переменные — на :root, как в приложении.
const audit = readFileSync(join(HERE, "audit.js"), "utf8");
function page(markup, palette, theme) {
  const vars = Object.entries(palette).map(([k, v]) => `--c-${k}:${v}`).join(";");
  return `<!DOCTYPE html><html lang="ru" data-theme="${theme}"><head><meta charset="utf-8">
<title>Проверка темы — ${theme}</title><style>
:root{${vars}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif}
${css}</style></head><body>
${markup}
<script>${audit}</script></body></html>`;
}

const pages = [];
for (const [theme, palette] of [["light", LIGHT], ["dark", DARK]]) {
  const file = join(OUT, `theme-preview-${theme}.html`);
  writeFileSync(file, page(render(theme), palette, theme), "utf8");
  pages.push(file);
}
console.log("страницы превью готовы:");
for (const f of pages) console.log("  " + f);
console.log("измерение вида (пример для тёмной):");
console.log(`  google-chrome --headless --disable-gpu --no-sandbox --virtual-time-budget=5000 \\`);
console.log(`    --dump-dom file://${pages[1]}`);
