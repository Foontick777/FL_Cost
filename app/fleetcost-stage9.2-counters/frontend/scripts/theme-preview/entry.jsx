/**
 * Страница превью темы: настоящие компоненты и токены, обе темы рядом.
 *
 * Нужна не для красоты, а чтобы ИЗМЕРИТЬ вид: `audit.js` открывает её в headless
 * браузере и ищет светлые фоны и невидимый текст. Специально включены элементы,
 * у которых цвет текста НЕ задан (данные в таблице, подписи, оглавление меню):
 * именно они в тёмной теме берут браузерный чёрный и сливаются с фоном.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { s, pill } from "../../src/ui/styles.js";
import { Card, CurrencyBadge, Segmented, UnratedNote } from "../../src/ui/components.jsx";
import { Sidebar } from "../../src/ui/Sidebar.jsx";
import { VehicleDetail } from "../../src/pages/DashboardPage.jsx";

const T = globalThis.__FC_T__;

// Данные для раскрытой строки «Финансы по авто». Значения вымышленные, но
// структура — та же, что приходит из txBatch: здесь важно измерить ЦВЕТА
// (фон панели, подписи категорий, числа без явного цвета), а не суммы.
const V_ROW={plate:"BI886LL",driver:"Vit",income:16370.92,expense:5119.65,profit:11251.27,
             km:7235.1,ratio:6.1,eurPerKm:0.71,directExpense:5050.7,prevDirectExpense:5150.44};
const V_BUCKETS=[
  {key:"2026-09-01",label:"01.09"},{key:"2026-09-08",label:"08.09"},
  {key:"2026-09-15",label:"15.09"},{key:"2026-09-22",label:"22.09"},
];
const V_DETAIL={cats:{fuel:2400.5,toll:1300.2,leasing:600,insurance:400,other:350},direct:5050.7,
                trend:{"2026-09-01":1100,"2026-09-08":1500,"2026-09-15":1250,"2026-09-22":1200}};

/** Раскрытая панель авто и переключатель «По странам / По типам»: обе новые
 *  поверхности дашборда. Добавлены сюда потому, что прежний аудит темы их не
 *  видел, а именно в них больше всего текста без заданного цвета — то, что в
 *  тёмной теме один раз уже «пропало». */
function DashboardPieces({ theme }) {
  return (
    <Card>
      <h3 style={s.cardTitle}>Раскрытая строка «Финансы по авто»</h3>
      <div style={{ marginBottom: 12 }}>
        <Segmented ariaLabel="География затрат" value={theme === "dark" ? "type" : "country"}
                   onChange={() => {}}
                   items={[{ id: "country", label: T.byCountry }, { id: "type", label: T.byType }]} />
      </div>
      <div style={{ border: "1px solid var(--c-border-2)", borderRadius: 12, overflow: "hidden" }}>
        <VehicleDetail row={V_ROW} detail={V_DETAIL} buckets={V_BUCKETS} t={T} lang="RU" redistShare={118.4} />
      </div>
      {/* Строка авто в свёрнутом виде: подпись, числа и бейдж доли AdBlue. */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto auto", gap: 10,
                    alignItems: "center", padding: "9px 10px", marginTop: 10,
                    borderBottom: "1px solid var(--c-surface-2)" }}>
        <span style={{ minWidth: 0 }}>
          <strong style={{ display: "block", fontSize: 12 }}>▸ BI886LL</strong>
          <small style={{ display: "block", fontSize: 11, fontWeight: 400, color: "var(--c-muted-2)" }}>Vit</small>
        </span>
        <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 12 }}>7 235,1</span>
        <span style={{ textAlign: "center" }}>
          <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700,
                         background: "var(--c-success-bg-3)", color: "var(--c-emerald-strong)" }}>6,1%</span>
        </span>
        <strong style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 12,
                         color: "var(--c-emerald-strong)" }}>+11 251,27</strong>
      </div>
    </Card>
  );
}


function Grid() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <Card>
        <h3 style={s.cardTitle}>⚡ Действия</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={s.btnPrimary}>Сегодняшний курс</button>
          <button style={s.btn}>Скачать историю</button>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 14, flexWrap: "wrap" }}>
          <span style={pill("var(--c-info-bg)", "var(--c-info)", "var(--c-info-border)")}>ECB</span>
          <span style={pill("var(--c-warn-bg)", "var(--c-warn)", "var(--c-warn-border)")}>manual</span>
          <span style={pill("var(--c-success-bg)", "var(--c-success)", "var(--c-success-border)")}>✓ SUCCESS</span>
          <span style={pill("var(--c-danger-bg)", "var(--c-danger)", "var(--c-danger-border)")}>✗ FAILED</span>
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={s.label}>Курс BYN для всех дат</label>
          <input style={{ ...s.input, width: 130 }} defaultValue="0,29" />
        </div>
        {/* Поле БЕЗ токена: проверяем, что базовое правило CSS его тоже покрывает. */}
        <div style={{ marginTop: 10 }}>
          <label style={s.label}>Поле без токена стиля</label>
          <input type="number" defaultValue="1234.56" />
        </div>
      </Card>

      <Card>
        <h3 style={s.cardTitle}>Последние курсы</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={s.theadBand}>
              <th style={s.th}>Валюта</th><th style={s.th}>Курс к EUR</th><th style={s.th}>Источник</th>
            </tr>
          </thead>
          <tbody>
            {/* Строки данных СОЗНАТЕЛЬНО без color: так выглядят числовые данные
                в приложении, и именно они «исчезали» в тёмной теме. */}
            <tr style={{ borderBottom: "1px solid var(--c-surface-2)" }}>
              <td style={s.td}>AUD</td><td style={s.td}>0.619348</td><td style={s.td}>ECB</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--c-surface-2)" }}>
              <td style={s.td}>BYN</td><td style={s.td}>0.290000</td><td style={s.td}>manual</td>
            </tr>
            <tr>
              <td style={s.td}>EUR</td><td style={s.td}>1.000000</td><td style={s.td}>ECB</td>
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: 12 }}>
          <label style={s.label}>Валюта</label>
          <select style={s.select} defaultValue="PLN">
            <option value="PLN">PLN</option>
            <option value="EUR">EUR</option>
          </select>
        </div>
      </Card>
    </div>
  );
}

function Sample({ theme }) {
  return (
    <div style={{ display: "flex", minHeight: "100%", background: "var(--c-app)" }}>
      <Sidebar page="dashboard" setPage={() => {}} t={T} lang="RU" setLang={() => {}}
               onLogout={() => {}} mobileOpen={false}
               themeMode={theme} setThemeMode={() => {}}
               user={{ full_name: "Admin Fleet", email: "admin@fleetcost.eu" }} />
      <div style={{ ...s.page, flex: 1, paddingTop: 20 }}>
        <h1 style={s.pageTitle}>Курсы валют</h1>
        <p style={s.cardSub}>Живые курсы, ручная правка и история изменений — от них зависит пересчёт в евро.</p>

        <Grid />

        <div style={{ marginTop: 16 }}>
          <DashboardPieces theme={theme} />
        </div>

        <div style={{ ...s.warnNote, marginTop: 16 }} role="status">
          <span style={{ flex: 1 }}>
            Без курса: BYN (2026-06-08 — 2026-06-11). Курсы загружаются только из архива ЕЦБ.
          </span>
        </div>

        <Card>
          <UnratedNote byCur={{ EUR: 100, BYN: 50 }} lang="RU" />
          <div style={{ fontSize: 12, color: "var(--c-muted-2)", marginTop: 10 }}>
            Обычный текст, <b style={{ color: "var(--c-text)" }}>выделенный</b>,{" "}
            <a href="#" style={{ color: "var(--c-brand)" }}>ссылка</a>,{" "}
            <span style={{ color: "var(--c-danger)" }}>ошибка</span>.
          </div>
          {/* Текст вовсе без цвета: в тёмной теме это и есть «чёрное на тёмном». */}
          <div style={{ fontSize: 13, marginTop: 8 }}>
            Подпись без заданного цвета — так выглядит часть надписей и данных.
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>1 234 567,89 EUR</div>
          <CurrencyBadge byCur={{ EUR: 100, BYN: 50, PLN: 30 }} lang="RU" />
          <pre style={{ margin: "12px 0 0", background: "var(--c-code-bg)", color: "var(--c-code-fg)",
                        padding: 12, borderRadius: 10, fontSize: 12 }}>
{`{ "currency": "BYN", "rate_to_eur": 0.29 }`}
          </pre>
        </Card>
      </div>
    </div>
  );
}

// Рендерим ОДНУ и ту же разметку: тему задаёт страница (переменные на :root),
// как в приложении. Поэтому измерение совпадает с реальным поведением.
console.log(JSON.stringify({
  markup: renderToStaticMarkup(<Sample theme={process.env.FC_THEME === "dark" ? "dark" : "light"} />),
}));
