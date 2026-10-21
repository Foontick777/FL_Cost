import { useLocalState } from "../lib/hooks.js";
import { getPeriodDates, getPrevMonthDates } from "../lib/date.js";
import { isManual, isToll } from "../lib/tx.js";
import { apiGet } from "../lib/api.js";
import { sumEurRows, sumToEur } from "../lib/money.js";
import { Card, CurrencyBadge, DeltaBadge, Pagination, PeriodSel, SkeletonRows, SrcFilter, TxFilterBar, TxTable, sortTxns, MissingEurBanner } from "../ui/components.jsx";
import { s, KPI_CORNER_PAD } from "../ui/styles.js";
import { FLAGS } from "../ui/constants.js";
import { useEffect, useState } from "react";
/** Страница «Толлы».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function TollsPage({t, lang, period, setPeriod, custom, setCustom, refreshKey=0}){
  const [srcFilter,setSrcFilter]=useLocalState("fc_tolls_srcfilter","");
  const [txns,setTxns]=useState([]);
  const [prevTxns,setPrevTxns]=useState([]);
  const [loading,setLoading]=useState(false);
  const [mstats,setMstats]=useState(null);
  const [prevMstats,setPrevMstats]=useState(null);
  const [vehicles,setVehicles]=useState([]);
  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}_${refreshKey}`;
  const [page,setPage]=useState(0);
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_tolls_vehiclefilter","");
  const [countryFilter,setCountryFilter]=useLocalState("fc_tolls_countryfilter","");
  const [sortMode,setSortMode]=useLocalState("fc_tolls_sortmode","date_desc");
  const tollFilterFn = tx => isToll(tx.fuel_type) && !isManual(tx.source);
  const load=async()=>{
    setLoading(true);
    const src=srcFilter?`&source=${srcFilter}`:"";
    const [d, ms] = await Promise.all([
      apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000${src}`),
      apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`)
    ]);
    setTxns(Array.isArray(d)?d.filter(tollFilterFn):[]);
    setMstats(ms||null);
    setLoading(false);
    try{
      const prevDates=getPrevMonthDates(dates.from,dates.to);
      const [pb, pms] = await Promise.all([
        apiGet(`/transactions/?date_from=${prevDates.from}&date_to=${prevDates.to}&limit=50000${src}`),
        apiGet(`/mileage/stats?date_from=${prevDates.from}&date_to=${prevDates.to}`)
      ]);
      setPrevTxns(Array.isArray(pb)?pb.filter(tollFilterFn):[]);
      setPrevMstats(pms||null);
    }catch(e){setPrevTxns([]);setPrevMstats(null);}
  };
  useEffect(()=>{load();},[datesKey,srcFilter]);
  useEffect(()=>{setPage(0);},[datesKey,srcFilter,vehicleFilter,countryFilter,sortMode]);
  useEffect(()=>{ apiGet("/vehicles").then(d=>setVehicles(Array.isArray(d)?d:[])); },[]);
  const driverByPlate=vehicles.reduce((m,v)=>{ if(v.plate_number) m[v.plate_number]=v.driver_name||null; return m; },{});
  const allTxns=txns;
  const prevAllTxns=prevTxns;
  const byCur=allTxns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const totalEur=sumEurRows(allTxns);
  const totalTxCount=allTxns.length;
  const prevByCur=prevAllTxns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const prevTotalEur=sumEurRows(prevAllTxns);
  const mVehicles=mstats?.vehicles||{};
  const fleetKm=mstats?.total_km||0;
  const costPerKm=fleetKm>0&&totalEur>0?totalEur/fleetKm:null;
  const prevFleetKm=prevMstats?.total_km||0;
  const prevCostPerKm=prevFleetKm>0&&prevTotalEur>0?prevTotalEur/prevFleetKm:null;
  const pctDelta=(cur,prev)=>{
    if(prev===null||prev===undefined||prev===0||cur===null||cur===undefined) return null;
    return (cur-prev)/Math.abs(prev)*100;
  };
  const totalEurDelta=pctDelta(totalEur,prevTotalEur);
  const costPerKmDelta=pctDelta(costPerKm,prevCostPerKm);
  const countryStats=allTxns.reduce((m,tx)=>{
    const c=tx.country||"Unknown";
    if(!m[c]) m[c]={vol:0,byCur:{},eur:0,count:0};
    m[c].byCur[tx.currency]=(m[c].byCur[tx.currency]||0)+tx.amount;
    m[c].eur+=(tx.amount_eur||0);
    m[c].count++;
    return m;
  },{});
  const countryEntries=Object.entries(countryStats).map(([country,cs])=>({
    country, cs, eur: cs.eur, count: cs.count,
    pct: totalEur>0?cs.eur/totalEur*100:0
  })).sort((a,b)=>b.eur-a.eur);
  const topCountry = countryEntries[0]||null;
  const vehicleTollMap=allTxns.reduce((m,tx)=>{
    const p=tx.plate_number||"UNKNOWN";
    if(!m[p]) m[p]={byCur:{},eur:0,count:0,countries:{}};
    m[p].byCur[tx.currency]=(m[p].byCur[tx.currency]||0)+tx.amount;
    m[p].eur+=(tx.amount_eur||0);   // исторический курс: см. sumEurRows
    m[p].count++;
    const c=tx.country||"Unknown";
    if(!m[p].countries[c]) m[p].countries[c]={byCur:{},eur:0,count:0};
    m[p].countries[c].byCur[tx.currency]=(m[p].countries[c].byCur[tx.currency]||0)+tx.amount;
    m[p].countries[c].eur+=(tx.amount_eur||0);   // исторический курс: см. sumEurRows
    m[p].countries[c].count++;
    return m;
  },{});
  const tollVehiclePlates=Object.keys(vehicleTollMap).filter(p=>p!=="UNKNOWN").sort();
  const tollVehicleEntries=tollVehiclePlates.map(plate=>{
    const vt=vehicleTollMap[plate];
    const totalEurV=vt.eur;
    const kmV=mVehicles[plate]?.km||0;
    const perKmV=kmV>0&&totalEurV>0?totalEurV/kmV:null;
    const sharePct=totalEur>0?totalEurV/totalEur*100:0;
    const csEntries=Object.entries(vt.countries).map(([country,c])=>({
      country, eur: c.eur, count: c.count
    })).sort((a,b)=>b.eur-a.eur);
    const topV=csEntries[0]||null;
    const topPctV=topV&&totalEurV>0?topV.eur/totalEurV*100:0;
    return {plate, ...vt, totalEurV, kmV, perKmV, sharePct, topV, topPctV};
  }).sort((a,b)=>b.totalEurV-a.totalEurV);
  const filteredTxns=allTxns.filter(tx=>{
    if(vehicleFilter&&tx.plate_number!==vehicleFilter) return false;
    if(countryFilter&&tx.country!==countryFilter) return false;
    return true;
  });
  const displayTxns=sortTxns(filteredTxns,sortMode);
  const paginatedTxns=displayTxns.slice(page*TOLLS_PAGE_SIZE,(page+1)*TOLLS_PAGE_SIZE);
  const totalPages=Math.max(1,Math.ceil(displayTxns.length/TOLLS_PAGE_SIZE));
  const availVehicles=[...new Set(allTxns.map(tx=>tx.plate_number).filter(Boolean))].sort();
  const availCountries=[...new Set(allTxns.map(tx=>tx.country).filter(Boolean))].sort();
  const numFmt=n=>(n||0).toLocaleString(lang==="RU"?"ru-RU":"en-US");
  const eurFmt=v=>v.toLocaleString(lang==="RU"?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+" EUR";
  const numFmt2=v=>v.toLocaleString(lang==="RU"?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const kpiCard={flex:"0 0 240px",background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"}
  const kpiTitle={fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)"};
  const kpiVal={fontSize:22,fontWeight:700,margin:"8px 0 4px",color:"var(--c-text-3)",whiteSpace:"nowrap"};
  const kpiSub={fontSize:12,color:"var(--c-muted-2)",marginBottom:8,paddingRight:KPI_CORNER_PAD};
  const kpiCorner=s.kpiCorner;
  const metricBox={background:"var(--c-hover)",padding:"8px 12px",borderRadius:10};
  const metricLabel={fontSize:12,color:"var(--c-muted-2)",marginBottom:2,whiteSpace:"nowrap"};
  const metricVal={fontSize:13,fontWeight:600,color:"var(--c-text-3)",whiteSpace:"nowrap"};
  return(
    <div style={{...s.page}} className="fc-content">
      <div className="fc-page-header" style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"nowrap",overflowX:"auto",gap:12,marginBottom:20,paddingBottom:4}}>
        <h1 style={{...s.pageTitle,fontSize:18,whiteSpace:"nowrap"}}>🛣️ {t.tolls}</h1>
        <div className="fc-header-controls" style={{display:"flex",gap:8,flexWrap:"nowrap",alignItems:"center",flexShrink:0}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <SrcFilter value={srcFilter} onChange={setSrcFilter} t={t}/>
        </div>
      </div>
      <MissingEurBanner rows={allTxns} lang={lang}/>
      <div className="fc-kpi-scroll" style={{display:"grid",gridTemplateColumns:"repeat(4, minmax(180px, 1fr))",gap:12,overflowX:"auto",paddingBottom:12,marginBottom:16}}>
        <div style={{...kpiCard,position:"relative"}}>
          <DeltaBadge pct={totalEurDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.tollTotalExpenses}</div>
          <div style={kpiVal}>{totalEur>0?eurFmt(totalEur):"—"}</div>
          <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
            <span>{lang==="RU"?"За выбранный период":"For the period"}</span>
          </div>
          <div style={{...kpiCorner}}><CurrencyBadge byCur={byCur} lang={lang}/></div>
        </div>
        <div style={{...kpiCard,position:"relative"}}>
          <DeltaBadge pct={costPerKmDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.tollCostPerKm}</div>
          <div style={{...kpiVal,color:"var(--c-brand)"}}>{costPerKm!=null?numFmt2(costPerKm)+" EUR/км":"—"}</div>
          <div style={kpiSub}>{t.tollCostPerKmSub}: {numFmt(fleetKm)} км</div>
        </div>
        <div style={kpiCard}>
          <div style={kpiTitle}>{t.tollMaxExpenses}</div>
          <div style={{...kpiVal,color:"var(--c-rose-600)"}}>{topCountry?`${topCountry.country} (${topCountry.pct.toFixed(1)}%)`:"—"}</div>
          <div style={kpiSub}>{topCountry?`${numFmt2(topCountry.eur)} EUR · ${t.tollCountryCount(topCountry.count)}`:""}</div>
        </div>
        <div style={kpiCard}>
          <div style={kpiTitle}>{t.tollTotalTx}</div>
          <div style={kpiVal}>{totalTxCount}</div>
          <div style={kpiSub}>{lang==="RU"?"E-Box, Виньетки, Рамки":"E-Box, Vignettes, Frames"}</div>
        </div>
      </div>
      <div style={{fontSize:16,fontWeight:600,marginBottom:14,color:"var(--c-text-3)"}}>{t.tollVehiclesTitle} ({tollVehicleEntries.length})</div>
      <div className="fc-cards-scroll fc-equal-card-grid" style={{display:"flex",gap:16,overflowX:"auto",paddingBottom:12,marginBottom:28}}>
        {!tollVehicleEntries.length
          ? <div style={s.empty}>{t.noData}</div>
          : tollVehicleEntries.map(v=>{
            const plateLabel=v.plate;
            const driverName=driverByPlate[v.plate];
            return(
              <div key={v.plate} style={{flex:"0 0 360px",background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:20,boxShadow:"0 2px 4px rgba(0,0,0,0.03)"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:12,borderBottom:"1px solid var(--c-border)",marginBottom:14}}>
                  <span>
                    <span style={{fontSize:16,fontWeight:700,color:"var(--c-text-3)"}}>{plateLabel}</span>
                    {driverName&&<span style={{fontSize:12,color:"var(--c-muted-2)",marginLeft:8}}>{driverName}</span>}
                  </span>
                  <span style={{fontSize:12,fontWeight:700,padding:"3px 8px",borderRadius:6,background:"var(--c-brand-bg-2)",color:"var(--c-brand-strong)"}}>
                    {lang==="RU"?"Доля":"Share"}: {v.sharePct.toFixed(1)}%
                  </span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                  <div style={metricBox}>
                    <div style={metricLabel}>{t.tollSumMetric}</div>
                    <div style={metricVal}>{numFmt2(v.totalEurV)} EUR</div>
                  </div>
                  <div style={metricBox}>
                    <div style={metricLabel}>{lang==="RU"?"Пробег за период":"Mileage"}</div>
                    <div style={metricVal}>{v.kmV>0?numFmt(v.kmV.toFixed(1))+" км":"—"}</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div style={metricBox}>
                    <div style={metricLabel}>{t.tollPerKmMetric}</div>
                    <div style={{...metricVal,color:"var(--c-blue-500)"}}>{v.perKmV!=null?numFmt2(v.perKmV)+" EUR/км":"—"}</div>
                  </div>
                  <div style={metricBox}>
                    <div style={metricLabel}>{t.tollTopCountryMetric}</div>
                    <div style={metricVal}>{v.topV?`${v.topV.country} (${v.topPctV.toFixed(0)}%)`:"—"}</div>
                  </div>
                </div>
              </div>
            );
          })
        }
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1.1fr 1fr",gap:16,marginBottom:18,alignItems:"stretch"}}>
        <Card style={{height:"100%"}}>
          <h3 style={s.cardTitle}>🌍 {t.byCountry}</h3>
          {!countryEntries.length
            ? <div style={s.empty}>—</div>
            : <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {countryEntries.map(({country,cs,eur,count,pct})=>(
                <div key={country} style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:10,borderBottom:"1px solid var(--c-surface-2)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:12,fontWeight:800,color:"var(--c-muted)",background:"var(--c-surface-2)",padding:"4px 8px",borderRadius:6}}>{country}</span>
                    <div>
                      <div style={{fontWeight:700,fontSize:13,color:"var(--c-text-3)"}}>{FLAGS[country]||"🌍"} {country}</div>
                      <div style={{fontSize:12,color:"var(--c-muted-2)"}}>{t.tollCountryCount(count)}</div>
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:13,fontWeight:800,color:"var(--c-text-3)"}}>{numFmt2(eur)} EUR</div>
                    <div style={{fontSize:12,color:"var(--c-muted-2)"}}>{t.tollShareOf(pct.toFixed(1))}</div>
                  </div>
                </div>
              ))}
            </div>}
        </Card>
        {/* RIGHT — Расходы по автомобилям (replaces Dynamics chart) */}
        <Card style={{display:"flex",flexDirection:"column",height:"100%"}}>
          <div style={{...s.cardTitle,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>🚛 {t.tollExpensesByVehicle}</span>
            <span style={{fontSize:12,color:"var(--c-muted-2)",fontWeight:500,textTransform:"none"}}>{t.tollExpensesByVehicleSub}</span>
          </div>
          {!tollVehicleEntries.length
            ? <div style={s.empty}>—</div>
            : <div style={{display:"flex",flexDirection:"column",gap:12,paddingRight:4}}>
              {tollVehicleEntries.map(v=>{
                // Progress bar width = relative to top vehicle (max = 100%)
                const maxEurV = tollVehicleEntries[0]?.totalEurV || 1;
                const barPct = maxEurV>0?(v.totalEurV/maxEurV*100):0;
                return(
                  <div key={v.plate} style={{display:"flex",flexDirection:"column",gap:3,paddingBottom:6,borderBottom:"1px solid var(--c-surface-2)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:12,fontWeight:800,color:"var(--c-brand)",background:"var(--c-brand-bg-2)",padding:"3px 6px",borderRadius:4}}>{v.plate}</span>
                        <span style={{fontSize:12,color:"var(--c-muted-2)",fontWeight:500}}>{t.tollTransShort(v.count)}</span>
                      </div>
                      <span style={{fontSize:13,fontWeight:800,color:"var(--c-text-3)"}}>{numFmt2(v.totalEurV)} EUR</span>
                    </div>
                    <div style={{width:"100%",height:6,background:"var(--c-surface-2)",borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",background:"var(--c-brand-solid)",borderRadius:3,width:`${barPct}%`,transition:"width 0.3s ease"}}/>
                    </div>
                    <div style={{display:"flex",justifyContent:"flex-end"}}>
                      <span style={{fontSize:12,fontWeight:700,color:"var(--c-muted-2)"}}>{v.sharePct.toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>}
        </Card>
      </div>
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
          :<TxTable txns={paginatedTxns} t={t} showVolume={false} onDeleteManual={null}/>}
        <Pagination total={displayTxns.length} limit={TOLLS_PAGE_SIZE} offset={page*TOLLS_PAGE_SIZE}
                    onChange={setPage} lang={lang}/>
      </Card>
    </div>
  );
}

const TOLLS_PAGE_SIZE = 50;
