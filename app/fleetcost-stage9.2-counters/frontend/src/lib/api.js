/**
 * Сетевой слой: единственная точка общения с API.
 *
 * Вынесено из App.jsx. Здесь: базовый URL, стабильный client_id браузера,
 * обёртки запросов, CSRF-заголовок и централизованная обработка
 * «бэкенд недоступен» / 401 / ошибок мутаций.
 */
export const API = "/api";

// Issue #6: stable per-browser UUID. Generated once on first launch,
// stored in localStorage (it's NOT sensitive — just a stable identifier
// so the audit log can distinguish between "user from Chrome on Mac"
// vs "user from Safari on iPhone"). If the user clears localStorage,
// they get a new client_id — that's fine, it just means a new "session".
function getClientId() {
  try {
    const KEY = "fc_client_id";
    let id = localStorage.getItem(KEY);
    if(!id) {
      // Generate a fresh UUID v4
      id = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === "x" ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch(e) {
    // localStorage might be disabled (e.g. private mode) — generate ephemeral
    return "ephemeral-" + Math.random().toString(36).slice(2);
  }
}
export const CLIENT_ID = getClientId();   // используется и в App.jsx (заголовок X-Client-ID)

// Global flag to detect backend connectivity issues
let _backendDown = false;
export function isBackendDown() { return _backendDown; }

// Handlers registered by App so apiFetch can refresh global UI state.
// `_backendDown` used to be cleared ONLY by the 2-second poll hitting
// /api/health, so the red banner could stay up to 2s after the backend was
// already answering. Any successful response now clears it immediately.
let _onBackendState = null;
let _onUnauthorized = null;
let _onMutationError = null;
export function setBackendStateHandler(fn) { _onBackendState = fn; }
export function setUnauthorizedHandler(fn) { _onUnauthorized = fn; }
export function setMutationErrorHandler(fn) { _onMutationError = fn; }

/** Report a client-side validation problem through the same channel as a
 *  failed request, so "нажал кнопку — ничего не произошло" cannot happen. */
export function reportUiError(detail) {
  try {
    if (_onMutationError) _onMutationError({ path: "", method: "", status: 0, detail });
  } catch (e) {}
}

/**
 * Perform a state-changing request and report the outcome.
 *
 * Mutations used to be fire-and-forget: the UI applied its optimistic update
 * regardless of the HTTP status, so a rejected save looked successful and a
 * failed DELETE removed the row from the screen while it stayed in the
 * database. Callers should now do:
 *
 *     const r = await apiMutate("/expenses/1", {method:"DELETE"});
 *     if (!r.ok) return;            // toast already shown by App
 *     setTxns(prev => prev.filter(...));
 *
 * A failing mutation is *also* surfaced globally (see the handler registered in
 * App), so even the call sites that do not inspect the result can never fail
 * silently again.
 */
export async function apiMutate(path, options = {}) {
  let res;
  try {
    res = await apiFetch(path, options);
  } catch (e) {
    return { ok: false, status: 0, data: null, error: "Network error" };
  }
  let data = null;
  try { data = await res.clone().json(); } catch (e) {}
  const error = res.ok
    ? null
    : (data && (data.detail || data.error)) || `HTTP ${res.status}`;
  return { ok: res.ok, status: res.status, data, error };
}

function _markBackend(up) {
  if (_backendDown === !up) return;      // no change
  _backendDown = !up;
  try { if (_onBackendState) _onBackendState(_backendDown); } catch(e) {}
}

// ──────────────────────────────────────────────────────────────────────
// SEC-02 (аудит stage8): обновление сессии через refresh-токен
// ──────────────────────────────────────────────────────────────────────
// Access-токен живёт 30 минут. Когда он истекает, очередной apiFetch получает
// 401 — вместо немедленного выбрасывания на экран логина пробуем один раз
// обновить пару токенов через HttpOnly cookie fc_rt (POST /auth/refresh).
// Получилось — повторяем исходный запрос; нет — показываем форму входа.
// Для пользователя сессия бесшовна: доступ к данным не прерывается каждые
// полчаса, а выход/компрометация по-прежнему отзывают всё (бэкенд).
let _refreshInFlight = null;
async function tryRefreshSession() {
  if (_refreshInFlight) return _refreshInFlight;   // single-flight: N параллельных 401 → один refresh
  _refreshInFlight = (async () => {
    try {
      // Для POST /auth/refresh нужен CSRF-заголовок (double-submit). Если токен
      // потерян из памяти — восстанавливаем из куки или просим свежий.
      let csrf = window.__FLEETCOST_CSRF__;
      if (!csrf && typeof document !== "undefined") {
        const m = document.cookie.match(/(?:^|; )fc_csrf=([^;]+)/);
        if (m) { try { csrf = decodeURIComponent(m[1]); window.__FLEETCOST_CSRF__ = csrf; } catch(e) {} }
      }
      if (!csrf) {
        try {
          const r0 = await fetch(`${API}/auth/csrf-token`, { credentials: "include", headers: { "X-Client-ID": CLIENT_ID } });
          if (r0.ok) { const d0 = await r0.json(); if (d0.csrf_token) { csrf = d0.csrf_token; window.__FLEETCOST_CSRF__ = csrf; } }
        } catch(e) {}
      }
      // Обновляемый запрос — через голый fetch (НЕ apiFetch), иначе рекурсия 401→refresh→401.
      const res = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Client-ID": CLIENT_ID,
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      // Ротация выдаёт и новый CSRF — кэшируем, чтобы следующие запросы не ловили 403.
      if (data.csrf_token) window.__FLEETCOST_CSRF__ = data.csrf_token;
      return true;
    } catch (e) {
      return false;
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

export async function apiFetch(path, options = {}) {
  // Issue #5: the JWT lives in an HttpOnly cookie set by /auth/login and
  // /auth/register. fetch() automatically includes cookies for same-origin
  // requests (and cross-origin when credentials:"include" is set — which we
  // do on every request below). The Authorization header is no longer set
  // from localStorage — XSS can no longer steal the token via JS.
  //
  // Issue #5 (CSRF): every state-changing request must include the
  // X-CSRF-Token header, whose value matches the non-HttpOnly CSRF cookie.
  // The cookie value is set on login/register; we keep the same value in
  // window.__FLEETCOST_CSRF__ so we can read it and send it as a header.
  //
  // IMPORTANT: after a page refresh, window.__FLEETCOST_CSRF__ is undefined
  // (JS memory clears on reload), but the CSRF cookie is still there. We
  // fall back to reading the cookie directly — that's the standard
  // double-submit pattern.
  const isStateChange = ["POST", "PATCH", "PUT", "DELETE"].includes(
    (options.method || "GET").toUpperCase()
  );
  // SEC-02: пометка «это уже повтор после успешного refresh» — больше не пытаемся
  // обновлять сессию, иначе бесконечный цикл при действительно просроченной сессии.
  const isRetry = !!options.__isRetry;
  const fetchOptions = { ...options };
  delete fetchOptions.__isRetry;
  const headers = {
    ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    // Issue #6: stable per-browser UUID, generated once on first launch.
    // Lets audit log distinguish between sessions on different devices.
    "X-Client-ID": CLIENT_ID,
    ...(options.headers || {}),
  };
  if (isStateChange) {
    let csrf = window.__FLEETCOST_CSRF__;
    if (!csrf && typeof document !== "undefined") {
      // Page was refreshed — read the CSRF token from the non-HttpOnly
      // cookie. The cookie was set on login with httponly=False
      // specifically so JS can read it for this purpose.
      const match = document.cookie.match(/(?:^|; )fc_csrf=([^;]+)/);
      if (match) {
        try {
          csrf = decodeURIComponent(match[1]);
          // Cache in memory so we don't parse document.cookie on every request
          window.__FLEETCOST_CSRF__ = csrf;
        } catch(e) {}
      }
    }
    if (csrf) {
      headers["X-CSRF-Token"] = csrf;
    }
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...fetchOptions,
      credentials: "include",  // send + receive cookies
      headers,
    });
  } catch(e) {
    console.error("apiFetch network error:", path, e);
    _markBackend(false);
    return { ok: false, status: 0, json: async()=>({error:"Network error"}), text: async()=>"Network error" };
  }
  // We got an HTTP response → the backend is reachable again.
  _markBackend(true);
  // If we got 403 "CSRF token missing or invalid" on a state-changing
  // request, the CSRF cookie value may have been rotated by the backend
  // (e.g. another tab logged in/out, or the cookie expired). Try reading
  // the cookie again and retry once.
  if (res.status === 403 && isStateChange && typeof document !== "undefined") {
    let newCsrf = null;
    const match = document.cookie.match(/(?:^|; )fc_csrf=([^;]+)/);
    if (match) {
      try { newCsrf = decodeURIComponent(match[1]); } catch(e) {}
    }
    if (newCsrf && newCsrf !== window.__FLEETCOST_CSRF__) {
      // The cookie has a value we didn't have cached — retry once.
      window.__FLEETCOST_CSRF__ = newCsrf;
      headers["X-CSRF-Token"] = newCsrf;
      try {
        res = await fetch(`${API}${path}`, {
          ...fetchOptions,
          credentials: "include",
          headers,
        });
      } catch(e) {
        console.error("apiFetch retry error:", path, e);
      }
    }
  }
  if (res.status === 401) {
    // SEC-02: access-истёк — сначала пробуем обновить пару через refresh-cookie
    // и повторить запрос. Повторный 401 (или отказ refresh) — сессия действительно
    // закончилась: сбрасываем память CSRF и показываем экран входа.
    // Авто-перезагрузку страницы тут делать НЕЛЬЗЯ — так был бесконечный цикл в
    // Safari/Firefox (reload → /auth/me → 401 → reload → ∞).
    if (!isRetry) {
      const refreshed = await tryRefreshSession();
      if (refreshed) {
        return apiFetch(path, { ...fetchOptions, __isRetry: true });
      }
    }
    window.__FLEETCOST_CSRF__ = null;
    try { if (_onUnauthorized) _onUnauthorized(); } catch(e) {}
  }
  // A state-changing request that failed must never be invisible: report it to
  // the app so it can show a toast. The body is read from a CLONE, so the
  // caller's own res.json() still works.
  if (isStateChange && !res.ok && res.status !== 401) {
    try {
      const body = await res.clone().json().catch(() => null);
      const detail = (body && (body.detail || body.error)) || `HTTP ${res.status}`;
      if (_onMutationError) {
        _onMutationError({
          path,
          method: (options.method || "POST").toUpperCase(),
          status: res.status,
          detail,
        });
      }
    } catch (e) {}
  }
  return res;
}

export async function apiGet(path) {
  try {
    const res = await apiFetch(path);
    if (!res.ok) {
      const err = await res.json().catch(()=>({detail: res.statusText}));
      console.error("apiGet error", path, res.status, err);
      return null;
    }
    return await res.json();
  } catch(e) {
    console.error("apiGet error:", path, e);
    return null;
  }
}
