import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge, Segmented } from "./components.jsx";
import { s } from "./styles.js";
import { apiFetch, apiGet, reportUiError} from "../lib/api.js";
import { Modal } from "./Modal.jsx";
import { ExpenseFormModal } from "./ExpenseForm.jsx";
import { useCategories } from "../lib/categories.js";
import {
  STATUS_LABELS, chargeDayLabel, deleteRecurring, fmtDay, fmtMoney, frequency,
  isCurrent, monthlyByCurrency, nearestChargeDate, pauseRecurring, progressPct,
  remainingLabel, resumeRecurring, statusLabel,
} from "../lib/recurring.js";

/**
 * Блок «Регулярные платежи» — один и тот же на всех вкладках.
 *
 * Раскладка (как в утверждённой вёрстке):
 *   шапка      — значок, заголовок, «N активных · ближайшее списание», сумма в
 *                месяц, свернуть/развернуть, «+ Добавить регулярный»;
 *   фильтры    — слева сегментированный переключатель Текущие/Будущие/Завершённые,
 *                справа чипсы категорий (прокручиваются по горизонтали);
 *   таблица    — (i) · договор · платёж · срок · прогресс · статус · «…».
 *
 * Кнопка (i) открывает окно со всеми данными договора. Остановить/продолжить,
 * изменить, начисления и удалить убраны в меню «…»: пять иконок в каждой строке
 * сливались в кашу и ломали ширину колонок.
 *
 * Остановка и удаление намеренно разные: остановить договор с историей платежей
 * и стереть договор вместе с историей — не одно и то же действие, поэтому
 * удаление требует отдельного подтверждения.
 */
export function RecurringPanel({
  payments, loading, lang, onReload, onAdd, title, subtitle, emptyHint,
  // Нужны форме редактирования: t — словарь, vehicles — список объектов.
  t = null, vehicles = [],
  sectionLabel = null, defaultOpen = true, section = null,
}) {
  // Справочник категорий для формы расчёта: без него редактирование
  // договора падало белым экраном (форма читала catState.list у undefined).
  const catState = useCategories();
  const ru = lang === "RU";
  const [open, setOpen] = useState(defaultOpen);
  const hasPayments = payments.length > 0;
  const [detailsOf, setDetailsOf] = useState(null);
  const [filter, setFilter] = useState("current");
  const [catFilter, setCatFilter] = useState(null);
  const [busy, setBusy] = useState(null);          // id договора, по которому идёт действие
  const [deleteOf, setDeleteOf] = useState(null);  // договор, удаление которого подтверждают
  // Правка меняет график, но НЕ уже созданные списания — они остаются историей
  // (см. PATCH /recurring-expenses/{id}).
  const [editing, setEditing] = useState(null);
  const [chargesOf, setChargesOf] = useState(null);

  // Счётчики вкладок считаем по всем договорам раздела, а не по отфильтрованным:
  // иначе после выбора категории «Будущие» показывало бы 0 и выглядело как потеря.
  const counts = useMemo(() => ({
    current: payments.filter(isCurrent).length,
    upcoming: payments.filter((p) => p.display_status === "upcoming").length,
    completed: payments.filter((p) => p.display_status === "completed").length,
  }), [payments]);

  // Если «Текущих» нет, а есть будущие/завершённые — открываем ту группу, где
  // что-то есть: иначе свежесозданный договор с будущей датой выглядел бы как
  // «ничего не добавилось».
  const autoPicked = useRef(false);
  useEffect(() => {
    if (loading || autoPicked.current || !hasPayments) return;
    autoPicked.current = true;
    if (counts.current === 0) setFilter(counts.upcoming ? "upcoming" : "completed");
  }, [loading, hasPayments, counts]);

  const catChips = useMemo(() => {
    const map = new Map();
    payments.forEach((p) => {
      if (p.section && p.code) map.set(`${p.section}:${p.code}`, p.category_name || p.code);
    });
    return Array.from(map.entries()).map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [payments]);

  // Выбранная категория исчезла (договор удалили) — сбрасываем фильтр, иначе
  // список остался бы пустым без видимой причины.
  useEffect(() => {
    if (catFilter && !catChips.some((c) => c.key === catFilter)) setCatFilter(null);
  }, [catFilter, catChips]);

  const visible = useMemo(() => payments.filter((p) => {
    const byStatus = filter === "current" ? isCurrent(p) : p.display_status === filter;
    if (!byStatus) return false;
    if (catFilter && `${p.section}:${p.code}` !== catFilter) return false;
    return true;
  }), [payments, filter, catFilter]);

  // Итог по валютам: складывать EUR, PLN и USD в одно число нельзя.
  const perMonth = monthlyByCurrency(payments);
  const nearest = nearestChargeDate(payments);
  const activeCount = payments.filter((p) => p.display_status === "active").length;

  async function act(id, fn) {
    setBusy(id);
    const res = await fn(id);
    setBusy(null);
    if (res?.ok === false) { reportUiError(res.error); return false; }
    onReload?.();
    return true;
  }

  const subline = activeCount > 0
    ? (ru
      ? `${activeCount} активных${nearest ? ` • ближайшее списание ${fmtDay(nearest, lang)}` : ""}`
      : `${activeCount} active${nearest ? ` • next charge ${fmtDay(nearest, lang)}` : ""}`)
    : (hasPayments
      ? (ru ? "нет активных договоров" : "no active contracts")
      : (subtitle || (ru ? "Регулярных платежей пока нет" : "No recurring payments yet")));

  return (
    <section style={{
      background: "var(--c-surface)", border: "1px solid var(--c-border-3)",
      borderRadius: 16, overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "14px 16px" }}>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
                style={{
                  display: "flex", alignItems: "center", gap: 12, flex: "1 1 320px",
                  minWidth: 0, background: "none", border: "none", padding: 0,
                  cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                }}>
          <span aria-hidden="true" style={{
            width: 36, height: 36, borderRadius: 11, display: "flex", alignItems: "center",
            justifyContent: "center", background: "var(--c-brand-bg)", color: "var(--c-brand-solid)",
            fontSize: 17, flex: "0 0 auto", border: "1px solid var(--c-border-3)",
          }}>↻</span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 700, fontSize: 15, color: "var(--c-text)" }}>
              {title || (ru ? "Регулярные платежи" : "Recurring payments")}
            </span>
            <span style={{ display: "block", fontSize: 12, color: "var(--c-muted-2)" }}>{subline}</span>
          </span>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "0 0 auto", marginLeft: "auto" }}>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
                  aria-label={open ? (ru ? "Свернуть" : "Collapse") : (ru ? "Развернуть" : "Expand")}
                  style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none",
                           cursor: "pointer", fontFamily: "inherit", padding: 0, textAlign: "right" }}>
            <span>
              {perMonth.length === 0 && (
                <span style={{ display: "block", fontWeight: 800, fontSize: 16, color: "var(--c-text)" }}>—</span>
              )}
              {/* Каждая валюта — своей строкой. Сложение валют без курса дало бы
                  красивое, но неправдивое одно число. */}
              {perMonth.map((row) => (
                <span key={row.currency} style={{ display: "block", fontWeight: 800, fontSize: 16,
                                                 color: "var(--c-text)", whiteSpace: "nowrap" }}>
                  {fmtMoney(row.amount, row.currency, lang)}
                </span>
              ))}
              <span style={{ display: "block", fontSize: 11, color: "var(--c-muted-2)" }}>
                {ru ? "в месяц" : "per month"}
              </span>
            </span>
            <span aria-hidden="true" style={{ color: "var(--c-muted-2)", fontSize: 12 }}>{open ? "▲" : "▼"}</span>
          </button>
          {onAdd && (
            <button type="button" onClick={() => onAdd()}
                    style={{ ...s.btn, flex: "0 0 auto", whiteSpace: "nowrap", fontWeight: 600,
                             background: "var(--c-brand-bg)", color: "var(--c-brand)",
                             borderColor: "var(--c-border-3)" }}>
              + {ru ? "Добавить регулярный" : "Add recurring"}
            </button>
          )}
        </div>
      </div>

      {open && (
        <div style={{ borderTop: "1px solid var(--c-border-2)" }}>
          {hasPayments && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                          flexWrap: "wrap", margin: "12px 16px", padding: 8, borderRadius: 12,
                          background: "var(--c-surface-2)" }}>
              <Segmented
                ariaLabel={ru ? "Состояние договоров" : "Contract state"}
                value={filter}
                onChange={setFilter}
                items={[
                  { id: "current", label: `${ru ? "Текущие" : "Current"}${counts.current ? ` (${counts.current})` : ""}` },
                  { id: "upcoming", label: `${ru ? "Будущие" : "Upcoming"}${counts.upcoming ? ` (${counts.upcoming})` : ""}` },
                  { id: "completed", label: `${ru ? "Завершённые" : "Completed"}${counts.completed ? ` (${counts.completed})` : ""}` },
                ]}
              />
              {catChips.length > 1 && (
                <div className="fc-cards-scroll"
                     style={{ display: "flex", gap: 6, overflowX: "auto", minWidth: 0, maxWidth: "100%", paddingBottom: 2 }}>
                  <button type="button" onClick={() => setCatFilter(null)} style={chipStyle(catFilter === null)}>
                    {ru ? "Все категории" : "All categories"}
                  </button>
                  {catChips.map((c) => (
                    <button key={c.key} type="button" onClick={() => setCatFilter(c.key)}
                            style={chipStyle(catFilter === c.key)}>{c.name}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {loading && !hasPayments ? (
            <div style={{ padding: "14px 16px 18px", fontSize: 12.5, color: "var(--c-muted-2)" }}>
              {ru ? "Загрузка…" : "Loading…"}
            </div>
          ) : visible.length === 0 ? (
            <div style={{ padding: "20px 16px 24px", textAlign: "center", fontSize: 12.5, color: "var(--c-muted-2)" }}>
              {emptyHint || (!hasPayments
                ? (ru ? "Регулярных платежей пока нет. Нажмите «Добавить регулярный» — например, лизинг, страховку или аренду."
                      : "No recurring payments yet. Use “Add recurring” — e.g. leasing, insurance or rent.")
                : filter === "current"
                  ? (ru ? "Текущих договоров нет." : "No current contracts.")
                  : (ru ? "В этой группе договоров нет." : "No contracts in this group."))}
            </div>
          ) : (
            <div className="fc-rec-scroll">
              <div className="fc-rec-table">
                <div className="fc-rec-head">
                  <span />
                  <span>{ru ? "Договор / Объект" : "Contract / Object"}</span>
                  <span>{ru ? "Платёж" : "Payment"}</span>
                  <span>{ru ? "Срок и списание" : "Term & charge"}</span>
                  <span>{ru ? "Прогресс" : "Progress"}</span>
                  <span>{ru ? "Статус" : "Status"}</span>
                  <span />
                </div>
                {visible.map((p) => (
                  <Row key={p.id} p={p} lang={lang} busy={busy === p.id}
                       onDetails={() => setDetailsOf(p)}
                       onCharges={() => setChargesOf(p)}
                       onEdit={() => setEditing(p)}
                       onPause={() => act(p.id, pauseRecurring)}
                       onResume={() => act(p.id, resumeRecurring)}
                       onDelete={() => setDeleteOf(p)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {detailsOf && (
        <DetailsModal lang={lang} t={t} p={detailsOf} onClose={() => setDetailsOf(null)}
                      onCharges={() => { setChargesOf(detailsOf); setDetailsOf(null); }} />
      )}

      {chargesOf && (
        <ChargesModal lang={lang} t={t} contract={chargesOf}
                      onClose={() => setChargesOf(null)}
                      onChanged={onReload}/>
      )}

      {deleteOf && (
        <Modal onClose={() => setDeleteOf(null)} align="center" maxWidth={440}
               label={ru ? "Удалить договор" : "Delete contract"}>
          <h3 style={{ ...s.cardTitle, margin: "0 0 8px" }}>
            {ru ? "Удалить регулярный платёж?" : "Delete this recurring payment?"}
          </h3>
          <p style={{ fontSize: 13, color: "var(--c-muted)", margin: "0 0 16px", lineHeight: 1.5 }}>
            <b>{deleteOf.description}</b>
            {/* PAY-01 (аудит stage8): сервер больше не удаляет списания вместе с
                договором — при наличии начислений вернёт 409 и попросит «Остановить».
                Текст диалога честно описывает это, а не обещает удаление с историей. */}
            {ru
              ? " будет удалён безвозвратно. Удалить можно только договор без единого списания; если начисления уже есть, сервер вернёт подсказку использовать «Остановить» — история сохранится."
              : " will be deleted permanently. Only contracts without a single charge can be deleted; if charges exist, the server will suggest using “Stop” instead — the history is kept."}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button style={s.btn} onClick={() => setDeleteOf(null)}>{ru ? "Отмена" : "Cancel"}</button>
            <button style={{ ...s.btn, borderColor: "var(--c-danger-strong)", color: "var(--c-danger-strong)", fontWeight: 700 }}
                    disabled={busy === deleteOf.id}
                    onClick={async () => { const id = deleteOf.id; if (await act(id, deleteRecurring)) setDeleteOf(null); }}>
              {busy === deleteOf.id ? "…" : (ru ? "Удалить навсегда" : "Delete for good")}
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <ExpenseFormModal
          initial={editing}
          section={editing.section || section || "other"}
          t={t}
          lang={lang}
          vehicles={vehicles}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onReload(); }}
        />
      )}
    </section>
  );
}

function chipStyle(on) {
  return {
    padding: "4px 10px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
    fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", flex: "0 0 auto",
    border: `1px solid ${on ? "var(--c-border-3)" : "var(--c-border)"}`,
    background: on ? "var(--c-brand-bg)" : "var(--c-surface)",
    color: on ? "var(--c-brand-solid)" : "var(--c-muted)",
  };
}

/** Объект договора. Пустой номер — это НЕ «все автомобили»: аренда офиса,
 *  бухгалтерия, налог или страховка сотрудников к машинам не относятся вовсе. */
export function scopeLabel(p, ru) {
  const companyLevel = p.section === "general" || p.section === "salary_tax"
    || (!p.plate_number && !p.trailer_plate && p.section !== "trailer");
  if (p.trailer_plate) return `${ru ? "Прицеп" : "Trailer"} ${p.trailer_plate}`;
  if (p.plate_number) return p.plate_number;
  return companyLevel ? (ru ? "Компания" : "Company") : (ru ? "Все прицепы" : "All trailers");
}

function Row({ p, lang, busy, onDetails, onCharges, onEdit, onPause, onResume, onDelete }) {
  const ru = lang === "RU";
  // PAY-01: удаление договора — право владельца (совпадает с require_owner на бэкенде).
  const isOwner = (typeof window !== "undefined" && window.__FLEETCOST_ROLE__) === "owner";
  const freq = frequency(p.frequency);
  const pct = progressPct(p);
  const tone = (STATUS_LABELS[p.display_status] || STATUS_LABELS.active).tone;
  const toneStyle = {
    ok: { bg: "var(--c-success-bg-3)", fg: "var(--c-emerald-strong)" },
    info: { bg: "var(--c-info-bg)", fg: "var(--c-info-2)" },
    warn: { bg: "var(--c-warn-bg)", fg: "var(--c-warn)" },
    muted: { bg: "var(--c-hover)", fg: "var(--c-muted-2)" },
  }[tone] || { bg: "var(--c-hover)", fg: "var(--c-muted-2)" };
  const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

  const items = [
    p.display_status !== "completed" && (p.display_status === "paused"
      ? { id: "resume", icon: "▶", label: ru ? "Продолжить" : "Resume", onClick: onResume }
      : { id: "pause", icon: "⏸", label: ru ? "Остановить" : "Stop", onClick: onPause }),
    { id: "edit", icon: "✎", label: ru ? "Изменить" : "Edit", onClick: onEdit },
    { id: "charges", icon: "☰", label: ru ? "Начисления и оплата" : "Charges & payments", onClick: onCharges },
    // PAY-01 (аудит stage8): удаление договора — только владелец. Раньше пункт
    // показывался менеджеру, а сервер стирал договор вместе с уже оплаченными
    // списаниями. Теперь сервер (require_owner + 409 при наличии списаний) и
    // интерфейс показывают «Удалить» только owner'у.
    isOwner && "sep",
    isOwner && { id: "delete", icon: "🗑", label: ru ? "Удалить" : "Delete", onClick: onDelete, danger: true },
  ].filter(Boolean);

  return (
    <div className="fc-rec-row">
      <div>
        <button type="button" className="fc-rec-info" onClick={onDetails} disabled={busy}
                title={ru ? "Подробная информация" : "Details"}
                aria-label={ru ? `Подробнее: ${p.description}` : `Details: ${p.description}`}>i</button>
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--c-text)", ...ellipsis }} title={p.description}>
          {p.description}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--c-muted-2)", ...ellipsis }}>
          {[p.category_name || p.code, scopeLabel(p, ru), p.document_ref ? `№ ${p.document_ref}` : null]
            .filter(Boolean).join(" • ")}
        </div>
      </div>

      <div style={{ whiteSpace: "nowrap" }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--c-text)" }}>
          {fmtMoney(p.amount, p.currency, lang)}
        </div>
        <div style={{ fontSize: 11, color: "var(--c-muted-2)" }}>{ru ? freq.perRu : freq.perEn}</div>
      </div>

      <div style={{ whiteSpace: "nowrap" }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--c-text)" }}>
          {fmtDay(p.start_date, lang)} — {p.end_date ? fmtDay(p.end_date, lang) : (ru ? "бессрочно" : "no end")}
        </div>
        <div style={{ fontSize: 11, color: "var(--c-muted-2)" }}>
          {p.frequency === "weekly" ? (ru ? "Каждые 7 дней" : "Every 7 days") : chargeDayLabel(p.day_of_month, lang)}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        {p.total_periods ? (
          <>
            <div style={{ fontSize: 11, color: "var(--c-muted-2)", whiteSpace: "nowrap" }}>
              {ru ? `Оплачено ${p.paid_periods} из ${p.total_periods}` : `${p.paid_periods} of ${p.total_periods} paid`}
            </div>
            <div className="fc-rec-progress"><i style={{ width: `${pct}%` }} /></div>
            <div style={{ marginTop: 3, fontSize: 10.5, fontWeight: 700, whiteSpace: "nowrap", ...ellipsis,
                          color: p.remaining_periods ? "var(--c-text)" : "var(--c-emerald-strong)" }}
                 title={`${ru ? "Осталось: " : "Left: "}${remainingLabel(p, lang)}`}>
              {ru ? "Ост: " : "Left: "}{remainingLabel(p, lang)}
            </div>
            {(p.unpaid_periods || 0) > 0 && (
              <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--c-danger-strong)" }}>
                {ru ? `не оплачено: ${p.unpaid_periods}` : `${p.unpaid_periods} unpaid`}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 11.5, color: "var(--c-muted-2)" }}>
            {ru ? "Бессрочный" : "Open-ended"} • {ru ? "оплачено" : "paid"} {p.paid_periods}
          </div>
        )}
      </div>

      <div>
        <Badge bg={toneStyle.bg} fg={toneStyle.fg}>{statusLabel(p.display_status, lang)}</Badge>
      </div>

      <div style={{ textAlign: "right" }}>
        <ActionMenu items={items} disabled={busy} label={ru ? "Действия" : "Actions"} />
      </div>
    </div>
  );
}

/**
 * Меню «…». Рисуется порталом в <body> с position:fixed от координат кнопки:
 * ни overflow родителей, ни строки таблицы его не обрезают, и страница не
 * получает лишнюю прокрутку. Закрывается по клику вне меню, Escape, прокрутке и
 * изменению размера. Если снизу не хватает места — раскрывается вверх.
 */
export function ActionMenu({ items, disabled, label }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);

  const place = () => {
    const b = btn.current?.getBoundingClientRect();
    if (!b) return;
    const w = 188;
    const h = menu.current?.offsetHeight || 190;
    const below = window.innerHeight - b.bottom;
    const top = below < h + 12 && b.top > h + 12 ? b.top - h - 4 : b.bottom + 4;
    setPos({ top, left: Math.max(8, Math.min(window.innerWidth - w - 8, b.right - w)) });
  };

  useEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onDown = (e) => {
      if (menu.current?.contains(e.target) || btn.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => { if (e.key === "Escape") { close(); btn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button type="button" ref={btn} className="fc-rec-more" disabled={disabled}
              aria-haspopup="menu" aria-expanded={open} aria-label={label}
              onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && createPortal(
        <div ref={menu} className="fc-rec-menu" role="menu"
             style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}>
          {items.map((it, i) => it === "sep"
            ? <hr key={`sep${i}`} />
            : (
              <button key={it.id} type="button" role="menuitem" className={it.danger ? "danger" : ""}
                      onClick={() => { setOpen(false); it.onClick(); }}>
                <span aria-hidden="true" style={{ width: 16, textAlign: "center" }}>{it.icon}</span>{it.label}
              </button>
            ))}
        </div>,
        document.body,
      )}
    </>
  );
}


/**
 * Начисления договора: отметить оплату или снять отметку по конкретной дате.
 *
 * Модель работы — «оплачено по умолчанию». Договоры почти всегда оплачиваются,
 * поэтому подтверждать каждую строку было бы лишней работой; вместо этого
 * находят нужную дату и снимают отметку — тогда начисление перестаёт считаться
 * оплаченным и снова попадает в остаток обязательств.
 */
function ChargesModal({ lang, t, contract, onClose, onChanged }) {
  const ru = lang === "RU";
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      setRows((await apiGet(`/recurring-expenses/${contract.id}/charges`)) || []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [contract.id]);

  const toggle = async (row, next) => {
    setBusyId(row.id);
    try {
      const res = await apiFetch(`/expenses/${row.id}/paid`, {
        method: "POST", body: JSON.stringify({ is_paid: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        reportUiError(data?.detail || `HTTP ${res.status}`, t);
        return;
      }
      await load();
      onChanged && onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const unpaid = rows.filter((r) => !r.is_paid && r.kind === "period").length;

  return (
    <Modal onClose={onClose} label={ru ? "Начисления договора" : "Contract charges"} maxWidth={560}>
      <h3 style={{ ...s.cardTitle, margin: "0 0 4px" }}>
        {ru ? `Начисления: ${contract.description}` : `Charges: ${contract.description}`}
      </h3>
      <p style={{ ...s.cardSub, margin: "0 0 12px", fontSize: 11.5 }}>
        {ru
          ? "Начисления считаются оплаченными. Если по какой-то дате оплаты не было — снимите отметку, и она вернётся в остаток."
          : "Charges are marked paid by default. If a date was not paid, uncheck it and it returns to the remaining balance."}
        {unpaid > 0 && (ru ? ` Не оплачено: ${unpaid}.` : ` Unpaid: ${unpaid}.`)}
      </p>

      <div style={{ maxHeight: 340, overflowY: "auto" }}>
        {loading && <div style={{ padding: 12, color: "var(--c-muted-2)" }}>…</div>}
        {!loading && rows.length === 0 && (
          <div style={{ padding: 12, color: "var(--c-muted-2)", fontSize: 12.5 }}>
            {ru ? "Начислений пока нет." : "No charges yet."}
          </div>
        )}
        {!loading && rows.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 4px",
                                   borderBottom: "1px solid var(--c-surface-2)", fontSize: 12.5 }}>
            <span style={{ fontFamily: "var(--font-mono,monospace)", minWidth: 86 }}>
              {fmtDay(r.date)}
            </span>
            <span style={{ minWidth: 110 }}>{fmtMoney(r.amount, r.currency, lang)}</span>
            {r.kind === "down_payment" && (
              <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 6,
                             background: "var(--c-info-bg)", color: "var(--c-info-2)" }}>
                {ru ? "разовый взнос" : "upfront"}
              </span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: r.is_paid ? "var(--c-emerald-strong)" : "var(--c-danger-strong)" }}>
                {r.is_paid ? (ru ? "оплачено" : "paid") : (ru ? "не оплачено" : "unpaid")}
              </span>
              <button type="button" disabled={busyId === r.id}
                      onClick={() => toggle(r, !r.is_paid)}
                      style={{ ...s.btn, padding: "3px 10px", fontSize: 11.5 }}>
                {r.is_paid ? (ru ? "Снять" : "Unmark") : (ru ? "Отметить" : "Mark")}
              </button>
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
        <button style={s.btn} onClick={onClose}>{t?.close || (ru ? "Закрыть" : "Close")}</button>
      </div>
    </Modal>
  );
}


/**
 * «Подробнее»: все данные договора в одном окне — сгруппированно.
 *
 * Форма просит много полей (номер документа, комментарий, режим суммы, разовый
 * взнос, полис), а в строке списка им нет места. Без этого окна введённое нигде
 * нельзя посмотреть.
 */
function DetailsModal({ lang, t, p, onClose, onCharges }) {
  const ru = lang === "RU";
  const freq = frequency(p.frequency);
  const pct = progressPct(p);
  const mode = { period: ru ? "за период" : "per period",
                 yearly: ru ? "за год" : "per year",
                 total: ru ? "всего за весь срок" : "total for the term" }[p.amount_mode] || p.amount_mode;
  const money = (v) => fmtMoney(v, p.currency, lang);
  const day = (v) => (v ? fmtDay(String(v).slice(0, 10), lang) : null);
  const tone = (STATUS_LABELS[p.display_status] || STATUS_LABELS.active).tone;
  const toneStyle = {
    ok: { bg: "var(--c-success-bg-3)", fg: "var(--c-emerald-strong)" },
    info: { bg: "var(--c-info-bg)", fg: "var(--c-info-2)" },
    warn: { bg: "var(--c-warn-bg)", fg: "var(--c-warn)" },
    muted: { bg: "var(--c-hover)", fg: "var(--c-muted-2)" },
  }[tone];

  const groups = [
    [ru ? "Объект" : "Object", [
      [ru ? "Категория" : "Category", p.category_name || p.code],
      [ru ? "Объект расхода" : "Applies to", scopeLabel(p, ru)],
      [ru ? "Номер документа" : "Document number", p.document_ref],
      [ru ? "Страна полиса" : "Policy country", p.country],
      [ru ? "Номер полиса" : "Policy number", p.policy_number],
      [ru ? "Страховая компания" : "Insurer", p.insurer],
      [ru ? "Комментарий" : "Comment", p.comment],
    ]],
    [ru ? "Платёж" : "Payment", [
      [ru ? "Платёж" : "Payment", `${money(p.amount)} ${ru ? freq.perRu : freq.perEn}`],
      [ru ? "Сумма введена как" : "Amount entered as",
        p.input_amount != null ? `${money(p.input_amount)} (${mode})` : null],
      [ru ? "Разовый взнос" : "Upfront payment", Number(p.down_payment) > 0 ? money(p.down_payment) : null],
      [ru ? "День списания" : "Charge day",
        p.frequency === "weekly" ? (ru ? "каждые 7 дней" : "every 7 days") : p.day_of_month],
      [ru ? "Ближайшее списание" : "Next charge", p.next_charge_date ? fmtDay(p.next_charge_date, lang) : null],
    ]],
    [ru ? "Срок и прогресс" : "Term & progress", [
      [ru ? "Срок" : "Term",
        `${fmtDay(p.start_date, lang)} — ${p.end_date ? fmtDay(p.end_date, lang) : (ru ? "бессрочно" : "no end")}`],
      [ru ? "Число платежей" : "Number of payments", p.total_periods],
      [ru ? "Оплачено" : "Paid", p.total_periods ? `${p.paid_periods} / ${p.total_periods}` : p.paid_periods],
      // Не оплачено — сумма в ЕВРО (сервер складывает amount_eur строк):
      // исходные суммы в разных валютах складывать нельзя (дефект аудита stage9.1).
      [ru ? "Не оплачено" : "Unpaid", p.unpaid_periods ? `${p.unpaid_periods} (${fmtMoney(p.unpaid_amount, "EUR", lang)})` : null],
      [ru ? "Пропущено" : "Skipped", p.skipped_periods || null],
      [ru ? "Осталось" : "Remaining", p.total_periods ? remainingLabel(p, lang) : null],
      [ru ? "Остаток обязательств" : "Remaining obligation",
        p.remaining_total_obligation != null && p.total_periods ? money(p.remaining_total_obligation) : null],
    ]],
    [ru ? "Служебное" : "Service", [
      [ru ? "Остановлен" : "Paused at", day(p.paused_at)],
      [ru ? "Создан" : "Created", day(p.created_at)],
    ]],
  ].map(([title, rows]) => [title, rows.filter(([, v]) => v !== null && v !== undefined && v !== "")])
    .filter(([, rows]) => rows.length > 0);

  return (
    <Modal onClose={onClose} label={ru ? "Данные договора" : "Contract details"} maxWidth={560}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <span className="fc-rec-info" style={{ width: 36, height: 36, fontSize: 18, cursor: "default" }} aria-hidden="true">i</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{ ...s.cardTitle, margin: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{p.description}</h3>
          <div style={{ fontSize: 12, color: "var(--c-muted-2)" }}>
            {ru ? "Детали регулярного обязательства" : "Recurring obligation details"}
          </div>
        </div>
        <Badge bg={toneStyle.bg} fg={toneStyle.fg}>{statusLabel(p.display_status, lang)}</Badge>
      </div>

      {pct !== null && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--c-muted)" }}>
            <span>{ru ? `Оплачено ${p.paid_periods} из ${p.total_periods}` : `${p.paid_periods} of ${p.total_periods} paid`}</span>
            <b>{pct}%</b>
          </div>
          <div className="fc-rec-progress" style={{ height: 7 }}><i style={{ width: `${pct}%` }} /></div>
        </div>
      )}

      <div style={{ maxHeight: 400, overflowY: "auto", paddingRight: 2 }}>
        {groups.map(([title, rows]) => (
          <div key={title} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                          color: "var(--c-text-4)", marginBottom: 2 }}>{title}</div>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "6px 2px",
                                    borderBottom: "1px solid var(--c-surface-2)", fontSize: 12.5 }}>
                <span style={{ color: "var(--c-muted-2)", flex: "0 0 42%" }}>{k}</span>
                <span style={{ fontWeight: 600, textAlign: "right", wordBreak: "break-word", minWidth: 0 }}>{String(v)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button style={s.btn} onClick={onCharges}>{ru ? "Начисления" : "Charges"}</button>
        <button style={s.btn} onClick={onClose}>{t?.close || (ru ? "Закрыть" : "Close")}</button>
      </div>
    </Modal>
  );
}
