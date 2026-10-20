import { apiFetch, apiGet } from "../lib/api.js";
import { s } from "../ui/styles.js";
import { Badge, Card } from "../ui/components.jsx";
import { useEffect, useState } from "react";
/** Страница «Автомобили».
 *  Вынесена из App.jsx. Данные приходят через props, сеть — через lib/api.js. */
export function VehiclesPage({t}){
  const [vehicles,setVehicles]=useState([]);
  const [form,setForm]=useState({plate_number:"",driver_name:"",description:""});
  const [editId,setEditId]=useState(null);
  const [editForm,setEditForm]=useState({});

  useEffect(()=>{apiGet("/vehicles").then(d=>setVehicles(Array.isArray(d)?d:[]));},[]);

  const add=async()=>{
    if(!form.plate_number) return;
    const r=await apiFetch("/vehicles",{method:"POST",body:JSON.stringify({...form,plate_number:form.plate_number.toUpperCase()})});
    const v=await r.json();
    setVehicles(prev=>[...prev,v]);
    setForm({plate_number:"",driver_name:"",description:""});
  };
  const saveEdit=async(id)=>{
    const r=await apiFetch(`/vehicles/${id}`,{method:"PATCH",body:JSON.stringify(editForm)});
    const v=await r.json();
    setVehicles(prev=>prev.map(x=>x.id===id?v:x));
    setEditId(null);
  };
  const toggle=async(v)=>{
    await apiFetch(`/vehicles/${v.id}`,{method:"PATCH",body:JSON.stringify({is_active:!v.is_active})});
    setVehicles(prev=>prev.map(x=>x.id===v.id?{...x,is_active:!x.is_active}:x));
  };

  return(
    <div style={s.page}>
      <h1 style={s.pageTitle}>🚛 {t.vehicles}</h1>
      <Card style={{marginBottom:14}}>
        <h3 style={{margin:"0 0 12px"}}>{t.addVehicleTitle}</h3>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          {[["plate_number",t.plate+" *","BI855GS"],["driver_name",t.driver,"Иван Петров"],["description",t.description,"Volvo FH 2022"]].map(([k,label,ph])=>(
            <div key={k} style={{flex:1,minWidth:120}}>
              <label style={s.label} htmlFor="fc-f-41">{label}</label>
              <input id="fc-f-41" style={s.input} placeholder={ph} value={form[k]} onChange={e=>setForm({...form,[k]:k==="plate_number"?e.target.value.toUpperCase():e.target.value})}/>
            </div>
          ))}
          <div style={{display:"flex",alignItems:"flex-end"}}>
            <button style={s.btnPrimary} onClick={add}>+ {t.addVehicle}</button>
          </div>
        </div>
      </Card>
      <Card style={{padding:0}}>
        {!vehicles.length?<div style={{padding:40,textAlign:"center",color:"var(--c-muted-2)"}}>{t.noVehicles}</div>:(
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr style={{background:"var(--c-hover)"}}>
              {[t.plate,t.driver,t.description,"Status",t.actions].map(h=><th key={h} style={s.th}>{h}</th>)}
            </tr></thead>
            <tbody>{vehicles.map(v=>(
              <tr key={v.id} style={{borderBottom:"1px solid var(--c-surface-2)",opacity:v.is_active?1:0.5}}>
                <td style={s.td}><b>{v.plate_number}</b></td>
                <td style={s.td}>{editId===v.id?<input style={{...s.input,width:140}} value={editForm.driver_name||""} onChange={e=>setEditForm({...editForm,driver_name:e.target.value})}/>:v.driver_name||"—"}</td>
                <td style={s.td}>{editId===v.id?<input style={{...s.input,width:160}} value={editForm.description||""} onChange={e=>setEditForm({...editForm,description:e.target.value})}/>:v.description||"—"}</td>
                <td style={s.td}><Badge bg={v.is_active?"var(--c-success-bg-2)":"var(--c-hover)"} fg={v.is_active?"var(--c-success-dark)":"var(--c-muted)"}>{v.is_active?"Active":"Inactive"}</Badge></td>
                <td style={{...s.td,display:"flex",gap:6}}>
                  {editId===v.id?(
                    <><button style={s.btnPrimary} onClick={()=>saveEdit(v.id)}>{t.save}</button>
                    <button style={s.btn} onClick={()=>setEditId(null)}>{t.cancel}</button></>
                  ):(
                    <><button style={s.btn} onClick={()=>{setEditId(v.id);setEditForm({driver_name:v.driver_name||"",description:v.description||""});}}>{t.edit}</button>
                    <button style={s.btn} onClick={()=>toggle(v)}>{v.is_active?"Off":"On"}</button></>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
