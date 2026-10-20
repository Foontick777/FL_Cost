import { apiGet } from "../lib/api.js";
import { MONO, fmtInstant } from "../lib/format.js";
import { s, pill } from "../ui/styles.js";
import { Card, DiffView, Pagination } from "../ui/components.jsx";
import { ENTITY_RU, entityRu } from "../ui/constants.js";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal.jsx";
/** Страница «Журнал действий».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js.
 *  Открывается только внутри вкладок администрирования (см. AdminPage). */
export function AuditLogPage({t,lang,embedded}){
  const [entries,setEntries]=useState([]);
  const [users,setUsers]=useState([]);
  const [loading,setLoading]=useState(false);
  const [filters,setFilters]=useState({action:"",entity_type:"",date_from:"",date_to:"",user_id:"",search:""});
  const [offset,setOffset]=useState(0);
  const [total,setTotal]=useState(0);
  const [selected,setSelected]=useState(null);  // for details drawer
  const [actions,setActions]=useState([]);      // action list built from real data
  const [copied,setCopied]=useState(null);
  const [searchInput,setSearchInput]=useState("");  // what the user is typing
  // 50 записей на страницу — как и во всех остальных таблицах приложения.
  // Раньше здесь стояло 100, из-за чего журнал выбивался из общего ряда, а
  // «Показано … из …» считалось от другого делителя.
  const limit=50;

  // Поиск идёт на сервер (параметр search), а не по загруженной странице: иначе
  // «ничего не найдено» означало бы «нет на этой странице», а не «нет в журнале».
  // Поэтому ввод с задержкой — чтобы не дёргать API на каждую букву.
  useEffect(()=>{
    const id=setTimeout(()=>{
      setFilters(f=> f.search===searchInput ? f : {...f,search:searchInput});
      setOffset(0);
    },350);
    return ()=>clearTimeout(id);
  },[searchInput]);

  // Build the "Действие" filter from what is actually in the journal, so a new
  // action type (SYNC/RECONCILE/LOGIN_FAILED) can never be missing from the
  // dropdown again — the hard-coded list silently lacked them.
  useEffect(()=>{
    (async()=>{
      try{
        const r=await apiGet("/audit-log/actions");
        if(r&&Array.isArray(r.actions)) setActions(r.actions);
      }catch(e){}
    })();
  },[]);

  const load=useCallback(async()=>{
    setLoading(true);
    const params=new URLSearchParams();
    if(filters.action) params.append("action",filters.action);
    if(filters.entity_type) params.append("entity_type",filters.entity_type);
    if(filters.date_from) params.append("date_from",filters.date_from);
    if(filters.date_to) params.append("date_to",filters.date_to);
    if(filters.user_id) params.append("user_id",filters.user_id);
    if(filters.search) params.append("search",filters.search);
    params.append("limit",String(limit));
    params.append("offset",String(offset));
    const [list,countR]=await Promise.all([
      apiGet(`/audit-log/?${params.toString()}`),
      apiGet(`/audit-log/count?${params.toString()}`),
    ]);
    setEntries(list||[]);
    if(countR) setTotal(countR.total||0);
    setLoading(false);
  },[filters,offset]);

  // Load users list for the filter dropdown
  const loadUsers=useCallback(async()=>{
    const myRole=(typeof window!=="undefined"&&window.__FLEETCOST_ROLE__)||"viewer";
    if(myRole!=="owner") return;  // only owner can list users (Issue #10)
    try {
      const list = await apiGet("/auth/users");
      if(Array.isArray(list)) setUsers(list);
    } catch(e) {}
  },[]);
  useEffect(()=>{load();loadUsers();},[load,loadUsers]);

  // Russian labels for actions
  const actionLabel=(action)=>{
    const labels={
      CREATE:"Создание",UPDATE:"Изменение",DELETE:"Удаление",
      CANCEL:"Отмена",SYNC:"Синхронизация",EXPORT:"Экспорт",
      // Смена пароля доступа e100 — отдельное действие: его ищут глазами
      // («когда меняли пароль»), и в общем «Изменении» оно бы терялось.
      PASSWORD_CHANGE:"Смена пароля e100",
      IMPORT:"Импорт",LOGIN:"Вход",LOGOUT:"Выход",
      RECONCILE:"Перезапись месяца",LOGIN_FAILED:"Неудачный вход",
    };
    return labels[action]||action;
  };
  // Цвета бейджей — как в редизайне: три смысловые группы (спокойные,
  // предупреждающие, разрушительные) вместо 13 почти неразличимых оттенков.
  // Само действие по-прежнему написано в бейдже, так что информация не потеряна.
  const actionBadge=(action)=>{
    const destructive=["DELETE","LOGIN_FAILED"];
    const warning=["UPDATE","CANCEL","RECONCILE","PASSWORD_CHANGE"];
    const neutral=["LOGOUT"];
    const c = destructive.includes(action) ? {bg:"var(--c-danger-bg-2)",fg:"var(--c-rose)",bd:"var(--c-danger-border)"}
            : warning.includes(action)     ? {bg:"var(--c-warn-bg)",fg:"var(--c-warn-strong)",bd:"var(--c-warn-border)"}
            : neutral.includes(action)     ? {bg:"var(--c-surface-2)",fg:"var(--c-muted)",bd:"var(--c-border)"}
            :                                {bg:"var(--c-info-bg-2)",fg:"var(--c-sky)",bd:"var(--c-info-border-2)"};
    return <span style={pill(c.bg,c.fg,c.bd)}>{actionLabel(action)}</span>;
  };

  // Parse User-Agent into "Browser · OS" short form for the table.
  //
  // Order matters and was wrong: an iPhone/iPad UA contains "like Mac OS X",
  // and an Android UA contains "Linux" — so iOS and Android were unreachable
  // and those devices were reported as macOS / Linux. Specific checks first.
  const parseUA=(ua)=>{
    if(!ua) return {short:"—",full:null};
    let browser="Другое", os="Другое";
    // ── OS first (specific → generic) ──
    if(/iPhone|iPad|iPod/.test(ua)) os="iOS";
    else if(/Android/.test(ua)) os="Android";
    else if(/Windows NT 10|Windows NT 11/.test(ua)) os="Windows";
    else if(/Windows/.test(ua)) os="Windows";
    else if(/Mac OS X|Macintosh/.test(ua)) os="macOS";
    else if(/CrOS/.test(ua)) os="ChromeOS";
    else if(/Linux/.test(ua)) os="Linux";
    // ── Browser (specific → generic; order matters, Edge/Oculus contain "Chrome") ──
    if(/Edg[A-Z]?\/(\d+)/.test(ua)) browser="Edge "+(ua.match(/Edg[A-Z]?\/(\d+)/)||[])[1];
    else if(/OPR\/(\d+)/.test(ua)) browser="Opera "+(ua.match(/OPR\/(\d+)/)||[])[1];
    else if(/YaBrowser\/(\d+)/.test(ua)) browser="Yandex "+(ua.match(/YaBrowser\/(\d+)/)||[])[1];
    else if(/Firefox\/(\d+)/.test(ua)) browser="Firefox "+(ua.match(/Firefox\/(\d+)/)||[])[1];
    else if(/CriOS\/(\d+)/.test(ua)) browser="Chrome iOS "+(ua.match(/CriOS\/(\d+)/)||[])[1];
    else if(/FxiOS\/(\d+)/.test(ua)) browser="Firefox iOS "+(ua.match(/FxiOS\/(\d+)/)||[])[1];
    else if(/Chrome\/(\d+)/.test(ua)) browser="Chrome "+(ua.match(/Chrome\/(\d+)/)||[])[1];
    else if(/Safari\//.test(ua)) browser="Safari";
    else if(/curl|python|httpx|axios|okhttp/i.test(ua)) browser="Скрипт/бот";
    return {short:`${browser} · ${os}`, full:ua};
  };

  // Human-readable short form of the browser UUID sent as X-Client-ID.
  // This is the STABLE per-browser identifier the audit log was designed
  // around — the User-Agent only tells you the software version, so two
  // different people on the same Chrome build looked identical.
  const shortClient=(cid)=>{
    if(!cid) return null;
    return cid.replace(/-/g,"").slice(0,8);
  };

  const copyToClipboard=async(text)=>{
    try{ await navigator.clipboard.writeText(String(text)); setCopied(text); setTimeout(()=>setCopied(null),1500); }
    catch(e){ /* clipboard blocked (http / permissions) — ignore */ }
  };

  const fmt=(v)=>{if(!v) return "—";try{return fmtInstant(v);}catch(e){return String(v);}};

  // «23.09.2026, 16:50» → дата и время отдельными строками, как в редизайне.
  const fmtParts=(v)=>{
    const full=fmt(v);
    const i=full.indexOf(", ");
    return i<0 ? {date:full,time:""} : {date:full.slice(0,i),time:full.slice(i+2)};
  };

  const resetFilters=()=>{
    setSearchInput("");
    setFilters({action:"",entity_type:"",date_from:"",date_to:"",user_id:"",search:""});
    setOffset(0);
  };

  const exportParams=()=>{
    const p=new URLSearchParams();
    if(filters.action) p.append("action",filters.action);
    if(filters.entity_type) p.append("entity_type",filters.entity_type);
    if(filters.date_from) p.append("date_from",filters.date_from);
    if(filters.date_to) p.append("date_to",filters.date_to);
    if(filters.user_id) p.append("user_id",filters.user_id);
    if(filters.search) p.append("search",filters.search);
    return p;
  };

  // Table cells: single line, ellipsis, full value in a tooltip (see `title`).
  const cellEllipsis={overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12};
  const thAdm={padding:"11px 16px",fontSize:11,fontWeight:600,color:"var(--c-muted-2)",
               textTransform:"uppercase",letterSpacing:"0.04em",textAlign:"left",whiteSpace:"nowrap"};
  const metaLabel={fontSize:10,fontWeight:700,color:"var(--c-muted-4)",textTransform:"uppercase",
                   letterSpacing:"0.05em",display:"block",marginBottom:2};

  const selectedJson=selected?JSON.stringify(selected,null,2):"";

  return(
    <div>
      {/* Заголовок печатаем только для отдельного пункта меню: внутри вкладок
          администрирования заголовок раздела рисует AdminPage, иначе он дублируется. */}
      {!embedded&&<h1 style={s.pageTitle}>📜 Журнал действий</h1>}

      {/* Фильтры: поиск и четыре уточнения одной сеткой, кнопки — отдельной
          строкой под чертой. Раньше шесть полей и четыре кнопки стояли в одной
          переносимой строке, и на ноутбуке это превращалось в кашу. */}
      <Card style={{marginBottom:14}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(175px,1fr))",gap:10}}>
          <div style={{position:"relative"}}>
            <span aria-hidden="true" style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:"var(--c-muted-4)"}}>🔍</span>
            <input style={{...s.input,paddingLeft:30}} value={searchInput}
                   aria-label="Поиск по журналу: IP, e-mail, объект"
                   placeholder="Поиск: IP, e-mail, объект…"
                   onChange={e=>setSearchInput(e.target.value)}/>
          </div>
          <select style={s.input} value={filters.action} aria-label="Действие"
                  onChange={e=>{setFilters(f=>({...f,action:e.target.value}));setOffset(0);}}>
            <option value="">Все действия</option>
            {(actions.length?actions:[
              {value:"CREATE",label:"Создание"},{value:"UPDATE",label:"Изменение"},
              {value:"DELETE",label:"Удаление"},{value:"SYNC",label:"Синхронизация"},
              {value:"IMPORT",label:"Импорт"},{value:"EXPORT",label:"Экспорт"},
              {value:"LOGIN",label:"Вход"},{value:"LOGIN_FAILED",label:"Неудачный вход"},
              {value:"RECONCILE",label:"Перезапись месяца"},{value:"LOGOUT",label:"Выход"},
              {value:"PASSWORD_CHANGE",label:"Смена пароля e100"},
            ]).map(a=><option key={a.value} value={a.value}>{a.label}{a.count?" ("+a.count+")":""}</option>)}
          </select>
          <select style={s.input} value={filters.entity_type} aria-label="Тип сущности"
                  onChange={e=>{setFilters(f=>({...f,entity_type:e.target.value}));setOffset(0);}}>
            <option value="">Все сущности</option>
            {Object.entries(ENTITY_RU).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
          <select style={s.input} value={filters.user_id} aria-label="Пользователь"
                  disabled={!users.length}
                  onChange={e=>{setFilters(f=>({...f,user_id:e.target.value}));setOffset(0);}}>
            <option value="">Все пользователи</option>
            {users.map(u=><option key={u.id} value={u.id}>{u.email}</option>)}
          </select>
          <input type="date" style={s.input} value={filters.date_from} aria-label="С даты"
                 onChange={e=>{setFilters(f=>({...f,date_from:e.target.value}));setOffset(0);}}/>
          <input type="date" style={s.input} value={filters.date_to} aria-label="По дату"
                 onChange={e=>{setFilters(f=>({...f,date_to:e.target.value}));setOffset(0);}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,
                     flexWrap:"wrap",marginTop:12,paddingTop:12,borderTop:"1px solid var(--c-surface-2)"}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button style={s.btn} onClick={resetFilters}>↺ Сбросить фильтры</button>
            <button style={s.btnPrimary} onClick={load} disabled={loading}>
              {loading?"⏳ Загрузка...":"🔄 Обновить"}
            </button>
          </div>
          <button style={{...s.btn,background:"var(--c-hover)"}}
                  title="Выгрузить журнал в CSV с текущими фильтрами — файл можно приложить к акту или передать аудитору"
                  onClick={()=>window.open(`/api/audit-log/export?${exportParams().toString()}`,"_blank")}>
            ⬇ Экспорт в CSV
          </button>
        </div>
      </Card>

      {/* Таблица: переходы по страницам — в футере самой карточки, как в редизайне */}
      <Card style={{padding:0}}>
        {entries.length===0&&!loading?(
          <div style={{padding:"48px 16px",textAlign:"center",color:"var(--c-muted-4)",fontSize:13}}>
            <div style={{fontSize:22,marginBottom:6}}>🔍</div>
            Записи не найдены по выбранным фильтрам
          </div>
        ):(
          /* Horizontal scroll wrapper + fixed layout: the table has 5 columns of
             user-supplied text (e-mail, entity id, UA, IP) and had neither, so a
             long value stretched the whole page and forced a page-level
             scrollbar. Cells now truncate with a tooltip instead. */
          <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:860}}>
            <colgroup>
              <col style={{width:"128px"}}/>
              <col style={{width:"186px"}}/>
              <col style={{width:"136px"}}/>
              <col style={{width:"180px"}}/>
              <col style={{width:"210px"}}/>
              <col style={{width:"112px"}}/>
            </colgroup>
            <thead>
              <tr style={{background:"var(--c-hover)",borderBottom:"1px solid var(--c-border-3)"}}>
                <th style={thAdm} title="Время в вашем часовом поясе">Время</th>
                <th style={thAdm}>Пользователь</th>
                <th style={thAdm}>Действие</th>
                <th style={thAdm}>Объект</th>
                <th style={thAdm}>Клиент / IP</th>
                <th style={{...thAdm,textAlign:"right"}}>Детали</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e=>{
                const ua=parseUA(e.user_agent);
                const cid=shortClient(e.client_id);
                const when=fmtParts(e.created_at);
                const isSystem=!e.user_email||e.user_email==="system";
                return (
                  <tr key={e.id} className="fc-row-hover"
                      style={{borderBottom:"1px solid var(--c-surface-2)",cursor:"pointer"}}
                      onClick={()=>setSelected(e)}>
                    <td style={{padding:"11px 16px"}}>
                      <div style={{fontSize:12,fontWeight:600,color:"var(--c-text)",whiteSpace:"nowrap"}}>{when.date}</div>
                      <div style={{fontSize:11,color:"var(--c-muted-4)",fontFamily:MONO}}>{when.time}</div>
                    </td>
                    <td style={{padding:"11px 16px"}}>
                      {isSystem?(
                        <span title="Изменение сделано фоновой задачей, а не человеком"
                              style={{display:"inline-block",padding:"2px 8px",borderRadius:6,background:"var(--c-surface-2)",
                                      color:"var(--c-muted)",fontSize:11,fontWeight:600,fontFamily:MONO}}>🤖 system</span>
                      ):(
                        <div style={cellEllipsis} title={e.user_email}>{e.user_email}</div>
                      )}
                    </td>
                    <td style={{padding:"11px 16px"}}>{actionBadge(e.action)}</td>
                    <td style={{padding:"11px 16px"}}>
                      <span style={{fontSize:12,fontWeight:600,color:"var(--c-brand)"}} title={e.entity_type}>{entityRu(e.entity_type)}</span>
                      <span style={{fontSize:11,color:"var(--c-muted-4)",fontFamily:MONO,marginLeft:5}} title={e.entity_id||""}>#{e.entity_id||"—"}</span>
                    </td>
                    <td style={{padding:"11px 16px"}}>
                      <div style={{...cellEllipsis,color:"var(--c-text-4)"}} title={e.user_agent||""}>{ua.short}</div>
                      {/* Stable per-browser UUID (8 chars) — the reliable way to
                          tell "same laptop" from "another device", because the
                          UA string alone is identical across machines. */}
                      <div style={{...cellEllipsis,fontSize:11,color:"var(--c-muted-4)",fontFamily:MONO}}
                           title={e.client_id?`client_id: ${e.client_id}`:"client_id не записан (старая запись)"}>
                        {e.ip_address||"—"}{cid?` · ⌗${cid}`:""}
                      </div>
                    </td>
                    <td style={{padding:"11px 16px",textAlign:"right"}}>
                      <button className="fc-audit-open"
                              style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",
                                      fontSize:12,fontWeight:500,color:"var(--c-brand)",padding:"4px 6px",borderRadius:6,
                                      whiteSpace:"nowrap"}}
                              onClick={(ev)=>{ev.stopPropagation();setSelected(e);}}>Подробнее →</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        <Pagination total={total} limit={limit} offset={offset}
                    onChange={(p)=>setOffset(p*limit)} lang={lang}/>
      </Card>

      {/* Выдвижная панель деталей — структура как в редизайне: шапка с бейджем и
          номером, сетка «кто/когда/что/откуда», diff «Было / Стало», технический
          контекст и кнопки в футере. Escape, фокус-ловушку и возврат фокуса
          обеспечивает <Modal>, поэтому своего обработчика Escape здесь нет. */}
      {selected&&<Modal variant="drawer" label={`Детали записи ${selected.id}`} onClose={()=>setSelected(null)} maxWidth={576} zIndex={999} className={undefined} backdropStyle={{background:"rgba(15,23,42,0.35)"}}>
          <div style={{padding:"18px 22px",borderBottom:"1px solid var(--c-border-3)",background:"var(--c-surface-3)",
                       display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
            <div style={{minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                {actionBadge(selected.action)}
                <span style={{fontSize:11,fontFamily:MONO,color:"var(--c-muted-4)"}}>#{selected.id}</span>
              </div>
              <h3 style={{margin:"6px 0 0",fontSize:16,fontWeight:700,color:"var(--c-text)"}}>
                Изменение: {entityRu(selected.entity_type)} #{selected.entity_id||"—"}
              </h3>
            </div>
            <button style={{...s.btn,padding:"6px 10px",flexShrink:0}} onClick={()=>setSelected(null)} aria-label="Закрыть (Esc)">✕</button>
          </div>

          <div style={{flex:1,overflow:"auto",padding:22,display:"flex",flexDirection:"column",gap:20}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,background:"var(--c-hover)",
                         border:"1px solid var(--c-surface-3)",borderRadius:12,padding:16,fontSize:12}}>
              <div>
                <span style={metaLabel}>Дата и время</span>
                <span style={{fontFamily:MONO,fontSize:12,color:"var(--c-text)"}}>{fmt(selected.created_at)}</span>
              </div>
              <div>
                <span style={metaLabel}>Пользователь</span>
                <span style={{fontWeight:600,color:"var(--c-text)",wordBreak:"break-all"}}>{selected.user_email||"system"}</span>
              </div>
              <div>
                <span style={metaLabel}>Сущность</span>
                <span style={{fontWeight:600,color:"var(--c-brand)"}}>{entityRu(selected.entity_type)}</span>
                <span style={{fontFamily:MONO,color:"var(--c-muted-4)",marginLeft:4}}>#{selected.entity_id||"—"}</span>
              </div>
              <div>
                <span style={metaLabel}>IP-адрес</span>
                <span style={{fontFamily:MONO,color:"var(--c-text)"}}>{selected.ip_address||"—"}</span>
              </div>
            </div>

            <div>
              <h4 style={{margin:"0 0 10px",fontSize:11,fontWeight:700,textTransform:"uppercase",
                          letterSpacing:"0.05em",color:"var(--c-muted-2)"}}>⇄ Изменения атрибутов (Было / Стало)</h4>
              <DiffView oldV={selected.old_value} newV={selected.new_value}/>
            </div>

            <div>
              <h4 style={{margin:"0 0 8px",fontSize:11,fontWeight:700,textTransform:"uppercase",
                          letterSpacing:"0.05em",color:"var(--c-muted-2)"}}>Клиент и устройство</h4>
              <div style={{fontSize:12,color:"var(--c-text)"}}>{parseUA(selected.user_agent).short}</div>
              {/* Stable per-browser identifier — полный UUID по копированию, потому
                  что целиком в строку не помещается. */}
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6,flexWrap:"wrap"}}>
                <span style={{fontSize:12,color:"var(--c-muted-2)"}}>Устройство:</span>
                <span style={{fontFamily:MONO,fontSize:12,color:"var(--c-text)"}}
                      title={selected.client_id||"client_id не записан (запись до включения Issue #6)"}>
                  {selected.client_id?shortClient(selected.client_id)+"…":"—"}
                </span>
                {selected.client_id&&(
                  <button style={{...s.btn,fontSize:11,padding:"2px 7px"}}
                          onClick={()=>copyToClipboard(selected.client_id)}>
                    {copied===selected.client_id?"скопировано":"копировать"}
                  </button>
                )}
              </div>
              {!selected.client_id&&(
                <div style={{fontSize:12,color:"var(--c-muted-2)",marginTop:4}}>Для этой записи идентификатор браузера не сохранялся.</div>
              )}
              {/* Raw UA collapses — up to 512 characters used to be printed as a
                  wall of 10px monospace text. */}
              {selected.user_agent&&(
                <details style={{marginTop:8}}>
                  <summary style={{cursor:"pointer",fontSize:12,color:"var(--c-muted-2)"}}>Показать User-Agent</summary>
                  <div style={{display:"flex",alignItems:"flex-start",gap:8,marginTop:6}}>
                    <pre style={{flex:1,margin:0,fontSize:12,fontFamily:MONO,whiteSpace:"pre-wrap",wordBreak:"break-word",background:"var(--c-hover)",padding:8,borderRadius:8,color:"var(--c-text-4)",maxHeight:140,overflow:"auto"}}>
                      {selected.user_agent}
                    </pre>
                    <button style={{...s.btn,fontSize:11,padding:"2px 7px"}} onClick={()=>copyToClipboard(selected.user_agent)}>
                      {copied===selected.user_agent?"✓":"копировать"}
                    </button>
                  </div>
                </details>
              )}
            </div>

            <div>
              <h4 style={{margin:"0 0 8px",fontSize:11,fontWeight:700,textTransform:"uppercase",
                          letterSpacing:"0.05em",color:"var(--c-muted-2)"}}>Технический контекст</h4>
              <pre style={{margin:0,background:"var(--c-code-bg)",color:"var(--c-code-fg)",padding:14,borderRadius:12,
                           fontSize:11,fontFamily:MONO,overflowX:"auto",lineHeight:1.6,maxHeight:260}}>
                {selectedJson}
              </pre>
            </div>
          </div>

          <div style={{padding:"14px 22px",borderTop:"1px solid var(--c-border-3)",background:"var(--c-surface-3)",
                       display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
            <button style={s.btn} onClick={()=>copyToClipboard(selectedJson)}>
              {copied===selectedJson?"✓ Скопировано":"⧉ Копировать JSON"}
            </button>
            <button style={s.btnPrimary} onClick={()=>setSelected(null)}>Закрыть</button>
          </div>
        </Modal>}
    </div>
  );
}
