import { useMemo, useState } from "react";
import { s } from "../ui/styles.js";
import { Card } from "../ui/components.jsx";
import {
  useCategories, createCategory, patchCategory, deleteCategory,
} from "../lib/categories.js";

/**
 * «Налоги и взносы» (ТЗ §6–7).
 *
 * Почему отдельная вкладка, а не поле в форме зарплаты. В ТЗ прямо сказано:
 * ZUS и PIT-4 должны остаться как готовые категории для Польши, но НЕ быть
 * жёстко зашитыми — иначе компания из другой страны видит «чужие» налоги и
 * считает, что программа не про неё. Здесь компания сама решает, какие налоги
 * и взносы у неё есть:
 *
 *   • ZUS и PIT-4 уже в списке — для Польши ничего настраивать не нужно;
 *   • для другой страны добавляется своя строка (ФСЗН, Lohnsteuer,
 *     социальные взносы, …) — столько, сколько нужно;
 *   • лишние категории отключаются, а не удаляются: расходы по ним за прошлые
 *     периоды остаются в отчётах;
 *   • удалить можно только категорию, по которой ещё не было операций.
 *
 * Виджеты на странице «Зарплата» строятся по этому же списку, поэтому
 * добавленный здесь налог сразу получает свою карточку в аналитике.
 */
export function TaxesPage({t, lang}){
  const ru=lang==="RU";
  const catState=useCategories();
  const [draftName,setDraftName]=useState("");
  const [draftIcon,setDraftIcon]=useState("");
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState(null);
  const [editing,setEditing]=useState(null);
  const [confirmDel,setConfirmDel]=useState(null);

  const taxes=useMemo(
    ()=>(catState.list||[])
      .filter(c=>c.section==="salary_tax")
      .sort((a,b)=>{
        if(a.is_system!==b.is_system) return a.is_system?-1:1;
        if(a.sort_order!==b.sort_order) return a.sort_order-b.sort_order;
        return (a.name||"").localeCompare(b.name||"");
      }),
    [catState.list],
  );

  const activeCount=taxes.filter(c=>c.is_active).length;
  const flash=(kind,text)=>{ setMsg({kind,text}); setTimeout(()=>setMsg(null),6000); };
  const inputStyle={...s.input, padding:"6px 9px", fontSize:13};
  const rowBtn={padding:"4px 10px",fontSize:12,fontWeight:600,borderRadius:6,cursor:"pointer",whiteSpace:"nowrap"};

  const add=async()=>{
    if(!draftName.trim()){ flash("err", ru?"Введите название налога или взноса":"Enter a tax or contribution name"); return; }
    setBusy(true);
    const res=await createCategory({section:"salary_tax", name:draftName.trim(), icon:draftIcon.trim()||"🏛️"});
    setBusy(false);
    if(!res.ok){ flash("err", res.error); return; }
    flash("ok", ru?`«${res.category.name}» добавлен в налоги и взносы (код: ${res.category.code})`
                  :`“${res.category.name}” added to taxes and contributions (code: ${res.category.code})`);
    setDraftName(""); setDraftIcon("");
  };

  const saveEdit=async()=>{
    setBusy(true);
    const res=await patchCategory(editing.id,{name:editing.name, icon:editing.icon});
    setBusy(false);
    if(!res.ok){ flash("err", res.error); return; }
    flash("ok", ru?"Обновлено":"Updated");
    setEditing(null);
  };

  const doDelete=async(c)=>{
    setBusy(true);
    const res=await deleteCategory(c.id);
    setBusy(false);
    setConfirmDel(null);
    if(!res.ok){ flash("err", res.error); return; }
    flash("ok", ru?"Категория удалена":"Category deleted");
  };

  return (
    <div>
      {msg&&(
        <div style={{
          marginBottom:12, padding:"10px 14px", borderRadius:8, fontSize:13,
          background: msg.kind==="ok"?"var(--c-success-bg)":"var(--c-danger-bg)",
          color: msg.kind==="ok"?"var(--c-success)":"var(--c-danger-strong)",
          border:`1px solid ${msg.kind==="ok"?"var(--c-success-border)":"var(--c-danger-border)"}`,
          wordBreak:"break-word",
        }}>{msg.text}</div>
      )}

      <Card style={{marginBottom:16,padding:16}}>
        <div style={{fontSize:13,color:"var(--c-muted)",lineHeight:1.5,marginBottom:4}}>
          {ru
            ? "Налоги и взносы, которые удерживаются с зарплат. Они распределяются по активным автомобилям вместе с выплатами — так считается «ЗП + налоги» на 1 км."
            : "Taxes and contributions withheld from salaries. They are spread across active vehicles along with the payouts — this is how “salary + taxes per km” is computed."}
        </div>
        <div style={{fontSize:12,color:"var(--c-muted-2)",marginBottom:14}}>
          {ru
            ? `Активных: ${activeCount} из ${taxes.length}. ZUS и PIT-4 уже добавлены — для Польши настраивать ничего не надо.`
            : `Active: ${activeCount} of ${taxes.length}. ZUS and PIT-4 are already added — nothing to configure for Poland.`}
        </div>

        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
          <div>
            <label style={s.label} htmlFor="fc-tax-icon">{ru?"Иконка":"Icon"}</label>
            <input id="fc-tax-icon" style={{...inputStyle,width:64,textAlign:"center"}} placeholder="🏛️" maxLength={4}
                   value={draftIcon} onChange={e=>setDraftIcon(e.target.value)}/>
          </div>
          <div style={{flex:1,minWidth:220}}>
            <label style={s.label} htmlFor="fc-tax-name">{ru?"Название налога / взноса":"Tax / contribution name"}</label>
            <input id="fc-tax-name" style={inputStyle}
                   placeholder={ru?"Напр. ФСЗН, Lohnsteuer, социальные взносы":"e.g. Social security, Lohnsteuer"}
                   value={draftName} onChange={e=>setDraftName(e.target.value)}
                   onKeyDown={e=>{ if(e.key==="Enter") add(); }}/>
          </div>
          <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={add} disabled={busy}>
            ＋ {ru?"Добавить":"Add"}
          </button>
        </div>
      </Card>

      <Card style={{padding:0,overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:720}}>
          <thead><tr style={{background:"var(--c-hover)"}}>
            <th style={s.th}>{ru?"Налог / взнос":"Tax / contribution"}</th>
            <th style={s.th}>{ru?"Код":"Code"}</th>
            <th style={s.th}>{ru?"Тип":"Type"}</th>
            <th style={{...s.th,textAlign:"right"}}>{ru?"Операций":"Operations"}</th>
            <th style={s.th}>{ru?"Статус":"Status"}</th>
            <th style={{...s.th,textAlign:"right",whiteSpace:"nowrap"}}>{ru?"Действия":"Actions"}</th>
          </tr></thead>
          <tbody>
            {!catState.list&&<tr><td colSpan={6} style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>…</td></tr>}
            {catState.list&&!taxes.length&&(
              <tr><td colSpan={6} style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>
                {ru?"Налоги и взносы не настроены. Добавьте свои — ZUS/PIT доступны как готовые."
                   :"No taxes configured. Add your own — ZUS/PIT are available as ready-made ones."}
              </td></tr>
            )}
            {taxes.map(c=>{
              const isEdit=editing&&editing.id===c.id;
              const isDel=confirmDel===c.id;
              return (
                <tr key={c.id} style={{borderBottom:"1px solid var(--c-surface-2)",opacity:c.is_active?1:0.6}}>
                  <td style={s.td}>
                    {isEdit?(
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <input style={{...inputStyle,width:56,textAlign:"center"}} maxLength={4} value={editing.icon||""}
                               onChange={e=>setEditing({...editing,icon:e.target.value})} aria-label={ru?"Иконка":"Icon"}/>
                        <input style={inputStyle} value={editing.name}
                               onChange={e=>setEditing({...editing,name:e.target.value})} aria-label={ru?"Название":"Name"}/>
                      </div>
                    ):(
                      <span style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:16}}>{c.icon||"🏛️"}</span>
                        <span style={{fontWeight:600,color:"var(--c-text)"}}>{c.name}</span>
                      </span>
                    )}
                  </td>
                  <td style={{...s.td,fontFamily:"var(--font-mono,monospace)",fontSize:12,color:"var(--c-muted-2)"}}>{c.code}</td>
                  <td style={s.td}>
                    <span style={{fontSize:12,fontWeight:600,padding:"2px 8px",borderRadius:6,
                      background:c.is_system?"var(--c-info-bg)":"var(--c-violet-bg)",
                      color:c.is_system?"var(--c-info-2)":"var(--c-violet)"}}>
                      {c.is_system?(ru?"готовая":"ready-made"):(ru?"своя":"custom")}
                    </span>
                  </td>
                  <td style={{...s.td,textAlign:"right",fontWeight:700}}>{c.usage_count||0}</td>
                  <td style={s.td}>
                    <span style={{fontSize:12,fontWeight:600,padding:"2px 8px",borderRadius:6,
                      background:c.is_active?"var(--c-success-bg)":"var(--c-surface-2)",
                      color:c.is_active?"var(--c-success)":"var(--c-muted)"}}>
                      {c.is_active?(ru?"активен":"active"):(ru?"отключён":"disabled")}
                    </span>
                  </td>
                  <td style={{...s.td,textAlign:"right"}}>
                    <div style={{display:"inline-flex",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
                      {isEdit?(
                        <>
                          <button onClick={saveEdit} disabled={busy} style={{...rowBtn,border:"1px solid var(--c-success-solid)",background:"var(--c-success-bg)",color:"var(--c-success)"}}>✓ {ru?"Сохранить":"Save"}</button>
                          <button onClick={()=>setEditing(null)} style={{...rowBtn,border:"1px solid var(--c-border)",background:"var(--c-surface)",color:"var(--c-muted)"}}>{ru?"Отмена":"Cancel"}</button>
                        </>
                      ):isDel?(
                        <>
                          <span style={{fontSize:12,fontWeight:600,color:"var(--c-danger-strong)",alignSelf:"center"}}>{ru?"Удалить?":"Delete?"}</span>
                          <button onClick={()=>doDelete(c)} disabled={busy} style={{...rowBtn,border:"1px solid var(--c-success-solid)",background:"var(--c-success-bg)",color:"var(--c-success)"}}>✓</button>
                          <button onClick={()=>setConfirmDel(null)} style={{...rowBtn,border:"1px solid var(--c-danger)",background:"var(--c-danger-bg-2)",color:"var(--c-danger-strong)"}}>⊘</button>
                        </>
                      ):(
                        <>
                          <button onClick={()=>setEditing({id:c.id,name:c.name,icon:c.icon||"🏛️"})}
                                  style={{...rowBtn,border:"1px solid var(--c-border)",background:"var(--c-surface)",color:"var(--c-muted)"}}>
                            ✎ {ru?"Изменить":"Edit"}
                          </button>
                          <button onClick={async()=>{ const r=await patchCategory(c.id,{is_active:!c.is_active});
                                  if(!r.ok) flash("err",r.error); }}
                                  style={{...rowBtn,border:"1px solid var(--c-warn-border)",background:"var(--c-warn-bg-2)",color:"var(--c-warn)"}}>
                            {c.is_active?(ru?"Отключить":"Disable"):(ru?"Включить":"Enable")}
                          </button>
                          <button onClick={()=>setConfirmDel(c.id)}
                                  style={{...rowBtn,border:"1px solid var(--c-danger-border)",background:"var(--c-danger-bg)",color:"var(--c-danger)"}}>
                            🗑 {ru?"Удалить":"Delete"}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <div style={{marginTop:12,fontSize:12,color:"var(--c-muted-2)",lineHeight:1.5}}>
        {ru
          ? "Отключённый налог исчезает из выбора в форме зарплаты, но расходы по нему за прошлые периоды продолжают учитываться в отчётах."
          : "A disabled tax disappears from the salary form picker, while its past expenses keep counting in the reports."}
      </div>
    </div>
  );
}
