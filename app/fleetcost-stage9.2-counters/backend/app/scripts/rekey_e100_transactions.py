"""
One-time migration: rewrite external_id for existing source='e100' transactions
to match the current key scheme in app/scraper/service.py (amount, station_id,
and insert-timestamp all excluded; vehicle identity keyed by plate, not card;
timestamp truncated to the minute).

WHY THIS IS NEEDED
-------------------
The dedup key started out including the transaction amount, then station_id,
then the insert timestamp — e100 revises all of these as a transaction moves
through its lifecycle (blocked/delayed -> confirmed) for what it shows as a
single transaction throughout: the amount can shift by a cent, the exact toll
gantry/station code can get corrected, and even e100's own "last touched"
timestamp can shift by a few seconds. Whenever the key formula changes to
stop including a field that can drift like this, every already-saved row
must be re-keyed to match — otherwise the next sync sees existing_count=0
for every group and re-inserts the entire e100 history again (this happened
once already; don't skip this step).

This script recomputes external_id for every existing e100 row using the
same algorithm the app uses going forward, so the next sync recognizes them
as already-saved and only touches genuinely new/changed transactions.

USAGE
-----
Run this ONCE per service.py key-formula change, after deploying the updated
service.py but BEFORE the next sync runs (manual or scheduled):

    docker compose exec backend python -m app.scripts.rekey_e100_transactions

It only reads/writes source='e100' rows. Nothing else is touched. It prints
a summary and does not delete or duplicate any data — only rewrites the
external_id column. Safe to re-run any time service.py's key formula changes
again; running it twice with no formula change in between is a no-op.
"""
import asyncio
from collections import defaultdict

from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.models.models import Transaction


def make_base_key_from_row(t: Transaction) -> str:
    """Mirrors make_base_key() in app/scraper/service.py, but reads from an
    already-saved Transaction row instead of a freshly-fetched E100Transaction."""
    vehicle_key = t.plate_number or t.card_shortname or "noauto"
    dt_str = t.transaction_date.strftime("%Y%m%d%H%M") if t.transaction_date else "unknown"
    return f"e100_{vehicle_key}_{dt_str}_{t.service_category}"


async def main():
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Transaction)
            .where(Transaction.source == "e100")
            .order_by(Transaction.company_id, Transaction.id)  # stable, deterministic order
        )
        rows = result.scalars().all()
        print(f"Found {len(rows)} e100 transactions to check.")

        groups: dict[tuple, list[Transaction]] = defaultdict(list)
        for t in rows:
            groups[(t.company_id, make_base_key_from_row(t))].append(t)

        changed = 0
        for (company_id, base_key), txns in groups.items():
            for i, t in enumerate(txns):
                new_ext_id = f"{base_key}_n{i}"
                if t.external_id != new_ext_id:
                    t.external_id = new_ext_id
                    changed += 1

        await db.commit()
        print(f"Rewrote external_id on {changed} of {len(rows)} rows, across {len(groups)} groups.")
        print("Done. Safe to run a normal sync now.")


if __name__ == "__main__":
    asyncio.run(main())
