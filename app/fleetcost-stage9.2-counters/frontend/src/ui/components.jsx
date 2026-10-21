/**
 * Переиспользуемые компоненты и атомы интерфейса: Card, DeltaBadge (сравнение с
 * прошлым периодом), SkeletonRows, SrcFilter, TxFilterBar, TxTable, PaginatedTxTable,
 * CurrencyBadge, ShrunkSelect, DiffValue/DiffView (история изменений), IncomeKpi,
 * PeriodSel, Badge/SrcBadge.
 *
 * Вынесено из App.jsx. Зависимости: общий объект стилей и константы.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { s, KPI_CORNER_PAD } from "./styles.js";
import { FLAGS, PAGE_SIZE, SEG_PAGE_SIZE, SRC, fieldRu } from "./constants.js";
import { DP_PRESETS, buildMonthGrid, dayCountWord, fmtDMY, getPeriodDates, isoFmt, parseISODate, sameDay } from "../lib/date.js";
import { isAdBlue, isIncome, isSalary, isSvcFee, isToll, txStatus } from "../lib/tx.js";
import { MONO, fmtDate, fmtDateTime, fmtInt, fmtMoney, fmtQty } from "../lib/format.js";
import { apiGet, apiFetch } from "../lib/api.js";
import { curEntries, hasCurrencyBreakdown, unknownCurrencies, missingEurRows, missingEurByCur } from "../lib/money.js";
import { useLocalState } from "../lib/hooks.js";

export function Card({children,style}){return <div style={{background:"var(--c-surface)",borderRadius:20,border:"1px solid var(--c-border-3)",boxShadow:"0 8px 30px rgba(0,0,0,0.02)",padding:20,...style}}>{children}</div>;}

/** Сегментированный переключатель: одна «дорожка», активный сегмент залит
 *  брендовым цветом. `aria-pressed` обязателен — состояние должно читаться не
 *  только по заливке.
 *
 *  Живёт здесь, а не в сайдбаре: раньше это был локальный компонент подвала
 *  меню, и второму месту (переключатель «По странам / По типам» в блоке
 *  «География затрат» на дашборде) пришлось бы заводить копию с риском
 *  разъехаться по форме. */
export function Segmented({items,value,onChange,ariaLabel}){
  return(
    <div role="group" aria-label={ariaLabel}
         style={{display:"flex",alignItems:"center",gap:2,background:"var(--c-surface-2)",
                 borderRadius:"var(--r-sm)",padding:3,flex:"0 0 auto"}}>
      {items.map(it=>{
        const on=value===it.id;
        return(
          <button key={it.id} type="button" aria-pressed={on} title={it.title}
                  onClick={()=>onChange(it.id)}
                  style={{minWidth:30,height:24,display:"flex",alignItems:"center",
                          justifyContent:"center",gap:5,padding:"0 7px",border:"none",
                          borderRadius:"var(--r-xs)",cursor:"pointer",fontFamily:"inherit",
                          fontSize:11,fontWeight:on?700:500,lineHeight:1,
                          background:on?"var(--c-brand-solid)":"transparent",
                          // Неактивный сегмент — --c-muted: прежний --c-muted-2
                          // на «дорожке» --c-surface-2 давал 4.34 при норме 4.5
                          // (замер превью темы). Правка касается и переключателя
                          // языка, и нового «По странам / По типам».
                          color:on?"var(--c-on-brand)":"var(--c-muted)",
                          boxShadow:on?"0 1px 2px rgba(15,23,42,0.18)":"none",
                          transition:"background 0.15s, color 0.15s"}}>
            {it.icon?<span style={{display:"flex",width:14,height:14}}>{it.icon}</span>:null}
            {it.label||null}
          </button>
        );
      })}
    </div>
  );
}

export function DeltaBadge({pct,invert=false,absolute=false,prevValue=null,prevLabel=""}){
  // prevValue mode: show absolute previous value as a neutral badge (no % / arrows)
  if(prevValue!==null){
    const style={
      display:"inline-flex",alignItems:"center",gap:3,
      fontSize:12,fontWeight:700,padding:"3px 7px",borderRadius:6,
      background:"var(--c-surface-2)",color:"var(--c-muted)",whiteSpace:"nowrap",
      lineHeight:1,zIndex:2,
    };
    if(absolute){
      style.position="absolute";
      style.top=12;
      style.right=12;
    }
    return(
      <span style={style}>● {prevLabel||"Было:"} {prevValue}</span>
    );
  }
  if(pct===null||pct===undefined||!isFinite(pct)) return null;
  const isZero=Math.abs(pct)<0.05;
  const good=isZero?null:(invert?pct<0:pct>0);
  const arrow=pct>0?"▲":pct<0?"▼":"→";
  const bg=isZero?"var(--c-surface-2)":(good?"var(--c-success-bg)":"var(--c-danger-bg-2)");
  const fg=isZero?"var(--c-muted)":(good?"var(--c-success)":"var(--c-danger-strong)");
  const style={
    display:"inline-flex",alignItems:"center",gap:3,
    fontSize:12,fontWeight:700,padding:"3px 7px",borderRadius:6,
    background:bg,color:fg,whiteSpace:"nowrap",
    lineHeight:1,zIndex:2,
  };
  if(absolute){
    style.position="absolute";
    style.top=12;
    style.right=12;
  }
  return(
    <span style={style}>
      {arrow} {pct>0?"+":""}{pct.toFixed(1)}%
    </span>
  );
}

// "$" badge with popover — shows original currencies breakdown on hover.
// byCur is an object like {EUR: 1234.56, PLN: 66968, CZK: 1346, ...}
// lang controls the header label ("Исходные валюты" / "Original currencies").
// The popover is rendered through createPortal to document.body, so it is NOT
// clipped by the parent `.fc-kpi-scroll` container (which has overflow-x:auto
// and would otherwise produce an unwanted vertical scrollbar).
//
// IMPORTANT: All hooks (useState, useRef, useEffect) MUST be called before any
// early `return null`, otherwise React throws error #310 ("Rendered fewer hooks
// than expected") when byCur changes between renders.

/** Всплывающая подсказка к элементу. Рисуется отдельным слоем (createPortal),
 *  а не рядом с элементом: шапка дашборда прокручивается по горизонтали
 *  (overflow-x:auto), и подсказка внутри неё была бы обрезана по краю — или
 *  добавила бы шапке полосу прокрутки. Тот же приём уже применён к «исходным
 *  валютам» (CurrencyBadge) и подсказке PLN, поэтому вид и поведение совпадают.
 *
 *  Показывается и по наведению, и по фокусу: до подсказки должно быть можно
 *  добраться с клавиатуры, а не только мышью. `pointer-events:none` (в классе
 *  .fc-hint) — подсказка не перехватывает курсор и не «мигает» на границе. */
export function Hint({label,children,align="left",width=0}){
  const [open,setOpen]=useState(false);
  const ref=useRef(null);
  const [pos,setPos]=useState({top:0,left:0});
  useEffect(()=>{
    if(!open) return;
    const update=()=>{
      if(!ref.current) return;
      const r=ref.current.getBoundingClientRect();
      // Ширина: либо задана (таблица «показатель — значение»), либо по тексту.
      const w=width||ref.current.offsetWidth||160;
      // «center» — для маленьких значков-подсказок: подсказка встаёт по центру
      // значка, а не свисает вправо от него. Существующие вызовы передают
      // только left/right, для них поведение не меняется.
      let left=align==="right"?r.right-w:(align==="center"?r.left+r.width/2-w/2:r.left);
      left=Math.max(8,Math.min(left,window.innerWidth-w-8));
      setPos({top:r.bottom+8,left});
    };
    update();
    window.addEventListener("scroll",update,true);
    window.addEventListener("resize",update);
    return ()=>{window.removeEventListener("scroll",update,true);window.removeEventListener("resize",update);};
  },[open,align,width]);
  return(
    <span ref={ref} style={{display:"inline-flex"}}
          onMouseEnter={()=>setOpen(true)} onMouseLeave={()=>setOpen(false)}
          onFocusCapture={()=>setOpen(true)} onBlurCapture={()=>setOpen(false)}>
      {children}
      {open&&createPortal(
        <div className="fc-hint" role="tooltip"
             style={{top:pos.top,left:pos.left,...(width?{width}:{whiteSpace:"nowrap"})}}>{label}</div>,
        document.body)}
    </span>
  );
}

/** Квадратная кнопка со значком. Подписи нет — смысл в подсказке, поэтому
 *  доступное имя обязательно дублируем в aria-label: по значку «⬇» скринридер
 *  ничего не прочитает. `title` НЕ ставим специально: иначе браузер показал бы
 *  свою подсказку поверх нашей и получалось бы две разные по виду. */
export function IconBtn({icon,label,onClick,disabled=false,size=32,align="right"}){
  return(
    <Hint label={label} align={align}>
      <button type="button" className="fc-icon-btn" onClick={onClick} disabled={disabled}
              aria-label={label} style={{width:size,height:size,fontSize:14,lineHeight:1}}>
        <span aria-hidden="true">{icon}</span>
      </button>
    </Hint>
  );
}

/** Маленький серый кружок с буквой «i» — пояснение к сокращению в таблице.
 *
 *  Зачем: в «Финансах по авто» рядом стоят «AdB / ДТ» и «€/км». Обе подписи
 *  короткие, и по ним не понять, что именно считается и какие значения
 *  считаются нормой. Раньше объяснять это было нечем — приходилось угадывать.
 *
 *  Сделано на `Hint`, поэтому подсказка рисуется порталом поверх страницы: её
 *  не обрежет ни прокручиваемая карточка, ни липкая шапка таблицы (обычный
 *  absolute-тултип внутри `overflow:auto` обрезается — это и была бы «немного
 *  работающая» подсказка). Открывается и мышью, и с клавиатуры.
 *
 *  `width` задаётся явно: текст длинный, переносить его надо по словам, а не
 *  растягивать одной строкой на пол-экрана. */
export function InfoDot({label,ariaLabel,width=300}){
  return(
    <Hint label={label} width={width} align="center">
      <button type="button" className="fc-info-dot fc-tap-24" aria-label={ariaLabel||label}>
        <span aria-hidden="true">i</span>
      </button>
    </Hint>
  );
}

/** Размер кнопки синхронизации. Вынесен константой: ширина и высота обязаны
 *  совпадать в покое и во время работы, иначе кнопка «дёргает» соседей ровно в
 *  тот момент, когда пользователь ждёт ответа. Проверяется в check-behaviour. */
export const SYNC_BTN_W=150;
export const SYNC_BTN_H=36;

/** Кнопка синхронизации: строго фиксированный размер, во время работы —
 *  вращающийся индикатор и жёлтая заливка. Раньше подпись «Синхронизация…»
 *  была длиннее «Синхр. e100», кнопка росла вширь и сдвигала фильтры. */
export function SyncBtn({busy,label,busyLabel,onClick,disabled,title}){
  return(
    <button type="button" className={"fc-btn fc-sync-btn"+(busy?" fc-busy":"")}
            style={{...s.btnPrimary,width:SYNC_BTN_W,height:SYNC_BTN_H,padding:0,
                    boxShadow:busy?"none":undefined}}
            onClick={onClick} disabled={disabled} aria-busy={busy}
            title={busy?undefined:title}>
      {busy
        ? <span className="fc-spin" aria-hidden="true"/>
        : <span aria-hidden="true">🔄</span>}
      <span>{busy?busyLabel:label}</span>
    </button>
  );
}

/** Выбор источника. Внутри — настоящий <select> (прозрачный и растянутый по
 *  кнопке), поэтому системный список, клавиатура и чтение скринридером
 *  работают как раньше, а вид задаём сами — как у фильтра даты. Прежде это был
 *  голый <select>: он выпадал из общего стиля шапки и «не реагировал» на
 *  наведение, из-за чего не читался как нажимаемый. */
export function srcFilterOptions(t){
  return[
    {v:"",label:t.allSources,icon:"🔀"},
    {v:"e100",label:"E100",icon:"⚡"},
    {v:"q8",label:"Q8",icon:"⛽"},
    {v:"manual",label:"Manual",icon:"✍"},
  ];
}

export function SrcFilter({value,onChange,t}){
  const opts=srcFilterOptions(t);
  const cur=opts.find(o=>o.v===value)||opts[0];
  return(
    <span className="fc-src">
      <span aria-hidden="true">{cur.icon}</span>
      <span className="fc-src-label">{cur.label}</span>
      <span className="fc-src-chev" aria-hidden="true">▾</span>
      <select className="fc-src-native" value={value} aria-label={t.source}
              onChange={e=>onChange(e.target.value)}>
        {opts.map(o=><option key={o.v} value={o.v}>{o.icon} {o.label}</option>)}
      </select>
    </span>
  );
}


export function SkeletonRows({rows=6,height=14,cols=[38,18,22,12,10]}){
  return(
    <div aria-busy="true" aria-live="polite" style={{padding:"4px 0"}}>
      {Array.from({length:rows}).map((_,i)=>(
        <div key={i} style={{display:"flex",gap:12,alignItems:"center",padding:"11px 12px",borderBottom:"1px solid var(--c-surface-2)"}}>
          {cols.map((w,j)=>(
            <div key={j} className="fc-skel" style={{height,flex:`0 0 ${w}%`}}/>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── TxFilterBar ────────────────────────────────────────

export function TxFilterBar({vehicles, countries, vehicleFilter, setVehicleFilter, countryFilter, setCountryFilter, sortMode, setSortMode, t, embedded, total}) {
  const selectStyle = {padding:"6px 12px",border:"1px solid var(--c-border-2)",borderRadius:8,fontSize:12,fontWeight:600,background:"var(--c-surface)",cursor:"pointer",color:"var(--c-text-2)",outline:"none"};
  const wrapStyle = embedded
    ? {display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}
    : {display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",padding:"10px 16px",background:"var(--c-surface)",borderRadius:10,border:"1px solid var(--c-border-2)",marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.04)"};
  return (
    <div className="fc-table-filters" style={wrapStyle}>
      <select className="fc-select" style={selectStyle} value={vehicleFilter||""} onChange={e=>setVehicleFilter(e.target.value)}>
        <option value="">{t.allVehicles ? "🚛 "+t.allVehicles : "🚛 Все авто"}</option>
        {(vehicles||[]).map(v=><option key={v} value={v}>{v}</option>)}
      </select>
      <select className="fc-select" style={selectStyle} value={countryFilter||""} onChange={e=>setCountryFilter(e.target.value)}>
        <option value="">{t.allCountries ? "🌐 "+t.allCountries : "🌐 Все страны"}</option>
        {(countries||[]).map(c=><option key={c} value={c}>{FLAGS[c]||"🌍"} {c}</option>)}
      </select>
      <select className="fc-select" style={selectStyle} value={sortMode||"date_desc"} onChange={e=>setSortMode(e.target.value)}>
        <option value="date_desc">📅 {t.sortDateNew}</option>
        <option value="date_asc">📅 {t.sortDateOld}</option>
        <option value="amount_desc">💰 {t.sortAmountHigh}</option>
        <option value="amount_asc">💰 {t.sortAmountLow}</option>
        <option value="plate_asc">🔤 {t.sortAlpha}</option>
      </select>
      {/* Активные фильтры не были видны: непонятно, почему в таблице мало
          строк — короткий период или включённый фильтр. Кнопка появляется
          только когда фильтр реально включён и сбрасывает всё сразу. */}
      {(vehicleFilter||countryFilter||(sortMode&&sortMode!=="date_desc"))&&(
        <button type="button"
          onClick={()=>{ if(setVehicleFilter)setVehicleFilter(""); if(setCountryFilter)setCountryFilter(""); if(setSortMode)setSortMode("date_desc"); }}
          title="Сбросить фильтры таблицы"
          style={{...selectStyle,background:"var(--c-hover)",color:"var(--c-muted-2)"}}>
          ✕ Сбросить
        </button>
      )}
    </div>
  );
}

// ── Paginated tx table for dashboard ─────────────


export function Badge({children,bg="var(--c-info-bg)",fg="var(--c-info-2)"}){return <span style={{background:bg,color:fg,padding:"2px 8px",borderRadius:20,fontSize:12,fontWeight:600,whiteSpace:"nowrap"}}>{children}</span>;}

export function SrcBadge({source}){const b=SRC[source]||{bg:"var(--c-hover)",fg:"var(--c-muted-2)",label:source};return <Badge bg={b.bg} fg={b.fg}>{b.label}</Badge>;}

export function PeriodSel({period,setPeriod,custom,setCustom,t}){
  const [open,setOpen]=useState(false);
  const btnRef=useRef(null);
  const [pos,setPos]=useState({top:0,left:0});
  const dates=getPeriodDates(period,custom);
  const lbl=`${fmtDMY(dates.from)} — ${fmtDMY(dates.to)}`;

  const [selStart,setSelStart]=useState(null);
  const [selEnd,setSelEnd]=useState(null);
  const [viewMonth,setViewMonth]=useState(new Date());

  const updatePos=()=>{
    if(!btnRef.current) return;
    const r=btnRef.current.getBoundingClientRect();
    const width=640;
    const left=Math.min(r.left,Math.max(8,window.innerWidth-width-8));
    setPos({top:r.bottom+8,left});
  };

  const openPicker=()=>{
    const d0=parseISODate(dates.from), d1=parseISODate(dates.to);
    setSelStart(d0);setSelEnd(d1);
    setViewMonth(new Date(d0.getFullYear(),d0.getMonth(),1));
    updatePos();
    setOpen(true);
  };
  const closePicker=()=>setOpen(false);

  useEffect(()=>{
    if(!open) return;
    updatePos();
    window.addEventListener("scroll",updatePos,true);
    window.addEventListener("resize",updatePos);
    return ()=>{window.removeEventListener("scroll",updatePos,true);window.removeEventListener("resize",updatePos);};
  },[open]);

  const pickPreset=k=>{ setPeriod(k); setOpen(false); };

  const rangeLo=selStart&&selEnd?(selStart<=selEnd?selStart:selEnd):selStart;
  const rangeHi=selStart&&selEnd?(selStart<=selEnd?selEnd:selStart):selStart;
  const dayCount=rangeLo&&rangeHi?Math.round((rangeHi-rangeLo)/86400000)+1:0;

  const applyCustom=()=>{
    if(!rangeLo) return;
    setCustom({from:isoFmt(rangeLo),to:isoFmt(rangeHi)});
    setPeriod("custom");
    setOpen(false);
  };

  const handleDayClick=d=>{
    if(!selStart||(selStart&&selEnd)){ setSelStart(d); setSelEnd(null); }
    else if(d<selStart){ setSelEnd(selStart); setSelStart(d); }
    else setSelEnd(d);
  };

  const monthA=viewMonth;
  const monthB=new Date(viewMonth.getFullYear(),viewMonth.getMonth()+1,1);
  const navBtn={background:"none",border:"1px solid var(--c-border-2)",borderRadius:6,width:24,height:24,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"var(--c-muted-3)"};

  return(
    <div style={{position:"relative"}}>
      <button ref={btnRef} className={"fc-dp-trigger"+(open?" fc-open":"")} onClick={()=>open?closePicker():openPicker()}
        style={{...s.btn,display:"flex",alignItems:"center",gap:8}}>
        📅 <span>{lbl}</span> <span className="fc-dp-chevron" style={{fontSize:11}}>▾</span>
      </button>
      {open&&createPortal(
        <>
          <div onClick={closePicker} style={{position:"fixed",inset:0,zIndex:199}}/>
          <div className="fc-dp-popup" style={{position:"fixed",top:pos.top,left:pos.left,zIndex:200,background:"var(--c-surface)",
            border:"1px solid var(--c-border-2)",borderRadius:14,boxShadow:"0 20px 35px -10px rgba(16,24,40,.15),0 8px 16px -4px rgba(16,24,40,.08)",
            width:640,overflow:"hidden"}}>
            <div className="fc-dp-body" style={{display:"flex",borderBottom:"1px solid var(--c-border-2)"}}>
              <div className="fc-dp-presets" style={{width:160,background:"var(--c-surface-3)",borderRight:"1px solid var(--c-border-2)",padding:"12px 8px",display:"flex",flexDirection:"column",gap:2,flexShrink:0}}>
                {DP_PRESETS.map(k=>(
                  <button key={k} className={"fc-dp-preset"+(period===k?" fc-active":"")} onClick={()=>pickPreset(k)}
                    style={{padding:"8px 10px",borderRadius:6,border:"none",background:"transparent",textAlign:"left",fontSize:12,
                      fontWeight:period===k?700:500,color:period===k?"var(--c-brand)":"var(--c-muted-3)",cursor:"pointer",whiteSpace:"nowrap"}}>
                    {t.periods[k]}
                  </button>
                ))}
              </div>
              <div className="fc-dp-calendars" style={{display:"flex",gap:20,padding:16,flex:1}}>
                {[monthA,monthB].map((m,i)=>(
                  <div key={i} style={{flex:1}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,fontWeight:700,fontSize:12}}>
                      {i===0?<button className="fc-dp-nav" style={navBtn} onClick={()=>setViewMonth(new Date(monthA.getFullYear(),monthA.getMonth()-1,1))}>‹</button>:<span style={{width:24}}/>}
                      <span>{t.dpMonths[m.getMonth()]} {m.getFullYear()}</span>
                      {i===1?<button className="fc-dp-nav" style={navBtn} onClick={()=>setViewMonth(new Date(monthA.getFullYear(),monthA.getMonth()+1,1))}>›</button>:<span style={{width:24}}/>}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,textAlign:"center"}}>
                      {t.dpWeekdays.map(w=><div key={w} style={{fontSize:11,fontWeight:700,color:"var(--c-muted-2)",paddingBottom:6,textTransform:"uppercase"}}>{w}</div>)}
                      {buildMonthGrid(m).map((cell,idx)=>{
                        const inRange=!cell.muted&&rangeLo&&rangeHi&&cell.date>=rangeLo&&cell.date<=rangeHi;
                        const isStart=!cell.muted&&rangeLo&&sameDay(cell.date,rangeLo);
                        const isEnd=!cell.muted&&rangeHi&&sameDay(cell.date,rangeHi);
                        return(
                          <div key={idx} className={"fc-dp-day"+(cell.muted?" fc-muted":"")}
                            onClick={()=>!cell.muted&&handleDayClick(cell.date)}
                            style={{height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,
                              fontWeight:isStart||isEnd?700:500,
                              borderRadius:isStart&&isEnd?6:isStart?"6px 0 0 6px":isEnd?"0 6px 6px 0":inRange?0:6,
                              cursor:cell.muted?"default":"pointer",userSelect:"none",
                              color:cell.muted?"var(--c-border-strong)":(isStart||isEnd)?"var(--c-on-brand)":inRange?"var(--c-brand)":"var(--c-text-2)",
                              background:(isStart||isEnd)?"var(--c-brand-solid)":inRange?"var(--c-brand-bg)":"transparent"}}>
                            {cell.date.getDate()}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div style={{fontSize:12,fontWeight:600,color:"var(--c-text-2)",display:"flex",alignItems:"center",gap:8}}>
                <span>{t.dpSelected}: <strong>{rangeLo?fmtDMY(isoFmt(rangeLo)):"—"} — {rangeHi?fmtDMY(isoFmt(rangeHi)):"—"}</strong></span>
                {dayCount>0&&<span style={{background:"var(--c-brand-bg)",color:"var(--c-brand)",padding:"2px 8px",borderRadius:12,fontSize:12,fontWeight:700}}>{dayCount} {dayCountWord(dayCount,t)}</span>}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={closePicker} style={{padding:"6px 12px",borderRadius:6,fontSize:12,fontWeight:600,border:"1px solid var(--c-border-2)",background:"transparent",color:"var(--c-muted-3)",cursor:"pointer"}}>{t.cancel}</button>
                <button onClick={applyCustom} style={{padding:"6px 14px",borderRadius:6,fontSize:12,fontWeight:600,border:"none",background:"var(--c-brand-solid)",color:"var(--c-on-brand)",cursor:"pointer"}}>{t.dpApply}</button>
              </div>
            </div>
          </div>
        </>, document.body
      )}
    </div>
  );
}


export function TxTable({txns,t,showVolume=false,colorIncome=false,onDeleteManual=null}){
  const [confirmId,setConfirmId]=useState(null);
  if(!txns.length) return <div style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>{t.noData}</div>;
  return(
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead><tr style={{background:"var(--c-hover)"}}>
          {[t.status,t.source,t.date,t.plate,t.driver,t.type,t.country,
            ...(showVolume?[t.volume,t.price]:[]),t.amount,t.station,
            ...(onDeleteManual?[""]:[])].map((h,i)=>(
            <th key={i} style={s.th}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {txns.map(tx=>{
            const st=txStatus(tx);
            const ftBg=isToll(tx.fuel_type)?"var(--c-warn-bg)":isAdBlue(tx.fuel_type)?"var(--c-success-bg-3)":isSvcFee(tx.fuel_type)?"var(--c-hover)":isSalary(tx.fuel_type)?"var(--c-violet-bg-3)":isIncome(tx.fuel_type)?"var(--c-success-bg-2)":"var(--c-info-bg)";
            const ftFg=isToll(tx.fuel_type)?"var(--c-warn-strong)":isAdBlue(tx.fuel_type)?"var(--c-teal)":isSvcFee(tx.fuel_type)?"var(--c-muted)":isSalary(tx.fuel_type)?"var(--c-violet)":isIncome(tx.fuel_type)?"var(--c-success-dark)":"var(--c-info-2)";
            const amtColor = colorIncome ? (isIncome(tx.fuel_type) ? "var(--c-emerald)" : "var(--c-danger)") : undefined;
            const isConfirm = confirmId===tx.id;
            return(
              <tr key={tx.id} style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                <td style={s.td} title={st.label}>{st.icon}</td>
                <td style={s.td}><SrcBadge source={tx.source}/></td>
                <td style={{...s.td,whiteSpace:"nowrap"}}>{fmtDateTime(tx.transaction_date)}</td>
                <td style={s.td}><b>{tx.plate_number||"—"}</b></td>
                <td style={s.td}>{
                  // For income transactions (csv_income source), driver_name holds
                  // the raw dispatcher's product text (long string with plate as typed,
                  // e.g. "CMR Nr 61/... BI855GS/QARA784"). We use it as a tooltip on
                  // the Income page to help the user spot typos, but on the Dashboard
                  // we hide it so the transactions list stays compact. The actual
                  // driver name (if assigned via Vehicle) is shown via the live
                  // driver_by_plate lookup done by the backend.
                  tx.source==="csv_income" && !tx.plate_number ? "—" : (tx.driver_name||"—")
                }</td>
                <td style={s.td}><Badge bg={ftBg} fg={ftFg}>{tx.fuel_type?.replace("manual_","")||"—"}</Badge></td>
                <td style={s.td}>{FLAGS[tx.country]||""} {tx.country||"—"}</td>
                {showVolume&&<>
                  <td style={s.td}>{tx.volume>0?tx.volume.toFixed(2):"—"}</td>
                  <td style={s.td}>{tx.price>0?tx.price.toFixed(4):"—"}</td>
                </>}
                <td style={{...s.td,fontWeight:700,color:amtColor,fontFamily:MONO,whiteSpace:"nowrap"}}>{colorIncome&&isIncome(tx.fuel_type)?"+":""}{fmtQty(tx.amount,2)} {tx.currency}{tx.amount_eur==null&&Number(tx.amount||0)!==0&&(
                  <span role="img" aria-label="нет курса" title="Нет курса на дату операции — сумма не учтена в итогах EUR"
                        style={{marginLeft:6,color:"var(--c-warn-strong)",cursor:"help"}}>⚠</span>)}</td>
                <td style={{...s.td,fontSize:12,color:"var(--c-muted-2)",maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tx.station_address||tx.station_id||"—"}</td>
                {onDeleteManual&&<td style={s.td}>
                  {tx.source==="manual"&&(
                    isConfirm?(
                      <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"3px 6px",background:"var(--c-danger-bg)",border:"1px solid var(--c-danger-border)",borderRadius:8,whiteSpace:"nowrap"}}>
                        <span style={{fontSize:12,fontWeight:600,color:"var(--c-danger-strong)"}}>{t.deleteConfirm}</span>
                        <button
                          onClick={async()=>{await onDeleteManual(tx.id);setConfirmId(null);}}
                          title={t.save}
                          style={{padding:0,width:22,height:22,fontSize:13,fontWeight:700,border:"1px solid var(--c-success-solid)",borderRadius:6,background:"var(--c-success-bg)",color:"var(--c-success)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>✓</button>
                        <button
                          onClick={()=>setConfirmId(null)}
                          title={t.cancel}
                          style={{padding:0,width:22,height:22,fontSize:13,fontWeight:700,border:"1px solid var(--c-danger)",borderRadius:6,background:"var(--c-danger-bg-2)",color:"var(--c-danger-strong)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>⊘</button>
                      </div>
                    ):(
                      <button
                        onClick={()=>setConfirmId(tx.id)}
                        title={t.actionDelete}
                        style={{padding:0,width:22,height:22,fontSize:12,fontWeight:700,border:"1px solid var(--c-danger-border)",borderRadius:6,background:"var(--c-surface)",color:"var(--c-danger)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>✕</button>
                    )
                  )}
                </td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Скелетон строк таблицы. Используется там, где есть флаг loading:
// раньше на месте данных была строка «...», из-за чего страница «прыгала».

export function sortTxns(txns, mode) {
  if (!mode || mode === "date_desc") return [...txns].sort((a, b) => (b.transaction_date || "").localeCompare(a.transaction_date || ""));
  if (mode === "date_asc") return [...txns].sort((a, b) => (a.transaction_date || "").localeCompare(b.transaction_date || ""));
  if (mode === "amount_desc") return [...txns].sort((a, b) => (b.amount || 0) - (a.amount || 0));
  if (mode === "amount_asc") return [...txns].sort((a, b) => (a.amount || 0) - (b.amount || 0));
  if (mode === "plate_asc") return [...txns].sort((a, b) => (a.plate_number || "").localeCompare(b.plate_number || ""));
  return txns;
}


export function PaginatedTxTable({dates,srcFilter,t,lang,vehicleFilter,setVehicleFilter,countryFilter,setCountryFilter,sortMode,setSortMode,vehicles,countries,bare=false}){
  const [page,setPage]=useState(0);
  const [txns,setTxns]=useState([]);
  const [total,setTotal]=useState(0);

  useEffect(()=>{ setPage(0); },[dates.from,dates.to,srcFilter,vehicleFilter,countryFilter,sortMode]);

  useEffect(()=>{
    let q=`date_from=${dates.from}&date_to=${dates.to}&limit=${PAGE_SIZE}&offset=${page*PAGE_SIZE}&sort=${sortMode||"date_desc"}`;
    if(srcFilter) q+=`&source=${srcFilter}`;
    if(vehicleFilter) q+=`&plate_number=${encodeURIComponent(vehicleFilter)}`;
    if(countryFilter) q+=`&country=${encodeURIComponent(countryFilter)}`;
    apiGet(`/transactions/?${q}`)
      .then(d=>setTxns(Array.isArray(d)?d:[]));
  },[page,dates.from,dates.to,srcFilter,vehicleFilter,countryFilter,sortMode]);

  useEffect(()=>{
    let q=`date_from=${dates.from}&date_to=${dates.to}`;
    if(srcFilter) q+=`&source=${srcFilter}`;
    if(vehicleFilter) q+=`&plate_number=${encodeURIComponent(vehicleFilter)}`;
    if(countryFilter) q+=`&country=${encodeURIComponent(countryFilter)}`;
    apiGet(`/transactions/count?${q}`)
      .then(d=>setTotal(d?.total||0));
  },[dates.from,dates.to,srcFilter,vehicleFilter,countryFilter]);

  const totalPages=Math.max(1,Math.ceil(total/PAGE_SIZE));
  const displayTxns = sortTxns(txns, sortMode);
  const hasFilters = setVehicleFilter && setCountryFilter && setSortMode;

  return(
    // bare=true: та же таблица без «карточной» рамки — для выдвижной панели
    // «Все транзакции» на дашборде, где рамка карточки внутри рамки панели
    // читалась бы как вложенный блок. Разметка и данные не меняются.
    <Card style={{padding:0,...(bare?{border:"none",borderRadius:0,boxShadow:"none"}:{})}}>
      {/* Шапка: слева «заголовок + легенда цветов», справа фильтры — всё в одну
          строку. Легенда раньше стояла отдельной строкой под заголовком и
          отнимала высоту у таблицы; переходы по страницам переехали вниз
          (см. Pagination), потому что листать список, возвращаясь курсором
          наверх, неудобно. */}
      <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",minWidth:0}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.recentTx} ({total})</h3>
          <span style={{fontSize:12,color:"var(--c-muted-2)",whiteSpace:"nowrap"}}>🟢 OK · 🟡 Delayed · 🔴 Blocked</span>
        </div>
        {hasFilters&&(
          <TxFilterBar vehicles={vehicles} countries={countries} embedded
            vehicleFilter={vehicleFilter} setVehicleFilter={setVehicleFilter}
            countryFilter={countryFilter} setCountryFilter={setCountryFilter}
            sortMode={sortMode} setSortMode={setSortMode} t={t}/>
        )}
      </div>
      <TxTable txns={displayTxns} t={t} colorIncome={true}/>
      <Pagination total={total} limit={PAGE_SIZE} offset={page*PAGE_SIZE} onChange={setPage} lang={lang}/>
    </Card>
  );
}


// ── Vehicle Income & Profit Widget ────────────────────

/**
 * UnratedNote — «в итог не вошло: RON, NOK».
 *
 * Нужен там, где рядом с итоговой суммой нет разбивки по валютам
 * (главные KPI дашборда): сама цифра показывается через sumToEur(), который
 * валюты без курса выбрасывает, — без этой пометки пользователь увидел бы
 * заниженный расход и не узнал об этом. Рендерит null, если всё пересчитано,
 * поэтому вставлять можно безусловно.
 */
export function UnratedNote({byCur, lang}){
  const unrated=unknownCurrencies(byCur);
  if(!unrated.length) return null;
  const ru=lang==="RU";
  return(
    <div className="fc-unrated-note">
      <span aria-hidden="true">⚠</span>
      <span>{(ru?"в итог не вошло: ":"excluded from the total: ")+unrated.join(", ")}</span>
    </div>
  );
}

/**
 * LegacyContractsNotice — «есть договоры старого формата, их нужно перенести».
 *
 * Лизинг, прицепы, страхование и общие расходы переведены на единый механизм
 * регулярных платежей; страницы больше не читают старые таблицы договоров, поэтому
 * непереведённый договор на странице не виден. Плашка показывается, пока такие
 * договоры есть, и даёт владельцу компании перенести их кнопкой: сначала пробный
 * прогон (что именно будет перенесено), затем — по подтверждению — сам перенос.
 * Рендерит null, когда переносить нечего.
 */
export function LegacyContractsNotice({lang,onDone}){
  const ru=lang==="RU";
  const [total,setTotal]=useState(0);
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState("");
  const refresh=useCallback(async()=>{
    try{ const d=await apiGet("/recurring-expenses/legacy-status"); setTotal((d&&d.total)||0); }
    catch(e){ setTotal(0); }
  },[]);
  useEffect(()=>{ refresh(); },[refresh]);
  if(!total&&!msg) return null;
  const run=async()=>{
    setBusy(true); setMsg("");
    try{
      const dry=await apiFetch("/recurring-expenses/migrate-legacy?apply=false",{method:"POST"});
      if(dry.status===403){ setMsg(ru?"Перенос может выполнить только владелец компании.":"Only the company owner can run the migration."); setBusy(false); return; }
      const rep=await dry.json();
      const q=ru
        ? `Будет перенесено договоров: ${rep.migrated}, списаний привязано: ${rep.charges_relinked}, удалённых списаний сохранено: ${rep.tombstones_moved}`+(rep.errors?`, с ошибкой: ${rep.errors}`:"")+".\nСуммы и курсы прежних списаний не меняются. Выполнить перенос?"
        : `Contracts to migrate: ${rep.migrated}, charges relinked: ${rep.charges_relinked}, removed charges kept: ${rep.tombstones_moved}`+(rep.errors?`, with errors: ${rep.errors}`:"")+".\nAmounts and rates of existing charges stay unchanged. Run the migration?";
      if(rep.migrated>0 && window.confirm(q)){
        const r=await apiFetch("/recurring-expenses/migrate-legacy?apply=true",{method:"POST"});
        const d=await r.json();
        setMsg(ru?`Перенесено договоров: ${d.migrated}.`:`Contracts migrated: ${d.migrated}.`);
        await refresh();
        if(onDone) onDone();
      }
    }catch(e){ setMsg(ru?"Не удалось выполнить перенос.":"Migration failed."); }
    setBusy(false);
  };
  return(
    <div role="status" style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:12,
                               padding:"10px 14px",borderRadius:10,fontSize:13,lineHeight:1.5,
                               background:"var(--c-info-bg)",color:"var(--c-info)",border:"1px solid var(--c-info-border)"}}>
      <span aria-hidden="true">ℹ️</span>
      <span style={{flex:1,minWidth:220}}>
        {msg||(ru
          ? `Найдено договоров старого формата: ${total}. Они не показываются на страницах, пока не перенесены в «Регулярные платежи».`
          : `Legacy contracts found: ${total}. They are hidden on the pages until moved to “Recurring payments”.`)}
      </span>
      {total>0&&(
        <button type="button" disabled={busy} onClick={run}
                style={{border:"1px solid currentColor",background:"transparent",color:"inherit",borderRadius:8,
                        padding:"5px 10px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
          {busy?"…":(ru?"Перенести":"Migrate")}
        </button>
      )}
    </div>
  );
}


/** Переход на другую страницу из вложенного компонента без протаскивания
 *  `setPage` через все страницы: App слушает это событие. */
export function navigateTo(page){
  try{ window.dispatchEvent(new CustomEvent("fc:navigate",{detail:page})); }catch(e){ /* нет window — не критично */ }
}

/**
 * MissingEurBanner — «N операций не учтены в итогах EUR».
 *
 * Строка без курса на дату сохраняется с amount_eur = NULL (это правильно: лучше,
 * чем выдуманный курс), но итоги на странице считают её нулём. Без этой плашки
 * итог выглядит полным, хотя часть расходов в нём отсутствует. Рендерит null,
 * когда все строки пересчитаны, поэтому вставлять можно безусловно.
 */
export function MissingEurBanner({rows,lang}){
  const missing=missingEurRows(rows);
  if(!missing.length) return null;
  const ru=lang==="RU";
  const byCur=missingEurByCur(rows);
  const parts=Object.entries(byCur).map(([c,v])=>`${fmtQty(v,2)} ${c}`).join(" · ");
  const n=missing.length;
  const op=(k)=>{const a=k%10,b=k%100;return a===1&&b!==11?"операция":(a>=2&&a<=4&&(b<12||b>14))?"операции":"операций";};
  const one=n%10===1&&n%100!==11;
  return(
    <div role="status" style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:12,
                               padding:"10px 14px",borderRadius:10,fontSize:13,lineHeight:1.5,
                               background:"var(--c-warn-bg)",color:"var(--c-warn-strong)",
                               border:"1px solid var(--c-warn-border, var(--c-warn-strong))"}}>
      <span aria-hidden="true">⚠</span>
      <span style={{flex:1,minWidth:220}}>
        {ru
          ? <><b>{n} {op(n)}</b> ({parts}) {one?"не вошла":"не вошли"} в итоги в EUR — нет курса на дату операции. Исходные суммы сохранены; введите курс вручную или загрузите историю курсов.</>
          : <><b>{n} transaction{n===1?"":"s"}</b> ({parts}) are not included in the EUR totals — no exchange rate for the date. Original amounts are kept; add the rate manually or load the rate history.</>}
      </span>
      <button type="button" onClick={()=>navigateTo("fxrates")}
              style={{border:"1px solid currentColor",background:"transparent",color:"inherit",borderRadius:8,
                      padding:"5px 10px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
        {ru?"Открыть курсы валют":"Open FX rates"}
      </button>
    </div>
  );
}


/** Компактный значок «есть валюта без курса» — для раскладок, где строка
 *  текста (UnratedNote) не помещается: угол плашки KPI и колонка значков в
 *  списках. Размер и цвета взяты теми же классами, что у значка исходных сумм,
 *  поэтому пара значков стоит вровень; отличие — жёлтая заливка (внимание).
 *  Пояснение целиком уходит в title и aria-label: молча занижать итог нельзя
 *  (валюту без курса sumToEur() выбрасывает). */
export function UnratedIcon({byCur, lang, missingCount=0}){
  const ru=lang==="RU";
  // Точное число операций без курса на дату (считает сервер по amount_eur)
  // главнее списка валют: список отвечает на другой вопрос — «валюту фронтенд
  // вообще не умеет пересчитывать». После перехода итогов на исторический курс
  // (FC-001) валюта может быть известна, а курса на конкретную дату нет — тогда
  // в итог не вошли именно эти операции, и предупреждение должно говорить о них.
  if(missingCount>0){
    // Падеж: «1 операция», «2 операции», «5 операций». В русском формы
    // зависят от последних двух цифр, поэтому обычное `n===1` не подходит.
    const op=(n)=>{
      const a=n%10, b=n%100;
      if(a===1&&b!==11) return "операция";
      if(a>=2&&a<=4&&(b<12||b>14)) return "операции";
      return "операций";
    };
    const t=ru
      ? `${missingCount} ${op(missingCount)} без курса на дату — в итог не вошли`
      : `${missingCount} transaction${missingCount===1?"":"s"} without a rate for their date — excluded from the total`;
    return(
      <span role="img" aria-label={t} title={t}
            className="fc-currency-trigger fc-currency-warn fc-unrated-icon">⚠</span>
    );
  }
  const unrated=unknownCurrencies(byCur);
  if(!unrated.length) return null;
  const text=(ru?"в итог не вошло: ":"excluded from the total: ")+unrated.join(", ");
  return(
    <span role="img" aria-label={text} title={text}
          className="fc-currency-trigger fc-currency-warn fc-unrated-icon">⚠</span>
  );
}

export function CurrencyBadge({byCur, lang, sumsOnly=false}){
  const [byHover,setByHover]=useState(false);
  const [pos,setPos]=useState({top:0,left:0});
  const ref=useRef();
  // Currency entries (excluding zero amounts); sorted by EUR value desc, EUR
  // first, currencies WITHOUT a rate last (см. curEntries в lib/money.js).
  const entries=curEntries(byCur);
  // Валюты, для которых нет курса, — они НЕ входят ни в один итог в EUR на
  // странице. Показываем это явно: заниженный итог расходов — опасная сторона
  // ошибки, а тихо выброшенная валюта — как раз то, как это происходит.
  const unrated=unknownCurrencies(byCur);
  // Значок показываем, только если есть что показать: валюта кроме EUR или
  // несколько валют. Условие вынесено в hasCurrencyBreakdown(), потому что по
  // нему же плашки резервируют место под значок в углу.
  const hasNonEur = entries.some(([c])=>c!=="EUR");
  const hasMultiple = entries.length>1;
  const isVisible = hasNonEur || hasMultiple ? byHover : false;
  // Recompute popover position whenever it becomes visible
  useEffect(()=>{
    if(!isVisible) return;
    const updatePos=()=>{
      if(!ref.current) return;
      const r=ref.current.getBoundingClientRect();
      const POP_W=200; // matches .fc-currency-popover width
      const gap=6;
      // Position the popover below the badge, right-aligned with it (so it doesn't overflow the right edge of the viewport).
      let left=r.right-POP_W;
      left=Math.max(8, Math.min(left, window.innerWidth-POP_W-8));
      let top=r.bottom+gap;
      setPos({top, left});
    };
    updatePos();
    const onScroll=()=>{ if(ref.current) updatePos(); };
    window.addEventListener("scroll",onScroll,true);
    window.addEventListener("resize",onScroll);
    return ()=>{
      window.removeEventListener("scroll",onScroll,true);
      window.removeEventListener("resize",onScroll);
    };
  },[isVisible]);
  // Early return AFTER all hooks — safe because hooks above always run in the same order.
  if(!hasCurrencyBreakdown(byCur)) return null;
  const fmtAmt=(v)=>v.toLocaleString(lang==="RU"?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  return(
    <div ref={ref} style={{position:"relative",display:"inline-block"}}
      onMouseEnter={()=>setByHover(true)}
      onMouseLeave={()=>setByHover(false)}>
      <button type="button"
        className={"fc-currency-trigger"+(byHover?" fc-open":"")+(unrated.length&&!sumsOnly?" fc-currency-warn":"")}
        title={unrated.length&&!sumsOnly
          ? (lang==="RU"
              ? `Исходные валюты. Без курса — вне итога в EUR: ${unrated.join(", ")}`
              : `Original currencies. No EUR rate, excluded from the total: ${unrated.join(", ")}`)
          : (lang==="RU"?"Исходные валюты (наведите курсор)":"Original currencies (hover)")}
        style={{border:"none"}}>
        {unrated.length&&!sumsOnly?"⚠":"$⬍"}
      </button>
      {isVisible && createPortal(
        <div className="fc-currency-popover" style={{top:pos.top, left:pos.left, position:"fixed", zIndex:9999}}
          onMouseEnter={()=>setByHover(true)}
          onMouseLeave={()=>setByHover(false)}>
          <div className="fc-popover-header">{lang==="RU"?"Исходные валюты":"Original currencies"}</div>
          {entries.map(([c,v])=>{
            // Пометка стоит рядом с самой суммой: причина видна там, где
            // цифра, а не только в подсказке к значку.
            const noRate=unrated.includes(c===""?"—":String(c));
            return(
              <div key={c} className={"fc-popover-row"+(noRate?" fc-popover-row-unrated":"")}>
                <span className="fc-popover-amount">{fmtAmt(v)}</span>
                <span className="fc-popover-code">{c||"—"}
                  {noRate&&<span className="fc-popover-flag"> · {lang==="RU"?"нет курса":"no rate"}</span>}
                </span>
              </div>
            );
          })}
          {unrated.length>0&&(
            <div className="fc-popover-note">
              {lang==="RU"
                ? `⚠ ${unrated.join(", ")} — курса нет, в итог в EUR не входит`
                : `⚠ ${unrated.join(", ")} — no rate, not included in the EUR total`}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
export function PaginatedSegmentsTable({dates,t,lang,vehiclePlates}){
  const [page,setPage]=useState(0);
  const [plateFilter,setPlateFilter]=useState("");
  const [statusFilter,setStatusFilter]=useState("");
  const [sortMode,setSortMode]=useLocalState("fc_paginatedsegmentstable_sortmode","date_desc");
  const [segments,setSegments]=useState([]);
  const [total,setTotal]=useState(0);
  const numFmt=n=>(n||0).toLocaleString(lang==="RU"?"ru-RU":"en-US");
  const selStyle={padding:"6px 12px",border:"1px solid var(--c-border-2)",borderRadius:8,fontSize:12,fontWeight:600,background:"var(--c-surface)",cursor:"pointer",color:"var(--c-text-2)",outline:"none"};

  useEffect(()=>{ setPage(0); },[dates.from,dates.to,plateFilter,statusFilter,sortMode]);

  useEffect(()=>{
    let q=`date_from=${dates.from}&date_to=${dates.to}&limit=${SEG_PAGE_SIZE}&offset=${page*SEG_PAGE_SIZE}&sort=${sortMode}`;
    if(plateFilter) q+=`&plate_number=${encodeURIComponent(plateFilter)}`;
    if(statusFilter) q+=`&status=${encodeURIComponent(statusFilter)}`;
    apiGet(`/mileage/segments?${q}`).then(d=>setSegments(Array.isArray(d)?d:[]));
  },[page,dates.from,dates.to,plateFilter,statusFilter,sortMode]);

  useEffect(()=>{
    let q=`date_from=${dates.from}&date_to=${dates.to}`;
    if(plateFilter) q+=`&plate_number=${encodeURIComponent(plateFilter)}`;
    if(statusFilter) q+=`&status=${encodeURIComponent(statusFilter)}`;
    apiGet(`/mileage/segments/count?${q}`).then(d=>setTotal(d?.total||0));
  },[dates.from,dates.to,plateFilter,statusFilter]);

  const totalPages=Math.max(1,Math.ceil(total/SEG_PAGE_SIZE));

  return(
    <Card style={{padding:0,overflowX:"auto"}}>
      <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.intervalLog} ({total})</h3>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginLeft:"auto"}}>
          <ShrunkSelect
            value={plateFilter}
            onChange={setPlateFilter}
            placeholder={`🚛 ${lang==="RU"?"Все авто":"All vehicles"}`}
            options={[
              {value:"", label:`🚛 ${lang==="RU"?"Все авто":"All vehicles"}`},
              ...vehiclePlates.map(p=>({value:p, label:p}))
            ]}/>
          <ShrunkSelect
            value={statusFilter}
            onChange={setStatusFilter}
            placeholder={`🔘 ${lang==="RU"?"Все статусы":"All statuses"}`}
            options={[
              {value:"", label:`🔘 ${lang==="RU"?"Все статусы":"All statuses"}`},
              {value:"Движение", label:`▶️ ${t.driveLabel}`},
              {value:"Стоянка", label:`⏸️ ${t.stopLabel}`},
            ]}/>
          <ShrunkSelect
            value={sortMode}
            onChange={setSortMode}
            placeholder={`📅 ${lang==="RU"?"Сначала новые":"Newest first"}`}
            options={[
              {value:"date_desc", label:`📅 ${lang==="RU"?"Сначала новые":"Newest first"}`},
              {value:"date_asc", label:`📅 ${lang==="RU"?"Сначала старые":"Oldest first"}`},
              {value:"km_desc", label:`📏 ${lang==="RU"?"Пробег: больше→меньше":"Mileage: high→low"}`},
              {value:"km_asc", label:`📏 ${lang==="RU"?"Пробег: меньше→больше":"Mileage: low→high"}`},
            ]}/>
        </div>
      </div>
      {!segments.length?<div style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>{t.noMileageData}</div>:(
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:800}}><thead><tr style={{background:"var(--c-hover)"}}>
          <th style={s.th}>{t.date}</th><th style={s.th}>{t.plate}</th><th style={s.th}>{t.statusCol}</th>
          <th style={s.th}>{t.intervalCol}</th><th style={s.th}>{t.mileageCol}</th><th style={s.th}>{t.fuelConsumed}</th>
        </tr></thead><tbody>
          {segments.map(r=>(
            <tr key={r.id} style={{borderBottom:"1px solid var(--c-surface-2)"}}>
              <td style={s.td}>{fmtDate(r.date)}</td>
              <td style={s.td}><b>{r.plate_number}</b></td>
              <td style={s.td}>
                <span style={{display:"inline-block",padding:"3px 8px",borderRadius:6,fontSize:12,fontWeight:600,
                  background:r.status==="Движение"?"var(--c-success-bg)":"var(--c-warn-bg)",color:r.status==="Движение"?"var(--c-success)":"var(--c-warn)"}}>{r.status}</span>
              </td>
              <td style={{...s.td,fontFamily:MONO,color:"var(--c-muted)"}}>{r.time_from} — {r.time_to}</td>
              <td style={{...s.td,fontWeight:600,fontFamily:MONO}}>{r.km!=null?numFmt(r.km)+" км":"—"}</td>
              <td style={{...s.td,fontFamily:MONO,color:"var(--c-muted-2)"}}>—</td>
            </tr>
          ))}
        </tbody></table>
      )}
      <Pagination total={total} limit={SEG_PAGE_SIZE} offset={page*SEG_PAGE_SIZE} onChange={setPage} lang={lang}/>
    </Card>
  );
}
export function DiffValue({v}){
  if(v===undefined) return <span style={{color:"var(--c-muted-2)"}}>—</span>;
  if(v===null) return <span style={{color:"var(--c-muted-2)"}}>—</span>;
  // Дата+время из снимка приходит строкой ISO («2026-09-28T18:05:00+00:00»):
  // движок аудита сериализует datetime через isoformat. В журнале это читалось
  // как машинный код, поэтому показываем так же, как везде в интерфейсе.
  // Проверка строгая: ISO-подобная строка в данных пользователя практически
  // невозможна, а вот в снимках полей — обычное дело.
  if(typeof v==="string"&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}/.test(v)){
    return <span style={{fontFamily:MONO,whiteSpace:"nowrap"}}>{fmtDateTime(v)}</span>;
  }
  if(typeof v==="boolean") return <span>{v?"да":"нет"}</span>;
  if(v==="***REDACTED***") return <span style={{color:"var(--c-muted-2)"}}>скрыто</span>;
  if(typeof v==="number") return <span style={{fontFamily:MONO}}>{fmtQty(v,String(v).includes(".")?Math.min(4,String(v).split(".")[1].length):0)}</span>;
  if(typeof v==="object") return <span style={{fontFamily:MONO,fontSize:11}}>{JSON.stringify(v)}</span>;
  return <span style={{wordBreak:"break-word"}}>{String(v)}</span>;
}
// Показывает ТОЛЬКО изменившиеся поля, по-русски, с подсветкой.
// Вид — как в редизайне журнала: две колонки «Было» / «Стало», а имя поля
// подписано ВНУТРИ каждой ячейки. Раньше это была таблица из трёх колонок
// (Поле | Было | Стало), где «было» зачёркивалось линией — на длинных значениях
// зачёркивание делало текст нечитаемым, а имя поля приходилось искать взглядом
// в отдельной колонке.
export function DiffView({oldV,newV,raw}){
  const [showRaw,setShowRaw]=useState(false);
  const parse=(x)=>{ if(x==null||x==="") return null; if(typeof x==="object") return x;
    try{ return JSON.parse(x); }catch(e){ return x; } };
  const o=parse(oldV), n=parse(newV);
  const isObj=(x)=>x&&typeof x==="object"&&!Array.isArray(x);
  const rows=[];
  if(isObj(o)||isObj(n)){
    const keys=[...new Set([...Object.keys(o||{}),...Object.keys(n||{})])];
    keys.forEach(k=>{
      const a=o?o[k]:undefined, b=n?n[k]:undefined;
      if(JSON.stringify(a)===JSON.stringify(b)) return;   // только реальные различия
      rows.push({k,a,b});
    });
  }
  const rawDump=(val)=>val==null?"—":(typeof val==="string"?val:JSON.stringify(val,null,2));
  const cellLabel={fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.04em",
                   display:"block",marginBottom:3};
  return(
    <div>
      {rows.length?(
        <div style={{border:"1px solid var(--c-border-3)",borderRadius:12,overflow:"hidden",fontSize:12}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",background:"var(--c-surface-2)",
                       borderBottom:"1px solid var(--c-border-3)"}}>
            <div style={{padding:"7px 12px",fontSize:11,fontWeight:700,color:"var(--c-muted-2)"}}>Было (До изменения)</div>
            <div style={{padding:"7px 12px",fontSize:11,fontWeight:700,color:"var(--c-muted-2)"}}>Стало (После изменения)</div>
          </div>
          {rows.map(({k,a,b},i)=>(
            <div key={k} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,padding:8,
                                 borderTop:i?"1px solid var(--c-surface-2)":"none"}}>
              <div style={{background:"var(--c-danger-bg)",border:"1px solid var(--c-danger-bg-2)",borderRadius:8,padding:8,
                           color:"var(--c-rose-800)",wordBreak:"break-word"}}>
                <span style={{...cellLabel,color:"var(--c-rose-soft)"}}>{fieldRu(k)}</span>
                <DiffValue v={a}/>
              </div>
              <div style={{background:"var(--c-success-bg-2)",border:"1px solid var(--c-success-bg)",borderRadius:8,padding:8,
                           color:"var(--c-success-deep)",fontWeight:600,wordBreak:"break-word"}}>
                <span style={{...cellLabel,color:"var(--c-emerald-300)"}}>{fieldRu(k)}</span>
                <DiffValue v={b}/>
              </div>
            </div>
          ))}
        </div>
      ):(
        <div style={{fontSize:12,color:"var(--c-muted-2)",padding:"2px 0"}}>
          {isObj(o)&&!isObj(n)?"Запись удалена — см. полный JSON ниже":"Изменений по полям нет (запись только добавлена)"}
        </div>
      )}
      <button type="button" onClick={()=>setShowRaw(v=>!v)}
        style={{marginTop:8,background:"none",border:"none",color:"var(--c-brand)",fontSize:12,fontWeight:600,cursor:"pointer",padding:0}}>
        {showRaw?"▾ Скрыть полный JSON":"▸ Показать полный JSON"}
      </button>
      {showRaw&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}>
          <pre style={{margin:0,background:"var(--c-hover)",padding:10,borderRadius:8,fontSize:11,fontFamily:MONO,
                       whiteSpace:"pre-wrap",wordBreak:"break-word",maxHeight:220,overflow:"auto"}}>{rawDump(o)}</pre>
          <pre style={{margin:0,background:"var(--c-hover)",padding:10,borderRadius:8,fontSize:11,fontFamily:MONO,
                       whiteSpace:"pre-wrap",wordBreak:"break-word",maxHeight:220,overflow:"auto"}}>{rawDump(n)}</pre>
        </div>
      )}
    </div>
  );
}

export function ShrunkSelect({value,onChange,options,placeholder}){
  const [open,setOpen]=useState(false);
  const ref=useRef();
  const selected=options.find(o=>o.value===value);
  const label=selected?selected.label:(placeholder||options[0]?.label||"");
  useEffect(()=>{
    const onDoc=(e)=>{ if(ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown",onDoc);
    return ()=>document.removeEventListener("mousedown",onDoc);
  },[]);
  return (
    <div ref={ref} style={{position:"relative",display:"inline-block"}}>
      <button type="button" onClick={()=>setOpen(o=>!o)}
        style={{...s.filterSelect,display:"inline-flex",alignItems:"center",gap:6,paddingRight:22,position:"relative",maxWidth:280}}>
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
        <span style={{position:"absolute",right:7,top:"50%",transform:"translateY(-50%)",fontSize:11,color:"var(--c-muted-2)",pointerEvents:"none"}}>▼</span>
      </button>
      {open&&(
        <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,zIndex:300,background:"var(--c-surface)",border:"1px solid var(--c-border-2)",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,0.10)",minWidth:180,maxWidth:420,maxHeight:300,overflowY:"auto"}}>
          {options.map(o=>{
            const isSel=o.value===value;
            return (
              <div key={String(o.value)} onClick={()=>{onChange(o.value);setOpen(false);}}
                style={{padding:"7px 12px",fontSize:12,fontWeight:isSel?700:500,cursor:"pointer",color:isSel?"var(--c-brand)":"var(--c-text-5)",background:isSel?"var(--c-brand-bg)":"var(--c-surface)",whiteSpace:"normal",wordBreak:"break-word",lineHeight:1.35}}
                onMouseEnter={e=>{if(!isSel)e.currentTarget.style.background="var(--c-hover)";}}
                onMouseLeave={e=>{if(!isSel)e.currentTarget.style.background="var(--c-surface)";}}>
                {o.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function IncomeKpi({title,value,sub,delta,borderTop="var(--c-border-2)",valueColor="var(--c-text)",lang,totalPln}){
  const [plnHover,setPlnHover]=useState(false);
  const [plnPos,setPlnPos]=useState({top:0,left:0});
  const plnRef=useRef();
  useEffect(()=>{
    if(!plnHover) return;
    const updatePos=()=>{
      if(!plnRef.current) return;
      const r=plnRef.current.getBoundingClientRect();
      const POP_W=220;
      const gap=6;
      let left=r.right-POP_W;
      left=Math.max(8, Math.min(left, window.innerWidth-POP_W-8));
      let top=r.bottom+gap;
      setPlnPos({top,left});
    };
    updatePos();
    const onScroll=()=>{ if(plnRef.current) updatePos(); };
    window.addEventListener("scroll",onScroll,true);
    window.addEventListener("resize",onScroll);
    return ()=>{
      window.removeEventListener("scroll",onScroll,true);
      window.removeEventListener("resize",onScroll);
    };
  },[plnHover]);
  return (
    <div style={{
      background:"var(--c-surface)",border:"1px solid var(--c-border-2)",borderTop:`4px solid ${borderTop}`,
      borderRadius:12,padding:"16px 18px",boxShadow:"0 1px 3px rgba(0,0,0,0.04)",
      display:"flex",flexDirection:"column",height:"100%",minHeight:130,position:"relative",
    }}>
      {delta}
      <div style={{fontSize:12,fontWeight:700,color:"var(--c-muted-3)",textTransform:"uppercase",letterSpacing:0.6,paddingRight:delta?60:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{title}</div>
      <div style={{fontSize:22,fontWeight:800,margin:"8px 0 4px",color:valueColor,letterSpacing:-0.5,fontFamily:MONO,whiteSpace:"nowrap"}}>{value}</div>
      <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:10,paddingRight:totalPln>0?KPI_CORNER_PAD:0}}>
        <span>{sub}</span>
      </div>
      {/* Значок PLN — в правом нижнем углу, как «исходные суммы» на остальных
          плашках: одинаковая позиция значков по всей программе. Отступ 12px тот
          же, что у бейджа сравнения сверху, поэтому они стоят в одной колонке.
          Раньше значок стоял в строке с подписью и сдвигал её вбок. */}
      {totalPln > 0 && (
        <div style={s.kpiCorner}>
          <span
            ref={plnRef}
            onMouseEnter={()=>setPlnHover(true)}
            onMouseLeave={()=>setPlnHover(false)}
            style={{cursor:"help",fontSize:12,fontWeight:600,color:"var(--c-warn)",background:"var(--c-warn-bg)",padding:"1px 6px",borderRadius:4,border:"1px solid var(--c-warn-border)",display:"inline-flex",alignItems:"center",gap:3}}
            title={lang==="RU"?"Сумма в злотых (наведите курсор)":"Total in PLN (hover)"}>
            PLN ⬍
          </span>
        </div>
      )}
      {plnHover && totalPln > 0 && createPortal(
        <div
          onMouseEnter={()=>setPlnHover(true)}
          onMouseLeave={()=>setPlnHover(false)}
          style={{position:"fixed",top:plnPos.top,left:plnPos.left,zIndex:9999,background:"var(--c-surface)",border:"1px solid var(--c-border-2)",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,0.12)",padding:"12px 14px",minWidth:220,maxWidth:260}}>
          <div style={{fontSize:11,fontWeight:700,color:"var(--c-muted-2)",textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>
            {lang==="RU"?"Сумма в злотых (Wartość brutto PLN)":"Total in PLN (Wartość brutto PLN)"}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
            <span style={{fontSize:12,color:"var(--c-muted-2)"}}>{lang==="RU"?"За период":"For period"}</span>
            <span style={{fontSize:14,fontWeight:800,color:"var(--c-text)",fontFamily:MONO}}>
              {totalPln.toLocaleString(lang==="RU"?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2})} PLN
            </span>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}


// ── Пагинация в стиле редизайна администрирования ───────────────────────────
// Логика вынесена чистыми функциями (pageWindow / pageRange) не для красоты:
// номера страниц с многоточиями и границы диапазона — это то, что легко сломать
// незаметно, а проверить в браузере нельзя. Их проверяет `npm run check:logic`.

/** Диапазон показанных записей: «Показано 51–100 из 9734». */
export function pageRange(total, limit, offset) {
  if (!total || total <= 0) return { from: 0, to: 0 };
  const from = Math.min(offset + 1, total);
  const to = Math.min(offset + limit, total);
  return { from, to };
}

/**
 * Номера страниц для футера: всегда первая и последняя, вокруг текущей — «span»
 * соседей, а разрывы заменяются на null (многоточие).
 * Пример: (20, 9) → [0, null, 8, 9, 10, null, 19]
 */
export function pageWindow(totalPages, current, span = 1) {
  if (!totalPages || totalPages <= 0) return [];
  const keep = new Set([0, totalPages - 1]);
  for (let i = current - span; i <= current + span; i++) {
    if (i >= 0 && i < totalPages) keep.add(i);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out = [];
  let prev = null;
  for (const p of sorted) {
    if (prev !== null && p - prev > 1) out.push(null);   // разрыв → «…»
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * Футер таблицы: слева «Показано X–Y из Z записей», справа переходы по страницам
 * (Назад · 1 2 3 … N · Вперёд). Раньше переходы стояли в шапке таблицы рядом с
 * фильтрами, и чтобы листнуть список, приходилось возвращаться наверх.
 */
export function Pagination({ total = 0, limit = 50, offset = 0, onChange, lang = "RU", style }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(Math.floor(offset / limit), totalPages - 1);
  const { from, to } = pageRange(total, limit, offset);
  const ru = lang !== "EN";
  if (!total) return null;

  const btn = (extra) => ({
    padding: "6px 12px", borderRadius: 6, border: "1px solid var(--c-border)",
    background: "var(--c-surface)", color: "var(--c-muted)", fontSize: 12, fontWeight: 500,
    cursor: "pointer", fontFamily: "inherit", lineHeight: 1.2, ...extra,
  });
  const goto = (i) => onChange && onChange(Math.max(0, Math.min(totalPages - 1, i)));

  return (
    <div style={{
      padding: "14px 18px", borderTop: "1px solid var(--c-border-3)", background: "var(--c-surface-3)",
      display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between",
      gap: 12, fontSize: 12, color: "var(--c-muted-2)", ...style,
    }}>
      <div>
        {ru ? "Показано" : "Showing"}{" "}
        <b style={{ color: "var(--c-text)" }}>{from}–{to}</b>{" "}
        {ru ? "из" : "of"} <b style={{ color: "var(--c-text)" }}>{total}</b>{" "}
        {ru ? "записей" : "records"}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button type="button" style={btn({ opacity: current === 0 ? 0.45 : 1, cursor: current === 0 ? "default" : "pointer" })}
                onClick={() => current > 0 && goto(current - 1)} disabled={current === 0}>
          {ru ? "Назад" : "Prev"}
        </button>
        {pageWindow(totalPages, current).map((p, i) => (
          p === null
            ? <span key={"g" + i} style={{ padding: "0 4px", color: "var(--c-muted-4)" }}>…</span>
            : <button key={p} type="button" onClick={() => goto(p)}
                      style={p === current
                        ? btn({ background: "var(--c-brand-solid)", borderColor: "var(--c-brand-solid)", color: "var(--c-on-brand)", fontWeight: 700 })
                        : btn({})}>{p + 1}</button>
        ))}
        <button type="button" style={btn({ opacity: current >= totalPages - 1 ? 0.45 : 1, cursor: current >= totalPages - 1 ? "default" : "pointer" })}
                onClick={() => current < totalPages - 1 && goto(current + 1)} disabled={current >= totalPages - 1}>
          {ru ? "Вперёд" : "Next"}
        </button>
      </div>
    </div>
  );
}

/** Заголовок раздела: название + пояснение одной строкой (как в редизайне). */
export function PageHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--c-text)", letterSpacing: "-0.01em" }}>{title}</h1>
      {subtitle && <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--c-muted-2)", lineHeight: 1.45 }}>{subtitle}</p>}
    </div>
  );
}
