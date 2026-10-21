import { useLocalState } from "../lib/hooks.js";
import { apiFetch, apiGet, apiMutate } from "../lib/api.js";
import { fmtDMY, getPeriodDates, getPrevMonthDates } from "../lib/date.js";
import { extractTrailerPlates, isIncome, isManual } from "../lib/tx.js";
import { sumEurRows, sumToEur } from "../lib/money.js";
import { MONO, fmtDate, fmtQty, normalizeCompanyName } from "../lib/format.js";
import { DeltaBadge, IncomeKpi, Pagination, PeriodSel, ShrunkSelect, sortTxns, MissingEurBanner } from "../ui/components.jsx";
import { s } from "../ui/styles.js";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal.jsx";
import { fxAutoSummary , fxAutoAction } from "../lib/fxAction.js";
import { useCurrencyList } from "../lib/currencies.js";
/** Страница «Доходы».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function IncomePage({t,lang,period,setPeriod,custom,setCustom,refreshKey}){
  const [txBatch,setTxBatch]=useState([]);
  // FX-01: валюты — с бэкенда, не захардкоженные (раньше было 6 без CHF/RSD/MDL/GEL)
  const CURRENCIES = useCurrencyList();
  const [stats,setStats]=useState(null);
  const [mileageStats,setMileageStats]=useState(null);
  const [prevTxBatch,setPrevTxBatch]=useState([]);
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_income_vehiclefilter","");        // "" | "assigned" | "unassigned" | plate
  const [companyFilter,setCompanyFilter]=useState("");         // "" | company name
  const [sortMode,setSortMode]=useLocalState("fc_income_sortmode","date_desc");
  const [bindOpenId,setBindOpenId]=useState(null);             // tx.id whose plate dropdown is open
  const [confirmDeleteId,setConfirmDeleteId]=useState(null);    // tx.id awaiting delete confirmation
  const [csvUp,setCsvUp]=useState(false);
  const [csvMsg,setCsvMsg]=useState("");
  const [vehicles,setVehicles]=useState([]);
  const [showAddForm,setShowAddForm]=useState(false);
  const [addForm,setAddForm]=useState({expense_date:new Date().toISOString().slice(0,10),plate_number:"",description:"",amount:"",currency:"EUR"});
  const [page,setPage]=useState(0);
  // Multi-select for bulk delete
  const [selectedIds,setSelectedIds]=useState(new Set());      // selected transaction IDs
  const [bulkConfirm,setBulkConfirm]=useState(false);          // popup open?
  // Purge mode for CSV import: default OFF (UPSERT). When ON, deletes all
  // existing csv_income transactions before importing — use for clean slate.
  const [purgeMode,setPurgeMode]=useState(false);
  // «Очистка» deletes EVERY imported income row of the company. It used to be
  // a single checkbox that took effect immediately; now it can only be armed
  // through an explicit confirmation, and the backend refuses purge=true
  // without confirm_purge=true (so a replayed/edited request can't wipe data).
  const [purgeConfirmOpen,setPurgeConfirmOpen]=useState(false);
  const [purgeWord,setPurgeWord]=useState("");
  const PURGE_WORD=lang==="RU"?"ОЧИСТИТЬ":"PURGE";
  const csvRef=useRef();
  useEffect(()=>{apiGet("/vehicles").then(d=>setVehicles(Array.isArray(d)?d:[]));},[]);
  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}`;
  const periodLbl=`${fmtDMY(dates.from)} — ${fmtDMY(dates.to)}`;

  const load=async()=>{
    const [batch, st, ms] = await Promise.all([
      apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000`),
      apiGet(`/transactions/stats?date_from=${dates.from}&date_to=${dates.to}`),
      apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`),
    ]);
    setTxBatch(Array.isArray(batch)?batch:[]);
    setStats(st||null);
    setMileageStats(ms||null);

    // Previous month same-date-range, for DeltaBadge.
    try{
      const prevDates=getPrevMonthDates(dates.from,dates.to);
      const pb = await apiGet(`/transactions/?date_from=${prevDates.from}&date_to=${prevDates.to}&limit=50000`);
      setPrevTxBatch(Array.isArray(pb)?pb:[]);
    }catch(e){ setPrevTxBatch([]); }
  };
  useEffect(()=>{load();},[datesKey,refreshKey]);
  // Reset pagination when filters or date range change.
  useEffect(()=>{setPage(0);},[datesKey,refreshKey,vehicleFilter,companyFilter,sortMode]);

  // ── Helpers (same logic as DashboardPage) ──
  const EXCLUDED_PLATES=new Set(["TRUCK","Unknown"]);
  const computeIncomeFromBatch=(batch)=>{
    const incomeTx=(batch||[]).filter(tx=>isManual(tx.source)&&isIncome(tx.fuel_type));
    const directTx=incomeTx.filter(tx=>tx.plate_number);
    const unassignedTx=incomeTx.filter(tx=>!tx.plate_number);
    // Исторический курс: тот же источник, что у дашборда (sumEurRows),
    // иначе сумма вкладки расходилась с карточкой «Доходы».
    const total=sumEurRows(incomeTx);
    const direct=sumEurRows(directTx);
    const unassigned=sumEurRows(unassignedTx);
    return {incomeTx,directTx,unassignedTx,total,direct,unassigned};
  };
  const cur=computeIncomeFromBatch(txBatch);
  const prev=computeIncomeFromBatch(prevTxBatch);

  // by-currency breakdown for income (for CurrencyBadge on the "Общий доход" KPI).
  // Shows EUR / PLN / etc. amounts on hover, so the user can verify totals.
  const incomeByCur={};
  cur.incomeTx.forEach(tx=>{incomeByCur[tx.currency]=(incomeByCur[tx.currency]||0)+tx.amount;});
  // Total PLN equivalent — sum of Wartość brutto PLN (stored in Transaction.price
  // during CSV import). This is the user's verification number: the total that
  // should appear in the "Wartość brutto PLN" column of the source CSV for the
  // selected period. Shown on hover over the "Общий доход" KPI badge.
  const totalPln=cur.incomeTx.reduce((s,tx)=>s+(tx.price||0),0);

  // Working vehicles = e100 ∪ Q8 ∪ income-with-plate ∪ mileage by_vehicle.
  // Trailers are excluded — they appear in stats.by_vehicle because they have
  // transactions, but they're NOT vehicles and must not receive income
  // redistribution.
  // ALSO: vehicles that have ONLY leasing/insurance/recurring expenses and no
  // income and no mileage are excluded — they didn't actually work in this
  // period (their expenses get redistributed across truly active vehicles
  // on the dashboard). Without this exclusion, they'd receive a share of the
  // unassigned income, which is wrong.
  const incomeTrailerPlates=extractTrailerPlates(txBatch);
  const incomeDirectPlates=new Set();
  cur.directTx.forEach(tx=>{ if(tx.plate_number) incomeDirectPlates.add(tx.plate_number); });
  const incomeMileagePlates=new Set();
  Object.entries(mileageStats?.by_vehicle||{}).forEach(([p,km])=>{ if(km>0) incomeMileagePlates.add(p); });

  const workingVehicles=new Set();
  (stats?.by_vehicle||[]).forEach(v=>{
    if(EXCLUDED_PLATES.has(v.plate_number)||incomeTrailerPlates.has(v.plate_number)) return;
    if(sumToEur(v.by_currency)<=0) return;
    // Only count as "working" if the vehicle has income OR mileage — otherwise
    // it's a leasing/insurance-only vehicle that didn't actually work.
    if(incomeDirectPlates.has(v.plate_number) || incomeMileagePlates.has(v.plate_number)){
      workingVehicles.add(v.plate_number);
    }
  });
  cur.directTx.forEach(tx=>{ if(tx.plate_number&&!EXCLUDED_PLATES.has(tx.plate_number)&&!incomeTrailerPlates.has(tx.plate_number)) workingVehicles.add(tx.plate_number); });
  Object.entries(mileageStats?.by_vehicle||{}).forEach(([p,km])=>{
    if(!EXCLUDED_PLATES.has(p)&&!incomeTrailerPlates.has(p)&&km>0) workingVehicles.add(p);
  });
  const workingArr=Array.from(workingVehicles).sort();
  const redistPerVehicle=workingArr.length>0?cur.unassigned/workingArr.length:0;

  const vehicleRows=workingArr.map(plate=>{
    const direct=sumEurRows(cur.directTx.filter(tx=>tx.plate_number===plate));
    return {plate, direct, split:redistPerVehicle, total:direct+redistPerVehicle};
  }).sort((a,b)=>b.total-a.total);

  const avgPerVehicle=workingArr.length>0?cur.total/workingArr.length:0;

  // By customer (top-3 + "Прочие")
  const byCompany=new Map();
  cur.incomeTx.forEach(tx=>{
    const name=normalizeCompanyName(tx.station_address);
    const eur=Number(tx.amount_eur||0);   // исторический курс
    const agg=byCompany.get(name)||{eur:0,count:0};
    byCompany.set(name,{eur:agg.eur+eur,count:agg.count+1});
  });
  const companiesSorted=Array.from(byCompany.entries())
    .map(([name,v])=>({name,...v}))
    .sort((a,b)=>b.eur-a.eur);
  const top3=companiesSorted.slice(0,3);
  const rest=companiesSorted.slice(3);
  const restAgg=rest.length>0?{
    name:t.topCustomersRest(rest.length),
    eur:rest.reduce((s,c)=>s+c.eur,0),
    count:rest.reduce((s,c)=>s+c.count,0),
  }:null;
  const customerRows=[...top3, ...(restAgg?[restAgg]:[])];

  // Deltas vs prev period
  const pctDelta=(c,p)=>{
    if(p===null||p===undefined||p===0||c===null||c===undefined) return null;
    return (c-p)/Math.abs(p)*100;
  };
  const incomeDelta=pctDelta(cur.total, prev.total);
  const txDelta=pctDelta(cur.incomeTx.length, prev.incomeTx.length);
  const directDelta=pctDelta(cur.direct, prev.direct);
  const unassignDelta=pctDelta(cur.unassigned, prev.unassigned);
  const avgDelta=pctDelta(avgPerVehicle, workingArr.length>0 && prev.incomeTx.length>0
    ? prev.total/(workingArr.length) // best-effort: same fleet size for prev period
    : null);

  // ── Filters for transaction table ──
  const availCompanies=Array.from(new Set(cur.incomeTx.map(tx=>normalizeCompanyName(tx.station_address)))).sort();
  const filteredTxns=(()=>{
    let arr=cur.incomeTx.slice();
    if(vehicleFilter==="assigned")        arr=arr.filter(tx=>tx.plate_number);
    else if(vehicleFilter==="unassigned") arr=arr.filter(tx=>!tx.plate_number);
    else if(vehicleFilter)                arr=arr.filter(tx=>tx.plate_number===vehicleFilter);
    if(companyFilter)                     arr=arr.filter(tx=>normalizeCompanyName(tx.station_address)===companyFilter);
    return sortTxns(arr, sortMode);
  })();
  // ── Pagination ──
  const totalIncomePages=Math.max(1,Math.ceil(filteredTxns.length/INCOME_PAGE_SIZE));
  const paginatedIncomeTxns=filteredTxns.slice(page*INCOME_PAGE_SIZE,(page+1)*INCOME_PAGE_SIZE);

  const uploadIncomeCSV=async(e)=>{
    const file=e.target.files[0]; if(!file) return;
    setCsvUp(true);
    const fd=new FormData(); fd.append("file",file);
    const r=await apiFetch(`/import/income-csv?purge=${purgeMode?"true":"false"}&confirm_purge=${purgeMode?"true":"false"}`,{method:"POST",body:fd});
    const d=await r.json();
    setCsvUp(false);
    if(!r.ok){
      setCsvMsg(`❌ ${t.importError||"Import error"}: ${d.detail||r.statusText}`);
      setTimeout(()=>setCsvMsg(""),15000);
      csvRef.current.value="";
      return;
    }
    let parts=[`✅ ${t.importSuccess||"Imported"}: ${d.imported||0}`];
    if(d.parser_version) parts.push(`v: ${d.parser_version}`);
    if(d.purged) parts.push(`🗑️ ${lang==="RU"?"Очищено":"Purged"}: ${d.purged}`);
    if(d.updated) parts.push(`${lang==="RU"?"Обновлено":"Updated"}: ${d.updated}`);
    if(d.skipped) parts.push(`${t.importSkipped||"Skipped"}: ${d.skipped}`);
    parts.push(`${lang==="RU"?"Строк":"Rows"}: ${d.total_rows||0}`);
    const fxAuto=fxAutoSummary(d.auto);
    if(fxAuto) parts.push(fxAuto);
    const fxAct=fxAutoAction(d.auto);
    if(fxAct) parts.push(fxAct);
    let msg=parts.join("  ·  ");
    // Monthly breakdown — lets the user verify per-month counts match their CSV
    if(d.monthly_breakdown && Object.keys(d.monthly_breakdown).length>0){
      const months=Object.keys(d.monthly_breakdown).sort();
      msg+=`\n\n${lang==="RU"?"По месяцам (Data sprzedaży)":"By month (Data sprzedaży)"}:`;
      for(const m of months){
        const mb=d.monthly_breakdown[m];
        msg+=`\n  ${m}: ${mb.count} ${lang==="RU"?"транз":"txns"}`;
        if(mb.pln>0) msg+=`, ${mb.pln.toFixed(2)} PLN`;
      }
    }
    if(d.skip_reasons&&d.skip_reasons.length>0){
      msg+=`\n\n${t.skipReasons||"Skip reasons"}:\n`+d.skip_reasons.slice(0,20).join("\n");
    }
    setCsvMsg(msg);
    setTimeout(()=>setCsvMsg(""),60000);  // 60s — user needs time to read the breakdown
    csvRef.current.value="";

    // NOTE: the post-import "Проверка БД" block was removed. It called
    // GET /transactions/debug-income (which now returns 404 outside
    // development) and dumped up to 10 real income transactions — amounts,
    // customers, invoice numbers — into the browser console.
    load();
  };

  const remove=async(id)=>{
    const r=await apiMutate(`/expenses/${id}`,{method:"DELETE"});
    if(!r.ok) return;                     // toast reports the reason
    setTxBatch(prev=>prev.filter(tx=>tx.id!==id));
    setBindOpenId(null);
    setConfirmDeleteId(null);
    // Clean up selection state for the deleted tx id
    setSelectedIds(prev=>{const n=new Set(prev);n.delete(id);return n;});
  };

  // ── Multi-select helpers ──
  const toggleSelect=(id)=>{
    setSelectedIds(prev=>{
      const n=new Set(prev);
      if(n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  // Select / deselect all transactions currently visible in the filtered list
  const allFilteredIds=filteredTxns.map(tx=>tx.id);
  const allSelected=allFilteredIds.length>0 && allFilteredIds.every(id=>selectedIds.has(id));
  const toggleSelectAll=()=>{
    if(allSelected){
      // Deselect all in current filter
      setSelectedIds(prev=>{
        const n=new Set(prev);
        allFilteredIds.forEach(id=>n.delete(id));
        return n;
      });
    }else{
      // Select all in current filter
      setSelectedIds(prev=>{
        const n=new Set(prev);
        allFilteredIds.forEach(id=>n.add(id));
        return n;
      });
    }
  };
  const bulkDelete=async()=>{
    const ids=Array.from(selectedIds);
    if(!ids.length) return;
    const r=await apiMutate("/expenses/bulk-delete",{method:"POST",body:JSON.stringify({ids})});
    if(!r.ok) return;                     // keep the selection so a retry is possible
    const idSet=new Set(ids);
    setTxBatch(prev=>prev.filter(tx=>!idSet.has(tx.id)));
    setSelectedIds(new Set());
    setBulkConfirm(false);
  };

  const assignPlate=async(id,plate)=>{
    const r=await apiMutate(`/expenses/${id}`,{method:"PATCH",body:JSON.stringify({plate_number:plate})});
    if(!r.ok) return;                     // toast reports the reason
    setTxBatch(prev=>prev.map(tx=>tx.id===id?{...tx,plate_number:plate||null}:tx));
    setBindOpenId(null);
  };

  const addIncome=async()=>{
    if(!addForm.description||!addForm.amount) return;
    const r=await apiFetch("/expenses/",{method:"POST",body:JSON.stringify({
      expense_date:addForm.expense_date,
      plate_number:addForm.plate_number||null,
      description:addForm.description,
      amount:+addForm.amount,
      currency:addForm.currency,
      category:"income_freight",
    })});
    if(r.ok){
      setShowAddForm(false);
      setAddForm({expense_date:new Date().toISOString().slice(0,10),plate_number:"",description:"",amount:"",currency:"EUR"});
      load();
    }
  };

  const eurFmt=(v)=>v.toLocaleString(lang==="RU"?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+" EUR";
  const eurShort=(v)=>v.toLocaleString(lang==="RU"?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+" EUR";
  const progressColors=["var(--c-brand-500)","var(--c-blue-500)","var(--c-emerald-500)","var(--c-muted-2)"];

  return (
    <div style={{...s.page}}>
      {/* HEADER */}
      <div className="fc-page-header" style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"nowrap",overflowX:"auto",gap:12,marginBottom:20,paddingBottom:4}}>
        <h1 style={{...s.pageTitle,fontSize:18,whiteSpace:"nowrap"}}>📈 {t.incomeTitle}</h1>
        <div className="fc-header-controls" style={{display:"flex",gap:8,flexWrap:"nowrap",alignItems:"center",flexShrink:0}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <input ref={csvRef} type="file" accept=".csv" style={{display:"none"}} onChange={uploadIncomeCSV}/>
          <label title={lang==="RU"?"Если включено — перед импортом будут удалены ВСЕ старые доходы из CSV. Используйте только для полной очистки (например, после обновления парсера). При выключенном режиме (по умолчанию) существующие транзакции обновляются, новые добавляются, а те которых нет в CSV — остаются нетронутыми.":"When enabled, ALL existing CSV income transactions are deleted before importing. Use only for a clean slate (e.g. after parser upgrade). When disabled (default), existing transactions are updated, new ones are inserted, and transactions not in the CSV are left untouched."} style={{display:"flex",alignItems:"center",gap:4,fontSize:12,color:purgeMode?"var(--c-danger)":"var(--c-muted-2)",cursor:"pointer",whiteSpace:"nowrap",userSelect:"none"}}>
            <input type="checkbox" checked={purgeMode}
                   onChange={e=>{
                     if(e.target.checked){ setPurgeWord(""); setPurgeConfirmOpen(true); }
                     else setPurgeMode(false);
                   }}
                   style={{width:14,height:14,cursor:"pointer",accentColor:"var(--c-danger)"}}/>
            {lang==="RU"?"Очистка":"Purge"}
          </label>
          <button style={{...s.btn,whiteSpace:"nowrap"}} onClick={()=>csvRef.current.click()} disabled={csvUp}>
            {csvUp?"⏳ ...":t.importIncomeCsv}
          </button>
          <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={()=>setShowAddForm(true)}>
            {t.addIncomeBtn}
          </button>
        </div>
      </div>
      {csvMsg&&<div style={s.flash}>{csvMsg}</div>}

      {/* ADD INCOME MODAL */}
      {showAddForm&&<Modal onClose={()=>setShowAddForm(false)} maxWidth={560} backdropStyle={{padding:"80px 16px 16px"}} label={t.addIncomeBtn}>
            <h3 style={{margin:"0 0 14px",fontSize:16,fontWeight:700,color:"var(--c-text)"}}>{t.addIncomeBtn}</h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <div>
                <label style={s.label} htmlFor="fc-f-60">{t.expenseDate}</label>
                <input id="fc-f-60" type="date" style={s.input} value={addForm.expense_date} onChange={e=>setAddForm({...addForm,expense_date:e.target.value})}/>
              </div>
              <div>
                <label style={s.label} htmlFor="fc-f-61">{t.plate}</label>
                <select id="fc-f-61" style={s.input} value={addForm.plate_number} onChange={e=>setAddForm({...addForm,plate_number:e.target.value})}>
                  <option value="">— {t.noVehicle} —</option>
                  {vehicles.map(v=><option key={v.id} value={v.plate_number}>{v.plate_number}{v.driver_name?` (${v.driver_name})`:""}</option>)}
                </select>
              </div>
              <div style={{gridColumn:"1/-1"}}>
                <label style={s.label} htmlFor="fc-f-62">{t.companyCol}</label>
                <input id="fc-f-62" style={s.input} placeholder={t.companyCol} value={addForm.description} onChange={e=>setAddForm({...addForm,description:e.target.value})}/>
              </div>
              <div>
                <label style={s.label} htmlFor="fc-f-63">{t.amount}</label>
                <input id="fc-f-63" type="number" step="0.01" style={s.input} value={addForm.amount} onChange={e=>setAddForm({...addForm,amount:e.target.value})}/>
              </div>
              <div>
                <label style={s.label} htmlFor="fc-f-64">{t.currency}</label>
                <select id="fc-f-64" style={s.input} value={addForm.currency} onChange={e=>setAddForm({...addForm,currency:e.target.value})}>
                  {CURRENCIES.map(c=><option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:16,justifyContent:"flex-end"}}>
              <button style={s.btn} onClick={()=>setShowAddForm(false)}>{t.cancel}</button>
              <button style={s.btnPrimary} onClick={addIncome}>{t.save}</button>
            </div>
          </Modal>}

      {/* 5 KPI CARDS — horizontal scroll, "Всего транзакций" moved to the end */}
      <MissingEurBanner rows={txBatch.filter(tx=>isManual(tx.source)&&isIncome(tx.fuel_type))} lang={lang}/>
      <div className="fc-kpi-scroll" style={{display:"flex",gap:14,marginBottom:18,overflowX:"auto",paddingBottom:10}}>
        {/* 1. Общий доход — wider (so EUR doesn't wrap), keep delta badge */}
        <div style={{flex:"0 0 240px"}}>
          <IncomeKpi title={t.totalIncomeFull} borderTop="var(--c-emerald-500)" value={eurFmt(cur.total)}
            sub={`${periodLbl} · ${cur.incomeTx.length} ${t.transactions}`}
            delta={<DeltaBadge pct={incomeDelta} absolute/>} valueColor="var(--c-emerald)"
            lang={lang} totalPln={totalPln}/>
        </div>
        {/* 2. Прямые доходы (с авто) — NO delta badge */}
        <div style={{flex:"0 0 200px"}}>
          <IncomeKpi title={t.directIncome} borderTop="var(--c-emerald-500)" value={eurFmt(cur.direct)}
            sub={t.directIncomeSub(cur.total>0?(cur.direct/cur.total*100).toFixed(1):"0.0", cur.directTx.length)}
            delta={null} valueColor="var(--c-emerald-strong)"/>
        </div>
        {/* 3. Нераспределённый доход — NO delta badge */}
        <div style={{flex:"0 0 200px"}}>
          <IncomeKpi title={t.unassignedIncome} borderTop="var(--c-warn-solid)" value={eurFmt(cur.unassigned)}
            sub={t.unassignedIncomeSub(cur.unassignedTx.length)}
            delta={null} valueColor="var(--c-warn)"/>
        </div>
        {/* 4. Ср. выручка на 1 авто — NO delta badge */}
        <div style={{flex:"0 0 220px"}}>
          <IncomeKpi title={t.avgIncomePerVehicle} borderTop="var(--c-brand-500)" value={eurFmt(avgPerVehicle)}
            sub={t.avgIncomeSub(workingArr.length, periodLbl)}
            delta={null} valueColor="var(--c-brand)"/>
        </div>
        {/* 5. Всего транзакций — moved to the end (rightmost), no badge */}
        <div style={{flex:"0 0 190px"}}>
          <IncomeKpi title={t.txCountFull} borderTop="var(--c-brand-500)" value={String(cur.incomeTx.length)}
            sub={t.txCountSub(eurFmt(cur.total/Math.max(1,cur.directTx.length)))}
            delta={null}/>
        </div>
      </div>

      {/* AUTO-ALLOCATION BANNER */}
      {cur.unassigned>0.01 && workingArr.length>0 && (
        <div style={{
          background:"var(--c-info-bg)", border:"1px solid var(--c-info-border)", borderRadius:12,
          padding:"12px 16px", marginBottom:14,
          display:"flex", alignItems:"flex-start", gap:8,
        }}>
          <span style={{fontSize:16,flexShrink:0,lineHeight:1.4}}>⚙️</span>
          <span style={{fontSize:13, color:"var(--c-info)", lineHeight:1.4, wordBreak:"break-word", overflowWrap:"anywhere"}}>
            <strong>{t.autoAllocTitle}:</strong>{" "}
            {t.autoAllocBanner(eurFmt(cur.unassigned), workingArr.length, eurFmt(redistPerVehicle), periodLbl)}
          </span>
        </div>
      )}

      {/* ANALYTICS GRID: Customers | Vehicle Revenue */}
      <div style={{display:"grid",gridTemplateColumns:"1.05fr 1.25fr",gap:18,marginBottom:24}}>
        {/* LEFT — Customers */}
        <div style={{background:"var(--c-surface)",borderRadius:14,padding:20,border:"1px solid var(--c-border-2)",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <span style={{fontSize:12,fontWeight:700,color:"var(--c-text)",textTransform:"uppercase",letterSpacing:0.6}}>🏢 {t.incomeByCustomers}</span>
            <span style={{fontSize:12,color:"var(--c-muted-3)"}}>{t.incomeByCustomersSub}</span>
          </div>
          {!customerRows.length
            ? <div style={s.empty}>{t.noData}</div>
            : <div style={{display:"flex",flexDirection:"column",gap:14}}>
              {customerRows.map((c,idx)=>{
                const pct=cur.total>0?(c.eur/cur.total*100):0;
                const color=progressColors[Math.min(idx,progressColors.length-1)];
                const isRest=idx>=3;
                return (
                  <div key={c.name} style={{
                    display:"flex", justifyContent:"space-between", alignItems:"center",
                    paddingBottom:14,
                    borderBottom: idx<customerRows.length-1?"1px solid var(--c-surface-2)":"none",
                  }}>
                    <div style={{flex:1,marginRight:16}}>
                      <div style={{fontWeight:700,fontSize:14,color:isRest?"var(--c-muted)":"var(--c-text)"}}>{c.name}</div>
                      <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:6}}>{t.customerTxCount(c.count)}</div>
                      <div style={{width:"100%",background:"var(--c-surface-2)",height:6,borderRadius:3,overflow:"hidden"}}>
                        <div style={{height:"100%",background:color,borderRadius:3,width:`${pct.toFixed(2)}%`,transition:"width 0.4s ease"}}/>
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontWeight:700,fontSize:14,color:"var(--c-text)"}}>{eurFmt(c.eur)}</div>
                      <div style={{fontSize:12,color:"var(--c-muted-2)"}}>{pct.toFixed(1)}%</div>
                    </div>
                  </div>
                );
              })}
            </div>}
        </div>

        {/* RIGHT — Vehicle Revenue */}
        <div style={{background:"var(--c-surface)",borderRadius:14,padding:20,border:"1px solid var(--c-border-2)",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <span style={{fontSize:12,fontWeight:700,color:"var(--c-text)",textTransform:"uppercase",letterSpacing:0.6}}>🚛 {t.revenueByVehicle}</span>
            <span style={{fontSize:12,color:"var(--c-muted-2)"}}>{t.revenueByVehicleSub(workingArr.length)}</span>
          </div>
          {!vehicleRows.length
            ? <div style={s.empty}>{t.noData}</div>
            : <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
              <thead>
                <tr style={s.theadBand}>
                  <th style={vehTh}>{t.colPlate}</th>
                  <th style={vehTh}>{t.colDirectIncome}</th>
                  <th style={vehTh}>{t.colSplit}</th>
                  <th style={{...vehTh,textAlign:"right"}}>{t.colTotal}</th>
                </tr>
              </thead>
              <tbody>
                {vehicleRows.map(r=>(
                  <tr key={r.plate} style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                    <td style={vehTd}>
                      <span style={{background:"var(--c-surface-2)",color:"var(--c-text)",fontWeight:700,padding:"2px 8px",borderRadius:6,fontSize:12}}>{r.plate}</span>
                    </td>
                    <td style={vehTd}>{eurFmt(r.direct)}</td>
                    <td style={{...vehTd,color:"var(--c-emerald)",fontWeight:600}}>+{eurShort(r.split).replace(" EUR","")} EUR</td>
                    <td style={{...vehTd,textAlign:"right",fontWeight:700,color:"var(--c-text)"}}>{eurFmt(r.total)}</td>
                  </tr>
                ))}
                {/* "Без авто" — orange row */}
                <tr style={{background:"var(--c-warn-bg-2)",borderBottom:"none"}}>
                  <td style={{...vehTd,paddingTop:14}}>
                    <span style={{background:"var(--c-warn-bg)",color:"var(--c-warn)",fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12}}>{t.rowUnassigned}</span>
                  </td>
                  <td style={{...vehTd,color:"var(--c-warn)",fontWeight:600,paddingTop:14}}>{eurFmt(cur.unassigned)}</td>
                  <td style={{...vehTd,color:"var(--c-warn)",paddingTop:14}}>−{eurShort(cur.unassigned).replace(" EUR","")} EUR</td>
                  <td style={{...vehTd,textAlign:"right",fontWeight:700,color:"var(--c-muted-2)",paddingTop:14}}>{eurFmt(0)}</td>
                </tr>
              </tbody>
            </table>}
        </div>
      </div>

      {/* DETAILED TRANSACTIONS TABLE */}
      <div style={{background:"var(--c-surface)",borderRadius:14,border:"1px solid var(--c-border-2)",boxShadow:"0 1px 3px rgba(0,0,0,0.04)",overflow:"hidden"}}>
        <div style={{padding:"16px 20px",borderBottom:"1px solid var(--c-border-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <div style={{fontWeight:700,fontSize:15,color:"var(--c-text)"}}>{t.allIncomeTx} ({filteredTxns.length})</div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
            <ShrunkSelect
              value={vehicleFilter}
              onChange={setVehicleFilter}
              placeholder={t.filterAllVehicles}
              options={[
                {value:"", label:t.filterAllVehicles},
                {value:"assigned", label:t.filterAssigned},
                {value:"unassigned", label:t.filterUnassigned},
                ...workingArr.map(p=>({value:p, label:p})),
              ]}
            />
            <ShrunkSelect
              value={companyFilter}
              onChange={setCompanyFilter}
              placeholder={t.filterAllCustomers}
              options={[
                {value:"", label:t.filterAllCustomers},
                ...availCompanies.map(c=>({value:c, label:c})),
              ]}
            />
            <ShrunkSelect
              value={sortMode}
              onChange={setSortMode}
              options={[
                {value:"date_desc", label:t.sortDateDesc},
                {value:"date_asc", label:t.sortDateAsc},
                {value:"amount_desc", label:t.sortAmountDesc},
                {value:"amount_asc", label:t.sortAmountAsc},
              ]}
            />
            {/* Bulk delete button — only visible when at least one row is selected */}
            {selectedIds.size>0 && (
              <button
                onClick={()=>setBulkConfirm(true)}
                title={t.bulkDeleteBtn}
                style={{padding:"6px 12px",fontSize:12,fontWeight:600,border:"1px solid var(--c-danger-border)",borderRadius:6,background:"var(--c-danger-bg)",color:"var(--c-danger)",cursor:"pointer",whiteSpace:"nowrap"}}>
                {t.bulkDeleteBtn} ({selectedIds.size})
              </button>
            )}
          </div>
        </div>
        {!filteredTxns.length
          ? <div style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>{t.noData}</div>
          : <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",textAlign:"left",fontSize:12,minWidth:900}}>
              <thead>
                <tr style={s.theadBand}>
                  <th style={{...s.th,width:40,whiteSpace:"nowrap"}}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      title={t.bulkDeleteTitle}
                      style={{width:16,height:16,cursor:"pointer",accentColor:"var(--c-danger)",verticalAlign:"middle"}}
                    />
                  </th>
                  <th style={s.th}>{t.date}</th>
                  <th style={s.th}>{t.plate}</th>
                  <th style={s.th}>{t.companyCol}</th>
                  <th style={s.th}>{t.colStatus}</th>
                  <th style={s.th}>{t.amount}</th>
                  <th style={{...s.th,textAlign:"right",whiteSpace:"nowrap"}}>{t.actions}</th>
                </tr>
              </thead>
              <tbody>
                {paginatedIncomeTxns.map(tx=>{
                  const unassigned=!tx.plate_number;
                  const isBindOpen=bindOpenId===tx.id;
                  const isConfirm=confirmDeleteId===tx.id;
                  const isChecked=selectedIds.has(tx.id);
                  return (
                    <tr key={tx.id} style={{borderBottom:"1px solid var(--c-border-2)",background:isChecked?"var(--c-danger-bg)":"transparent"}}>
                      <td style={{...s.td,textAlign:"center"}}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={()=>toggleSelect(tx.id)}
                          title={t.bulkDeleteTitle}
                          style={{width:16,height:16,cursor:"pointer",accentColor:"var(--c-danger)",verticalAlign:"middle"}}
                        />
                      </td>
                      <td style={{...s.td,whiteSpace:"nowrap"}}>{fmtDate(tx.transaction_date)}</td>
                      <td style={{...s.td,whiteSpace:"nowrap"}}>
                        {tx.plate_number
                          ? <span style={{background:"var(--c-surface-2)",color:"var(--c-text)",fontWeight:700,padding:"2px 8px",borderRadius:6,fontSize:12}}>{tx.plate_number}</span>
                          : <span style={{color:"var(--c-muted-2)"}}>—</span>}
                      </td>
                      <td style={{...s.td,fontWeight:700}}>{tx.station_address||"—"}</td>
                      <td style={{...s.td,whiteSpace:"nowrap"}}>
                        {unassigned
                          ? <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                              <span style={{background:"var(--c-warn-bg-2)",color:"var(--c-warn)",fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12,display:"inline-flex",alignItems:"center",gap:4}}>{t.badgeUnassigned}</span>
                              {tx.driver_name && (
                                <span title={tx.driver_name} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:16,height:16,borderRadius:"50%",background:"var(--c-border-2)",color:"var(--c-muted-2)",fontSize:11,fontWeight:700,cursor:"help",flexShrink:0}}>i</span>
                              )}
                            </span>
                          : <span style={{background:"var(--c-success-bg)",color:"var(--c-success)",fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12,display:"inline-flex",alignItems:"center",gap:4}}>{t.badgeAssigned}</span>}
                      </td>
                      <td style={{...s.td,whiteSpace:"nowrap"}}>
                        <div style={{color:tx.amount<0?"var(--c-danger)":"var(--c-emerald-strong)",fontWeight:700,fontFamily:MONO}}>
                          {tx.amount>=0?"+":""}{fmtQty(tx.amount,2)} {tx.currency}
                        </div>
                        {tx.price ? (
                          <div style={{fontSize:11,color:"var(--c-muted-2)",fontWeight:400,marginTop:2,fontFamily:MONO}}>
                            {tx.price.toFixed(2)} PLN
                          </div>
                        ) : null}
                      </td>
                      <td style={{...s.td,textAlign:"right",whiteSpace:"nowrap"}}>
                        <div style={{display:"inline-flex",alignItems:"center",gap:6,position:"relative",justifyContent:"flex-end"}}>
                          {/* Default state: link button (unassigned only) + red X */}
                          {!isConfirm && !isBindOpen && (
                            <>
                              {unassigned && (
                                <button
                                  onClick={()=>setBindOpenId(tx.id)}
                                  style={{padding:"5px 10px",fontSize:12,fontWeight:600,border:"1px solid var(--c-border-2)",borderRadius:6,background:"var(--c-surface)",color:"var(--c-text-5)",cursor:"pointer",whiteSpace:"nowrap"}}>
                                  {t.actionLink}
                                </button>
                              )}
                              <button
                                onClick={()=>setConfirmDeleteId(tx.id)}
                                title={t.actionDelete}
                                style={{padding:0,width:22,height:22,fontSize:12,fontWeight:700,border:"1px solid var(--c-danger-border)",borderRadius:6,background:"var(--c-surface)",color:"var(--c-danger)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>
                                ✕
                              </button>
                            </>
                          )}
                          {/* Bind dropdown (unassigned only) */}
                          {isBindOpen && (
                            <div style={{position:"absolute",top:"calc(100% + 4px)",right:0,zIndex:200,background:"var(--c-surface)",border:"1px solid var(--c-border-2)",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,0.10)",minWidth:200,maxHeight:260,overflowY:"auto"}}>
                              <div style={{padding:"6px 10px",fontSize:11,color:"var(--c-muted-2)",fontWeight:700,textTransform:"uppercase",letterSpacing:0.5,borderBottom:"1px solid var(--c-surface-2)"}}>{t.bindVehicleHint}</div>
                              {workingArr.length===0 && <div style={{padding:"8px 10px",fontSize:12,color:"var(--c-muted-2)"}}>{t.noData}</div>}
                              {workingArr.map(p=>(
                                <div key={p} onClick={()=>assignPlate(tx.id,p)} style={{padding:"7px 12px",fontSize:12,fontWeight:600,cursor:"pointer",color:"var(--c-text)",background:"var(--c-surface)"}}
                                  onMouseEnter={e=>e.currentTarget.style.background="var(--c-surface-2)"}
                                  onMouseLeave={e=>e.currentTarget.style.background="var(--c-surface)"}>
                                  <span style={{background:"var(--c-surface-2)",color:"var(--c-text)",fontWeight:700,padding:"2px 8px",borderRadius:6,fontSize:12}}>{p}</span>
                                </div>
                              ))}
                              <div onClick={()=>setBindOpenId(null)} style={{padding:"7px 12px",fontSize:12,fontWeight:600,cursor:"pointer",color:"var(--c-muted-3)",borderTop:"1px solid var(--c-surface-2)",textAlign:"center"}}>{t.cancel}</div>
                            </div>
                          )}
                          {/* Inline delete confirmation */}
                          {isConfirm && (
                            <div style={{display:"inline-flex",alignItems:"center",gap:8,padding:"4px 8px",background:"var(--c-danger-bg)",border:"1px solid var(--c-danger-border)",borderRadius:8,whiteSpace:"nowrap"}}>
                              <span style={{fontSize:12,fontWeight:600,color:"var(--c-danger-strong)"}}>{t.deleteConfirm}</span>
                              <button
                                onClick={()=>remove(tx.id)}
                                title={t.save}
                                style={{padding:0,width:22,height:22,fontSize:13,fontWeight:700,border:"1px solid var(--c-success-solid)",borderRadius:6,background:"var(--c-success-bg)",color:"var(--c-success)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>
                                ✓
                              </button>
                              <button
                                onClick={()=>setConfirmDeleteId(null)}
                                title={t.cancel}
                                style={{padding:0,width:22,height:22,fontSize:13,fontWeight:700,border:"1px solid var(--c-danger)",borderRadius:6,background:"var(--c-danger-bg-2)",color:"var(--c-danger-strong)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>
                                ⊘
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}
      </div>

      {/* Переходы по страницам — под списком, как в остальных таблицах */}
      <Pagination total={filteredTxns.length} limit={INCOME_PAGE_SIZE} offset={page*INCOME_PAGE_SIZE}
                  onChange={setPage} lang={lang}/>

      {/* BULK DELETE CONFIRMATION POPUP */}
      {bulkConfirm && <Modal onClose={()=>setBulkConfirm(false)} align="center" maxWidth={420} label={t.bulkDeleteTitle}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
              <div style={{width:40,height:40,borderRadius:"50%",background:"var(--c-danger-bg)",color:"var(--c-danger)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:700,flexShrink:0}}>✕</div>
              <div style={{fontSize:15,fontWeight:700,color:"var(--c-text)"}}>{t.bulkDeleteTitle}</div>
            </div>
            <div style={{fontSize:13,color:"var(--c-muted)",lineHeight:1.5,marginBottom:20}}>
              {t.bulkDeleteConfirm(selectedIds.size)}
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button
                onClick={()=>setBulkConfirm(false)}
                style={{padding:"8px 16px",fontSize:13,fontWeight:600,border:"1px solid var(--c-border)",borderRadius:8,background:"var(--c-surface)",color:"var(--c-muted)",cursor:"pointer"}}>
                {t.bulkDeleteNo}
              </button>
              <button
                onClick={bulkDelete}
                style={{padding:"8px 16px",fontSize:13,fontWeight:600,border:"1px solid var(--c-danger)",borderRadius:8,background:"var(--c-danger-solid)",color:"var(--c-on-brand)",cursor:"pointer"}}>
                {t.bulkDeleteYes}
              </button>
            </div>
          </Modal>}

      {/* PURGE MODE CONFIRMATION — arming «Очистка» destroys all imported
          income, so it requires typing the word (and the API additionally
          demands confirm_purge=true). */}
      {purgeConfirmOpen && <Modal onClose={()=>setPurgeConfirmOpen(false)} align="center" maxWidth={480} zIndex={1200} className={undefined} label={lang==="RU"?"Режим «Очистка» удалит все импортированные доходы":"Purge mode deletes all imported income"}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
              <div style={{width:40,height:40,borderRadius:"50%",background:"var(--c-danger-bg)",color:"var(--c-danger)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:700,flexShrink:0}}>🗑️</div>
              <div style={{fontSize:15,fontWeight:700,color:"var(--c-text)"}}>
                {lang==="RU"?"Режим «Очистка» удалит все импортированные доходы":"Purge mode deletes all imported income"}
              </div>
            </div>
            <div style={{fontSize:13,color:"var(--c-muted)",lineHeight:1.6,marginBottom:14}}>
              {lang==="RU"
                ? <>Перед импортом будут <b>безвозвратно удалены ВСЕ</b> транзакции доходов, загруженные из CSV (source=csv_income). Ручные доходы не затрагиваются. Откатить это можно только повторным импортом полного файла.</>
                : <>Before importing, <b>ALL</b> transactions loaded from CSV (source=csv_income) will be permanently deleted. Manual income is not affected. The only way back is re-importing the complete file.</>}
            </div>
            <label style={{...s.label,marginBottom:6}}>
              {lang==="RU"?<>Введите <b>{PURGE_WORD}</b> для подтверждения</>:(<>Type <b>{PURGE_WORD}</b> to confirm</>)}
            </label>
            <input style={{...s.input,marginBottom:16}} value={purgeWord} autoFocus
                   onChange={e=>setPurgeWord(e.target.value)}
                   placeholder={PURGE_WORD}/>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>{setPurgeConfirmOpen(false);setPurgeWord("");}}
                      style={{padding:"8px 16px",fontSize:13,fontWeight:600,border:"1px solid var(--c-border)",borderRadius:8,background:"var(--c-surface)",color:"var(--c-muted)",cursor:"pointer"}}>
                {lang==="RU"?"Отмена":"Cancel"}
              </button>
              <button disabled={purgeWord.trim().toUpperCase()!==PURGE_WORD}
                      onClick={()=>{setPurgeMode(true);setPurgeConfirmOpen(false);setPurgeWord("");}}
                      style={{padding:"8px 16px",fontSize:13,fontWeight:600,border:"1px solid var(--c-danger)",borderRadius:8,
                              background:purgeWord.trim().toUpperCase()===PURGE_WORD?"var(--c-danger-solid)":"var(--c-danger-fg-soft)",
                              color:"var(--c-on-brand)",cursor:purgeWord.trim().toUpperCase()===PURGE_WORD?"pointer":"not-allowed"}}>
                {lang==="RU"?"Включить очистку":"Enable purge"}
              </button>
            </div>
          </Modal>}
    </div>
  );
}

const INCOME_PAGE_SIZE = 50;

const vehTh={textAlign:"left",fontSize:12,fontWeight:700,color:"var(--c-muted-3)",textTransform:"uppercase",letterSpacing:0.5,paddingBottom:10,borderBottom:"1px solid var(--c-border-2)"};

const vehTd={padding:"10px 0",fontSize:13,color:"var(--c-text-5)",borderBottom:"1px solid var(--c-surface-2)",verticalAlign:"middle"};
