import { useLocalState } from "../lib/hooks.js";
import { getPeriodDates } from "../lib/date.js";
import { apiFetch, apiGet, apiMutate } from "../lib/api.js";
import { isIncome, isManual, isOther, isSalary, isSvcFee } from "../lib/tx.js";
import { Badge, Card, PeriodSel, TxFilterBar, sortTxns } from "../ui/components.jsx";
import { MONO, fmtDate, fmtQty, normalizeCompanyName } from "../lib/format.js";
import { s } from "../ui/styles.js";
import { fmtByCur, sumToEur, sumEurRows } from "../lib/money.js";
import { useEffect, useRef, useState } from "react";
import { fxAutoSummary , fxAutoAction } from "../lib/fxAction.js";
import { useCurrencyList } from "../lib/currencies.js";
/** Страница «Ручной ввод».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function ManualPage({t,icon,title,fuelTypePrefix,addLabel,catLabels,showSvcFee=false,noVehicle=false,isIncomePage=false,period,setPeriod,custom,setCustom}){
  const [txns,setTxns]=useState([]);
  // FX-01: валюты — с бэкенда, не захардкоженные (раньше было 6 без CHF/RSD/MDL/GEL)
  const CURRENCIES = useCurrencyList();
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_manual_vehiclefilter","");
  const [countryFilter,setCountryFilter]=useLocalState("fc_manual_countryfilter","");
  const [sortMode,setSortMode]=useLocalState("fc_manual_sortmode","date_desc");
  const [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState({expense_date:new Date().toISOString().slice(0,10),plate_number:"",description:"",amount:"",currency:"EUR",category:Object.keys(catLabels)[0]});
  const [vehicles,setVehicles]=useState([]);
  const dates=getPeriodDates(period,custom);

  const load=()=>{
    apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000`)
      .then(d=>{
        const arr=Array.isArray(d)?d:[];
        setTxns(arr.filter(tx=>{
          if(isIncomePage) return isManual(tx.source)&&isIncome(tx.fuel_type);
          if(fuelTypePrefix==="salary") return isManual(tx.source)&&isSalary(tx.fuel_type);
          if(fuelTypePrefix==="other"){
            const manualOther=isManual(tx.source)&&isOther(tx.fuel_type);
            const svcFee=showSvcFee&&!isManual(tx.source)&&isSvcFee(tx.fuel_type);
            return manualOther||svcFee;
          }
          return isManual(tx.source)&&tx.fuel_type?.startsWith(`manual_${fuelTypePrefix}`);
        }));
      });
  };
  useEffect(()=>{load();},[`${dates.from}_${dates.to}`]);
  useEffect(()=>{apiGet("/vehicles").then(d=>setVehicles(Array.isArray(d)?d:[]));},[]);

  const add=async()=>{
    if(!form.description||!form.amount) return;
    // income stored with special prefix so it can be identified
    const cat=isIncomePage?`income_${form.category}`:`${fuelTypePrefix}_${form.category}`;
    await apiFetch("/expenses/",{method:"POST",body:JSON.stringify({...form,amount:+form.amount,category:cat})});
    setShowForm(false);load();
  };
  const remove=async(id)=>{
    const r=await apiMutate(`/expenses/${id}`,{method:"DELETE"});
    if(!r.ok) return;                     // toast reports the reason
    setTxns(prev=>prev.filter(tx=>tx.id!==id));
  };

  // Client-side filter
  const filteredTxns = txns.filter(tx=>{
    if(vehicleFilter && tx.plate_number !== vehicleFilter) return false;
    if(countryFilter && tx.country !== countryFilter) return false;
    return true;
  });
  const displayTxns = sortTxns(filteredTxns, sortMode);

  const availVehicles = [...new Set(txns.map(tx=>tx.plate_number).filter(Boolean))].sort();
  const availCountries = [...new Set(txns.map(tx=>tx.country).filter(Boolean))].sort();

  const byCur=txns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});

  // Category breakdown (e.g. Штраф / Парковка / Ремонт / Аренда прицепа / Прочее
  // on the "Иные расходы" page) — only meaningful when the page has more than
  // one manual sub-category.
  const showCatBreakdown=!isIncomePage&&Object.keys(catLabels).length>1;
  const byCategory=showCatBreakdown?txns.reduce((m,tx)=>{
    let label;
    if(isManual(tx.source)){
      const key=tx.fuel_type?.replace(`manual_${fuelTypePrefix}_`,"");
      label=catLabels[key]||key||t.otherCat;
    }else{
      label=tx.fuel_type||t.otherCat; // e.g. e100 "Сервисный сбор" service fee
    }
    if(!m[label]) m[label]={};
    m[label][tx.currency]=(m[label][tx.currency]||0)+tx.amount;
    m[label].__eur = (m[label].__eur||0) + Number(tx.amount_eur||0);   // исторический курс
    return m;
  },{}):null;

  // For income page: compute by-company and by-vehicle stats
  const byCompany=isIncomePage?txns.reduce((m,tx)=>{
    const company=normalizeCompanyName(tx.station_address);
    if(!m[company]) m[company]={};
    m[company][tx.currency]=(m[company][tx.currency]||0)+tx.amount;
    m[company].__eur = (m[company].__eur||0) + Number(tx.amount_eur||0);   // исторический курс
    return m;
  },{}):null;

  const byVehicleIncome=isIncomePage?txns.reduce((m,tx)=>{
    const plate=tx.plate_number||t.noVehicle;
    if(!m[plate]) m[plate]={};
    m[plate][tx.currency]=(m[plate][tx.currency]||0)+tx.amount;
    m[plate].__eur = (m[plate].__eur||0) + Number(tx.amount_eur||0);   // исторический курс
    return m;
  },{}):null;

  // CSV import for income
  const csvRef=useRef();
  const [csvUp,setCsvUp]=useState(false);
  const [csvMsg,setCsvMsg]=useState("");
  const uploadIncomeCSV=async(e)=>{
    const file=e.target.files[0];if(!file) return;
    setCsvUp(true);
    const fd=new FormData();fd.append("file",file);
    const r=await apiFetch("/import/income-csv",{method:"POST",body:fd});
    const d=await r.json();
    setCsvUp(false);
    let parts = [`✅ ${t.importSuccess}: ${d.imported||0}`, `${t.importSkipped}: ${d.skipped||0}`];
    if(d.credit_notes) parts.push(`${t.creditNotes}: ${d.credit_notes}`);
    if(d.cancelled_positives) parts.push(`${t.cancelledPos}: ${d.cancelled_positives}`);
    if(d.parse_errors) parts.push(`parse errors: ${d.parse_errors}`);
    // Автопересчёт курсов: без этой строки «импорт выполнен» скрывало бы, что часть
    // строк осталась без EUR и требует ручного курса.
    const fxAuto=fxAutoSummary(d.auto);
    if(fxAuto) parts.push(fxAuto);
    const fxAct=fxAutoAction(d.auto);
    if(fxAct) parts.push(fxAct);
    let msg = parts.join(', ');
    if(d.skip_reasons && d.skip_reasons.length > 0){
      msg += `\n\n${t.skipReasons}\n` + d.skip_reasons.join('\n');
    }
    setCsvMsg(msg);
    setTimeout(()=>setCsvMsg(""),15000);
    csvRef.current.value="";
    load();
  };

  return(
    <div style={s.page}>
      <div style={s.pageHeader}>
        <h1 style={s.pageTitle}>{icon} {title}</h1>
        <div style={{display:"flex",gap:8}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          {isIncomePage&&<><input ref={csvRef} type="file" accept=".csv" style={{display:"none"}} onChange={uploadIncomeCSV}/>
          <button style={s.btnPrimary} onClick={()=>csvRef.current.click()} disabled={csvUp}>
            {csvUp?"⏳ ...":"📂 "+t.importIncomeCSV}
          </button></>}
          <button style={s.btnPrimary} onClick={()=>setShowForm(true)}>+ {addLabel}</button>
        </div>
      </div>
      {csvMsg&&<div style={s.flash}>{csvMsg}</div>}
      {isIncomePage&&byCompany&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:14,marginBottom:18}}>
          <Card>
            <h3 style={s.cardTitle}>🏢 {t.byCompany}</h3>
            {Object.keys(byCompany).length?Object.entries(byCompany).map(([company,bc])=>(
              <div key={company} style={s.row}>
                <div><div style={{fontWeight:600,fontSize:13}}>{company}</div></div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--c-emerald-500)"}}>{(bc.__eur||0).toFixed(2)} EUR</div>
                  {Object.entries(bc).map(([c,v])=><div key={c} style={{fontSize:12,color:"var(--c-muted-2)"}}>{v.toFixed(2)} {c}</div>)}
                </div>
              </div>
            )):<div style={s.empty}>—</div>}
          </Card>
          <Card>
            <h3 style={s.cardTitle}>🚛 {t.byVehicleIncome}</h3>
            {Object.keys(byVehicleIncome||{}).length?Object.entries(byVehicleIncome).map(([plate,bc])=>(
              <div key={plate} style={s.row}>
                <span style={{fontWeight:600,fontSize:13}}>{plate}</span>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--c-emerald-500)"}}>{(bc.__eur||0).toFixed(2)} EUR</div>
                  {Object.entries(bc).map(([c,v])=><div key={c} style={{fontSize:12,color:"var(--c-muted-2)"}}>{v.toFixed(2)} {c}</div>)}
                </div>
              </div>
            )):<div style={s.empty}>—</div>}
          </Card>
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(155px,1fr))",gap:12,marginBottom:18}}>
        <Card>
          <div style={s.kpiLabel}>💰 {t.total}</div>
          {Object.keys(byCur).length?<>
            <div style={s.kpiValue}>{sumEurRows(txns).toFixed(2)} EUR   {/* исторический курс */}</div>
            <div style={{fontSize:12,color:"var(--c-muted-2)"}}>{fmtByCur(byCur)}</div>
          </>:<div style={{...s.kpiValue,color:"var(--c-border-strong)"}}>—</div>}
        </Card>
        <Card><div style={s.kpiLabel}>📊 {t.totalTx}</div><div style={s.kpiValue}>{txns.length}</div></Card>
      </div>

      {showCatBreakdown&&(
        <Card style={{marginBottom:18}}>
          <h3 style={s.cardTitle}>🗂️ {t.byType}</h3>
          {Object.keys(byCategory).length?Object.entries(byCategory).sort((a,b)=>(b[1].__eur||0)-(a[1].__eur||0)).map(([label,bc])=>(
            <div key={label} style={s.row}>
              <span style={{fontWeight:600,fontSize:13}}>{label}</span>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:13,fontWeight:700,fontFamily:MONO}}>{(bc.__eur||0).toFixed(2)} EUR</div>
                <div style={{fontSize:12,color:"var(--c-muted-2)"}}>{fmtByCur(bc)}</div>
              </div>
            </div>
          )):<div style={s.empty}>{t.noData}</div>}
        </Card>
      )}

      {showForm&&(
        <Card style={{marginBottom:14}}>
          <h3 style={{margin:"0 0 12px"}}>{addLabel}</h3>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            <div><label style={s.label} htmlFor="fc-g-46">{t.expenseDate}</label><input id="fc-g-46" type="date" style={s.input} value={form.expense_date} onChange={e=>setForm({...form,expense_date:e.target.value})}/></div>
            {!noVehicle&&<div><label style={s.label} htmlFor="fc-f-37">{t.plate}</label>
              <select id="fc-f-37" style={s.input} value={form.plate_number} onChange={e=>setForm({...form,plate_number:e.target.value})}>
                <option value="">—</option>
                {vehicles.map(v=><option key={v.id} value={v.plate_number}>{v.plate_number} {v.driver_name?`(${v.driver_name})`:""}</option>)}
              </select></div>}
            <div><label style={s.label} htmlFor="fc-f-38">{t.category}</label>
              <select id="fc-f-38" style={s.input} value={form.category} onChange={e=>setForm({...form,category:e.target.value})}>
                {Object.entries(catLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}
              </select></div>
            <div style={{gridColumn:"1/-1"}}><label style={s.label} htmlFor="fc-f-39">{t.description}</label>
              <input id="fc-f-39" style={s.input} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-g-47">{t.amount}</label><input id="fc-g-47" type="number" style={s.input} value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-f-40">{t.currency}</label>
              <select id="fc-f-40" style={s.input} value={form.currency} onChange={e=>setForm({...form,currency:e.target.value})}>
                {CURRENCIES.map(c=><option key={c}>{c}</option>)}
              </select></div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button style={s.btnPrimary} onClick={add}>{t.save}</button>
            <button style={s.btn} onClick={()=>setShowForm(false)}>{t.cancel}</button>
          </div>
        </Card>
      )}
      <Card style={{padding:0}}>
        <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.recentTx} ({displayTxns.length})</h3>
          <TxFilterBar vehicles={availVehicles} countries={availCountries} embedded
            vehicleFilter={vehicleFilter} setVehicleFilter={setVehicleFilter}
            countryFilter={countryFilter} setCountryFilter={setCountryFilter}
            sortMode={sortMode} setSortMode={setSortMode} t={t}/>
        </div>
        {!displayTxns.length?<div style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>{t.noData}</div>:(
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr style={{background:"var(--c-hover)"}}>
              {[t.date,t.plate,...(isIncomePage?[t.companyCol]:[t.category]),t.amount,t.actions].map(h=><th key={h} style={s.th}>{h}</th>)}
            </tr></thead>
            <tbody>{displayTxns.map(tx=>(
              <tr key={tx.id} style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                <td style={s.td}>{fmtDate(tx.transaction_date)}</td>
                <td style={s.td}><b>{tx.plate_number||"—"}</b></td>
                {isIncomePage
                  ?<td style={s.td}>{tx.station_address||"—"}</td>
                  :<><td style={s.td}>{tx.station_address||"—"}</td>
                  <td style={s.td}><Badge bg="var(--c-violet-bg)" fg="var(--c-violet-700)">{tx.fuel_type?.replace(/^manual_[^_]+_/,"")}</Badge></td></>
                }
                <td style={{...s.td,fontWeight:700,color:isIncomePage?"var(--c-emerald-500)":undefined,fontFamily:MONO}}>{isIncomePage?"+":""}{fmtQty(tx.amount,2)} {tx.currency}</td>
                <td style={s.td}><button style={s.btnDanger} onClick={()=>remove(tx.id)}>✕</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
