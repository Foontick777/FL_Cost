import { apiFetch, apiGet } from "../lib/api.js";
import { s, pill } from "../ui/styles.js";
import { Card, Pagination } from "../ui/components.jsx";
import { MONO, fmtInstant } from "../lib/format.js";
import { useCallback, useEffect, useMemo, useState } from "react";
/** Страница «Пользователи».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function UsersPage({t,embedded}){
  const [users,setUsers]=useState([]);
  const [me,setMe]=useState(null);
  const [form,setForm]=useState({email:"",password:"",full_name:"",role:"viewer"});
  const [flash,setFlash]=useState("");
  const [query,setQuery]=useState("");
  const [page,setPage]=useState(0);
  // Список пользователей приходит одним запросом целиком, поэтому фильтр и
  // постраничный вывод считаем на клиенте — это не «поиск по странице», а
  // поиск по всему списку. 50 на страницу, как во всех таблицах приложения.
  const limit=50;
  const [error,setError]=useState("");
  const msg=(m)=>{setFlash(m);setTimeout(()=>setFlash(""),4000);};
  const errMsg=(m)=>{setError(m);setTimeout(()=>setError(""),5000);};

  const load=useCallback(async()=>{
    const [u,mr]=await Promise.all([apiGet("/auth/users"),apiGet("/auth/me")]);
    if(u) setUsers(u);
    if(mr) { setMe(mr); window.__FLEETCOST_ROLE__=mr.role; }
  },[]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{setPage(0);},[query]);

  const filtered=useMemo(()=>{
    const q=query.trim().toLowerCase();
    if(!q) return users;
    return users.filter(u=>
      String(u.email||"").toLowerCase().includes(q) ||
      String(u.full_name||"").toLowerCase().includes(q) ||
      String(u.role||"").toLowerCase().includes(q));
  },[users,query]);
  const pageUsers=filtered.slice(page*limit,page*limit+limit);

  const addUser=async()=>{
    setError("");
    if(!form.email||!form.password){errMsg("Email и пароль обязательны");return;}
    if(form.password.length<10){errMsg("Пароль минимум 10 символов");return;}
    if(!/[A-Z]/.test(form.password)){errMsg("Нужна хотя бы одна заглавная буква");return;}
    if(!/[0-9]/.test(form.password)){errMsg("Нужна хотя бы одна цифра");return;}
    const r=await apiFetch("/auth/users",{
      method:"POST",
      body:JSON.stringify(form),
    });
    if(!r.ok){const d=await r.json().catch(()=>({detail:"Ошибка"}));errMsg(d.detail||"Ошибка");return;}
    setForm({email:"",password:"",full_name:"",role:"viewer"});
    msg("✅ Пользователь добавлен");
    load();
  };

  const patchUser=async(id,patch)=>{
    const r=await apiFetch(`/auth/users/${id}`,{method:"PATCH",body:JSON.stringify(patch)});
    if(!r.ok){const d=await r.json().catch(()=>({detail:"Ошибка"}));errMsg(d.detail||"Ошибка");return;}
    msg("✅ Сохранено");
    load();
  };

  const delUser=async(id,email)=>{
    if(!confirm(`Удалить пользователя ${email}? Действие необратимо.`)) return;
    const r=await apiFetch(`/auth/users/${id}`,{method:"DELETE"});
    if(!r.ok){const d=await r.json().catch(()=>({detail:"Ошибка"}));errMsg(d.detail||"Ошибка");return;}
    msg("✅ Удалён");
    load();
  };

  const thAdm={padding:"11px 16px",fontSize:11,fontWeight:600,color:"var(--c-muted-2)",
               textTransform:"uppercase",letterSpacing:"0.04em",textAlign:"left",whiteSpace:"nowrap"};
  const roleBadge=(role)=>{
    const map={
      owner:{bg:"var(--c-warn-bg)",fg:"var(--c-warn-strong)",label:"Owner",bd:"var(--c-warn-border)"},
      manager:{bg:"var(--c-info-bg-2)",fg:"var(--c-sky)",label:"Manager",bd:"var(--c-info-border-2)"},
      viewer:{bg:"var(--c-surface-2)",fg:"var(--c-muted)",label:"Viewer",bd:"var(--c-border)"},
    };
    const c=map[role]||{bg:"var(--c-surface-2)",fg:"var(--c-muted)",label:role,bd:"var(--c-border)"};
    return <span style={pill(c.bg,c.fg,c.bd)}>{c.label}</span>;
  };

  return(
    <div style={s.page}>
      {/* Заголовок печатаем только для отдельного пункта меню: внутри вкладок
          администрирования заголовок раздела рисует AdminPage, иначе он дублируется. */}
      {!embedded&&<h1 style={s.pageTitle}>👥 Управление пользователями</h1>}
      {error&&<div style={{background:"var(--c-danger-bg)",color:"var(--c-danger)",padding:"10px 14px",borderRadius:10,marginBottom:14,fontSize:14}}>{error}</div>}
      {flash&&<div style={s.flash}>{flash}</div>}

      <Card style={{marginBottom:14}}>
        <h3 style={s.cardTitle}>➕ Добавить пользователя</h3>
        <p style={{fontSize:13,color:"var(--c-muted-2)",margin:"0 0 12px"}}>Создание manager или viewer под вашей компанией. Owner создать нельзя — регистрация новой компании отдельно.</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr auto",gap:8,alignItems:"flex-end"}}>
          <div>
            <label style={s.label} htmlFor="fc-f-45">Email</label>
            <input id="fc-f-45" type="email" style={s.input} placeholder="name@company.com"
                   value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/>
          </div>
          <div>
            <label style={s.label} htmlFor="fc-f-46">Пароль</label>
            <input id="fc-f-46" type="password" style={s.input} placeholder="мин 10 символов"
                   value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/>
          </div>
          <div>
            <label style={s.label} htmlFor="fc-f-47">Имя</label>
            <input id="fc-f-47" style={s.input} placeholder="Иван Иванов"
                   value={form.full_name} onChange={e=>setForm({...form,full_name:e.target.value})}/>
          </div>
          <div>
            <label style={s.label} htmlFor="fc-f-48">Роль</label>
            <select id="fc-f-48" style={s.input} value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>
              <option value="viewer">Viewer (только просмотр)</option>
              <option value="manager">Manager (редактирование)</option>
            </select>
          </div>
          <button style={{...s.btnPrimary,padding:"9px 16px"}} onClick={addUser}>Добавить</button>
        </div>
      </Card>

      <Card>
        {/* Шапка карточки: заголовок, поиск и счётчик — как в журнале действий */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,
                     flexWrap:"wrap",marginBottom:14}}>
          <h3 style={{...s.cardTitle,margin:0}}>📋 Пользователи ({filtered.length}{query?` из ${users.length}`:""})</h3>
          <div style={{position:"relative",minWidth:240}}>
            <span aria-hidden="true" style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:"var(--c-muted-4)"}}>🔍</span>
            <input style={{...s.input,paddingLeft:30}} value={query} aria-label="Поиск по пользователям"
                   placeholder="Поиск: e-mail, имя, роль…" onChange={e=>setQuery(e.target.value)}/>
          </div>
        </div>

        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead>
            <tr style={{background:"var(--c-hover)",borderBottom:"1px solid var(--c-border-3)"}}>
              <th style={thAdm}>Email</th>
              <th style={thAdm}>Имя</th>
              <th style={thAdm}>Роль</th>
              <th style={thAdm}>Статус</th>
              <th style={thAdm}>Создан</th>
              <th style={{...thAdm,textAlign:"right"}}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {pageUsers.map(u=>(
              <tr key={u.id} className="fc-row-hover" style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                <td style={{padding:"11px 16px"}}>
                  <div style={{fontWeight:600,fontSize:13,color:"var(--c-text)"}}>{u.email}</div>
                  {me&&u.id===me.id&&<div style={{fontSize:11,color:"var(--c-muted-2)"}}>это вы</div>}
                </td>
                <td style={{padding:"11px 16px",fontSize:13,color:"var(--c-text-4)"}}>{u.full_name||"—"}</td>
                <td style={{padding:"11px 16px"}}>
                  {me&&u.id===me.id ? roleBadge(u.role) :
                    <select style={{padding:"4px 8px",borderRadius:6,border:"1px solid var(--c-border)",fontSize:12,
                                    fontFamily:"inherit",background:"var(--c-surface)"}}
                            value={u.role}
                            onChange={e=>patchUser(u.id,{role:e.target.value})}>
                      <option value="viewer">Viewer</option>
                      <option value="manager">Manager</option>
                    </select>}
                </td>
                <td style={{padding:"11px 16px"}}>
                  {u.is_active?
                    <span style={pill("var(--c-success-bg-3)","var(--c-emerald-strong)","var(--c-success-border)")}>● активен</span>:
                    <span style={pill("var(--c-danger-bg)","var(--c-rose)","var(--c-danger-border)")}>● отключён</span>}
                </td>
                <td style={{padding:"11px 16px"}}><span style={{fontFamily:MONO,fontSize:12,color:"var(--c-muted-2)"}}>{fmtInstant(u.created_at)}</span></td>
                <td style={{padding:"11px 16px",textAlign:"right"}}>
                  <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                    {me&&u.id!==me.id&&(
                      <>
                        <button style={{...s.btn,fontSize:12,padding:"4px 9px"}}
                                onClick={()=>patchUser(u.id,{is_active:!u.is_active})}>
                          {u.is_active?"Отключить":"Включить"}
                        </button>
                        <button style={{...s.btnDanger}} onClick={()=>delUser(u.id,u.email)}>✕</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length===0&&(
          <div style={{padding:"32px 16px",textAlign:"center",color:"var(--c-muted-4)",fontSize:13}}>
            {query?"Пользователи не найдены по запросу":"Пользователей нет"}
          </div>
        )}
        <Pagination total={filtered.length} limit={limit} offset={page*limit} onChange={setPage}/>
      </Card>
    </div>
  );
}
