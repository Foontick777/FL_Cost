import { useState } from "react";

const API = "/api";

const dict = {
  en: {
    subtitle: "Fleet Expense Tracker",
    signIn: "Sign In",
    register: "Register",
    company: "Company name",
    companyPlaceholder: "e.g. SSCARGO",
    name: "Your name (optional)",
    namePlaceholder: "John Doe",
    email: "Email",
    emailPlaceholder: "name@company.com",
    password: "Password",
    passwordPlaceholder: "Create a secure password",
    passwordPlaceholderLogin: "••••••••",
    btnSignIn: "Sign In",
    btnRegister: "Create Account",
    passwordHint: "Min 10 characters, one uppercase letter and one digit",
    pwdTooShort: "Minimum 10 characters",
    pwdNoUpper: "Must contain at least one uppercase letter",
    pwdNoDigit: "Must contain at least one digit",
    pwdOk: "Strong password ✓",
  },
  ru: {
    subtitle: "Учёт расходов автопарка",
    signIn: "Вход",
    register: "Регистрация",
    company: "Название компании",
    companyPlaceholder: "напр. SSCARGO",
    name: "Ваше имя (необязательно)",
    namePlaceholder: "Иван Иванов",
    email: "Электронная почта",
    emailPlaceholder: "email@компания.com",
    password: "Пароль",
    passwordPlaceholder: "Создайте надёжный пароль",
    passwordPlaceholderLogin: "••••••••",
    btnSignIn: "Войти",
    btnRegister: "Создать аккаунт",
    passwordHint: "Мин. 10 символов, заглавная буква и цифра",
    pwdTooShort: "Минимум 10 символов",
    pwdNoUpper: "Нужна хотя бы одна заглавная буква",
    pwdNoDigit: "Нужна хотя бы одна цифра",
    pwdOk: "Надёжный пароль ✓",
  },
};

function validatePassword(pwd) {
  // SEC-03 (аудит stage8): минимум поднят с 7 до 10 символов. Должен
  // совпадать с бэкенд-правилом (schemas.validate_password_complexity),
  // иначе фронтенд пропустит то, что сервер отменит 422.
  if (pwd.length < 10) return "short";
  if (!/[A-Z]/.test(pwd)) return "noUpper";
  if (!/[0-9]/.test(pwd)) return "noDigit";
  return "ok";
}

export default function AuthPage({ onAuth }) {
  const [lang, setLang] = useState("en");
  const [tab, setTab] = useState("signin");
  const [form, setForm] = useState({ company: "", name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pwdTouched, setPwdTouched] = useState(false);

  const t = dict[lang];
  const pwdStatus = validatePassword(form.password);

  const pwdMessage = () => {
    if (!pwdTouched || tab === "signin") return null;
    if (pwdStatus === "short") return { msg: t.pwdTooShort, color: "var(--c-danger)" };
    if (pwdStatus === "noUpper") return { msg: t.pwdNoUpper, color: "var(--c-warn-600)" };
    if (pwdStatus === "noDigit") return { msg: t.pwdNoDigit, color: "var(--c-warn-600)" };
    return { msg: t.pwdOk, color: "var(--c-emerald)" };
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (tab === "register" && pwdStatus !== "ok") {
      setPwdTouched(true);
      return;
    }
    setError("");
    setLoading(true);
    try {
      const path = tab === "signin" ? "/auth/login" : "/auth/register";
      const body = tab === "signin"
        ? { email: form.email, password: form.password }
        : { email: form.email, password: form.password, company_name: form.company, full_name: form.name };

      const res = await fetch(`${API}${path}`, {
        method: "POST",
        credentials: "include",
        // Issue #6: stable per-browser UUID for audit log. Generates a fresh
        // UUID on first call, persists in localStorage across reloads.
        headers: {
          "Content-Type": "application/json",
          "X-Client-ID": (() => {
            try {
              const KEY = "fc_client_id";
              let id = localStorage.getItem(KEY);
              if(!id) {
                id = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
                  const r = Math.random() * 16 | 0;
                  const v = c === "x" ? r : (r & 0x3 | 0x8);
                  return v.toString(16);
                });
                localStorage.setItem(KEY, id);
              }
              return id;
            } catch(e) { return "ephemeral-" + Math.random().toString(36).slice(2); }
          })(),
        },
        body: JSON.stringify(body),
      });

      // Handle non-JSON responses gracefully (backend down / nginx 502 / etc.)
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        // Backend returned HTML (nginx error page) — surface a clear message
        if (res.status === 0 || !res.status) {
          throw new Error("Бэкенд недоступен — проверьте, запущен ли docker compose");
        }
        throw new Error(`Бэкенд вернул ${res.status} (не JSON). Проверьте docker compose logs backend`);
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Ошибка");
      // Issue #5: store the CSRF token in memory only (it's safe — the token
      // itself is a random value used purely as a double-submit nonce; it
      // cannot be used to authenticate). The auth JWT is in the HttpOnly
      // cookie and never touches JavaScript.
      if (data.csrf_token) {
        window.__FLEETCOST_CSRF__ = data.csrf_token;
      }
      // UX-01 (аудит stage8): раньше роль появлялась только после F5 —
      // window.__FLEETCOST_ROLE__ выставлялся ТОЛЬКО в boot-проверке /auth/me
      // при загрузке страницы. Боковое меню читает роль при первом рендере,
      // и после логина показывалось как для viewer: без «Администрирования»,
      // безowner-разделов до перезагрузки. Теперь роль подтягиваем до входа
      // в приложение и передаём её вверх вместе с пользователем.
      let user = null;
      try {
        const meRes = await fetch(`${API}/auth/me`, {
          credentials: "include",
          headers: { "X-Client-ID": (() => {
            try { return localStorage.getItem("fc_client_id") || ""; } catch(e) { return ""; }
          })() },
        });
        if (meRes.ok) {
          user = await meRes.json();
          window.__FLEETCOST_ROLE__ = user.role;
        }
      } catch(e) {}
      onAuth(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const hint = pwdMessage();

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        {/* Lang switcher */}
        <div style={s.langBar}>
          {["en", "ru"].map((l) => (
            <button key={l} style={lang === l ? s.langActive : s.langBtn}
              onClick={() => setLang(l)}>{l.toUpperCase()}</button>
          ))}
        </div>

        {/* Brand */}
        <div style={s.brand}>
          <div style={s.logoRow}>
            <span style={{ fontSize: 28 }}>🚛</span>
            <span style={s.logoText}>FleetCost</span>
          </div>
          <p style={s.subtitle}>{t.subtitle}</p>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          <button style={tab === "signin" ? s.tabActive : s.tabInactive}
            onClick={() => { setTab("signin"); setError(""); setPwdTouched(false); }}>
            {t.signIn}
          </button>
          <button style={tab === "register" ? s.tabActive : s.tabInactive}
            onClick={() => { setTab("register"); setError(""); setPwdTouched(false); }}>
            {t.register}
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          {tab === "register" && (
            <>
              <Field label={t.company} placeholder={t.companyPlaceholder}
                value={form.company} onChange={(v) => setForm({ ...form, company: v })} required />
              <Field label={t.name} placeholder={t.namePlaceholder}
                value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            </>
          )}
          <Field label={t.email} type="email" placeholder={t.emailPlaceholder}
            value={form.email} onChange={(v) => setForm({ ...form, email: v })} required />

          {/* Password with live validation */}
          <div style={{ marginBottom: 20 }}>
            <label style={s.label}>{t.password}</label>
            <input
              style={{
                ...s.input,
                borderColor: pwdTouched && tab === "register"
                  ? pwdStatus === "ok" ? "var(--c-emerald)" : "var(--c-danger)"
                  : "var(--c-border-mid)",
              }}
              type="password"
              placeholder={tab === "signin" ? t.passwordPlaceholderLogin : t.passwordPlaceholder}
              value={form.password}
              onChange={(e) => { setForm({ ...form, password: e.target.value }); setPwdTouched(true); }}
              required
            />
            {hint && (
              <div style={{ fontSize: 12, marginTop: 5, color: hint.color }}>{hint.msg}</div>
            )}
            {!pwdTouched && tab === "register" && (
              <div style={{ fontSize: 12, marginTop: 5, color: "var(--c-muted-3)" }}>{t.passwordHint}</div>
            )}
          </div>

          {error && <div style={s.error}>{error}</div>}

          <button style={s.btn} type="submit" disabled={loading}>
            {loading ? "..." : tab === "signin" ? t.btnSignIn : t.btnRegister}
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({ label, placeholder, value, onChange, type = "text", required }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <label style={s.label}>{label}</label>
      <input style={s.input} type={type} placeholder={placeholder}
        value={value} onChange={(e) => onChange(e.target.value)} required={required} />
    </div>
  );
}

const s = {
  wrap: { display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "var(--c-app)", padding: 20, fontFamily: "'Inter', system-ui, sans-serif" },
  card: { background: "var(--c-surface)", borderRadius: 28, width: "100%", maxWidth: 420, padding: "40px 32px", boxShadow: "0 8px 30px rgba(0,0,0,0.05)", border: "1px solid var(--c-border-3)", position: "relative" },
  langBar: { position: "absolute", top: 24, right: 24, display: "flex", gap: 4, background: "var(--c-surface-2)", padding: 4, borderRadius: 8 },
  langBtn: { background: "none", border: "none", padding: "4px 10px", fontSize: 12, fontWeight: 600, color: "var(--c-muted-5)", cursor: "pointer", borderRadius: 6 },
  langActive: { background: "var(--c-surface)", border: "none", padding: "4px 10px", fontSize: 12, fontWeight: 700, color: "var(--c-brand)", cursor: "pointer", borderRadius: 6, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
  brand: { textAlign: "center", marginBottom: 32 },
  logoRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 6 },
  logoText: { fontSize: 26, fontWeight: 800, color: "var(--c-text)", letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: "var(--c-muted-2)", margin: 0 },
  tabs: { display: "flex", background: "var(--c-surface-2)", padding: 4, borderRadius: 12, marginBottom: 28 },
  tabActive: { flex: 1, background: "var(--c-brand-solid)", color: "var(--c-on-brand)", border: "none", padding: "12px", fontSize: 14, fontWeight: 600, borderRadius: 10, cursor: "pointer" },
  tabInactive: { flex: 1, background: "none", color: "var(--c-muted-2)", border: "none", padding: "12px", fontSize: 14, fontWeight: 500, borderRadius: 10, cursor: "pointer" },
  label: { display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6, color: "var(--c-muted-2)" },
  input: { width: "100%", padding: "14px 16px", fontSize: 15, background: "var(--c-surface)", border: "1.5px solid var(--c-border)", borderRadius: 12, outline: "none", color: "var(--c-text-2)", boxSizing: "border-box", transition: "border-color 0.2s" },
  btn: { width: "100%", padding: 14, background: "var(--c-brand-solid)", color: "var(--c-on-brand)", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer", marginTop: 8 },
  error: { background: "var(--c-danger-bg)", color: "var(--c-danger)", padding: "10px 14px", borderRadius: 10, fontSize: 13, marginBottom: 14 },
};
