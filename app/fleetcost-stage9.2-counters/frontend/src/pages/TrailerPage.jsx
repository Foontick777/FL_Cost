import { useLocalState } from "../lib/hooks.js";
import { activePlatesForAllocation, extractTrailerPlates, isManual, isTrailer } from "../lib/tx.js";
import { fmtDMY, getPeriodDates, getPrevMonthDates } from "../lib/date.js";
import { apiFetch, apiGet, apiMutate } from "../lib/api.js";
import { sumToEur, sumEurRows } from "../lib/money.js";
import { Card, CurrencyBadge, DeltaBadge, Pagination, PeriodSel, ShrunkSelect, SkeletonRows, sortTxns, MissingEurBanner, LegacyContractsNotice } from "../ui/components.jsx";
import { s, KPI_CORNER_PAD } from "../ui/styles.js";
import { MONO, fmtDate, fmtQty } from "../lib/format.js";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal.jsx";
import { ExpenseFormModal } from "../ui/ExpenseForm.jsx";
import { RecurringPanel } from "../ui/RecurringPanel.jsx";
import { AssetCards } from "../ui/AssetCards.jsx";
import { buildAssetCards } from "../lib/assetCards.js";
import { fetchRecurring, syncRecurring, toContractShape , contractEndpoints} from "../lib/recurring.js";
import { CategorySelect } from "../ui/CategorySelect.jsx";
import { categoryOfTransaction, parseFuelType, useCategories } from "../lib/categories.js";

const NO_LEGACY_CONTRACTS=[];

/**
 * Страница «Прицепы».
 *
 * Что изменилось (ТЗ §9):
 *   • категории прицепа не ограничены арендой/страхованием/CMR. Раздел
 *     «Прицепы» содержит и ремонт, и шиномонтаж, и техосмотр, и мойку, и
 *     лизинг, и «прочее» — плюс любая своя категория, создаваемая в форме;
 *   • KPI и разбивка в карточках строятся по факту расходов, поэтому новая
 *     категория сразу появляется в аналитике;
 *   • «разовый платёж» и «регулярный платёж» — это один и тот же выбор в форме
 *     (§4), поэтому аренда прицепа больше не обязана быть 12-месячным договором:
 *     можно завести бессрочный регулярный расход;
 *   • договоры с фиксированным сроком и суммой (/trailer-contracts/) остались —
 *     они по-прежнему нужны для аренды с известным сроком и графиком платежей.
 *
 * Сохранено как было: авто-распределение по активным автомобилям, панель
 * договоров с прогрессом платежей, дельта к прошлому периоду, таблица.
 */
export function TrailerPage({t, lang, period, setPeriod, custom, setCustom, refreshKey=0}){
  const [txns,setTxns]=useState([]);
  const [allOpPlates,setAllOpPlates]=useState([]);
  const [prevTxns,setPrevTxns]=useState([]);
  const [loading,setLoading]=useState(false);
  const [mstats,setMstats]=useState(null);
  const [stats,setStats]=useState(null);
  const [modalMode,setModalMode]=useState(null);
  // Разовый или регулярный: одна форма, два входа.
  const [expenseType,setExpenseType]=useState("oneoff");   // null | "expense" | "contract"
  const [page,setPage]=useState(0);
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_trailer_vehiclefilter","");
  const [sortMode,setSortMode]=useLocalState("fc_trailer_sortmode","date_desc");
  const [confirmId,setConfirmId]=useState(null);
  // Договоры старого формата перенесены в регулярные платежи (см. LegacyContractsNotice):
  // единственный источник договоров — /recurring-expenses.
  const contracts=NO_LEGACY_CONTRACTS;

  const [recurring,setRecurring]=useState([]);

  // ЕДИНЫЙ список: старые записи (для уже существующих договоров) + новые из
  // регулярных расходов. Пока экран читал только старую модель, новый договор
  // был виден в блоке платежей, но отсутствовал в карточках и KPI — прямое
  // противоречие внутри одной страницы.
  const allContracts=useMemo(()=>[...(contracts||[]), ...(recurring||[]).map(toContractShape)],
                            [contracts, recurring]);
  const [recurringLoading,setRecurringLoading]=useState(false);
  const [contractsTab,setContractsTab]=useState("rental");
  const [contractConfirm,setContractConfirm]=useState(null);
  const [trailerPlates,setTrailerPlates]=useState(new Set());
  const catState=useCategories();
  const ru=lang==="RU";

  const filterFn = tx => isManual(tx.source) && isTrailer(tx.fuel_type);
  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}_${refreshKey}`;
  const periodLbl=`${fmtDMY(dates.from)} — ${fmtDMY(dates.to)}`;

  // Регулярные платежи раздела: синхронизация (достроить наступившие списания)
  // и чтение договоров. Синхронизация именно здесь, а не только по кнопке —
  // иначе при открытии страницы договор выглядел бы без свежих списаний.
  const loadRecurring=async()=>{
    setRecurringLoading(true);
    try{
      await syncRecurring();
      setRecurring(await fetchRecurring({section:'trailer'}));
    }catch(e){ setRecurring([]); }
    setRecurringLoading(false);
  };

  const load=async()=>{
    setLoading(true);
    // Старый /trailer-contracts/sync больше не вызываем: новые договоры живут в регулярных
    // расходах, и их синхронизирует загрузка блока регулярных платежей.
    try{ await apiFetch(`/recurring-expenses/sync`,{method:"POST"}); }catch(e){}
    const [d, ms, st] = await Promise.all([
      apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000`),
      apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`),
      apiGet(`/transactions/stats?date_from=${dates.from}&date_to=${dates.to}`),
    ]);
    setTxns(Array.isArray(d)?d.filter(filterFn):[]);
    // Полный список номеров за период — запасной источник «активных авто», если
    // пробега за период нет (см. activePlatesForAllocation).
    setAllOpPlates(Array.isArray(d)?[...new Set(d.map(tx=>tx.plate_number).filter(Boolean))]:[]);
    setTrailerPlates(extractTrailerPlates(d));
    setMstats(ms||null); setStats(st||null); setLoading(false);
    
    try{
      const pd=getPrevMonthDates(dates.from,dates.to);
      const pb=await apiGet(`/transactions/?date_from=${pd.from}&date_to=${pd.to}&limit=50000`);
      setPrevTxns(Array.isArray(pb)?pb.filter(filterFn):[]);
    }catch(e){setPrevTxns([]);}
  };
  // Оба вызова — ВНУТРИ эффекта. Вызов в теле компонента (снаружи) — это
  // setState на каждом рендере и бесконечный цикл перерисовки.
  useEffect(()=>{
    // Сначала sync регулярных платежей (создаёт наступившие списания и
    // пересчитывает курсы), затем — выборка транзакций: раньше оба вызова шли
    // параллельно, и созданные при открытии страницы списания не попадали в
    // карточки и таблицу до перезагрузки (гонка, дефект аудита stage9.1).
    setLoading(true);
    (async()=>{ await loadRecurring(); load(); })();
  },[datesKey]);
  useEffect(()=>{setPage(0);},[datesKey,vehicleFilter,sortMode]);
  const reload=()=>{catState.reload();loadRecurring().then(load);};

const cancelContract=async(c)=>{
    // Адрес выбирается по источнику договора (`_source`): id нового
    // договора лежит в другом пространстве, и старый адрес его не находил.
    const u=contractEndpoints(c,"trailer-contracts");
    await apiFetch(u.cancel,{method:"PATCH"});
    setContractConfirm(null);
    load();
  };

  const deleteContract=async(c)=>{
    const u=contractEndpoints(c,"trailer-contracts");
    await apiFetch(u.remove,{method:"DELETE"});
    setContractConfirm(null);
    load();
  };
;

  const remove=async(id)=>{const r=await apiMutate(`/expenses/${id}`,{method:"DELETE"});if(!r.ok) return;setTxns(prev=>prev.filter(tx=>tx.id!==id));setConfirmId(null);};

  // ── Категория строки: справочник (раздел «Прицепы»), затем «хвост» fuel_type.
  // Исторические аренда/страхование/CMR продолжают опознаваться.
  const LEGACY_LABEL = {rental:t.trailersCatRental, insurance:t.trailersCatInsurance, cmr:t.trailersCatCmr, other:t.trailersCatOther};
  const bucketOf = (tx) => {
    const direct=categoryOfTransaction(catState,tx);
    if(direct) return {key:`${direct.section}:${direct.code}`,cat:direct,name:direct.name,icon:direct.icon,color:direct.color};
    const p=parseFuelType(tx.fuel_type);
    if(p&&p.section==="trailer"){
      const c=catState.byKey[`trailer:${p.code}`];
      return {key:`trailer:${p.code}`,cat:c,name:(c&&c.name)||LEGACY_LABEL[p.code]||p.code.replace(/_/g," "),icon:c&&c.icon,color:c&&c.color};
    }
    return {key:`raw:${tx.fuel_type||"—"}`,cat:null,name:tx.fuel_type||"—",icon:null,color:null};
  };

  const totalByCur = txns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const totalEur=sumEurRows(txns);

  // ── Расходы по категориям прицепов (динамически, по факту) ──
  const catRows=useMemo(()=>{
    const map=new Map();
    txns.forEach(tx=>{
      const b=bucketOf(tx);
      if(!map.has(b.key)) map.set(b.key,{key:b.key,name:b.name,icon:b.icon,color:b.color,byCur:{},eur:0,count:0});
      const row=map.get(b.key);
      row.byCur[tx.currency]=(row.byCur[tx.currency]||0)+tx.amount;
      row.eur+=Number(tx.amount_eur||0);
      row.count+=1;
    });
    return Array.from(map.values()).sort((a,b)=>b.eur-a.eur);
  },[txns,catState.list]);

  const prevTotalEur = sumEurRows(prevTxns);
  const pctDelta=(cur,prev)=>{if(!prev||!cur) return null; return (cur-prev)/Math.abs(prev)*100;};
  const totalDelta = pctDelta(totalEur, prevTotalEur);

  // Активные авто: по пробегу за период, а если пробега нет — по машинам,
  // у которых есть операции в периоде. Равномерное деление между ними.
  const activeArr = activePlatesForAllocation({
    mileageByVehicle: mstats?.by_vehicle || {},
    operationPlates: allOpPlates,
    trailerPlates,
  });
  const unassignedEur = totalEur;
  const redistPerVehicle = activeArr.length>0 ? unassignedEur/activeArr.length : 0;

  // ── Разбивка по прицепам (категории динамические) ──
  const trailerAgg = {};
  const trailerCatKeys = new Set();
  txns.forEach(tx=>{
    const p = tx.plate_number || "—";
    const b=bucketOf(tx);
    if(!trailerAgg[p]) trailerAgg[p] = {byCat:{}, total:{}, totalEur:0};
    const bucket = trailerAgg[p].byCat[b.key] || (trailerAgg[p].byCat[b.key]={eur:0,byCur:{}});
    bucket.byCur[tx.currency] = (bucket.byCur[tx.currency]||0) + tx.amount;
    bucket.eur += Number(tx.amount_eur||0);
    trailerAgg[p].total[tx.currency] = (trailerAgg[p].total[tx.currency]||0) + tx.amount;
    trailerAgg[p].totalEur += Number(tx.amount_eur||0);
    trailerCatKeys.add(b.key);
  });
  const trailerMeta = {};
  txns.forEach(tx=>{ const b=bucketOf(tx); if(!trailerMeta[b.key]) trailerMeta[b.key]={name:b.name,icon:b.icon,color:b.color}; });
  const trailerPlateList = Object.keys(trailerAgg).filter(p=>p!=="—").sort();
  const assetCards = useMemo(()=>buildAssetCards({txns,contracts:recurring,bucketOf}),[txns,recurring,catState.list]);

  // ── Договоры ──
  const contractsByPlate = {};
  (allContracts||[]).filter(c=>c.is_active).forEach(c=>{
    if(!contractsByPlate[c.plate_number]) contractsByPlate[c.plate_number] = [];
    contractsByPlate[c.plate_number].push(c);
  });
  const contractOverlapsPeriod = (c) => {
    const periodStart = new Date(dates.from);
    const periodEnd = new Date(dates.to);
    const lastIdx = c.term_months - 1;
    const start = new Date(c.start_date);
    const contractEnd = new Date(start.getFullYear() + Math.floor((start.getMonth()+lastIdx)/12), (start.getMonth()+lastIdx)%12, c.day_of_month);
    return start <= periodEnd && contractEnd >= periodStart;
  };
  const lastChargeDateIso = (c) => {
    const lastIdx = c.term_months - 1;
    const start = new Date(c.start_date);
    const year = start.getFullYear() + Math.floor((start.getMonth() + lastIdx) / 12);
    const month = (start.getMonth() + lastIdx) % 12;
    return new Date(year, month, c.day_of_month).toISOString().slice(0,10);
  };
  const todayForProgress = new Date();
  const elapsedPayments = (c) => {
    const start = new Date(c.start_date);
    const todayMid = new Date(todayForProgress.getFullYear(), todayForProgress.getMonth(), todayForProgress.getDate());
    let count = 0;
    for(let i=0; i<c.term_months; i++){
      const year = start.getFullYear() + Math.floor((start.getMonth() + i) / 12);
      const month = (start.getMonth() + i) % 12;
      const chargeDate = new Date(year, month, c.day_of_month);
      if(chargeDate <= todayMid) count++;
      else break;
    }
    return count;
  };
  const contractForCategory = (plate, category) => {
    const all = (contractsByPlate[plate]||[]).filter(c=>c.category===category);
    if (!all.length) return null;
    const overlapping = all.filter(contractOverlapsPeriod);
    const pool = overlapping.length ? overlapping : all;
    return pool.slice().sort((a,b) => (b.start_date||"").localeCompare(a.start_date||""))[0];
  };

  // Вкладки панели договоров: аренда и страхование — базовые, плюс любые
  // категории, по которым уже есть договоры (своя категория не должна
  // «потерять» свои договоры).
  const contractTabCodes = useMemo(()=>{
    const codes=new Set(["rental","insurance"]);
    (allContracts||[]).forEach(c=>{ if(c.category) codes.add(c.category); });
    return Array.from(codes);
  },[allContracts]);
  const contractTabLabel=(code)=>{
    if(LEGACY_LABEL[code]) return LEGACY_LABEL[code];
    const c=catState.byKey[`trailer:${code}`];
    return (c&&c.name)||code;
  };
  useEffect(()=>{
    if(!contractTabCodes.includes(contractsTab)) setContractsTab(contractTabCodes[0]||"rental");
  },[contractTabCodes.join(",")]);

  const filteredTxns = txns.filter(tx=>{if(vehicleFilter&&tx.plate_number!==vehicleFilter)return false;return true;});
  const displayTxns = sortTxns(filteredTxns, sortMode);
  const paginatedTxns = displayTxns.slice(page*TRAILER_PAGE_SIZE,(page+1)*TRAILER_PAGE_SIZE);
  const availTrailers = [...new Set(txns.map(tx=>tx.plate_number).filter(Boolean))].sort();

  const eurFmt = v => v.toLocaleString(ru?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+" EUR";
  const numFmt2 = v => v.toLocaleString(ru?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2});

  const kpiCard = {background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"};
  const kpiTitle = {fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)"};
  const kpiVal = {fontSize:22,fontWeight:700,margin:"8px 0 4px",color:"var(--c-text-3)",whiteSpace:"nowrap"};
  const kpiSub = {fontSize:12,color:"var(--c-muted-2)",marginBottom:8,paddingRight:KPI_CORNER_PAD};
  const kpiCorner=s.kpiCorner;

  return (
    <div style={{...s.page}} className="fc-content">
      <div className="fc-page-header" style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"nowrap",overflowX:"auto",gap:12,marginBottom:20,paddingBottom:4}}>
        <h1 style={{...s.pageTitle,fontSize:18,whiteSpace:"nowrap"}}>🚛 {t.trailers}</h1>
        <div className="fc-header-controls" style={{display:"flex",gap:8,flexWrap:"nowrap",alignItems:"center",flexShrink:0}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <button style={{...s.btn,whiteSpace:"nowrap"}} onClick={()=>{setExpenseType("recurring");setModalMode("expense");}}>{t.trailersAddContract}</button>
          <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={()=>{setExpenseType("oneoff");setModalMode("expense");}}>{t.trailersAddOneOff}</button>
        </div>
      </div>

      {modalMode==="expense"&&<ExpenseFormModal
        initialType={expenseType}
        section="trailer"
        catState={catState}
        lang={lang}
        defaultScope="trailer"
        onClose={()=>setModalMode(null)}
        onSaved={reload}
        titleOverride={t.trailersAddOneOff}
      />}

      {/* KPI: Итого + по одной карточке на категорию с расходами */}
      <LegacyContractsNotice lang={lang} onDone={()=>{loadRecurring().then(load);}}/>
      <MissingEurBanner rows={txns} lang={lang}/>
      <div className="fc-kpi-scroll" style={{display:"flex",gap:12,overflowX:"auto",paddingBottom:12,marginBottom:16}}>
        <div style={{...kpiCard,flex:"0 0 220px"}}>
          <DeltaBadge pct={totalDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.trailersTotalForPeriod}</div>
          <div style={kpiVal}>{totalEur>0?eurFmt(totalEur):"—"}</div>
          <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
            <span>{t.trailersTotalSub}</span>
          </div>
          <div style={{...kpiCorner}}><CurrencyBadge byCur={totalByCur} lang={lang}/></div>
        </div>
        {catRows.map(c=>(
          <div key={c.key} style={{...kpiCard,flex:"0 0 190px"}}>
            <div style={{...kpiTitle,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {c.icon?`${c.icon} `:""}{c.name}
            </div>
            <div style={{...kpiVal,color:"var(--c-warn)"}}>{c.eur>0?eurFmt(c.eur):"—"}</div>
            <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
              <span>{c.count} {ru?"операций":"tx"}</span>
            </div>
            <div style={{...kpiCorner}}><CurrencyBadge byCur={c.byCur} lang={lang}/></div>
          </div>
        ))}
      </div>

      {unassignedEur>0.01 && activeArr.length>0 && (
        <div style={{background:"var(--c-info-bg)",border:"1px solid var(--c-info-border)",borderRadius:12,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"flex-start",gap:8}}>
          <span style={{fontSize:16,flexShrink:0,lineHeight:1.4}}>⚙️</span>
          <span style={{fontSize:13,color:"var(--c-info)",lineHeight:1.4,wordBreak:"break-word",overflowWrap:"anywhere"}}>
            <strong>{t.trailersAutoAllocTitle}:</strong>{" "}
            {t.trailersAutoAllocBanner(eurFmt(unassignedEur), activeArr.length, eurFmt(redistPerVehicle), periodLbl)}
          </span>
        </div>
      )}

      {/* Регулярные платежи — тот же блок, что и на «Иных расходах»: один
          механизм договоров во всех разделах. */}
      <div style={{marginBottom:16}}>
        <RecurringPanel
          payments={recurring}
          loading={recurringLoading}
          lang={lang}
          onReload={loadRecurring}
          onAdd={()=>{setExpenseType("recurring");setModalMode("expense");}}
                t={t}
/>
      </div>


      {/* Карточки прицепов: «Разовые / Регулярные» + итог за период */}
      <AssetCards
        cards={assetCards}
        lang={lang}
        title={t.trailersCardsTitle}
        subtitle={ru?"Разовые операции и действующие регулярные платежи — отдельно; внизу общий итог по прицепу за период":"One-off operations and active recurring payments, separately; the period total is at the bottom"}
        emptyText={t.trailersNoContracts}
        totalLabel={t.trailersTotalPeriod}
      />


      <Card style={{padding:0,overflowX:"auto"}}>
        <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.trailersAllTransactions} ({displayTxns.length})</h3>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginLeft:"auto"}}>
            <ShrunkSelect value={vehicleFilter} onChange={setVehicleFilter} placeholder={`🚛 ${ru?"Все прицепы":"All trailers"}`} options={[{value:"",label:`🚛 ${ru?"Все прицепы":"All trailers"}`},...availTrailers.map(p=>({value:p,label:p}))]}/>
            <ShrunkSelect value={sortMode} onChange={setSortMode} placeholder={`📅 ${ru?"Сначала новые":"Newest first"}`} options={[{value:"date_desc",label:`📅 ${ru?"Сначала новые":"Newest first"}`},{value:"date_asc",label:`📅 ${ru?"Сначала старые":"Oldest first"}`},{value:"amount_desc",label:`💰 ${ru?"По сумме (От большего":"By amount (High"}`},{value:"amount_asc",label:`💰 ${ru?"По сумме (От меньшего":"By amount (Low"}`}]}/>
          </div>
        </div>
        {loading?<SkeletonRows rows={6}/>
        :!paginatedTxns.length?<div style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>{t.noData}</div>
        :<div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:760}}>
            <thead><tr style={{background:"var(--c-hover)"}}>
              <th style={s.th}>{t.date}</th>
              <th style={s.th}>{t.trailersPlate}</th>
              <th style={s.th}>{t.category}</th>
              <th style={s.th}>{t.description}</th>
              <th style={s.th}>{t.amount}</th>
              <th style={{...s.th,textAlign:"right",whiteSpace:"nowrap"}}>{t.actions}</th>
            </tr></thead>
            <tbody>
              {paginatedTxns.map(tx=>{
                const isConfirm=confirmId===tx.id;
                const b=bucketOf(tx);
                const isAuto=tx.source==="recurring";
                return(
                  <tr key={tx.id} style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                    <td style={s.td}>{fmtDate(tx.transaction_date)}</td>
                    <td style={s.td}><span style={{background:"var(--c-surface-2)",color:"var(--c-text)",fontWeight:700,padding:"2px 8px",borderRadius:6,fontSize:12}}>{tx.plate_number||"—"}</span></td>
                    <td style={s.td}>
                      <span style={{background:b.color?`color-mix(in srgb, ${b.color} 14%, transparent)`:"var(--c-violet-bg)",color:b.color||"var(--c-violet)",fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12}}>
                        {b.icon?`${b.icon} `:""}{b.name}{isAuto?` · ${t.generalSourceRecurring}`:""}
                      </span>
                    </td>
                    <td style={{...s.td,fontWeight:600}}>{tx.station_address||"—"}</td>
                    <td style={{...s.td,fontWeight:700,fontFamily:MONO,whiteSpace:"nowrap"}}>{fmtQty(tx.amount,2)} {tx.currency}</td>
                    <td style={{...s.td,textAlign:"right"}}>
                      <div style={{display:"inline-flex",alignItems:"center",gap:6}}>
                        {!isConfirm?(
                          <button onClick={()=>setConfirmId(tx.id)} title={t.actionDelete} style={{padding:0,width:22,height:22,fontSize:12,fontWeight:700,border:"1px solid var(--c-danger-border)",borderRadius:6,background:"var(--c-surface)",color:"var(--c-danger)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0}}>✕</button>
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
        <Pagination total={displayTxns.length} limit={TRAILER_PAGE_SIZE} offset={page*TRAILER_PAGE_SIZE}
                    onChange={setPage} lang={lang}/>
      </Card>


    </div>
  );
}

const TRAILER_PAGE_SIZE = 50;
