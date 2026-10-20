import { apiFetch, apiGet } from "../lib/api.js";
import { s, pill } from "../ui/styles.js";
import { Card } from "../ui/components.jsx";
import { MONO, fmtInstant } from "../lib/format.js";
import { useEffect, useState } from "react";
/** Страница «Настройки».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function SettingsPage({t,setPage,embedded}){
  const [creds,setCreds]=useState([]);
  const [newCred,setNewCred]=useState({username:"",password:""});
  const [tg,setTg]=useState(null);
  const [scraper,setScraper]=useState(null);
  const [flash,setFlash]=useState("");
  // Правка существующего доступа: id открытой карточки + её поля. Пароль всегда
  // начинается пустым — хранимый не показывается нигде, и «оставить пустым»
  // означает «не менять».
  const [editId,setEditId]=useState(null);
  const [editForm,setEditForm]=useState({username:"",password:""});
  const msg=m=>{setFlash(m);setTimeout(()=>setFlash(""),4000);};

  useEffect(()=>{
    apiGet("/credentials/e100").then(d=>setCreds(Array.isArray(d)?d:[]));
    apiGet("/telegram").then(setTg);
    apiGet("/scraper").then(setScraper);
  },[]);

  const addCred=async()=>{
    const r=await apiFetch("/credentials/e100",{method:"POST",body:JSON.stringify({...newCred,label:"e100"})});
    const c=await r.json();setCreds(prev=>[...prev,c]);setNewCred({username:"",password:""});msg("✅ Saved");
  };
  const delCred=async id=>{await apiFetch(`/credentials/e100/${id}`,{method:"DELETE"});setCreds(prev=>prev.filter(c=>c.id!==id));};

  const startEdit=c=>{ setEditId(c.id); setEditForm({username:c.username,password:""}); };
  const cancelEdit=()=>{ setEditId(null); setEditForm({username:"",password:""}); };

  // Сохранение правки. Пустой пароль не отправляем вовсе: иначе он затёрся бы
  // на пустую строку. Логин уходит всегда — он показывается в поле, и если
  // пользователь его не трогал, сервер увидит то же значение и ничего не изменит.
  const saveEdit=async()=>{
    const body={username:editForm.username.trim()};
    if(editForm.password) body.password=editForm.password;
    const r=await apiFetch(`/credentials/e100/${editId}`,{method:"PATCH",body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ msg(`❌ ${d.detail||"Не удалось сохранить"}`); return; }
    setCreds(prev=>prev.map(c=>c.id===d.id?d:c));
    cancelEdit();
    // Подтверждаем именно то, что нужно пользователю: следующая синхронизация
    // зайдёт с новыми данными, и с какой даты это действует.
    msg(`✅ ${body.password?t.credSavedWithPassword:t.credSaved}${d.password_changed_at?` · ${t.passwordChangedAt} ${fmtInstant(d.password_changed_at)}`:""}`);
  };
  const saveTg=async()=>{await apiFetch("/telegram",{method:"PATCH",body:JSON.stringify(tg)});msg("✅ Saved");};
  const saveScraper=async()=>{await apiFetch("/scraper",{method:"PATCH",body:JSON.stringify(scraper)});msg("✅ Saved");};
  return(
    <div style={s.page}>
      {/* Заголовок печатаем только для отдельного пункта меню: внутри вкладок
          администрирования заголовок раздела рисует AdminPage, иначе он дублируется. */}
      {!embedded&&<h1 style={s.pageTitle}>⚙️ {t.settings}</h1>}
      {flash&&<div style={s.flash}>{flash}</div>}
      <Card style={{marginBottom:14}}>
        <h3 style={s.cardTitle}>🔑 e100.eu Credentials</h3>
        <p style={s.cardSub}>
          Логин и пароль, под которыми сборщик заходит в e100.eu. Пароль хранится в базе компании,
          в интерфейсе не показывается. Когда e100 просит сменить пароль — правьте его здесь кнопкой
          «{t.editCred}»: доступ остаётся тем же, история синхронизаций сохраняется, а следующая
          синхронизация заходит уже с новым паролем.
        </p>
        {creds.length===0&&(
          <div style={{...s.empty,marginBottom:4}}>Ни одного доступа не добавлено — синхронизация работать не будет</div>
        )}
        {creds.map(c=>(
          <div key={c.id} className="fc-row-hover"
               style={{...s.row,marginBottom:8,padding:"10px 12px",border:"1px solid var(--c-surface-3)",borderRadius:"var(--r-md)"}}>
            <div style={{minWidth:0}}>
              <div style={{fontWeight:600,fontSize:13}}>{c.username}</div>
              {/* Состояние последней синхронизации — пилюлей, а не цветным
                  текстом: цвет текста не читается при дальтонизме и теряется
                  в списке, а подпись «✓ Синхронизировано» видна сразу. */}
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4,flexWrap:"wrap"}}>
                {c.last_sync_status==="ok"
                  ? <span style={pill("var(--c-success-bg-3)","var(--c-emerald-strong)","var(--c-success-border)")}>✓ {t.lastSync}</span>
                  : <span style={pill("var(--c-danger-bg)","var(--c-danger-strong)","var(--c-danger-border)")}>✕ {t.lastSync}</span>}
                <span style={{fontSize:12,color:"var(--c-muted-2)",fontFamily:MONO}}>
                  {c.last_sync_at?fmtInstant(c.last_sync_at):"—"}
                </span>
                {/* Дата смены пароля: по ней видно, что доступ уже обновлён после
                    требования e100 сменить пароль, и когда это было. */}
                {c.password_changed_at&&(
                  <span style={pill("var(--c-info-bg-2)","var(--c-sky)","var(--c-info-border-2)")}
                        title={t.passwordChangedAt}>
                    🔑 {t.passwordChangedAt} {fmtInstant(c.password_changed_at)}
                  </span>
                )}
              </div>
              {c.last_sync_status!=="ok"&&c.last_sync_error&&(
                <div style={{fontSize:11,color:"var(--c-danger-strong)",marginTop:4,lineHeight:1.35,wordBreak:"break-word"}}>
                  {c.last_sync_error}
                </div>
              )}
            </div>
            <div style={{display:"flex",gap:6,flexShrink:0}}>
              <button style={s.btn} onClick={()=>editId===c.id?cancelEdit():startEdit(c)} title={t.editCred}>
                {editId===c.id?t.cancel:t.editCred}
              </button>
              <button style={s.btnDanger} onClick={()=>delCred(c.id)} title="Удалить доступ">✕</button>
            </div>
          </div>
        ))}
        {/* Правка открывается под той карточкой, которую меняют: видно и старую
            сессию, и куда вводить новые данные. Раньше правка была недоступна —
            приходилось удалять доступ и добавлять заново, теряя историю
            синхронизаций (id доступа при этом НЕ меняется). */}
        {editId!==null&&(
          <div style={{marginTop:10,padding:"10px 12px",border:"1px solid var(--c-brand-500)",
                       background:"var(--c-brand-bg)",borderRadius:"var(--r-md)"}}>
            <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>✏️ {t.editCredTitle}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <input style={{...s.input,flex:1,minWidth:180}} aria-label={t.e100Login} placeholder={t.e100Login}
                     value={editForm.username} onChange={e=>setEditForm(f=>({...f,username:e.target.value}))}/>
              <input type="password" style={{...s.input,flex:1,minWidth:180}} aria-label={t.newPassword}
                     placeholder={t.newPassword} autoComplete="new-password"
                     value={editForm.password} onChange={e=>setEditForm(f=>({...f,password:e.target.value}))}/>
              <button style={s.btnPrimary} onClick={saveEdit}>{t.save}</button>
              <button style={s.btn} onClick={cancelEdit}>{t.cancel}</button>
            </div>
            <div style={{fontSize:11,color:"var(--c-muted-2)",marginTop:6,lineHeight:1.4}}>
              {t.newPasswordHint}
            </div>
          </div>
        )}
        <div style={{display:"flex",gap:8,marginTop:10}}>
          <input style={{...s.input,flex:1}} placeholder={t.e100Login} value={newCred.username} onChange={e=>setNewCred({...newCred,username:e.target.value})}/>
          <input type="password" style={{...s.input,flex:1}} placeholder={t.e100Password} value={newCred.password} onChange={e=>setNewCred({...newCred,password:e.target.value})}/>
          <button style={s.btnPrimary} onClick={addCred}>{t.addCred}</button>
        </div>
      </Card>
      {scraper&&(
        <Card style={{marginBottom:14}}>
          <h3 style={s.cardTitle}>⏱️ Sync Schedule</h3>
          <p style={s.cardSub}>
            Как часто и за какой период фоновый сборщик забирает данные из e100. Большой период
            замедляет синхронизацию и может упереться в лимиты сервиса.
          </p>
          <div style={{display:"flex",gap:14,flexWrap:"wrap",alignItems:"flex-end"}}>
            <div><label style={s.label} htmlFor="fc-f-42">{t.syncInterval}</label>
              <input id="fc-f-42" type="number" style={{...s.input,width:100}} value={scraper.interval_minutes} onChange={e=>setScraper({...scraper,interval_minutes:+e.target.value})}/></div>
            <div><label style={s.label} htmlFor="fc-f-43">{t.lookbackDays}</label>
              <input id="fc-f-43" type="number" style={{...s.input,width:100}} value={scraper.lookback_days} onChange={e=>setScraper({...scraper,lookback_days:+e.target.value})}/></div>
            <label style={{display:"flex",gap:6,alignItems:"center",fontSize:14}}>
              <input type="checkbox" checked={scraper.is_enabled} onChange={e=>setScraper({...scraper,is_enabled:e.target.checked})}/> Auto-sync
            </label>
          </div>
          <button style={{...s.btnPrimary,marginTop:10}} onClick={saveScraper}>{t.saveSettings}</button>
        </Card>
      )}
      {tg&&(
        <Card>
          <h3 style={s.cardTitle}>📱 Telegram</h3>
          <p style={s.cardSub}>
            Куда присылать уведомления: о новых транзакциях и об итогах дня. Чат определяется
            по его идентификатору.
          </p>
          <label style={s.label} htmlFor="fc-f-44">{t.telegramChatId}</label>
          <input id="fc-f-44" style={s.input} placeholder="123456789" value={tg.chat_id||""} onChange={e=>setTg({...tg,chat_id:e.target.value})}/>
          <div style={{display:"flex",flexDirection:"column",gap:8,margin:"10px 0"}}>
            {[["notify_on_transaction",t.notifyTx],["notify_daily_summary",t.notifyDaily],["is_active",t.enableTg]].map(([k,label])=>(
              <label key={k} style={{display:"flex",gap:6,alignItems:"center",fontSize:14}}>
                <input type="checkbox" checked={!!tg[k]} onChange={e=>setTg({...tg,[k]:e.target.checked})}/> {label}
              </label>
            ))}
          </div>
          <button style={s.btnPrimary} onClick={saveTg}>{t.saveSettings}</button>
        </Card>
      )}
    </div>
  );
}
