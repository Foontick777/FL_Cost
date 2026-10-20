import { s } from "../ui/styles.js";
import { SettingsPage } from "./SettingsPage.jsx";
import { FxRatesPage } from "./FxRatesPage.jsx";
import { AuditLogPage } from "./AuditLogPage.jsx";
import { UsersPage } from "./UsersPage.jsx";
import { ImportCenterPage } from "./ImportCenterPage.jsx";
import { CategoriesPage } from "./CategoriesPage.jsx";
import { useEffect, useState } from "react";
/** Страница «Администрирование (оболочка с вкладками)».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function AdminPage({t,lang,initialTab,setPage}){
  // Container page that holds 4 sub-tabs: Settings, FX Rates, Audit Log, Users.
  // This collapses 4 separate sidebar items into ONE, keeping the sidebar
  // compact on small screens (MacBook Air 13"). The tabs are persisted in
  // localStorage so the user returns to the same tab on reload.
  const myRole=(typeof window!=="undefined"&&window.__FLEETCOST_ROLE__)||"viewer";
  const STORAGE_KEY="fc_admin_tab";
  const TAB_KEYS=["settings","fxrates","categories","audit","users","importcenter"];
  // «Категории расходов» доступны и менеджеру: он добавляет категории в работе,
  // и ему нужно видеть/чинить справочник, не обращаясь к владельцу (§16 ТЗ).
  const roleAllowed=(k)=>(
    k==="users"||k==="settings"||k==="fxrates" ? myRole==="owner"
    : k==="importcenter"||k==="categories" ? (myRole==="owner"||myRole==="manager")
    : true
  );
  const fallbackTab=myRole==="owner"?"settings":"audit";
  const [tab,setTab]=useState(()=>{
    if(initialTab && roleAllowed(initialTab)) return initialTab;
    try{
      const saved=localStorage.getItem(STORAGE_KEY);
      if(saved && TAB_KEYS.includes(saved) && roleAllowed(saved)) return saved;
    }catch(e){}
    return fallbackTab;
  });
  useEffect(()=>{
    try{localStorage.setItem(STORAGE_KEY,tab);}catch(e){}
  },[tab]);

  // Each tab declares who may use it — previously every role saw the same list,
  // so a manager could open Settings/FX and hit 403 on every button.
  const ALL_TABS=[
    {key:"settings",label:"Настройки",icon:"⚙️",roles:["owner"]},
    {key:"fxrates",label:"Курсы валют",icon:"💱",roles:["owner"]},
    {key:"categories",label:"Категории расходов",icon:"🏷️",roles:["owner","manager"]},
    {key:"audit",label:"Журнал действий",icon:"📜",roles:["owner","manager","viewer"]},
    {key:"users",label:"Пользователи",icon:"👥",roles:["owner"]},
    {key:"importcenter",label:"Импорт данных",icon:"📥",roles:["owner","manager"]},
  ];
  const tabs=ALL_TABS.filter(tb=>tb.roles.includes(myRole));

  // Заголовок раздела под панелью вкладок: у каждой вкладки своё название и
  // пояснение (как в редизайне). Раньше каждая страница печатала свой <h1>, и
  // при переходе по вкладкам заголовок «прыгал» вместе с содержимым.
  const TAB_META={
    settings:{title:"Настройки компании", subtitle:"Параметры расчётов, ставки, валюта отчётности и служебные ключи."},
    fxrates:{title:"Курсы валют", subtitle:"Живые курсы, ручная правка и история изменений — от них зависит пересчёт в евро."},
    categories:{title:"Категории расходов", subtitle:"Разделы учёта фиксированы, категории внутри — любые: системные (штрафы, аренда, офис, КАСКО, ZUS) и свои для вашей страны и модели работы. Налоги и взносы — это раздел «Налоги и взносы» в этом же справочнике; отдельной вкладки для них не нужно, виджеты на странице «Зарплата» строятся по добавленным здесь категориям."},
    audit:{title:"Журнал действий системы", subtitle:"Полная история изменений транзакций, настроек, пользователей и фоновых синхронизаций."},
    users:{title:"Пользователи", subtitle:"Доступ сотрудников к системе: роли, статус учётных записей и создание новых."},
    importcenter:{title:"Импорт данных", subtitle:"Загрузка выгрузок Q8 и реестров доходов, история импортов и разбор ошибок."},
  };
  const meta=TAB_META[tab]||{title:"Администрирование"};

  return(
    <div style={s.page}>
      {/* Панель вкладок: белая карточка с «пилюлями», активная залита светлым
          индиго с рамкой — так видно и текущий раздел, и весь список сразу. */}
      <div style={{background:"var(--c-surface)",border:"1px solid var(--c-border-2)",borderRadius:12,
                   boxShadow:"0 1px 2px rgba(15,23,42,0.04)",padding:6,
                   display:"flex",alignItems:"center",gap:4,flexWrap:"wrap",marginBottom:16}}>
        {tabs.map(tb=>(
          <button key={tb.key}
                  type="button"
                  aria-current={tab===tb.key?"page":undefined}
                  className="fc-admintab"
                  style={tab===tb.key?
                    {display:"flex",alignItems:"center",gap:8,padding:"8px 14px",borderRadius:8,
                     border:"1px solid var(--c-violet-border-2)",background:"var(--c-brand-bg)",color:"var(--c-brand-strong)",
                     fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",
                     boxShadow:"0 1px 2px rgba(79,70,229,0.12)"}:
                    {display:"flex",alignItems:"center",gap:8,padding:"8px 14px",borderRadius:8,
                     border:"1px solid transparent",background:"none",color:"var(--c-muted)",
                     fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}
                  onClick={()=>setTab(tb.key)}>
            <span aria-hidden="true" style={{fontSize:14,lineHeight:1}}>{tb.icon}</span>
            <span>{tb.label}</span>
          </button>
        ))}
      </div>

      {/* Заголовок активного раздела */}
      <div style={{marginBottom:16}}>
        <h1 style={{margin:0,fontSize:20,fontWeight:700,color:"var(--c-text)",letterSpacing:"-0.01em"}}>{meta.title}</h1>
        {meta.subtitle&&<p style={{margin:"3px 0 0",fontSize:13,color:"var(--c-muted-2)",lineHeight:1.45}}>{meta.subtitle}</p>}
      </div>
      {/* Active tab content */}
      {tab==="settings"&&myRole==="owner"&&<SettingsPage key="settings" t={t} setPage={setPage} embedded/>}
      {tab==="fxrates"&&myRole==="owner"&&<FxRatesPage key="fxrates" t={t} lang={lang} embedded/>}
      {tab==="categories"&&(myRole==="owner"||myRole==="manager")&&
        <CategoriesPage key="categories" t={t} lang={lang}/>}
      {tab==="audit"&&<AuditLogPage key="audit" t={t} lang={lang} embedded/>}
      {tab==="users"&&myRole==="owner"&&<UsersPage key="users" t={t} embedded/>}
      {/* Импорт данных перенесён сюда из отдельного пункта меню, чтобы
          сайдбар не разрастался (это редкая операция уровня настроек). */}
      {tab==="importcenter"&&(myRole==="owner"||myRole==="manager")&&
        <ImportCenterPage key="importcenter" t={t} lang={lang} embedded/>}
    </div>
  );
}
