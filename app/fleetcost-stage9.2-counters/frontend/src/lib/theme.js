/**
 * Тёмная тема: палитра, применение и переключатель.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ И ПОЧЕМУ ПЕРЕМЕННЫЕ
 * ------------------------------------------
 * Всё оформление приложения — инлайн-стили (`style={{color:"#64748b"}}`). Инлайн-стиль
 * нельзя переопределить из CSS: у него максимальная специфичность. Поэтому единственный
 * способ сделать тему переключаемой — заменить цвета ЗНАЧЕНИЯМИ ПЕРЕМЕННЫХ:
 *
 *     color:"#64748b"  →  color:"var(--c-muted-2)"
 *
 * Тогда одна смена переменных на корне документа перекрашивает всё приложение, а
 * компоненты о темах не знают вообще. Механизм в проекте уже был — так сделаны радиусы
 * (`var(--r-lg)`); здесь он расширен на цвета.
 *
 * ГДЕ ЧТО ЛЕЖИТ
 * -------------
 * • `LIGHT` / `DARK` — значения переменных. Здесь ЕДИНСТВЕННОЕ место с хексами в
 *   приложении: проверка `npm run check:logic` следит, чтобы больше нигде их не было
 *   (единственное исключение — код ошибки React `#310` в комментарии).
 * • `scripts/color-map.json` — таблица «прежний хекс → переменная». Она же доказывает,
 *   что светлая тема осталась прежней: для каждого цвета из `vars` значение в `LIGHT`
 *   равно ровно тому хексу, который стоял в коде, — и это проверяется автоматически.
 *
 * ПРАВИЛО РОЛЕЙ: в тёмной теме светлые поверхности темнеют, а цвет текста светлеет —
 * направления противоположные. Поэтому цвета, которые служат И текстом, И заливкой,
 * разделены: `--c-brand` (текст на тёмном фоне) и `--c-brand-solid` (заливка кнопки).
 * Иначе заливка стала бы бледной, и белый текст на ней перестал бы читаться.
 */

/** Светлая тема. Значения совпадают с прежними хексами — вид не меняется. */
export const LIGHT = {
  // Поверхности
  "app": "#f6f8fa",
  "surface": "#ffffff",
  "surface-2": "#f1f5f9",
  "surface-3": "#f3f4f6",
  "hover": "#f8fafc",
  // Рамки
  "border": "#e2e8f0",
  "border-2": "#e5e7eb",
  "border-3": "#e9edf2",
  "border-strong": "#cbd5e1",
  "border-mid": "#c4c7c5",
  // Текст
  "text": "#0f172a",
  "text-2": "#111827",
  "text-3": "#1e293b",
  "text-4": "#334155",
  "text-5": "#374151",
  "muted": "#475569",
  "muted-2": "#64748b",
  "muted-3": "#6b7280",
  "muted-4": "#94a3b8",
  "muted-5": "#5e5e5e",
  // Блок кода
  "code-bg": "#0f172a",
  "code-fg": "#e2e8f0",
  // Бренд
  "brand": "#4f46e5",
  "brand-solid": "#4f46e5",
  "brand-strong": "#4338ca",
  "brand-500": "#6366f1",
  "brand-bg": "#eef2ff",
  "brand-bg-2": "#e0e7ff",
  "on-brand": "#ffffff",
  // Опасность
  "danger": "#dc2626",
  "danger-solid": "#dc2626",
  "danger-400": "#ef4444",
  "danger-strong": "#b91c1c",
  "danger-deep": "#7f1d1d",
  "danger-fg-soft": "#fca5a5",
  "danger-bg": "#fef2f2",
  "danger-bg-2": "#fee2e2",
  "danger-border": "#fecaca",
  "rose": "#be123c",
  "rose-600": "#e11d48",
  "rose-800": "#9f1239",
  "rose-soft": "#fb7185",
  // Предупреждение
  "warn": "#b45309",
  "warn-600": "#d97706",
  "warn-strong": "#92400e",
  "warn-solid": "#f59e0b",
  "warn-500": "#f59e0b",
  "warn-bg": "#fef3c7",
  "warn-bg-2": "#fffbeb",
  "warn-border": "#fde68a",
  "orange": "#f97316",
  // Успех
  "success": "#15803d",
  "success-2": "#16a34a",
  "success-solid": "#16a34a",
  "success-dark": "#166534",
  "success-deep": "#065f46",
  "emerald": "#059669",
  "emerald-strong": "#047857",
  "emerald-500": "#10b981",
  "emerald-300": "#34d399",
  "teal": "#0f766e",
  "teal-soft": "#0d9488",
  "teal-400": "#14b8a6",
  "success-bg": "#dcfce7",
  "success-bg-2": "#f0fdf4",
  "success-bg-3": "#ecfdf5",
  "success-border": "#a7f3d0",
  // Информация
  "info": "#1e40af",
  "info-2": "#1d4ed8",
  "blue": "#2563eb",
  "blue-500": "#3b82f6",
  "sky": "#0369a1",
  "sky-600": "#0284c7",
  "cyan": "#06b6d4",
  "cyan-deep": "#0e7490",
  "info-bg": "#eff6ff",
  "info-bg-2": "#e0f2fe",
  "info-bg-3": "#dbeafe",
  "info-border": "#bfdbfe",
  "info-border-2": "#bae6fd",
  // Фиолетовый
  "violet": "#7c3aed",
  "violet-solid": "#7c3aed",
  "violet-strong": "#6b21a8",
  "violet-700": "#6d28d9",
  "violet-500": "#8b5cf6",
  "violet-deep": "#3730a3",
  "violet-bg": "#f5f3ff",
  "violet-bg-2": "#f3e8ff",
  "violet-bg-3": "#fdf4ff",
  "violet-border": "#ddd6fe",
  "violet-border-2": "#c7d2fe",
  "pink": "#ec4899",
};

/**
 * Тёмная тема.
 *
 * Принципы подбора: текст не светлее #e6edf3 и не тусклее #6f7c8c (читается, но не
 * слепит); поверхности — от #0d1117 (фон окна) до #2b333e (рамки). Заливки кнопок и
 * плашек остаются насыщенными: на них лежит белый текст, и осветление сломало бы
 * контраст. Числовые проверки контраста — в `npm run check:logic`.
 */
export const DARK = {
  // Поверхности
  "app": "#141821",
  "surface": "#1c222c",
  "surface-2": "#232b36",
  "surface-3": "#202731",
  "hover": "#242c37",
  // Рамки
  "border": "#333d4a",
  "border-2": "#333d4a",
  "border-3": "#2c3540",
  "border-strong": "#424e5d",
  "border-mid": "#424e5d",
  // Текст
  "text": "#e6edf3",
  "text-2": "#e6edf3",
  "text-3": "#d7dee6",
  "text-4": "#bcc7d2",
  "text-5": "#c2ccd6",
  "muted": "#a9b6c4",
  "muted-2": "#8b98a8",
  "muted-3": "#8b98a8",
  "muted-4": "#8794a4",
  "muted-5": "#8b98a8",
  // Блок кода — наоборот, темнее фона
  "code-bg": "#10141c",
  "code-fg": "#cdd9e5",
  // Бренд: текст светлее, заливка насыщенная (на ней белый текст)
  "brand": "#8b93ff",
  "brand-solid": "#4f46e5",
  "brand-strong": "#a5aaff",
  "brand-500": "#8b93ff",
  "brand-bg": "#2a3150",
  "brand-bg-2": "#2d375a",
  "on-brand": "#ffffff",
  // Опасность
  "danger": "#f87171",
  "danger-solid": "#dc2626",
  "danger-400": "#f87171",
  "danger-strong": "#fca5a5",
  "danger-deep": "#fca5a5",
  "danger-fg-soft": "#fca5a5",
  "danger-bg": "#31201f",
  "danger-bg-2": "#3a2023",
  "danger-border": "#552a2f",
  "rose": "#fb7185",
  "rose-600": "#fb7185",
  "rose-800": "#fda4af",
  "rose-soft": "#fb7185",
  // Предупреждение
  "warn": "#fbbf24",
  "warn-600": "#fbbf24",
  "warn-strong": "#fcd34d",
  "warn-solid": "#d97706",
  "warn-500": "#fbbf24",
  "warn-bg": "#352c18",
  "warn-bg-2": "#2b2515",
  "warn-border": "#57471c",
  "orange": "#fb923c",
  // Успех
  "success": "#4ade80",
  "success-2": "#4ade80",
  "success-solid": "#16a34a",
  "success-dark": "#86efac",
  "success-deep": "#4ade80",
  "emerald": "#34d399",
  "emerald-strong": "#34d399",
  "emerald-500": "#10b981",
  "emerald-300": "#6ee7b7",
  "teal": "#2dd4bf",
  "teal-soft": "#2dd4bf",
  "teal-400": "#5eead4",
  "success-bg": "#1a3222",
  "success-bg-2": "#182b1f",
  "success-bg-3": "#182b1f",
  "success-border": "#296644",
  // Информация
  "info": "#93c5fd",
  "info-2": "#93c5fd",
  "blue": "#60a5fa",
  "blue-500": "#60a5fa",
  "sky": "#38bdf8",
  "sky-600": "#38bdf8",
  "cyan": "#22d3ee",
  "cyan-deep": "#22d3ee",
  "info-bg": "#1c2836",
  "info-bg-2": "#182935",
  "info-bg-3": "#1c2a42",
  "info-border": "#2a4c6e",
  "info-border-2": "#265769",
  // Фиолетовый
  "violet": "#a78bfa",
  "violet-solid": "#7c3aed",
  "violet-strong": "#c4b5fd",
  "violet-700": "#a78bfa",
  "violet-500": "#a78bfa",
  "violet-deep": "#a5b4fc",
  "violet-bg": "#29223b",
  "violet-bg-2": "#2e223b",
  "violet-bg-3": "#312336",
  "violet-border": "#443c78",
  "violet-border-2": "#3e4678",
  "pink": "#f472b6",
};

export const PALETTES = { light: LIGHT, dark: DARK };

export const THEME_KEY = "fc_theme";           // localStorage: light | dark | system
export const THEME_MODES = ["light", "dark", "system"];

const DEFAULT_MODE = "system";

/** Разрешённый режим из строки: что угодно вне списка — снова system. */
export function normalizeThemeMode(mode) {
  return THEME_MODES.includes(mode) ? mode : DEFAULT_MODE;
}

/** Системная тема, если браузер о ней сообщает. */
export function systemPrefersDark(matchMedia) {
  try {
    const mm = matchMedia && matchMedia("(prefers-color-scheme: dark)");
    return !!(mm && mm.matches);
  } catch (e) {
    return false;
  }
}

/** Какой палитрой рисовать при данном режиме — с учётом системной настройки. */
export function resolveTheme(mode, prefersDark) {
  const m = normalizeThemeMode(mode);
  if (m === "light") return "light";
  if (m === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

function resolveExplicit(resolved) {
  return resolved === "dark" ? "dark" : "light";
}

/** Переменные темы как CSS-правило: используется для применения и в проверках. */
export function themeVars(resolved) {
  const palette = PALETTES[resolveExplicit(resolved)] || LIGHT;
  return Object.entries(palette).map(([k, v]) => `--c-${k}:${v}`).join(";");
}

/**
 * Применяет тему к документу: пишет переменные и помечает корень для CSS.
 * `color-scheme` нужен, чтобы системные элементы (полосы прокрутки, поля ввода,
 * автозаполнение) тоже стали тёмными — иначе светлое поле в тёмной теме выглядит
 * как дефект вёрстки.
 */
export function applyTheme(resolved, doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || !d.documentElement) return;
  const root = d.documentElement;
  const name = resolveExplicit(resolved);
  const palette = PALETTES[name] || LIGHT;
  for (const [k, v] of Object.entries(palette)) {
    root.style.setProperty(`--c-${k}`, v);
  }
  try { root.setAttribute("data-theme", name); } catch (e) {}
  try { root.style.colorScheme = name; } catch (e) {}
  // Цвет текста и фон ставим и на корень: до загрузки стилей (или если их
  // вставка не удалась) всё равно наследуется правильное значение, и браузерный
  // чёрный не появляется. Именно из-за него в тёмной теме «исчезали» подписи.
  try { root.style.color = palette.text; } catch (e) {}
  try { root.style.background = palette.app; } catch (e) {}
}

/** Прочитать сохранённый режим (переживает перезагрузку и перезаход). */
export function readStoredTheme(storage) {
  try {
    const st = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    return normalizeThemeMode(st ? st.getItem(THEME_KEY) : null);
  } catch (e) {
    return DEFAULT_MODE;
  }
}

export function storeTheme(mode, storage) {
  try {
    const st = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (st) st.setItem(THEME_KEY, normalizeThemeMode(mode));
  } catch (e) {}
}

/**
 * Тема до первого отрисованного кадра.
 *
 * Тот же расчёт продублирован коротким скриптом в index.html: без него на тёмном
 * системном фоне успевает мигнуть белая страница. Здесь — для повторного применения,
 * например когда системная тема меняется «на лету».
 */
export function initTheme(doc, storage, matchMedia) {
  const mode = readStoredTheme(storage);
  applyTheme(resolveTheme(mode, systemPrefersDark(matchMedia)), doc);
  return mode;
}
