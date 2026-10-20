#!/usr/bin/env node
/**
 * check-self.mjs — проверка самой проверки (`npm run check:self`).
 *
 * ЗАЧЕМ
 * -----
 * «Гейт зелёный» может означать две разные вещи: «ошибок нет» или «гейт ослеп».
 * Это не теория. В этом проекте белый экран случался уже ПОСЛЕ зелёной проверки
 * (анализатор не видел очередной класс ссылок), а один раз проверка ошибку
 * НАШЛА, но её не заметили, глядя на конец вывода: последней строкой шло
 * «✓ Модули загружаются…» вместо итога.
 *
 * Поэтому здесь каждый дефект вносится НАМЕРЕННО, и проверка обязана его
 * поймать. Если случай перестанет ловиться — падает уже этот скрипт: это видно
 * сразу и здесь, а не как белый экран у пользователя.
 *
 * ПОЧЕМУ НА КОПИИ
 * ---------------
 * Чтобы гейт увидел дефект, код действительно надо сломать. Первая версия
 * правила НАСТОЯЩИЕ файлы и возвращала их в `finally` плюс по сигналу — и это
 * не сработало: во время `execFileSync` (запуск esbuild и самого гейта)
 * событийный цикл Node заблокирован, поэтому обработчик сигнала не выполняется
 * до возврата дочернего процесса. Проверено на живом примере: SIGTERM на
 * первой секунде 34-секундного прогона был доставлен, но проигнорирован, и
 * скрипт дошёл до конца. Любое прерывание (Ctrl+C, SIGKILL, падение узла)
 * оставило бы репозиторий с намеренно сломанным кодом.
 *
 * Теперь правится КОПИЯ: `scripts/` и `src/` копируются во временный каталог,
 * `node_modules` подключается символической ссылкой. Рабочее дерево не
 * изменяется вообще, и прерывать можно когда угодно.
 *
 * ВАЖНО ПРО СИНХРОННОСТЬ. Обработчик сигнала выполняется только тогда, когда
 * крутится событийный цикл. Если весь скрипт синхронный (а он был таким:
 * `execFileSync` в цикле), событийный цикл не разу не поворачивается, и
 * обработчик НЕ ВЫПОЛНЯЕТСЯ НИКОГДА — при этом зарегистрированный обработчик
 * отменяет стандартное поведение «умереть по сигналу», то есть процесс
 * начинает сигнал игнорировать. Это хуже, чем не иметь обработчика вовсе.
 * Проверено: SIGTERM на 6-й секунде 34-секундного прогона игнорировался.
 * Поэтому прогон гейта сделан АСИНХРОННЫМ (`execFile` + await): между шагами
 * цикл свободен, сигнал обрабатывается сразу, дочерний процесс убивается,
 * копия убирается.
 *
 * Запуск: npm run check:self
 * Коды возврата: 0 — все классы дефектов ловятся, 1 — нет, 2 — исходный код
 * уже с замечаниями, 3 — гейт не смог выполниться.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "fc-check-self-"));

function setupSandbox() {
  cpSync(join(ROOT, "scripts"), join(SANDBOX, "scripts"), { recursive: true });
  cpSync(join(ROOT, "src"), join(SANDBOX, "src"), { recursive: true });
  const nm = join(ROOT, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, join(SANDBOX, "node_modules"));
}

function cleanupSandbox() {
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
}

/**
 * Уборка с повтором. Одного `rmSync` мало: гейт запускает esbuild, и убийство
 * родителя (гейта) не убивает внука — esbuild успевает пересоздать `.check-tmp`
 * уже после уборки, и каталог остаётся. Поэтому сначала снимаем всю группу
 * процессов (см. `detached` в runCheck), затем убираем с несколькими попытками.
 */
async function cleanupSandboxEventually() {
  for (let i = 0; i < 6; i++) {
    cleanupSandbox();
    if (!existsSync(SANDBOX)) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return !existsSync(SANDBOX);
}
// Временный каталог живёт до конца процесса; обработчики нужны лишь чтобы не
// оставлять мусор при прерывании. В отличие от восстановления файлов, здесь
// задержка обработчика безопасна: чистить нечего, даже если сигнал придёт
// позже — испортить можно только копию.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, async () => {
    // Снимаем всю группу процессов дочернего гейта, а не только его самого:
    // иначе esbuild (внук) переживёт родителя и допишет файлы в копию.
    try {
      if (currentChild && currentChild.pid) {
        try { process.kill(-currentChild.pid, "SIGKILL"); }
        catch (e) { try { currentChild.kill("SIGKILL"); } catch (e2) {} }
      }
    } catch (e) {}
    const ok = await cleanupSandboxEventually();
    console.log("\n⊘ прервано — рабочее дерево не изменялось; "
      + (ok ? "временная копия убрана" : "временную копию убрать не удалось: " + SANDBOX));
    process.exit(130);
  });
}

/** Классы дефектов, которые проверка обязана ловить. */
const CASES = [
  {
    what: "импорт потерян (класс «белый экран»)",
    // Шаблон намеренно терпим к составу импорта: раньше здесь было точное
    // `import { s } from ...`, и когда в файл добавили второе имя
    // (KPI_CORNER_PAD), сценарий перестал применяться и самопроверка сообщила
    // «ШАБЛОН ПОЛОМКИ НЕ СРАБОТАЛ» — то есть гейт перестал проверяться.
    patches: [{ file: "src/pages/TollsPage.jsx",
                break: (s) => s.replace(/^import \{[^}]*\bs\b[^}]*\} from "\.\.\/ui\/styles\.js";\n/m, "", 1) }],
    // Порядок имён в сообщении зависит от обхода дерева, поэтому проверяем
    // факт обнаружения `s`, а не его позицию в строке.
    expect: /использует без импорта:[^\n]*\bs\b/,
  },
  {
    what: "хук React без импорта",
    patches: [{ file: "src/pages/SalaryPage.jsx",
                break: (s) => s.replace(/^import \{[^}]*\} from "react";\n/m, "", 1) }],
    expect: /без импорта \(react\/react-dom\)/,
  },
  {
    what: "модуль не экспортирует импортируемое имя (падает сборка)",
    patches: [{ file: "src/pages/TollsPage.jsx",
                break: (s) => s.replace("export function TollsPage(", "function TollsPage(", 1) }],
    expect: /не экспортирует/,
  },
  {
    what: 'role="dialog" мимо <Modal>',
    patches: [{ file: "src/pages/MileagePage.jsx",
                break: (s) => s.replace("return(", 'const fcSelfTest=<div role="dialog"/>;\n  return(', 1) }],
    expect: /role="dialog" вне ui\/Modal\.jsx/,
  },
  {
    what: "<Modal> без доступного имени",
    patches: [{ file: "src/pages/AuditLogPage.jsx",
                break: (s) => s.replace(/ label=\{`Детали записи \$\{selected\.id\}`\}/, "", 1) }],
    expect: /<Modal> без доступного имени/,
  },
  {
    what: "имя объявлено, но НЕ экспортируется (и используется в другом файле)",
    patches: [
      { file: "src/lib/tx.js",
        break: (s) => s.replace("export function isFuel(",
          "const fcSelfTestOnly = 1;\nexport function isFuel(", 1) },
      { file: "src/pages/MileagePage.jsx",
        break: (s) => s.replace("{t,lang,period,setPeriod,custom,setCustom}){",
          "{t,lang,period,setPeriod,custom,setCustom}){\n  const fcSelfTest = fcSelfTestOnly;", 1) },
    ],
    expect: /использует без импорта: fcSelfTestOnly/,
  },
];

// Текущий дочерний процесс — чтобы обработчик сигнала мог его снять.
let currentChild = null;

/** Прогон гейта в песочнице (асинхронно, чтобы работали сигналы). */
function runCheck() {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [join(SANDBOX, "scripts/check-modules.mjs")],
      // detached: у гейта своя группа процессов, поэтому сигнал можно послать
      // всей группе (-pid) и заодно снять esbuild, запущенный внутри гейта.
      { cwd: SANDBOX, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, detached: true },
      (err, stdout, stderr) => {
        currentChild = null;
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          out: String(stdout || "") + String(stderr || ""),
        });
      });
    currentChild = child;
  });
}

const failsOf = (out) => out.split("\n").filter((l) => l.includes("✗")).map((l) => "     " + l.trim());

console.log("── самопроверка гейта: каждый дефект вносится намеренно и должен быть найден");
console.log(`   (работаем на копии в ${SANDBOX} — рабочее дерево не изменяется)\n`);

setupSandbox();

const base = await runCheck();
// Код 2 — гейт не смог выполниться (нет esbuild и т.п.). Это НЕ про код:
// самопроверка в таком состоянии ничего не значит, поэтому и говорим иначе.
if (base.code === 2) {
  console.log("⚠ ГЕЙТ НЕ СМОГ ВЫПОЛНИТЬСЯ — самопроверка бессмысленна, пока он не запускается:");
  console.log(base.out.split("\n").filter((l) => l.includes("⚠")).map((l) => "     " + l.trim()).join("\n")
              || "     (подробностей нет)");
  await cleanupSandboxEventually();
  process.exit(3);
}
if (base.code !== 0) {
  console.log("✗ ИСХОДНОЕ СОСТОЯНИЕ УЖЕ С ЗАМЕЧАНИЯМИ — сначала почините код:");
  console.log(failsOf(base.out).join("\n"));
  await cleanupSandboxEventually();
  process.exit(2);
}
console.log("  ✓ исходное состояние: замечаний нет\n");

let bad = 0;
for (const c of CASES) {
  const saved = [];
  let applied = true;
  try {
    for (const p of c.patches) {
      const path = join(SANDBOX, p.file);
      const original = readFileSync(path, "utf8");
      const broken = p.break(original);
      if (broken === original) { applied = false; break; }
      saved.push({ path, original });
      writeFileSync(path, broken);
    }
    if (!applied) {
      bad++;
      console.log(`  ✗ ${c.what}: ШАБЛОН ПОЛОМКИ НЕ СРАБОТАЛ — тест ничего не проверил`);
      console.log("     (значит сценарий устарел: код вокруг места правки изменился)");
      continue;
    }
    const r = await runCheck();
    if (r.code === 2) {
      bad++;
      console.log(`  ✗ ${c.what}: ГЕЙТ НЕ ВЫПОЛНИЛСЯ (код 2) — сценарий не проверен`);
      continue;
    }
    const found = r.code !== 0 && c.expect.test(r.out);
    if (!found) bad++;
    console.log(`  ${found ? "✓" : "✗"} ${c.what}: ${found ? "пойман" : "НЕ ПОЙМАН"} (код ${r.code})`);
    if (!found) {
      console.log(`     ожидался текст: ${c.expect}`);
      console.log(failsOf(r.out).join("\n") || "     (замечаний в выводе нет вообще)");
    }
  } finally {
    for (const s of saved) writeFileSync(s.path, s.original);   // копию возвращаем всегда
  }
}

// Контроль: после снятия всех поломок копия снова чистая. Если это не так,
// значит какой-то сценарий не восстановил файл — и тест врёт.
const after = await runCheck();
const restored = after.code === 0 && /ИТОГ: ✓ замечаний нет/.test(after.out);
console.log(`\n  ${restored ? "✓" : "✗"} после снятия поломок: ${restored ? "копия снова чистая" : "В КОПИИ ОСТАЛИСЬ ПРАВКИ!"}`);
if (!restored) bad++;

await cleanupSandboxEventually();

console.log(`\nИТОГ: ${bad === 0
  ? "✓ проверка ловит все " + CASES.length + " классов дефектов, рабочее дерево не изменялось"
  : "✗ самопроверка провалена, проблемных случаев: " + bad}`);
process.exit(bad === 0 ? 0 : 1);
