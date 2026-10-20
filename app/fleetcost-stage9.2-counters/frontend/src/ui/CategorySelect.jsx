/**
 * Выбор категории расхода с созданием «прямо из списка».
 *
 * Требование §4 ТЗ: если нужной категории нет, её можно создать здесь же —
 * `Категория [ Шиномонтаж ▼ ] + Создать новую категорию`. Отдельный экран
 * администрирования тоже есть, но заставлять пользователя уходить с формы
 * расхода ради одной категории — именно та «жёсткая рамка», которую убираем.
 *
 * Неактивные категории в списке НЕ предлагаются (§12 п.9), но если операция
 * открыта по уже сохранённой строке с отключённой категорией, её показываем —
 * иначе значение поля молча подменилось бы.
 */
import { useMemo, useState } from "react";
import { s } from "./styles.js";
import { categoriesForSection, createCategory, sectionLabel, useCategories } from "../lib/categories.js";

const NEW = "__create_new__";

export function CategorySelect({
  section,
  catState: catStateProp,
  value,
  onChange,
  lang = "RU",
  id,
  allowCreate = true,
  includeInactive = false,
  placeholder,
  style,
  disabled = false,
}) {
  // ── Категории берём сами, если их не передали ────────────────────────────
  //
  // ПОЧЕМУ. Компонент читал `catState.list` без проверки, а на двух путях
  // (блок регулярных платежей и страница лизинга) состояние категорий вообще не
  // передавалось. Пока значение поля пустое, падения не было — но как только в
  // поле оказывался сохранённый код (редактирование договора, а также создание
  // новой категории прямо из списка), выполнялся `catState.list` у undefined, и
  // форма падала с «Cannot read properties of undefined (reading 'list')» —
  // белый экран вместо формы.
  //
  // Хук вызывается ВСЕГДА (условный вызов хука запрещён правилами React), но
  // переданное снаружи состояние имеет приоритет: страницы, у которых список уже
  // есть, не делают лишней работы.
  const catStateOwn = useCategories();
  const catState = catStateProp || catStateOwn;
  const catList = (catState && catState.list) || [];

  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftIcon, setDraftIcon] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const options = useMemo(
    () => categoriesForSection(catState, section, { includeInactive }),
    [catState, section, includeInactive],
  );

  // Значение, которого нет среди активных категорий (историческая строка),
  // должно остаться видимым в поле.
  const missingActive = value && !options.some((c) => c.code === value);
  const current = missingActive
    ? catList.find((c) => c.section === section && c.code === value)
    : null;

  const ru = lang === "RU";

  async function save() {
    const name = draftName.trim();
    if (!name) { setError(ru ? "Введите название" : "Enter a name"); return; }
    setBusy(true);
    setError("");
    const res = await createCategory({
      section,
      name,
      icon: draftIcon.trim() || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error || (ru ? "Не удалось создать категорию" : "Could not create category"));
      return;
    }
    setCreating(false);
    setDraftName("");
    setDraftIcon("");
    onChange(res.category.code);
  }

  if (creating) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            aria-label={ru ? "Иконка категории" : "Category icon"}
            style={{ ...(style || s.input), width: 54, textAlign: "center" }}
            placeholder="📍"
            maxLength={4}
            value={draftIcon}
            onChange={(e) => setDraftIcon(e.target.value)}
          />
          <input
            aria-label={ru ? "Название новой категории" : "New category name"}
            style={{ ...(style || s.input), flex: 1 }}
            placeholder={ru ? "Напр. GPS / Телематика" : "e.g. GPS / Telematics"}
            value={draftName}
            autoFocus
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); save(); }
              if (e.key === "Escape") { e.preventDefault(); setCreating(false); setError(""); }
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="fc-btn"
            onClick={save}
            disabled={busy}
            style={{ ...s.btnPrimary, padding: "6px 12px", fontSize: 12 }}
          >
            {busy ? "…" : (ru ? "Создать" : "Create")}
          </button>
          <button
            type="button"
            className="fc-btn"
            onClick={() => { setCreating(false); setError(""); }}
            style={{ ...s.btn, padding: "6px 12px", fontSize: 12 }}
          >
            {ru ? "Отмена" : "Cancel"}
          </button>
          <span style={{ fontSize: 11, color: "var(--c-muted-2)" }}>
            {ru ? `Раздел: ${sectionLabel(section, lang)}` : `Section: ${sectionLabel(section, lang)}`}
          </span>
        </div>
        {(error || value) && error && (
          <div style={{ fontSize: 12, color: "var(--c-danger-strong)" }}>{error}</div>
        )}
      </div>
    );
  }

  return (
    <select
      id={id}
      style={style || s.input}
      value={value || ""}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        if (v === NEW) { setCreating(true); return; }
        onChange(v);
      }}
    >
      <option value="">{placeholder || (ru ? "— выберите категорию —" : "— select category —")}</option>
      {missingActive && (
        <option value={value}>{current ? current.name : value} {ru ? "(отключена)" : "(disabled)"}</option>
      )}
      {options.map((c) => (
        <option key={c.id} value={c.code}>
          {c.icon ? `${c.icon} ` : ""}{c.name}
        </option>
      ))}
      {allowCreate && <option value={NEW}>{ru ? "＋ Создать новую категорию" : "＋ Create new category"}</option>}
    </select>
  );
}

/**
 * Компактный список тегов категорий — для карточек аналитики, где категорий
 * может быть сколько угодно (раньше было ровно 4 зашитых: Штрафы/Парковки/
 * Ремонты/Прочее, а «GPS» и «Шиномонтаж» из примера ТЗ туда не влезали).
 */
export function CategoryTag({ cat, fallback, lang }) {
  const name = cat ? `${cat.icon ? cat.icon + " " : ""}${cat.name}` : (fallback || "—");
  const color = (cat && cat.color) || null;
  return (
    <span
      style={{
        background: color ? `color-mix(in srgb, ${color} 14%, transparent)` : "var(--c-violet-bg)",
        color: color || "var(--c-violet)",
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 6,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {name}
    </span>
  );
}
