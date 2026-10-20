/** Работа с периодами и датами календаря: пресеты, сетка месяца, подписи.
 *  Вынесено из App.jsx. Чистые функции — без React и DOM. */
export const isoFmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

export const parseISODate=iso=>{const[y,m,d]=iso.split("-").map(Number);return new Date(y,m-1,d);};

export const sameDay=(a,b)=>a&&b&&a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();

export const fmtDMY=iso=>{const[y,m,d]=iso.split("-");return `${d}.${m}.${y}`;};
// Get same-date-range in the previous month for comparison badges.
// E.g. 01.06–14.06 → 01.05–14.05;  01.07–31.07 → 01.06–30.06 (June has 30 days)

export function buildMonthGrid(monthDate){
  const year=monthDate.getFullYear(), month=monthDate.getMonth();
  const first=new Date(year,month,1);
  const startOffset=(first.getDay()+6)%7; // Monday=0
  const start=new Date(year,month,1-startOffset);
  let cells=[];
  for(let i=0;i<42;i++){
    const d=new Date(start.getFullYear(),start.getMonth(),start.getDate()+i);
    cells.push({date:d,muted:d.getMonth()!==month});
  }
  while(cells.length>35 && cells.slice(-7).every(c=>c.muted)) cells=cells.slice(0,-7);
  return cells;
}

export function dayCountWord(n,t){
  if(t._lang==="en") return n===1?t.dpDay:t.dpDays5;
  const mod10=n%10, mod100=n%100;
  if(mod10===1&&mod100!==11) return t.dpDay;
  if(mod10>=2&&mod10<=4&&!(mod100>=12&&mod100<=14)) return t.dpDays2;
  return t.dpDays5;
}


export function getPeriodDates(period,custom){
  const today=new Date();
  const fmt=isoFmt;
  const fd=d=>new Date(d.getFullYear(),d.getMonth(),1);
  const ld=d=>new Date(d.getFullYear(),d.getMonth()+1,0);
  switch(period){
    case "today": return{from:fmt(today),to:fmt(today)};
    case "yesterday":{const y=new Date(today);y.setDate(today.getDate()-1);return{from:fmt(y),to:fmt(y)};}
    case "last7":{const m=new Date(today);m.setDate(today.getDate()-6);return{from:fmt(m),to:fmt(today)};}
    case "last30":{const m=new Date(today);m.setDate(today.getDate()-29);return{from:fmt(m),to:fmt(today)};}
    case "week":{const m=new Date(today);const dow=today.getDay()||7;m.setDate(today.getDate()-dow+1);return{from:fmt(m),to:fmt(today)};}
    case "this_month": return{from:fmt(fd(today)),to:fmt(today)};
    case "last_month":{const p=new Date(today.getFullYear(),today.getMonth()-1,1);return{from:fmt(fd(p)),to:fmt(ld(p))};}
    case "this_year": return{from:`${today.getFullYear()}-01-01`,to:fmt(today)};
    case "custom": return custom;
    default: return{from:fmt(fd(today)),to:fmt(today)};
  }
}

export const DP_PRESETS=["today","yesterday","last7","last30","this_month","last_month","this_year"];


export function getPrevMonthDates(fromIso, toIso){
  const from=parseISODate(fromIso);
  const to=parseISODate(toIso);
  const prevMonth=from.getMonth()-1;
  const prevYear=from.getFullYear()+(prevMonth<0?0:0);
  const pm=prevMonth<0?11:prevMonth;
  const py=prevMonth<0?from.getFullYear()-1:from.getFullYear();
  // Start day is same, but clamp to month length
  const prevMonthLen=new Date(py,pm+1,0).getDate();
  const fromDay=Math.min(from.getDate(), prevMonthLen);
  const toDay=Math.min(to.getDate(), prevMonthLen);
  const prevFrom=new Date(py,pm,fromDay);
  const prevTo=new Date(py,pm,toDay);
  return {from:isoFmt(prevFrom), to:isoFmt(prevTo)};
}
