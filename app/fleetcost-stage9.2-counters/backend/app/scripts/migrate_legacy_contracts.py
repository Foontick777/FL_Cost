"""Перенос договоров старого формата в регулярные платежи — для ВСЕХ компаний.

Запуск (по умолчанию пробный прогон: ничего не меняется, печатается отчёт):

    docker compose exec backend python -m app.scripts.migrate_legacy_contracts
    docker compose exec backend python -m app.scripts.migrate_legacy_contracts --company 3
    docker compose exec backend python -m app.scripts.migrate_legacy_contracts --apply

Рекомендуемый порядок для боевой базы: сделать копию БД → пробный прогон →
прочитать отчёт → --apply. Повторный запуск безопасен: уже перенесённые договоры
пропускаются (отметка legacy_ref), недостающие списания дорелинкуются.
Подробности — app/services/legacy_migration_service.py.
"""
import argparse
import asyncio
import json
import sys


async def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="записать изменения (без флага — пробный прогон)")
    ap.add_argument("--company", type=int, default=None, help="только одна компания")
    args = ap.parse_args(argv)

    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.models.models import Company
    from app.services import legacy_migration_service

    async with AsyncSessionLocal() as db:
        q = select(Company.id).order_by(Company.id)
        if args.company:
            q = q.where(Company.id == args.company)
        ids = [i for (i,) in (await db.execute(q)).all()]

    mode = "ПРИМЕНЕНИЕ" if args.apply else "пробный прогон (изменений нет)"
    print(f"Режим: {mode}; компаний: {len(ids)}")
    errors = 0
    for cid in ids:
        async with AsyncSessionLocal() as db:
            rep = await legacy_migration_service.migrate_company(db, cid, apply=args.apply)
        if not rep["contracts"]:
            continue
        errors += rep["errors"]
        print(json.dumps(rep, ensure_ascii=False, indent=2, default=str))
    print("Готово." + (" Есть ошибки — см. отчёт." if errors else ""))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
