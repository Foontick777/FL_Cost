import { useState } from "react";
import { Card, Segmented } from "./components.jsx";
import { s } from "./styles.js";
import { fmtMoney } from "../lib/recurring.js";

/**
 * «Структура расходов» — сравнение по объектам (авто/прицепы) и по категориям.
 *
 * Почему карточки одного размера и с горизонтальной прокруткой. Раньше на
 * «Иных расходах» у каждой машины был свой набор колонок, и при переключении
 * между авто карточки «прыгали»: у одной пять категорий, у другой одна, а
 * заголовки уезжали. Здесь карточка фиксированной ширины, список категорий
 * внутри прокручивается, а сами карточки идут в ряд с горизонтальным скроллом —
 * поэтому ничего не смещается и читается как таблица.
 *
 * `mode` управляется снаружи: на страницах, где сравнение по объектам
 * бессмысленно (общие расходы не привязаны к авто), блок вызывается в режиме
 * категорий и переключатель не показывается.
 */
export function StructureBlock({
  lang, title, subtitle, mode, onModeChange, objects, categories,
  objectLabelRu = "По автомобилям", objectLabelEn = "By vehicle",
  catLabelRu = "По категориям", catLabelEn = "By category",
  showSwitcher = true, objectEmptyRu = "Нет расходов по объектам за период",
  objectEmptyEn = "No expenses by object in the period",
}) {
  const ru = lang === "RU";
  const [innerMode, setInnerMode] = useState(mode || "objects");
  const active = mode !== undefined ? mode : innerMode;
  const setActive = onModeChange || setInnerMode;

  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--c-text)" }}>
            {title || (ru ? "Структура расходов" : "Expense structure")}
          </h3>
          <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--c-muted-2)" }}>
            {subtitle || (ru ? "Сравнение по объектам и категориям" : "Comparison by object and category")}
          </p>
        </div>
        {showSwitcher && (
          <Segmented
            ariaLabel={ru ? "Разрез сравнения" : "Comparison mode"}
            value={active}
            onChange={setActive}
            items={[
              { id: "objects", label: ru ? objectLabelRu : objectLabelEn },
              { id: "categories", label: ru ? catLabelRu : catLabelEn },
            ]}
          />
        )}
      </div>

      {active === "objects" ? (
        objects && objects.length > 0 ? (
          <div className="fc-struct-scroll">
            {objects.map((o) => (
              <article className="fc-struct-card" key={o.key}>
                <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--c-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {o.title}
                    </div>
                    {o.subtitle && (
                      <div style={{ fontSize: 11.5, color: "var(--c-muted-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {o.subtitle}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <div style={{ fontWeight: 800, fontSize: 13, fontFamily: "var(--font-mono,monospace)", color: "var(--c-text)" }}>
                      {fmtMoney(o.total, o.currency || "EUR", lang)}
                    </div>
                  </div>
                </header>

                {/* Внутренний вертикальный скролл: категорий может быть много, а
                    карточки обязаны оставаться одного размера. */}
                <div style={{ marginTop: 8, flex: "1 1 auto", maxHeight: 186, overflowY: "auto" }}>
                  {o.rows.length === 0 ? (
                    <div style={{ fontSize: 11.5, color: "var(--c-muted-2)", padding: "6px 0" }}>
                      {ru ? "расходов нет" : "no expenses"}
                    </div>
                  ) : o.rows.map((r) => (
                    <div className="fc-struct-cat" key={r.key}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        {r.icon && <span aria-hidden="true">{r.icon}</span>}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--c-muted-2)" }}>
                          {r.name}
                        </span>
                      </span>
                      <b style={{ fontFamily: "var(--font-mono,monospace)", fontWeight: 600, color: r.amount ? "var(--c-text)" : "var(--c-muted-3)" }}>
                        {fmtMoney(r.amount, o.currency || "EUR", lang)}
                      </b>
                    </div>
                  ))}
                </div>

                <footer style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 10, paddingTop: 9, borderTop: "1px solid var(--c-border-2)", fontSize: 11.5 }}>
                  <span style={{ color: "var(--c-muted-2)" }}>{ru ? "Итого за период" : "Total for the period"}</span>
                  <b style={{ fontFamily: "var(--font-mono,monospace)", color: "var(--c-text)" }}>
                    {fmtMoney(o.total, o.currency || "EUR", lang)}
                  </b>
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <div style={{ padding: "16px 0", fontSize: 12.5, color: "var(--c-muted-2)", textAlign: "center" }}>
            {ru ? objectEmptyRu : objectEmptyEn}
          </div>
        )
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
          {(categories || []).length === 0 ? (
            <div style={{ padding: "12px 0", fontSize: 12.5, color: "var(--c-muted-2)" }}>
              {ru ? "Расходов за период нет" : "No expenses in the period"}
            </div>
          ) : (categories || []).map((c) => (
            <article key={c.key} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
              border: "1px solid var(--c-border-3)", borderRadius: 12, background: "var(--c-surface)",
            }}>
              <span aria-hidden="true" style={{
                width: 30, height: 30, borderRadius: 9, flex: "0 0 auto",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
                background: `color-mix(in srgb, ${c.color || "var(--c-brand-solid)"} 14%, transparent)`,
                color: "var(--c-text)",
              }}>{c.icon || "•"}</span>
              <span style={{ minWidth: 0, flex: "1 1 auto" }}>
                <span style={{ display: "block", fontWeight: 600, fontSize: 12.5, color: "var(--c-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.name}
                </span>
                <span style={{ display: "block", fontSize: 11, color: "var(--c-muted-2)" }}>
                  {c.count} {c.count === 1
                    ? (ru ? "операция" : "operation")
                    : (ru ? "операции" : "operations")}
                </span>
              </span>
              <b style={{ fontFamily: "var(--font-mono,monospace)", fontSize: 12.5, color: "var(--c-text)", whiteSpace: "nowrap" }}>
                {fmtMoney(c.total, c.currency || "EUR", lang)}
              </b>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
