import { apiFetch, apiGet, flattenDetail } from "../lib/api.js";
import { fxOutcome, fxErrorMessage, fxIsFatal, backfillSummary, rateActions, parseRateInput, fxAutoSummary, fxOtherSummary, fxAutoNote, mayEnterRate } from "../lib/fxAction.js";
import { s, pill } from "../ui/styles.js";
import { Card, SkeletonRows } from "../ui/components.jsx";
import { MONO, fmtDate } from "../lib/format.js";
import { useCallback, useEffect, useRef, useState } from "react";

// Кнопки действий: три визуальные роли из макета (primary / secondary / danger).
// Держим рядом, чтобы разница между ними была видна в одном месте, а не собиралась
// по цветам в разметке.
const btnBase={padding:"9px 14px",borderRadius:10,cursor:"pointer",fontSize:13,
               fontWeight:600,display:"inline-flex",alignItems:"center",gap:7,
               border:"1px solid transparent",lineHeight:1.2};
const btnPrimaryLg={...btnBase,background:"var(--c-brand-solid)",color:"var(--c-on-brand)"};
const btnSecondaryLg={...btnBase,background:"var(--c-surface-2)",color:"var(--c-text)",
                      borderColor:"var(--c-border)"};
const btnDangerLg={...btnBase,background:"var(--c-danger-bg)",color:"var(--c-danger-strong)",
                   borderColor:"var(--c-danger-border)"};
// Одинаковая высота карточек «Последние курсы» и «EUR-конвертер»: иначе правая
// «висит» короче левой и сетка выглядит неровной.
const FX_CARD_H=360;
/** Страница «Курсы валют».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function FxRatesPage({t,lang,embedded}){
  const [rates,setRates]=useState([]);
  const [currencies,setCurrencies]=useState([]);
  // Валюты архива ЕЦБ: по ним курс приходит сам. Подсказка в форме ручного ввода
  // объясняет это ДО нажатия «Добавить» — иначе непонятно, зачем поле вообще нужно.
  const [ecbCur,setEcbCur]=useState(()=>new Set());
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState("");
  const [flash,setFlash]=useState("");
  const [error,setError]=useState("");
  // Подсказка «что делать дальше» (янтарная, не исчезает сама): если остались
  // транзакции без курса, оператору нужно увидеть это и открыть форму ручного
  // курса ниже, а не прочитать всплывающую строку за 5 секунд.
  const [note,setNote]=useState("");
  // Разбор «по каким валютам и на какие ДАТЫ нет курса» — из него рисуются
  // кнопки подстановки в форму ручного курса.
  const [noRate,setNoRate]=useState([]);
  // Значение курса для массового ввода — по валютам: одно значение на все даты.
  const [bulk,setBulk]=useState({});
  const manualRateRef=useRef(null);
  const [convert,setConvert]=useState({amount:"100",currency:"PLN",date:new Date().toISOString().slice(0,10)});
  const [convertResult,setConvertResult]=useState(null);
  const [convertBusy,setConvertBusy]=useState(false);
  const [convertError,setConvertError]=useState("");
  // Поиск по коду валюты: список длинный (три десятка валют), и без фильтра
  // нужную приходилось искать глазами по всей таблице.
  const [q,setQ]=useState("");
  const [manual,setManual]=useState({currency:"",rate_to_eur:"",rate_date:new Date().toISOString().slice(0,10)});
  const myRole=(typeof window!=="undefined"&&window.__FLEETCOST_ROLE__)||"viewer";
  const isOwner=myRole==="owner";
  // Менеджеру страница доступна целиком — и ручной ввод, и загрузка истории, и
  // пересчёт: на практике это одна и та же работа, а разделение заставляло искать
  // владельца ради одной кнопки. Только viewer остаётся на чтение.
  const canEdit=isOwner||myRole==="manager";
  // Переопределять курс валюты из архива ЕЦБ может только владелец: ручное значение
  // перебивает официальный курс (поиск идёт как «company manual → global ECB») и
  // молча меняет исторические суммы. Проверка есть на сервере, здесь — чтобы не
  // показывать кнопку, которая гарантированно вернёт 403.
  const blockedByRole=manual.currency.length===3
                     &&!mayEnterRate(myRole,manual.currency,ecbCur);
  const msg=(m)=>{setFlash(m);setTimeout(()=>setFlash(""),5000);};
  const errMsg=(m)=>{setError(m);setTimeout(()=>setError(""),5000);};
  // Ответ может быть НЕ JSON: при обрыве по таймауту nginx отдаёт HTML, и
  // `await r.json()` бросал исключение — пользователь видел «Error» вместо
  // причины. Читаем как текст и разбираем мягко.
  const readJson=async(r)=>{ const raw=await r.text(); try{ return JSON.parse(raw); }catch(e){ return null; } };
  // Разбор ответа и текст ошибки — в lib/fxAction.js: это ветвление, а не
  // разметка, и оно одинаково для всех трёх кнопок. Там же разобрано, почему
  // сбой ЕЦБ (HTTP 200 + status:"error") и обрыв по таймауту (502 от nginx)
  // раньше выглядели как успех.
  // Фатальную ошибку показываем красным и говорим «не вышло». Частичный сбой
  // (status:"partial") фатальным не считается: результат показываем, а причину —
  // янтарной подсказкой, потому что работа частично выполнена.
  const failed=(r,d)=>{
    const kind=fxOutcome(r,d);
    if(kind==="ok") return false;
    if(fxIsFatal(kind)){ errMsg(fxErrorMessage(kind,r,d)); return true; }
    setNote(fxErrorMessage(kind,r,d));
    return false;
  };

  const load=useCallback(async()=>{
    setLoading(true);
    const [r,c]=await Promise.all([
      apiGet("/fx-rates/?limit=200"),
      apiGet("/fx-rates/currencies"),
    ]);
    if(r) setRates(r);
    if(c) setCurrencies(c.currencies||[]);
    if(c&&Array.isArray(c.ecb_currencies)) setEcbCur(new Set(c.ecb_currencies));
    setLoading(false);
  },[]);
  useEffect(()=>{load();},[load]);

  const syncToday=async()=>{
    setBusy("today");setError("");
    msg(t.fxSyncStarted);
    try{
      const r=await apiFetch("/fx-rates/sync",{method:"POST"});
      const d=await readJson(r);
      if(failed(r,d)) return;
      // Синхронизация теперь не только грузит курс: бэкенд сразу докачивает
      // недостающие даты и пересчитывает строки. Без этой строки пересчёт
      // выглядел бы как «ничего не произошло».
      const auto=fxAutoSummary(d.auto);
      msg(`✅ ${t.fxTodayBtn}: ${d.stored||0} ${t.fxRowsFor} ${d.rate_date}`+fxOtherSummary(d.other)+(auto?` · ${auto}`:""));
      if(d.auto&&d.auto.remaining){
        setNote(fxAutoNote(d.auto));
        setNoRate(rateActions(d.auto.unrated));
      }
      load();
    }finally{setBusy("");}
  };

  const syncHistorical=async()=>{
    if(!confirm(t.fxConfirmHistory)) return;
    setBusy("historical");setError("");
    msg(t.fxHistLoading);
    try{
      const r=await apiFetch("/fx-rates/sync-historical",{method:"POST"});
      const d=await readJson(r);
      if(failed(r,d)){setFlash("");return;}
      const auto=fxAutoSummary(d.auto);
      msg(`✅ ${t.fxHistDone}: ${d.new_rows||0} new rows, ${d.dates_stored||0} dates, ${d.currencies?.length||0} currencies. ${d.earliest_date} → ${d.latest_date}`+fxOtherSummary(d.other)+(auto?` · ${auto}`:""));
      if(d.auto&&d.auto.remaining){
        setNote(fxAutoNote(d.auto));
        setNoRate(rateActions(d.auto.unrated));
      }
      load();
    }finally{setBusy("");}
  };

  // Ядро пересчёта. Используется и кнопкой, и автоматически — сразу после ввода
  // курса. Автопересчёт нужен потому, что иначе подсказка остаётся со СТАРОЙ датой
  // и непонятно, что делать дальше: приходилось самому догадываться нажать
  // «Пересчитать» и только потом видеть следующую нужную дату. Обход очереди
  // гарантированно завершается (см. backfill_plan), поэтому вызывать его отсюда
  // безопасно.
  const runBackfill=async(prefix)=>{
    const r=await apiFetch("/fx-rates/backfill",{method:"POST"});
    const d=await readJson(r);
    if(failed(r,d)) return null;
    msg((prefix?prefix+" · ":"✅ ")+backfillSummary(d));
    // Подсказка и список дат всегда отражают ТЕКУЩЕЕ состояние, а не то, что было
    // на момент прошлого нажатия.
    setNote(d.note||"");
    setNoRate(rateActions(d.no_rate_detail));
    load();
    return d;
  };

  // Принудительный пересчёт всех строк. Нужен, когда прежние amount_eur
  // посчитаны неверно: до исправления направления курса суммы в иностранной
  // валюте были завышены (~18× для PLN), а обычный пересчёт такие строки не
  // трогает — у них amount_eur не NULL. Дашборд считает по amount_eur, поэтому
  // без этого прохода завышенные расходы так и останутся на экране.
  const forceBackfill=async()=>{
    if(!confirm(t.fxConfirmForce)) return;
    setBusy("force");setError("");setNote("");setNoRate([]);
    msg(t.fxForceStarted);
    try{
      const r=await apiFetch("/fx-rates/backfill?force=true",{method:"POST"});
      const d=await readJson(r);
      if(failed(r,d)) return;
      msg("✅ "+backfillSummary(d));
      setNote(d.note||"");
      setNoRate(rateActions(d.no_rate_detail));
      load();
    }finally{ setBusy(""); }
  };

  const backfill=async()=>{
    if(!confirm(t.fxConfirmBackfill)) return;
    setBusy("backfill");setError("");setNote("");setNoRate([]);
    msg(t.fxBackfillStarted);
    try{ await runBackfill(); }finally{ setBusy(""); }
  };

  // Массовый ввод: ОДНО значение на все нужные даты валюты.
  // Для валют вне архива ЕЦБ (BYN, RSD, UAH…) это и есть нужный сценарий: курса в
  // источнике нет вовсе, а вводить по одной дате бессмысленно — значение всё равно
  // одно. Курс действует 14 дней вперёд, поэтому число дат конечно и невелико.
  const applyBulk=async(item)=>{
    const val=parseRateInput(bulk[item.currency]);
    if(val===null){ errMsg(`${t.fxRateMustBePositive} ${item.currency}`); return; }
    setBusy("bulk");setError("");
    try{
      const r=await apiFetch("/fx-rates/manual-bulk",{method:"POST",body:JSON.stringify({
        currency:item.currency, rate_to_eur:val, dates:item.needed_dates,
      })});
      const d=await readJson(r);
      if(failed(r,d)) return;
      const applied=(d.created||0)+(d.updated||0);
      // Пересчёт выполнен на бэкенде в том же запросе (fx_autoload.auto_finish):
      // отдельный вызов /backfill был бы вторым проходом по тем же строкам.
      const auto=fxAutoSummary(d.auto);
      msg(`✅ ${item.currency}: ${t.fxBulkApplied} ${applied} ${t.fxBulkDatesWord}`+(auto?` · ${auto}`:""));
      if(d.auto&&d.auto.remaining) setNote(fxAutoNote(d.auto));
      setNoRate(rateActions(d.auto&&d.auto.unrated));
      load();
      setBulk({...bulk,[item.currency]:""});
    }finally{ setBusy(""); }
  };

  const addManual=async()=>{
    setBusy("manual");setError("");
    if(!manual.currency||!manual.rate_to_eur||!manual.rate_date){
      setBusy("");errMsg(t.fxFillAllFields);return;
    }
    const savedCurrency=manual.currency.toUpperCase();
    try{
      const r=await apiFetch("/fx-rates/",{
        method:"POST",
        body:JSON.stringify({
          currency:savedCurrency,
          rate_to_eur:parseRateInput(manual.rate_to_eur),
          rate_date:manual.rate_date,
          source:"manual",
        }),
      });
      const resp=await readJson(r);
      if(failed(r,resp)) return;
      setManual({...manual,currency:"",rate_to_eur:""});
      // Пересчёт уже сделан бэкендом в ответе на сохранение курса, и подсказка
      // отражает ТЕКУЩЕЕ состояние: следующая нужная дата видна сразу, а не после
      // ещё одного нажатия «Пересчитать».
      const auto=fxAutoSummary(resp.auto);
      msg(`✅ ${t.fxRateSaved}: ${savedCurrency}`+(auto?` · ${auto}`:""));
      if(resp.auto&&resp.auto.remaining) setNote(fxAutoNote(resp.auto));
      setNoRate(rateActions(resp.auto&&resp.auto.unrated));
      load();
    }finally{ setBusy(""); }
  };

  // Ставит в форму валюту и ИМЕННО ту дату, на которую нет курса. Курс действует
  // на свою дату и 14 дней вперёд, поэтому ввод «на сегодня» старые транзакции не
  // покрывает — на этом пользователь и терялся: курс в списке есть, а пересчёт
  // снова сообщает «без курса».
  const prefillRate=(item)=>{
    setManual({currency:item.currency, rate_date:item.date, rate_to_eur:""});
    setTimeout(()=>{
      manualRateRef.current?.scrollIntoView({block:"center",behavior:"smooth"});
      manualRateRef.current?.focus();
    },0);
  };

  // Результат считается САМ, по мере ввода — кнопку «→» из прежней версии убрали.
  // Курс на дату знает только сервер (там же правило «ближайший рабочий день в
  // пределах 14 дней»), поэтому считаем на сервере, но с задержкой 350 мс после
  // последнего нажатия и с защитой от гонки: ответ на устаревший запрос не должен
  // перетирать более новый (иначе при быстром наборе цифра мигала бы старой).
  const convSeq=useRef(0);
  useEffect(()=>{
    const amount=Number(String(convert.amount).replace(",","."));
    if(!convert.currency||!convert.date||!Number.isFinite(amount)||amount<=0){
      setConvertResult(null); setConvertError(""); setConvertBusy(false); return;
    }
    const seq=++convSeq.current;
    setConvertBusy(true);
    const timer=setTimeout(async()=>{
      try{
        const r=await apiFetch("/fx-rates/convert",{method:"POST",
          body:JSON.stringify({amount,currency:convert.currency.toUpperCase(),date:convert.date})});
        const d=await r.json().catch(()=>({}));
        if(seq!==convSeq.current) return;                  // ответ устарел
        if(!r.ok){setConvertResult(null);setConvertError(flattenDetail(d.detail)||t.fxRateNotFound);}
        else {setConvertResult(d);setConvertError("");}
      }catch(e){
        if(seq===convSeq.current){setConvertResult(null);setConvertError(t.fxServerUnreachable);}
      }finally{
        if(seq===convSeq.current) setConvertBusy(false);
      }
    },350);
    return ()=>clearTimeout(timer);
  },[convert]);

  // Latest rate per currency (most recent date wins)
  const latestByCurrency={};
  for(const r of rates){
    const cur=r.currency;
    if(!latestByCurrency[cur]||new Date(r.rate_date)>new Date(latestByCurrency[cur].rate_date)){
      latestByCurrency[cur]=r;
    }
  }
  const latestList=Object.values(latestByCurrency).sort((a,b)=>a.currency.localeCompare(b.currency));
  const qUp=q.trim().toUpperCase();
  const latestShown=qUp?latestList.filter(r=>r.currency.includes(qUp)):latestList;

  return(
    <div style={s.page}>
      {/* Заголовок печатаем только для отдельного пункта меню: внутри вкладок
          администрирования заголовок раздела рисует AdminPage, иначе он дублируется. */}
      {!embedded&&<h1 style={s.pageTitle}>💱 {t.fxrates}</h1>}
      <p style={{fontSize:13,color:"var(--c-muted-2)",margin:"0 0 16px"}}>
        {t.fxPageSub}
        {!canEdit&&<><br/><span style={{fontSize:12,color:"var(--c-muted-2)"}}>{t.fxViewerNote}</span></>}
      </p>
      {error&&<div style={{background:"var(--c-danger-bg)",color:"var(--c-danger)",padding:"10px 14px",borderRadius:10,marginBottom:14,fontSize:14}}>{error}</div>}
      {flash&&<div style={s.flash}>{flash}</div>}
      {note&&(
        <div style={{...s.warnNote,flexDirection:"column",alignItems:"stretch"}} role="status">
          <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
            <span style={{flex:1}}>{note}</span>
            <button onClick={()=>setNote("")} aria-label={t.fxHideHint}
                    style={{background:"transparent",border:"none",color:"var(--c-warn-strong)",fontSize:14,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
          {/* Ввод курса: владелец и менеджер.
              Менеджеру поля показываем только для валют вне архива ЕЦБ
              (`manual_only`): для PLN и подобных сервер ответит 403, потому что
              ручное значение перебило бы официальный курс. Остальные валюты для
              него перечисляем словами ниже. */}
          {canEdit&&noRate.filter(x=>isOwner||x.manual_only||x.auto).map(x=>(
            <div key={x.currency} style={{display:"flex",gap:8,flexWrap:"wrap",
                                          alignItems:"flex-end",
                                          paddingTop:2,borderTop:"1px solid var(--c-warn-border)"}}>
              {/* Массовый ввод: ОДНО значение на все нужные даты. Для валют вне
                  архива ЕЦБ (BYN, RSD, UAH…) курса в источнике нет вообще, и
                  значение всё равно одно — вводить его по одной дате бессмысленно,
                  тем более что после каждой приходилось нажимать «Пересчитать»,
                  чтобы увидеть следующую. */}
              <div style={{minWidth:150}}>
                <label style={s.label} htmlFor={`fc-bulk-${x.currency}`}>
                  {t.fxBulkRateForAll} {x.currency}
                </label>
                <input id={`fc-bulk-${x.currency}`} type="number" step="0.00000001"
                       style={{...s.input,width:130}} placeholder="0,29"
                       value={bulk[x.currency]||""}
                       onChange={e=>setBulk({...bulk,[x.currency]:e.target.value})}/>
              </div>
              <button style={s.btnPrimary} disabled={!!busy} onClick={()=>applyBulk(x)}
                      title={`${t.fxOneValuePrefix} ${x.needed_dates.length} ${t.fxOneValueSuffix} ${x.needed_dates.map(fmtDate).join(", ")}`}>
                {busy==="bulk"?"⏳ ...":`${t.fxApplyAllDates} (${x.needed_dates.length})`}
              </button>
              <button style={s.btn} disabled={!!busy} onClick={()=>prefillRate(x)}
                      title={x.advice||""}>
                {t.fxEnterManually} {fmtDate(x.date)}
              </button>
            </div>
          ))}
          {/* Валюты, курс которых менеджер переопределять не вправе: поле ввода ему
              не поможет (сервер откажет), поэтому говорим, к кому идти. */}
          {canEdit&&!isOwner&&noRate.some(x=>!x.manual_only&&!x.auto)&&(
            <div style={{fontSize:12,color:"var(--c-warn-strong)",paddingTop:6,
                         borderTop:"1px solid var(--c-warn-border)"}}>
              {noRate.filter(x=>!x.manual_only&&!x.auto).map(x=>x.currency).join(", ")}
              {" — "}{t.fxBlockedOwnerOnly}
            </div>
          )}
        </div>
      )}

      {/* Операции с курсами: владелец и менеджер (viewer — только чтение) */}
      {canEdit&&(
        <Card style={{marginBottom:14}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:260}}>
              <h3 style={s.cardTitle}>{t.fxAutoTitle}</h3>
              <p style={s.cardSub}>{t.fxAutoSub}</p>
            </div>
            <span style={pill("var(--c-surface-2)","var(--c-muted)","var(--c-border)")}>{t.fxSourceEcb}</span>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
            {/* Primary — то, что нужно чаще всего: курс на сегодня. */}
            <button className="fc-btn fc-btn-primary" style={btnPrimaryLg} onClick={syncToday} disabled={!!busy}>
              {busy==="today"?t.fxBusyLoading:t.fxTodayBtn}
            </button>
            <button className="fc-btn fc-btn-secondary" style={btnSecondaryLg} onClick={syncHistorical} disabled={!!busy}>
              {busy==="historical"?t.fxBusyLoading:t.fxHistBtn}
            </button>
            <button className="fc-btn fc-btn-secondary" style={btnSecondaryLg} onClick={backfill} disabled={!!busy}>
              {busy==="backfill"?t.fxBusyRecalc:t.fxBackfillBtn}
            </button>
            {/* Отдельная кнопка, а не галочка: действие редкое и меняет
                исторические суммы, поэтому его нельзя нажать по привычке. */}
            <button className="fc-btn fc-btn-danger" style={btnDangerLg} onClick={forceBackfill} disabled={!!busy}>
              {busy==="force"?t.fxBusyRecalc:t.fxForceBackfillBtn}
            </button>
          </div>
        </Card>
      )}

      {/* Ручной курс: сразу под операциями — это второй по частоте сценарий, и
          раньше он лежал в самом низу страницы, за таблицей и конвертером. */}
      {canEdit&&(
        <Card style={{marginBottom:14}}>
          <h3 style={s.cardTitle}>{t.fxAddManual}</h3>
          <p style={s.cardSub}>
            {isOwner?t.fxManualSubOwner:t.fxManualSubManager}
          </p>
          <div style={{display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap"}}>
            <div>
              <label style={s.label} htmlFor="fc-f-57">{t.fxManualCurrency}</label>
              <input id="fc-f-57" style={{...s.input,width:110,textTransform:"uppercase"}} placeholder="BYN"
                     value={manual.currency} onChange={e=>setManual({...manual,currency:e.target.value.toUpperCase()})}/>
            </div>
            <div>
              <label style={s.label} htmlFor="fc-f-58">{t.fxManualRate}</label>
              <input id="fc-f-58" ref={manualRateRef} type="number" step="0.00000001"
                     style={{...s.input,width:150}} placeholder="0.29"
                     value={manual.rate_to_eur} onChange={e=>setManual({...manual,rate_to_eur:e.target.value})}/>
            </div>
            <div>
              <label style={s.label} htmlFor="fc-f-59">{t.fxManualDate}</label>
              <input id="fc-f-59" type="date" style={{...s.input,width:150}} value={manual.rate_date}
                     onChange={e=>setManual({...manual,rate_date:e.target.value})}/>
            </div>
            {/* Кнопку блокируем ДО запроса: менеджеру сервер всё равно ответит 403 на
                валюту из архива ЕЦБ, и лучше сказать это сразу, чем показывать ошибку
                после нажатия. Правило живёт на сервере — здесь только подсказка. */}
            <button className="fc-btn fc-btn-primary"
                    style={{...btnPrimaryLg,...(blockedByRole?{opacity:.5,cursor:"not-allowed"}:{})}}
                    disabled={blockedByRole} onClick={addManual}>
              {t.fxAdd}
            </button>
          </div>
          {/* Что будет, если ввести этот код: для валют архива ЕЦБ это переопределение
              автоматического курса, для BYN — единственный источник курса вовсе. */}
          <div style={{fontSize:12,marginTop:8,
                       color:(blockedByRole||ecbCur.has(manual.currency.toUpperCase()))
                             ? "var(--c-warn-strong)" : "var(--c-muted-2)"}}>
            {manual.currency.length===3
              ? (blockedByRole
                 ? t.fxCurEcbOwnerOnly
                 : ecbCur.has(manual.currency.toUpperCase()) ? t.fxCurInEcbAuto : t.fxCurManualOnly)
              : t.fxManualDateHint}
          </div>
        </Card>
      )}

      {/* Сетка «Последние курсы» + «EUR-конвертер».
          Обе карточки одной высоты: список курсов больше не растягивает страницу
          вниз (внутренний скролл с липкой шапкой), а конвертер не «висит» короче. */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(340px,1fr))",
                   gap:14,alignItems:"stretch"}}>
        <Card style={{height:FX_CARD_H,display:"flex",flexDirection:"column"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                       gap:10,marginBottom:10,flexWrap:"wrap"}}>
            <h3 style={{...s.cardTitle,margin:0}}>{t.fxRecentRates} ({latestShown.length})</h3>
            <div style={{position:"relative"}}>
              <span aria-hidden="true"
                    style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",
                            fontSize:11,color:"var(--c-muted-3)",pointerEvents:"none"}}>🔍</span>
              <input style={{...s.input,paddingLeft:26,width:150}} placeholder={t.fxSearchPlaceholder}
                     value={q} onChange={e=>setQ(e.target.value)}
                     aria-label={t.fxSearchAria}/>
            </div>
          </div>
          {loading?<SkeletonRows rows={5}/>:latestList.length===0?(
            <div style={s.empty}>{t.fxNoRates}</div>
          ):latestShown.length===0?(
            <div style={s.empty}>{t.fxSearchEmpty} «{q.trim()}»</div>
          ):(
            <div className="fc-scroll"
                 style={{flex:1,minHeight:0,overflowY:"auto",
                         border:"1px solid var(--c-border-3)",borderRadius:10}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr>
                    {/* Липкую шапку делаем на самих ячейках: у <thead> свой фон не
                        перекрывает прокручиваемые строки, и они просвечивали сквозь неё. */}
                    {[t.fxColCurrency,t.fxColRate,t.fxColDate,t.fxColSource].map((h,i)=>(
                      <th key={h} style={{...s.th,position:"sticky",top:0,background:"var(--c-surface-2)",
                                          zIndex:1,textAlign:i===1||i===3?"right":"left"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {latestShown.map(r=>(
                    <tr key={r.currency} className="fc-row-hover" style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                      <td style={s.td}><span style={{fontWeight:700}}>{r.currency}</span></td>
                      <td style={{...s.td,textAlign:"right"}}>
                        <span style={{fontFamily:MONO}}>{Number(r.rate_to_eur).toFixed(6)}</span>
                      </td>
                      <td style={s.td}>
                        <span style={{fontFamily:MONO,fontSize:12,color:"var(--c-muted-2)"}}>{fmtDate(r.rate_date)}</span>
                      </td>
                      <td style={{...s.td,textAlign:"right"}}>
                        <span style={(r.source==="ECB"||r.source==="FRANKFURTER")?pill("var(--c-info-bg-2)","var(--c-sky)","var(--c-info-border-2)")
                                     :r.source==="manual"?pill("var(--c-warn-bg)","var(--c-warn-strong)","var(--c-warn-border)")
                                     :pill("var(--c-surface-2)","var(--c-muted)","var(--c-border)")}>{r.source}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card style={{height:FX_CARD_H,display:"flex",flexDirection:"column"}}>
           <h3 style={{...s.cardTitle,margin:0}}>{t.fxConvert}</h3>
           {/* Отступы заданы явно и перебивают s.cardSub. Базовый стиль подписи
               карточки — `margin:-8px 0 12px`, отрицательный верхний отступ
               прижимает текст к заголовку: в этой карточке подпись длинная, и
               она визуально сливалась с «EUR-конвертер» в одну строку. Здесь
               подпись опущена под заголовок, а увеличенный нижний отступ
               отодвигает вниз и поля (сумма / валюта / дата) — иначе они
               липли к подписи. */}
           <p style={{...s.cardSub,margin:"8px 0 22px"}}>{t.fxConvertSub}</p>
           <div style={{display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap",marginTop:2}}>
            <div>
              <label style={s.label} htmlFor="fc-f-54">{t.fxConvertAmount}</label>
              <input id="fc-f-54" type="number" style={{...s.input,width:96}} value={convert.amount}
                     onChange={e=>setConvert({...convert,amount:e.target.value})}/>
            </div>
            <div>
              <label style={s.label} htmlFor="fc-f-55">{t.fxConvertCur}</label>
              <select id="fc-f-55" style={{...s.input,width:96}} value={convert.currency}
                      onChange={e=>setConvert({...convert,currency:e.target.value})}>
                {currencies.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{flex:1,minWidth:132}}>
              <label style={s.label} htmlFor="fc-f-56">{t.fxConvertDate}</label>
              <input id="fc-f-56" type="date" style={{...s.input,width:"100%"}} value={convert.date}
                     onChange={e=>setConvert({...convert,date:e.target.value})}/>
            </div>
          </div>
          {/* Панель результата прижата к низу карточки: она на месте даже при пустых
              полях, поэтому высота не «дёргается» при вводе. */}
          <div style={{marginTop:"auto",padding:"12px 14px",borderRadius:10,
                       background:convertError?"var(--c-danger-bg)":"var(--c-brand-bg)",
                       border:`1px solid ${convertError?"var(--c-danger-border)":"var(--c-border-2)"}`}}>
            {convertError?(
              <div style={{fontSize:13,color:"var(--c-danger-strong)"}}>⚠ {convertError}</div>
            ):convertResult?(
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                           gap:10,flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:.4,textTransform:"uppercase",
                               color:"var(--c-muted-2)"}}>{t.fxResultLabel}</div>
                  <div style={{fontFamily:MONO,fontWeight:700,fontSize:20}}>
                    {Number(convertResult.amount_eur).toFixed(2)} EUR
                  </div>
                </div>
                <div style={{fontSize:12,fontFamily:MONO,color:"var(--c-muted-2)",textAlign:"right"}}>
                  1 {convertResult.currency} = {Number(convertResult.fx_rate).toFixed(4)} EUR<br/>
                  {fmtDate(convertResult.rate_date)} · {convertResult.source}
                </div>
              </div>
            ):(
              <div style={{fontSize:13,color:"var(--c-muted-2)"}}>
                {convertBusy?t.fxCalculating:t.fxConvertIdle}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
