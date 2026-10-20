import { useEffect, useState } from "react";
import { THEME_MODES } from "../lib/theme.js";
import { Segmented } from "./components.jsx";
/** Боковое меню: группы пунктов, сворачивание, мобильный режим.
 *  Вынесено из App.jsx. */
export function Sidebar({page,setPage,t,lang,setLang,onLogout,mobileOpen,themeMode,setThemeMode,user}){
  const myRole=(typeof window!=="undefined"&&window.__FLEETCOST_ROLE__)||"viewer";

  // Rail/collapsed mode. Previously useState(false) — the choice was lost on
  // every reload. Now it is persisted AND defaults to the compact rail on
  // narrow screens (13" laptops), where the expanded sidebar is what pushed
  // "Администрирование"/"Импорт данных" below the fold.
  const [collapsed,setCollapsed]=useState(()=>{
    try{
      const saved=localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if(saved!==null) return saved==="1";
    }catch(e){}
    try{
      return !!window.matchMedia("(max-width:1280px)").matches;
    }catch(e){ return false; }
  });
  useEffect(()=>{
    try{ localStorage.setItem(SIDEBAR_COLLAPSED_KEY,collapsed?"1":"0"); }catch(e){}
  },[collapsed]);

  // On phones the sidebar becomes a full-width drawer with labels, so the rail
  // state must be ignored there (it used to leave an icon-only drawer).
  const [isNarrow,setIsNarrow]=useState(()=>{
    try{ return !!window.matchMedia("(max-width:1280px)").matches; }catch(e){ return false; }
  });
  useEffect(()=>{
    let mq;
    try{ mq=window.matchMedia("(max-width:1280px)"); }catch(e){ return; }
    const onChange=(ev)=>{
      setIsNarrow(ev.matches);
      // Auto-collapse when the window gets narrow, auto-expand when it grows —
      // but never override an explicit choice made while narrow/wide.
      setCollapsed(ev.matches);
    };
    try{ mq.addEventListener("change",onChange); }catch(e){ mq.addListener(onChange); }
    return ()=>{
      try{ mq.removeEventListener("change",onChange); }catch(e){ try{mq.removeListener(onChange);}catch(_){} }
    };
  },[]);

  const [isMobile,setIsMobile]=useState(false);
  useEffect(()=>{
    let mq;
    try{ mq=window.matchMedia("(max-width:768px)"); }catch(e){ return; }
    const apply=(ev)=>{ setIsMobile(!!ev.matches); if(ev.matches) setCollapsed(false); };
    apply(mq);
    try{ mq.addEventListener("change",apply); }catch(e){ mq.addListener(apply); }
    return ()=>{
      try{ mq.removeEventListener("change",apply); }catch(e){ try{mq.removeListener(apply);}catch(_){} }
    };
  },[]);

  const allGroups=[
    {key:"main",title:t.groupMain, items:[
      {key:"dashboard",icon:SidebarIcons.dashboard,label:t.dashboard},
      {key:"vehicles",icon:SidebarIcons.vehicles,label:t.vehicles},
      {key:"mileage",icon:SidebarIcons.mileage,label:t.mileage},
    ]},
    {key:"ops",title:t.groupOps, items:[
      {key:"fuel",icon:SidebarIcons.fuel,label:t.fuel},
      {key:"adblue",icon:SidebarIcons.adblue,label:t.adblue},
      {key:"tolls",icon:SidebarIcons.tolls,label:t.tolls},
      {key:"other",icon:SidebarIcons.other,label:t.other},
    ]},
    {key:"capital",title:t.groupCapital, items:[
      {key:"salary",icon:SidebarIcons.salary,label:t.salary},
      {key:"insurance",icon:SidebarIcons.insurance,label:t.insurance},
      {key:"leasing",icon:SidebarIcons.leasing,label:t.leasing},
      {key:"trailers",icon:SidebarIcons.trailers,label:t.trailers},
      {key:"general",icon:SidebarIcons.general,label:t.general},
      {key:"income",icon:SidebarIcons.income,label:t.income},
    ]},
    // «Курсы валют» отдельным пунктом — ТОЛЬКО менеджеру: ему нужна именно эта
        // страница, и держать её внутри «Администрирования» (куда ему хода нет) было
        // бы запутанно. Владельцу отдельный пункт не нужен: он видит ту же страницу
        // вкладкой внутри «Администрирования», а меню остаётся компактным — ради
        // этого вкладки и были схлопнуты в один пункт.
    {key:"config",title:t.groupConfig, items:[
      {key:"admin",icon:SidebarIcons.settings,label:t.admin||"Администрирование"},
      {key:"fxrates",icon:SidebarIcons.fxrates,label:t.fxrates||"Курсы валют"},
    ]},
  ];

  // Role filtering: hide pages the role cannot use, and drop empty groups.
  const groups=allGroups
    .map(g=>({...g, items:g.items.filter(it=>{
      const allowed=ROLE_GATES[it.key];
      return !allowed || allowed.includes(myRole);
    })}))
    .filter(g=>g.items.length>0);

  // Collapsible groups: the solution to "вкладки не влазят в экран" — the user
  // decides which sections occupy vertical space instead of scrolling blindly.
  // `{}` (or a missing key) means OPEN; persistence keeps the choice.
  const [closedGroups,setClosedGroups]=useState(()=>{
    try{
      const raw=localStorage.getItem(SIDEBAR_GROUPS_KEY);
      if(raw) return JSON.parse(raw)||{};
    }catch(e){}
    return {};
  });
  useEffect(()=>{
    try{ localStorage.setItem(SIDEBAR_GROUPS_KEY,JSON.stringify(closedGroups)); }catch(e){}
  },[closedGroups]);

  // Always reveal the group containing the current page (e.g. after a deep
  // link or a page change made from elsewhere).
  useEffect(()=>{
    const gi=groups.findIndex(g=>g.items.some(i=>i.key===page));
    if(gi>=0){
      const gk=groups[gi].key;
      setClosedGroups(prev=>(prev[gk]?{...prev,[gk]:false}:prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[page]);

  const toggleGroup=(gk)=>setClosedGroups(prev=>({...prev,[gk]:!prev[gk]}));

  const rail=collapsed&&!isMobile;
  // В свёрнутом меню текста нет — имя и почта доступны подсказкой.
  const userTitle=user?`${user.full_name||user.email}\n${user.email}`:"";
  const w=rail?68:230;

  return(
    <div className={"fc-sidebar"+(mobileOpen?" fc-open":"")} style={{
      width:w,background:"var(--c-surface)",borderRight:"1px solid var(--c-border-3)",
      display:"flex",flexDirection:"column",flexShrink:0,
      padding:rail?"12px 8px":"10px 12px",
      overflow:"visible",position:"relative"
    }}>
      {/* Brand + collapse toggle */}
      <div style={{display:"flex",alignItems:"center",justifyContent:rail?"center":"space-between",marginBottom:10,minHeight:32,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10,overflow:"hidden"}}>
          <div style={{
            width:32,height:32,background:"var(--c-brand-solid)",borderRadius:8,
            display:"flex",alignItems:"center",justifyContent:"center",
            color:"var(--c-on-brand)",fontWeight:800,fontSize:15,flexShrink:0
          }}>F</div>
          {!rail&&<span style={{fontWeight:800,fontSize:17,color:"var(--c-text)",whiteSpace:"nowrap"}}>FleetCost</span>}
        </div>
        {/* Floating collapse toggle (desktop only, hidden on mobile via CSS) */}
        <button
          className={"fc-collapse-btn"+(rail?" rot":"")}
          onClick={()=>setCollapsed(c=>!c)}
          aria-label={rail?"Развернуть меню":"Свернуть меню"}
          aria-expanded={!rail}
          title={rail?"Развернуть меню (запомним выбор)":"Свернуть меню в иконки (запомним выбор)"}
          style={{
            position:"absolute",right:-12,top:18,width:24,height:24,
            borderRadius:"50%",background:"var(--c-surface)",border:"1px solid var(--c-border)",
            cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
            boxShadow:"0 2px 4px rgba(0,0,0,0.06)",zIndex:10,color:"var(--c-muted-2)",flexShrink:0
          }}
        >
          {SidebarIcons.collapse}
        </button>
      </div>

      {/* Navigation */}
      <nav aria-label="Основная навигация" style={{flex:1,minHeight:0,overflowY:"auto",overflowX:"hidden",paddingBottom:4}}>
        {groups.map((group,gi)=>{
          const closed=!rail&&!!closedGroups[group.key];
          return(
          <div key={group.key} style={{marginBottom:8}}>
            {!rail&&(
              <button
                type="button"
                className="fc-nav-group-head"
                aria-expanded={!closed}
                aria-controls={`fc-nav-group-${group.key}`}
                onClick={()=>toggleGroup(group.key)}
                style={{
                  width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",
                  gap:6,background:"none",border:"none",cursor:"pointer",textAlign:"left",
                  padding:"3px 8px 3px 8px",borderRadius:6,
                  fontSize:11,fontWeight:700,color:"var(--c-muted-2)",textTransform:"uppercase",letterSpacing:0.7
                }}
                title={closed?"Развернуть раздел":"Свернуть раздел"}
              >
                <span>{group.title}</span>
                <span className={"fc-nav-chevron"+(closed?" fc-closed":"")} aria-hidden="true">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </span>
              </button>
            )}
            {rail&&gi>0&&<div style={{margin:"3px 4px 6px",borderBottom:"1px solid var(--c-surface-2)"}}/>}
            <div id={`fc-nav-group-${group.key}`} hidden={closed}>
            {group.items.map(({key,icon,label})=>{
              const active=page===key;
              return(
                <button
                  type="button"
                  key={key}
                  className="fc-nav-item"
                  onClick={()=>setPage(key)}
                  title={rail?label:undefined}
                  aria-current={active?"page":undefined}
                  style={{
                    width:"100%",display:"flex",alignItems:"center",gap:9,
                    justifyContent:rail?"center":"flex-start",
                    padding:rail?"7px 0":"5px 9px",margin:"1px 0",borderRadius:8,
                    border:"none",cursor:"pointer",textAlign:"left",fontFamily:"inherit",
                    fontSize:12,fontWeight:active?600:500,
                    color:active?"var(--c-brand)":"var(--c-muted-2)",
                    background:active?"var(--c-brand-bg)":"transparent",
                    overflow:"hidden",whiteSpace:"nowrap"
                  }}
                >
                  <span className="fc-nav-icon" style={{flexShrink:0,display:"flex",width:18,height:18,alignItems:"center",justifyContent:"center"}}>{icon}</span>
                  {!rail&&<span style={{overflow:"hidden",textOverflow:"ellipsis"}}>{label}</span>}
                </button>
              );
            })}
            </div>
          </div>
          );
        })}
      </nav>

      {/* Подвал из двух строк.
          Первая: оформление слева, язык справа (space-between). Оба — один и
          тот же контрол (Segmented), но разнесённые по краям: раньше они
          стояли вплотную, и два переключателя читались как одна деталь.
          Оформление — три состояния (солнце / луна / компьютер = как в системе),
          язык — RU / EN.
          Вторая: профиль и «Выход» одной серой карточкой, выход встроен справа.
          Имя и почта приходят из /auth/me (см. App.jsx); пока ответа нет,
          блок пользователя не рендерится вообще, а не показывает заглушку.
          В свёрнутом меню (52px) карточку не сделать: аватар и кнопка выхода
          (26 и 32px) не встают рядом, поэтому там они по-прежнему столбиком —
          отдельными элементами без общей подложки. */}
      <div style={{paddingTop:8,borderTop:"1px solid var(--c-border-3)",flexShrink:0}}>
        {rail ? (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
            <button type="button" className="fc-nav-item"
                    title={themeTitle(lang,themeMode)}
                    onClick={()=>setThemeMode(nextThemeMode(themeMode))}
                    style={{width:"100%",display:"flex",justifyContent:"center",padding:"6px 0",
                            border:"none",background:"none",cursor:"pointer",color:"var(--c-muted-2)"}}>
              <span style={{display:"flex",width:16,height:16}}>{THEME_ICONS[themeMode]}</span>
            </button>
            <button type="button" className="fc-nav-item"
                    title={`${lang==="RU"?"Русский":"English"} — переключить язык`}
                    onClick={()=>setLang(lang==="RU"?"EN":"RU")}
                    style={{width:"100%",display:"flex",justifyContent:"center",padding:"6px 0",
                            border:"none",background:"none",cursor:"pointer",fontFamily:"inherit",
                            fontSize:11,fontWeight:700,color:"var(--c-muted-2)"}}>
              {lang}
            </button>
          </div>
        ) : (
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                       gap:8,marginBottom:8}}>
            <Segmented ariaLabel={lang==="RU"?"Оформление":"Appearance"}
                       value={themeMode} onChange={setThemeMode}
                       items={THEME_MODES.map(m=>({
                         id:m, icon:THEME_ICONS[m], title:themeTitle(lang,m),
                       }))}/>
            <Segmented ariaLabel={lang==="RU"?"Язык интерфейса":"Interface language"}
                       value={lang} onChange={setLang}
                       items={[{id:"RU",label:"RU",title:"Русский язык"},
                               {id:"EN",label:"EN",title:"English"}]}/>
          </div>
        )}
        {user ? (
          rail ? (
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
              <span aria-hidden="true" title={userTitle} style={AVATAR}>{initialsOf(user)}</span>
              <LogoutButton compact onLogout={onLogout} label={t.logout}/>
            </div>
          ) : (
            /* Профиль и «Выход» — ОДНА карточка: кнопка выхода встроена в тот же
               серый блок справа, а не висит отдельным элементом рядом. Фон и
               рамка блока мягкие (--c-surface-2 / --c-border-2) — те же, что у
               «дорожки» переключателей выше, поэтому подвал читается цельно. */
            <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0,
                         padding:"6px 8px",borderRadius:"var(--r-md)",
                         background:"var(--c-surface-2)",border:"1px solid var(--c-border-2)"}}>
              <div title={userTitle}
                   style={{display:"flex",alignItems:"center",gap:9,flex:1,minWidth:0}}>
                <span aria-hidden="true" style={{...AVATAR}}>{initialsOf(user)}</span>
                <span style={{minWidth:0,display:"flex",flexDirection:"column"}}>
                  <span style={{fontSize:12,fontWeight:700,color:"var(--c-text)",whiteSpace:"nowrap",
                                overflow:"hidden",textOverflow:"ellipsis"}}>{user.full_name||user.email}</span>
                  <span style={{fontSize:10.5,color:"var(--c-muted)",whiteSpace:"nowrap",
                                overflow:"hidden",textOverflow:"ellipsis"}}>{user.email}</span>
                </span>
              </div>
              <LogoutButton compact onLogout={onLogout} label={t.logout}/>
            </div>
          )
        ) : (
          <LogoutButton rail={rail} onLogout={onLogout} label={t.logout}/>
        )}
      </div>
    </div>
  );
}

/** Инициалы для аватара: из имени («Vit Koval» → «VK»), иначе первые две буквы
 *  почты. Нужны, когда в имени нет пробела (одно слово) — тогда вторая буква
 *  пустая, и мы остаёмся с одной. */
function initialsOf(u){
  const name=(u&&u.full_name||"").trim();
  if(name){
    const parts=name.split(/\s+/);
    return ((parts[0][0]||"")+(parts[1]?.[0]||"")).toUpperCase();
  }
  return ((u&&u.email)||"?").slice(0,2).toUpperCase();
}

/** Подпись к текущему режиму оформления — видна при наведении. */
function themeTitle(lang,mode){
  const ru={light:"Светлое оформление",dark:"Тёмное оформление",system:"Как в системе"};
  const en={light:"Light theme",dark:"Dark theme",system:"Match system"};
  return (lang==="RU"?ru:en)[mode]||"";
}

/** Следующий режим при переключении одним нажатием (режим «свёрнуто»). */
function nextThemeMode(mode){
  const order=["light","dark","system"];
  return order[(order.indexOf(mode)+1)%order.length];
}

const THEME_ICONS = {
  light: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>,
  dark: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>,
  system: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
};

const SidebarIcons = {
  dashboard: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  vehicles: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 18V6a2 2 0 00-2-2H4a2 2 0 00-2 2v11a1 1 0 001 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 001-1v-3.65a1 1 0 00-.22-.624l-3.48-4.35A1 1 0 0017.52 8H14"/></svg>,
  mileage: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 12l4-4"/><path d="M12 3v1"/><path d="M21 12h-1"/><path d="M4 12H3"/></svg>,
  fuel: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 22V6a2 2 0 012-2h8a2 2 0 012 2v16"/><path d="M15 10h4l3 5v7h-7V10z"/><circle cx="7" cy="14" r="1"/><circle cx="17" cy="16" r="1"/></svg>,
  adblue: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v6"/><path d="M12 18v4"/><path d="M4.93 4.93l4.24 4.24"/><path d="M14.83 14.83l4.24 4.24"/><path d="M2 12h6"/><path d="M16 12h6"/><path d="M4.93 19.07l4.24-4.24"/><path d="M14.83 9.17l4.24-4.24"/></svg>,
  tolls: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 20h18"/><path d="M5 20V8l7-5 7 5v12"/><path d="M9 20v-6h6v6"/><path d="M8 12h8"/></svg>,
  other: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><circle cx="12" cy="14" r="2"/></svg>,
  salary: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 10-16 0"/><path d="M12 4V2"/></svg>,
  insurance: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  leasing: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/><line x1="7" y1="15" x2="13" y2="15"/></svg>,
  trailers: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17h2"/><path d="M5 17V7h11v10"/><rect x="5" y="7" width="11" height="10"/><circle cx="8" cy="18" r="2"/><circle cx="15" cy="18" r="2"/><path d="M16 9h2l2 2v6"/></svg>,
  general: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>,
  income: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  users: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  audit: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  fxrates: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
  importcenter: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  logout: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  collapse: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>,
  expand: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>,
};

// only has to carry one configuration entry instead of two.
const ROLE_GATES={
  // Администрирование — только владелец: у менеджера вместо него «Курсы валют»
  // (см. группу config выше), а импорт данных ему доступен прямо на рабочих
  // вкладках — «Топливо», «Доходы», «Ручной ввод».
  admin:["owner"],
  fxrates:["manager"],
  importcenter:["owner","manager"],
};

const SIDEBAR_COLLAPSED_KEY="fc_sidebar_collapsed";

const SIDEBAR_GROUPS_KEY="fc_sidebar_groups";

/** Круг с инициалами: один и тот же в блоке пользователя и в подвале меню. */
const AVATAR={width:26,height:26,borderRadius:"50%",flexShrink:0,background:"var(--c-brand-bg)",
  color:"var(--c-brand)",display:"flex",alignItems:"center",justifyContent:"center",
  fontSize:11,fontWeight:800,letterSpacing:0.2};

/** Кнопка «Выход». Отдельным компонентом: в подвале она нужна в двух видах —
 *  компактной иконкой рядом с пользователем и широкой строкой, пока данные о
 *  пользователе не пришли. Копия разметки разошлась бы при первой же правке. */
function LogoutButton({onLogout,label,compact=false,rail=false}){
  return(
    <button type="button" className="fc-nav-item" onClick={onLogout}
            title={label} aria-label={label}
            style={{flexShrink:0,display:"flex",alignItems:"center",
                    justifyContent:(compact||rail)?"center":"flex-start",gap:9,
                    width:compact?32:"100%",height:compact?32:"auto",
                    padding:compact?0:(rail?"8px 0":"7px 9px"),borderRadius:8,cursor:"pointer",
                    border:"none",background:"none",textAlign:"left",fontFamily:"inherit",
                    // --c-danger вместо --c-danger-400: прежний красный на белом давал
                    // 3.76 при норме 4.5 (замер превью темы).
                    fontSize:12,fontWeight:500,color:"var(--c-danger)"}}>
      <span style={{flexShrink:0,display:"flex",width:18,height:18,alignItems:"center",
                    justifyContent:"center"}}>{SidebarIcons.logout}</span>
      {!compact&&!rail&&<span>{label}</span>}
    </button>
  );
}
