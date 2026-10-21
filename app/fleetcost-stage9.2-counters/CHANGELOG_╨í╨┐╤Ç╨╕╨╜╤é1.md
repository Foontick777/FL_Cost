# FleetCost — Спринт 1: P0 + P1 из аудита stage8

> Период: 19.10.2026. Основа: `fleetcost-stage8.zip`.
> Полный перечень находок — в «FleetCost_Технический_аудит_stage8.docx» (раздел 11, реестр 32 находок).
> Этот спринт закрывает **все 7 находок уровня P0–P1**: DEP-01, UX-01, SEC-01, SEC-02, PAY-01, SEC-03, FX-01.

---

## Что изменилось (кратко)

| ID | Приоритет | Находка | Статус |
|----|-----------|---------|--------|
| DEP-01 | **P0** | Нет резервного копирования БД | ✅ Исправлено |
| UX-01 | P1 | Роль появляется только после F5 | ✅ Исправлено |
| SEC-01 | P1 | python-jose 3.3.0 (CVE-2024-33663/33664) | ✅ Исправлено |
| SEC-02 | P1 | JWT на 7 дней без механизма отзыва | ✅ Исправлено |
| PAY-01 | P1 | Менеджер удаляет договор вместе с историей оплат | ✅ Исправлено |
| SEC-03 | P1 | Пароль минимум 7 символов | ✅ Исправлено |
| FX-01 | P1 | Захардкоженный список валют без CHF/RSD/MDL/GEL | ✅ Исправлено |

Проверено: **222/222 автотестов OK** (было 220 с 3 сбоями), живой прогон API и браузерного сценария (Chromium 1440×900).

---

## 1. DEP-01 (P0): резервное копирование и восстановление

**Было.** Единственная копия данных — docker-том `postgres_data` на той же машине. Отказ диска/шифровальщик = полная необратимая потеря финансовой истории.

**Стало:**
- `deploy/backup.sh` — ежедневный `pg_dump -Fc` из контейнера, проверка читаемости дампа (`pg_restore --list`), SHA-256, ротация 14 дней (`RETENTION_DAYS`).
- `deploy/restore.sh` — восстановление: проверка дампа ДО изменений, страховочный дамп «до», остановка backend, `pg_restore --clean --if-exists`, возврат backend.
- `docker-compose.yml` — новый сервис `db_backup` (профиль `backup`, том `db_backups`): встроенный ежедневный бэкап без cron: `docker compose --profile backup up -d`.
- `deploy/BACKUP.md` — полная инструкция: cron на хосте, схема 3-2-1, что НЕ входит в дамп (`.env` c `ENCRYPTION_KEY`!), учебное восстановление раз в квартал, таблица типовых сбоев.

**Как включить сразу:**
```bash
./deploy/backup.sh                                   # вручную прямо сейчас
# crontab -e: 30 3 * * *  cd /opt/fleetcost && ./deploy/backup.sh >> /var/log/fc-backup.log 2>&1
```

---

## 2. SEC-02 (P1): короткий access + отзывные refresh-токены

**Было.** Один JWT на 7 дней в cookie `fc_at`. Украденный cookie жил неделю; «выход» только чистил cookie; деактивация пользователя не отзывала уже выданные токены.

**Стало (классическая схема для SaaS):**
- **Access-JWT — 30 минут** (`ACCESS_TOKEN_EXPIRE_MINUTES=30`), клеймы `jti` (уникальный id) и `ver` (версия токенов пользователя).
- **Refresh-токен — 14 дней** (`REFRESH_TOKEN_EXPIRE_DAYS=14`): непрозрачный случайный токен (384 бита энтропии) в HttpOnly cookie `fc_rt`; в БД — таблица `refresh_tokens` с **SHA-256-хэшем**, сроком, `revoked_at`, user-agent и IP (задел под экран «Активные сессии»).
- **`POST /api/auth/refresh`** — ротация: старая строка отзывается, выдаётся новая пара. **Reuse-детекция**: попытка обмена уже отозванным токеном → отзываются ВСЕ сессии пользователя (признак кражи).
- **`POST /api/auth/logout`** теперь отзывает refresh-строку, а не только чистит cookie.
- **`POST /api/auth/logout-all`** — «выйти на всех устройствах»: отзыв всех сессий + повышение `token_version`.
- **Мгновенный отзыв access**: `users.token_version` (+1 при деактивации/удалении пользователя, logout-all). `get_current_user` сверяет клейм `ver` — несовпадение = 401. Токены старого образца (без `ver`) перестают приниматься сразу — один перелогин после деплоя.
- **Фронтенд** (`lib/api.js`): при 401 — тихий `POST /auth/refresh` (single-flight, без циклов) и повтор исходного запроса; пользователь не вылетает каждые 30 минут.
- Cookie `fc_csrf` теперь живёт не короче сессии (раньше умерла бы через 30 минут).
- Миграции: alembic `0016_refresh_tokens.py` (production) + догоняющие CREATE TABLE/ADD COLUMN в `main.py` и `schema_sync.sync_users_schema` (dev) — развертывание поверх существующей базы безопасно.

**Проверено живьём:** ротация 200 → повтор старой cookie 401 → все сессии в БД отозваны; logout-all → старый access 401.

---

## 3. PAY-01 (P1): историю оплат нельзя стереть

**Было.** `DELETE /recurring-expenses/{id}` (и 4 легаси-роута договоров) физически удалял списания, включая оплаченные, и был доступен роли manager.

**Стало (ровно как в фрагменте исправления из отчёта аудита):**
- Удаление — **только owner** (`require_owner`): recurring_expenses, recurring_contracts, leasing_contracts, trailer_contracts, insurance_contracts.
- **При наличии хотя бы одного списания — 409** с подсказкой «используйте Остановить»: история неизменяема. Удалять можно только договор, созданный по ошибке и не создавший ни одного списания.
- Фронтенд: пункт «🗑 Удалить» в меню «…» показывается только owner; текст диалога удаления приведён в соответствие с новым поведением.
- Списания считаются по FK `recurring_expense_id` + точному префиксу external_id (без LIKE-дефекта).

**Проверено живьём:** менеджер → 403; owner по договору с 3 списаниями → 409 (списания на месте); owner по договору без списаний → 200.

---

## 4. SEC-03 (P1): пароль от 10 символов + стоп-лист

**Было.** Минимум 7 символов, заглавная + цифра.

**Стало:**
- Минимум **10 символов**, требования по классам сохранены.
- **Стоп-лист расхожих паролей** (`Password123`, `Qwertyuiop1`, …) — точные совпадения + подстроки `password`/`qwerty`/`12345678`/`administrator`.
- Правило живёт на бэкенде (Pydantic, обойти через API нельзя) и продублировано на фронтенде (AuthPage, UsersPage).
- **Существующие пользователи НЕ затронуты** — политика применяется только при создании пользователя.

---

## 5. SEC-01 (P1): python-jose 3.3.0 → 3.5.0

- CVE-2024-33663 (algorithm confusion при ECDSA-ключах) и CVE-2024-33664 (DoS через JWE) закрыты в ветке 3.5.x. Приложение использует HS256, поэтому практический риск был ограничен, но pin поднят: `python-jose[cryptography]==3.5.0`. Остальные зависимости не менялись.

---

## 6. UX-01 (P1): роль доступна сразу после входа

**Было.** `window.__FLEETCOST_ROLE__` выставлялся только в boot-проверке `/auth/me` при загрузке страницы. После логина Sidebar рендерился с ролью по умолчанию («viewer»): администратор не видел «Администрирование» до F5 (подтверждено в аудите на живом приложении).

**Стало:** AuthPage после успешного логина/регистрации подтягивает `/auth/me` и передаёт пользователя в `onAuth(user)`; App выставляет роль и имя ДО первого рендера основного интерфейса.

**Проверено в браузере (1440×900):** после логина меню «Администрирование» присутствует сразу, `window.__FLEETCOST_ROLE__ === "owner"` без перезагрузки.

---

## 7. FX-01 (P1): список валют — с бэкенда

**Было.** Список захардкожен в 5 местах, в формах не было CHF/RSD/MDL/GEL — операцию в швейцарских франках нельзя было внести руками.

**Стало:**
- Новый эндпоинт **`GET /api/fx-rates/form-currencies`** — единый источник: EUR + активные валюты ЕЦБ (без исторических CYP/EEK/LTL/LVL/MTL/SIT/SKK/ROL/TRL/HRK) + валюты Frankfurter (при недоступности сервиса — резервный набор BYN/RSD/UAH/MDL/GEL). Ответ с `code/name/source` не зависит от наличия заведённых курсов.
- **Фронтенд**: новый модуль `lib/currencies.js` (`useCurrencyList()` с кэшем localStorage на сутки + fallback). Подключён к ExpenseForm, Manual, Income, Fuel, FuelLike — все 5 захардкоженных списков удалены.

**Проверено живьём:** эндпоинт отдаёт 166 валют (CHF/RSD/MDL/GEL/UAH/BYN на месте, EUR первый); в браузере форма показывает полный список.

---

## Изменённые файлы

**Бэкенд (12):**
```
requirements.txt                                  — python-jose 3.5.0
app/core/config.py                                — ACCESS 30 мин, REFRESH 14 дней
app/core/security.py                              — jti/ver, fc_rt, hash, cookie-хелперы
app/core/schema_sync.py                           — sync_users_schema (token_version)
app/api/deps.py                                   — сверка клейма ver
app/api/routes/auth.py                            — сессии, refresh, logout-all
app/api/routes/recurring_expenses.py              — PAY-01
app/api/routes/recurring_contracts.py             — PAY-01
app/api/routes/leasing_contracts.py               — PAY-01
app/api/routes/trailer_contracts.py               — PAY-01
app/api/routes/insurance_contracts.py             — PAY-01
app/api/routes/fx_rates.py                        — GET /form-currencies
app/models/models.py                              — User.token_version, RefreshToken
app/main.py                                       — догоняющая схема refresh_tokens
alembic/versions/0016_refresh_tokens.py           — НОВЫЙ
tests/test_auth_sprint1.py                        — НОВЫЙ (14 тестов)
tests/test_expense_categories.py                  — 3 теста обновлены под PAY-01/устаревший test_15
```

**Фронтенд (10):**
```
src/lib/api.js                                    — refresh-on-401 (single-flight)
src/lib/currencies.js                             — НОВЫЙ (useCurrencyList)
src/AuthPage.jsx                                  — роль после логина, пароль 10+
src/App.jsx                                       — onAuth(user)
src/ui/ExpenseForm.jsx                            — динамические валюты
src/ui/RecurringPanel.jsx                         — PAY-01 UI (owner-only delete)
src/pages/ManualPage.jsx, IncomePage.jsx,         — динамические валюты
src/pages/FuelPage.jsx, FuelLikePage.jsx
src/pages/UsersPage.jsx                           — подсказки пароля 10+
```

**Деплой (4):**
```
deploy/backup.sh, deploy/restore.sh               — НОВЫЕ
deploy/BACKUP.md                                  — НОВЫЙ
docker-compose.yml                                — сервис db_backup (профиль backup)
```

## Обновление существующего deployment

```bash
# 1. Остановить и забрать новый код
docker compose down
# 2. (рекомендуется) сразу поставить первый бэкап после запуска:
./deploy/backup.sh
# 3. Поднять: миграция 0016 применится сама (python -m app.scripts.migrate в контейнере)
docker compose up -d --build
# 4. Все пользователи перелогинятся один раз (старые токены без "ver" не принимаются).
```

## Что осталось на следующие спринты (из реестра аудита)

- **Спринт 2 (P2, часть 1):** двойная схема миграций → консолидация, `date.today()` без таймзоны, sync при открытии страницы без cooldown, README ↔ код (soft delete).
- **Спринт 3 (P2, часть 2):** планировщик в процессе (горизонтальное масштабирование), смена валюты договора (PAY-02), редактирование разового расхода, конкурентный `store_rates`.
- **Спринт 4 (P3 + полировка):** единый формат чисел, замена `window.confirm` на собственный Modal, «Активные сессии» (данные уже собираются), смена пароля пользователем + восстановление (вы отложили до VPS).
