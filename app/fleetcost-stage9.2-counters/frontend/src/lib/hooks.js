import { useState, useCallback } from "react";

/**
 * Состояние, переживающее перезагрузку и переходы между вкладками.
 * Вынесено из App.jsx; ключи вида fc_<страница>_<фильтр>.
 */
export function useLocalState(key, initial){
  const [v,setV]=useState(()=>{ try{ const saved=localStorage.getItem(key); return saved===null?initial:saved; }catch(e){ return initial; } });
  const set=useCallback((val)=>{
    setV(prev=>{
      const next=(typeof val==="function")?val(prev):val;
      try{
        if(next===""||next===null||next===undefined) localStorage.removeItem(key);
        else localStorage.setItem(key,String(next));
      }catch(e){}
      return next;
    });
  },[key]);
  return [v,set];
}
