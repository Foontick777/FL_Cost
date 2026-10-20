import { useLocalState } from "../lib/hooks.js";
import { extractTrailerPlates, isLeasing, isManual } from "../lib/tx.js";
import { categoryOfTransaction, parseFuelType, useCategories } from "../lib/categories.js";
import { fmtDMY, getPeriodDates, getPrevMonthDates } from "../lib/date.js";
import { apiFetch, apiGet, apiMutate } from "../lib/api.js";
import { sumToEur, toEur, sumEurRows, rowEur } from "../lib/money.js";
import { Card, CurrencyBadge, DeltaBadge, Pagination, PeriodSel, ShrunkSelect, SkeletonRows, sortTxns, MissingEurBanner, LegacyContractsNotice } from "../ui/components.jsx";
import { s, KPI_CORNER_PAD } from "../ui/styles.js";
import { MONO, fmtDate, fmtQty } from "../lib/format.js";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal.jsx";
import { RecurringPanel } from "../ui/RecurringPanel.jsx";
import { ExpenseFormModal } from "../ui/ExpenseForm.jsx";
import { AssetCards } from "../ui/AssetCards.jsx";
import { buildAssetCards } from "../lib/assetCards.js";
import { fetchRecurring, syncRecurring, toContractShape , contractEndpoints} from "../lib/recurring.js";

const NO_LEGACY_CONTRACTS=[];
/** Страница «Лизинг».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function LeasingPage({t, lang, period, setPeriod, custom, setCustom, refreshKey=0}){
  const [txns,setTxns]=useState([]);
  const [prevTxns,setPrevTxns]=useState([]);
  const [loading,setLoading]=useState(false);
  const [mstats,setMstats]=useState(null);
  const [stats,setStats]=useState(null);
  // Договоры старого формата перенесены в регулярные платежи (см. LegacyContractsNotice):
  // единственный источник договоров — /recurring-expenses.
  const contracts=NO_LEGACY_CONTRACTS;

  // Справочник категорий для формы расхода: без него список категорий пуст.
  const catState=useCategories();
  const [vehicles,setVehicles]=useState([]);
  const [modalMode,setModalMode]=useState(null);  // null | "expense" | "one-off"
  // Тип создаваемого расхода: лизинг перешёл на общий механизм регулярных
  // платежей, и договор теперь заводится той же формой, что и остальные
  // регулярные расходы — своей формы у лизинга больше нет.
  const [expenseType,setExpenseType]=useState("recurring");
  const [recurring,setRecurring]=useState([]);
  const [recurringLoading,setRecurringLoading]=useState(true);
  const loadRecurring=async()=>{
    setRecurringLoading(true);
    try{ await syncRecurring(); }catch(e){}
    try{ setRecurring(await fetchRecurring({section:"leasing"})); }
    finally{ setRecurringLoading(false); }
  };
  const [page,setPage]=useState(0);
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_leasing_vehiclefilter","");
  const [sortMode,setSortMode]=useLocalState("fc_leasing_sortmode","date_desc");
  const [confirmId,setConfirmId]=useState(null);
  const [contractConfirm,setContractConfirm]=useState(null);
  const [trailerPlates,setTrailerPlates]=useState(new Set());

  const leasingFilterFn = tx => isManual(tx.source) && isLeasing(tx.fuel_type);

  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}_${refreshKey}`;
  const periodLbl=`${fmtDMY(dates.from)} — ${fmtDMY(dates.to)}`;

  const load=async()=>{
    setLoading(true);
    try{
      // Старый /leasing-contracts/sync больше не вызываем: новые договоры живут
      // в регулярных расходах, и их синхронизирует loadRecurring(). Два вызова
      // означали две системы на одной странице.
    }catch(e){ /* non-fatal */ }
    const [d, ms, st] = await Promise.all([
      apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000`),
      apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`),
      apiGet(`/transactions/stats?date_from=${dates.from}&date_to=${dates.to}`),
    ]);
    const arr=Array.isArray(d)?d.filter(leasingFilterFn):[];
    setTxns(arr);
    setTrailerPlates(extractTrailerPlates(d));
    setMstats(ms||null);
    setStats(st||null);
    setLoading(false);
    try{
      const prevDates=getPrevMonthDates(dates.from,dates.to);
      const pb = await apiGet(`/transactions/?date_from=${prevDates.from}&date_to=${prevDates.to}&limit=50000`);
      setPrevTxns(Array.isArray(pb)?pb.filter(leasingFilterFn):[]);
    }catch(e){ setPrevTxns([]); }
  };
  // Оба вызова внутри эффекта: в теле компонента это setState на каждом
  // рендере и бесконечная перерисовка.
  useEffect(()=>{
    // Сначала sync регулярных платежей (создаёт наступившие списания и
    // пересчитывает курсы), затем — выборка транзакций: раньше оба вызова шли
    // параллельно, и созданные при открытии страницы списания не попадали в
    // карточки и таблицу до перезагрузки (гонка, дефект аудита stage9.1).
    setLoading(true);
    (async()=>{ await loadRecurring(); load(); })();
  },[datesKey]);
  useEffect(()=>{setPage(0);},[datesKey,vehicleFilter,sortMode]);
  useEffect(()=>{ apiGet("/vehicles").then(d=>setVehicles(Array.isArray(d)?d:[])); },[]);

  const driverByPlate=vehicles.reduce((m,v)=>{ if(v.plate_number) m[v.plate_number]=v.driver_name||null; return m; },{});

  // ── One-off expense ──

  // ── Recurring contract ──

const cancelContract=async(c)=>{
    // Адрес выбирается по источнику договора (`_source`): id нового
    // договора лежит в другом пространстве, и старый адрес его не находил.
    const u=contractEndpoints(c,"leasing-contracts");
    await apiFetch(u.cancel,{method:"PATCH"});
    setContractConfirm(null);
    load();
  };

  const deleteContract=async(c)=>{
    const u=contractEndpoints(c,"leasing-contracts");
    await apiFetch(u.remove,{method:"DELETE"});
    setContractConfirm(null);
    load();
  };

  const remove=async(id)=>{
    const r=await apiMutate(`/expenses/${id}`,{method:"DELETE"});
    if(!r.ok) return;                     // toast reports the reason
    setTxns(prev=>prev.filter(tx=>tx.id!==id));
    setConfirmId(null);
  };

  // ── Current period totals ──
  const totalByCur  = txns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const totalEur=sumEurRows(txns);   // исторический курс
  const prevTotalEur= sumEurRows(prevTxns);

  const pctDelta=(cur,prev)=>{
    if(prev===null||prev===undefined||prev===0||cur===null||cur===undefined) return null;
    return (cur-prev)/Math.abs(prev)*100;
  };
  const totalDelta=pctDelta(totalEur,prevTotalEur);

  // ── Active vehicles = those with mileage > 0 (this is the criterion for
  //    "vehicle worked in this period" — if a leased vehicle has no mileage,
  //    its leasing payment gets redistributed across active vehicles).
  const EXCLUDED_PLATES=new Set(["TRUCK","Unknown"]);
  const activeByMileage=new Set();
  Object.entries(mstats?.by_vehicle||{}).forEach(([p,km])=>{
    if(km>0 && !EXCLUDED_PLATES.has(p) && !trailerPlates.has(p)) activeByMileage.add(p);
  });
  const activeArr=Array.from(activeByMileage).sort();

  // Total active vehicles count (for "X из Y активных авто" KPI).
  // Only vehicles with mileage count as "active" — expense-only vehicles
  // (leased trucks that never moved) should NOT inflate the denominator.
  const uniqueActiveSet=new Set();
  (stats?.by_vehicle||[]).forEach(v=>{
    if(EXCLUDED_PLATES.has(v.plate_number)||trailerPlates.has(v.plate_number)) return;
    if(sumToEur(v.by_currency)<=0) return;
    if(activeByMileage.has(v.plate_number)) uniqueActiveSet.add(v.plate_number);
  });
  activeArr.forEach(p=>uniqueActiveSet.add(p));
  const totalActiveCount=uniqueActiveSet.size;

  // ── Leasing per vehicle ──
  const leasingByVehicle={};
  txns.forEach(tx=>{
    if(!tx.plate_number) return;
    const eur=rowEur(tx);   // исторический курс: см. rowEur
    leasingByVehicle[tx.plate_number]=(leasingByVehicle[tx.plate_number]||0)+eur;
  });

  // Unassigned leasing = leasing for vehicles NOT active by mileage
  let unassignedLeasingEur=0;
  const inactiveLeasingPlates=new Set();
  Object.entries(leasingByVehicle).forEach(([plate,eur])=>{
    if(!activeByMileage.has(plate)){
      unassignedLeasingEur+=eur;
      inactiveLeasingPlates.add(plate);
    }
  });
  const redistPerVehicle=activeArr.length>0?unassignedLeasingEur/activeArr.length:0;

  // ── Vehicles in lease (from contracts) ──
  // Only contracts that are still ACTIVE (not cancelled) AND not yet EXPIRED
  // (term_months not yet reached) count as "in lease". A contract whose term
  // has ended (e.g. 12-month lease started 18 months ago) is "paid off" and
  // should NOT be counted in the "Авто в лизинге" KPI.
  const today=new Date();
  const todayIso=today.toISOString().slice(0,10);
  // ── elapsedPaymentsCount ──
  // Returns how many of the contract's monthly charge dates have ALREADY PASSED
  // (i.e. the charge_date <= today). This exactly matches the number of
  // transactions sync would have generated.
  //
  // NOTE: a naive month-difference (monthsBetween) returns the wrong number
  // for the start month — e.g. start=01.05.2026, today=26.08.2026 returns 3,
  // but 4 charge dates have already passed (15.05, 15.06, 15.07, 15.08). That
  // caused the "3 из 48" bug. Counting actual charge dates is the correct
  // approach and matches the backend sync logic exactly.
  const elapsedPaymentsCount=(c)=>{
    const start=new Date(c.start_date);
    const todayMidnight=new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let count=0;
    for(let i=0; i<c.term_months; i++){
      const year=start.getFullYear() + Math.floor((start.getMonth() + i) / 12);
      const month=(start.getMonth() + i) % 12;
      const chargeDate=new Date(year, month, c.day_of_month);
      if(chargeDate <= todayMidnight) count++;
      else break;  // charge dates are generated in chronological order, so we can stop early
    }
    return count;
  };
  // Last charge date = start_date + (term_months - 1) months, on day_of_month.
  // e.g. start=01.06.2025, term=12, day=10 → last charge is 10.05.2026
  // (12 payments: 10.06.2025, 10.07.2025, ..., 10.05.2026).
  const lastChargeDateIso=(c)=>{
    const lastIdx=c.term_months-1;
    const start=new Date(c.start_date);
    const year=start.getFullYear() + Math.floor((start.getMonth() + lastIdx) / 12);
    const month=(start.getMonth() + lastIdx) % 12;
    const d=new Date(year, month, c.day_of_month);
    return d.toISOString().slice(0,10);
  };
  const isInLease=(c)=>{
    if(!c.is_active) return false;
    const elapsed=elapsedPaymentsCount(c);
    return elapsed < c.term_months;  // not yet paid off
  };
  // ЕДИНЫЙ список договоров: старые записи (для уже существующих договоров) и
  // новые из регулярных расходов. Пока KPI считался только по старым, страница
  // противоречила сама себе: в блоке платежей договор есть, а в «Авто в лизинге»
  // ноль.
  const allContracts=[...contracts, ...recurring.map(toContractShape)];
  const activeLeasingContracts=allContracts.filter(c=>c.is_active);  // ALL active (incl. expired-term) — used for cards
  const inLeaseContracts=activeLeasingContracts.filter(isInLease);  // only those still in active term
  const leasedPlates=new Set(inLeaseContracts.map(c=>c.plate_number));
  const vehiclesInLeaseCount=leasedPlates.size;

  // ── Remaining obligation (as of TODAY) ──
  let remainingObligationEur=0;
  inLeaseContracts.forEach(c=>{
    if(c._source==="recurring" && c.remaining_amount_eur!=null){
      // Остаток в евро посчитан СЕРВЕРОМ по курсу на сегодня: фронтендовский
      // пересчёт шёл по устаревшему захардкоженному курсу, а для валют без
      // курса давал NaN (дефект аудита stage9.1).
      remainingObligationEur += c.remaining_amount_eur;
      return;
    }
    if(c._source==="recurring" && c.remaining_amount!=null){
      // Сервер EUR-пересчёт не дал (курс валюты неизвестен) — показываем
      // остаток в валюте договора без деления на устаревший курс.
      return;
    }
    const elapsed=elapsedPaymentsCount(c);
    const remaining=Math.max(0, c.term_months - elapsed);
    remainingObligationEur += toEur(remaining * c.monthly_amount, c.currency);
  });

  // ── Cost per km ──
  const fleetKm=mstats?.total_km||0;
  const costPerKm=fleetKm>0?totalEur/fleetKm:null;

  // ── Filtered / sorted / paginated table ──
  const filteredTxns=txns.filter(tx=>{
    if(vehicleFilter && tx.plate_number!==vehicleFilter) return false;
    return true;
  });
  const displayTxns=sortTxns(filteredTxns,sortMode);
  const paginatedTxns=displayTxns.slice(page*LEASING_PAGE_SIZE,(page+1)*LEASING_PAGE_SIZE);
  const totalPages=Math.max(1,Math.ceil(displayTxns.length/LEASING_PAGE_SIZE));
  const availVehicles=[...new Set(txns.map(tx=>tx.plate_number).filter(Boolean))].sort();

  // ── Format helpers ──
  const eurFmt=v=>v.toLocaleString(lang==="RU"?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+" EUR";
  const numFmt2=v=>v.toLocaleString(lang==="RU"?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const numFmt0=v=>Math.round(v).toLocaleString(lang==="RU"?"ru-RU":"en-US");

  // ── KPI / card styles ──
  const kpiCard={background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"};
  const kpiTitle={fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)"};
  const kpiVal={fontSize:22,fontWeight:700,margin:"8px 0 4px",color:"var(--c-text-3)",whiteSpace:"nowrap"};
  const kpiSub={fontSize:12,color:"var(--c-muted-2)",marginBottom:8,paddingRight:KPI_CORNER_PAD};
  const kpiCorner=s.kpiCorner;
  const metricBox={background:"var(--c-hover)",padding:"8px 12px",borderRadius:10};
  const metricLabel={fontSize:12,color:"var(--c-muted-2)",marginBottom:2,whiteSpace:"nowrap"};
  const metricVal={fontSize:13,fontWeight:600,color:"var(--c-text-3)",whiteSpace:"nowrap"};

  // ── Contract status resolver ──
  const contractStatus=(c)=>{
    if(!c.is_active) return {key:"cancelled",label:t.leasingStatusCancelled,bg:"var(--c-danger-bg-2)",fg:"var(--c-danger-strong)"};
    // Future = first charge date has NOT yet passed
    const firstChargeDate=new Date(new Date(c.start_date).getFullYear(), new Date(c.start_date).getMonth(), c.day_of_month);
    const todayMidnight=new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if(firstChargeDate > todayMidnight) return {key:"future",label:t.leasingStatusFuture,bg:"var(--c-warn-bg)",fg:"var(--c-warn)"};
    // Expired = number of paid charge dates has reached the term
    const elapsed=elapsedPaymentsCount(c);
    if(elapsed>=c.term_months) return {key:"expired",label:t.leasingStatusExpired,bg:"var(--c-surface-2)",fg:"var(--c-muted)"};
    return {key:"active",label:t.leasingStatusActive,bg:"var(--c-success-bg)",fg:"var(--c-success)"};
  };

  // ── Contract progress (as of today) ──
  const contractProgress=(c)=>{
    const elapsed=elapsedPaymentsCount(c);
    const elapsedClamped=Math.max(0, Math.min(c.term_months, elapsed));
    const remaining=Math.max(0, c.term_months - elapsedClamped);
    const pct=c.term_months>0?(elapsedClamped/c.term_months*100):0;
    return {elapsed:elapsedClamped, remaining, pct};
  };

  const oneOffCats={payment:t.leasingCatPayment, deposit:t.leasingCatDeposit};
  const catLabelOf=(tx)=>{
    if(/manual_leasing_deposit/i.test(tx.fuel_type||"")) return t.leasingCatDeposit;
    return t.leasingCatPayment;
  };

  // ── Карточки авто «Разовые / Регулярные» (как на страховке/прицепах) ──
  // Категория строки: сначала справочник (category_id), затем «хвост»
  // fuel_type; исторические платёж/залог опознаются по старым кодам.
  const LEGACY_LEASING_LABELS={payment:t.leasingCatPayment, deposit:t.leasingCatDeposit};
  const bucketOf=(tx)=>{
    const direct=categoryOfTransaction(catState,tx);
    if(direct) return {key:`${direct.section}:${direct.code}`,cat:direct,name:direct.name,icon:direct.icon,color:direct.color};
    const p=parseFuelType(tx.fuel_type);
    if(p&&p.section==="leasing"){
      const c=catState.byKey[`leasing:${p.code}`];
      return {key:`leasing:${p.code}`,cat:c,name:(c&&c.name)||LEGACY_LEASING_LABELS[p.code]||p.code.replace(/_/g," "),icon:c&&c.icon,color:c&&c.color};
    }
    return {key:`raw:${tx.fuel_type||"—"}`,cat:null,name:tx.fuel_type||"—",icon:null,color:null};
  };
  // Договоры раздела (recurring) дают вкладку «Регулярные» с датами окончания,
  // списания за период суммируются из транзакций источника "recurring".
  const assetCards=useMemo(()=>buildAssetCards({txns,contracts:recurring,bucketOf}),[txns,recurring,catState.list]);

  return(
    <div style={{...s.page}} className="fc-content">
      {/* Header */}
      <div className="fc-page-header" style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"nowrap",overflowX:"auto",gap:12,marginBottom:20,paddingBottom:4}}>
        <h1 style={{...s.pageTitle,fontSize:18,whiteSpace:"nowrap"}}>📋 {t.leasing}</h1>
        <div className="fc-header-controls" style={{display:"flex",gap:8,flexWrap:"nowrap",alignItems:"center",flexShrink:0}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <button style={{...s.btn,whiteSpace:"nowrap"}} onClick={()=>{setExpenseType("recurring");setModalMode("expense");}}>{t.leasingAddContract}</button>
          <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={()=>{setExpenseType("oneoff");setModalMode("expense");}}>{t.leasingAddOneOff}</button>
        </div>
      </div>

      {/* 4 KPI cards */}
      <LegacyContractsNotice lang={lang} onDone={()=>{loadRecurring().then(load);}}/>
      <MissingEurBanner rows={txns} lang={lang}/>
      <div className="fc-kpi-scroll" style={{display:"flex",gap:12,overflowX:"auto",paddingBottom:12,marginBottom:16}}>
        {/* 1. Оплата за период — with DeltaBadge */}
        <div style={{...kpiCard,position:"relative",flex:"0 0 240px"}}>
          <DeltaBadge pct={totalDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.leasingTotalForPeriod}</div>
          <div style={kpiVal}>{totalEur>0?eurFmt(totalEur):"—"}</div>
          <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
            <span>{txns.length} {t.leasingPaidTx}</span>
          </div>
          <div style={{...kpiCorner}}><CurrencyBadge byCur={totalByCur} lang={lang}/></div>
        </div>
        {/* 2. Авто в лизинге */}
        <div style={{...kpiCard,flex:"0 0 220px"}}>
          <div style={kpiTitle}>{t.leasingVehiclesInLease}</div>
          <div style={{...kpiVal,color:"var(--c-text)"}}>
            {vehiclesInLeaseCount}
            <span style={{fontSize:14,fontWeight:600,color:"var(--c-muted-2)",marginLeft:6}}>{lang==="RU"?"из":"of"} {totalActiveCount}</span>
          </div>
          <div style={kpiSub}>{t.leasingVehiclesInLeaseSub(vehiclesInLeaseCount, totalActiveCount)}</div>
        </div>
        {/* 3. Остаток обязательств */}
        <div style={{...kpiCard,flex:"0 0 220px"}}>
          <div style={kpiTitle}>{t.leasingRemainingObligation}</div>
          <div style={{...kpiVal,color:"var(--c-violet)"}}>{remainingObligationEur>0?numFmt0(remainingObligationEur)+" EUR":"—"}</div>
          <div style={kpiSub}>{t.leasingRemainingObligationSub}</div>
        </div>
        {/* 4. Затраты лизинга / км */}
        <div style={{...kpiCard,flex:"0 0 220px"}}>
          <div style={kpiTitle}>{t.leasingCostPerKm}</div>
          <div style={{...kpiVal,color:"var(--c-brand)"}}>{costPerKm!=null?numFmt2(costPerKm)+" EUR/км":"—"}</div>
          <div style={kpiSub}>{t.leasingCostPerKmSub}: {numFmt0(fleetKm)} км</div>
        </div>
      </div>

      {/* Auto-allocation banner */}
      {unassignedLeasingEur>0.01 && activeArr.length>0 && (
        <div style={{
          background:"var(--c-info-bg)", border:"1px solid var(--c-info-border)", borderRadius:12,
          padding:"12px 16px", marginBottom:14,
          display:"flex", alignItems:"flex-start", gap:8,
        }}>
          <span style={{fontSize:16,flexShrink:0,lineHeight:1.4}}>⚙️</span>
          <span style={{fontSize:13, color:"var(--c-info)", lineHeight:1.4, wordBreak:"break-word", overflowWrap:"anywhere"}}>
            <strong>{t.leasingAutoAllocTitle}:</strong>{" "}
            {t.leasingAutoAllocBanner(eurFmt(unassignedLeasingEur), activeArr.length, eurFmt(redistPerVehicle), periodLbl)}
          </span>
        </div>
      )}

      {/* Регулярные платежи по лизингу — общий механизм: остановить, продолжить,
          удалить, прогресс «оплачено N из M» и остаток суммы. */}
      <div style={{marginBottom:20}}>
        <RecurringPanel
          section="leasing"
          payments={recurring}
          loading={recurringLoading}
          lang={lang}
          title={lang==="RU"?"Платежи по лизингу":"Leasing payments"}
          onReload={loadRecurring}
          onAdd={()=>{setExpenseType("recurring");setModalMode("expense");}}
          t={t} vehicles={vehicles}
        />
      </div>

      {/* Карточки автомобилей: «Разовые / Регулярные» + итог за период.
          Тот же вид, что на страховке и прицепах: на вкладке «Регулярные» видно,
          когда заканчивается договор (дата, срок списания, сколько осталось),
          а итог внизу — все расходы авто за выбранный период. */}
      <AssetCards
        cards={assetCards}
        lang={lang}
        title={t.leasingCardsTitle}
        subtitle={t.leasingCardsSubtitle}
        emptyText={t.leasingNoVehicleCards}
        subtitleOf={(plate)=>driverByPlate[plate]||null}
      />

      {/* Paginated transaction table */}
      <Card style={{padding:0,overflowX:"auto"}}>
        <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.leasingAllTransactions} ({displayTxns.length})</h3>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginLeft:"auto"}}>
            <ShrunkSelect
              value={vehicleFilter}
              onChange={setVehicleFilter}
              placeholder={`🚛 ${lang==="RU"?"Все авто":"All vehicles"}`}
              options={[
                {value:"", label:`🚛 ${lang==="RU"?"Все авто":"All vehicles"}`},
                ...availVehicles.map(p=>({value:p, label:p}))
              ]}/>
            <ShrunkSelect
              value={sortMode}
              onChange={setSortMode}
              placeholder={`📅 ${lang==="RU"?"Сначала новые":"Newest first"}`}
              options={[
                {value:"date_desc", label:`📅 ${lang==="RU"?"Сначала новые":"Newest first"}`},
                {value:"date_asc", label:`📅 ${lang==="RU"?"Сначала старые":"Oldest first"}`},
                {value:"amount_desc", label:`💰 ${lang==="RU"?"По сумме (От большего":"By amount (High"}`},
                {value:"amount_asc", label:`💰 ${lang==="RU"?"По сумме (От меньшего":"By amount (Low"}`},
              ]}/>
          </div>
        </div>
        {loading?<SkeletonRows rows={6}/>
        :!paginatedTxns.length?<div style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>{t.noData}</div>
        :<div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:760}}>
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
                const isAuto=tx.source==="recurring";
                return(
                  <tr key={tx.id} style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                    <td style={s.td}>{fmtDate(tx.transaction_date)}</td>
                    <td style={s.td}>
                      <span style={{background:"var(--c-surface-2)",color:"var(--c-text)",fontWeight:700,padding:"2px 8px",borderRadius:6,fontSize:12}}>{tx.plate_number}</span>
                    </td>
                    <td style={s.td}>
                      <span style={{background:isAuto?"var(--c-brand-bg-2)":"var(--c-surface-2)",color:isAuto?"var(--c-violet-deep)":"var(--c-muted)",fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12}}>
                        {catLabelOf(tx)}{isAuto?` · ${t.generalSourceRecurring}`:""}
                      </span>
                    </td>
                    <td style={{...s.td,fontWeight:600}}>{tx.station_address||"—"}</td>
                    <td style={{...s.td,fontWeight:700,fontFamily:MONO,whiteSpace:"nowrap"}}>{fmtQty(tx.amount,2)} {tx.currency}</td>
                    <td style={{...s.td,textAlign:"right"}}>
                      <div style={{display:"inline-flex",alignItems:"center",gap:6}}>
                        {!isConfirm?(
                          <button onClick={()=>setConfirmId(tx.id)} title={t.actionDelete}
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
        <Pagination total={displayTxns.length} limit={LEASING_PAGE_SIZE} offset={page*LEASING_PAGE_SIZE}
                    onChange={setPage} lang={lang}/>
      </Card>

      {/* Modal — one-off OR contract */}
      {modalMode==="expense"&&<ExpenseFormModal
        catState={catState}
        initialType={expenseType}
        section="leasing"
        defaultScope="vehicle"
        allowedScopes={["vehicle"]}
        t={t} lang={lang}
        vehicles={vehicles}
        onClose={()=>setModalMode(null)}
        onSaved={async()=>{ await loadRecurring(); await load(); }}/>}

      {/* Старая форма договора лизинга оставлена только для чтения ранее
          созданных договоров: создающий метод API теперь отвечает 409, а
          кнопка ведёт в общую форму регулярных расходов. */}
    </div>
  );
}

// so the user always sees up-to-date auto-generated monthly payments.
const LEASING_PAGE_SIZE = 50;
