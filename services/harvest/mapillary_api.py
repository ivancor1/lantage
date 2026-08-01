"""Mapillary Graph API v4 client: token bucket, backoff, and the field allowlist.

VERIFIED against https://www.mapillary.com/developer/api-documentation on 2026-07-29.
Do not edit the constants below from memory — re-fetch the docs and re-verify.

  Base URL             https://graph.mapillary.com
  Search               GET /images?bbox=<minLon,minLat,maxLon,maxLat>&fields=..&limit=..
  Entity               GET /<image_id>?fields=..
  Auth                 header `Authorization: OAuth <token>` (preferred for entity
                       calls) or `?access_token=<token>`. We always use the header.
  bbox order           "left, bottom, right, top (or minLon, minLat, maxLon, maxLat)"
  bbox size            "The bbox area must be smaller than 0.01 degrees square."
  limit                "the maximum number of image entities to return. Max and
                       default is 2000"
  PAGINATION           "Pagination is currently supported only in combination with
                       creator_username parameter."
  captured_at          Unix timestamp in MILLISECONDS (e.g. 1641206630491)
  geometry             GeoJSON Point, coordinates are [longitude, latitude]
  computed_geometry    GeoJSON Point, "location after running image processing" (SfM)
  Rate limits          Entity API 60,000/min · Search API 10,000/min ·
                       Tile API 50,000/day

THE LOAD-BEARING CONSEQUENCE OF "NO PAGINATION"
-----------------------------------------------
A bbox query returning exactly `limit` rows is *silently truncated* — there is no
cursor to follow and no error. Correct wide-area coverage therefore requires
adaptive subdivision: when a tile comes back at the cap, split it into quadrants
and re-query. `search_images_adaptive` in harvest.py is the only sanctioned way to
enumerate an area. Never call `search_images` on a large bbox and trust the count.

THE SECOND REASON TO SUBDIVIDE, MEASURED 2026-07-31
---------------------------------------------------
A bbox the server considers too data-heavy is rejected outright:

  HTTP 500  {"error":{"code":1,"message":"Please reduce the amount of data
             you're asking for, then retry your request"}}

Measured against downtown Greenwich CT with a valid token:

  bbox -73.6310,41.0150,-73.6220,41.0240 (0.009 deg)  limit=50    -> 500
  same bbox                                            limit=2000  -> 500
  that bbox's south-west quadrant (0.0045 deg)         limit=2000  -> 200, 1938 rows
  bbox -73.6280,41.0180,-73.6260,41.0200 (0.002 deg)  limit=50    -> 200, 46 rows

The rejection tracks the volume of data INSIDE the bbox, not `limit` — lowering
`limit` does not help, and the wording ("reduce the amount of data you're asking
for") describes the box, not the page size. It is therefore a permanent property
of that request: retrying it is guaranteed to fail, and a plain 5xx retry loop
burns its whole budget and collects nothing. `AreaTooDense` exists so callers can
tell this apart from a genuine server error and respond the only way that works —
shrink the box. Real 500s and 429s still retry exactly as before, which is why the
match is on the message text and not on the status alone.

WHY A DIRECT HTTP CLIENT AND NOT mapillary-python-sdk
-----------------------------------------------------
The official SDK is an approved API path, but its documented surface is
point-oriented (`get_image_close_to(longitude, latitude)`) and it exposes neither
the raw result count needed to detect cap-truncation nor a rate-limit hook. Both
are mandatory here. This module talks to the same documented, approved REST
endpoints — which is what Terms §5 permits. It does NOT scrape www.mapillary.com,
does not bypass robots.txt, and issues no request to any undocumented endpoint.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlsplit

import httpx

log = logging.getLogger("harvest.api")

GRAPH_BASE = "https://graph.mapillary.com"

# Documented per-app ceilings. We deliberately never touch the Tile API
# (tiles.mapillary.com, 50,000/day) — it is the real bottleneck for wide-area
# work, and the Search API at 10,000/min gives us everything we need.
SEARCH_LIMIT_PER_MIN = 10_000
ENTITY_LIMIT_PER_MIN = 60_000

# "Max and default is 2000". Hitting this number means truncation, not completion.
SEARCH_RESULT_CAP = 2000

# Per the docs the constraint is phrased "smaller than 0.01 degrees square", which
# is ambiguous between 0.01 deg^2 of area and 0.01 deg per side. We enforce the
# strictest reading — every side strictly under 0.01 deg — which satisfies both.
MAX_BBOX_SIDE_DEG = 0.01

# Fields we request. Kept minimal on purpose: each one has to justify itself
# either to MapillaryRecordSchema or to the best-in-bucket score.
IMAGE_FIELDS: Tuple[str, ...] = (
    "id",
    "geometry",              # raw GPS
    "computed_geometry",     # SfM-refined GPS; strongly preferred when present
    "compass_angle",
    "computed_compass_angle",
    "captured_at",
    "thumb_1024_url",
    "sequence",
    "is_pano",
    "camera_type",
    "quality_score",
)

# TECHNICAL SAFEGUARD (Mapillary Terms §12: commercial users must "implement and
# maintain technical safeguards and business processes that prohibit
# reidentification or unblurring of any Content, including any individual or
# license plate").
#
# `detections` is the one image field that can carry per-object geometry and OCR'd
# text for signs and plates. Requesting it would put plate-adjacent payload inside
# our pipeline, which we refuse structurally rather than by policy. Any attempt to
# add it raises at import-adjacent call time, not in review.
FORBIDDEN_FIELDS = frozenset({"detections"})

# Thumbnails are served from Mapillary/Meta-operated CDNs and are the *blurred*
# renditions. Pinning the host set is how we assert `blurApplied` means something:
# a thumb URL pointing anywhere else is not a Mapillary-blurred rendition and the
# record is dropped. Confirm and tighten this list on the first real run — see
# docs/HARVEST.md "Blur safeguard".
ALLOWED_THUMB_HOST_SUFFIXES: Tuple[str, ...] = (
    "mapillary.com",
    "fbcdn.net",
    "cdninstagram.com",
)

RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504, 408})

# The exact phrase the Graph API returns (inside a 500) when a bbox holds more data
# than it will serve. Matched case-insensitively as a substring so a reworded prefix
# or a changed `code` does not silently turn this back into an infinite retry.
# Deliberately narrow: anything that does NOT contain it stays an ordinary 5xx and
# keeps its retries. Re-verify this string if the error handling ever stops firing —
# a stale match here fails OPEN into the old backoff-forever behaviour.
DENSITY_REJECTION_MARKERS: Tuple[str, ...] = (
    "reduce the amount of data",
)


class MapillaryError(RuntimeError):
    """Non-retryable API failure."""

    def __init__(self, status: int, body: str, url: str) -> None:
        super().__init__("Mapillary API %s for %s: %s" % (status, url, body[:400]))
        self.status = status
        self.body = body
        self.url = url


class AreaTooDense(MapillaryError):
    """The bbox holds more imagery than the API will serve in one response.

    NOT a transport error and NOT retryable: the same request produces the same
    refusal forever, because the cause is how much imagery sits inside the box.
    The only fix is a smaller box, so callers must treat this as a signal to
    subdivide — see `walk_tile` in harvest.py. It subclasses MapillaryError so a
    caller that has not been taught about it still degrades to "tile failed"
    rather than crashing, but any caller that enumerates an area owes it a
    dedicated branch: swallowing this is silent under-collection of exactly the
    densest, most valuable blocks.
    """

    def __init__(
        self,
        status: int,
        body: str,
        url: str,
        bbox_param: Optional[str] = None,
        bbox: Optional["Bbox"] = None,
    ) -> None:
        super().__init__(status, body, url)
        #: The raw `bbox=` query parameter, always available even from `_get`.
        self.bbox_param = bbox_param
        #: The parsed Bbox, attached by `search_images` so callers can subdivide it.
        self.bbox = bbox


class BboxTooLarge(ValueError):
    pass


def is_area_too_dense(status: int, body: str) -> bool:
    """True only for the documented 'reduce the amount of data' 5xx.

    Status alone is not enough — a genuine 500 must keep its retries — so both the
    5xx class and the message text have to match.
    """
    if status < 500:
        return False
    low = (body or "").lower()
    return any(marker in low for marker in DENSITY_REJECTION_MARKERS)


def assert_fields_permitted(fields: Iterable[str]) -> None:
    """Structural refusal of plate/face-adjacent fields. See FORBIDDEN_FIELDS."""
    bad = sorted(set(fields) & FORBIDDEN_FIELDS)
    if bad:
        raise ValueError(
            "refusing to request Mapillary field(s) %s: they can carry OCR'd sign "
            "and plate text. Mapillary Terms §12 requires technical safeguards "
            "against reidentification; Lantage ships no ALPR. See AGENTS.md." % bad
        )


def thumb_host_allowed(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    if not host:
        return False
    return any(host == s or host.endswith("." + s) for s in ALLOWED_THUMB_HOST_SUFFIXES)


def assert_bbox_within_api_limit(bbox: "Bbox") -> None:
    if bbox.width >= MAX_BBOX_SIDE_DEG or bbox.height >= MAX_BBOX_SIDE_DEG:
        raise BboxTooLarge(
            "bbox %s is %.5f x %.5f deg; the documented ceiling is 'smaller than "
            "0.01 degrees square'. Tile the area instead." % (bbox, bbox.width, bbox.height)
        )


@dataclass(frozen=True)
class Bbox:
    """minLon, minLat, maxLon, maxLat — the order the API documents for `bbox`."""

    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float

    def __post_init__(self) -> None:
        if self.min_lon >= self.max_lon or self.min_lat >= self.max_lat:
            raise ValueError("degenerate bbox: %r" % (self,))

    @property
    def width(self) -> float:
        return self.max_lon - self.min_lon

    @property
    def height(self) -> float:
        return self.max_lat - self.min_lat

    @property
    def center(self) -> Tuple[float, float]:
        return ((self.min_lon + self.max_lon) / 2.0, (self.min_lat + self.max_lat) / 2.0)

    def to_param(self) -> str:
        return "%.7f,%.7f,%.7f,%.7f" % (self.min_lon, self.min_lat, self.max_lon, self.max_lat)

    def quadrants(self) -> List["Bbox"]:
        mid_lon, mid_lat = self.center
        return [
            Bbox(self.min_lon, self.min_lat, mid_lon, mid_lat),
            Bbox(mid_lon, self.min_lat, self.max_lon, mid_lat),
            Bbox(self.min_lon, mid_lat, mid_lon, self.max_lat),
            Bbox(mid_lon, mid_lat, self.max_lon, self.max_lat),
        ]

    def contains(self, lon: float, lat: float) -> bool:
        return self.min_lon <= lon <= self.max_lon and self.min_lat <= lat <= self.max_lat

    def __str__(self) -> str:
        return self.to_param()

    @classmethod
    def parse(cls, text: str) -> "Bbox":
        parts = [p.strip() for p in text.split(",")]
        if len(parts) != 4:
            raise ValueError("bbox must be minLon,minLat,maxLon,maxLat — got %r" % text)
        return cls(*(float(p) for p in parts))


class TokenBucket:
    """Async token bucket sized to a documented per-minute Mapillary ceiling.

    Continuous refill rather than fixed windows: a fixed window lets a burst at
    the boundary spend two windows' budget in two seconds, which is exactly the
    shape that trips server-side limiters.
    """

    def __init__(self, per_minute: int, name: str, fraction: float = 0.25) -> None:
        if not 0 < fraction <= 1:
            raise ValueError("fraction must be in (0, 1]")
        self.name = name
        self.documented_per_minute = per_minute
        # Spend a fraction of the documented ceiling by default. Nothing here needs
        # 10k req/min, and headroom means a retry storm cannot exhaust the app quota
        # for every other process using the same token.
        self.capacity = max(1.0, per_minute * fraction)
        self.rate_per_sec = self.capacity / 60.0
        self._tokens = self.capacity
        self._updated = time.monotonic()
        self._lock = asyncio.Lock()
        self.spent = 0

    def _refill(self) -> None:
        now = time.monotonic()
        self._tokens = min(self.capacity, self._tokens + (now - self._updated) * self.rate_per_sec)
        self._updated = now

    async def take(self, n: int = 1) -> None:
        while True:
            async with self._lock:
                self._refill()
                if self._tokens >= n:
                    self._tokens -= n
                    self.spent += n
                    return
                deficit = n - self._tokens
                wait = deficit / self.rate_per_sec
            await asyncio.sleep(min(wait, 5.0))

    @property
    def available(self) -> float:
        self._refill()
        return self._tokens

    def budget_line(self) -> str:
        return "%s %.0f/%.0f tokens (%d spent, ceiling %d/min)" % (
            self.name,
            self.available,
            self.capacity,
            self.spent,
            self.documented_per_minute,
        )


@dataclass
class ClientStats:
    requests: int = 0
    retries: int = 0
    rate_limited: int = 0
    server_errors: int = 0
    #: Counted separately from `server_errors`: these are not failures, they are
    #: subdivide signals, and conflating them would make a healthy dense-metro
    #: harvest look like an unstable API.
    area_too_dense: int = 0
    bytes_in: int = 0
    seconds_waiting_on_backoff: float = 0.0
    per_status: Dict[int, int] = field(default_factory=dict)


class MapillaryClient:
    """Thin, rate-limited, retrying client over the documented v4 endpoints."""

    def __init__(
        self,
        token: str,
        *,
        client: Optional[httpx.AsyncClient] = None,
        rate_fraction: float = 0.25,
        max_attempts: int = 6,
        timeout: float = 60.0,
    ) -> None:
        if not token:
            raise ValueError(
                "no Mapillary access token. Set MAPILLARY_ACCESS_TOKEN — see "
                "docs/HARVEST.md 'Getting a token'."
            )
        self._token = token
        self._owns_client = client is None
        self._http = client or httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            headers={
                # Documented: "Authorization: OAuth XXX (preferred for entity API calls)".
                # Header rather than ?access_token= so tokens stay out of proxy and
                # CDN access logs.
                "Authorization": "OAuth %s" % token,
                "Accept": "application/json",
                "User-Agent": "lantage-harvest/1.0 (+https://github.com/lantage) research index build",
            },
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=32),
            follow_redirects=True,
        )
        self.search_bucket = TokenBucket(SEARCH_LIMIT_PER_MIN, "search", rate_fraction)
        self.entity_bucket = TokenBucket(ENTITY_LIMIT_PER_MIN, "entity", rate_fraction)
        self.max_attempts = max_attempts
        self.stats = ClientStats()

    async def __aenter__(self) -> "MapillaryClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    # -- core ---------------------------------------------------------------

    async def _get(self, url: str, params: Dict[str, Any], bucket: TokenBucket) -> Dict[str, Any]:
        attempt = 0
        while True:
            attempt += 1
            await bucket.take()
            try:
                resp = await self._http.get(url, params=params)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt >= self.max_attempts:
                    raise MapillaryError(0, "transport: %s" % exc, url) from exc
                await self._backoff(attempt, None, "transport %s" % type(exc).__name__)
                continue

            self.stats.requests += 1
            self.stats.per_status[resp.status_code] = self.stats.per_status.get(resp.status_code, 0) + 1

            if resp.status_code == 200:
                self.stats.bytes_in += len(resp.content)
                payload = resp.json()
                if not isinstance(payload, dict):
                    raise MapillaryError(200, "expected JSON object, got %s" % type(payload), url)
                return payload

            # Checked BEFORE the retry branch, and on the first attempt: this 500 is
            # a property of the bbox, so backing off cannot change the answer. Every
            # second spent retrying it is a second not spent on the smaller box that
            # would have worked. Raise immediately and let the caller subdivide.
            if is_area_too_dense(resp.status_code, resp.text):
                self.stats.area_too_dense += 1
                log.info(
                    "area too dense for one response: bbox=%s — caller must subdivide",
                    params.get("bbox"),
                )
                raise AreaTooDense(
                    resp.status_code, resp.text, url, bbox_param=str(params.get("bbox") or "")
                )

            if resp.status_code in RETRYABLE_STATUS and attempt < self.max_attempts:
                if resp.status_code == 429:
                    self.stats.rate_limited += 1
                else:
                    self.stats.server_errors += 1
                await self._backoff(attempt, resp.headers.get("Retry-After"), "HTTP %d" % resp.status_code)
                continue

            # 400/401/403 and exhausted retries: surface it. A 401 here almost
            # always means an expired or wrong-scope token.
            raise MapillaryError(resp.status_code, resp.text, url)

    async def _backoff(self, attempt: int, retry_after: Optional[str], why: str) -> None:
        delay: Optional[float] = None
        if retry_after:
            try:
                delay = float(retry_after)
            except ValueError:
                delay = None
        if delay is None:
            # Exponential with full jitter; jitter matters because every worker
            # trips the same limiter at the same instant otherwise.
            delay = min(60.0, 1.5 * (2 ** (attempt - 1)))
            delay = random.uniform(delay / 2.0, delay)
        self.stats.retries += 1
        self.stats.seconds_waiting_on_backoff += delay
        log.warning("backoff %.1fs (attempt %d) after %s", delay, attempt, why)
        await asyncio.sleep(delay)

    # -- documented endpoints ----------------------------------------------

    async def search_images(
        self,
        bbox: Bbox,
        *,
        fields: Sequence[str] = IMAGE_FIELDS,
        limit: int = SEARCH_RESULT_CAP,
        start_captured_at: Optional[str] = None,
        end_captured_at: Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """GET /images?bbox=... — returns (rows, truncated).

        `truncated` is True when the API returned `limit` rows, meaning there are
        probably more and there is NO cursor to reach them. Callers must subdivide.

        Raises `AreaTooDense` when the server refuses the bbox outright for holding
        too much data. That is the *other* subdivide signal, and it arrives instead
        of rows rather than alongside them.
        """
        assert_fields_permitted(fields)
        assert_bbox_within_api_limit(bbox)
        limit = min(limit, SEARCH_RESULT_CAP)
        params: Dict[str, Any] = {
            "bbox": bbox.to_param(),
            "fields": ",".join(fields),
            "limit": limit,
        }
        if start_captured_at:
            params["start_captured_at"] = start_captured_at
        if end_captured_at:
            params["end_captured_at"] = end_captured_at

        try:
            payload = await self._get("%s/images" % GRAPH_BASE, params, self.search_bucket)
        except AreaTooDense as exc:
            # `_get` only ever sees the serialised parameter. Hand the caller the real
            # Bbox so it can call `.quadrants()` without re-parsing its own request.
            exc.bbox = bbox
            raise
        rows = payload.get("data") or []
        if not isinstance(rows, list):
            raise MapillaryError(200, "expected data[] list, got %s" % type(rows), "/images")
        return rows, len(rows) >= limit

    async def get_image(self, image_id: str, *, fields: Sequence[str] = ("thumb_1024_url",)) -> Dict[str, Any]:
        """GET /<image_id> — used to re-mint expired thumbnail URLs at embed time."""
        assert_fields_permitted(fields)
        payload = await self._get(
            "%s/%s" % (GRAPH_BASE, image_id),
            {"fields": ",".join(fields)},
            self.entity_bucket,
        )
        # The entity API returns the object directly; tolerate a {"data": {...}} wrapper.
        inner = payload.get("data")
        if isinstance(inner, dict):
            return inner
        return payload

    def budget_line(self) -> str:
        return " | ".join([self.search_bucket.budget_line(), self.entity_bucket.budget_line()])
