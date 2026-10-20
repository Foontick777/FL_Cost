import { useLocalState } from "../lib/hooks.js";
import { getPeriodDates, getPrevMonthDates, fmtDMY, isoFmt, parseISODate } from "../lib/date.js";
import { API, apiFetch, apiGet } from "../lib/api.js";
import { isAdBlue, isCarWash, isFuel, isGeneral, isIncome, isInsurance, isLeasing, isManual, isOther, isParking, isSalary, isSvcFee, isToll, isTrailer, txStatus } from "../lib/tx.js";
import { sectionOf, useCategories } from "../lib/categories.js";
import { sumToEur, rowEur } from "../lib/money.js";
import { s, KPI_CORNER_PAD } from "../ui/styles.js";
import { DONUT_AMOUNT_MAX_W, MONO, donutAmount, fmtMoney, fmtQty, fmtDateTime, greeting, greetName } from "../lib/format.js";
import { CurrencyBadge, DeltaBadge, Hint, IconBtn, InfoDot, PaginatedTxTable, PeriodSel, Segmented, SrcBadge, SrcFilter, SyncBtn, UnratedIcon } from "../ui/components.jsx";
import { FLAGS } from "../ui/constants.js";
import { Modal } from "../ui/Modal.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Страница «Дашборд».
 *
 *  РАСКЛАДКА. Прежняя версия состояла из четырёх самостоятельных рядов
 *  (4 KPI → 9 карточек расходов с прокруткой → полоса «распределение расходов»
 *  → 3 карточки аналитики с прокруткой). Один и тот же разрез показывался
 *  дважды: «Топливо 44%» было и в ряду карточек, и в полосе распределения, а
 *  страны и типы занимали два одинаковых по форме блока. Теперь:
 *
 *    1) 4 главных KPI                         — без изменений
 *    2) «Финансы по авто» + «Структура расходов» (кольцевая диаграмма)
 *    3) «География затрат» (страны / типы) + «Последние транзакции»
 *
 *  Полный реестр транзакций не исчез — он открывается кнопкой в выдвижной
 *  панели. Так на экране остаётся одна таблица с данными вместо двух.
 *
 *  ВАЖНО ПРО ДАННЫЕ. Ни одна цифра здесь не пересчитывается «примерно»: всё,
 *  что показано, получено из /transactions/stats, /transactions/, /mileage/stats
 *  и из тех же правил перераспределения общих расходов, что были раньше
 *  (см. комментарии по ходу кода). */
/** Нижняя граница пары «Финансы по авто + Структура расходов». Верхней нет:
 *  при раскрытии авто карточки должны вырасти, а не получить прокрутку. */
const PAIR_A_MIN=580;
/** Пара «География + Последние транзакции» — ровно такая высота. Список типов
 *  бывает в десятки строк, и выше этого виджет мешает: что не помещается,
 *  прокручивается внутри карточки, а соседний список транзакций встаёт той же
 *  высоты и заполняет место строками. */
const PAIR_B_H=620;

/** Высота СОДЕРЖИМОГО списка — по его строкам, а не по scrollHeight.
 *
 *  Это принципиально. Для прокручиваемого тела (flex:1; overflow-y:auto)
 *  scrollHeight = max(содержимое, высота тела). Если мерить им, а затем этой же
 *  величиной задавать высоту карточки, получается положительная обратная связь:
 *  карточка растёт от собственной высоты — по чуть-чуть и бесконечно. Именно так
 *  «Финансы по авто» и «Структура расходов» удлинялись сами по себе.
 *  Строки же от высоты контейнера не зависят, поэтому связь разрывается.
 */
function contentHeight(el){
  const kids=el.children;
  if(!kids.length) return 0;
  const first=kids[0].getBoundingClientRect();
  const last=kids[kids.length-1].getBoundingClientRect();
  const cs=getComputedStyle(el);
  const pad=(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);
  return Math.max(0,last.bottom-first.top)+pad;
}

/** Общая высота пары карточек: максимум из высот содержимого (см. contentHeight),
 *  но не меньше minPx и не больше maxPx — дальше список прокручивается внутри.
 *
 *  Так обе карточки пары встают по более высокой: у кого данных больше, тот и
 *  задаёт высоту, и вторая подстраивается под неё.
 *
 *  tick заставляет перемерить после прихода данных: внешний размер тел при этом
 *  не меняется, и ResizeObserver сам по себе не сработает.
 *  Тела, которые НЕ должны влиять на высоту, не регистрируем: список последних
 *  транзакций намеренно заполняет место, показывая столько строк, сколько влезло.
 */
function usePairHeight(refA,refB,minPx,maxPx,tick){
  const [h,setH]=useState(minPx);
  useEffect(()=>{
    const els=[refA,refB].map(r=>r&&r.current).filter(Boolean);
    if(!els.length) return;
    const measure=()=>{
      let want=minPx;
      els.forEach(el=>{
        // chrome — всё, кроме самого списка: шапка карточки и её отступы.
        const card=el.closest("section")||el.parentElement;
        const chrome=Math.max(0,card.getBoundingClientRect().height-el.getBoundingClientRect().height);
        want=Math.max(want,contentHeight(el)+chrome);
      });
      if(maxPx) want=Math.min(want,maxPx);
      // Порог в 1px: без него субпиксельные колебания давали лишние перерисовки.
      const next=Math.ceil(want);
      setH(prev=>Math.abs(prev-next)>1?next:prev);
    };
    measure();
    const ro=typeof ResizeObserver!=="undefined"?new ResizeObserver(measure):null;
    if(ro) els.forEach(el=>ro.observe(el));
    // После подгрузки шрифтов строки меняют высоту — повторяем замер.
    const late=setTimeout(measure,300);
    return()=>{ if(ro) ro.disconnect(); clearTimeout(late); };
  },[refA,refB,minPx,maxPx,tick]);
  return h;
}

export function DashboardPage({t,period,setPeriod,custom,setCustom,lang,refreshKey,user}){
  // Справочник категорий нужен KPI: раздел операции определяется по нему, а не по
  // названию категории в fuel_type.
  const catState=useCategories();
  const [stats,setStats]=useState(null);
  const [syncing,setSyncing]=useState(false);
  // Замок синхронизации общий на компанию и живёт на СЕРВЕРЕ: параллельный синк не
  // запустится (409), даже если его вызвать из другой вкладки или из «Импорта
  // данных». Здесь читаем это состояние, чтобы кнопка не выглядела доступной во
  // время чужой синхронизации.
  const [syncLock,setSyncLock]=useState(null);
  const [srcFilter,setSrcFilter]=useLocalState("fc_dashboard_srcfilter","");
  const [vehicleFilter,setVehicleFilter]=useLocalState("fc_dashboard_vehiclefilter","");
  const [countryFilter,setCountryFilter]=useLocalState("fc_dashboard_countryfilter","");
  const [sortMode,setSortMode]=useLocalState("fc_dashboard_sortmode","date_desc");
  // Переключатель «По странам / По типам» и раскрытая строка авто — тоже
  // запоминаются: после перезагрузки страницы пользователь возвращается к тому
  // разрезу, который смотрел.
  // Подсветка категории в «Структуре расходов». Два состояния, потому что
  // наведение и выбор — разные вещи: наведение показывается, пока курсор на
  // строке, а клик «закрепляет» категорию, чтобы можно было убрать курсор и
  // рассмотреть сегмент (наведение при этом уже не действует).
  const [hoverCat,setHoverCat]=useState("");
  const [pinnedCat,setPinnedCat]=useState("");
  const [geoMode,setGeoMode]=useLocalState("fc_dashboard_geomode","country");
  // Высоты пар считаем по содержимому (см. usePairHeight ниже).
  const vehBodyRef=useRef(null);   // тело «Финансы по авто»
  const donutBodyRef=useRef(null); // список «Структура расходов»
  const [expandedPlate,setExpandedPlate]=useLocalState("fc_dashboard_expanded","");
  const [txDrawer,setTxDrawer]=useState(false);
  const [availVehicles,setAvailVehicles]=useState([]);
  const [availCountries,setAvailCountries]=useState([]);
  const [mileageStats,setMileageStats]=useState(null);
  const [prevStats,setPrevStats]=useState(null);
  const [prevMileage,setPrevMileage]=useState(null);
  const [txBatch,setTxBatch]=useState([]);
  const dates=getPeriodDates(period,custom);
  const datesKey=`${dates.from}_${dates.to}`;

  const load=async()=>{
    const src=srcFilter?`&source=${srcFilter}`:"";
    const s=await apiGet(`/transactions/stats?date_from=${dates.from}&date_to=${dates.to}${src}`);
    setStats(s);
    const vehicles = await apiGet("/vehicles");
    if(Array.isArray(vehicles)) setAvailVehicles(vehicles.map(v=>v.plate_number).filter(Boolean).sort());
    const batch = await apiGet(`/transactions/?date_from=${dates.from}&date_to=${dates.to}&limit=50000${src}`);
    setTxBatch(Array.isArray(batch)?batch:[]);
    if(Array.isArray(batch)){
      const countries = [...new Set(batch.map(tx=>tx.country).filter(Boolean))].sort();
      setAvailCountries(countries);
    }
    const ms=await apiGet(`/mileage/stats?date_from=${dates.from}&date_to=${dates.to}`);
    setMileageStats(ms);

    // Previous month same-date-range, for the comparison badges. Best-effort:
    // if either call fails, comparison badges just don't render.
    try{
      const prevDates=getPrevMonthDates(dates.from,dates.to);
      const [ps,pm]=await Promise.all([
        apiGet(`/transactions/stats?date_from=${prevDates.from}&date_to=${prevDates.to}${src}`),
        apiGet(`/mileage/stats?date_from=${prevDates.from}&date_to=${prevDates.to}`),
      ]);
      setPrevStats(ps);setPrevMileage(pm);
    }catch(e){ setPrevStats(null);setPrevMileage(null); }
  };
  useEffect(()=>{load();},[datesKey,srcFilter,refreshKey]);

  const exportExcel=()=>{
    // Экспорт обязан совпадать с тем, что видно на экране. Таблица дашборда
    // фильтруется на сервере по source / plate_number / country
    // (см. PaginatedTxTable), а выгрузка отправляла только даты — бухгалтер
    // фильтровал «только Q8» и получал в Excel все источники.
    const qs=new URLSearchParams({date_from:dates.from,date_to:dates.to});
    if(srcFilter) qs.append("source",srcFilter);
    if(vehicleFilter) qs.append("plate_number",vehicleFilter);
    const url=API+"/transactions/export/excel?"+qs.toString();
    const a=document.createElement("a");
    a.href=url;
    a.download="fleetcost_export.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const loadSyncLock=useCallback(async()=>{
    try{
      const r=await apiGet("/sync/status");
      if(r) setSyncLock(r);
    }catch(e){}
  },[]);
  useEffect(()=>{ loadSyncLock(); },[loadSyncLock]);
  // Пока синхронизация идёт — следим за замком: он снимется, когда сервер
  // закончит, и кнопка снова станет доступной без перезагрузки страницы.
  useEffect(()=>{
    if(!syncing) return;
    const iv=setInterval(loadSyncLock,3000);
    return ()=>clearInterval(iv);
  },[syncing,loadSyncLock]);

  const sync=async()=>{
    setSyncing(true);
    try{
      const r=await apiFetch("/sync",{method:"POST"});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){
        // Раньше ответ 409 (замок занят) попадал в ветку успеха и показывался как
        // «Готово. Новых: undefined» — отказ выглядел завершённой синхронизацией.
        alert((lang==="RU"?"Синхронизация не выполнена: ":"Sync not performed: ")
              +(d.detail||(lang==="RU"?"неизвестная ошибка":"unknown error")));
        return;
      }
      alert(lang==="RU"?`Готово. Новых: ${d.new_transactions??0}`:`Done. New: ${d.new_transactions??0}`);
    }finally{
      setSyncing(false);
      loadSyncLock();
      load();
    }
  };

  const computeKpi=(stats)=>{
    const fuel={},toll={},adblue={},other={},salary={},insurance={},leasing={},general={},trailer={},income={};
    if(!stats?.by_fuel_type) return{fuel,toll,adblue,other,salary,insurance,leasing,general,trailer,income};
    Object.entries(stats.by_fuel_type).forEach(([ft,byCur])=>{
      let target;
      if(isIncome(ft)) target=income;
      else if(isAdBlue(ft)) target=adblue;
      else if(isToll(ft)) target=toll;
      else if(isSalary(ft)) target=salary;
      else if(isInsurance(ft)) target=insurance;
      else if(isLeasing(ft)) target=leasing;
      else if(isTrailer(ft)) target=trailer;
      else if(isGeneral(ft)) target=general;
      else if(isOther(ft)||isSvcFee(ft)) target=other;
      else target=fuel;
      Object.entries(byCur).forEach(([c,v])=>{target[c]=(target[c]||0)+v;});
    });
    return{fuel,toll,adblue,other,salary,insurance,leasing,general,trailer,income};
  };
  const kpi=computeKpi(stats);
  const allTotal={};
  [kpi.fuel,kpi.toll,kpi.adblue,kpi.other,kpi.salary,kpi.insurance,kpi.leasing,kpi.general,kpi.trailer].forEach(bc=>{
    Object.entries(bc).forEach(([c,v])=>{allTotal[c]=(allTotal[c]||0)+v;});
  });
  // Суммы в EUR берём у сервера: он считает по сохранённому курсу на дату
  // каждой операции (stats.eur). Прежде здесь стоял sumToEur по сырым
  // суммам — то есть по ТЕКУЩИМ курсам, и дашборд расходился с Excel-
  // экспортом, который берёт amount_eur (FC-001 в аудите). Фолбэк оставлен
  // на случай старого сервера без поля eur.
  const missingRate=stats?.eur?.missing_rate_count||0;
  const incomeEur=stats?.eur?.income??sumToEur(kpi.income);
  const expensesEur=stats?.eur?.expenses??sumToEur(allTotal);
  const profitEur=incomeEur-expensesEur;
  const profitPositive=profitEur>=0;

  const totalKm=mileageStats?.total_km||0;
  const costPerKm=totalKm>0?expensesEur/totalKm:null;
  const revPerKm=totalKm>0?incomeEur/totalKm:null;
  const marginPct=incomeEur>0?(profitEur/incomeEur*100):null;
  const profitPerKm=(costPerKm!==null&&revPerKm!==null)?revPerKm-costPerKm:null;

  // Previous-period comparison (best-effort — null if the fetch failed)
  const pctDelta=(cur,prev)=>{
    if(prev===null||prev===undefined||prev===0||cur===null||cur===undefined) return null;
    return (cur-prev)/Math.abs(prev)*100;
  };
  const prevFleetKm = prevMileage?.total_km||0;
  let prevIncomeEur=null,prevExpensesEur=null,prevProfitEur=null;
  if(prevStats){
    const pkpi=computeKpi(prevStats);
    const pAllTotal={};
    [pkpi.fuel,pkpi.toll,pkpi.adblue,pkpi.other,pkpi.salary,pkpi.insurance,pkpi.leasing,pkpi.general,pkpi.trailer].forEach(bc=>{
      Object.entries(bc).forEach(([c,v])=>{pAllTotal[c]=(pAllTotal[c]||0)+v;});
    });
    prevIncomeEur=prevStats?.eur?.income??sumToEur(pkpi.income);
    prevExpensesEur=prevStats?.eur?.expenses??sumToEur(pAllTotal);
    prevProfitEur=prevIncomeEur-prevExpensesEur;
  }
  const incomeDelta=pctDelta(incomeEur,prevIncomeEur);
  const expenseDelta=pctDelta(expensesEur,prevExpensesEur);
  const profitDelta=pctDelta(profitEur,prevProfitEur);

  // ── Merged per-vehicle table data ──
  // TRUCK (personal car, not commercial fleet) and Unknown (unattributed e100
  // fees) are excluded from the per-vehicle breakdown — they're still counted
  // in the company-wide totals above, just not shown as a "vehicle" row.
  const incomeByVehicleRaw={};
  let unassignedIncomeEur=0;
  txBatch.filter(tx=>isManual(tx.source)&&isIncome(tx.fuel_type)).forEach(tx=>{
    const eur=rowEur(tx);
    if(tx.plate_number) incomeByVehicleRaw[tx.plate_number]=(incomeByVehicleRaw[tx.plate_number]||0)+eur;
    else unassignedIncomeEur+=eur;
  });

  // Unassigned salary taxes (ZUS + PIT-4) — manual_salary_zus / manual_salary_pit4
  // These have no plate_number, so they're "unassigned expenses" that we
  // redistribute evenly across active vehicles (same logic as unassigned income).
  // Налоги без привязки к машине. Считаем по РАЗДЕЛУ справочника, а не по
  // isSalary(): под `manual_salary_*` лежат и выплаты, и налоги, поэтому обычная
  // зарплата водителя без номера машины попадала в «Налоги ZUS/PIT» и потом
  // перераспределялась как налог — то есть в чужой строке отчёта.
  let unassignedSalaryTaxesEur=0;
  txBatch.filter(tx=>sectionOf(catState, tx)==="salary_tax"&&!tx.plate_number).forEach(tx=>{
    unassignedSalaryTaxesEur+=rowEur(tx);
  });

  // Unassigned general expenses (office rent / accounting / other) —
  // manual_general_* transactions. They are added without a plate_number
  // (noVehicle=true on the GeneralPage form), therefore ALL general expenses
  // are "unassigned" and the full total is redistributed evenly across active
  // vehicles, exactly like salary taxes. The redistribution is reflected in
  // the «Финансы по авто» widget as a separate informational note.
  let unassignedGeneralEur=0;
  txBatch.filter(tx=>isManual(tx.source)&&isGeneral(tx.fuel_type)&&!tx.plate_number).forEach(tx=>{
    unassignedGeneralEur+=rowEur(tx);
  });

  // Unassigned leasing — manual_leasing_* transactions where the vehicle has
  // NO mileage in this period (it didn't work). These have plate_number, so
  // they're already counted in stats.by_vehicle for that plate. We need to
  // subtract them from the inactive vehicle's expense (so the leasing payment
  // is not attributed to a non-working vehicle) and add them to the unassigned
  // pool to be redistributed across active vehicles.
  const activeByMileageSet=new Set();
  Object.entries(mileageStats?.by_vehicle||{}).forEach(([p,km])=>{
    if(km>0 && !EXCLUDED_PLATES.has(p)) activeByMileageSet.add(p);
  });
  const leasingByVehicleMap={};
  txBatch.filter(tx=>isManual(tx.source)&&isLeasing(tx.fuel_type)&&tx.plate_number).forEach(tx=>{
    const eur=rowEur(tx);
    leasingByVehicleMap[tx.plate_number]=(leasingByVehicleMap[tx.plate_number]||0)+eur;
  });
  let unassignedLeasingEur=0;
  const inactiveLeasingPlates=new Set();
  Object.entries(leasingByVehicleMap).forEach(([plate,eur])=>{
    if(!activeByMileageSet.has(plate)){
      unassignedLeasingEur+=eur;
      inactiveLeasingPlates.add(plate);
    }
  });

  // Unassigned insurance — same logic as leasing: per-vehicle insurance
  // contracts whose vehicle had no mileage in the period. Get redistributed
  // across active vehicles.
  const insuranceByVehicleMap={};
  txBatch.filter(tx=>isManual(tx.source)&&isInsurance(tx.fuel_type)&&tx.plate_number).forEach(tx=>{
    const eur=rowEur(tx);
    insuranceByVehicleMap[tx.plate_number]=(insuranceByVehicleMap[tx.plate_number]||0)+eur;
  });
  let unassignedInsuranceEur=0;
  const inactiveInsurancePlates=new Set();
  Object.entries(insuranceByVehicleMap).forEach(([plate,eur])=>{
    if(!activeByMileageSet.has(plate)){
      unassignedInsuranceEur+=eur;
      inactiveInsurancePlates.add(plate);
    }
  });

  // Unassigned trailers — all trailer expenses are unassigned (trailers are
  // not vehicles in the Vehicle table; they have no mileage). Pool into the
  // general redistribution bucket, same as general expenses.
  let unassignedTrailerEur=0;
  txBatch.filter(tx=>isManual(tx.source)&&isTrailer(tx.fuel_type)).forEach(tx=>{
    unassignedTrailerEur+=rowEur(tx);
  });

  // Unassigned Other expenses — manual other expenses without plate AND service
  // fees (e100/Q8) without plate. These get redistributed across active vehicles
  // on the dashboard, exactly like salary taxes and general expenses.
  // ALSO includes e100 car wash and parking without plate (they're "Иные расходы"
  // too, just from e100 source instead of manual).
  let unassignedOtherEur=0;
  txBatch.filter(tx=>{
    if(tx.plate_number) return false;  // only without plate
    if(isOther(tx.fuel_type) && isManual(tx.source)) return true;
    if(isCarWash(tx.fuel_type) && tx.source==="e100") return true;
    if(isParking(tx.fuel_type) && tx.source==="e100") return true;
    if(isSvcFee(tx.fuel_type)) return true;
    return false;
  }).forEach(tx=>{
    unassignedOtherEur+=rowEur(tx);
  });

  // AdBlue/Diesel liter ratio per vehicle (from raw e100/Q8 transactions)
  const fuelVolByVehicle={};
  txBatch.forEach(tx=>{
    if(!tx.plate_number||!tx.volume) return;
    if(isAdBlue(tx.fuel_type)){
      fuelVolByVehicle[tx.plate_number]=fuelVolByVehicle[tx.plate_number]||{diesel:0,adblue:0};
      fuelVolByVehicle[tx.plate_number].adblue+=tx.volume;
    }else if(isFuel(tx.fuel_type,tx.source,tx.plate_number)){
      fuelVolByVehicle[tx.plate_number]=fuelVolByVehicle[tx.plate_number]||{diesel:0,adblue:0};
      fuelVolByVehicle[tx.plate_number].diesel+=tx.volume;
    }
  });

  // Commercial vehicles active this period = appear in expenses, income, or mileage.
  // HOWEVER: vehicles that have ONLY leasing transactions and no mileage are
  // "leasing-only inactive" — their leasing payment gets redistributed, so we
  // exclude them from commercialPlates (so they don't show as a row in the
  // merged table). If a vehicle has mileage, it stays (its leasing payment
  // stays with it, not redistributed).
  //
  // ALSO: trailer plates (e.g. "SW12345") must NEVER be in commercialPlates —
  // trailers are NOT vehicles. They appear in stats.by_vehicle because they
  // have transactions, but they have no mileage and no income, and their
  // expenses are redistributed as a whole (see unassignedTrailerEur).
  const trailerPlates=new Set();
  txBatch.filter(tx=>isTrailer(tx.fuel_type)&&tx.plate_number).forEach(tx=>trailerPlates.add(tx.plate_number));

  const commercialPlates=new Set();
  (stats?.by_vehicle||[]).forEach(v=>{
    const vehEur=stats?.eur?.expenses_by_vehicle?.[v.plate_number]??sumToEur(v.by_currency);
    if(!EXCLUDED_PLATES.has(v.plate_number)&&!trailerPlates.has(v.plate_number)&&vehEur>0) commercialPlates.add(v.plate_number);
  });
  Object.entries(incomeByVehicleRaw).forEach(([p,v])=>{ if(!EXCLUDED_PLATES.has(p)&&!trailerPlates.has(p)&&v>0) commercialPlates.add(p); });
  Object.entries(mileageStats?.by_vehicle||{}).forEach(([p,km])=>{ if(!EXCLUDED_PLATES.has(p)&&!trailerPlates.has(p)&&km>0) commercialPlates.add(p); });
  // Remove inactive-leasing plates (vehicles with leasing but no mileage and
  // no other activity) — their leasing total is added to the unassigned pool.
  inactiveLeasingPlates.forEach(p=>{
    // Only remove if the vehicle has no mileage and no income (its only
    // "activity" was the leasing payment). If it has income or mileage, keep
    // it — we'll subtract just the leasing amount from its expense below.
    const hasMileage=activeByMileageSet.has(p);
    const hasIncome=(incomeByVehicleRaw[p]||0)>0;
    if(!hasMileage && !hasIncome) commercialPlates.delete(p);
  });
  // Same for inactive-insurance plates.
  inactiveInsurancePlates.forEach(p=>{
    const hasMileage=activeByMileageSet.has(p);
    const hasIncome=(incomeByVehicleRaw[p]||0)>0;
    if(!hasMileage && !hasIncome) commercialPlates.delete(p);
  });

  const redistPerVehicle=commercialPlates.size>0?unassignedIncomeEur/commercialPlates.size:0;
  // Combined unassigned EXPENSES (salary taxes ZUS/PIT-4 + general + leasing
  // for inactive vehicles + trailers + insurance for inactive vehicles).
  // All categories are pooled into a single redistribution: one line in the
  // «Перераспределения» tooltip under «Финансы по авто» + the per-vehicle share
  // is added to each vehicle's expense column (mirror of how unassigned income
  // is added to each vehicle's income column).
  const unassignedExpensesEur=unassignedSalaryTaxesEur+unassignedGeneralEur+unassignedLeasingEur+unassignedTrailerEur+unassignedInsuranceEur+unassignedOtherEur;
  const redistPerVehicleExpenses=commercialPlates.size>0?unassignedExpensesEur/commercialPlates.size:0;

  const mergedVehicleRows=[...commercialPlates].map(plate=>{
    const expenseRow=(stats?.by_vehicle||[]).find(v=>v.plate_number===plate);
    const baseExpense=expenseRow?(stats?.eur?.expenses_by_vehicle?.[expenseRow.plate_number]??sumToEur(expenseRow.by_currency)):0;
    // If this vehicle's leasing was redistributed (inactive, but it still
    // appears as a row because it has income or mileage), subtract its leasing
    // amount from the base expense (it's being redistributed, not counted as
    // this vehicle's direct cost).
    const leasingForThis=inactiveLeasingPlates.has(plate)?(leasingByVehicleMap[plate]||0):0;
    // Same for insurance — subtract if redistributed.
    const insuranceForThis=inactiveInsurancePlates.has(plate)?(insuranceByVehicleMap[plate]||0):0;
    // Add the per-vehicle share of unassigned expenses.
    const expense=baseExpense - leasingForThis - insuranceForThis + redistPerVehicleExpenses;
    const income=(incomeByVehicleRaw[plate]||0)+redistPerVehicle;
    const profit=income-expense;
    const km=mileageStats?.by_vehicle?.[plate]||0;
    const vol=fuelVolByVehicle[plate];
    const ratio=(vol&&vol.diesel>0)?(vol.adblue/vol.diesel*100):null;
    const eurPerKm=km>0?expense/km:null;
    // Прямая выручка/расход без перераспределения — из тех же строк
    // by_vehicle, что пришли с сервера. Нужны для честного сравнения с прошлым
    // периодом: сравнивать «расход с долей общих» против прошлого «прямого»
    // было бы сравнением разных величин.
    const prevExpenseRow=(prevStats?.by_vehicle||[]).find(v=>v.plate_number===plate);
    const prevDirectExpense=prevExpenseRow?(prevStats?.eur?.expenses_by_vehicle?.[prevExpenseRow.plate_number]??sumToEur(prevExpenseRow.by_currency)):null;
    return{plate,driver:expenseRow?.driver_name,expense,income,profit,km,ratio,eurPerKm,directExpense:baseExpense,prevDirectExpense};
  }).sort((a,b)=>b.profit-a.profit);

  const anyRedistributed=unassignedIncomeEur>0.01&&commercialPlates.size>0;
  const anyRedistributedExpenses=unassignedExpensesEur>0.01&&commercialPlates.size>0;

  // ── Структура расходов: один список категорий на всё ──
  // Раньше этот же разрез рисовался трижды: ряд карточек, полоса
  // «распределение по типам» и столбики в блоке аналитики. Теперь источник
  // один — и кольцевая диаграмма, и вкладка «По типам», и детализация по авто
  // берут данные отсюда, поэтому разойтись они не могут.
  // Серверные суммы по типам операций → по категориям. Классификатор тот же
  // (catKeyOf), что и в computeKpi, поэтому итоги сходятся с шапкой.
  const eurByCategory={};
  Object.entries(stats?.eur?.expenses_by_fuel_type||{}).forEach(([ft,v])=>{
    const k=catKeyOf(ft);
    if(k!=="income") eurByCategory[k]=(eurByCategory[k]||0)+v;
  });

  const compositionParts=CATS
    .map(c=>({key:c.key,label:t[c.label],icon:c.icon,color:c.color,byCur:kpi[c.key],eur:eurByCategory[c.key]??sumToEur(kpi[c.key])}))
    .filter(p=>p.eur>0)
    .sort((a,b)=>b.eur-a.eur);
  const donutTotal=compositionParts.reduce((acc,p)=>acc+p.eur,0);
  // Какая категория подсвечена: закреплённая кликом важнее наведения.
  const activeCat=pinnedCat||hoverCat;
  const donutBg=donutGradient(compositionParts,activeCat,"var(--c-border-2)")
    || "var(--c-surface-3)";
  // Сумма в центре кольца и её кегль: считает donutAmount (lib/format.js) —
  // размер подбирается по длине строки, чтобы «€» не переносился и текст не
  // налезал на кольцо при больших суммах.
  const donutCenter=donutAmount(expensesEur);
  // Имя для приветствия — из /auth/me (проп user), см. greetName().
  const userName=greetName(user);

  // ── География затрат: страны или типы за выбранный период ──
  // Два прежних блока были одинаковыми по форме и описывали один и тот же
  // период с разных сторон, поэтому объединены в один с переключателем.
  const geoCountryRows=Object.entries(stats?.by_country||{}).map(([code,byCur])=>{
    const eur=stats?.eur?.expenses_by_country?.[code]??sumToEur(byCur);
    return{key:code,short:code,label:`${FLAGS[code]||"🌍"} ${code}`,eur,byCur,color:"var(--c-brand-solid)"};
  }).filter(r=>r.eur>0).sort((a,b)=>b.eur-a.eur);
  // «По типам» — ИСХОДНЫЕ типы операций из by_fuel_type, как в прежней
  // реализации: «Diesel», «Car wash», «Highway A2», «AdBlue unbottled»,
  // «general_accounting». Агрегированные категории (Топливо/Дороги/Лизинг)
  // остались в кольцевой диаграмме и в детализации по авто — иначе вкладка
  // «По типам» повторяла бы диаграмму и не показывала детализацию.
  // Префикс manual_ снимаем: он служебный, в подписи его быть не должно.
  const typeLabel=ft=>String(ft||"").replace(/^manual_/,"");
  const geoTypeRows=Object.entries(stats?.by_fuel_type||{})
    .filter(([ft])=>!isIncome(ft))
    .map(([ft,byCur])=>({key:ft,short:typeLabel(ft),label:typeLabel(ft),eur:stats?.eur?.expenses_by_fuel_type?.[ft]??sumToEur(byCur),byCur,color:null}))
    .filter(r=>r.eur>0)
    .sort((a,b)=>b.eur-a.eur);
  const geoRows=geoMode==="type"?geoTypeRows:geoCountryRows;
  const geoTotal=geoRows.reduce((acc,r)=>acc+r.eur,0);

  // ── Последние транзакции ──
  // Пять последних по дате из того же набора, что загружен для периода
  // (txBatch). Полный реестр — в выдвижной панели (кнопка под списком).
  const recentTx=[...txBatch]
    .sort((a,b)=>String(b.transaction_date||"").localeCompare(String(a.transaction_date||"")))
    .slice(0,25);

  // ── Детализация по авто ──
  // Считается один раз на набор транзакций: категории расходов конкретной
  // машины. Суммы берутся в EUR через rowEur() — это ИСТОРИЧЕСКИЙ курс из
  // amount_eur, тот же, что во вкладках. Раньше здесь стоял toEur() (живой курс),
  // и раскрытая строка «Финансы по авто» показывала по топливу другую сумму,
  // чем вкладка «Топливо». Строки без курса дают 0.
  const vehicleDetail=useMemo(()=>{
    const rows={};
    txBatch.forEach(tx=>{
      const plate=tx.plate_number;
      if(!plate||EXCLUDED_PLATES.has(plate)) return;
      const key=catKeyOf(tx.fuel_type);
      if(key==="income") return;
      // БЕЗ Math.abs: знак несёт смысл. Расходы хранятся положительными, а
      // возврат/сторно по дорогам — отрицательной строкой; модуль превращал
      // возврат в дополнительный расход, и строка «платные дороги» здесь была
      // ровно на 2×|возврат| больше, чем во вкладке «Платные дороги»
      // (пример из отчёта: 2 492,15 против 2 486,83 — разница 5,32 = 2 × 2,66).
      // Проверка ниже нужна на случай испорченного значения в БД: Number("abc")
      // даёт NaN, и одна такая строка обнулила бы всю категорию.
      const eur=rowEur(tx);
      if(!Number.isFinite(eur)) return;
      const d=rows[plate]||(rows[plate]={cats:{},direct:0});
      d.cats[key]=(d.cats[key]||0)+eur;
      d.direct+=eur;
    });
    return{rows};
  },[txBatch]);

  // Высота карточек верхней пары. Одна на обе — так «Финансы по авто» и
  // «Структура расходов» стоят в линию, и сетка не «пляшет» при смене данных.
  // Высота пары «Финансы по авто + Структура расходов». При раскрытии строки
  // ОБА виджета подрастают (как в референсе) — иначе раскрытая панель упиралась
  // бы во внутреннюю прокрутку, и детализацию пришлось бы листать колесом.
  // Отпечаток содержимого: меняется, когда приходят данные или открывается
  // детализация — по нему хук перемеряет высоту (см. usePairHeight).
  const contentKey=[txBatch.length,stats?1:0,mergedVehicleRows.length,compositionParts.length,geoMode,expandedPlate,lang].join("|");
  // Высоту второй пары не меряем: она фиксированная (PAIR_B_H), иначе длинный
  // список типов тянул бы за собой соседний виджет с транзакциями.
  const pair1H=usePairHeight(vehBodyRef,donutBodyRef,PAIR_A_MIN,0,contentKey);
  const CARD_H=pair1H;
  const CARD_H2=PAIR_B_H;
  // Общие стили плашек: подпись, сумма, строка валют и уголок со значками.
  const kpiLabel={fontSize:12,fontWeight:700,textTransform:"uppercase",color:"var(--c-text)",paddingRight:80,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"};
  const kpiValue={fontSize:24,fontWeight:800,margin:"8px 0 4px",letterSpacing:-0.5,fontFamily:MONO,wordBreak:"break-word",overflowWrap:"anywhere"};
  // Стиль угла — общий для всех вкладок (ui/styles.js): на дашборде он был
  // задан локально, из-за чего плашки разных вкладок разъезжались на пару
  // пикселей. Подпись под суммой резервирует место под значок через kpiSub.
  const kpiCorner=s.kpiCorner;
  const cardStyle={background:"var(--c-surface)",border:"1px solid var(--c-border-2)",borderRadius:12,boxShadow:"0 1px 3px rgba(0,0,0,0.02)"};

  return(
    <div style={{...s.page}} className="fc-content">
      {/* HEADER — one row: title+counters left, controls right.
          gap:32 gives extra breathing room between the counters and the
          date/source/sync controls, so large transaction counts don't cause
          horizontal overflow to push the controls off-screen. */}
      <div className="fc-page-header" style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"nowrap",overflowX:"auto",gap:32,marginBottom:20,paddingBottom:4}}>
        <div className="fc-header-left" style={{display:"flex",alignItems:"center",gap:16,flexWrap:"nowrap",flexShrink:0}}>
          {/* Обращение — реальное имя из /auth/me (его вводят при регистрации, а
              владелец задаёт менеджеру и вьюверу). Если имени нет, показываем
              почту без домена; если нет и её — приветствие без обращения.
              Заглушки вроде «Admin» больше нет: её принимали за настоящее имя. */}
          <h1 style={{...s.pageTitle,fontSize:18,whiteSpace:"nowrap"}}>
            {t[greeting()]}{userName?`, ${userName}`:""} 👋
          </h1>
          {/* Статистика периода: одна компактная плашка вместо двух крупных
              («407 ТРАНЗАКЦИИ» и «7 АВТО»). Две плашки занимали больше места,
              чем фильтры справа, и первыми уезжали за край на узком экране.
              Подробности — в подсказке при наведении И при фокусе с клавиатуры
              (tabIndex): цифры сами по себе не объясняют, что они считают.
              role="img" + aria-label — тот же приём, что у значка «без курса»:
              иначе скринридер прочитает только «407 / 7 авто». */}
          <Hint width={215}
                label={<>
                  <div className="fc-hint-title">{t.statsPeriod}</div>
                  <div className="fc-hint-row"><span>{t.statTx}:</span><b>{stats?.total_transactions||0}</b></div>
                  <div className="fc-hint-row"><span>{t.statVehiclesActive}:</span><b>{commercialPlates.size||0}</b></div>
                </>}>
            <span className="fc-stat-chip" role="img" tabIndex={0}
                  aria-label={`${t.statsPeriod}: ${t.statTx} ${stats?.total_transactions||0}, ${t.statVehiclesActive} ${commercialPlates.size||0}`}>
              <span aria-hidden="true" style={{color:"var(--c-brand)"}}>📊</span>
              <span>{stats?.total_transactions||0} / {commercialPlates.size||0} {t.vehiclesShort}</span>
              <span aria-hidden="true" style={{color:"var(--c-muted-2)"}}>ⓘ</span>
            </span>
          </Hint>
        </div>
        <div className="fc-header-controls" style={{display:"flex",gap:8,flexWrap:"nowrap",alignItems:"center",flexShrink:0,marginLeft:"auto"}}>
          <PeriodSel period={period} setPeriod={setPeriod} custom={custom} setCustom={setCustom} t={t}/>
          <SrcFilter value={srcFilter} onChange={setSrcFilter} t={t}/>
          {/* Экспорт — квадратная кнопка со значком: подпись «Экспорт» отнимала
              больше места, чем само действие, а смысл значка ⬇ однозначен.
              Доступное имя и подсказка сохранены. */}
          <IconBtn icon="⬇" label={t.exportHint} onClick={exportExcel}/>
          <SyncBtn busy={syncing} label={t.syncE100} busyLabel={t.syncing}
                   onClick={sync} disabled={syncing||!!syncLock?.locked}
                   title={syncLock?.locked
                     ? (lang==="RU"
                        ? `Синхронизация уже идёт${syncLock.locked_by_email?` (${syncLock.locked_by_email})`:""}`
                        : `Sync already running${syncLock.locked_by_email?` (${syncLock.locked_by_email})`:""}`)
                     : undefined}/>
        </div>
      </div>

      {/* 1. ЧЕТЫРЕ ГЛАВНЫХ ПОКАЗАТЕЛЯ.
          План по доходам (в референсе «Целевой план») не показываем: в системе
          такого понятия нет, а выдуманное число рядом с фактическим доходом
          читалось бы как ошибка данных. Вместо него — разбивка по валютам и
          предупреждение о валютах без курса (см. UnratedNote). */}
      <div className="fc-main-financial-grid" style={{marginBottom:16}}>
        {/* Card 1: Доходы */}
        <div style={{...cardStyle,padding:"16px 20px",display:"flex",flexDirection:"column",justifyContent:"space-between",minHeight:140,position:"relative"}}>
          <DeltaBadge pct={incomeDelta} absolute/>
          <div>
            <div style={kpiLabel}>📈 {t.totalIncome}</div>
            <div style={{...kpiValue,color:"var(--c-text)"}}>{fmtMoney(incomeEur)}</div>
          </div>
          {/* Перечисление сумм убрано: те же суммы показывает значок исходных
              сумм при наведении. Остался только случай «поступлений нет» — это
              не дублирование, а сигнал, что данных за период не пришло. */}
          {incomeEur<=0&&(
            <div style={{fontSize:11,color:"var(--c-muted-2)",lineHeight:1.4,paddingRight:64}}>
              {lang==="RU"?"Нет поступлений за период":"No income this period"}
            </div>
          )}
          {/* Правый нижний угол: «исходные суммы» и слева от него — «есть
              валюта без курса». Отступы те же 12px, что у бейджа сравнения
              сверху, иначе значки не встали бы в одну колонку с ним.
              Прежняя строка текста про валюту без курса убрана: то же самое
              теперь в подсказке значка, но без шума на плашке. */}
          <div style={kpiCorner}>
            <UnratedIcon byCur={kpi.income} lang={lang} missingCount={missingRate}/>
            <CurrencyBadge byCur={kpi.income} lang={lang} sumsOnly/>
          </div>
        </div>
        {/* Card 2: Все расходы */}
        <div style={{...cardStyle,padding:"16px 20px",display:"flex",flexDirection:"column",justifyContent:"space-between",minHeight:140,position:"relative"}}>
          <DeltaBadge pct={expenseDelta} invert absolute/>
          <div>
            <div style={kpiLabel}>📉 {t.totalAll}</div>
            <div style={{...kpiValue,color:"var(--c-text)"}}>{fmtMoney(expensesEur)}</div>
          </div>
          {/* Суммы по валютам — в значке исходных сумм (правый нижний угол). */}
          {/* Правый нижний угол: «исходные суммы» и слева от него — «есть
              валюта без курса». Отступы те же 12px, что у бейджа сравнения
              сверху, иначе значки не встали бы в одну колонку с ним.
              Прежняя строка текста про валюту без курса убрана: то же самое
              теперь в подсказке значка, но без шума на плашке. */}
          <div style={kpiCorner}>
            <UnratedIcon byCur={allTotal} lang={lang} missingCount={missingRate}/>
            <CurrencyBadge byCur={allTotal} lang={lang} sumsOnly/>
          </div>
        </div>
        {/* Card 3: Прибыль / Убыток */}
        <div style={{...cardStyle,padding:"16px 20px",display:"flex",flexDirection:"column",justifyContent:"space-between",minHeight:140,position:"relative"}}>
          <DeltaBadge pct={profitDelta} absolute/>
          <div>
            <div style={kpiLabel}>⚖️ {t.profit}</div>
            <div style={{...kpiValue,color:profitPositive?"var(--c-emerald-strong)":"var(--c-danger-strong)"}}>{profitPositive?"+":""}{fmtMoney(profitEur)}</div>
          </div>
          <div style={{fontSize:11,color:profitPositive?"var(--c-emerald-strong)":"var(--c-danger-strong)",fontFamily:MONO}}>{lang==="RU"?"Маржа":"Margin"}: {marginPct!==null?marginPct.toFixed(1)+"%":"—"}</div>
        </div>
        {/* Card 4: Пробег флота with embedded unit-economics row */}
        <div style={{...cardStyle,padding:"16px 20px",display:"flex",flexDirection:"column",justifyContent:"space-between",minHeight:140,position:"relative"}}>
          <DeltaBadge pct={null} absolute prevValue={prevFleetKm.toLocaleString(lang==="RU"?"ru-RU":"en-US")+" км"} prevLabel={lang==="RU"?"Было:":"Was:"}/>
          <div>
            <div style={kpiLabel}>🛰️ {t.mileage}</div>
            <div style={{...kpiValue,color:"var(--c-text)"}}>{totalKm.toLocaleString(lang==="RU"?"ru-RU":"en-US")} км</div>
          </div>
          <div style={{display:"flex",gap:12,marginTop:8,fontSize:12,borderTop:"1px solid var(--c-surface-2)",paddingTop:8}}>
            <div style={{display:"flex",flexDirection:"column",flex:1,minWidth:0}}>
              <span style={{color:"var(--c-muted-3)",fontSize:10.5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.costShort}</span>
              <span style={{fontWeight:700,color:"var(--c-danger)",fontFamily:MONO,whiteSpace:"nowrap"}}>{costPerKm!==null?costPerKm.toFixed(2):"—"} €/км</span>
            </div>
            <div style={{display:"flex",flexDirection:"column",flex:1,minWidth:0}}>
              <span style={{color:"var(--c-muted-3)",fontSize:10.5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.revShort}</span>
              <span style={{fontWeight:700,color:"var(--c-success)",fontFamily:MONO,whiteSpace:"nowrap"}}>{revPerKm!==null?revPerKm.toFixed(2):"—"} €/км</span>
            </div>
            <div style={{display:"flex",flexDirection:"column",flex:1,minWidth:0}}>
              <span style={{color:"var(--c-muted-3)",fontSize:10.5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.profitShort}</span>
              <span style={{fontWeight:700,color:profitPerKm>=0?"var(--c-success)":"var(--c-danger)",fontFamily:MONO,whiteSpace:"nowrap"}}>{profitPerKm!==null?(profitPerKm>=0?"+":"")+profitPerKm.toFixed(2):"—"} €/км</span>
            </div>
          </div>
        </div>
      </div>

      {/* 2. ФИНАНСЫ ПО АВТО (раскрываемые строки) + СТРУКТУРА РАСХОДОВ (кольцо).
          Эти две карточки заменили ряд из 9 карточек расходов и отдельную полосу
          «распределение по типам»: те же цифры, но без двойного показа и без
          горизонтальной прокрутки. */}
      <div className="fc-dash-split" style={{marginBottom:16}}>
        <section style={{...cardStyle,height:CARD_H,display:"flex",flexDirection:"column",padding:16}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexShrink:0,marginBottom:10}}>
            <div style={{minWidth:0}}>
              <h2 style={{margin:0,fontSize:14,fontWeight:800,display:"flex",alignItems:"center",gap:7}}>🚛 {t.mergedByVehicle}</h2>
              <p style={{margin:"2px 0 0",fontSize:11.5,color:"var(--c-muted-2)"}}>{t.rowClickHint}</p>
            </div>
            {/* Перераспределения: раньше это были две постоянно видимые строки
                над таблицей (красная и зелёная). Они занимали место в каждой
                карточке, хотя нужны не каждый день, — поэтому свёрнуты в
                подсказку. Показывается при наведении И при фокусе с
                клавиатуры (см. .fc-tip:focus-within), иначе содержимое было бы
                недоступно без мыши. */}
            {(anyRedistributed||anyRedistributedExpenses)&&(
              <div className="fc-tip-wrap" style={{flexShrink:0}}>
                <button type="button" className="fc-tap-24" aria-describedby="fc-redist-tip"
                        style={{...s.btn,padding:"3px 8px",borderRadius:7,borderColor:"var(--c-warn-border)",background:"var(--c-warn-bg-2)",color:"var(--c-warn-strong)",fontSize:10.5,fontWeight:600,whiteSpace:"nowrap"}}>
                  <span aria-hidden="true" style={{fontSize:11,lineHeight:1}}>ⓘ</span> {t.redistributions}
                </button>
                <span className="fc-tip" id="fc-redist-tip" role="tooltip">
                  {anyRedistributed&&(
                    <span style={{display:"block",fontWeight:700,color:"var(--c-emerald-strong)"}}>
                      +{unassignedIncomeEur.toFixed(2)} EUR {t.unassignedNote} ({commercialPlates.size}×{redistPerVehicle.toFixed(2)})
                    </span>
                  )}
                  {anyRedistributedExpenses&&(
                    <span style={{display:"block",marginTop:4,fontWeight:700,color:"var(--c-danger-strong)"}}>
                      −{unassignedExpensesEur.toFixed(2)} EUR {t.unassignedNote} ({commercialPlates.size}×{redistPerVehicleExpenses.toFixed(2)})
                    </span>
                  )}
                  <span style={{display:"block",marginTop:6,opacity:0.72,fontWeight:400}}>
                    {lang==="RU"
                      ?"Общие расходы и налоги, у которых нет своей машины, распределены поровну между работающими авто — поэтому в строке каждой машины они прибавлены."
                      :"Shared expenses and taxes with no vehicle of their own are split evenly across active vehicles — that is why they are added to every vehicle row."}
                  </span>
                </span>
              </div>
            )}
          </div>
          <div ref={vehBodyRef} className="fc-card-body-scroll" style={{flex:1,minHeight:0,overflowY:"auto"}}>
            <div className="fc-vrow" style={{position:"sticky",top:0,zIndex:2,background:"var(--c-surface)",borderLeft:"2px solid transparent",borderBottom:"1px solid var(--c-border-2)",padding:"6px 10px",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.4,color:"var(--c-muted-3)"}}>
              {/* Короткие подписи — свои ключи, а не общие (t.mileageCol и
                  прочие стоят ещё на нескольких страницах, где длинная
                  формулировка уместна). */}
              <span>{t.vehColPlate}</span>
              <span className="fc-vhide" style={{textAlign:"right"}}>{t.vehColKm}</span>
              <span className="fc-vhide" style={{textAlign:"right"}}>{t.income}</span>
              <span className="fc-vhide" style={{textAlign:"right"}}>{t.vehColExpense}</span>
              {/* «+/-» по центру своей колонки, а не по правому краю: суммы
                  доходов и расходов выровнены по правой границе, и знак,
                  прижатый к ней же, читался как «съехавший» вправо. */}
              <span className="fc-vhide" style={{textAlign:"center"}}>{t.vehColPlusMinus}</span>
              {/* Пояснения к сокращениям: что такое AdB/ДТ и €/км — раскрывается
                  по наведению и с клавиатуры (см. InfoDot). */}
              <span className="fc-vhide" style={{textAlign:"center"}}>
                <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                  {t.vehColAdbDt}
                  <InfoDot label={t.vehColAdbDtInfo} ariaLabel={`${t.vehColAdbDt}: ${t.infoDotAria}`} width={330}/>
                </span>
              </span>
              <span className="fc-vhide" style={{textAlign:"right"}}>
                <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                  {t.eurPerKmCol}
                  <InfoDot label={t.eurPerKmColInfo} ariaLabel={`${t.eurPerKmCol}: ${t.infoDotAria}`} width={330}/>
                </span>
              </span>
              <span className="fc-vhide"/>
              <span className="fc-vshow-sm" style={{textAlign:"right"}}>{t.vehColPlusMinus}</span>
            </div>
            {mergedVehicleRows.length?mergedVehicleRows.map(r=>{
              const open=expandedPlate===r.plate;
              // Сильный зелёный: обычный --c-emerald на светлом фоне плашки давал
              // 3.6 при норме 4.5 — это нашёл аудит темы, а не глаз.
              const ratioColor=r.ratio===null?"var(--c-muted)":(r.ratio>=4&&r.ratio<=6)?"var(--c-emerald-strong)":"var(--c-warn-strong)";
              const ratioBg=r.ratio===null?"var(--c-surface-3)":(r.ratio>=4&&r.ratio<=6)?"var(--c-success-bg-3)":"var(--c-warn-bg-2)";
              return(
                <div key={r.plate} style={{borderBottom:"1px solid var(--c-surface-2)",borderLeft:`2px solid ${open?"var(--c-brand-solid)":"transparent"}`}}>
                  <button type="button" className="fc-vrow fc-list-row"
                          onClick={()=>setExpandedPlate(open?"":r.plate)}
                          aria-expanded={open} aria-controls={`fc-vdetail-${r.plate}`}
                          style={{border:"none",background:"transparent",cursor:"pointer",textAlign:"left",fontFamily:"inherit",padding:"9px 10px"}}>
                    <span style={{minWidth:0}}>
                      <strong style={{display:"block",fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{open?"▾":"▸"} {r.plate}</strong>
                      <small style={{display:"block",fontSize:11,fontWeight:400,color:"var(--c-muted-2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.driver||"—"}</small>
                    </span>
                    <span className="fc-vhide" style={{textAlign:"right",fontFamily:MONO,fontSize:12}}>{r.km?r.km.toLocaleString(lang==="RU"?"ru-RU":"en-US"):"—"}</span>
                    <span className="fc-vhide" style={{textAlign:"right",fontFamily:MONO,fontSize:12,color:"var(--c-success)"}}>{r.income.toFixed(2)}</span>
                    <span className="fc-vhide" style={{textAlign:"right",fontFamily:MONO,fontSize:12}}>{r.expense.toFixed(2)}</span>
                     <strong className="fc-vhide" style={{textAlign:"center",fontFamily:MONO,fontSize:12,color:r.profit>=0?"var(--c-emerald-strong)":"var(--c-danger-strong)",whiteSpace:"nowrap"}}>{r.profit>=0?"+":""}{r.profit.toFixed(2)}</strong>
                     <span className="fc-vhide" style={{textAlign:"center"}}>
                      {r.ratio!==null
                        ?<span style={{padding:"2px 6px",borderRadius:4,fontSize:11,fontWeight:700,background:ratioBg,color:ratioColor}}>{r.ratio.toFixed(1)}%</span>
                        :<span style={{color:"var(--c-muted-2)"}}>—</span>}
                    </span>
                    <strong className="fc-vhide" style={{textAlign:"right",fontFamily:MONO,fontSize:12}}>{r.eurPerKm!==null?r.eurPerKm.toFixed(2):"—"}</strong>
                    <span className="fc-vhide" style={{textAlign:"right",color:"var(--c-muted-2)"}}>{open?"▲":"▼"}</span>
                    <strong className="fc-vshow-sm" style={{textAlign:"right",fontFamily:MONO,fontSize:12,color:r.profit>=0?"var(--c-emerald-strong)":"var(--c-danger-strong)",whiteSpace:"nowrap"}}>{r.profit>=0?"+":""}{r.profit.toFixed(2)}</strong>
                  </button>
                  {open&&(
                    <div id={`fc-vdetail-${r.plate}`}>
                      <VehicleDetail row={r} detail={vehicleDetail.rows[r.plate]} t={t} lang={lang} redistShare={redistPerVehicleExpenses} redistIncome={redistPerVehicle}/>
                    </div>
                  )}
                </div>
              );
            }):<div style={s.empty}>—</div>}
          </div>
        </section>

        <section style={{...cardStyle,height:CARD_H,display:"flex",flexDirection:"column",padding:16}}>
          <div style={{flexShrink:0}}>
            <h2 style={{margin:0,fontSize:14,fontWeight:800,display:"flex",alignItems:"center",gap:7}}>📊 {t.expenseStructure}</h2>
            <p style={{margin:"2px 0 0",fontSize:11.5,color:"var(--c-muted-2)"}}>{t.structureSub}</p>
          </div>
          <div style={{display:"flex",justifyContent:"center",padding:"12px 0 8px",flexShrink:0}}>
            <div className="fc-donut" role="img" aria-label={`${t.expenseStructure}: ${fmtMoney(expensesEur)}`}
                 style={{width:136,height:136,background:donutBg}}>
              <div className="fc-donut-hole">
                <span style={{fontSize:9.5,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-text-4)"}}>{lang==="RU"?"Расходы":"Expenses"}</span>
                {/* Сумма в центре: кегль и текст подбирает donutAmount()
                    (lib/format.js) под ширину отверстия — см. комментарий там.
                    maxWidth тут как страховка: даже если шрифт окажется шире,
                    чем ожидает расчёт, строка не выйдет за пределы кольца и не
                    налезет на саму диаграмму. */}
                <strong style={{fontSize:donutCenter.size,fontWeight:800,fontFamily:MONO,color:"var(--c-text)",marginTop:2,whiteSpace:"nowrap",maxWidth:DONUT_AMOUNT_MAX_W,overflow:"hidden"}}>{donutCenter.text}</strong>
                <span style={{fontSize:10,color:"var(--c-muted-2)",marginTop:2}}>{compositionParts.length} {lang==="RU"?"категорий":"categories"}</span>
              </div>
            </div>
          </div>
          <div ref={donutBodyRef} className="fc-card-body-scroll" style={{flex:1,minHeight:0,overflowY:"auto"}}>
            {compositionParts.length?compositionParts.map(p=>(
              /* Слева тип, справа блок «значки + сумма». Значки стоят
                 вплотную слева от суммы (как в «Географии затрат»), а сама
                 сумма имеет минимальную ширину — поэтому правые края сумм
                 совпадают и в строках без значков. Доля в процентах ушла в
                 подсказку строки: в референсе её нет, а сумму она не заменяет. */
              /* Строку ведём как кнопку: наведение и фокус подсвечивают её сегмент
                 в кольце, клик закрепляет подсветку. Настоящий <button> тут
                 невозможен — внутри строки уже есть кнопки (значок валют и
                 «без курса»), а вложенные кнопки недопустимы. Поэтому role,
                 tabIndex и обработка Enter/Space вручную. */
              <div key={p.key} className="fc-list-row" role="button" tabIndex={0}
                   aria-pressed={pinnedCat===p.key}
                   aria-label={`${p.label}: ${fmtMoney(p.eur)}${donutTotal>0?`, ${(p.eur/donutTotal*100).toFixed(1)}%`:""}`}
                   onMouseEnter={()=>setHoverCat(p.key)}
                   onMouseLeave={()=>setHoverCat("")}
                   onFocus={()=>setHoverCat(p.key)}
                   onBlur={()=>setHoverCat("")}
                   onClick={()=>setPinnedCat(c=>c===p.key?"":p.key)}
                   onKeyDown={e=>{
                     if(e.key==="Enter"||e.key===" "){e.preventDefault();setPinnedCat(c=>c===p.key?"":p.key);}
                     if(e.key==="Escape") setPinnedCat("");
                   }}
                   title={donutTotal>0?`${p.label}: ${(p.eur/donutTotal*100).toFixed(1)}% ${lang==="RU"?"от расходов":"of expenses"}`:p.label}
                   style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:8,alignItems:"center",padding:"5px 6px",borderRadius:8,fontSize:12,cursor:"pointer",
                           background:activeCat===p.key?"var(--c-hover)":undefined,
                           boxShadow:activeCat===p.key?`inset 0 0 0 1px var(--c-border-3)`:undefined}}>
                <span style={{display:"flex",alignItems:"center",gap:7,minWidth:0}}>
                  <span style={{width:9,height:9,borderRadius:3,background:p.color,flexShrink:0}}/>
                  <span style={{color:"var(--c-text-4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                                fontWeight:activeCat===p.key?700:undefined}}>{p.label}</span>
                </span>
                <span style={{display:"flex",alignItems:"center",gap:5,justifyContent:"flex-end"}}>
                  <UnratedIcon byCur={p.byCur} lang={lang}/>
                  <CurrencyBadge byCur={p.byCur} lang={lang} sumsOnly/>
                  <strong style={{fontFamily:MONO,fontSize:11.5,fontWeight:700,whiteSpace:"nowrap",textAlign:"right",minWidth:74}}>{fmtMoney(p.eur)}</strong>
                </span>
              </div>
            )):<div style={s.empty}>—</div>}
          </div>
        </section>
      </div>

      {/* 3. ГЕОГРАФИЯ ЗАТРАТ + ПОСЛЕДНИЕ ТРАНЗАКЦИИ.
          «По странам» и «По типам» были двумя одинаковыми по форме блоками про
          один и тот же период — теперь это один блок с переключателем, а
          освободившееся место занял оперативный список последних операций
          (раньше его не было: вместо него на экране сразу стоял полный реестр
          на 50 строк). */}
      <div className="fc-dash-split-2">
        <section style={{...cardStyle,height:CARD_H2,display:"flex",flexDirection:"column",padding:16}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexShrink:0,marginBottom:10}}>
            <div style={{minWidth:0}}>
              <h2 style={{margin:0,fontSize:14,fontWeight:800,display:"flex",alignItems:"center",gap:7}}>🌍 {t.geoTitle}</h2>
              <p style={{margin:"2px 0 0",fontSize:11.5,color:"var(--c-muted-2)"}}>
                {geoMode==="type"
                  ?(lang==="RU"?"Затраты по типам за выбранный период":"Expenses by type for the selected period")
                  :(lang==="RU"?"Затраты по странам за выбранный период":"Expenses by country for the selected period")}
              </p>
            </div>
            <Segmented ariaLabel={t.geoTitle} value={geoMode} onChange={setGeoMode}
                       items={[{id:"country",label:t.byCountry,title:t.byCountry},
                               {id:"type",label:t.byType,title:t.byType}]}/>
          </div>
          <div className="fc-card-body-scroll" style={{flex:1,minHeight:0,overflowY:"auto"}}>
            {geoRows.length?geoRows.map(r=>{
              const share=geoTotal>0?(r.eur/geoTotal*100):0;
              return(
                <div key={r.key} className="fc-list-row" style={{padding:"6px",borderRadius:8,marginBottom:2}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,fontSize:12}}>
                    <span style={{minWidth:0,fontWeight:600,color:"var(--c-text-2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.label}</span>
                    <span style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                      <CurrencyBadge byCur={r.byCur} lang={lang}/>
                      <strong style={{fontFamily:MONO,whiteSpace:"nowrap"}}>{fmtMoney(r.eur)}</strong>
                      <span style={{color:"var(--c-muted-2)",fontSize:11,minWidth:30,textAlign:"right"}}>{share.toFixed(0)}%</span>
                    </span>
                  </div>
                  <div style={{height:6,borderRadius:4,background:"var(--c-surface-3)",overflow:"hidden",marginTop:5}}>
                    <div style={{height:"100%",width:`${share.toFixed(2)}%`,background:r.color}}/>
                  </div>
                </div>
              );
            }):<div style={s.empty}>—</div>}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",gap:10,borderTop:"1px solid var(--c-surface-2)",paddingTop:8,marginTop:8,fontSize:11.5,color:"var(--c-muted-2)",flexShrink:0}}>
            <span>{geoMode==="type"?t.geoCategories:t.geoCountries}: <b style={{color:"var(--c-text-2)"}}>{geoRows.length}</b></span>
            {geoRows[0]&&<span>{t.geoTop}: <b style={{color:"var(--c-text-2)"}}>{geoRows[0].short}</b></span>}
          </div>
        </section>

        <section style={{...cardStyle,height:CARD_H2,display:"flex",flexDirection:"column",padding:16}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexShrink:0,marginBottom:10}}>
            <div style={{minWidth:0}}>
              <h2 style={{margin:0,fontSize:14,fontWeight:800,display:"flex",alignItems:"center",gap:7}}>🧾 {t.lastTxTitle}</h2>
              <p style={{margin:"2px 0 0",fontSize:11.5,color:"var(--c-muted-2)"}}>{t.lastTxSub}</p>
            </div>
            <span style={{flexShrink:0,padding:"2px 9px",borderRadius:999,fontSize:11,fontWeight:700,background:"var(--c-surface-3)",color:"var(--c-muted)",border:"1px solid var(--c-border-2)",whiteSpace:"nowrap"}}>
              {fmtDMY(dates.from)} — {fmtDMY(dates.to)}
            </span>
          </div>
          <div className="fc-card-body-scroll" style={{flex:1,minHeight:0,overflowY:"auto"}}>
            {recentTx.length?recentTx.map(tx=>{
              const st=txStatus(tx);
              const inc=isIncome(tx.fuel_type);
              return(
                <div key={tx.id} className="fc-list-row" style={{display:"grid",gridTemplateColumns:"auto minmax(0,1fr) auto",gap:10,alignItems:"center",padding:"7px 9px",borderRadius:9,background:"var(--c-surface-2)",marginBottom:6}}>
                  <span title={st.label} aria-label={st.label} style={{fontSize:10}}>{st.icon}</span>
                  <span style={{minWidth:0}}>
                    <span style={{display:"block",fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {tx.plate_number||"—"} <span style={{fontWeight:500,color:"var(--c-muted)"}}>· {tx.source==="csv_income"&&!tx.plate_number?"—":(tx.driver_name||"—")}</span>
                    </span>
                    <span style={{display:"flex",alignItems:"center",gap:6,marginTop:3,fontSize:11,color:"var(--c-muted)"}}>
                      <SrcBadge source={tx.source}/>{fmtDateTime(tx.transaction_date)}
                    </span>
                  </span>
                  <span style={{textAlign:"right",flexShrink:0}}>
                    <strong style={{display:"block",fontFamily:MONO,fontSize:12,color:inc?"var(--c-emerald-strong)":"var(--c-danger-strong)"}}>{inc?"+":""}{fmtQty(tx.amount,2)} {tx.currency}</strong>
                    <span style={{fontSize:10.5,color:"var(--c-muted)"}}>{FLAGS[tx.country]||""} {(tx.fuel_type||"").replace("manual_","")||"—"}</span>
                  </span>
                </div>
              );
            }):<div style={s.empty}>—</div>}
          </div>
          <button type="button" onClick={()=>setTxDrawer(true)}
                  style={{...s.btn,flexShrink:0,width:"100%",marginTop:10,display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                          borderColor:"var(--c-brand-bg-2)",background:"var(--c-brand-bg)",color:"var(--c-brand)",fontWeight:700}}>
            {t.allTxBtn} ({stats?.total_transactions||0}) →
          </button>
        </section>
      </div>

      {/* Полный реестр транзакций: та же таблица с фильтрами и выгрузкой, что
          была на странице, но открывается по требованию. Escape, ловушка фокуса
          и возврат фокуса — из Modal (variant="drawer"). */}
      {txDrawer&&(
        <Modal variant="drawer" maxWidth={1180} zIndex={1500} onClose={()=>setTxDrawer(false)}
               labelledBy="fc-tx-drawer-title" style={{padding:0}}>
          <div style={{display:"flex",flexDirection:"column",height:"100%",minHeight:0}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"16px 20px",borderBottom:"1px solid var(--c-border-3)",flexShrink:0}}>
              <div style={{minWidth:0}}>
                <h2 id="fc-tx-drawer-title" style={{margin:0,fontSize:16,fontWeight:800}}>🧾 {t.recentTx} ({stats?.total_transactions||0})</h2>
                <p style={{margin:"3px 0 0",fontSize:12,color:"var(--c-muted-2)"}}>
                  {fmtDMY(dates.from)} — {fmtDMY(dates.to)}{srcFilter?` · ${srcFilter}`:""}
                </p>
              </div>
              <button type="button" onClick={()=>setTxDrawer(false)} aria-label={lang==="RU"?"Закрыть":"Close"}
                      style={{...s.btn,padding:"6px 11px",fontSize:14,flexShrink:0}}>✕</button>
            </div>
            <div style={{flex:1,minHeight:0,overflowY:"auto",padding:"14px 20px 20px"}}>
              <PaginatedTxTable dates={dates} srcFilter={srcFilter} t={t} lang={lang} bare
                vehicleFilter={vehicleFilter} setVehicleFilter={setVehicleFilter}
                countryFilter={countryFilter} setCountryFilter={setCountryFilter}
                sortMode={sortMode} setSortMode={setSortMode}
                vehicles={availVehicles} countries={availCountries}/>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Категории расходов. Один список на всё: кольцевая диаграмма, вкладка
 *  «По типам», детализация по авто. Ключи совпадают с именами блоков в kpi
 *  (см. computeKpi) — новая категория появится сразу во всех трёх местах.
 *  Цвета — переменные темы, поэтому список одинаково выглядит в обеих темах. */
const CATS=[
  {key:"fuel",     label:"totalFuel",      icon:"⛽", color:"var(--info)"},
  {key:"toll",     label:"totalTolls",     icon:"🛣️", color:"var(--warning)"},
  {key:"adblue",   label:"totalAdBlue",    icon:"🧪", color:"var(--teal)"},
  {key:"other",    label:"totalOther",     icon:"💼", color:"var(--purple)"},
  {key:"salary",   label:"totalSalary",    icon:"👤", color:"var(--c-pink)"},
  {key:"insurance",label:"totalInsurance", icon:"🛡️", color:"var(--c-cyan)"},
  {key:"leasing",  label:"totalLeasing",   icon:"📋", color:"var(--c-orange)"},
  {key:"trailer",  label:"trailers",       icon:"🚛", color:"var(--c-teal-soft)"},
  {key:"general",  label:"totalGeneral",   icon:"🏢", color:"var(--c-muted-3)"},
];

/** TRUCK (личная машина, не автопарк) и Unknown (непривязанные сборы e100) не
 *  показываются строками, хотя входят в общие итоги компании. */
const EXCLUDED_PLATES=new Set(["TRUCK","Unknown"]);

/**
 * Заливка кольцевой диаграммы расходов, с подсветкой выбранной категории.
 *
 * Диаграмма нарисована через conic-gradient, а не SVG, поэтому отдельный сегмент
 * «выбрать» средствами CSS нельзя — при наведении на строку списка заливка
 * пересобирается заново: выбранный сегмент сохраняет свой цвет, остальные уходят
 * в нейтральный. Доли при этом НЕ меняются: подсветка не должна искажать картину
 * (это проверяется в check-behaviour).
 *
 * dimColor пустой — подсветки нет (обычный вид, все категории своими цветами).
 */
export function donutGradient(parts,activeKey,dimColor){
  const total=(parts||[]).reduce((acc,p)=>acc+(p.eur||0),0);
  if(!(total>0)) return null;
  let acc=0;
  return `conic-gradient(${parts.map(p=>{
    const from=acc;
    acc+=(p.eur||0)/total*100;
    const dim=!!activeKey&&p.key!==activeKey;
    return `${dim&&dimColor?dimColor:p.color} ${from.toFixed(3)}% ${acc.toFixed(3)}%`;
  }).join(",")})`;
}

/** К какой категории относится тип транзакции. Порядок проверок повторяет
 *  computeKpi(): там то же решение принимается по строкам by_fuel_type.
 *  Разошедшись, эти две функции дали бы разные суммы в шапке и в детализации
 *  по авто — поэтому «прочее» проверяется ДО топлива (иначе мойка и парковка
 *  e100 попали бы в топливо), а топливо — это всё, что не подошло раньше. */
export function catKeyOf(ft){
  if(isIncome(ft)) return "income";
  if(isAdBlue(ft)) return "adblue";
  if(isToll(ft)) return "toll";
  if(isSalary(ft)) return "salary";
  if(isInsurance(ft)) return "insurance";
  if(isLeasing(ft)) return "leasing";
  if(isTrailer(ft)) return "trailer";
  if(isGeneral(ft)) return "general";
  if(isOther(ft)||isSvcFee(ft)) return "other";
  return "fuel";
}



/** Раскрытая строка «Финансы по авто»: показатели машины, её прямые расходы по
 *  категориям и динамика по интервалам периода.
 *
 *  Почему категории считаются по строкам транзакций, а не берутся из
 *  stats.by_vehicle: сервер по машине отдаёт только итог в разрезе валют,
 *  разбивки по категориям там нет. Валюты без курса пропущены (см. toEur),
 *  поэтому сумма категорий может быть меньше строки «Расходы» — расхождение
 *  объяснено отдельной строкой про распределённые общие расходы. */
export function VehicleDetail({row,detail,t,lang,redistShare,redistIncome}){
  const cats=CATS.map(c=>({...c,eur:detail?.cats?.[c.key]||0})).filter(c=>c.eur>0).sort((a,b)=>b.eur-a.eur);
  const direct=detail?.direct||0;
  const margin=row.income>0?(row.profit/row.income*100):null;
  // Сравнение с прошлым периодом — по ПРЯМЫМ расходам с обеих сторон: строка
  // «Расходы» содержит долю общих расходов, и сравнивать её с прошлым
  // «прямым» расходом было бы сравнением разных величин.
  const delta=(row.prevDirectExpense&&row.prevDirectExpense>0)
    ?(row.directExpense-row.prevDirectExpense)/Math.abs(row.prevDirectExpense)*100
    :null;
  // Цвета значений взяты «сильными» вариантами (--c-emerald-strong /
  // --c-danger-strong), а подписи — --c-text-4. Панель стоит на
  // --c-brand-bg, а он заметно светлее обычной поверхности, и обычные
  // --c-emerald / --c-muted-2 на нём давали 3.4 и 4.3 при норме 4.5 —
  // это нашёл аудит превью темы (`npm run theme:preview`), а не глаз.
  const metrics=[
    {label:t.income,   value:fmtMoney(row.income,"€"),  color:"var(--c-emerald-strong)"},
    {label:t.totalAll, value:fmtMoney(row.expense,"€"), color:"var(--c-text)"},
    {label:t.marginPct,value:margin!==null?margin.toFixed(1)+"%":"—", color:margin!==null&&margin>=0?"var(--c-emerald-strong)":"var(--c-danger-strong)"},
    {label:t.eurPerKmCol,value:row.eurPerKm!==null?row.eurPerKm.toFixed(2):"—", color:"var(--c-text)"},
    {label:t.mileageCol,value:row.km?row.km.toLocaleString(lang==="RU"?"ru-RU":"en-US"):"—", color:"var(--c-text)"},
  ];
  // Показатели на 1 км. Считаются от тех же сумм, что выше: доход, расход и
  // прибыль уже включают долю общих расходов/доходов и налогов, приходящуюся на
  // машину, — поэтому «прибыль / км» сходится с «доход / км − расход / км».
  const perKm=row.km>0?[
    {key:"income",  label:t.perKmIncome,  text:fmtMoney(row.income/row.km,"€")+"/км",
     color:"var(--c-emerald-strong)"},
    {key:"expense", label:t.perKmExpense, text:fmtMoney(row.expense/row.km,"€")+"/км",
     color:"var(--c-danger-strong)"},
    {key:"profit",  label:t.perKmProfit,  text:(row.profit>=0?"+":"")+fmtMoney(row.profit/row.km,"€")+"/км",
     color:row.profit>=0?"var(--c-emerald-strong)":"var(--c-danger-strong)"},
  ]:[
    {key:"income",  label:t.perKmIncome,  text:"—", color:"var(--c-text-4)"},
    {key:"expense", label:t.perKmExpense, text:"—", color:"var(--c-text-4)"},
    {key:"profit",  label:t.perKmProfit,  text:"—", color:"var(--c-text-4)"},
  ];
  return(
    <div style={{background:"var(--c-brand-bg)",borderTop:"1px solid var(--c-border-2)",padding:"14px 14px 16px"}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(118px,1fr))",gap:12}}>
        {metrics.map(m=>(
          <div key={m.label} style={{borderLeft:"2px solid var(--c-brand-solid)",paddingLeft:9,minWidth:0}}>
            <div style={{fontSize:9.5,fontWeight:700,textTransform:"uppercase",letterSpacing:0.4,color:"var(--c-text-4)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{m.label}</div>
            <div style={{fontSize:13,fontWeight:800,fontFamily:MONO,color:m.color,marginTop:2,whiteSpace:"nowrap"}}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* Строка «на 1 км»: доход, расход и прибыль на километр.
          Отдельная подложка и тонкие разделители — чтобы это читалось как один
          показатель эффективности машины, а не как ещё три независимых числа
          рядом с суммами. Без пробега показатели не считаются: деление на ноль
          дало бы «∞» или «NaN», а «0.00» соврало бы — поэтому честная подпись. */}
      <div style={{marginTop:12,borderRadius:10,border:"1px solid var(--c-border-2)",
                   background:"var(--c-surface)",overflow:"hidden"}}>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",
                     gap:8,flexWrap:"wrap",padding:"7px 12px 0"}}>
          <span style={{fontSize:9.5,fontWeight:700,textTransform:"uppercase",
                        letterSpacing:0.5,color:"var(--c-text-4)"}}>{t.perKmRowTitle}</span>
          {!(row.km>0)&&<span style={{fontSize:10,color:"var(--c-text-4)"}}>{t.perKmNoMileage}</span>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))"}}>
          {perKm.map((p,i)=>(
            <div key={p.key} style={{padding:"6px 12px 9px",minWidth:0,
                           borderLeft:i?"1px solid var(--c-border-3)":"none"}}>
              <div style={{fontSize:9.5,fontWeight:700,textTransform:"uppercase",letterSpacing:0.4,
                           color:"var(--c-text-4)",whiteSpace:"nowrap",overflow:"hidden",
                           textOverflow:"ellipsis"}}>{p.label}</div>
              <div style={{fontSize:14,fontWeight:800,fontFamily:MONO,color:p.color,
                           marginTop:1,whiteSpace:"nowrap"}}>{p.text}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:10,marginTop:14,flexWrap:"wrap"}}>
        <h3 style={{margin:0,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5,color:"var(--c-text-4)"}}>{t.expenseByCategory}</h3>
        {/* Сравнение с прошлым периодом — тем же бейджем DeltaBadge, что и на
            остальных страницах (расход вырос = плохо, отсюда invert). Раньше
            здесь была просто подпись «+11.2% к пред. периоду»: она выбивалась из
            общего вида и не читалась как показатель. */}
        <span style={{display:"inline-flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <DeltaBadge pct={delta} invert/>
          <span style={{fontSize:10.5,color:"var(--c-text-4)"}}>{t.directByCategoryNote}{delta!==null?` · ${t.vsPrevPeriod}`:""}</span>
        </span>
      </div>
      {cats.length?(
        <>
          <div style={{display:"flex",height:8,borderRadius:5,overflow:"hidden",background:"var(--c-surface-3)",marginTop:8}}>
            {cats.map(c=>(
              <span key={c.key} title={`${t[c.label]}: ${fmtMoney(c.eur)}`}
                    style={{height:"100%",width:`${(c.eur/direct*100).toFixed(2)}%`,background:c.color}}/>
            ))}
          </div>
          {/* Одна категория — одна строка: название слева, «сумма · доля»
              справа по общей правой границе. Сетка в несколько колонок читалась
              как каша: суммы вставали вразнобой, порядок приходилось искать. */}
          <div style={{marginTop:9}}>
            {cats.map(c=>(
              <div key={c.key} style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:12,alignItems:"center",fontSize:11.5,padding:"3px 0",borderBottom:"1px solid var(--c-border-3)"}}>
                <span style={{display:"flex",alignItems:"center",gap:7,minWidth:0}}>
                  <span style={{width:8,height:8,borderRadius:2,background:c.color,flexShrink:0}}/>
                  <span style={{color:"var(--c-text-4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t[c.label]}</span>
                </span>
                <strong style={{fontFamily:MONO,whiteSpace:"nowrap"}}>{fmtMoney(c.eur)} · {(c.eur/direct*100).toFixed(0)}%</strong>
              </div>
            ))}
          </div>
        </>
      ):<div style={{...s.empty,padding:"10px 0"}}>—</div>}
      {/* Общие суммы без своего авто — их доля, приходящаяся на эту машину.
          Знак «+» и пояснение «(из них перераспределено)» убраны: осталась
          подпись и сумма, а направления видно по цвету — расходы красным,
          доходы зелёным. */}
      {redistShare>0.005&&(
        <div style={{fontSize:11,marginTop:8,color:"var(--c-danger-strong)"}}>
          {fmtMoney(redistShare)} — {t.distributedGeneralNote}
        </div>
      )}
      {redistIncome>0.005&&(
        <div style={{fontSize:11,marginTop:4,color:"var(--c-emerald-strong)"}}>
          {fmtMoney(redistIncome)} — {t.distributedGeneralIncome}
        </div>
      )}
    </div>
  );
}
