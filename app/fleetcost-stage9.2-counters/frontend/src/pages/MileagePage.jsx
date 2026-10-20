import { getPeriodDates, getPrevMonthDates } from "../lib/date.js";
import { apiFetch, apiGet } from "../lib/api.js";
import { s } from "../ui/styles.js";
import { DeltaBadge, PaginatedSegmentsTable, PeriodSel } from "../ui/components.jsx";
import { fmtDuration, fmtDurationShort } from "../lib/format.js";
import { useEffect, useRef, useState } from "react";
/** Страница «Пробег».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function MileagePage({t,lang,period,setPeriod,custom,setCustom}){
  const [mstats,setMstats]=useState(null);
  const [prevMstats,setPrevMstats]=useState(null);
  const [driverByPlate,setDriverByPlate]=useState({});
  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}`;

  useEffect(()=>{
    apiGet("/vehicles").then(d=>{
      if(!Array.isArray(d)) return;
      const m={};
      d.forEach(v=>{ if(v.plate_number) m[v.plate_number]=v.driver_name||null; });
      setDriverByPlate(m);
    });
  },[]);

  const load=async()=>{
    const cur=await apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`);
    setMstats(cur);
    // Previous month same-date-range, for the comparison badges.
    try{
      const prevDates=getPrevMonthDates(dates.from,dates.to);
      const prev=await apiGet(`/mileage/stats?date_from=${prevDates.from}&date_to=${prevDates.to}`);
      setPrevMstats(prev);
    }catch(e){ setPrevMstats(null); }
  };
  useEffect(()=>{load();},[datesKey]);

  const xlsxRef=useRef();
  const [upBusy,setUpBusy]=useState(false);
  const [upMsg,setUpMsg]=useState("");
  const upload=async(e)=>{
    const file=e.target.files[0];if(!file) return;
    setUpBusy(true);
    const fd=new FormData();fd.append("file",file);
    const r=await apiFetch("/import/mileage-xlsx",{method:"POST",body:fd});
    const d=await r.json();
    setUpBusy(false);
    let msg=`✅ ${t.importSuccess}: ${d.imported||0} (${lang==="RU"?"дней":"days"}), ${d.segments_imported||0} (${lang==="RU"?"сегментов":"segments"}), ${t.importSkipped}: ${d.skipped||0}`;
    if(d.unmatched_plates?.length) msg+=`\n${lang==="RU"?"Не найдены в автопарке":"Not found in fleet"}: ${d.unmatched_plates.join(", ")}`;
    setUpMsg(msg);
    setTimeout(()=>setUpMsg(""),15000);
    xlsxRef.current.value="";
    load();
  };

  const pctDelta=(cur,prev)=>{
    if(prev===null||prev===undefined||prev===0||cur===null||cur===undefined) return null;
    return (cur-prev)/Math.abs(prev)*100;
  };

  const totalKm=mstats?.total_km||0;
  const totalFuel=mstats?.total_fuel_liters||0;
  const fleetFuelPer100=mstats?.fleet_fuel_per_100km??null;
  const totalMoving=mstats?.total_moving_seconds||0;
  const totalStopped=mstats?.total_stopped_seconds||0;
  const fleetAvgSpeed=totalMoving>0?totalKm/(totalMoving/3600):null;
  const vehicles=mstats?.vehicles||{};
  const vehicleEntries=Object.entries(vehicles).sort((a,b)=>b[1].km-a[1].km);

  const kmDelta=pctDelta(totalKm,prevMstats?.total_km);
  const movingDelta=pctDelta(totalMoving,prevMstats?.total_moving_seconds);
  const stoppedDelta=pctDelta(totalStopped,prevMstats?.total_stopped_seconds);
  const fuelDelta=pctDelta(fleetFuelPer100,prevMstats?.fleet_fuel_per_100km);

  const numFmt=n=>(n||0).toLocaleString(lang==="RU"?"ru-RU":"en-US");

  return(
    <div style={s.page} className="fc-content">
      <div style={s.pageHeader}>
        <h1 style={s.pageTitle}>🛰️ {t.mileage}</h1>
        <div style={{display:"flex",gap:8}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <input ref={xlsxRef} type="file" accept=".xlsx,.xlsm" style={{display:"none"}} onChange={upload}/>
          <button style={s.btnPrimary} onClick={()=>xlsxRef.current.click()} disabled={upBusy}>{upBusy?"⏳ ...":"📂 "+t.uploadMileageXlsx}</button>
        </div>
      </div>
      {upMsg&&<div style={{...s.flash,whiteSpace:"pre-line"}}>{upMsg}</div>}

      {/* 1. FLEET KPI ROW — DeltaBadge absolutely positioned in top-right corner */}
      <div className="fc-kpi-scroll" style={{display:"grid",gridTemplateColumns:"repeat(4, minmax(180px, 1fr))",gap:12,overflowX:"auto",paddingBottom:12,marginBottom:16}}>
        <div style={{flex:"0 0 240px",background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"}}>
          <DeltaBadge pct={kmDelta} absolute/>
          <div style={{fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)",paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.totalMileage}</div>
          <div style={{fontSize:22,fontWeight:700,margin:"8px 0 4px",color:"var(--c-text-3)",whiteSpace:"nowrap"}}>{numFmt(totalKm)} км</div>
          <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:8}}>{vehicleEntries.length} {t.activeVehiclesShort}</div>
        </div>
        <div style={{flex:"0 0 240px",background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"}}>
          <DeltaBadge pct={movingDelta} absolute/>
          <div style={{fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)",paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.timeMoving}</div>
          <div style={{fontSize:20,fontWeight:700,margin:"8px 0 4px",color:"var(--c-emerald-500)",whiteSpace:"nowrap"}}>{fmtDurationShort(totalMoving,lang)}</div>
          <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:8}}>{t.avgSpeed}: {fleetAvgSpeed!=null?fleetAvgSpeed.toFixed(1):"—"} км/ч</div>
        </div>
        <div style={{flex:"0 0 240px",background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"}}>
          <DeltaBadge pct={stoppedDelta} invert absolute/>
          <div style={{fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)",paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.timeStopped}</div>
          <div style={{fontSize:20,fontWeight:700,margin:"8px 0 4px",color:"var(--c-warn-500)",whiteSpace:"nowrap"}}>{fmtDurationShort(totalStopped,lang)}</div>
          <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:8}}>{t.totalStoppedDesc}</div>
        </div>
        <div style={{flex:"0 0 240px",background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"}}>
          <DeltaBadge pct={fuelDelta} invert absolute/>
          <div style={{fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)",paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.mileageFuelTotal}</div>
          <div style={{fontSize:22,fontWeight:700,margin:"8px 0 4px",color:"var(--c-text-3)",whiteSpace:"nowrap"}}>{numFmt(totalFuel)} л</div>
          <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:8}}>{lang==="RU"?"Ср. расход":"Avg"}: {fleetFuelPer100!=null?fleetFuelPer100.toFixed(1):"—"} л / 100 км</div>
        </div>
      </div>

      {/* 2. VEHICLE CARDS — horizontal scroll */}
      <div style={{fontSize:16,fontWeight:600,marginBottom:14,color:"var(--c-text-3)"}}>{t.vehiclesSummary} ({vehicleEntries.length})</div>
      <div className="fc-cards-scroll fc-equal-card-grid" style={{display:"flex",gap:16,overflowX:"auto",paddingBottom:12,marginBottom:28}}>
        {!vehicleEntries.length?<div style={s.empty}>{t.noMileageData}</div>:vehicleEntries.map(([plate,v])=>{
          const util=v.utilization_pct;
          return(
          <div key={plate} style={{flex:"0 0 360px",background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:20,boxShadow:"0 2px 4px rgba(0,0,0,0.03)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:12,borderBottom:"1px solid var(--c-border)",marginBottom:14}}>
              <span>
                <span style={{fontSize:18,fontWeight:700,color:"var(--c-text-3)"}}>{plate}</span>
                {driverByPlate[plate]&&<span style={{fontSize:12,color:"var(--c-muted-2)",marginLeft:8}}>{driverByPlate[plate]}</span>}
              </span>
              <span style={{fontSize:12,fontWeight:600,padding:"4px 8px",borderRadius:20,background:"var(--c-info-bg-2)",color:"var(--c-sky)"}}>КТУ: {util!=null?util.toFixed(0):"—"}%</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <div style={{background:"var(--c-hover)",padding:"10px 12px",borderRadius:10}}>
                <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:3,whiteSpace:"nowrap"}}>{t.mileageForPeriod}</div>
                <div style={{fontSize:14,fontWeight:600,color:"var(--c-text-3)",whiteSpace:"nowrap"}}>{numFmt(v.km)} км</div>
              </div>
              <div style={{background:"var(--c-hover)",padding:"10px 12px",borderRadius:10}}>
                <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:3,whiteSpace:"nowrap"}}>{t.avgSpeed}</div>
                <div style={{fontSize:14,fontWeight:600,color:"var(--c-blue-500)",whiteSpace:"nowrap"}}>{v.avg_speed_kmh!=null?v.avg_speed_kmh.toFixed(1)+" км/ч":"—"}</div>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <div style={{background:"var(--c-hover)",padding:"10px 12px",borderRadius:10}}>
                <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:3,whiteSpace:"nowrap"}}>{t.timeMoving}</div>
                <div style={{fontSize:14,fontWeight:600,color:"var(--c-emerald-500)",whiteSpace:"nowrap"}}>{fmtDuration(v.moving_seconds,lang)}</div>
              </div>
              <div style={{background:"var(--c-hover)",padding:"10px 12px",borderRadius:10}}>
                <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:3,whiteSpace:"nowrap"}}>{t.timeStopped}</div>
                <div style={{fontSize:14,fontWeight:600,color:"var(--c-warn-500)",whiteSpace:"nowrap"}}>{fmtDuration(v.stopped_seconds,lang)}</div>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr",gap:10,marginBottom:0}}>
              <div style={{background:"var(--c-hover)",padding:"10px 12px",borderRadius:10}}>
                <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:3,whiteSpace:"nowrap"}}>{t.fuelAvgLabel}</div>
                <div style={{fontSize:14,fontWeight:600,color:"var(--c-text-3)",whiteSpace:"nowrap"}}>{v.fuel_per_100km!=null?v.fuel_per_100km.toFixed(1)+" л / 100 км":"—"}</div>
              </div>
            </div>
            <div style={{marginTop:12}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"var(--c-muted-2)",marginBottom:4}}>
                <span>{t.driveLabel}: {util!=null?util.toFixed(0):0}%</span>
                <span>{t.stopLabel}: {util!=null?(100-util).toFixed(0):0}%</span>
              </div>
              <div style={{height:6,background:"var(--c-surface-2)",borderRadius:3,overflow:"hidden",display:"flex"}}>
                <div style={{background:"var(--c-emerald-500)",height:"100%",width:`${util||0}%`}}/>
                <div style={{background:"var(--c-warn-solid)",height:"100%",width:`${util!=null?100-util:0}%`}}/>
              </div>
            </div>
          </div>
          );
        })}
      </div>

      {/* 3. DETAILED INTERVAL LOG (movement/stop segments) — paginated + filterable */}
      <div style={{fontSize:16,fontWeight:600,marginBottom:14,color:"var(--c-text-3)"}}>{t.intervalLog}</div>
      <PaginatedSegmentsTable dates={dates} t={t} lang={lang} vehiclePlates={vehicleEntries.map(([p])=>p)}/>
    </div>
  );
}
