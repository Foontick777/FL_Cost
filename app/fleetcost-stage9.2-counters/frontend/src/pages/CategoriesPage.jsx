import { useMemo, useState } from "react";
import { s } from "../ui/styles.js";
import { Card } from "../ui/components.jsx";
import { apiMutate } from "../lib/api.js";
import {
  SECTION_ORDER, SECTION_META, sectionLabel, useCategories, createCategory,
  patchCategory, deleteCategory,
} from "../lib/categories.js";

/**
 * Палитра для категорий — ССЫЛКИ НА ПЕРЕМЕННЫЕ ТЕМЫ, а не сырые цвета.
 *
 * Так сделано намеренно: цвет категории хранится строкой вида `var(--c-sky)` и
 * подставляется в `color-mix(in srgb, …)` при отрисовке. Сырой hex не менялся бы
 * в тёмной теме, и цвет категории «сломался» бы на светлом/тёмном фоне. Правило
 * из гейта проекта («в src не осталось сырых цветов») здесь соблюдено по существу,
 * а не формально.
 */
/**
 * Готовые значки категорий.
 *
 * Раньше это было текстовое поле: пользователь ставил туда курсор и не понимал,
 * что делать, — категории создавались с одинаковым значком 🏷️. Выбор из набора
 * снимает вопрос «как ввести эмодзи» и заодно не даёт случайно вписать букву
 * вместо значка.
 */
const ICON_CHOICES = [
  "🏷️","🚫","🅿️","🔧","🧼","🛞","🔍","📄","💼","🏢","💡","🌐","📞","🏦","⚖️","💻",
  "📣","🧹","🛡️","🛡","🚚","📦","🧾","📝","⛽","🛢️","🧰","🅰️","👷","🩺","🎓","🍽️",
  "🛣️","🚧","🔔","⏱️","📊","🧯","🔌","💧","🌡️","🗂️","✉️","🤝","📌","❓",
];

function IconPicker({value,onChange,lang,id}){
  const ru = lang==="RU";
  return (
    <div id={id} role="group" aria-label={ru?"Значок категории":"Category icon"}
         style={{display:"flex",flexWrap:"wrap",gap:3,maxWidth:250,maxHeight:92,overflowY:"auto",
                 border:"1px solid var(--c-border)",borderRadius:8,padding:5,background:"var(--c-surface)"}}>
      <button type="button" onClick={()=>onChange("")} title={ru?"Без значка":"No icon"}
              aria-pressed={!value}
              style={{...iconCell, borderColor:!value?"var(--c-brand-solid)":"transparent",
                      background:!value?"var(--c-brand-bg)":"transparent",color:"var(--c-muted-2)",fontSize:10}}>—</button>
      {ICON_CHOICES.map(ic=>(
        <button key={ic} type="button" onClick={()=>onChange(ic)} title={ic} aria-pressed={value===ic}
                style={{...iconCell, borderColor:value===ic?"var(--c-brand-solid)":"transparent",
                        background:value===ic?"var(--c-brand-bg)":"transparent"}}>{ic}</button>
      ))}
    </div>
  );
}

const iconCell={width:26,height:26,display:"inline-flex",alignItems:"center",justifyContent:"center",
                border:"1px solid transparent",borderRadius:6,background:"transparent",cursor:"pointer",
                fontFamily:"inherit",fontSize:15,lineHeight:1,padding:0};

const CATEGORY_SWATCHES = [
  { id: "",                     label: "Авто",      swatch: "var(--c-muted-2)" },
  { id: "var(--c-danger)",      label: "Красный",   swatch: "var(--c-danger)" },
  { id: "var(--c-warn)",        label: "Оранжевый", swatch: "var(--c-warn)" },
  { id: "var(--c-success)",     label: "Зелёный",   swatch: "var(--c-success)" },
  { id: "var(--c-sky)",         label: "Голубой",   swatch: "var(--c-sky)" },
  { id: "var(--c-violet)",      label: "Фиолетовый",swatch: "var(--c-violet)" },
  { id: "var(--c-blue)",        label: "Синий",     swatch: "var(--c-blue)" },
];

function ColorSwatches({ value, onChange, lang, label }) {
  const ru = lang === "RU";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }} role="group" aria-label={label}>
      {CATEGORY_SWATCHES.map((c) => {
        const active = (value || "") === c.id;
        return (
          <button
            key={c.id || "auto"}
            type="button"
            title={c.id ? c.label : (ru ? "Цвет темы по умолчанию" : "Default theme color")}
            aria-pressed={active}
            onClick={() => onChange(c.id)}
            style={{
              width: 20, height: 20, borderRadius: "50%", cursor: "pointer", padding: 0,
              background: c.id ? c.swatch : "var(--c-surface-2)",
              border: active ? "2px solid var(--c-text)" : "1px solid var(--c-border-strong)",
              boxShadow: active ? "0 0 0 2px var(--c-surface)" : "none",
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * «Категории расходов» — управление справочником (ТЗ §11).
 *
 * Здесь видно и можно сделать ровно то, что перечислено в ТЗ:
 *   • название, иконка/цвет, раздел, системная/пользовательская, число операций;
 *   • создать свою категорию в любом разделе;
 *   • переименовать, поменять иконку/цвет, отключить и удалить;
 *   • физическое удаление доступно только для категории без операций — иначе
 *     вернулась бы «пропавшая история»: расходы остались бы без категории.
 *
 * Код категории показан, но не редактируется: он входит в тип операции
 * (`manual_{раздел}_{код}`) уже записанных расходов. Переименование безопасно,
 * смена кода — нет.
 */
export function CategoriesPage({t, lang}){
  const ru=lang==="RU";
  const catState=useCategories();
  const [sectionFilter,setSectionFilter]=useState("");
  const [query,setQuery]=useState("");
  const [showInactive,setShowInactive]=useState(true);
  const [editing,setEditing]=useState(null);      // {id, name, icon, color, is_active}
  const [creating,setCreating]=useState(false);
  const [draft,setDraft]=useState({section:"other", name:"", icon:"", color:""});
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState(null);              // {kind:"ok"|"err", text}
  const [confirmDel,setConfirmDel]=useState(null);

  const list=useMemo(()=>{
    const all=(catState.list||[]).filter(c=>{
      if(sectionFilter && c.section!==sectionFilter) return false;
      if(!showInactive && !c.is_active) return false;
      if(query.trim()){
        const q=query.trim().toLowerCase();
        if(!(`${c.name} ${c.code}`.toLowerCase().includes(q))) return false;
      }
      return true;
    });
    const order=(sec)=>SECTION_ORDER.indexOf(sec);
    return all.sort((a,b)=>{
      if(order(a.section)!==order(b.section)) return order(a.section)-order(b.section);
      if(a.is_system!==b.is_system) return a.is_system?-1:1;
      if(a.sort_order!==b.sort_order) return a.sort_order-b.sort_order;
      return (a.name||"").localeCompare(b.name||"");
    });
  },[catState.list,sectionFilter,query,showInactive]);

  const flash=(kind,text)=>{ setMsg({kind,text}); setTimeout(()=>setMsg(null),6000); };

  const saveNew=async()=>{
    if(!draft.name.trim()){ flash("err", ru?"Введите название категории":"Enter a category name"); return; }
    setBusy(true);
    const res=await createCategory({section:draft.section, name:draft.name.trim(), icon:draft.icon.trim()||null, color:draft.color.trim()||null});
    setBusy(false);
    if(!res.ok){ flash("err", res.error); return; }
    flash("ok", ru?`Категория «${res.category.name}» создана (код: ${res.category.code})`
                  :`Category “${res.category.name}” created (code: ${res.category.code})`);
    setDraft({section:draft.section, name:"", icon:"", color:""});
    setCreating(false);
  };

  const saveEdit=async()=>{
    if(!editing) return;
    setBusy(true);
    const res=await patchCategory(editing.id, {
      name: editing.name, icon: editing.icon, color: editing.color, is_active: editing.is_active,
    });
    setBusy(false);
    if(!res.ok){ flash("err", res.error); return; }
    flash("ok", ru?"Категория обновлена":"Category updated");
    setEditing(null);
  };

  const toggleActive=async(c)=>{
    const res=await patchCategory(c.id,{is_active:!c.is_active});
    if(!res.ok) flash("err", res.error);
    else flash("ok", c.is_active
      ? (ru?"Категория отключена: из выбора исчезла, история сохранена":"Category disabled: hidden from the picker, history kept")
      : (ru?"Категория снова активна":"Category re-activated"));
  };

  const doDelete=async(c)=>{
    setBusy(true);
    const res=await deleteCategory(c.id);
    setBusy(false);
    setConfirmDel(null);
    if(!res.ok){
      // 409 = на категорию ссылаются операции: объясняем, что делать вместо удаления.
      flash("err", res.error);
      return;
    }
    flash("ok", ru?"Категория удалена":"Category deleted");
  };

  const inputStyle={...s.input, padding:"6px 9px", fontSize:13};
  // Кнопка-значок фиксированного размера: одинаковая ширина у всех строк, поэтому
  // колонка действий не «дышит» и таблица не смещается.
  const rowBtn={width:28,height:26,display:"inline-flex",alignItems:"center",justifyContent:"center",
                padding:0,fontSize:12,fontWeight:600,borderRadius:6,cursor:"pointer",whiteSpace:"nowrap",lineHeight:1};

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
        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
          <div>
            <label style={s.label} htmlFor="fc-cat-sec">{ru?"Раздел":"Section"}</label>
            <select id="fc-cat-sec" style={inputStyle} value={sectionFilter} onChange={e=>setSectionFilter(e.target.value)}>
              <option value="">{ru?"Все разделы":"All sections"}</option>
              {SECTION_ORDER.map(s2=><option key={s2} value={s2}>{SECTION_META[s2].icon} {sectionLabel(s2,lang)}</option>)}
            </select>
          </div>
          <div style={{flex:1,minWidth:180}}>
            <label style={s.label} htmlFor="fc-cat-q">{ru?"Поиск":"Search"}</label>
            <input id="fc-cat-q" style={inputStyle} placeholder={ru?"Название или код":"Name or code"}
                   value={query} onChange={e=>setQuery(e.target.value)}/>
          </div>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--c-muted)",paddingBottom:8}}>
            <input type="checkbox" checked={showInactive} onChange={e=>setShowInactive(e.target.checked)}/>
            {ru?"показывать отключённые":"show disabled"}
          </label>
          <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={()=>setCreating(v=>!v)}>
            ＋ {ru?"Создать категорию":"Create category"}
          </button>
        </div>

        {creating&&(
          <div style={{marginTop:14,paddingTop:14,borderTop:"1px solid var(--c-surface-2)",display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
            <div>
              <label style={s.label} htmlFor="fc-cat-nsec">{ru?"Раздел":"Section"}</label>
              <select id="fc-cat-nsec" style={inputStyle} value={draft.section} onChange={e=>setDraft({...draft,section:e.target.value})}>
                {SECTION_ORDER.map(s2=><option key={s2} value={s2}>{SECTION_META[s2].icon} {sectionLabel(s2,lang)}</option>)}
              </select>
            </div>
            <div>
              <label style={s.label}>{ru?"Иконка":"Icon"}</label>
              <IconPicker id="fc-cat-icon" value={draft.icon} onChange={ic=>setDraft({...draft,icon:ic})} lang={lang}/>
            </div>
            <div style={{flex:1,minWidth:200}}>
              <label style={s.label} htmlFor="fc-cat-name">{ru?"Название":"Name"}</label>
              <input id="fc-cat-name" style={inputStyle} placeholder={ru?"Напр. GPS / Телематика":"e.g. GPS / Telematics"}
                     value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}
                     onKeyDown={e=>{ if(e.key==="Enter") saveNew(); }}/>
            </div>
            <div>
              <label style={s.label}>{ru?"Цвет":"Color"}</label>
              <div style={{paddingBottom:6}}>
                <ColorSwatches value={draft.color} onChange={(c)=>setDraft({...draft,color:c})} lang={lang} label={ru?"Цвет категории":"Category color"}/>
              </div>
            </div>
            <button style={{...s.btnPrimary,whiteSpace:"nowrap"}} onClick={saveNew} disabled={busy}>
              {busy?"…":(ru?"Создать":"Create")}
            </button>
            <button style={{...s.btn,whiteSpace:"nowrap"}} onClick={()=>setCreating(false)}>{ru?"Отмена":"Cancel"}</button>
          </div>
        )}
      </Card>

      <Card style={{padding:0,overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:900}}>
          <thead><tr style={{background:"var(--c-hover)"}}>
            <th style={s.th}>{ru?"Категория":"Category"}</th>
            <th style={s.th}>{ru?"Код":"Code"}</th>
            <th style={s.th}>{ru?"Раздел":"Section"}</th>
            <th style={s.th}>{ru?"Тип":"Type"}</th>
            <th style={{...s.th,textAlign:"right"}}>{ru?"Операций":"Operations"}</th>
            <th style={s.th}>{ru?"Статус":"Status"}</th>
            <th style={{...s.th,textAlign:"right",whiteSpace:"nowrap"}}>{ru?"Действия":"Actions"}</th>
          </tr></thead>
          <tbody>
            {!catState.list&&<tr><td colSpan={7} style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>…</td></tr>}
            {catState.list&&!list.length&&<tr><td colSpan={7} style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>{t.noData}</td></tr>}
            {list.map(c=>{
              const isEdit=editing&&editing.id===c.id;
              const isDel=confirmDel===c.id;
              // Приглушение строки убрано намеренно: раньше отключённая категория
              // гасила ВСЮ строку вместе с кнопками, и они выглядели неактивными,
              // хотя продолжали нажиматься — ровно на это и жаловались. Теперь
              // состояние показывает бейдж, а кнопки остаются обычными и рабочими.
              return (
                <tr key={c.id} style={{borderBottom:"1px solid var(--c-surface-2)"}}>
                  <td style={s.td}>
                    {isEdit?(
                      <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                        <IconPicker value={editing.icon||""} onChange={ic=>setEditing({...editing,icon:ic})} lang={lang}/>
                        <input style={inputStyle} value={editing.name}
                               onChange={e=>setEditing({...editing,name:e.target.value})} aria-label={ru?"Название":"Name"}/>
                        <ColorSwatches value={editing.color} onChange={(c)=>setEditing({...editing,color:c})} lang={lang} label={ru?"Цвет категории":"Category color"}/>
                      </div>
                    ):(
                      <span style={{display:"flex",alignItems:"center",gap:8,minWidth:0}}>
                        <span style={{fontSize:16}}>{c.icon||"🏷️"}</span>
                        <span style={{fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",
                                      color:c.is_active?"var(--c-text)":"var(--c-muted-2)"}}>{c.name}</span>
                      </span>
                    )}
                  </td>
                  <td style={{...s.td,fontFamily:"var(--font-mono,monospace)",fontSize:12,color:"var(--c-muted-2)"}}>{c.code}</td>
                  <td style={{...s.td,fontSize:12,color:"var(--c-muted)"}}>{SECTION_META[c.section]?.icon} {sectionLabel(c.section,lang)}</td>
                  <td style={s.td}>
                    <span style={{fontSize:12,fontWeight:600,padding:"2px 8px",borderRadius:6,
                      background:c.is_system?"var(--c-info-bg)":"var(--c-violet-bg)",
                      color:c.is_system?"var(--c-info-2)":"var(--c-violet)"}}>
                      {c.is_system?(ru?"системная":"system"):(ru?"своя":"custom")}
                    </span>
                  </td>
                  <td style={{...s.td,textAlign:"right",fontWeight:700}}>{c.usage_count||0}</td>
                  <td style={s.td}>
                    <span style={{fontSize:12,fontWeight:600,padding:"2px 8px",borderRadius:6,
                      background:c.is_active?"var(--c-success-bg)":"var(--c-surface-2)",
                      color:c.is_active?"var(--c-success)":"var(--c-muted)"}}>
                      {c.is_active?(ru?"активна":"active"):(ru?"отключена":"disabled")}
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
                          {/* Кнопки — только значки с подсказкой. Полные подписи
                              («Изменить», «Отключить», «Удалить») растягивали
                              колонку действий, и таблица уезжала: названия и
                              категории сдвигались. Смысл остаётся доступным —
                              всплывающая подсказка и aria-label. */}
                          <button onClick={()=>setEditing({id:c.id,name:c.name,icon:c.icon||"",color:c.color||"",is_active:c.is_active})}
                                  title={ru?"Изменить название, значок и цвет":"Edit name, icon and colour"}
                                  aria-label={ru?"Изменить":"Edit"}
                                  style={{...rowBtn,border:"1px solid var(--c-border)",background:"var(--c-surface)",color:"var(--c-muted)"}}>✎</button>
                          <button onClick={()=>toggleActive(c)}
                                  title={c.is_active
                                    ? (ru?"Отключить: исчезнет из выбора, история сохранится":"Disable: hidden from the picker, history kept")
                                    : (ru?"Включить: снова появится в выборе":"Enable: available in the picker again")}
                                  aria-label={c.is_active?(ru?"Отключить":"Disable"):(ru?"Включить":"Enable")}
                                  style={{...rowBtn,border:"1px solid var(--c-warn-border)",background:"var(--c-warn-bg-2)",color:"var(--c-warn)"}}>
                            {c.is_active?"⏸":"▶"}
                          </button>
                          <button onClick={()=>setConfirmDel(c.id)}
                                  title={ru?"Удалить категорию":"Delete category"}
                                  aria-label={ru?"Удалить":"Delete"}
                                  style={{...rowBtn,border:"1px solid var(--c-danger-border)",background:"var(--c-danger-bg)",color:"var(--c-danger)"}}>🗑</button>
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
          ? "Удалить можно только категорию без операций: если расходы по ней уже есть, кнопка вернёт отказ и предложит отключить — так история расходов не «потеряет» категорию."
          : "Only a category with no operations can be deleted: if it is already used, the action is refused and suggests disabling it instead, so history never loses its category."}
        {" "}
        <span style={{color:"var(--c-muted)"}}>
          {ru?"Код категории менять нельзя — он зашит в тип уже записанных операций."
             :"The category code cannot be changed — it is embedded in the type of already recorded operations."}
        </span>
      </div>
    </div>
  );
}
