# FleetCost 🚛

Self-hosted fleet expense tracking service for European trucking companies.
Automatically pulls transaction data from e100.eu and stores it in your own database.

## Features

- **Multi-tenant** — multiple companies can register independently
- **Automatic e100.eu sync** via JSON API (no browser automation needed)
- **Role-based access control** — owner / manager / viewer with strict
  backend enforcement (Issue #1)
- **NUMERIC money storage** — no Float drift on financial figures (Issue #2)
- **ECB-sourced FX rates** — EUR conversion at the operation date, not a
  hardcoded dict (Issue #3)
- **Audit trail** — every state-changing operation is logged with the user,
  IP, before/after values, and timestamp (Issue #4)
- **HttpOnly cookie + CSRF protection** — JWT no longer in localStorage (Issue #5)
- **Docs closed in production** — `/docs` `/redoc` `/openapi.json` return 404
  when `ENVIRONMENT != development` (Issue #6)
- **Rate limiting** on `/auth/login` (10/min) and `/auth/register` (3/min) (Issue #7)
- **Backend password policy** — min 7 chars, ≥1 uppercase, ≥1 digit, enforced
  by Pydantic on the server (Issue #8)
- **Fernet key validation** — `ENCRYPTION_KEY` is checked at startup; helper
  script generates a real one (Issue #9)
- **Alembic migrations** — baseline + 0002_security_hardening; no more
  `ALTER TABLE IF NOT EXISTS` hacks (Issue #10)
- **Per-company scheduler** — `ScraperSettings.interval_minutes` and
  `is_enabled` actually control the per-company sync job (Issue #11)
- **Multi-credential dedup** — `credential_id` + `source_account` tie each
  transaction back to the specific E100 account that produced it (Issue #12)

Plus all the original features:
- Dashboard with filters by period: today / week / month / year / custom
- Stats by vehicle, country, expense type, currency
- Excel export (audit-logged)
- Telegram bot: per-transaction notifications + /today /week /month /sync commands

**Universal expense categories** (see the section below) — the product is not
tied to one country or one business model: every section takes any category,
one-off or recurring, and taxes/insurance types are configured per company.

## Stack

- **Backend**: Python 3.12, FastAPI, SQLAlchemy async, PostgreSQL, APScheduler, aiogram 3
- **Frontend**: React 18 + Vite (no heavy UI framework — pure inline styles)
- **Deployment**: Docker Compose

---

## Quick Start

### 1. Clone and configure
```bash
git clone <your-repo>
cd fleetcost
cp .env.example .env
```

Generate the secrets (NEVER reuse the placeholder values from .env.example):

```bash
# 1) SECRET_KEY (JWT signing)
python -c "import secrets; print(secrets.token_hex(32))"

# 2) ENCRYPTION_KEY (Fernet — for encrypting e100 passwords in the DB)
docker compose run --rm backend python -m app.scripts.generate_fernet_key

# 3) POSTGRES_PASSWORD
python -c "import secrets; print(secrets.token_urlsafe(24))"
```

Edit `.env` and set:
```
POSTGRES_PASSWORD=<from step 3>
SECRET_KEY=<from step 1>
ENCRYPTION_KEY=<from step 2 — a 44-char urlsafe-base64 string>
ENVIRONMENT=production        # closes /docs /redoc /openapi.json
SECURE_COOKIES=true           # HTTPS-only cookies
CORS_ORIGINS=https://your-frontend-domain
TELEGRAM_BOT_TOKEN=<from @BotFather — optional>
```

### 2. Start
```bash
docker compose up -d
```

The backend runs `alembic upgrade head` on startup (Issue #10), which:
- On a FRESH database: creates all tables in their v2 form via migration 0001.
- On an EXISTING database that was running on the old Float-based schema:
  applies migration 0002 (`security_hardening`) which ALTERs the existing
  tables in place (Float → Numeric, adds fx_rates, audit_log, credential_id
  on transactions, etc.).

- Frontend: http://localhost:3000
- Backend API: http://localhost:8000 (docs are available only in development env)

### 3. First use

1. Open http://localhost:3000 → Register your company (you become role=owner)
2. (Owner) Go to ⚙️ Settings → add your e100.eu login/password
3. (Owner) Click **Sync e100** on Dashboard
4. (Owner) Add vehicle plate numbers if they don't appear automatically
5. (Owner) Go to /api/fx-rates/sync (via curl or a REST tool) to pull the
   latest ECB rates — or wait for the daily scheduler job. Until rates are
   loaded, the frontend uses the fallback EUR_RATES dict (printed in the
   console on app start).
6. (Owner) To add a manager or viewer: Settings → User management. Viewers
   get read-only access (no POST/PATCH/DELETE).

---

## Universal expense categories (dynamic sections)

FleetCost used to hardcode the expense vocabulary of one country and one way of
working: fines/parking/repair on «Иные расходы», rental/insurance/CMR on the
trailer page, office/accounting/parking as *the* general expenses, polish/CASCO/
belarus as *the* insurance types, and ZUS/PIT-4 as *the* payroll taxes. Adding
«GPS tracker» or a German insurer meant a code change.

Now the vocabulary is data:

* **Sections are fixed, categories are dynamic.** A section is an accounting area
  and matches a menu tab: `other`, `trailer`, `general`, `salary`, `salary_tax`,
  `insurance`. Inside a section, a company gets a ready-made system set
  (`is_system = true`) and can add any number of its own categories — from the
  expense form itself (`＋ Create new category`) or from
  **Administration → Expense categories**.
* **One form for everything.** Category, object (vehicle / trailer / company),
  amount, currency, date, **type (one-off / recurring)**, frequency, description,
  comment and document reference live in one modal, shared by every section
  (`src/ui/ExpenseForm.jsx`).
* **Recurring expenses are unlimited.** Any active category of any section can be
  made recurring — monthly, quarterly, yearly or weekly, with or without an end
  date, and without the old 12-month contract assumption. Charges are generated
  on demand and are idempotent (`external_id = rexp_{id}_{period}`); a charge the
  user deleted is not recreated (tombstone).
* **Insurance: country is an attribute, not a type.** `insurance_contracts` now
  carries `country`, `policy_number` and `insurer` separately, and `category` is
  any code of the `insurance` section — so «Haftpflicht», «Kfz-Versicherung» or
  «ОСГО» are first-class. The historical `polish` / `belarus` codes remain so
  existing contracts and expenses keep working, but they are seeded *inactive*.
* **Taxes are configured, not assumed.** ZUS and PIT-4 stay in the ready-made set
  (nothing to configure for Poland), but they are not hardcoded widgets any more:
  the «Зарплата» page renders one KPI card per configured `salary_tax` category,
  and shows a compact “taxes are not configured” block with an **Add** button
  when there are none.
* **History is never lost.** Renaming a category keeps its `code` (the code is
  part of `fuel_type` of already-recorded rows). A category with operations
  cannot be deleted — the API answers `409` and suggests disabling it instead, so
  past expenses keep their classification.

Nothing changes for existing data: `fuel_type` still holds
`manual_{section}_{code}`, so every existing filter, page, export and Telegram
notification keeps working. New rows additionally carry `category_id`, and
categories that only exist in history are backfilled automatically the first time
the category list is requested. The one deliberate exception is `salary_tax`,
whose prefix is `salary` — that is what keeps historical `manual_salary_zus` /
`manual_salary_pit4` rows attached to their categories.

### API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/expense-categories/` | list (seeds + backfills on first call); `section`, `include_inactive` |
| `GET` | `/api/expense-categories/meta` | sections, prefixes, frequencies, object scopes |
| `POST` | `/api/expense-categories/` | create — owner & manager |
| `PATCH` | `/api/expense-categories/{id}` | rename, icon/colour, scope, enable/disable |
| `DELETE` | `/api/expense-categories/{id}` | owner only; `409` if the category is in use |
| `POST` | `/api/expenses/` | one-off **or** recurring (`type`, `periodicity`, `section` + `category_code`) |
| `GET/POST` | `/api/recurring-expenses/` | universal recurring expenses (any category, any object) |
| `PATCH` | `/api/recurring-expenses/{id}/cancel` | stop future charges, keep history |
| `POST` | `/api/recurring-expenses/sync` | generate missing charges up to today |

The legacy call style still works: `POST /api/expenses/` with
`{"category": "other_fine", ...}` is translated to `(other, fine)` and linked to
the matching category.

### Tests

```bash
cd backend && python3 tests/test_expense_categories.py
```

15 checks covering the acceptance criteria: seeding and custom categories in all
sections, immediate usability, deactivate-keeps-history, delete guarding, one-off
and recurring creation, idempotent sync, deleted-charge tombstone, frequencies
and object scopes (vehicle / trailer / company), configurable taxes, insurance
country-as-attribute, trailer categories beyond rental/insurance/CMR, tenant
isolation, role permissions, backfill from history, and that the existing
analytics pipeline is untouched. A separate test compiles the new tables for the
PostgreSQL dialect, and asserts the `fuel_type` contract that the whole
historical dataset depends on.

---

## Role-based access (Issue #1)

| Action                       | Owner | Manager | Viewer |
|------------------------------|:-----:|:-------:|:------:|
| Read (GET)                   |  ✅   |  ✅     |  ✅    |
| Add expense / vehicle         |  ✅   |  ✅     |  ❌    |
| Edit expense / vehicle       |  ✅   |  ✅     |  ❌    |
| Delete expense / vehicle     |  ✅   |  ✅     |  ❌    |
| Export                       |  ✅   |  ✅     |  ❌    |
| Contracts (all kinds)        |  ✅   |  ✅     |  ❌    |
| E100 credentials             |  ✅   |  ❌     |  ❌    |
| Telegram settings            |  ✅   |  ❌     |  ❌    |
| Scraper settings             |  ✅   |  ❌     |  ❌    |
| Manual sync                  |  ✅   |  ❌     |  ❌    |
| Users management             |  ✅   |  ❌     |  ❌    |
| FX rates (manual override)   |  ✅   |  ❌     |  ❌    |
| Audit log (read)             |  ✅   |  ✅     |  ✅    |

Role checks happen in `app/api/deps.py` (`require_owner`, `require_manager`).
Every state-changing endpoint depends on one of these.

---

## Money & FX rates (Issues #2, #3, #12)

- **Money columns** are `NUMERIC(14, 2)` (amounts), `NUMERIC(18, 2)` (contract
  totals), `NUMERIC(12, 4)` (unit prices), `NUMERIC(12, 3)` (volumes in liters).
  No Float drift over thousands of transactions.
- **FX rates** are stored in the `fx_rates` table, sourced daily from the
  European Central Bank. Each `Transaction` carries `fx_rate`, `amount_eur`,
  `fx_rate_date`, `fx_source` populated at insert time using the rate closest
  to the transaction's date (with up to 14 days backward fallback for weekends
  and ECB holidays).
- **Historical backfill**: owner can call `POST /api/fx-rates/sync-historical`
  — pulls the full ECB archive (~25 years of daily rates, ~15000 rows) in one
  shot. Use this once after deploying to populate rates for all your existing
  transactions, then call `POST /api/fx-rates/backfill` to fill `amount_eur`
  on existing Transaction rows.
- **Manual FX override**: owner can `POST /api/fx-rates` to add a manual rate
  for any currency/date. Useful for BYN, UAH, etc. that ECB doesn't publish.
- **UI**: there's a dedicated **💱 Курсы валют / FX Rates** page in the sidebar
  with one-click buttons for today's rate, full historical sync, backfill, a
  manual rate entry form, and an interactive EUR converter widget.
- **Multi-credential dedup** (Issue #12): each Transaction has `credential_id`
  and `source_account` (SHA-256 hash of the E100 username). The dedup key is
  `(company_id, credential_id, external_id)` — two credentials returning the
  same vehicle+date+category no longer overwrite each other.

---

## Audit log (Issue #4)

Every POST / PATCH / DELETE on a business entity writes a row to `audit_log`
with: `user_id`, `user_email`, `action` (CREATE/UPDATE/DELETE/CANCEL/SYNC/
EXPORT/IMPORT/LOGIN/LOGOUT), `entity_type`, `entity_id`, `old_value` (JSON),
`new_value` (JSON), `ip_address`, `user_agent`, `created_at`.

Read access is open to all roles (the audit log is a shared accountability
record). There's no POST endpoint — writes only happen inside route handlers
via `app/services/audit_service.log()`.

**UI**: dedicated **📜 Журнал действий / Audit Log** page in the sidebar with
filters by action, entity type, date range, and pagination (100 rows per page).
Each row shows timestamp, user email, action badge, entity type, entity_id,
IP, and expandable old/new value JSON.

Retention: `AUDIT_LOG_RETENTION_DAYS=0` keeps everything. A nightly job purges
rows older than N days when > 0.

---

## User management (new)

Owners can manage their company's users via the dedicated **👥 Пользователи /
Users** page (sidebar, owner-only — managers and viewers don't see it).

Operations:
- **Add user**: create a manager or viewer (cannot create owner — only the
  registration flow does that). Password policy enforced: min 7 chars, ≥1
  uppercase letter, ≥1 digit.
- **Edit role**: switch user between manager / viewer. You cannot change your
  own role (would lock yourself out).
- **Disable / enable**: set `is_active=false` to revoke login without deleting.
  You cannot disable yourself.
- **Delete**: hard delete. You cannot delete yourself. The user's audit log
  entries are kept (they reference `user_email` for display after the FK is gone).

API endpoints:
- `GET /api/auth/users` — list users in your company (owner only)
- `POST /api/auth/users` — create manager/viewer (owner only)
- `PATCH /api/auth/users/{id}` — change role / active / name (owner only)
- `DELETE /api/auth/users/{id}` — delete (owner only)
- `GET /api/auth/me` — current user info (all roles, used by the frontend
  to gate the Users nav item by role)

---

## Backups (DEP-01, audit stage8)

The database is the company's financial history — back it up. Built-in tooling
(see **deploy/BACKUP.md** for the full guide):

```bash
./deploy/backup.sh                    # pg_dump -Fc → ./backups/, SHA-256, 14-day rotation
./deploy/restore.sh backups/fleetcost_XXXX.dump   # verified restore with a safety dump
docker compose --profile backup up -d             # or: built-in daily backup service
```

Rules of thumb: run backup daily (cron on the host), keep copies on ANOTHER
disk/machine, back up `.env` separately (the dump does NOT contain
`ENCRYPTION_KEY` — without it restored e100 credentials can't be decrypted),
and do a test restore once a quarter.

## Security notes

### Session tokens (SEC-02, audit stage8)

Access JWT lives 30 minutes (`fc_at` cookie) and carries `jti`/`ver` claims; a
14-day revocable refresh token (`fc_rt` cookie, SHA-256-hashed in
`refresh_tokens`) rotates on every `POST /api/auth/refresh`. Replaying a
revoked refresh token revokes ALL user sessions (theft detection). Logout
revokes the session; `POST /api/auth/logout-all` revokes every session and
bumps `users.token_version`, which instantly invalidates all previously
issued access tokens. Deactivating a user via PATCH /auth/users does the same.

### Passwords (SEC-03, audit stage8)

Minimum 10 characters, at least one uppercase letter and one digit, plus a
common-password blocklist. Applies to new users only — existing accounts keep
working unchanged.

### Contract deletion (PAY-01, audit stage8)

Deleting a contract is owner-only and refuses with 409 if the contract has
generated ANY charges — payment history is immutable. Use “Stop”
(PATCH /pause) to end future charges while keeping history.

### ENCRYPTION_KEY (Issue #9)

The Fernet key encrypts e100 passwords at rest in the `e100_credentials`
table. If an attacker gets your database backup **and** the ENCRYPTION_KEY,
they can decrypt every stored password — treat the key like a password
manager vault key.

**Do NOT store the ENCRYPTION_KEY**:
- In the same git repo as the code
- In the same volume / backup as the database
- In environment files committed to version control

**DO** store it:
- In a secrets manager (HashiCorp Vault, AWS Secrets Manager, Doppler, etc.)
- Or in a root-owned `.env` file outside the project directory with `chmod 600`

### Cookie + CSRF (Issue #5)

The frontend no longer writes the JWT to `localStorage` (where XSS could
steal it). Instead, `/auth/login` and `/auth/register` set:
- `fc_at` — HttpOnly, Secure (in prod), SameSite=Lax cookie with the JWT
- `fc_csrf` — non-HttpOnly cookie with a random CSRF token

Every state-changing request from the frontend must include an
`X-CSRF-Token: <same value as fc_csrf cookie>` header. The backend compares
the two (double-submit pattern) — a malicious cross-site form can send the
cookie but cannot read it to put it in a header, so the request is rejected.

---

## Making it accessible from outside your server

### Option A: Cloudflare Tunnel (recommended, free, no port forwarding)
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
./cloudflared tunnel --url http://localhost:3000
```

### Option B: Static IP + Let's Encrypt
Forward ports 80/443 on your router, install nginx + certbot on the host.
Set `SECURE_COOKIES=true`, `ENVIRONMENT=production`, `CORS_ORIGINS=https://your-domain`.

---

## Development (without Docker)

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
pip install psycopg2-binary  # for alembic

# Apply migrations (creates all tables fresh)
alembic upgrade head

# Or, for an existing DB, just upgrade:
# alembic stamp 0001_baseline  # mark existing schema as the baseline
# alembic upgrade head         # apply 0002_security_hardening

uvicorn app.main:app --reload --port 8000
```

### Frontend
```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:3000, proxies /api to :8000
```

---

## Adding a second data source (future)

The architecture is ready. To add, for example, a toll provider or Excel import:
1. Add a new scraper in `backend/app/scraper/`
2. Add credentials model/schema if needed
3. Reuse `save_transactions()` in `scraper/service.py` (pass `credential_id`
   and `source_account` so dedup works across all sources)
4. All existing filters/exports/Telegram notifications/audit logging work
   automatically

---

## Project structure
```
fleetcost/
├── backend/
│   ├── alembic/              # Issue #10 — Alembic env.py + migrations
│   │   ├── env.py
│   │   └── versions/
│   │       ├── 0001_baseline.py
│   │       ├── 0002_security_hardening.py
│   │       └── 0006_expense_categories.py  # dynamic categories + recurring expenses
│   ├── tests/
│   │   └── test_expense_categories.py      # acceptance criteria for the feature
│   ├── alembic.ini
│   ├── requirements.txt
│   └── app/
│       ├── api/
│       │   ├── deps.py       # Issue #1 — require_owner, require_manager, cookie+CSRF
│       │   └── routes/
│       │       ├── auth.py   # Issue #5,7,8 — cookies, rate-limit, password policy
│       │       ├── audit.py  # Issue #4 — GET /audit-log
│       │       ├── fx_rates.py  # Issue #3 — ECB sync, manual override, convert
│       │       ├── expenses.py       # one-off OR recurring, any section
│       │       ├── expense_categories.py  # category CRUD (admin)
│       │       ├── recurring_expenses.py  # universal recurring (any category)
│       │       ├── imports.py
│       │       ├── insurance_contracts.py # free-form type + country/policy
│       │       ├── leasing_contracts.py
│       │       ├── mileage.py
│       │       ├── recurring_contracts.py
│       │       ├── settings.py    # Issue #1 — owner-only for cred/telegram/scraper
│       │       ├── trailer_contracts.py
│       │       └── transactions.py
│       ├── core/
│       │   ├── config.py     # ENVIRONMENT, SECURE_COOKIES, FX_ECB_URL, ...
│       │   ├── database.py
│       │   └── security.py   # Issue #5,9 — Fernet validation, cookies, CSRF
│       ├── models/
│       │   └── models.py     # Issue #2,3,4,12 — Numeric, FxRate, AuditLog, provenance
│       ├── schemas/
│       │   └── schemas.py    # Issue #8 — backend password validator; Decimal schemas
│       ├── scraper/
│       │   ├── e100_client.py
│       │   └── service.py    # Issue #3,12 — credential_id, fx_rate, amount_eur
│       ├── scripts/
│       │   └── generate_fernet_key.py  # Issue #9
│       ├── services/
│       │   ├── audit_service.py  # Issue #4 — log() + snapshot()
│       │   ├── category_service.py        # sections, system set, seeding, backfill
│       │   ├── recurring_expense_service.py # charge generation + tombstones
│       │   └── fx_service.py      # Issue #3 — ECB fetch + rate lookup + backfill
│       ├── telegram/
│       │   ├── bot.py
│       │   └── notifications.py
│       └── main.py           # Issue #6,11 — docs gating, per-company scheduler
├── frontend/
│   └── src/
│       ├── App.jsx           # Issue #5 — cookie credentials, no localStorage
│       └── AuthPage.jsx     # Issue #5 — credentials:"include", CSRF header
├── .env.example
└── docker-compose.yml        # runs `alembic upgrade head` on startup
```
