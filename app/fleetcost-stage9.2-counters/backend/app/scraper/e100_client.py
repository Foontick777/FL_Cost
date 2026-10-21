"""
e100.eu API client — POST https://clients.e100.eu/api/transactions
Auth: POST https://clients.e100.eu/api/token

Uses curl_cffi with browser impersonation (Chrome TLS/JA3 fingerprint)
because e100.eu sits behind Cloudflare bot protection that 403s any client
whose TLS handshake doesn't match a real browser. Plain httpx was working
until Cloudflare's bot filter was tightened, at which point every request
to /api/transactions started coming back as 403 Forbidden while /api/token
(login) kept succeeding — Cloudflare was challenging the second endpoint
more aggressively than the first.

curl_cffi's `impersonate="chrome131"` mode replays Chrome's exact ClientHello,
ALPN, cipher order, etc., so Cloudflare sees a real browser and lets the
request through to the application layer.
"""
import logging
import re
from datetime import datetime, date, timezone
from typing import Optional
from dataclasses import dataclass

from curl_cffi import requests as cffi_requests

logger = logging.getLogger(__name__)

# e100 returns tokens in its JSON bodies. Dumping a body into the logs (or into
# `last_sync_error`, which is stored in the DB and rendered in the UI) would
# hand out a working session token, so mask token-ish values first.
_TOKEN_RE = re.compile(
    r'(?i)("?(?:access|refresh)?_?token"?\s*[:=]\s*"?)([A-Za-z0-9\-._~+/=]{8,})'
)


def _redact(text, limit: int = 400) -> str:
    """Mask token-like substrings and truncate — safe for logs and DB fields."""
    s = str(text if text is not None else "")
    s = _TOKEN_RE.sub(r"\1***", s)
    s = re.sub(r"(?i)(password\"?\s*[:=]\s*\"?)[^\"\s,}]{1,}", r"\1***", s)
    return s[:limit]

E100_BASE = "https://clients.e100.eu"
LOGIN_URL = f"{E100_BASE}/api/token"
TRANSACTIONS_URL = f"{E100_BASE}/api/transactions"

# Chrome 131 is a stable impersonation target that curl_cffi ships
# out-of-the-box. The User-Agent below must approximately match the
# impersonated browser family — Cloudflare cross-checks UA against the
# TLS fingerprint and 403s mismatches.
IMPERSONATE = "chrome131"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# Headers e100's own SPA sends on every request. curl_cffi already
# provides browser-matching Sec-Ch-UA / Accept-Encoding / Sec-Fetch-*
# defaults via the impersonate flag — we only override what e100 needs.
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    "Origin": "https://clients.e100.eu",
    "Referer": "https://clients.e100.eu/transactions",
    "User-Agent": USER_AGENT,
}


@dataclass
class E100Transaction:
    date: datetime
    card: str
    card_shortname: str
    auto: str
    card_driver: Optional[str]
    country: str
    station_id: str
    price: float
    currency: str
    volume: float
    amount: float
    service_category: int
    fuel_type: str
    category: int
    address: Optional[str]
    station_region: Optional[str]
    is_confirmed: bool        # False = blocked, exclude from accounting
    e100_mobility: bool
    datetime_insert: Optional[datetime]
    driving_licence_number: Optional[str]


class E100ClientError(Exception):
    """Raised when e100 returns a non-2xx response. Includes response body
    so the operator can see whether the failure is Cloudflare
    ('Just a moment...'), an auth failure ('Invalid token'), or a real
    API error — instead of just the bare HTTP status code httpx was
    surfacing before."""

    def __init__(self, status_code: int, url: str, body: str):
        self.status_code = status_code
        self.url = url
        self.body = body
        # This message is persisted to `e100_credentials.last_sync_error` and
        # rendered in the settings UI, so it must not carry tokens.
        snippet = _redact((body or "").strip(), limit=800)
        super().__init__(f"e100 HTTP {status_code} for {url}: {snippet}")


class E100Client:
    def __init__(self, username: str, password: str):
        self.username = username
        self.password = password
        self._access_token: Optional[str] = None
        self._refresh_token: Optional[str] = None
        self._session: Optional[cffi_requests.AsyncSession] = None

    async def __aenter__(self):
        # impersonate= is the key parameter — it tells curl_cffi to use
        # libcurl-impersonate and replay Chrome's exact TLS handshake.
        self._session = cffi_requests.AsyncSession(
            impersonate=IMPERSONATE,
            timeout=30,
            allow_redirects=True,
        )
        self._session.headers.update(HEADERS)
        return self

    async def __aexit__(self, *args):
        if self._session:
            await self._session.close()
            self._session = None

    async def login(self) -> bool:
        try:
            resp = await self._session.post(
                LOGIN_URL,
                json={"login": self.username, "password": self.password,
                      "client_id": "client", "territory": 1, "v": 3},
            )
            if resp.status_code != 200:
                logger.error(
                    f"e100 login HTTP {resp.status_code}: {_redact(resp.text)}"
                )
                return False
            data = resp.json()
            # Response: {"status":200,"data":{"access_token":"...","refresh_token":"..."}}
            token = None
            if isinstance(data.get("data"), dict):
                token = data["data"].get("access_token")
            if not token:
                token = data.get("access_token") or data.get("token")
            if token:
                self._access_token = str(token)
                if isinstance(data.get("data"), dict):
                    self._refresh_token = data["data"].get("refresh_token")
                logger.info("e100 login successful")
                return True
            logger.error(f"e100 login: no token. Body={_redact(data)}")
            return False
        except Exception as e:
            logger.error(f"e100 login failed: {e}")
            return False

    def _auth_headers(self) -> dict:
        # Send the access token under BOTH the header the e100 SPA frontend
        # traditionally used (Access-Token) AND the standard Authorization
        # Bearer scheme. e100 has historically used Access-Token; sending
        # both costs nothing and protects against a silent rename on their
        # side.
        if not self._access_token:
            return {}
        return {
            "Access-Token": self._access_token,
            "Authorization": f"Bearer {self._access_token}",
        }

    async def fetch_transactions(self, date_from: date, date_to: date,
                                  page: int = 1) -> tuple[list[E100Transaction], int]:
        payload = {
            "auto_numbers": [], "cards": [], "departments": [],
            "from": date_from.strftime("%Y-%m-%d"), "lang": "en",
            "pageNumber": page, "regions": [], "services": [],
            "stations": [], "to": date_to.strftime("%Y-%m-%d"),
        }
        resp = await self._session.post(
            TRANSACTIONS_URL,
            json=payload,
            headers=self._auth_headers(),
        )
        # Capture the response body on any non-200 — this is what the
        # previous raise_for_status() call was throwing away. Without the
        # body the operator sees only "403 Forbidden" and has no way to
        # tell whether Cloudflare is challenging them, the token was
        # rejected, or the API payload was malformed.
        if resp.status_code != 200:
            raise E100ClientError(resp.status_code, str(resp.url), resp.text)
        data = resp.json()
        if data.get("statusCode") != 1:
            raise ValueError(f"e100 API error: {data}")
        msg = data["message"]
        return [self._parse(t) for t in msg.get("Transactions", [])], msg.get("PageCount", 1)

    async def fetch_all_transactions(self, date_from: date, date_to: date) -> list[E100Transaction]:
        all_txns, page = [], 1
        while True:
            txns, total_pages = await self.fetch_transactions(date_from, date_to, page)
            all_txns.extend(txns)
            logger.info(f"e100: page {page}/{total_pages}, {len(txns)} records")
            if page >= total_pages:
                break
            page += 1
        return all_txns

    def _parse(self, raw: dict) -> E100Transaction:
        def parse_dt(s: Optional[str]) -> Optional[datetime]:
            if not s:
                return None
            try:
                # e100 sends LOCAL wall-clock time with no offset (e.g.
                # "2026-08-31T23:30:00"). The app's convention — relied upon by
                # every `AT TIME ZONE 'UTC'` filter in transactions.py and
                # mileage.py, and by the income importer's noon-UTC trick — is
                # to treat that wall clock AS UTC, so the calendar date the
                # driver saw is preserved.
                #
                # `tzinfo=utc` makes that convention EXPLICIT instead of
                # depending on the PostgreSQL session timezone: a naive value
                # written to a TIMESTAMPTZ column is interpreted in the session
                # TZ, so if the DB is ever not UTC the stored instant (and the
                # derived date) silently changes. Values are unchanged on a
                # UTC-session database.
                return datetime.fromisoformat(s.split('.')[0].replace('Z', '')).replace(
                    tzinfo=timezone.utc
                )
            except Exception:
                return None

        return E100Transaction(
            date=parse_dt(raw.get("date")),
            card=raw.get("card", ""),
            card_shortname=raw.get("card_shortname", ""),
            auto=raw.get("auto", ""),
            card_driver=raw.get("card_driver"),
            country=raw.get("country", ""),
            station_id=raw.get("stationId", ""),
            price=float(raw.get("price") or 0),
            currency=raw.get("curency", ""),
            # `or 1` used to substitute a LITER when e100 sent no volume, which
            # silently corrupted price-per-litre / fuel-efficiency maths for
            # that row. Unknown is now unknown (NULL) — the API and the UI both
            # treat volume as optional.
            volume=float(raw["volume"]) if raw.get("volume") not in (None, "") else None,
            amount=float(raw.get("sum") or 0),
            service_category=int(raw.get("ServiceCategory") or 0),
            fuel_type=raw.get("ftype", ""),
            category=int(raw.get("category") or 0),
            address=raw.get("address"),
            station_region=raw.get("station_region"),
            is_confirmed=bool(raw.get("confirmed", True)),
            e100_mobility=bool(raw.get("e100mobility", False)),
            datetime_insert=parse_dt(raw.get("datetimeInsert")),
            driving_licence_number=raw.get("driving_licence_number"),
        )
