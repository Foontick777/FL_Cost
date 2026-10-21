import { useState } from "react";
import { chargeDayLabel, fmtDay, fmtMoney, frequency, periodWord, progressPct, remainingLabel } from "../lib/recurring.js";

/**
 * Карточки автомобилей / прицепов с переключателем «Разовые / Регулярные».
 *
 * Ревизия 2 (по вёрстке пользователя, stage9.2):
 *   • все карточки ОДНОГО размера (фиксированная высота), список внутри
 *     прокрывается вертикальным скроллом — карточка не растёт и ничего
 *     не сдвигает, сколько бы платежей ни было за период;
 *   • на вкладках — КАУНТЕРЫ (число транзакций периода), а не суммы:
 *     «Разовые (3)» / «Регулярные (12)». Суммы на кнопках разъезжались бы
 *     при больших числах; точные суммы — в списке и в подвале карточки
 *     (в титуле кнопки тоже);
 *   • строка регулярного платежа структурирована: название + платёж
 *     в месяц В ВАЛЮТЕ ПЛАТЕЖА справа; ниже срок действия и день списания;
 *     ниже блок «Оплачено N из M» / «Осталось: K мес. · сумма (на текущую
 *     дату)» с мини-прогрессом; ниже «Списано за период» в EUR;
 *   • внизу карточки закреплён итог «за период» + разбивка слева/справа:
 *     сколько за разовые и сколько за регулярные (EUR).
 *
 * Данные собирает `buildAssetCards` (lib/assetCards.js).
 */
const eur = (v, ru) => `${Number(v || 0).toLocaleString(ru ? "ru-RU" : "en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;

/** Компактный остаток для месячных договоров: «11 мес. · 165,00 EUR» (как на вёрстке). */
function remainingShort(p, freq, ru, lang) {
  if (freq.id !== "monthly") return remainingLabel(p, lang);
  const rp = p.remaining_periods;
  if (rp === null || rp === undefined) return ru ? "Бессрочно" : "No end date";
  if (rp <= 0) return ru ? "Выполнено" : "Completed";
  const amount = Number(p.remaining_amount || 0).toLocaleString(ru ? "ru-RU" : "en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${rp} ${ru ? "мес." : "mo"} · ${amount} ${p.currency}`;
}

/** Родительный падеж для «из N …»: «1 из 3 месяцев», «1 из 2 лет» (а не «из 3 месяца»). */
function genWord(freqId, n, ru) {
  if (!ru) return ""; // в EN после of идёт periodWord без склонения
  const forms = {
    monthly: ["месяца", "мес."],
    quarterly: ["квартала", "кварталов"],
    yearly: ["года", "лет"],
    weekly: ["недели", "недель"],
  };
  const [one, many] = forms[freqId] || forms.monthly;
  return (n % 10 === 1 && n % 100 !== 11) ? one : many;
}

export function AssetCards({ cards, lang, title, subtitle, emptyText, subtitleOf, totalLabel }) {
  const ru = lang === "RU";
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--c-text)" }}>{title}</h2>
        {subtitle && <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--c-muted-2)" }}>{subtitle}</p>}
      </div>
      {cards.length === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--c-muted-2)", fontSize: 13,
                      background: "var(--c-surface)", border: "1px dashed var(--c-border)", borderRadius: 14 }}>
          {emptyText}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {cards.map((c) => (
            <AssetCard key={c.plate} card={c} ru={ru} lang={lang}
                       subtitle={subtitleOf ? subtitleOf(c.plate) : null}
                       totalLabel={totalLabel || (ru ? "Итого за период:" : "Total for the period:")} />
          ))}
        </div>
      )}
    </section>
  );
}

function AssetCard({ card, ru, lang, subtitle, totalLabel }) {
  const [tab, setTab] = useState(card.oneOff.length === 0 && card.regular.length > 0 ? "regular" : "oneoff");
  const tabBtn = (id, label, count, titleTxt) => {
    const on = tab === id;
    return (
      <button type="button" aria-pressed={on} onClick={() => setTab(id)} title={titleTxt}
              style={{ padding: "3px 9px", borderRadius: 7, border: "none", cursor: "pointer",
                       fontFamily: "inherit", fontSize: 11.5, fontWeight: on ? 700 : 500, whiteSpace: "nowrap",
                       background: on ? "var(--c-surface)" : "transparent",
                       color: on ? "var(--c-brand-solid)" : "var(--c-muted)",
                       boxShadow: on ? "0 1px 2px rgba(15,23,42,0.12)" : "none" }}>
        {label} ({count})
      </button>
    );
  };
  const empty = (txt) => (
    <div style={{ padding: "18px 6px", textAlign: "center", fontSize: 12, color: "var(--c-muted-2)" }}>{txt}</div>
  );

  return (
    <div style={{ background: "var(--c-surface)", border: "1px solid var(--c-border)", borderRadius: 16,
                  padding: 18, height: 356, display: "flex", flexDirection: "column",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                    paddingBottom: 12, borderBottom: "1px solid var(--c-surface-2)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: "var(--c-text)", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.plate}</div>
          {subtitle && <div style={{ fontSize: 12, color: "var(--c-muted-2)", overflow: "hidden",
                                     textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</div>}
        </div>
        <div role="group" aria-label={ru ? "Вид расходов" : "Expense kind"}
             style={{ display: "flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--c-surface-2)", flex: "0 0 auto" }}>
          {tabBtn("oneoff", ru ? "Разовые" : "One-off", card.oneOffCount,
            `${ru ? "Операций за период" : "Transactions in period"}: ${card.oneOffCount} · ${eur(card.oneOffEur, ru)}`)}
          {tabBtn("regular", ru ? "Регулярные" : "Recurring", card.regularCount,
            `${ru ? "Списаний за период" : "Charges in period"}: ${card.regularCount} · ${eur(card.regularEur, ru)}` +
            (card.regular.length ? (ru ? ` · договоров: ${card.regular.length}` : ` · contracts: ${card.regular.length}`) : ""))}
        </div>
      </div>

      <div className="custom-scrollbar" style={{ flex: "1 1 auto", minHeight: 0, maxHeight: 190, overflowY: "auto",
                                                margin: "12px 0", paddingRight: 2, display: "flex",
                                                flexDirection: "column", gap: 8 }}>
        {tab === "oneoff" && (card.oneOff.length === 0
          ? empty(ru ? "Разовых расходов за период нет" : "No one-off expenses in this period")
          : card.oneOff.map((r) => (
            <div key={r.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                                      background: "var(--c-hover)", border: "1px solid var(--c-surface-2)",
                                      borderRadius: 11, padding: "8px 10px", flex: "0 0 auto" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, fontSize: 12.5,
                             fontWeight: 600, color: "var(--c-text-2, var(--c-text))" }}
                    title={r.count > 1 ? (ru ? `${r.count} операц. — ${eur(r.eur, ru)}` : `${r.count} txn(s) — ${eur(r.eur, ru)}`) : undefined}>
                <span aria-hidden="true">{r.icon || "🏷️"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                {r.count > 1 && <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--c-muted-2)",
                                               flex: "0 0 auto" }}>×{r.count}</span>}
              </span>
              <span style={{ fontWeight: 800, fontSize: 13, whiteSpace: "nowrap", color: "var(--c-text)" }}>
                {eur(r.eur, ru)}
              </span>
            </div>
          )))}

        {tab === "regular" && (card.regular.length === 0
          ? empty(ru ? "Действующих регулярных платежей нет" : "No active recurring payments")
          : card.regular.map((p) => {
            const freq = frequency(p.frequency);
            const hasTerm = Number(p.total_periods) > 0;
            const pct = progressPct(p);
            return (
              <div key={p.id} style={{ padding: "10px 11px", borderRadius: 12, flex: "0 0 auto",
                                       background: "var(--c-brand-bg)", border: "1px solid var(--c-border-3)" }}>
                {/* Название — слева, платёж в месяц (в валюте платежа) — справа */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div title={p.description} style={{ fontWeight: 700, fontSize: 12.5, color: "var(--c-text)",
                                                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.description}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--c-muted)", marginTop: 2 }}>
                      {p.end_date
                        ? `${ru ? "До" : "Until"} ${fmtDay(p.end_date, lang)}`
                        : (ru ? "Бессрочно" : "No end date")}
                      {p.display_status === "paused" ? ` · ${ru ? "на паузе" : "paused"}` : ""}
                      {" • "}
                      {p.frequency === "weekly" ? (ru ? "каждые 7 дней" : "every 7 days") : chargeDayLabel(p.day_of_month, lang)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flex: "0 0 auto" }}>
                    <div style={{ fontWeight: 700, fontSize: 12.5, color: "var(--c-text)", whiteSpace: "nowrap" }}>
                      {fmtMoney(p.amount, p.currency, lang)}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--c-muted-2)" }}>{ru ? freq.perRu : freq.perEn}</div>
                  </div>
                </div>

                {/* Оплачено / Осталось (на текущую дату) + мини-прогресс */}
                {hasTerm ? (
                  <div style={{ background: "var(--c-surface)", border: "1px solid var(--c-border-3)", borderRadius: 9,
                                padding: "6px 9px", marginTop: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", rowGap: 2,
                                  columnGap: 8, fontSize: 11, color: "var(--c-muted)" }}>
                      <span>{ru ? "Оплачено:" : "Paid:"}{" "}
                        <b style={{ color: "var(--c-text)" }}>
                          {Math.min(p.paid_periods || 0, p.total_periods)} {ru ? "из" : "of"}{" "}
                          {ru
                            ? `${p.total_periods} ${genWord(freq.id, p.total_periods, true)}`
                            : periodWord(freq.id, p.total_periods, lang)}
                        </b>
                      </span>
                      <span style={{ whiteSpace: "nowrap" }}>{ru ? "Осталось:" : "Left:"}{" "}
                        <b style={{ color: "var(--c-brand-strong)" }}>{remainingShort(p, freq, ru, lang)}</b>
                      </span>
                    </div>
                    <div style={{ height: 4, background: "var(--c-surface-2)", borderRadius: 999, marginTop: 5, overflow: "hidden" }}
                         role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                      <div style={{ width: `${pct || 0}%`, height: "100%", background: "var(--c-brand)", borderRadius: 999 }} />
                    </div>
                  </div>
                ) : null}

                {/* Списано за выбранный период (EUR) */}
                <div style={{ borderTop: "1px solid var(--c-border-3)", marginTop: 8, paddingTop: 6,
                              display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontSize: 11 }}>
                  <span style={{ color: "var(--c-muted)" }}>{ru ? "Списано за период:" : "Charged in period:"}</span>
                  <span style={{ fontWeight: 700, color: "var(--c-brand)", whiteSpace: "nowrap" }}>{eur(p.periodEur, ru)}</span>
                </div>
              </div>
            );
          }))}
      </div>

      {/* Нижний итог закреплён: не зависит от выбранной вкладки */}
      <div style={{ marginTop: "auto", paddingTop: 12, borderTop: "1px solid var(--c-surface-2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--c-muted)" }}>{totalLabel}</span>
          <span style={{ fontSize: 16, fontWeight: 800, color: "var(--c-brand)", whiteSpace: "nowrap" }}>
            {eur(card.totalEur, ru)}
          </span>
        </div>
        {card.missingEur > 0 && (
          <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--c-muted-2)" }}>
            ⚠ {ru
              ? `${card.missingEur} строк(и) без курса — в EUR-итог не входят`
              : `${card.missingEur} row(s) without FX rate — excluded from the EUR total`}
          </div>
        )}
        {card.totalEur > 0 && (
          <div style={{ marginTop: 5, display: "flex", justifyContent: "space-between", gap: 8,
                        fontSize: 10.5, color: "var(--c-muted-2)" }}>
            <span style={{ whiteSpace: "nowrap" }}>{ru ? "Разовые" : "One-off"}: {eur(card.oneOffEur, ru)}</span>
            <span style={{ whiteSpace: "nowrap" }}>{ru ? "Регулярные" : "Recurring"}: {eur(card.regularEur, ru)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
