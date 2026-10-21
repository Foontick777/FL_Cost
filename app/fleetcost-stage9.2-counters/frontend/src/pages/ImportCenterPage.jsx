import { apiFetch, apiGet } from "../lib/api.js";
import { s, pill } from "../ui/styles.js";
import { Card } from "../ui/components.jsx";
import { MONO, fmtDate, fmtInstant, fmtInstantShort } from "../lib/format.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { fxAutoSummary , fxAutoAction } from "../lib/fxAction.js";
import { freshnessColor, freshnessLabel } from "../lib/importFreshness.js";

/** Источники данных для карточек: код в квадратике, название, что именно грузится.
 *
 *  Статус и действие живут в ОДНОЙ карточке. Раньше это были два блока —
 *  «Последняя синхронизация по сервисам» и отдельный набор карточек с кнопками, —
 *  и про один источник информация лежала в двух местах: приходилось глазами
 *  сопоставлять «Q8» в одном списке с «Q8 Truck» в другом.
 *
 *  Кнопки «Запустить всё» здесь нет и быть не может: автоматически приходит только
 *  E100 (по расписанию), остальные три — загрузка файла, который выбирает человек.
 *  Пометка рядом с названием говорит, какой это случай.
 */
const SOURCES=[
  {key:"e100",busyKey:"e100",code:"E100",title:"E100 Card",auto:true,
   bg:"var(--c-info-bg)",fg:"var(--c-info-2)",
   // Что реально даёт источник — по нему и подписываем карточку.
   subtitle:"Платные дороги и топливо"},
  {key:"q8",busyKey:"q8",code:"Q8",title:"Q8 Truck",auto:false,
   bg:"var(--c-warn-bg)",fg:"var(--c-warn-strong)",
   // В файле Q8 только оплата топлива: тип заправки (дизель/бензин/AdBlue) берётся
   // из колонки с товаром, платных дорог там нет — их забирает E100.
   subtitle:"Оплата топлива по картам Q8: дизель, бензин, AdBlue"},
  {key:"fakturownia",busyKey:"income",code:"FAK",title:"Fakturownia",auto:false,
   bg:"var(--c-success-bg-2)",fg:"var(--c-success-dark)",
   subtitle:"Доходы из CSV, дедупликация по номеру счёта"},
  {key:"navby_mileage",busyKey:"mileage",code:"NAV",title:"nav.by",auto:false,
   bg:"var(--c-violet-bg)",fg:"var(--c-violet-700)",
   subtitle:"Пробег и сегменты движения/стоянок из XLSX"},
];

/* Пороги «свежести» (час / сутки) и их цвета живут в lib/importFreshness.js:
   так правило одно на всех, и его можно проверить без ожидания времени. */

/** Страница «Импорт данных».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function ImportCenterPage({t,lang,embedded}){
  const [history,setHistory]=useState([]);
  const [loading,setLoading]=useState(false);
  const [flash,setFlash]=useState("");
  const [busy,setBusy]=useState("");
  const [syncStatus,setSyncStatus]=useState({locked:false,locked_by_email:null});
  const myRole=(typeof window!=="undefined"&&window.__FLEETCOST_ROLE__)||"viewer";
  const isOwnerOrManager=myRole==="owner"||myRole==="manager";
  const fileRefs={q8:useRef(),income:useRef(),mileage:useRef()};
  const msg=(m)=>{setFlash(m);setTimeout(()=>setFlash(""),5000);};

  const loadHistory=useCallback(async()=>{
    setLoading(true);
    const r=await apiGet("/imports/history?limit=50");
    if(r) setHistory(r);
    setLoading(false);
  },[]);
  const loadSyncStatus=useCallback(async()=>{
    try {
      const r=await apiGet("/sync/status");
      if(r) setSyncStatus(r);
    } catch(e) {}
  },[]);
  // Issue #3: load "last sync per source" — gives the user an at-a-glance
  // view of which services have fresh data and which haven't been synced
  // in a while.
  const [lastSyncs,setLastSyncs]=useState([]);
  const loadLastSyncs=useCallback(async()=>{
    try {
      const r=await apiGet("/imports/last-sync");
      if(r&&Array.isArray(r.sources)) setLastSyncs(r.sources);
    } catch(e) {}
  },[]);
  useEffect(()=>{loadHistory();loadSyncStatus();loadLastSyncs();},[loadHistory,loadSyncStatus,loadLastSyncs]);
  // Poll sync status every 5s when locked
  useEffect(()=>{
    if(!syncStatus.locked) return;
    const iv=setInterval(loadSyncStatus,5000);
    return ()=>clearInterval(iv);
  },[syncStatus.locked,loadSyncStatus]);

  const triggerE100Sync=async()=>{
    setBusy("e100");
    try{
      const r=await apiFetch("/sync",{method:"POST"});
      const d=await r.json();
      if(!r.ok){msg(`❌ ${d.detail||"Ошибка"}`);return;}
      msg(`✅ E100 синхронизация: ${d.new_transactions||0} новых транзакций`+(fxAutoSummary(d.auto)?` · ${fxAutoSummary(d.auto)}`:"")+(fxAutoAction(d.auto)?` · ${fxAutoAction(d.auto)}`:""));
      loadHistory();
    }finally{setBusy("");loadSyncStatus();loadLastSyncs();}
  };

  const uploadQ8=async(e)=>{
    const file=e.target.files[0];if(!file) return;
    setBusy("q8");
    const fd=new FormData();fd.append("file",file);
    const r=await apiFetch("/import/q8-csv",{method:"POST",body:fd});
    const d=await r.json();
    setBusy("");
    if(!r.ok){msg(`❌ ${d.detail||"Ошибка импорта Q8"}`);return;}
    msg("✅ Q8 импорт: "+d.imported+" новых, "+d.skipped+" пропущено, "+d.total_rows+" строк"+(d.duration_ms?" ("+d.duration_ms+"ms)":"")+(fxAutoSummary(d.auto)?" · "+fxAutoSummary(d.auto):"")+(fxAutoAction(d.auto)?" · "+fxAutoAction(d.auto):""));
    loadHistory();loadLastSyncs();
    fileRefs.q8.current.value="";
  };
  const uploadIncome=async(e)=>{
    const file=e.target.files[0];if(!file) return;
    setBusy("income");
    const fd=new FormData();fd.append("file",file);
    const r=await apiFetch("/import/income-csv",{method:"POST",body:fd});
    const d=await r.json();
    setBusy("");
    if(!r.ok){msg(`❌ ${d.detail||"Ошибка импорта доходов"}`);return;}
    msg("✅ Fakturownia: "+d.imported+" новых, "+d.updated+" обновлено, "+d.skipped+" пропущено, "+d.purged+" очищено"+(d.duration_ms?" ("+d.duration_ms+"ms)":"")+(fxAutoSummary(d.auto)?" · "+fxAutoSummary(d.auto):"")+(fxAutoAction(d.auto)?" · "+fxAutoAction(d.auto):""));
    loadHistory();loadLastSyncs();
    fileRefs.income.current.value="";
  };
  const uploadMileage=async(e)=>{
    const file=e.target.files[0];if(!file) return;
    setBusy("mileage");
    const fd=new FormData();fd.append("file",file);
    const r=await apiFetch("/import/mileage-xlsx",{method:"POST",body:fd});
    const d=await r.json();
    setBusy("");
    if(!r.ok){msg(`❌ ${d.detail||"Ошибка импорта пробега"}`);return;}
    msg("✅ nav.by: "+d.imported+" дней + "+d.segments_imported+" сегментов"+(d.duration_ms?" ("+d.duration_ms+"ms)":""));
    loadHistory();loadLastSyncs();
    fileRefs.mileage.current.value="";
  };

  // Действие карточки: у E100 — запуск синхронизации, у остальных — выбор файла.
  const ACTIONS={
    e100:{label:"Синхр.",icon:"🔄",busyText:"⏳ Идёт…",run:triggerE100Sync,
          disabled:!!busy||syncStatus.locked},
    q8:{label:"CSV",icon:"📂",busyText:"⏳ Импорт…",accept:".csv",
        run:()=>fileRefs.q8.current.click(),disabled:!!busy},
    fakturownia:{label:"CSV",icon:"📂",busyText:"⏳ Импорт…",accept:".csv",
        run:()=>fileRefs.income.current.click(),disabled:!!busy},
    navby_mileage:{label:"XLSX",icon:"📊",busyText:"⏳ Импорт…",accept:".xlsx,.xlsm",
        run:()=>fileRefs.mileage.current.click(),disabled:!!busy},
  };
  const lastBySource={};
  lastSyncs.forEach(ls=>{ if(ls&&ls.source) lastBySource[ls.source]=ls.last_import||null; });

  const sourceLabel=(s)=>{
    const map={e100:"E100",q8:"Q8",fakturownia:"Fakturownia",navby_mileage:"nav.by"};
    return map[s]||s;
  };
  // Цвета источников: пара «фон + текст + рамка», чтобы чип выглядел одинаково
  // во всех таблицах (раньше был только фон, и текст на нём не читался).
  const sourcePill=(src)=>{
    const map={
      e100:{bg:"var(--c-info-bg)",fg:"var(--c-info-2)",bd:"var(--c-info-border)"},
      q8:{bg:"var(--c-warn-bg-2)",fg:"var(--c-warn)",bd:"var(--c-warn-border)"},
      fakturownia:{bg:"var(--c-success-bg-3)",fg:"var(--c-emerald-strong)",bd:"var(--c-success-border)"},
      navby_mileage:{bg:"var(--c-violet-bg)",fg:"var(--c-violet-700)",bd:"var(--c-violet-border)"},
    };
    return map[src]||{bg:"var(--c-surface-2)",fg:"var(--c-muted)",bd:"var(--c-border)"};
  };
  const statusBadge=(status)=>{
    // Статус — пилюлей: цветной текст в плотной таблице не считывается, а
    // фон с рамкой видно сразу, в том числе при дальтонизме (есть ещё значок).
    if(status==="success") return <span style={pill("var(--c-success-bg-3)","var(--c-emerald-strong)","var(--c-success-border)")}>✓ SUCCESS</span>;
    if(status==="partial") return <span style={pill("var(--c-warn-bg-2)","var(--c-warn)","var(--c-warn-border)")}>⚠ PARTIAL</span>;
    return <span style={pill("var(--c-danger-bg)","var(--c-danger-strong)","var(--c-danger-border)")}>✗ FAILED</span>;
  };
  const fmtDuration=(ms)=>{
    if(!ms) return "—";
    if(ms<1000) return `${ms}ms`;
    return `${(ms/1000).toFixed(1)}s`;
  };

  // Компактные кнопки карточек: в макете действие стоит в строке с названием, а не
  // отдельной широкой кнопкой под текстом, — карточка становится ниже в два раза.
  const btnSm=(primary)=>({
    padding:"5px 10px",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,
    whiteSpace:"nowrap",flexShrink:0,
    // display:flex + gap — ради индикатора загрузки: он должен стоять в строке с
    // подписью, а не переносить её на вторую строку и растить карточку.
    display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6,
    border:primary?"none":"1px solid var(--c-border-3)",
    background:primary?"var(--c-brand-solid)":"var(--c-surface-2)",
    color:primary?"var(--c-on-brand)":"var(--c-text)",
  });

  return(
    <div style={s.page}>
      {/* Заголовок печатаем только для отдельного пункта меню: внутри вкладок
          администрирования заголовок раздела рисует AdminPage, иначе он дублируется. */}
      {!embedded&&<h1 style={s.pageTitle}>📥 Импорт данных</h1>}
      <p style={{fontSize:13,color:"var(--c-muted-2)",margin:"0 0 16px"}}>
        Источники данных и интеграции. Импорты доступны также на соответствующих вкладках (Доходы, Топливо, Пробег).
      </p>
      {flash&&<div style={s.flash}>{flash}</div>}

      {/* Sync status banner */}
      {syncStatus.locked&&(
        <div style={{background:"var(--c-warn-bg)",color:"var(--c-warn-strong)",padding:"10px 14px",borderRadius:10,marginBottom:14,fontSize:13,fontWeight:600}}>
          ⏳ Синхронизация E100 уже запущена пользователем {syncStatus.locked_by_email||"..."}. Подождите завершения.
        </div>
      )}

      {/* Источники: статус и действие в одной карточке */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(340px,1fr))",gap:12,marginBottom:24}}>
        {SOURCES.map(src=>{
          const last=lastBySource[src.key]||null;
          const act=ACTIONS[src.key];
          const dot=freshnessColor(last);
          const failed=!!(last&&last.status==="failed");
          // Одна пилюля на карточку: как данные попадают в программу (и не сломалось
          // ли это на последней загрузке). Свежесть несёт точка в подвале.
          const modeText=(src.auto?"авто":"файл")+(failed?" · ошибка":"");
          const modeStyle=src.auto&&!failed
            ? pill("var(--c-success-bg-3)","var(--c-emerald-strong)","var(--c-success-border)")
            : failed
              ? pill("var(--c-danger-bg)","var(--c-danger-strong)","var(--c-danger-border)")
              : pill("var(--c-hover)","var(--c-muted)","var(--c-border-3)");
          return(
            <Card key={src.key} style={{padding:"14px 16px"}}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10}}>
                <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
                  <span style={{width:38,height:38,borderRadius:10,background:src.bg,color:src.fg,
                                display:"flex",alignItems:"center",justifyContent:"center",
                                fontSize:12,fontWeight:700,letterSpacing:0.3,flexShrink:0}}>
                    {src.code}
                  </span>
                  <div style={{minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                      <strong style={{fontSize:13,color:"var(--c-text)"}}>{src.title}</strong>
                      <span style={modeStyle}>{modeText}</span>
                    </div>
                    <div style={{fontSize:11.5,color:"var(--c-muted-2)",marginTop:2,lineHeight:1.35}}>
                      {src.subtitle}
                    </div>
                  </div>
                </div>
                {isOwnerOrManager?(
                  <button style={btnSm(src.auto)} onClick={act.run} disabled={act.disabled}
                          title={src.auto?`Запустить синхронизацию ${src.title}`:`Загрузить файл (${act.accept})`}>
                    {/* Тот же приём, что у кнопки синхронизации в шапке дашборда:
                        во время работы — вращающийся индикатор, а не статичный «⏳».
                        По неподвижному значку не видно, идёт процесс или завис. */}
                    {busy===src.busyKey
                      ? <><span className="fc-spin" aria-hidden="true"/><span>{act.busyText}</span></>
                      : `${act.icon} ${act.label}`}
                  </button>
                ):(
                  <span style={{fontSize:11,color:"var(--c-muted-2)",whiteSpace:"nowrap"}}>только просмотр</span>
                )}
              </div>

              <div style={{marginTop:12,paddingTop:10,borderTop:"1px solid var(--c-border-3)",
                           display:"flex",alignItems:"center",justifyContent:"space-between",
                           gap:8,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,fontSize:11.5,
                             fontFamily:MONO,color:"var(--c-muted-2)",flexWrap:"wrap"}}>
                  <span title={freshnessLabel(last)}
                        style={{width:8,height:8,borderRadius:"50%",background:dot,display:"inline-block",flexShrink:0}}/>
                  {last?(
                    <>
                      <span>Посл: <strong style={{color:"var(--c-muted)"}}>{fmtInstantShort(last.created_at)}</strong></span>
                      {last.file_date_from&&last.file_date_to&&(
                        <span title="Период, который покрывает последняя загрузка">
                          · {fmtDate(last.file_date_from)}→{fmtDate(last.file_date_to)}
                        </span>
                      )}
                    </>
                  ):(
                    <span style={{fontStyle:"italic"}}>Ещё не загружалось</span>
                  )}
                </div>
                {last?(
                  <div style={{display:"flex",gap:8,fontSize:11.5,fontFamily:MONO,flexWrap:"wrap"}}>
                    {last.total_rows>0&&<span style={{color:"var(--c-muted)"}}>{last.total_rows} записей</span>}
                    {last.new_rows>0&&<span style={{color:"var(--c-emerald)"}}>+{last.new_rows}</span>}
                    {last.updated_rows>0&&<span style={{color:"var(--c-info-2)"}}>↻{last.updated_rows}</span>}
                    {last.skipped_rows>0&&<span style={{color:"var(--c-muted-2)"}}>≈{last.skipped_rows}</span>}
                    {last.failed_rows>0&&<span style={{color:"var(--c-danger)"}}>{last.failed_rows} ошиб.</span>}
                  </div>
                ):null}
              </div>
              {/* Ошибку показываем текстом: «красная точка» объясняет, что что-то не
                  так, но не говорит, что именно. */}
              {failed&&last.error_message&&(
                <div style={{fontSize:11,color:"var(--c-danger)",marginTop:6,lineHeight:1.35}}>
                  {last.error_message.slice(0,90)}{last.error_message.length>90?"…":""}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* Скрытые поля файлов, на которые нажимают кнопки карточек.
          Элементы были потеряны при переработке карточек, а обработчики остались:
          fileRefs.q8.current === undefined, click() падал, диалог не открывался. */}
      <input ref={fileRefs.q8}      type="file" accept=".csv"         style={{display:"none"}} onChange={uploadQ8}/>
      <input ref={fileRefs.income}  type="file" accept=".csv"         style={{display:"none"}} onChange={uploadIncome}/>
      <input ref={fileRefs.mileage} type="file" accept=".xlsx,.xlsm"  style={{display:"none"}} onChange={uploadMileage}/>

      {/* Import history */}
      <Card>
        <h3 style={s.cardTitle}>История импортов ({history.length})</h3>
        <p style={s.cardSub}>Каждая загрузка: сколько строк получено, добавлено, обновлено и на чём упало.</p>
        {loading?"Загрузка...":history.length===0?(
          <div style={s.empty}>История пуста — импортируйте что-нибудь сверху</div>
        ):(
          <div style={{overflowX:"auto",width:"100%",maxWidth:"100%"}}>
            {/* Таблица из 12 колонок с датами вида «10.10.2025 → 23.09.2026»
                раньше вылезала за карточку и за край экрана. Теперь карточка
                всегда по ширине страницы, а таблица прокручивается
                горизонтально ВНУТРИ неё (и не сжимается до нечитаемого
                состояния благодаря minWidth). */}
            <table style={{width:"100%",minWidth:1240,borderCollapse:"collapse"}}>
            <thead>
              <tr style={s.theadBand}>
                <th style={s.th}>Дата</th>
                <th style={s.th}>Источник</th>
                <th style={s.th}>Файл</th>
                <th style={s.th}>Пользователь</th>
                <th style={s.th}>Строк</th>
                <th style={s.th}>Нов.</th>
                <th style={s.th}>Обн.</th>
                <th style={s.th}>Проп.</th>
                <th style={s.th}>Ошиб.</th>
                <th style={s.th} title="Время в вашем часовом поясе">Время</th>
                <th style={s.th}>Статус</th>
                <th style={s.th}>Дата в файле</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h=>(
                <tr key={h.id} className="fc-row-hover" style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                  <td style={s.td}><span style={{fontFamily:MONO,fontSize:12,whiteSpace:"nowrap"}}>{fmtInstant(h.created_at)}</span></td>
                  <td style={s.td}>{(()=>{const c=sourcePill(h.source);return <span style={pill(c.bg,c.fg,c.bd)}>{sourceLabel(h.source)}</span>;})()}</td>
                  <td style={s.td}><span style={{fontSize:12,fontFamily:MONO,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"inline-block"}}>{h.filename||"—"}</span></td>
                  <td style={s.td}><span style={{fontSize:12}}>{h.user_email||"system"}</span></td>
                  <td style={s.td}><span style={{fontFamily:MONO,fontSize:12}}>{h.total_rows}</span></td>
                  <td style={s.td}><span style={{fontFamily:MONO,fontSize:12,color:"var(--c-emerald)"}}>+{h.new_rows}</span></td>
                  <td style={s.td}><span style={{fontFamily:MONO,fontSize:12,color:"var(--c-info-2)"}}>↻{h.updated_rows}</span></td>
                  <td style={s.td}><span style={{fontFamily:MONO,fontSize:12,color:"var(--c-muted-2)"}}>{h.skipped_rows}</span></td>
                  <td style={s.td}><span style={{fontFamily:MONO,fontSize:12,color:h.failed_rows>0?"var(--c-danger)":"var(--c-muted-2)"}}>{h.failed_rows}</span></td>
                  <td style={s.td}><span style={{fontFamily:MONO,fontSize:12}}>{fmtDuration(h.duration_ms)}</span></td>
                  <td style={s.td}>{statusBadge(h.status)}</td>
                  <td style={s.td}>
                    <span style={{fontSize:12,color:"var(--c-muted-2)",fontFamily:MONO,whiteSpace:"nowrap"}}>{h.file_date_from&&h.file_date_to?`${fmtDate(h.file_date_from)} → ${fmtDate(h.file_date_to)}`:"—"}</span>
                    {/* Доходы Fakturownia группируются по «Data sprzedaży», а не по
                        дате выставления: в файле за август может оказаться
                        операция с июльской датой продажи, и диапазон без подписи
                        выглядит как ошибка импорта. */}
                    {h.source==="fakturownia"&&h.file_date_from&&(
                      <span style={{display:"block",fontSize:10.5,color:"var(--c-muted-2)",marginTop:2}}>
                        {lang==="RU"?"по дате продажи":"by sale date"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>
    </div>
  );
}
