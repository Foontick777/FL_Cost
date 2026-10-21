import { useLocalState } from "../lib/hooks.js";
import { activePlatesForAllocation, extractTrailerPlates, isGeneral, isManual } from "../lib/tx.js";
import { fmtDMY, getPeriodDates, getPrevMonthDates } from "../lib/date.js";
import { apiFetch, apiGet, apiMutate } from "../lib/api.js";
import { defaultContractDescription } from "../ui/constants.js";
import { sumToEur, sumEurRows } from "../lib/money.js";
import { Card, CurrencyBadge, DeltaBadge, Pagination, PeriodSel, ShrunkSelect, SkeletonRows, sortTxns, MissingEurBanner, LegacyContractsNotice } from "../ui/components.jsx";
import { s, KPI_CORNER_PAD } from "../ui/styles.js";
import { MONO, fmtDate, fmtQty } from "../lib/format.js";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal.jsx";
import { ExpenseFormModal } from "../ui/ExpenseForm.jsx";
import { RecurringPanel } from "../ui/RecurringPanel.jsx";
import { fetchRecurring, toContractShape , contractEndpoints} from "../lib/recurring.js";
import { categoryOfTransaction, parseFuelType, useCategories } from "../lib/categories.js";

const NO_LEGACY_CONTRACTS=[];

/**
 * Страница «Общие расходы».
 *
 * Что изменилось (ТЗ §9): набор «офис / бухгалтерия / стоянка» перестал быть
 * единственно возможным. Раздел «Общие расходы» содержит готовые категории
 * (офис, бухгалтерия, коммунальные, интернет, телефония, банк, юридические, ПО,
 * реклама, уборка, охрана, прочее) и принимает любые свои категории. Расход
 * можно завести разово или сделать регулярным с любой периодичностью — без
 * права редактировать продолжительность договора (§8: «Аренда офиса 800 EUR/мес
 * — бессрочно»).
 *
 * Сохранено как было: годовые договоры «офис/бухгалтерия/стоянка» с графиком
 * платежей (они удобны, когда сумма в год известна и срок фиксирован),
 * авто-распределение по активным авто, дельта к прошлому периоду, таблица.
 */
export function GeneralPage({t, lang, period, setPeriod, custom, setCustom, refreshKey=0}){
  const [txns,setTxns]=useState([]);
  const [allOpPlates,setAllOpPlates]=useState([]);
  const [prevTxns,setPrevTxns]=useState([]);
  const [loading,setLoading]=useState(false);
  const [mstats,setMstats]=useState(null);
  const [stats,setStats]=useState(null);
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
  // null | "one-off" | "contract"
  const [modalMode,setModalMode]=useState(null);
  // Разовый или регулярный — открывается ОДНА и та же форма. Раньше для
  // регулярного ставился режим "expense", которого не ждало ни одно окно, и
  // кнопка «Добавить регулярный» не делала ничего.
  const [expenseType,setExpenseType]=useState("oneoff");
  const [page,setPage]=useState(0);
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_general_vehiclefilter","");
  const [sortMode,setSortMode]=useLocalState("fc_general_sortmode","date_desc");
  const [confirmId,setConfirmId]=useState(null);
  const [contractConfirm,setContractConfirm]=useState(null);
  const [recurringConfirm,setRecurringConfirm]=useState(null);
  const [contractsTab,setContractsTab]=useState("office");
  const [trailerPlates,setTrailerPlates]=useState(new Set());
  const catState=useCategories();
  const ru=lang==="RU";

  const generalFilterFn = tx => isManual(tx.source) && isGeneral(tx.fuel_type);

  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}_${refreshKey}`;
  const periodLbl=`${fmtDMY(dates.from)} — ${fmtDMY(dates.to)}`;

  // Панель регулярных платежей перечитывает только договоры: синхронизацию уже
  // делает load() — второй раз дёргать её из панели незачем.
  const loadRecurring=async()=>{
    try{ setRecurring(await fetchRecurring({section:"general"})); }
    catch(e){ setRecurring([]); }
  };

  const load=async()=>{
    setLoading(true);
    // Синхронизация договоров и универсальных регулярных расходов — до чтения
    // операций, чтобы пользователь сразу видел актуальные списания.
    // Старый /recurring-contracts/sync больше не вызываем: новые договоры живут в регулярных
    // расходах, и их синхронизирует загрузка блока регулярных платежей.
    try{ await apiFetch(`/recurring-expenses/sync`,{method:"POST"}); }catch(e){}
    const [d, ms, st] = await Promise.all([
      apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000`),
      apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`),
      apiGet(`/transactions/stats?date_from=${dates.from}&date_to=${dates.to}`),
    ]);
    const arr=Array.isArray(d)?d.filter(generalFilterFn):[];
    // Все номера за период: запасной источник «активных авто», если пробега нет.
    setAllOpPlates(Array.isArray(d)?[...new Set(d.map(tx=>tx.plate_number).filter(Boolean))]:[]);
    setTxns(arr);
    setTrailerPlates(extractTrailerPlates(d));
    setMstats(ms||null);
    setStats(st||null);
    setLoading(false);
    
    const rs=await apiGet(`/recurring-expenses/?section=general`);
    setRecurring(Array.isArray(rs)?rs:[]);
    try{
      const prevDates=getPrevMonthDates(dates.from,dates.to);
      const pb = await apiGet(`/transactions/?date_from=${prevDates.from}&date_to=${prevDates.to}&limit=50000`);
      setPrevTxns(Array.isArray(pb)?pb.filter(generalFilterFn):[]);
    }catch(e){ setPrevTxns([]); }
  };
  useEffect(()=>{load();},[datesKey]);
  useEffect(()=>{setPage(0);},[datesKey,vehicleFilter,sortMode]);
  const reload=()=>{catState.reload();load();loadRecurring();};

  // ── Годовой договор (офис/бухгалтерия/стоянка) ──

const cancelContract=async(c)=>{
    // Адрес выбирается по источнику договора (`_source`): id нового
    // договора лежит в другом пространстве, и старый адрес его не находил.
    const u=contractEndpoints(c,"recurring-contracts");
    await apiFetch(u.cancel,{method:"PATCH"});
    setContractConfirm(null);
    load();
  };

  const deleteContract=async(c)=>{
    const u=contractEndpoints(c,"recurring-contracts");
    await apiFetch(u.remove,{method:"DELETE"});
    setContractConfirm(null);
    load();
  };
;

  // ── Универсальный регулярный расход ──
  const cancelRecurring=async(id)=>{ await apiFetch(`/recurring-expenses/${id}/cancel`,{method:"PATCH"}); setRecurringConfirm(null); load(); };
  const deleteRecurring=async(id)=>{ await apiFetch(`/recurring-expenses/${id}`,{method:"DELETE"}); setRecurringConfirm(null); load(); };

  const remove=async(id)=>{
    const r=await apiMutate(`/expenses/${id}`,{method:"DELETE"});
    if(!r.ok) return;
    setTxns(prev=>prev.filter(tx=>tx.id!==id));
    setConfirmId(null);
  };

  // ── Категория строки: справочник, затем «хвост» fuel_type ──
  const LEGACY_LABEL={office:t.generalCategoryOffice,accounting:t.generalCategoryAccounting,parking:t.generalCategoryParking,other:t.generalCategoryOther};
  const bucketOf=(tx)=>{
    const direct=categoryOfTransaction(catState,tx);
    if(direct) return {key:`${direct.section}:${direct.code}`,cat:direct,name:direct.name,icon:direct.icon,color:direct.color};
    const p=parseFuelType(tx.fuel_type);
    if(p&&p.section==="general"){
      const c=catState.byKey[`general:${p.code}`];
      return {key:`general:${p.code}`,cat:c,name:(c&&c.name)||LEGACY_LABEL[p.code]||p.code.replace(/_/g," "),icon:c&&c.icon,color:c&&c.color};
    }
    return {key:`raw:${tx.fuel_type||"—"}`,cat:null,name:tx.fuel_type||"—",icon:null,color:null};
  };

  // ── Итоги ──
  const totalByCur = txns.reduce((m,tx)=>{m[tx.currency]=(m[tx.currency]||0)+tx.amount;return m;},{});
  const totalEur=sumEurRows(txns);

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

  const prevTotalEur=sumEurRows(prevTxns);
  const pctDelta=(cur,prev)=>{
    if(prev===null||prev===undefined||prev===0||cur===null||cur===undefined) return null;
    return (cur-prev)/Math.abs(prev)*100;
  };
  const totalDelta=pctDelta(totalEur,prevTotalEur);

  // ── Активные автомобили ──
  // По пробегу за период, а если пробега нет — по машинам с операциями в периоде.
  const activeArr = activePlatesForAllocation({
    mileageByVehicle: mstats?.by_vehicle || {},
    operationPlates: allOpPlates,
    trailerPlates,
  });
  const unassignedEur=totalEur;
  const redistPerVehicle=activeArr.length>0?unassignedEur/activeArr.length:0;

  const filteredTxns=txns.filter(tx=>{
    if(vehicleFilter && tx.plate_number!==vehicleFilter) return false;
    return true;
  });
  const displayTxns=sortTxns(filteredTxns,sortMode);
  const paginatedTxns=displayTxns.slice(page*GENERAL_PAGE_SIZE,(page+1)*GENERAL_PAGE_SIZE);
  const availVehicles=[...new Set(txns.map(tx=>tx.plate_number).filter(Boolean))].sort();

  const eurFmt=v=>v.toLocaleString(ru?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+" EUR";
  const numFmt2=v=>v.toLocaleString(ru?"ru-RU":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2});

  const kpiCard={background:"var(--c-surface)",border:"1px solid var(--c-border)",borderRadius:14,padding:"16px 18px",boxShadow:"0 2px 4px rgba(0,0,0,0.03)",position:"relative"};
  const kpiTitle={fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-muted-2)"};
  const kpiVal={fontSize:22,fontWeight:700,margin:"8px 0 4px",color:"var(--c-text-3)",whiteSpace:"nowrap"};
  const kpiSub={fontSize:12,color:"var(--c-muted-2)",marginBottom:8,paddingRight:KPI_CORNER_PAD};
  const kpiCorner=s.kpiCorner;

  // ── Статусы договоров ──
  const todayIso=new Date().toISOString().slice(0,10);
  const contractStatus=(c)=>{
    if(!c.is_active) return {key:"cancelled", label:t.generalContractCancelled, bg:"var(--c-danger-bg-2)", fg:"var(--c-danger-strong)"};
    if(c.start_date > todayIso) return {key:"future", label:t.generalContractFutureStart, bg:"var(--c-warn-bg)", fg:"var(--c-warn)"};
    if(c.end_date < todayIso)   return {key:"expired", label:t.generalContractExpired, bg:"var(--c-surface-2)", fg:"var(--c-muted)"};
    return {key:"active", label:t.generalContractActive, bg:"var(--c-success-bg)", fg:"var(--c-success)"};
  };
  const contractCatLabel=(cat)=>LEGACY_LABEL[cat]||((catState.byKey[`general:${cat}`]||{}).name)||cat;

  // Вкладки панели договоров: базовые + любые, по которым есть договоры.
  const contractTabCodes=useMemo(()=>{
    const codes=new Set(["office","accounting","parking"]);
    (allContracts||[]).forEach(c=>{ if(c.category) codes.add(c.category); });
    return Array.from(codes);
  },[allContracts]);
  useEffect(()=>{
    if(!contractTabCodes.includes(contractsTab)) setContractsTab(contractTabCodes[0]||"office");
  },[contractTabCodes.join(",")]);

  const freqLabel=(f)=>f==="monthly"?(ru?"ежемесячно":"monthly")
    :f==="quarterly"?(ru?"ежеквартально":"quarterly")
    :f==="yearly"?(ru?"ежегодно":"yearly")
    :(ru?"еженедельно":"weekly");

  return(
    <div style={{...s.page}} className="fc-content">
      <div className="fc-page-header" style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"nowrap",overflowX:"auto",gap:12,marginBottom:20,paddingBottom:4}}>
        <h1 style={{...s.pageTitle,fontSize:18,whiteSpace:"nowrap"}}>🏢 {t.general}</h1>
        <div className="fc-header-controls" style={{display:"flex",gap:8,flexWrap:"nowrap",alignItems:"center",flexShrink:0}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <button style={{...s.btn,whiteSpace:"nowrap"}} onClick={()=>{setExpenseType("recurring");setModalMode("expense");}}>{t.generalAddContract}</button>
          <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={()=>{setExpenseType("oneoff");setModalMode("expense");}}>{t.generalAddOneOff}</button>
        </div>
      </div>

      {modalMode==="expense"&&<ExpenseFormModal
        initialType={expenseType}
        section="general"
        catState={catState}
        lang={lang}
        defaultScope="company"
        onClose={()=>setModalMode(null)}
        onSaved={reload}
        titleOverride={t.generalAddOneOff}
      />}

      {/* KPI: Итого + по карточке на категорию с расходами */}
      <LegacyContractsNotice lang={lang} onDone={()=>{load();loadRecurring();}}/>
      <MissingEurBanner rows={txns} lang={lang}/>
      <div className="fc-kpi-scroll" style={{display:"flex",gap:12,overflowX:"auto",paddingBottom:12,marginBottom:16}}>
        <div style={{...kpiCard,flex:"0 0 220px"}}>
          <DeltaBadge pct={totalDelta} invert absolute/>
          <div style={{...kpiTitle,paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.generalTotalExpenses}</div>
          <div style={kpiVal}>{totalEur>0?eurFmt(totalEur):"—"}</div>
          <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
            <span>{ru?"За период":"For period"}</span>
          </div>
          <div style={{...kpiCorner}}><CurrencyBadge byCur={totalByCur} lang={lang}/></div>
        </div>
        {catRows.map(c=>(
          <div key={c.key} style={{...kpiCard,flex:"0 0 190px"}}>
            <div style={{...kpiTitle,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {c.icon?`${c.icon} `:""}{c.name}
            </div>
            <div style={{...kpiVal,color:"var(--c-sky)"}}>{c.eur>0?eurFmt(c.eur):"—"}</div>
            <div style={{...kpiSub,display:"flex",alignItems:"center",gap:6}}>
              <span>{c.count} {ru?"операций":"tx"}</span>
            </div>
            <div style={{...kpiCorner}}><CurrencyBadge byCur={c.byCur} lang={lang}/></div>
          </div>
        ))}
      </div>

      {unassignedEur>0.01 && activeArr.length>0 && (
        <div style={{
          background:"var(--c-info-bg)", border:"1px solid var(--c-info-border)", borderRadius:12,
          padding:"12px 16px", marginBottom:14,
          display:"flex", alignItems:"flex-start", gap:8,
        }}>
          <span style={{fontSize:16,flexShrink:0,lineHeight:1.4}}>⚙️</span>
          <span style={{fontSize:13, color:"var(--c-info)", lineHeight:1.4, wordBreak:"break-word", overflowWrap:"anywhere"}}>
            <strong>{t.generalAutoAllocTitle}:</strong>{" "}
            {t.generalAutoAllocBanner(eurFmt(unassignedEur), activeArr.length, eurFmt(redistPerVehicle), periodLbl)}
          </span>
        </div>
      )}

      {/* Регулярные платежи — общий блок (тот же, что на «Иных расходах»,
          страховке и прицепах). Здесь без карточек объектов: общие расходы к
          автомобилям не привязаны, а нераспределённая часть равномерно ложится
          на активные авто — это видно в KPI выше. */}
      <div style={{marginBottom:28}}>
        <RecurringPanel
          payments={recurring}
          loading={false}
          lang={lang}
          onReload={loadRecurring}
          onAdd={()=>{setExpenseType("recurring");setModalMode("expense");}}
                t={t}
/>
      </div>


      {/* Таблица операций */}
      <Card style={{padding:0,overflowX:"auto"}}>
        <div className="fc-table-header" style={{padding:"14px 18px",borderBottom:"1px solid var(--c-surface-2)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,flexShrink:0}}>{t.generalAllTransactions} ({displayTxns.length})</h3>
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
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:760}}>
            <thead><tr style={{background:"var(--c-hover)"}}>
              <th style={s.th}>{t.date}</th>
              <th style={s.th}>{t.category}</th>
              <th style={s.th}>{t.description}</th>
              <th style={s.th}>{t.generalSourceRecurring}</th>
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
                    <td style={s.td}>
                      <span style={{background:b.color?`color-mix(in srgb, ${b.color} 14%, transparent)`:"var(--c-info-bg-2)",color:b.color||"var(--c-sky)",fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12}}>
                        {b.icon?`${b.icon} `:""}{b.name}
                      </span>
                    </td>
                    <td style={{...s.td,fontWeight:600}}>{tx.station_address||"—"}</td>
                    <td style={s.td}>
                      <span style={{background:isAuto?"var(--c-info-bg)":"var(--c-surface-2)",color:isAuto?"var(--c-info-2)":"var(--c-muted)",fontWeight:600,padding:"2px 8px",borderRadius:6,fontSize:12}}>
                        {isAuto?t.generalSourceRecurring:t.generalSourceManual}
                      </span>
                    </td>
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
        <Pagination total={displayTxns.length} limit={GENERAL_PAGE_SIZE} offset={page*GENERAL_PAGE_SIZE}
                    onChange={setPage} lang={lang}/>
      </Card>

      {/* Модал: годовой договор */}
    </div>
  );
}

const GENERAL_PAGE_SIZE = 50;

// Годовые договоры поддерживают эти категории на бэкенде (срок + годовая сумма).
// Любая другая категория заводится универсальным регулярным расходом выше.
const RECURRING_CATEGORIES = ["office","accounting","parking"];
