#!/usr/bin/env python3
"""
Standalone diagnostic for the e100.eu client fix.

Run from the host (not in Docker) with:

    python3 backend/scripts/test_e100_client.py <username> <password>

It will:
  1. Try logging into https://clients.e100.eu/api/token
  2. Try fetching transactions for the last 30 days from
     https://clients.e100.eu/api/transactions
  3. Print a summary — either success (page count + first transaction
     preview) or the exact HTTP status + response body e100 returned.

This is the fastest way to confirm the curl_cffi / Chrome impersonation
fix is working before rebuilding the Docker container.

Requirements:  pip install curl_cffi
"""
import asyncio
import sys
from datetime import date, timedelta
from pathlib import Path

# Make `backend/app/...` importable when the script is run from anywhere
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.scraper.e100_client import E100Client, E100ClientError


async def main(username: str, password: str) -> int:
    date_to = date.today()
    date_from = date_to - timedelta(days=30)
    print(f"[diag] period: {date_from} -> {date_to}")

    async with E100Client(username, password) as client:
        print("[diag] logging in to https://clients.e100.eu/api/token ...")
        if not await client.login():
            print("[diag] LOGIN FAILED - check username/password")
            return 2
        print(f"[diag] login ok, access_token = {client._access_token[:20]}...")

        print("[diag] fetching transactions page 1 ...")
        try:
            txns, page_count = await client.fetch_transactions(date_from, date_to, page=1)
        except E100ClientError as e:
            print(f"[diag] FETCH FAILED - HTTP {e.status_code}")
            print(f"[diag] URL:  {e.url}")
            print(f"[diag] BODY: {e.body}")
            return 3
        except Exception as e:
            print(f"[diag] FETCH FAILED - {type(e).__name__}: {e}")
            return 4

        print(f"[diag] OK - {len(txns)} records on page 1, total pages = {page_count}")
        if txns:
            t = txns[0]
            print(f"[diag] first record: {t.date}  {t.auto}  "
                  f"{t.fuel_type}  {t.amount:.2f} {t.currency}")
        return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2])))
