#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# FleetCost — резервное копирование БД (DEP-01, аудит stage8, P0)
#
# До этого спринта процедуры бэкапа НЕ СУЩЕСТВОВАЛО: единственная копия
# производственных данных лежала в docker-томе postgres_data на той же
# машине. Отказ диска, ошибочный rm -rf тома или шифровальщик означали
# ПОЛНУЮ и НЕОБРАТИМУЮ потерю всей финансовой истории.
#
# Использование:
#   ./backup.sh                          # бэкап в ./backups рядом с проектом
#   BACKUP_DIR=/var/backups/fleetcost ./backup.sh
#
# Ежедневный запуск — через cron на хосте (см. BACKUP.md):
#   30 3 * * *  cd /opt/fleetcost/deploy && ./backup.sh >> /var/log/fleetcost-backup.log 2>&1
#
# Что делает:
#   1. pg_dump -Fc (сжатый формат с выборочным восстановлением) из контейнера postgres
#   2. проверяет, что файл не пуст и читается (pg_restore --list)
#   3. печатает размер и SHA-256 — удобно для журнала
#   4. удаляет копии старше RETENTION_DAYS (по умолчанию 14)
#
# ВАЖНО: в дампе НЕТ секрета ENCRYPTION_KEY из .env (им зашифрованы
# логин/пароль e100). Бэкап без .env восстанавливает суммы, но не
# доступность e100-учётки. Правила хранения — в deploy/BACKUP.md.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."   # корень проекта (рядом с docker-compose.yml)

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/fleetcost_${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

# Учётные данные берём из .env проекта (как их видит контейнер postgres).
PGUSER="${POSTGRES_USER:-fleetcost}"
PGDATABASE="${POSTGRES_DB:-fleetcost}"
if [ -f .env ]; then
  _u="$(grep -E '^POSTGRES_USER=' .env | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  _d="$(grep -E '^POSTGRES_DB=' .env | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  [ -n "${_u:-}" ] && PGUSER="$_u"
  [ -n "${_d:-}" ] && PGDATABASE="$_d"
fi

echo "→ pg_dump: user=$PGUSER db=$PGDATABASE → $OUT"

# exec -T: без TTY (скрипт может работать из cron). stdout → файл.
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDATABASE" -Fc > "$OUT"

# ── Проверка: пустой/битый дамп не должен оставаться единственной копией ──
if [ ! -s "$OUT" ]; then
  echo "✗ Дамп пуст — возможно, контейнер postgres не поднят." >&2
  rm -f "$OUT"
  exit 1
fi
if ! docker run --rm -i postgres:16 pg_restore --list < "$OUT" >/dev/null 2>&1; then
  # Дамп не читается — ошибка, а не бэкап. Скрипт падает с ненулевым кодом,
  # чтобы cron/мониторинг показали сбой, а не тишину с мёртвым файлом.
  echo "✗ Дамп не проходит pg_restore --list — НЕ считаем его валидным." >&2
  exit 1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"
echo "✓ Готово: $OUT ($SIZE)"
echo "  SHA-256: $SHA"

# ── Ротация ──────────────────────────────────────────────────────────
DELETED="$(find "$BACKUP_DIR" -name 'fleetcost_*.dump' -mtime +"$RETENTION_DAYS" -print -delete | wc -l)"
echo "→ Ротация: удалено копий старше ${RETENTION_DAYS} дн.: ${DELETED}"
