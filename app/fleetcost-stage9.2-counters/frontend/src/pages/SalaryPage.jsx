import { getPeriodDates, getPrevMonthDates } from "../lib/date.js";
import { useLocalState } from "../lib/hooks.js";
import { isManual, isSalary } from "../lib/tx.js";
import { apiFetch, apiGet, apiMutate } from "../lib/api.js";
import { sumEurRows } from "../lib/money.js";
import { Card, CurrencyBadge, DeltaBadge, Pagination, PeriodSel, ShrunkSelect, SkeletonRows, sortTxns, MissingEurBanner } from "../ui/components.jsx";
import { s, KPI_CORNER_PAD } from "../ui/styles.js";
import { MONO, fmtDate, fmtQty } from "../lib/format.js";
import { ExpenseFormModal } from "../ui/ExpenseForm.jsx";
import { RecurringPanel } from "../ui/RecurringPanel.jsx";
import { fetchRecurring, syncRecurring } from "../lib/recurring.js";
import {
  categoriesForSection, categoryOfTransaction, salaryCodeOf, useCategories,
} from "../lib/categories.js";
import { useEffect, useMemo, useState } from "react";

/**
 * Страница «Зарплата».
 *
 * Что изменилось (ТЗ §6–7):
 *   • налоги/взносы больше не два зашитых виджета «ZUS» и «PIT-4». Виджеты
 *     строятся по фактически настроенным категориям раздела «Налоги и взносы»
 *     (ZUS и PIT остались в готовом наборе, поэтому для Польши ничего не
 *     меняется), а у компании из другой страны — свои налоги (ФСЗН, Lohnsteuer,
 *     социальные взносы…);
 *   • если налогов не настроено вовсе, вместо пустых виджетов показывается
 *     компактный блок «Налоги и взносы не настроены» с кнопкой «Добавить» —
 *     приложение не утверждает, что у всех есть ZUS и PIT;
 *   • выплату и налог можно завести из одной формы: они отличаются только
 *     разделом (зарплата ↔ налоги), а категория внутри раздела — любая.
 *
 * Сохранено как было: прямые выплаты по водителям, авто-распределение налогов
 * по активным автомобилям, «ЗП на 1 км», карточки по авто и таблица.
 */
export function SalaryPage({t, lang, period, setPeriod, custom, setCustom, refreshKey=0}){
  const [txns,setTxns]=useState([]);
  const [prevTxns,setPrevTxns]=useState([]);
  const [loading,setLoading]=useState(false);
  const [mstats,setMstats]=useState(null);
  const [prevMstats,setPrevMstats]=useState(null);
  const [vehicles,setVehicles]=useState([]);
  // null | "salary" | "salary_tax" — раздел, для которого открыта форма.
  const [formSection,setFormSection]=useState(null);
  // Разовый или регулярный платёж открывается формой.
  const [formType,setFormType]=useState("oneoff");
  // Регулярные выплаты и налоги: раньше создать их можно было, а посмотреть,
  // остановить или удалить — негде.
  const [recurring,setRecurring]=useState([]);
  const [recurringLoading,setRecurringLoading]=useState(false);
  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}_${refreshKey}`;
  const [page,setPage]=useState(0);
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_salary_vehiclefilter","");
  const [sortMode,setSortMode]=useLocalState("fc_salary_sortmode","date_desc");
  const [confirmId,setConfirmId]=useState(null);
  const catState=useCategories();
  const ru=lang==="RU";

  const salaryFilterFn = tx => isManual(tx.source) && isSalary(tx.fuel_type);

  const load=async()=>{
    setLoading(true);
    const [d, ms] = await Promise.all([
      apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000`),
      apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`)
    ]);
    setTxns(Array.isArray(d)?d.filter(salaryFilterFn):[]);
    setMstats(ms||null);
    setLoading(false);
    try{
      const prevDates=getPrevMonthDates(dates.from,dates.to);
      const [pb, pms] = await Promise.all([
        apiGet(`/transactions/?date_from=${prevDates.from}&date_to=${prevDates.to}&limit=50000`),
        apiGet(`/mileage/stats?date_from=${prevDates.from}&date_to=${prevDates.to}`)
      ]);
      setPrevTxns(Array.isArray(pb)?pb.filter(salaryFilterFn):[]);
      setPrevMstats(pms||null);
    }catch(e){setPrevTxns([]);setPrevMstats(null);}
  };
  useEffect(()=>{load();},[datesKey]);
  useEffect(()=>{setPage(0);},[datesKey,vehicleFilter,sortMode]);
  useEffect(()=>{ apiGet("/vehicles").then(d=>setVehicles(Array.isArray(d)?d:[])); },[]);
  const driverByPlate=vehicles.reduce((m,v)=>{ if(v.plate_number) m[v.plate_number]=v.driver_name||null; return m; },{});
  const loadRecurring=async()=>{
    setRecurringLoading(true);
    try{
      await syncRecurring();
      const [a,b]=await Promise.all([fetchRecurring({section:"salary"}),fetchRecurring({section:"salary_tax"})]);
      setRecurring([...a,...b]);
    }catch(e){ setRecurring([]); }
    setRecurringLoading(false);
  };
  useEffect(()=>{loadRecurring();},[datesKey]);
  const reload=()=>{catState.reload();load();loadRecurring();};

  const remove=async(id)=>{
    const r=await apiMutate(`/expenses/${id}`,{method:"DELETE"});
    if(!r.ok) return;
    setTxns(prev=>prev.filter(tx=>tx.id!==id));
    setConfirmId(null);
  };

  // ── Налоги определяются справочником категорий, а не зашитыми строками.
  // Пока справочник не загрузился, страховкой служат исторические коды zus/pit4
  // (см. lib/categories.js) — иначе ZUS на миг посчитался бы зарплатой водителя.
  const taxCats = useMemo(
    () => categoriesForSection(catState, "salary_tax", { includeInactive: false }),
    [catState.list],
  );
  const isTaxTx = (tx) => {
    const code=salaryCodeOf(tx.fuel_type);
    if(code===null) return false;
    if(taxCats.length) return taxCats.some(c=>c.code===code);
    return ["zus","pit4"].includes(code);
  };
  const isDirectSalary = tx => isSalary(tx.fuel_type) && !isTaxTx(tx);

  const allTxns=txns;
  const prevAllTxns=prevTxns;

  // ── Текущий период ──
  const salaryByCur=allTxns.filter(isDirectSalary).reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const salaryEur=sumEurRows(allTxns.filter(isDirectSalary));
  const totalByCur=allTxns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});

  // Налоги — построчно по категориям: карточка появляется на каждую категорию
  // раздела «Налоги и взносы», по которой в периоде есть операции.
  const taxRows = useMemo(()=>{
    const map=new Map();
    allTxns.filter(isTaxTx).forEach(tx=>{
      const cat=categoryOfTransaction(catState,tx);
      const code=salaryCodeOf(tx.fuel_type);
      const key=cat?cat.code:(code||"other");
      if(!map.has(key)) map.set(key,{key,cat,byCur:{},eur:0,count:0});
      const row=map.get(key);
      row.byCur[tx.currency]=(row.byCur[tx.currency]||0)+tx.amount;
      row.eur+=Number(tx.amount_eur||0);
      row.count+=1;
    });
    return Array.from(map.values()).sort((a,b)=>b.eur-a.eur);
  },[allTxns,catState.list]);

  const taxesEur=taxRows.reduce((sum,r)=>sum+r.eur,0);
  const taxesByCur=taxRows.reduce((m,r)=>{Object.entries(r.byCur).forEach(([c,v])=>{m[c]=(m[c]||0)+v;});return m;},{});
  const totalEur=salaryEur+taxesEur;

  // ── Предыдущий период ──
  const prevTotalEur=sumEurRows(prevAllTxns);

  // ── Пробег ──
  const mVehicles=mstats?.vehicles||{};
  const fleetKm=mstats?.total_km||0;
  const avgPerKm=fleetKm>0&&totalEur>0?totalEur/fleetKm:null;
  const prevFleetKm=prevMstats?.total_km||0;
  const prevAvgPerKm=prevFleetKm>0&&prevTotalEur>0?prevTotalEur/prevFleetKm:null;

  const pctDelta=(cur,prev)=>{
    if(prev===null||prev===undefined||prev===0||cur===null||cur===undefined) return null;
    return (cur-prev)/Math.abs(prev)*100;
  };
  const totalDelta=pctDelta(totalEur,prevTotalEur);
  const avgPerKmDelta=pctDelta(avgPerKm,prevAvgPerKm);

  // Распределение налогов/взносов по активным автомобилям (§7.1): «ЗП + налоги»
  // на 1 км считается с учётом приходящейся на авто доли налогов.
  const unassignedTaxesEur = taxesEur;
  const activePlates = new Set();
  allTxns.forEach(tx=>{ if(tx.plate_number && isDirectSalary(tx)) activePlates.add(tx.plate_number); });
  Object.entries(mVehicles).forEach(([p,v])=>{ if(v?.km>0) activePlates.add(p); });
  const activeArr = Array.from(activePlates).sort();
  const redistPerVehicle = activeArr.length>0 ? unassignedTaxesEur/activeArr.length : 0;

  // ── Статистика по автомобилям (прямые выплаты) ──
  const vehicleSalaryMap=allTxns.filter(isDirectSalary).reduce((m,tx)=>{
    const p=tx.plate_number||"UNKNOWN";
    if(!m[p]) m[p]={byCur:{},count:0};
    m[p].byCur[tx.currency]=(m[p].byCur[tx.currency]||0)+tx.amount;
    m[p].byCur.__eur = (m[p].byCur.__eur||0) + Number(tx.amount_eur||0);
    m[p].count++;
    return m;
  },{});
  const salaryVehiclePlates=Object.keys(vehicleSalaryMap).filter(p=>p!=="UNKNOWN").sort();
  const salaryVehicleEntries=salaryVehiclePlates.map(plate=>{
    const vs=vehicleSalaryMap[plate];
    const salaryEurV=(vs.byCur.__eur||0);
    const kmV=mVehicles[plate]?.km||0;
    const totalWithTaxesV=salaryEurV+redistPerVehicle;
    const ratePerKmV=kmV>0&&totalWithTaxesV>0?totalWithTaxesV/kmV:null;
    const sharePct=totalEur>0?totalWithTaxesV/totalEur*100:0;
    return {plate, ...vs, salaryEurV, kmV, totalWithTaxesV, ratePerKmV, sharePct};
  }).sort((a,b)=>b.totalWithTaxesV-a.totalWithTaxesV);

  const filteredTxns=allTxns.filter(tx=>{
    if(vehicleFilter && tx.plate_number!==vehicleFilter) return false;
    return true;
  });
  const displayTxns=sortTxns(filteredTxns,sortMode);
  const paginatedTxns=displayTxns.slice(page*SALARY_PAGE_SIZE,(page+1)*SALARY_PAGE_SIZE);
  const availVehicles=[...new Set(allTxns.map(tx=>tx.plate_number).filter(Boolean))].sort();

  const numFmt=n=>(n||0).toLocaleString(ru?"ru-RU":"en-US");
  const eurFmt=v=>v.toLocaleString(ru?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+" EUR";
  const numFmt2=v=>v.toLocaleString(ru?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2});

  const kpiCard={background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"}
  const kpiTitle={fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)"};
  const kpiVal={fontSize:22,fontWeight:700,margin:"8px 0 4px",color:"var(--c-text-3)",whiteSpace:"nowrap"};
  const kpiSub={fontSize:12,color:"var(--c-muted-2)",marginBottom:8,paddingRight:KPI_CORNER_PAD};
  const kpiCorner=s.kpiCorner;
  const metricBox={background:"var(--c-hover)",padding:"8px 12px",borderRadius:10};
  const metricLabel={fontSize:12,color:"var(--c-muted-2)",marginBottom:2,whiteSpace:"nowrap"};
  const metricVal={fontSize:13,fontWeight:600,color:"var(--c-text-3)",whiteSpace:"nowrap"};

  const catNameForTx=(tx)=>{
    const cat=categoryOfTransaction(catState,tx);
    if(cat) return cat.name;
    const code=salaryCodeOf(tx.fuel_type);
    return code||"—";
  };

  return(
    <div style={{...s.page}} className="fc-content">
      <div className="fc-page-header" style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"nowrap",overflowX:"auto",gap:12,marginBottom:20,paddingBottom:4}}>
        <h1 style={{...s.pageTitle,fontSize:18,whiteSpace:"nowrap"}}>👤 {t.salary}</h1>
        <div className="fc-header-controls" style={{display:"flex",gap:8,flexWrap:"nowrap",alignItems:"center",flexShrink:0}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <button style={{...s.btn,whiteSpace:"nowrap"}} onClick={()=>{setFormType("oneoff");setFormSection("salary_tax");}}>＋ {ru?"Налог / взнос":"Tax / contribution"}</button>
          <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={()=>{setFormType("oneoff");setFormSection("salary");}}>＋ {t.addSalary}</button>
        </div>
      </div>

      {formSection&&<ExpenseFormModal
        initialType={formType}
        section={formSection}
        catState={catState}
        vehicles={vehicles}
        lang={lang}
        defaultScope={formSection==="salary_tax"?"company":"vehicle"}
        onClose={()=>setFormSection(null)}
        onSaved={reload}
        titleOverride={formSection==="salary_tax"
          ? (ru?"Добавить налог / взнос":"Add tax / contribution")
          : t.addSalary}
      />}

      {/* KPI: Итого · Зарплаты · <динамические налоги> · ЗП на 1 км */}
      <MissingEurBanner rows={allTxns} lang={lang}/>
      <div className="fc-kpi-scroll" style={{display:"flex",gap:12,overflowX:"auto",paddingBottom:12,marginBottom:16}}>
        <div style={{...kpiCard,flex:"0 0 240px",position:"relative"}}>
          <DeltaBadge pct={totalDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.salaryTotalExpenses}</div>
          <div style={{...kpiVal,color:"var(--c-violet)"}}>{totalEur>0?eurFmt(totalEur):"—"}</div>
          <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
            <span>{ru?"За выбранный период":"For the period"}</span>
          </div>
          <div style={{...kpiCorner}}><CurrencyBadge byCur={totalByCur} lang={lang}/></div>
        </div>

        <div style={{...kpiCard,flex:"0 0 220px"}}>
          <div style={kpiTitle}>{t.salaryDrivers}</div>
          <div style={kpiVal}>{salaryEur>0?eurFmt(salaryEur):"—"}</div>
          <div style={kpiSub}>{t.salaryDriversSub(salaryVehicleEntries.length)} · {ru?"Прямые выплаты":"Direct payments"}</div>
        </div>

        {/* Налоги: по карточке на каждую настроенную категорию с операциями.
            Жёстких «ZUS» и «PIT-4» больше нет — есть раздел «Налоги и взносы». */}
        {taxRows.map(r=>(
          <div key={r.key} style={{...kpiCard,flex:"0 0 200px"}}>
            <div style={{...kpiTitle,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {(r.cat&&r.cat.icon)?`${r.cat.icon} `:""}{r.cat?r.cat.name:r.key}
            </div>
            <div style={{...kpiVal,color:"var(--c-warn)"}}>{r.eur>0?eurFmt(r.eur):"—"}</div>
            <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
              <span>{r.count} {ru?"операций":"tx"}</span>
            </div>
            <div style={{...kpiCorner}}><CurrencyBadge byCur={r.byCur} lang={lang}/></div>
          </div>
        ))}

        {!taxRows.length && (
          <div style={{...kpiCard,flex:"0 0 300px",borderStyle:"dashed"}}>
            <div style={kpiTitle}>{ru?"Налоги и взносы":"Taxes & contributions"}</div>
            <div style={{...kpiVal,fontSize:15,color:"var(--c-muted-2)",whiteSpace:"normal",lineHeight:1.35,margin:"10px 0 10px"}}>
              {ru
                ? "Налоги и взносы не настроены. Добавьте свои — ZUS/PIT доступны как готовые."
                : "No taxes configured yet. Add your own — ZUS/PIT are available as ready-made ones."}
            </div>
            <button style={{...s.btnPrimary,fontSize:12,padding:"6px 12px",whiteSpace:"nowrap"}}
                    onClick={()=>{setFormType("oneoff");setFormSection("salary_tax");}}>
              ＋ {ru?"Добавить налог / взнос":"Add tax / contribution"}
            </button>
          </div>
        )}

        <div style={{...kpiCard,flex:"0 0 240px",position:"relative"}}>
          <DeltaBadge pct={avgPerKmDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.salaryPerKm}</div>
          <div style={{...kpiVal,color:"var(--c-blue)"}}>{avgPerKm!=null?numFmt2(avgPerKm)+" EUR/км":"—"}</div>
          <div style={kpiSub}>{t.salaryPerKmSub}: {numFmt(fleetKm)} км</div>
        </div>
      </div>

      {/* Баннер распределения налогов */}
      {unassignedTaxesEur>0.01 && activeArr.length>0 && (
        <div style={{
          background:"var(--c-warn-bg)", border:"1px solid var(--c-warn-border)", borderRadius:12,
          padding:"12px 16px", marginBottom:14,
          display:"flex", alignItems:"flex-start", gap:8,
        }}>
          <span style={{fontSize:16,flexShrink:0,lineHeight:1.4}}>🏛️</span>
          <span style={{fontSize:13, color:"var(--c-warn-strong)", lineHeight:1.4, wordBreak:"break-word", overflowWrap:"anywhere"}}>
            <strong>{t.salaryAllocationTitle}:</strong>{" "}
            {ru
              ? `Налоги и взносы за период — ${eurFmt(taxesEur)}. Они распределяются по ${activeArr.length} активным авто: ${eurFmt(redistPerVehicle)} на автомобиль.`
              : `Taxes and contributions for the period — ${eurFmt(taxesEur)}. They are spread across ${activeArr.length} active vehicles: ${eurFmt(redistPerVehicle)} per vehicle.`}
          </span>
        </div>
      )}

      {/* Регулярные платежи: тот же блок, что и в остальных разделах. */}
      <div style={{marginBottom:16}}>
        <RecurringPanel
          payments={recurring}
          loading={recurringLoading}
          lang={lang}
          onReload={loadRecurring}
          onAdd={()=>{setFormType("recurring");setFormSection("salary");}}
          t={t} vehicles={vehicles}
        />
      </div>

      {/* Карточки автомобилей */}
      <div style={{fontSize:16,fontWeight:600,marginBottom:14,color:"var(--c-text-3)"}}>{t.salaryVehiclesTitle} ({salaryVehicleEntries.length})</div>
      <div className="fc-cards-scroll fc-equal-card-grid" style={{display:"flex",gap:16,overflowX:"auto",paddingBottom:12,marginBottom:28}}>
        {!salaryVehicleEntries.length
          ? <div style={s.empty}>{t.noData}</div>
          : salaryVehicleEntries.map(v=>{
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
                    {ru?"Доля":"Share"}: {v.sharePct.toFixed(1)}%
                  </span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                  <div style={metricBox}>
                    <div style={metricLabel}>{t.salaryPaidMetric}</div>
                    <div style={{...metricVal,color:"var(--c-violet)"}}>{numFmt2(v.salaryEurV)} EUR</div>
                  </div>
                  <div style={metricBox}>
                    <div style={metricLabel}>{t.salaryMileagePeriod}</div>
                    <div style={{...metricVal,color:"var(--c-blue-500)"}}>{v.kmV>0?numFmt(v.kmV.toFixed(1))+" км":"—"}</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div style={metricBox}>
                    <div style={metricLabel}>{t.salaryPaidWithTaxes}</div>
                    <div style={metricVal}>{numFmt2(v.totalWithTaxesV)} EUR</div>
                  </div>
                  <div style={metricBox}>
                    <div style={metricLabel}>{t.salaryRatePerKm}</div>
                    <div style={{...metricVal,color:"var(--c-blue)"}}>{v.ratePerKmV!=null?numFmt2(v.ratePerKmV)+" EUR/км":"—"}</div>
                  </div>
                </div>
              </div>
            );
          })
        }
      </div>

      {/* Таблица */}
      <Card style={{padding:0,overflowX:"auto"}}>
        <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.salaryAllTransactions} ({displayTxns.length})</h3>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginLeft:"auto"}}>
            <ShrunkSelect
              value={vehicleFilter}
              onChange={setVehicleFilter}
              placeholder={`🚛 ${ru?"Все авто":"All vehicles"}`}
              options={[
                {value:"", label:`🚛 ${ru?"Все авто":"All vehicles"}`},
                ...availVehicles.map(p=>({value:p, label:p}))
              ]}/>
            <ShrunkSelect
              value={sortMode}
              onChange={setSortMode}
              placeholder={`📅 ${ru?"Сначала новые":"Newest first"}`}
              options={[
                {value:"date_desc", label:`📅 ${ru?"Сначала новые":"Newest first"}`},
                {value:"date_asc", label:`📅 ${ru?"Сначала старые":"Oldest first"}`},
                {value:"amount_desc", label:`💰 ${ru?"По сумме (От большего":"By amount (High"}`},
                {value:"amount_asc", label:`💰 ${ru?"По сумме (От меньшего":"By amount (Low"}`},
              ]}/>
          </div>
        </div>
        {loading?<SkeletonRows rows={6}/>
        :!paginatedTxns.length?<div style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>{t.noData}</div>
        :<div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:700}}>
            <thead><tr style={{background:"var(--c-hover)"}}>
              <th style={s.th}>{t.date}</th>
              <th style={s.th}>{t.plate}</th>
              <th style={s.th}>{t.category}</th>
              <th style={s.th}>{t.description}</th>
              <th style={s.th}>{t.amount}</th>
              <th style={{...s.th,textAlign:"right",whiteSpace:"nowrap"}}>{t.actions}</th>
            </tr></thead>
            <tbody>
              {paginatedTxns.map(tx=>{
                const isConfirm=confirmId===tx.id;
                const tax=isTaxTx(tx);
                const cat=categoryOfTransaction(catState,tx);
                return(
                  <tr key={tx.id} style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                    <td style={s.td}>{fmtDate(tx.transaction_date)}</td>
                    <td style={s.td}>
                      {tx.plate_number
                        ?<span style={{background:"var(--c-surface-2)",color:"var(--c-text)",fontWeight:700,padding:"2px 8px",borderRadius:6,fontSize:12}}>{tx.plate_number}</span>
                        :<span style={{background:"var(--c-warn-bg)",color:"var(--c-warn)",fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12}}>{ru?"Без авто":"No vehicle"}</span>}
                    </td>
                    <td style={s.td}>
                      <span style={{
                        background:tax?"var(--c-violet-bg-2)":"var(--c-violet-bg)",
                        color:tax?"var(--c-violet-strong)":"var(--c-violet)",
                        fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12,
                      }}>
                        {(cat&&cat.icon)?`${cat.icon} `:""}{catNameForTx(tx)}
                      </span>
                    </td>
                    <td style={{...s.td,fontWeight:600}}>{tx.station_address||"—"}</td>
                    <td style={{...s.td,fontWeight:700,fontFamily:MONO,whiteSpace:"nowrap"}}>{fmtQty(tx.amount,2)} {tx.currency}</td>
                    <td style={{...s.td,textAlign:"right"}}>
                      <div style={{display:"inline-flex",alignItems:"center",gap:6}}>
                        {!isConfirm?(
                          <button
                            onClick={()=>setConfirmId(tx.id)}
                            title={t.actionDelete}
                            style={{padding:0,width:22,height:22,fontSize:12,fontWeight:700,border:"1px solid var(--c-danger-border)",borderRadius:6,background:"var(--c-surface)",color:"var(--c-danger)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>✕</button>
                        ):(
                          <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"3px 6px",background:"var(--c-danger-bg)",border:"1px solid var(--c-danger-border)",borderRadius:8,whiteSpace:"nowrap"}}>
                            <span style={{fontSize:12,fontWeight:600,color:"var(--c-danger-strong)"}}>{t.deleteConfirm}</span>
                            <button onClick={()=>remove(tx.id)} title={t.save} style={{padding:0,width:22,height:22,fontSize:13,fontWeight:700,border:"1px solid var(--c-success-solid)",borderRadius:6,background:"var(--c-success-bg)",color:"var(--c-success)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>✓</button>
                            <button onClick={()=>setConfirmId(null)} title={t.cancel} style={{padding:0,width:22,height:22,fontSize:13,fontWeight:700,border:"1px solid var(--c-danger)",borderRadius:6,background:"var(--c-danger-bg-2)",color:"var(--c-danger-strong)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>⊘</button>
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
        <Pagination total={displayTxns.length} limit={SALARY_PAGE_SIZE} offset={page*SALARY_PAGE_SIZE}
                    onChange={setPage} lang={lang}/>
      </Card>
    </div>
  );
}

const SALARY_PAGE_SIZE = 50;
