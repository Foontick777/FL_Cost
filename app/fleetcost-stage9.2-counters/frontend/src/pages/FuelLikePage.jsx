import { useLocalState } from "../lib/hooks.js";
import { getPeriodDates } from "../lib/date.js";
import { apiGet, apiMutate, reportUiError } from "../lib/api.js";
import { Card, PeriodSel, SkeletonRows, SrcFilter, TxFilterBar, TxTable, sortTxns } from "../ui/components.jsx";
import { fmtByCur, sumEurRows, sumToEur } from "../lib/money.js";
import { s } from "../ui/styles.js";
import { FLAGS } from "../ui/constants.js";
import { MONO } from "../lib/format.js";
import { useEffect, useState } from "react";
import { useCurrencyList } from "../lib/currencies.js";
/** Страница «Страница-близнец топлива (AdBlue/сервисные сборы)».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function FuelLikePage({t,icon,title,filterFn,showVolume=false,showAvgPrice=true,allowManual=false,showConsumption=false,lang,period,setPeriod,custom,setCustom}){
  const [srcFilter,setSrcFilter]=useLocalState("fc_fuellike_srcfilter","");
  // FX-01: валюты — с бэкенда, не захардкоженные (раньше было 4 без CHF/RSD/MDL/GEL)
  const CURRENCIES = useCurrencyList();
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_fuellike_vehiclefilter","");
  const [countryFilter,setCountryFilter]=useLocalState("fc_fuellike_countryfilter","");
  const [sortMode,setSortMode]=useLocalState("fc_fuellike_sortmode","date_desc");
  const [txns,setTxns]=useState([]);
  const [loading,setLoading]=useState(false);
  const [mstats,setMstats]=useState(null);
  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}`;

  const load=()=>{
    setLoading(true);
    const src=srcFilter?`&source=${srcFilter}`:"";
    apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000${src}`)
      .then(d=>{setTxns(Array.isArray(d)?d.filter(filterFn):[]);setLoading(false);});
    if(showConsumption) apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`).then(setMstats);
  };
  useEffect(()=>{load();},[datesKey,srcFilter]);

  // ── Manual entry (fuel bought outside e100/Q8, e.g. filling up in Belarus)
  const [vehicles,setVehicles]=useState([]);
  const [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState({expense_date:new Date().toISOString().slice(0,10),plate_number:"",volume:"",amount:"",currency:"BYN",country:"BY",description:lang==="RU"?"Беларусь":"Belarus"});
  useEffect(()=>{ if(allowManual||showConsumption) apiGet("/vehicles").then(d=>setVehicles(Array.isArray(d)?d:[])); },[allowManual,showConsumption]);
  const driverByPlate=vehicles.reduce((m,v)=>{ if(v.plate_number) m[v.plate_number]=v.driver_name||null; return m; },{});
  const addManual=async()=>{
    if(!form.amount||!form.volume){
      reportUiError(lang==="RU"?"Заполните сумму и объём":"Enter amount and volume");
      return;
    }
    const r=await apiMutate("/expenses/",{method:"POST",body:JSON.stringify({
      expense_date:form.expense_date, plate_number:form.plate_number||null,
      description:form.description||(lang==="RU"?"Беларусь":"Belarus"), country:form.country||null,
      amount:+form.amount, currency:form.currency, volume:+form.volume, category:"fuel_manual",
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

  // Client-side filter by vehicle/country
  const filteredTxns = txns.filter(tx=>{
    if(vehicleFilter && tx.plate_number !== vehicleFilter) return false;
    if(countryFilter && tx.country !== countryFilter) return false;
    return true;
  });
  const displayTxns = sortTxns(filteredTxns, sortMode);

  // Compute available vehicles and countries from fetched data
  const availVehicles = [...new Set(txns.map(tx=>tx.plate_number).filter(Boolean))].sort();
  const availCountries = [...new Set(txns.map(tx=>tx.country).filter(Boolean))].sort();

  // Stats based on all fetched txns (not filtered by vehicle/country — those are for the table)
  const allTxns=txns;
  const byCur=allTxns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const totalEur=sumEurRows(allTxns);
  const totalVol=allTxns.reduce((s,tx)=>s+(tx.volume||0),0);

  // By country stats — weighted average price = total amount / total volume (per currency)
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

  // ── Real consumption per vehicle: (liters bought e100+Q8+manual) / (km driven, from Mileage segments) * 100
  // — deliberately NOT read from the nav.by export, which is frequently empty or wrong for fuel.
  const volByPlate=allTxns.reduce((m,tx)=>{
    if(!tx.plate_number||!(tx.volume>0)) return m;
    m[tx.plate_number]=(m[tx.plate_number]||0)+tx.volume;
    return m;
  },{});
  const mVehicles=mstats?.vehicles||{};
  const consumptionPlates=[...new Set([...Object.keys(volByPlate),...Object.keys(mVehicles)])].sort();
  const consumptionRows=consumptionPlates.map(plate=>{
    const liters=volByPlate[plate]||0;
    const km=mVehicles[plate]?.km||0;
    return {plate, liters, km, per100: km>0&&liters>0 ? liters/km*100 : null};
  }).filter(r=>r.liters>0||r.km>0);
  const fleetKm=mstats?.total_km||0;
  const fleetPer100 = fleetKm>0&&totalVol>0 ? totalVol/fleetKm*100 : null;

  return(
    <div style={s.page}>
      <div style={s.pageHeader}>
        <h1 style={s.pageTitle}>{icon} {title}</h1>
        <div style={{display:"flex",gap:8}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <SrcFilter value={srcFilter} onChange={setSrcFilter} t={t}/>
          {allowManual&&<button style={s.btnPrimary} onClick={()=>setShowForm(v=>!v)}>＋ {t.addFuelManual}</button>}
        </div>
      </div>

      {showForm&&(
        <Card style={{marginBottom:14}}>
          <h3 style={{margin:"0 0 12px"}}>{t.addFuelManual}</h3>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            <div><label style={s.label} htmlFor="fc-g-4">{t.expenseDate}</label><input id="fc-g-4" type="date" style={s.input} value={form.expense_date} onChange={e=>setForm({...form,expense_date:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-f-5">{t.plate}</label>
              <select id="fc-f-5" style={s.input} value={form.plate_number} onChange={e=>setForm({...form,plate_number:e.target.value})}>
                <option value="">—</option>
                {vehicles.map(v=><option key={v.id} value={v.plate_number}>{v.plate_number} {v.driver_name?`(${v.driver_name})`:""}</option>)}
              </select></div>
            <div><label style={s.label} htmlFor="fc-g-5">{t.volume} ({t.liters})</label><input id="fc-g-5" type="number" style={s.input} value={form.volume} onChange={e=>setForm({...form,volume:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-f-6">{t.country}</label>
              <select id="fc-f-6" style={s.input} value={form.country} onChange={e=>setForm({...form,country:e.target.value})}>
                {["BY","PL","DE","LT","LV","UA","RU"].map(c=><option key={c} value={c}>{FLAGS[c]||"🌍"} {c}</option>)}
              </select></div>
            <div style={{gridColumn:"1/-1"}}><label style={s.label} htmlFor="fc-f-7">{t.station}</label>
              <input id="fc-f-7" style={s.input} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-g-6">{t.amount}</label><input id="fc-g-6" type="number" style={s.input} value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-f-8">{t.currency}</label>
              <select id="fc-f-8" style={s.input} value={form.currency} onChange={e=>setForm({...form,currency:e.target.value})}>
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

      {/* KPI row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(155px,1fr))",gap:12,marginBottom:18}}>
        <Card>
          <div style={s.kpiLabel}>💰 {t.total}</div>
          {totalEur>0?<>
            <div style={s.kpiValue}>{totalEur.toFixed(2)} EUR</div>
            <div style={{fontSize:12,color:"var(--c-muted-2)",marginTop:2}}>{fmtByCur(byCur)}</div>
          </>:<div style={{...s.kpiValue,color:"var(--c-border-strong)"}}>—</div>}
        </Card>
        {showVolume&&<Card><div style={s.kpiLabel}>🔢 {t.volume}</div><div style={s.kpiValue}>{totalVol.toFixed(1)} {t.liters}</div></Card>}
        {showConsumption&&<Card><div style={s.kpiLabel}>⛽ {t.fuelPer100}</div><div style={s.kpiValue}>{fleetPer100!=null?fleetPer100.toFixed(1)+" л":"—"}</div>
          <div style={{fontSize:12,color:"var(--c-muted-2)",marginTop:2}}>{lang==="RU"?"из факт. заправок / пробега":"from actual fuel / mileage"}</div></Card>}
        <Card><div style={s.kpiLabel}>📊 {t.totalTx}</div><div style={s.kpiValue}>{allTxns.length}</div></Card>
      </div>

      {/* Per-vehicle real consumption widgets — horizontal scroll */}
      {showConsumption&&(
        <div style={{marginBottom:20}}>
          <div style={{fontSize:12,fontWeight:700,textTransform:"uppercase",color:"var(--c-muted-3)",marginBottom:8}}>🚛 {t.consumptionByVehicle}</div>
          <div className="fc-cards-scroll fc-kpi-equal-grid" style={{display:"flex",gap:12,overflowX:"auto",paddingBottom:8}}>
            {!consumptionRows.length?<div style={s.empty}>{t.noData}</div>:consumptionRows.map(r=>(
              <div key={r.plate} style={{flex:"0 0 175px",background:"var(--c-surface)",border:"1px solid var(--c-border-2)",borderRadius:12,padding:"12px 14px"}}>
                <div style={{fontSize:13,fontWeight:700,marginBottom:2}}>{r.plate}</div>
                {driverByPlate[r.plate]&&<div style={{fontSize:11,color:"var(--c-muted-2)",marginBottom:4}}>{driverByPlate[r.plate]}</div>}
                <div style={{fontSize:18,fontWeight:800,fontFamily:MONO,color:r.per100!=null?"var(--c-text-2)":"var(--c-border-strong)",marginTop:driverByPlate[r.plate]?0:4}}>{r.per100!=null?r.per100.toFixed(1)+" л":"—"}</div>
                <div style={{fontSize:11,color:"var(--c-muted-2)",fontFamily:MONO,marginTop:4}}>{r.liters.toFixed(0)} {t.liters} / {(r.km||0).toLocaleString(lang==="RU"?"ru-RU":"en-US")} км</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* By country + avg price */}
      <div style={{display:"grid",gridTemplateColumns:showAvgPrice?"1fr 1fr":"1fr",gap:14,marginBottom:18}}>
        <Card>
          <h3 style={s.cardTitle}>🌍 {t.byCountry}</h3>
          {Object.keys(countryStats).length?Object.entries(countryStats).map(([country,cs])=>(
            <div key={country} style={s.row}>
              <div>
                <div style={{fontWeight:600}}>{FLAGS[country]||"🌍"} {country}</div>
                {showVolume&&<div style={{fontSize:12,color:"var(--c-muted-2)"}}>{cs.vol.toFixed(1)} {t.liters}</div>}
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:13,fontWeight:700,fontFamily:MONO}}>{cs.eur.toFixed(2)} EUR</div>
                {Object.entries(cs.byCur).map(([c,v])=><div key={c} style={{fontSize:12,color:"var(--c-muted-2)"}}>{v.toFixed(2)} {c}</div>)}
              </div>
            </div>
          )):<div style={s.empty}>—</div>}
        </Card>
        {showAvgPrice && <Card>
          <h3 style={s.cardTitle}>📈 {t.avgPrice}</h3>
          {Object.keys(countryStats).length?Object.entries(countryStats).map(([country,cs])=>{
            // Weighted average: total amount (converted to EUR) / total volume across all currencies
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
        </Card>}
      </div>

      <Card style={{padding:0}}>
        <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.recentTx} ({displayTxns.length})</h3>
          <TxFilterBar vehicles={availVehicles} countries={availCountries} embedded
            vehicleFilter={vehicleFilter} setVehicleFilter={setVehicleFilter}
            countryFilter={countryFilter} setCountryFilter={setCountryFilter}
            sortMode={sortMode} setSortMode={setSortMode} t={t}/>
        </div>
        {loading?<SkeletonRows rows={6}/>
          :<TxTable txns={displayTxns} t={t} showVolume={showVolume} onDeleteManual={allowManual?removeManual:null}/>}
      </Card>
    </div>
  );
}
