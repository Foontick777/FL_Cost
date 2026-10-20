/**
 * FX-01 (аудит stage8): единый динамический список валют для форм.
 *
 * Проблема: список валют выпадающих списков был ЗАХАРДКОЖЕН в пяти местах
 * (ExpenseForm, Manual, Income, Fuel, FuelLike), причём в четырёх из них —
 * более короткими списками, чем в ExpenseForm. В формах не было CHF/RSD/MDL/GEL,
 * хотя бэкенд считает по ним курсы (ЕЦБ/Frankfurter). Операцию в швейцарских
 * франках нельзя было внести руками — приходится открывать «Курсы валют».
 *
 * Решение: источник списка — БЭКЕНД (GET /fx-rates/form-currencies): именно
 * он решает, по каким валютам умеет считать. Фронтенд кэширует ответ
 * в localStorage на сутки, чтобы формы открывались мгновенно и работали
 * при кратковременной недоступности API. Пока списка нет (первый запуск)
 * используется FALLBACK_CURRENCIES — надмножество прежнего списка.
 *
 * Использование в компоненте:
 *   const currencies = useCurrencyList();
 */
import { useEffect, useState } from "react";
import { API } from "./api.js";

// Офлайн-резерв: всё, что было в формах раньше, плюс валюты, упомянутые
// в аудите (CHF — ЕЦБ; RSD/MDL/GEL — Frankfurter). Реальный список шире —
// он приходит с бэкенда.
export const FALLBACK_CURRENCIES = [
  "EUR", "PLN", "USD", "GBP", "CZK", "HUF", "BYN", "UAH", "RON", "BGN",
  "SEK", "NOK", "DKK", "CHF", "RSD", "MDL", "GEL",
];

const LS_KEY = "fc_form_currencies";
const LS_AT = "fc_form_currencies_at";
const TTL_MS = 24 * 3600 * 1000;   // сутки — список валют меняется редко

function readLocalCache() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return (Array.isArray(arr) && arr.length) ? arr : null;
  } catch(e) { return null; }
}

/** Актуальный список без похода в сеть (для первого рендера формы). */
export function getCachedCurrencies() {
  return readLocalCache() || FALLBACK_CURRENCIES;
}

let _inflight = null;
let _fetchedAt = 0;

/**
 * Список валют: из кэша, при устаревании — тихое обновление с бэкенда.
 * Никогда не бросает исключений: форма обязана открываться даже при
 * недоступном API (список останется последним известным или fallback).
 */
export function fetchCurrencies({ maxAgeMs = TTL_MS } = {}) {
  if (_inflight) return _inflight;
  const cached = readLocalCache();
  if (cached && _fetchedAt && (Date.now() - _fetchedAt) < maxAgeMs) {
    return Promise.resolve(cached);
  }
  _inflight = (async () => {
    try {
      const res = await fetch(`${API}/fx-rates/form-currencies`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const codes = (data.currencies || [])
        .map((c) => (typeof c === "string" ? c : c && c.code))
        .filter(Boolean);
      if (!codes.length) throw new Error("empty list");
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(codes));
        localStorage.setItem(LS_AT, String(Date.now()));
      } catch(e) {}
      _fetchedAt = Date.now();
      return codes;
    } catch(e) {
      return null;          // сеть/авторизация недоступны — остаёмся на кэше
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** React-хук для выпадающих списков валют. */
export function useCurrencyList() {
  const [currencies, setCurrencies] = useState(getCachedCurrencies);
  useEffect(() => {
    let alive = true;
    fetchCurrencies().then((list) => {
      if (alive && list) setCurrencies(list);
    });
    return () => { alive = false; };
  }, []);
  return currencies;
}
