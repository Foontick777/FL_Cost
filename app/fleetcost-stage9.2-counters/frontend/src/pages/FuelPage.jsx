import { useLocalState } from "../lib/hooks.js";
import { getPeriodDates, getPrevMonthDates } from "../lib/date.js";
import { apiFetch, apiGet, apiMutate, reportUiError } from "../lib/api.js";
import { isFuel } from "../lib/tx.js";
import { sumEurRows, sumToEur } from "../lib/money.js";
import { Card, CurrencyBadge, DeltaBadge, Pagination, PeriodSel, SkeletonRows, SrcFilter, TxFilterBar, TxTable, sortTxns, MissingEurBanner } from "../ui/components.jsx";
import { s, KPI_CORNER_PAD } from "../ui/styles.js";
import { FLAGS } from "../ui/constants.js";
import { MONO } from "../lib/format.js";
import { useEffect, useRef, useState } from "react";
import { fxAutoSummary , fxAutoAction } from "../lib/fxAction.js";
import { useCurrencyList } from "../lib/currencies.js";
/** Страница «Топливо».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function FuelPage({t, lang, icon="⛽", title, filterFn, manualCategory="fuel_manual", period, setPeriod, custom, setCustom, refreshKey=0}){
  const [srcFilter,setSrcFilter]=useLocalState("fc_fuel_srcfilter","");
  // FX-01: валюты — с бэкенда, не захардкоженные (раньше было 4 без CHF/RSD/MDL/GEL)
  const CURRENCIES = useCurrencyList();
  const [txns,setTxns]=useState([]);
  const [prevTxns,setPrevTxns]=useState([]);
  const [loading,setLoading]=useState(false);
  const [mstats,setMstats]=useState(null);
  const [prevMstats,setPrevMstats]=useState(null);
  const [vehicles,setVehicles]=useState([]);
  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}_${refreshKey}`;

  // Pagination
  const [page,setPage]=useState(0);
  // Table filters
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_fuel_vehiclefilter","");
  const [countryFilter,setCountryFilter]=useLocalState("fc_fuel_countryfilter","");
  const [sortMode,setSortMode]=useLocalState("fc_fuel_sortmode","date_desc");

  // Q8 CSV import
  const [q8Up,setQ8Up]=useState(false);
  const [q8Msg,setQ8Msg]=useState("");
  const q8Ref=useRef();

  // Manual fuel entry
  const [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState({expense_date:new Date().toISOString().slice(0,10),plate_number:"",volume:"",amount:"",currency:"BYN",country:"BY",description:lang==="RU"?"Беларусь":"Belarus"});

  // Load vehicles for driver names & manual entry
  useEffect(()=>{ apiGet("/vehicles").then(d=>setVehicles(Array.isArray(d)?d:[])); },[]);
  const driverByPlate=vehicles.reduce((m,v)=>{ if(v.plate_number) m[v.plate_number]=v.driver_name||null; return m; },{});

  const fuelFilterFn = filterFn || (tx => isFuel(tx.fuel_type, tx.source, tx.plate_number));

  const load=async()=>{
    setLoading(true);
    const src=srcFilter?`&source=${srcFilter}`:"";
    const [d, ms] = await Promise.all([
      apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000${src}`),
      apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`)
    ]);
    setTxns(Array.isArray(d)?d.filter(fuelFilterFn):[]);
    setMstats(ms||null);
    setLoading(false);
    // Previous month same-date-range for delta badges
    try{
      const prevDates=getPrevMonthDates(dates.from,dates.to);
      const [pb, pms] = await Promise.all([
        apiGet(`/transactions/?date_from=${prevDates.from}&date_to=${prevDates.to}&limit=50000${src}`),
        apiGet(`/mileage/stats?date_from=${prevDates.from}&date_to=${prevDates.to}`)
      ]);
      setPrevTxns(Array.isArray(pb)?pb.filter(fuelFilterFn):[]);
      setPrevMstats(pms||null);
    }catch(e){setPrevTxns([]);setPrevMstats(null);}
  };
  useEffect(()=>{load();},[datesKey,srcFilter]);

  // Reset page on filter change
  useEffect(()=>{setPage(0);},[datesKey,srcFilter,vehicleFilter,countryFilter,sortMode]);

  // Q8 CSV upload
  const uploadQ8=async(e)=>{
    const file=e.target.files[0];if(!file) return;
    setQ8Up(true);
    const fd=new FormData();fd.append("file",file);
    const r=await apiFetch("/import/q8-csv",{method:"POST",body:fd});
    const d=await r.json();
    setQ8Up(false);
    let parts=[`✅ ${t.importSuccess}: ${d.imported||0}`, `${t.importSkipped}: ${d.skipped||0}`];
    if(d.credit_notes) parts.push(`${t.creditNotes}: ${d.credit_notes}`);
    if(d.cancelled_positives) parts.push(`${t.cancelledPos}: ${d.cancelled_positives}`);
    // Автопересчёт курсов: сколько строк пересчитано и что осталось без курса.
    const fxAuto=fxAutoSummary(d.auto);
    if(fxAuto) parts.push(fxAuto);
    // Если что-то осталось без курса — говорим, куда идти и на какую дату. Для
    // менеджера это его пункт меню «Курсы валют», но только для валют вне архива
    // ЕЦБ: переопределение курса ЕЦБ остаётся за владельцем (см. fxAutoAction).
    const fxAct=fxAutoAction(d.auto);
    if(fxAct) parts.push(fxAct);
    let msg=parts.join(", ");
    if(d.skip_reasons&&d.skip_reasons.length>0){
      msg+=`\n\n${t.skipReasons}\n`+d.skip_reasons.join("\n");
    }
    setQ8Msg(msg);
    setTimeout(()=>setQ8Msg(""),15000);
    q8Ref.current.value="";
    load();
  };

  // Manual entry
  const addManual=async()=>{
    if(!form.amount||!form.volume){
      reportUiError(lang==="RU"?"Заполните сумму и объём":"Enter amount and volume");
      return;
    }
    const r=await apiMutate("/expenses/",{method:"POST",body:JSON.stringify({
      expense_date:form.expense_date, plate_number:form.plate_number||null,
      description:form.description||(lang==="RU"?"Беларусь":"Belarus"), country:form.country||null,
      amount:+form.amount, currency:form.currency, volume:+form.volume, category:manualCategory,
    })});
    if(!r.ok) return;                 // toast reports the reason
    setShowForm(false);
    setForm({expense_date:new Date().toISOString().slice(0,10),plate_number:"",volume:"",amount:"",currency:"BYN",country:"BY",description:lang==="RU"?"Беларусь":"Belarus"});
    load();
  };
  const removeManual=async(id)=>{
    const r=await apiMutate(`/expenses/${id}`,{method:"DELETE"});
    if(!r.ok) return;                     // toast reports the reason
    setTxns(prev=>prev.filter(tx=>tx.id!==id));
  };

  // ── Computations ──
  const allTxns=txns;
  const prevAllTxns=prevTxns;

  // Totals current period
  const byCur=allTxns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const totalEur=sumEurRows(allTxns);
  const totalVol=allTxns.reduce((s,tx)=>s+(tx.volume||0),0);

  // Totals previous period
  const prevByCur=prevAllTxns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const prevTotalEur=sumEurRows(prevAllTxns);
  const prevTotalVol=prevAllTxns.reduce((s,tx)=>s+(tx.volume||0),0);

  // Mileage data
  const mVehicles=mstats?.vehicles||{};
  const fleetKm=mstats?.total_km||0;
  const fleetPer100=fleetKm>0&&totalVol>0?totalVol/fleetKm*100:null;
  // Previous period fleet fuel/100
  const prevFleetKm=prevMstats?.total_km||0;
  const prevFleetVol=prevTotalVol;
  const prevFleetPer100=prevFleetKm>0&&prevFleetVol>0?prevFleetVol/prevFleetKm*100:null;

  // Transaction count by source
  const q8Count=allTxns.filter(tx=>tx.source==="q8").length;
  const e100Count=allTxns.filter(tx=>tx.source==="e100").length;
  const manualCount=allTxns.filter(tx=>tx.source==="manual").length;
  const totalTxCount=allTxns.length;


  // Delta helper
  const pctDelta=(cur,prev)=>{
    if(prev===null||prev===undefined||prev===0||cur===null||cur===undefined) return null;
    return (cur-prev)/Math.abs(prev)*100;
  };
  const totalEurDelta=pctDelta(totalEur,prevTotalEur);
  const totalVolDelta=pctDelta(totalVol,prevTotalVol>0?prevTotalVol:null);
  const fleetPer100Delta=pctDelta(fleetPer100,prevFleetPer100);

  // Per-vehicle stats
  const vehicleFuelMap=allTxns.reduce((m,tx)=>{
    const p=tx.plate_number||"UNKNOWN";
    if(!m[p]) m[p]={liters:0,byCur:{},eur:0,count:0,q8Count:0,e100Count:0,manualCount:0};
    m[p].liters+=(tx.volume||0);
    m[p].byCur[tx.currency]=(m[p].byCur[tx.currency]||0)+tx.amount;
    m[p].eur+=(tx.amount_eur||0);   // исторический курс: см. sumEurRows
    m[p].count++;
    if(tx.source==="q8") m[p].q8Count++;
    else if(tx.source==="e100") m[p].e100Count++;
    else m[p].manualCount++;
    return m;
  },{});

  // Only vehicles with fuel
  const fuelVehiclePlates=Object.keys(vehicleFuelMap).filter(p=>p!=="UNKNOWN").sort();
  const fuelVehicleEntries=fuelVehiclePlates.map(plate=>{
    const vf=vehicleFuelMap[plate];
    const totalEurV=vf.eur;
    const avgPricePerLiter=vf.liters>0?totalEurV/vf.liters:null;
    const kmV=mVehicles[plate]?.km||0;
    const per100V=kmV>0&&vf.liters>0?vf.liters/kmV*100:null;
    const avgFillVolume=vf.count>0?vf.liters/vf.count:null;
    const sharePct=totalVol>0?vf.liters/totalVol*100:0;
    const cardPct=vf.count>0?(vf.q8Count+vf.e100Count)/vf.count*100:0;
    return {plate, ...vf, totalEurV, avgPricePerLiter, kmV, per100V, avgFillVolume, sharePct, cardPct};
  }).sort((a,b)=>b.liters-a.liters);

  // Country stats
  const countryStats=allTxns.reduce((m,tx)=>{
    const c=tx.country||"Unknown";
    if(!m[c]) m[c]={vol:0,byCur:{},eur:0,volByCur:{}};
    m[c].vol+=(tx.volume||0);
    m[c].byCur[tx.currency]=(m[c].byCur[tx.currency]||0)+tx.amount;
    m[c].eur+=(tx.amount_eur||0);
    if(tx.volume>0){
      m[c].volByCur[tx.currency]=(m[c].volByCur[tx.currency]||0)+tx.volume;
    }
    return m;
  },{});

  // Filtered/sorted transactions for table
  const filteredTxns=allTxns.filter(tx=>{
    if(vehicleFilter&&tx.plate_number!==vehicleFilter) return false;
    if(countryFilter&&tx.country!==countryFilter) return false;
    return true;
  });
  const displayTxns=sortTxns(filteredTxns,sortMode);
  // Pagination
  const paginatedTxns=displayTxns.slice(page*FUEL_PAGE_SIZE,(page+1)*FUEL_PAGE_SIZE);
  const totalPages=Math.max(1,Math.ceil(displayTxns.length/FUEL_PAGE_SIZE));

  const availVehicles=[...new Set(allTxns.map(tx=>tx.plate_number).filter(Boolean))].sort();
  const availCountries=[...new Set(allTxns.map(tx=>tx.country).filter(Boolean))].sort();

  const numFmt=n=>(n||0).toLocaleString(lang==="RU"?"ru-RU":"en-US");
  const eurFmt=v=>v.toLocaleString(lang==="RU"?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2});

  // KPI card style (like MileagePage)
  const kpiCard={flex:"0 0 240px",background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"}
  const kpiTitle={fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)"};
  const kpiVal={fontSize:22,fontWeight:700,margin:"8px 0 4px",color:"var(--c-text-3)",whiteSpace:"nowrap"};
  const kpiSub={fontSize:12,color:"var(--c-muted-2)",marginBottom:8,paddingRight:KPI_CORNER_PAD};
  const kpiCorner=s.kpiCorner;

  // Vehicle card metric box
  const metricBox={background:"var(--c-hover)",padding:"8px 12px",borderRadius:10};
  const metricLabel={fontSize:12,color:"var(--c-muted-2)",marginBottom:2,whiteSpace:"nowrap"};
  const metricVal={fontSize:13,fontWeight:600,color:"var(--c-text-3)",whiteSpace:"nowrap"};

  return(
    <div style={{...s.page}} className="fc-content">
      {/* Header */}
      <div className="fc-page-header" style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"nowrap",overflowX:"auto",gap:12,marginBottom:20,paddingBottom:4}}>
        <h1 style={{...s.pageTitle,fontSize:18,whiteSpace:"nowrap"}}>{icon} {title||t.fuel}</h1>
        <div className="fc-header-controls" style={{display:"flex",gap:8,flexWrap:"nowrap",alignItems:"center",flexShrink:0}}>
          <SrcFilter value={srcFilter} onChange={setSrcFilter} t={t}/>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <input ref={q8Ref} type="file" accept=".csv" style={{display:"none"}} onChange={uploadQ8}/>
          <button style={{...s.btn,whiteSpace:"nowrap"}} onClick={()=>q8Ref.current.click()} disabled={q8Up}>
            {q8Up?"⏳ ...":"📥 "+t.importQ8}
          </button>
          <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={()=>setShowForm(v=>!v)}>＋ {t.addFuelManual}</button>
        </div>
      </div>

      {q8Msg&&<div style={{...s.flash,whiteSpace:"pre-line"}}>{q8Msg}</div>}

      {/* Manual fuel form */}
      {showForm&&(
        <Card style={{marginBottom:14}}>
          <h3 style={{margin:"0 0 12px"}}>{t.addFuelManual}</h3>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            <div><label style={s.label} htmlFor="fc-g-1">{t.expenseDate}</label><input id="fc-g-1" type="date" style={s.input} value={form.expense_date} onChange={e=>setForm({...form,expense_date:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-f-1">{t.plate}</label>
              <select id="fc-f-1" style={s.input} value={form.plate_number} onChange={e=>setForm({...form,plate_number:e.target.value})}>
                <option value="">—</option>
                {vehicles.map(v=><option key={v.id} value={v.plate_number}>{v.plate_number} {v.driver_name?`(${v.driver_name})`:""}</option>)}
              </select></div>
            <div><label style={s.label} htmlFor="fc-g-2">{t.volume} ({t.liters})</label><input id="fc-g-2" type="number" style={s.input} value={form.volume} onChange={e=>setForm({...form,volume:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-f-2">{t.country}</label>
              <select id="fc-f-2" style={s.input} value={form.country} onChange={e=>setForm({...form,country:e.target.value})}>
                {["BY","PL","DE","LT","LV","UA","RU"].map(c=><option key={c} value={c}>{FLAGS[c]||"🌍"} {c}</option>)}
              </select></div>
            <div style={{gridColumn:"1/-1"}}><label style={s.label} htmlFor="fc-f-3">{t.station}</label>
              <input id="fc-f-3" style={s.input} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-g-3">{t.amount}</label><input id="fc-g-3" type="number" style={s.input} value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-f-4">{t.currency}</label>
              <select id="fc-f-4" style={s.input} value={form.currency} onChange={e=>setForm({...form,currency:e.target.value})}>
                {CURRENCIES.map(c=><option key={c}>{c}</option>)}
              </select></div>
          </div>
          <div style={{fontSize:12,color:"var(--c-muted-2)",marginTop:6}}>{t.fuelManualHint}</div>
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button style={s.btnPrimary} onClick={addManual}>{t.save}</button>
            <button style={s.btn} onClick={()=>setShowForm(false)}>{t.cancel}</button>
          </div>
        </Card>
      )}

      {/* 4 KPI Cards */}
      <MissingEurBanner rows={allTxns} lang={lang}/>
      <div className="fc-kpi-scroll" style={{display:"grid",gridTemplateColumns:"repeat(4, minmax(180px, 1fr))",gap:12,overflowX:"auto",paddingBottom:12,marginBottom:16}}>
        {/* 1. Total expenses — increase is BAD (red) */}
        <div style={{...kpiCard,position:"relative"}}>
          <DeltaBadge pct={totalEurDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{lang==="RU"?"Итого расходы":"Total expenses"}</div>
          <div style={kpiVal}>{totalEur>0?eurFmt(totalEur)+" EUR":"—"}</div>
          <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
            <span>{lang==="RU"?"За выбранный период":"For the period"}</span>
          </div>
          <div style={{...kpiCorner}}><CurrencyBadge byCur={byCur} lang={lang}/></div>
        </div>
        {/* 2. Total fuel volume — increase is BAD (red) */}
        <div style={{...kpiCard,position:"relative"}}>
          <DeltaBadge pct={totalVolDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{lang==="RU"?"Объём топлива":"Fuel volume"}</div>
          <div style={kpiVal}>{totalVol>0?numFmt(totalVol.toFixed(1))+" л":"—"}</div>
          <div style={kpiSub}>{lang==="RU"?"По всем заправкам флота":"Across all fleet fill-ups"}</div>
        </div>
        {/* 3. Avg fuel per 100 km — increase is BAD (red) */}
        <div style={{...kpiCard,position:"relative"}}>
          <DeltaBadge pct={fleetPer100Delta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{lang==="RU"?"Расход на 100 км":"Fuel / 100 km"}</div>
          <div style={{...kpiVal,color:"var(--c-brand)"}}>{fleetPer100!=null?fleetPer100.toFixed(1)+" л":"—"}</div>
          <div style={kpiSub}>{lang==="RU"?"из факт. заправок / пробега":"from actual fuel / mileage"}</div>
        </div>
        {/* 4. Total transactions — no badge */}
        <div style={kpiCard}>
          <div style={kpiTitle}>{lang==="RU"?"Всего транзакций":"Total transactions"}</div>
          <div style={kpiVal}>{totalTxCount}</div>
          <div style={kpiSub}>Q8: {q8Count} • E100: {e100Count} • {lang==="RU"?"Ручных":"Manual"}: {manualCount}</div>
        </div>
      </div>

      {/* Vehicle cards */}
      <div style={{fontSize:16,fontWeight:600,marginBottom:14,color:"var(--c-text-3)"}}>
        {lang==="RU"?"Сводка по автомобилям":"Vehicle summary"} ({fuelVehicleEntries.length})
      </div>
      <div className="fc-cards-scroll fc-equal-card-grid" style={{display:"flex",gap:16,overflowX:"auto",paddingBottom:12,marginBottom:28}}>
        {!fuelVehicleEntries.length
          ? <div style={s.empty}>{t.noData}</div>
          : fuelVehicleEntries.map(v=>{
            const plateLabel = v.plate;
            const driverName = driverByPlate[v.plate];
            return(
              <div key={v.plate} style={{flex:"0 0 360px",background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:20,boxShadow:"0 2px 4px rgba(0,0,0,0.03)"}}>
                {/* Header: plate + driver | share badge */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:12,borderBottom:"1px solid var(--c-border)",marginBottom:14}}>
                  <span>
                    <span style={{fontSize:16,fontWeight:700,color:"var(--c-text-3)"}}>{plateLabel}</span>
                    {driverName&&<span style={{fontSize:12,color:"var(--c-muted-2)",marginLeft:8}}>{driverName}</span>}
                  </span>
                  <span style={{fontSize:12,fontWeight:700,padding:"3px 8px",borderRadius:6,background:"var(--c-brand-bg-2)",color:"var(--c-brand-strong)"}}>
                    {lang==="RU"?"Доля":"Share"}: {v.sharePct.toFixed(0)}%
                  </span>
                </div>

                {/* Row 1: Заправлено | Сумма расходов */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                  <div style={metricBox}>
                    <div style={metricLabel}>{lang==="RU"?"Заправлено":"Filled"}</div>
                    <div style={metricVal}>{numFmt(v.liters.toFixed(1))} л</div>
                  </div>
                  <div style={metricBox}>
                    <div style={metricLabel}>{lang==="RU"?"Сумма расходов":"Total cost"}</div>
                    <div style={metricVal}>{eurFmt(v.totalEurV)} EUR</div>
                  </div>
                </div>

                {/* Row 2: Ср. цена литра | Ср. расход */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                  <div style={metricBox}>
                    <div style={metricLabel}>{lang==="RU"?"Ср. цена литра":"Avg price/L"}</div>
                    <div style={metricVal}>{v.avgPricePerLiter!=null?v.avgPricePerLiter.toFixed(3)+" EUR/л":"—"}</div>
                  </div>
                  <div style={metricBox}>
                    <div style={metricLabel}>{lang==="RU"?"Ср. расход топлива":"Avg consumption"}</div>
                    <div style={metricVal}>{v.per100V!=null?v.per100V.toFixed(1)+" л / 100 км":"—"}</div>
                  </div>
                </div>

                {/* Row 3: Пробег | Ср. объем заправки */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
                  <div style={metricBox}>
                    <div style={metricLabel}>{lang==="RU"?"Пробег за период":"Mileage"}</div>
                    <div style={metricVal}>{v.kmV>0?numFmt(v.kmV.toFixed(1))+" км":"—"}</div>
                  </div>
                  <div style={metricBox}>
                    <div style={metricLabel}>{lang==="RU"?"Ср. объём заправки":"Avg fill vol."}</div>
                    <div style={metricVal}>{v.avgFillVolume!=null?v.avgFillVolume.toFixed(1)+" л":"—"}</div>
                  </div>
                </div>

                {/* Source ratio progress bar */}
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:600,color:"var(--c-muted-2)",marginBottom:4}}>
                  <span>{lang==="RU"?"Безнал (Карты)":"Cards"}: {v.cardPct.toFixed(0)}%</span>
                  <span>{lang==="RU"?"Ручной":"Manual"}: {(100-v.cardPct).toFixed(0)}%</span>
                </div>
                <div style={{height:6,background:"var(--c-surface-2)",borderRadius:4,overflow:"hidden",display:"flex"}}>
                  <div style={{background:"var(--c-blue-500)",height:"100%",width:`${v.cardPct}%`}}/>
                  <div style={{background:"var(--c-warn-solid)",height:"100%",width:`${100-v.cardPct}%`}}/>
                </div>
              </div>
            );
          })
        }
      </div>

      {/* Country analytics — same as before */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:18}}>
        <Card>
          <h3 style={s.cardTitle}>🌍 {t.byCountry}</h3>
          {Object.keys(countryStats).length?Object.entries(countryStats).map(([country,cs])=>(
            <div key={country} style={s.row}>
              <div>
                <div style={{fontWeight:600}}>{FLAGS[country]||"🌍"} {country}</div>
                <div style={{fontSize:12,color:"var(--c-muted-2)"}}>{cs.vol.toFixed(1)} {t.liters}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:13,fontWeight:700,fontFamily:MONO}}>{cs.eur.toFixed(2)} EUR</div>
                {Object.entries(cs.byCur).map(([c,v])=><div key={c} style={{fontSize:12,color:"var(--c-muted-2)"}}>{v.toFixed(2)} {c}</div>)}
              </div>
            </div>
          )):<div style={s.empty}>—</div>}
        </Card>
        <Card>
          <h3 style={s.cardTitle}>📈 {t.avgPrice}</h3>
          {Object.keys(countryStats).length?Object.entries(countryStats).map(([country,cs])=>{
            const totalEurAmt=cs.eur;
            const avgEur=cs.vol>0?totalEurAmt/cs.vol:0;
            return(
              <div key={country} style={s.row}>
                <span style={{fontWeight:600}}>{FLAGS[country]||"🌍"} {country}</span>
                <div style={{textAlign:"right"}}>
                  {avgEur>0&&<div style={{fontSize:13,fontWeight:700}}>{avgEur.toFixed(4)} EUR/{t.liters}</div>}
                  {Object.entries(cs.byCur).map(([c,amt])=>{
                    const vol=cs.volByCur[c]||0;
                    if(vol<=0) return null;
                    const avg=amt/vol;
                    return<div key={c} style={{fontSize:12,color:"var(--c-muted-2)"}}>{avg.toFixed(4)} {c}/{t.liters}</div>;
                  })}
                </div>
              </div>
            );
          }):<div style={s.empty}>—</div>}
        </Card>
      </div>

      {/* Paginated transaction table */}
      <Card style={{padding:0,overflowX:"auto"}}>
        <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.recentTx} ({displayTxns.length})</h3>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginLeft:"auto"}}>
            <TxFilterBar vehicles={availVehicles} countries={availCountries} embedded
              vehicleFilter={vehicleFilter} setVehicleFilter={setVehicleFilter}
              countryFilter={countryFilter} setCountryFilter={setCountryFilter}
              sortMode={sortMode} setSortMode={setSortMode} t={t}/>
          </div>
        </div>
        {loading?<SkeletonRows rows={6}/>
          :<TxTable txns={paginatedTxns} t={t} showVolume={true} onDeleteManual={removeManual}/>}
        <Pagination total={displayTxns.length} limit={FUEL_PAGE_SIZE} offset={page*FUEL_PAGE_SIZE}
                    onChange={setPage} lang={lang}/>
      </Card>
    </div>
  );
}

const FUEL_PAGE_SIZE = 50;
