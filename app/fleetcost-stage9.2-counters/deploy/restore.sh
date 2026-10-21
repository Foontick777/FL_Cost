#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# FleetCost — восстановление БД из дампа (DEP-01, аудит stage8)
#
# Использование:
#   ./restore.sh backups/fleetcost_20261019_033000.dump
#
# Что делает:
#   0. проверяет, что дамп читается (pg_restore --list) ДО любых изменений
#   1. делает СТРАХОВОЧНЫЙ дамп текущего состояния (нельзя вернуться — так
#      хотя бы остаётся копия «до восстановления»)
#   2. останавливает backend (чтобы приложение не писало в БД посреди восстановления)
#   3. pg_restore --clean --if-exists — схема+данные заменяются содержимым дампа
#   4. поднимает backend обратно
#
# Учебный прогон (recovery drill) — см. раздел «Учебное восстановление»
# в deploy/BACKUP.md. Бэкап, который ни разу не восстанавливали, — это
# не бэкап, а надежда.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

DUMP="${1:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "Использование: $0 <путь/к/файлу.dump>" >&2
  echo "Пример:        $0 backups/fleetcost_20261019_033000.dump" >&2
  exit 1
fi

cd "$(dirname "$0")/.."   # корень проекта

PGUSER="${POSTGRES_USER:-fleetcost}"
PGDATABASE="${POSTGRES_DB:-fleetcost}"
if [ -f .env ]; then
  _u="$(grep -E '^POSTGRES_USER=' .env | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  _d="$(grep -E '^POSTGRES_DB=' .env | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  [ -n "${_u:-}" ] && PGUSER="$_u"
  [ -n "${_d:-}" ] && PGDATABASE="$_d"
fi

# 0. Дамп должен читаться ДО того, как мы что-то остановили/удалили.
if ! docker run --rm -i postgres:16 pg_restore --list < "$DUMP" >/dev/null 2>&1; then
  echo "✗ Файл $DUMP не является читаемым дампом pg_dump -Fc. Восстановление отменено." >&2
  exit 1
fi
echo "✓ Дамп читается: $DUMP"

# 1. Страховочный дамп текущего состояния.
SAFETY_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d_%H%M%S)"
SAFETY="$SAFETY_DIR/pre_restore_${STAMP}.dump"
mkdir -p "$SAFETY_DIR"
echo "→ Страховочный дамп текущей базы → $SAFETY"
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDATABASE" -Fc > "$SAFETY"
if [ ! -s "$SAFETY" ]; then
  echo "✗ Страховочный дамп пуст — восстановление отменено." >&2
  exit 1
fi

# 2. Останавливаем backend: восстановление на живую базу с активными
#    сессиями приложения заканчивается смесью старых и новых данных.
echo "→ Останавливаю backend..."
docker compose stop backend

# 3. Восстановление. --clean удаляет объекты перед созданием из дампа,
#    --if-exists не падает, если объекта уже нет.
echo "→ pg_restore --clean --if-exists ..."
if docker compose exec -T postgres pg_restore \
     -U "$PGUSER" -d "$PGDATABASE" --clean --if-exists --no-owner < "$DUMP"; then
  echo "✓ База восстановлена из $DUMP"
else
  echo "⚠ pg_restore вернул ошибку (часто это лишь ошибки с активными сессиями)."
  echo "  Проверьте данные и логи; страховочная копия: $SAFETY"
fi

# 4. Возвращаем приложение.
echo "→ Поднимаю backend..."
docker compose start backend
echo "✓ Готово. Проверьте: открылся ли дашборд и сходятся ли суммы."
