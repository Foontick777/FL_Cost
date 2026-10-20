import { useLocalState } from "../lib/hooks.js";
import { activePlatesForAllocation, extractTrailerPlates, isCarWash, isManual, isParking, isSvcFee } from "../lib/tx.js";
import { fmtDMY, getPeriodDates, getPrevMonthDates } from "../lib/date.js";
import { apiFetch, apiGet, apiMutate } from "../lib/api.js";
import { sumToEur, sumEurRows, rowEur } from "../lib/money.js";
import { Card, CurrencyBadge, DeltaBadge, Pagination, PeriodSel, ShrunkSelect, SkeletonRows, sortTxns, MissingEurBanner } from "../ui/components.jsx";
import { s, KPI_CORNER_PAD } from "../ui/styles.js";
import { MONO, fmtDate, fmtQty } from "../lib/format.js";
import { ExpenseFormModal } from "../ui/ExpenseForm.jsx";
import { categoryOfTransaction, parseFuelType, useCategories } from "../lib/categories.js";
import { fetchRecurring, syncRecurring } from "../lib/recurring.js";
import { RecurringPanel } from "../ui/RecurringPanel.jsx";
import { AssetCards } from "../ui/AssetCards.jsx";
import { buildAssetCards } from "../lib/assetCards.js";
import { useEffect, useMemo, useState } from "react";

/**
 * Страница «Иные расходы».
 *
 * Что изменилось (ТЗ §5) без потери прежней логики:
 *   • категории — динамические: список приходит из /expense-categories/
 *     (раздел «other»), а в форме есть «＋ Создать новую категорию»;
 *   • KPI и карточки по категориям строятся по факту: категория появилась в
 *     расходах — появилась карточка, своего столбца в аналитике и разбивка в
 *     карточке автомобиля. Раньше четыре столбца (Штрафы/Парковки/Ремонты/
 *     Прочее) были зашиты, и «Шиномонтаж» из примера ТЗ туда не помещался;
 *   • сервисные сборы E100 остаются отдельной системной категорией с
 *     источником E100 — они приходят автоматически и вручную не создаются;
 *   • нераспределённые расходы, авто-распределение по активным авто,
 *     дельта к прошлому периоду и таблица — сохранены как были;
 *   • один и тот же расход можно завести разово или сделать регулярным
 *     прямо в форме.
 */
export function OtherPage({t, lang, period, setPeriod, custom, setCustom, refreshKey=0}){
  const [txns,setTxns]=useState([]);
  const [allOpPlates,setAllOpPlates]=useState([]);
  const [prevTxns,setPrevTxns]=useState([]);
  const [loading,setLoading]=useState(false);
  const [mstats,setMstats]=useState(null);
  const [stats,setStats]=useState(null);
  const [vehicles,setVehicles]=useState([]);
  const [showForm,setShowForm]=useState(false);
  // Тип, с которым открывается форма: разовый расход или регулярный платёж.
  const [formType,setFormType]=useState("oneoff");
  const [recurring,setRecurring]=useState([]);
  const [recurringLoading,setRecurringLoading]=useState(false);
  const [formSection]=useState("other");
  const [page,setPage]=useState(0);
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_other_vehiclefilter","");
  const [sortMode,setSortMode]=useLocalState("fc_other_sortmode","date_desc");
  const [confirmId,setConfirmId]=useState(null);
  const [trailerPlates,setTrailerPlates]=useState(new Set());
  const catState=useCategories();
  const ru=lang==="RU";

  // Фильтр страницы: ручные расходы раздела «other» + сервисные сборы и
  // парковки/мойки, пришедшие из e100 (у них нет пользовательской категории).
  const filterFn = tx => {
    if(isManual(tx.source)){
      const parsed=parseFuelType(tx.fuel_type);
      if(parsed && parsed.section==="other") return true;
    }
    if(isSvcFee(tx.fuel_type)) return true;
    if(tx.source==="e100" && (isCarWash(tx.fuel_type)||isParking(tx.fuel_type))) return true;
    return false;
  };

  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}_${refreshKey}`;
  const periodLbl=`${fmtDMY(dates.from)} — ${fmtDMY(dates.to)}`;

  const load=async()=>{
    setLoading(true);
    const [d, ms, st] = await Promise.all([
      apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000`),
      apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`),
      apiGet(`/transactions/stats?date_from=${dates.from}&date_to=${dates.to}`),
    ]);
    setTxns(Array.isArray(d)?d.filter(filterFn):[]);
    // Все номера за период: запасной источник «активных авто», если пробега нет.
    setAllOpPlates(Array.isArray(d)?[...new Set(d.map(tx=>tx.plate_number).filter(Boolean))]:[]);
    setTrailerPlates(extractTrailerPlates(d));
    setMstats(ms||null); setStats(st||null); setLoading(false);
    try{
      const pd=getPrevMonthDates(dates.from,dates.to);
      const pb=await apiGet(`/transactions/?date_from=${pd.from}&date_to=${pd.to}&limit=50000`);
      setPrevTxns(Array.isArray(pb)?pb.filter(filterFn):[]);
    }catch(e){setPrevTxns([]);}
  };
  useEffect(()=>{ loadRecurring(); },[datesKey]);

  useEffect(()=>{load();},[datesKey]);
  useEffect(()=>{setPage(0);},[datesKey,vehicleFilter,sortMode]);
  useEffect(()=>{apiGet("/vehicles").then(d=>setVehicles(Array.isArray(d)?d:[]));},[]);
  // Регулярные платежи: при открытии страницы достраиваем наступившие списания
  // (sync) и забираем договоры раздела. Без sync пользователь видел бы договор
  // без свежих списаний, пока не нажмёт что-нибудь ещё.
  const loadRecurring=async()=>{
    setRecurringLoading(true);
    try{
      await syncRecurring();
      const rows=await fetchRecurring({section:"other"});
      setRecurring(rows);
    }catch(e){ setRecurring([]); }
    setRecurringLoading(false);
  };

  const driverByPlate=vehicles.reduce((m,v)=>{if(v.plate_number)m[v.plate_number]=v.driver_name||null;return m;},{});
  const reload=()=>{catState.reload();loadRecurring().then(load);};

  const remove=async(id)=>{const r=await apiMutate(`/expenses/${id}`,{method:"DELETE"});if(!r.ok) return;setTxns(prev=>prev.filter(tx=>tx.id!==id));setConfirmId(null);};

  // ── Категория строки: сначала по category_id, затем по «хвосту» fuel_type.
  // Импортированные из e100 парковки/мойки привязываются к одноимённым
  // системным категориям, чтобы попадать в общую аналитику, а не в «прочее».
  const bucketOf = (tx) => {
    const direct=categoryOfTransaction(catState,tx);
    if(direct) return {key:`${direct.section}:${direct.code}`, cat:direct, name:direct.name, icon:direct.icon, color:direct.color};
    if(isSvcFee(tx.fuel_type)){
      const c=catState.byKey["other:e100_service_fee"];
      return {key:"other:e100_service_fee", cat:c, name:(c&&c.name)||t.otherSvcFee, icon:(c&&c.icon)||"🧾", color:c&&c.color};
    }
    if(isCarWash(tx.fuel_type)){
      const c=catState.byKey["other:wash"];
      return {key:"other:wash", cat:c, name:(c&&c.name)||tx.fuel_type, icon:(c&&c.icon)||"🚿", color:c&&c.color};
    }
    if(isParking(tx.fuel_type)){
      const c=catState.byKey["other:parking"];
      return {key:"other:parking", cat:c, name:(c&&c.name)||tx.fuel_type, icon:(c&&c.icon)||"🅿️", color:c&&c.color};
    }
    const p=parseFuelType(tx.fuel_type);
    if(p){
      const c=catState.byKey[`${p.section}:${p.code}`];
      return {key:`${p.section}:${p.code}`, cat:c, name:(c&&c.name)||p.code.replace(/_/g," "), icon:c&&c.icon, color:c&&c.color};
    }
    return {key:`raw:${tx.fuel_type||"—"}`, cat:null, name:tx.fuel_type||"—", icon:null, color:null};
  };

  const SVC_FEE_KEY="other:e100_service_fee";
  const isSvcFeeTx = tx => bucketOf(tx).key===SVC_FEE_KEY;

  // ── Итоги по валютам и в EUR (исторический курс) ──
  const totalByCur=txns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const totalEur=sumEurRows(txns);
  const svcFeeByCur=txns.filter(isSvcFeeTx).reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const svcFeeEur=sumEurRows(txns.filter(isSvcFeeTx));

  const prevTotalEur=sumEurRows(prevTxns);
  const pctDelta=(cur,prev)=>{if(!prev||!cur)return null;return (cur-prev)/Math.abs(prev)*100;};
  const totalDelta=pctDelta(totalEur,prevTotalEur);

  // Активные авто: по пробегу за период, а если пробега нет — по машинам
  // с операциями в периоде (иначе распределения не происходит вовсе).
  const activeArr = activePlatesForAllocation({
    mileageByVehicle: mstats?.by_vehicle || {},
    operationPlates: allOpPlates,
    trailerPlates,
  });

  // Нераспределённые = расходы без привязки к авто (в т.ч. сервисные сборы и
  // общий платёж по прицепу). Распределяются по активным автомобилям.
  let unassignedEur = 0;
  const unassignedByCur = {};
  txns.forEach(tx=>{
    if(!tx.plate_number){
      unassignedEur += rowEur(tx);
      unassignedByCur[tx.currency] = (unassignedByCur[tx.currency]||0) + tx.amount;
      unassignedByCur.__eur = (unassignedByCur.__eur||0) + Number(tx.amount_eur||0);
    }
  });
  const redistPerVehicle = activeArr.length>0 ? unassignedEur/activeArr.length : 0;

  const filteredTxns = txns.filter(tx=>{if(vehicleFilter&&tx.plate_number!==vehicleFilter)return false;return true;});
  const displayTxns = sortTxns(filteredTxns, sortMode);
  const paginatedTxns = displayTxns.slice(page*OTHER_PAGE_SIZE,(page+1)*OTHER_PAGE_SIZE);
  const availVehicles = [...new Set(txns.map(tx=>tx.plate_number).filter(Boolean))].sort();

  const eurFmt = v => v.toLocaleString(ru?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+" EUR";
  const numFmt2 = v => v.toLocaleString(ru?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2});

  const kpiCard = {background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"};
  const kpiTitle = {fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)"};
  const kpiVal = {fontSize:22,fontWeight:700,margin:"8px 0 4px",color:"var(--c-text-3)",whiteSpace:"nowrap"};
  const kpiSub = {fontSize:12,color:"var(--c-muted-2)",marginBottom:8,paddingRight:KPI_CORNER_PAD};
  const kpiCorner=s.kpiCorner;
  const metricBox = {background:"var(--c-hover)",padding:"8px 12px",borderRadius:10};
  const metricLabel = {fontSize:12,color:"var(--c-muted-2)",marginBottom:2,whiteSpace:"nowrap"};
  const metricVal = {fontSize:13,fontWeight:600,color:"var(--c-text-3)",whiteSpace:"nowrap"};

  // ── Карточки авто «Разовые / Регулярные» (как на страховке/прицепах) ──
  // Сервисные сборы в карточки не попадают — они показаны отдельным KPI сверху
  // (как и раньше). Списания регулярных платежей за выбранный период
  // buildAssetCards берёт из транзакций источника "recurring", поэтому итог
  // в подвале карточки всегда = разовые + регулярные за период.
  const assetCards=useMemo(()=>buildAssetCards({
    txns: txns.filter(tx=>bucketOf(tx).key!==SVC_FEE_KEY),
    contracts: recurring,
    bucketOf,
  }),[txns,recurring,catState.list,t]);

  return (
    <div style={{...s.page}} className="fc-content">
      <div className="fc-page-header" style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"nowrap",overflowX:"auto",gap:12,marginBottom:20,paddingBottom:4}}>
        <h1 style={{...s.pageTitle,fontSize:18,whiteSpace:"nowrap"}}>💼 {t.other}</h1>
        <div className="fc-header-controls" style={{display:"flex",gap:8,flexWrap:"nowrap",alignItems:"center",flexShrink:0}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={()=>{setFormType("oneoff");setShowForm(true);}}>＋ {t.addExpense}</button>
        </div>
      </div>

      {showForm&&<ExpenseFormModal
        initialType={formType}
        section={formSection}
        catState={catState}
        vehicles={vehicles}
        lang={lang}
        defaultScope="vehicle"
        onClose={()=>setShowForm(false)}
        onSaved={reload}
        titleOverride={t.addExpense}
      />}

      {/* 4 KPI: Итого + Сервисные сборы + Нераспределённые + Кол-во операций */}
      <MissingEurBanner rows={txns} lang={lang}/>
      <div className="fc-kpi-scroll" style={{display:"grid",gridTemplateColumns:"repeat(4, minmax(180px, 1fr))",gap:12,overflowX:"auto",paddingBottom:12,marginBottom:16}}>
        <div style={{...kpiCard,position:"relative"}}>
          <DeltaBadge pct={totalDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.otherTotalForPeriod}</div>
          <div style={kpiVal}>{totalEur>0?eurFmt(totalEur):"—"}</div>
          <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
            <span>{t.otherTotalSub}</span>
          </div>
          <div style={{...kpiCorner}}><CurrencyBadge byCur={totalByCur} lang={lang}/></div>
        </div>
        <div style={kpiCard}>
          <div style={kpiTitle}>{t.otherSvcFee}</div>
          <div style={{...kpiVal,color:"var(--c-muted)"}}>{svcFeeEur>0?eurFmt(svcFeeEur):"—"}</div>
          <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
            <span>{t.otherSvcFeeSub}</span>
          </div>
          <div style={{...kpiCorner}}><CurrencyBadge byCur={svcFeeByCur} lang={lang}/></div>
        </div>
        <div style={kpiCard}>
          <div style={kpiTitle}>{ru?"Нераспределённые":"Unassigned"}</div>
          <div style={{...kpiVal,color:"var(--c-warn)"}}>{unassignedEur>0?eurFmt(unassignedEur):"—"}</div>
          <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
            <span>{ru?"Без привязки к авто":"Without vehicle"}</span>
          </div>
          <div style={{...kpiCorner}}><CurrencyBadge byCur={unassignedByCur} lang={lang}/></div>
        </div>
        <div style={kpiCard}>
          <div style={kpiTitle}>{t.otherTxCount}</div>
          <div style={{...kpiVal,color:"var(--c-brand)"}}>{txns.length}</div>
          <div style={kpiSub}>{t.otherTxCountSub}</div>
        </div>
      </div>

      {/* Баннер авто-распределения */}
      {unassignedEur>0.01 && activeArr.length>0 && (
        <div style={{background:"var(--c-info-bg)",border:"1px solid var(--c-info-border)",borderRadius:12,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"flex-start",gap:8}}>
          <span style={{fontSize:16,flexShrink:0,lineHeight:1.4}}>⚙️</span>
          <span style={{fontSize:13,color:"var(--c-info)",lineHeight:1.4,wordBreak:"break-word",overflowWrap:"anywhere"}}>
            <strong>{t.otherAutoAllocTitle}:</strong>{" "}
            {t.otherAutoAllocBanner(eurFmt(unassignedEur), activeArr.length, eurFmt(redistPerVehicle), periodLbl)}
          </span>
        </div>
      )}

      {/* Регулярные платежи: что списывается само и сколько осталось платить */}
      <div style={{marginBottom:16}}>
        <RecurringPanel
          payments={recurring}
          loading={recurringLoading}
          lang={lang}
          onReload={loadRecurring}
          onAdd={()=>{setFormType("recurring");setShowForm(true);}}
          emptyHint={ru
            ? "Активных регулярных платежей нет. Здесь появятся подписки, абонементы и любые повторяющиеся расходы."
            : "No active recurring payments. Subscriptions and any repeating expenses will appear here."}
                t={t} vehicles={vehicles}
/>
      </div>

      {/* Карточки автомобилей: «Разовые / Регулярные» + итог за период.
          Карточки одного размера, длинный список прокручивается внутри,
          поэтому при переключении между авто ничего не смещается. */}
      <div style={{marginBottom:28}}>
        <AssetCards
          cards={assetCards}
          lang={lang}
          title={t.otherCardsTitle}
          subtitle={t.otherCardsSubtitle}
          emptyText={t.otherNoVehicleCards}
          subtitleOf={(plate)=>driverByPlate[plate]||null}
        />
      </div>

      {/* Таблица операций */}
      <Card style={{padding:0,overflowX:"auto"}}>
        <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.otherAllTransactions} ({displayTxns.length})</h3>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginLeft:"auto"}}>
            <ShrunkSelect value={vehicleFilter} onChange={setVehicleFilter} placeholder={`🚛 ${ru?"Все авто":"All vehicles"}`} options={[{value:"",label:`🚛 ${ru?"Все авто":"All vehicles"}`},...availVehicles.map(p=>({value:p,label:p}))]}/>
            <ShrunkSelect value={sortMode} onChange={setSortMode} placeholder={`📅 ${ru?"Сначала новые":"Newest first"}`} options={[{value:"date_desc",label:`📅 ${ru?"Сначала новые":"Newest first"}`},{value:"date_asc",label:`📅 ${ru?"Сначала старые":"Oldest first"}`},{value:"amount_desc",label:`💰 ${ru?"По сумме (От большего":"By amount (High"}`},{value:"amount_asc",label:`💰 ${ru?"По сумме (От меньшего":"By amount (Low"}`}]}/>
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
                const b=bucketOf(tx);
                const isAuto=tx.source==="recurring";
                const isE100=tx.source!=="manual"&&tx.source!=="recurring";
                return(
                  <tr key={tx.id} style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                    <td style={s.td}>{fmtDate(tx.transaction_date)}</td>
                    <td style={s.td}>{tx.plate_number?<span style={{background:"var(--c-surface-2)",color:"var(--c-text)",fontWeight:700,padding:"2px 8px",borderRadius:6,fontSize:12}}>{tx.plate_number}</span>:<span style={{color:"var(--c-muted-2)"}}>—</span>}</td>
                    <td style={s.td}>
                      <span style={{background:b.color?`color-mix(in srgb, ${b.color} 14%, transparent)`:"var(--c-violet-bg)",color:b.color||"var(--c-violet)",fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12}}>
                        {b.icon?`${b.icon} `:""}{b.name}{isAuto?` · ${t.generalSourceRecurring}`:""}
                      </span>
                    </td>
                    <td style={{...s.td,fontWeight:600}}>
                      {isE100 ? (tx.fuel_type||"—") : (tx.station_address||"—")}
                    </td>
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
        <Pagination total={displayTxns.length} limit={OTHER_PAGE_SIZE} offset={page*OTHER_PAGE_SIZE}
                    onChange={setPage} lang={lang}/>
      </Card>
    </div>
  );
}

const OTHER_PAGE_SIZE = 50;
