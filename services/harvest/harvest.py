#!/usr/bin/env python3
"""Mapillary imagery harvest for Lantage — Pittsburgh first.

    python3 services/harvest/harvest.py precheck --metro pittsburgh   # ALWAYS FIRST
    python3 services/harvest/harvest.py run      --metro pittsburgh
    python3 services/harvest/harvest.py stats    --metro pittsburgh
    python3 services/harvest/harvest.py export   --metro pittsburgh --out data/harvest/pgh.ndjson
    python3 services/harvest/harvest.py load     --metro pittsburgh   # -> Postgres

Runbook, expected counts, and the fallback plan: docs/HARVEST.md
Sizing rationale and the three irreversible decisions: docs/MASTER_PLAN.md §3
Output row shape: MapillaryRecordSchema in src/lib/contracts/schemas.ts

Three things about this pipeline that are not obvious
----------------------------------------------------
1. `/images?bbox=` HAS NO PAGINATION (only `creator_username` queries do) and caps
   at 2000 rows. A tile at the cap is silently truncated. Every area walk therefore
   subdivides on truncation — see `walk_tile`. This is the correctness core.

2. Thinning is the point, not an optimisation. Mapillary density follows
   contributor sequences, so raw coverage is 1 m apart along a few popular corridors
   and absent one street over. We bucket by (≈20 m grid cell × heading sector) and
   keep one winner per bucket, which converts clustered donations into the even
   ~200 images/km the sizing table in MASTER_PLAN §3 assumes.

3. Nothing here can undo upstream blur, and it is arranged so it cannot start to.
   `detections` is refused at the field allowlist (mapillary_api.FORBIDDEN_FIELDS),
   thumb URLs are host-pinned to Mapillary/Meta CDNs, and `blurApplied` is asserted
   per record before it is allowed into the store. No OCR of any kind runs here —
   not plate characters, not plate style, not signage.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import os
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from mapillary_api import (  # noqa: E402
    IMAGE_FIELDS,
    SEARCH_RESULT_CAP,
    Bbox,
    MapillaryClient,
    MapillaryError,
    thumb_host_allowed,
)

log = logging.getLogger("harvest")

REPO_ROOT = _HERE.parent.parent
DEFAULT_DATA_DIR = REPO_ROOT / "data" / "harvest"  # gitignored

# ---------------------------------------------------------------------------
# Metros
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Metro:
    slug: str
    name: str
    bbox: Bbox
    #: Centreline street kilometres, used only to project row counts in `precheck`.
    street_km: int
    #: Land area km^2, for reporting density sanity.
    area_km2: int
    note: str = ""


METROS: Dict[str, Metro] = {
    # Pittsburgh city limits. Verified against the city boundary extent; the
    # rectangle necessarily includes river surface and slivers of neighbouring
    # boroughs, which is fine — empty tiles cost one cheap request each.
    "pittsburgh": Metro(
        slug="pittsburgh",
        name="Pittsburgh, PA (city)",
        bbox=Bbox(-80.0958, 40.3617, -79.8657, 40.5011),
        street_km=1600,
        area_km2=151,
        note="Metro #1. ~1,600 km of city streets => ~320k images at practical density.",
    ),
    # Documented fallback if city-proper community coverage turns out thin.
    # Stage it: city -> inner ring -> full county. The full county at 200 img/km is
    # ~1.8M vectors, which is at the ≤2M/metro ceiling in MASTER_PLAN §3, so do not
    # harvest it in one shot without re-reading that section.
    "allegheny": Metro(
        slug="allegheny",
        name="Allegheny County, PA",
        bbox=Bbox(-80.3700, 40.1900, -79.6900, 40.6800),
        street_km=9000,
        area_km2=1891,
        note="FALLBACK ONLY. ~1.8M images at practical density — at the pgvector/metro ceiling.",
    ),
}


# ---------------------------------------------------------------------------
# Harvest parameters
# ---------------------------------------------------------------------------

# Practical density from MASTER_PLAN §3: 20 m spacing x 4 headings = 200 images/km.
# The two knobs below ARE that row of the table. Changing either changes index size
# and cost linearly, so they are fingerprinted into the checkpoint (see Store).
DEFAULT_CELL_METERS = 20.0
DEFAULT_HEADING_SECTORS = 4  # 4 x 90 deg sectors == "4 headings". 8 doubles the index.

# Strictly under the documented "smaller than 0.01 degrees square" ceiling under
# either reading of that phrase. At Pittsburgh's latitude one tile is ~1.00 x 0.76 km.
DEFAULT_TILE_DEG = 0.009

# 0.009 / 2^6 ≈ 0.00014 deg ≈ 15 m. 2000 images inside 15 m is not a real place, so
# a tile still truncating at this depth is a bug or an API change, and we say so
# loudly rather than silently dropping coverage.
MAX_SUBDIVIDE_DEPTH = 6

#: Fixed so `score` is reproducible across runs (a wall-clock normaliser would make
#: yesterday's winners differ from today's for identical inputs).
_RECENCY_NORMALISER_MS = 2_051_222_400_000  # 2035-01-01T00:00:00Z

DISCARD_REASONS = (
    "no_gps",
    "outside_bbox",
    "duplicate_id",
    "pano_excluded",
    "missing_thumb",
    "bad_thumb_host",
    "blur_safeguard_failed",
    "thinned_bucket_loser",
    "max_records_reached",
)


@dataclass
class HarvestParams:
    cell_meters: float = DEFAULT_CELL_METERS
    heading_sectors: int = DEFAULT_HEADING_SECTORS
    include_panos: bool = False
    tile_deg: float = DEFAULT_TILE_DEG
    max_records: Optional[int] = None

    def fingerprint(self, metro: Metro) -> str:
        """Any change to these invalidates existing buckets — checked on resume."""
        return json.dumps(
            {
                "metro": metro.slug,
                "bbox": metro.bbox.to_param(),
                "cell_meters": self.cell_meters,
                "heading_sectors": self.heading_sectors,
                "include_panos": self.include_panos,
                "tile_deg": self.tile_deg,
                "schema": 1,
            },
            sort_keys=True,
        )


# ---------------------------------------------------------------------------
# Grid + thinning maths
# ---------------------------------------------------------------------------


def cell_size_degrees(cell_meters: float, ref_lat: float) -> Tuple[float, float]:
    """Equirectangular cell size at a FIXED reference latitude.

    Fixing the latitude (metro centre) rather than using each point's own latitude
    keeps the grid globally consistent inside a metro, so a record always lands in
    the same cell no matter which tile found it. Over a 15 km north-south span the
    resulting cell-width error is well under a metre — irrelevant at 20 m.
    """
    d_lat = cell_meters / 111_320.0
    d_lon = cell_meters / (111_320.0 * max(0.05, math.cos(math.radians(ref_lat))))
    return d_lat, d_lon


def heading_sector(compass_angle: Optional[float], sectors: int) -> str:
    if compass_angle is None:
        # Kept as its own sector rather than dropped: a heading-less image is still
        # valid coverage, it just cannot be view-matched by heading.
        return "na"
    width = 360.0 / sectors
    return str(int((compass_angle % 360.0) // width) % sectors)


def cell_and_sector(
    lat: float,
    lon: float,
    compass_angle: Optional[float],
    is_pano: bool,
    params: HarvestParams,
    ref_lat: float,
) -> Tuple[str, str]:
    """-> (cell_key, sector). bucket_key is the two joined by ':'."""
    d_lat, d_lon = cell_size_degrees(params.cell_meters, ref_lat)
    cell_key = "%d:%d" % (math.floor(lat / d_lat), math.floor(lon / d_lon))
    # A panorama covers every heading, so it gets one bucket per cell instead of
    # competing per sector. It is excluded from the index by default anyway —
    # EigenPlaces expects perspective frames, and equirect->perspective cropping is
    # B1's call, not ours. See docs/HARVEST.md "Panoramas".
    sector = "pano" if is_pano else heading_sector(compass_angle, params.heading_sectors)
    return cell_key, sector


def best_in_bucket_score(
    *,
    has_computed_geometry: bool,
    quality_score: Optional[float],
    captured_at_ms: Optional[int],
) -> float:
    """Higher wins. Deterministic; ties broken on id by the SQL upsert.

    SfM-refined geometry dominates because an image in the wrong place is worse than
    a slightly older or slightly blurrier image in the right one — the whole index
    is a positional lookup.
    """
    score = 2.0 if has_computed_geometry else 0.0
    if quality_score is not None:
        score += min(max(float(quality_score), 0.0), 1.0)
    if captured_at_ms:
        score += min(max(captured_at_ms / _RECENCY_NORMALISER_MS, 0.0), 1.0)
    return score


def ms_to_iso(ms: Optional[int]) -> Optional[str]:
    """`captured_at` is Unix MILLISECONDS (verified in the API docs)."""
    if not ms:
        return None
    try:
        return (
            datetime.fromtimestamp(int(ms) / 1000.0, tz=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    except (OverflowError, OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Record normalisation + the blur safeguard
# ---------------------------------------------------------------------------


@dataclass
class Candidate:
    """A MapillaryRecordSchema row plus the fields needed to rank it in its bucket."""

    mapillary_id: str
    lat: float
    lon: float
    compass_angle: Optional[float]
    captured_at: Optional[str]
    thumb_url: str
    sequence_id: Optional[str]
    is_pano: bool
    blur_applied: bool
    score: float
    geom_source: str
    quality_score: Optional[float]
    cell_key: str
    sector: str

    @property
    def bucket_key(self) -> str:
        return "%s:%s" % (self.cell_key, self.sector)

    def to_record(self) -> Dict[str, Any]:
        """Exactly MapillaryRecordSchema (src/lib/contracts/schemas.ts)."""
        rec: Dict[str, Any] = {
            "mapillaryId": self.mapillary_id,
            "lat": self.lat,
            "lon": self.lon,
            "compassAngle": self.compass_angle,
            "thumbUrl": self.thumb_url,
            "isPano": self.is_pano,
            "blurApplied": True,  # z.literal(true) — asserted below, never inferred
        }
        if self.captured_at:
            rec["capturedAt"] = self.captured_at
        if self.sequence_id:
            rec["sequenceId"] = self.sequence_id
        return rec


class BlurSafeguardViolation(RuntimeError):
    pass


def assert_blur_safeguards(row: Dict[str, Any], thumb_url: str) -> None:
    """The technical safeguard behind `blurApplied: true`.

    Mapillary Terms §12 requires commercial users to "implement and maintain
    technical safeguards and business processes that prohibit reidentification or
    unblurring of any Content, including any individual or license plate."
    Mapillary blurs faces and plates server-side, so the safeguard we owe is:
    (a) only ever ingest pixels from Mapillary's own CDN renditions, which are the
    blurred ones, and (b) never carry detection/OCR payload alongside them.

    This function is the enforcement point. If it raises, the record is dropped —
    we do not "fix up" and continue.
    """
    if not thumb_url:
        raise BlurSafeguardViolation("missing_thumb")
    if not thumb_host_allowed(thumb_url):
        raise BlurSafeguardViolation(
            "bad_thumb_host: %s is not a known Mapillary/Meta CDN host, so it is not "
            "a verified blurred rendition" % thumb_url.split("/")[2:3]
        )
    if "detections" in row:
        raise BlurSafeguardViolation(
            "blur_safeguard_failed: response carried `detections`, which can hold "
            "OCR'd sign and plate text. Refusing to persist."
        )


def normalise(
    row: Dict[str, Any],
    *,
    bbox: Bbox,
    params: HarvestParams,
    ref_lat: float,
    counters: Dict[str, int],
) -> Optional[Candidate]:
    """Raw API row -> Candidate (carrying its bucket), or None with a counted reason."""

    def drop(reason: str) -> None:
        counters[reason] = counters.get(reason, 0) + 1

    image_id = row.get("id")
    if image_id is None:
        drop("no_gps")
        return None
    image_id = str(image_id)

    # computed_geometry is the SfM-refined position; prefer it. Either way the
    # coordinate order is [longitude, latitude].
    geom = row.get("computed_geometry")
    geom_source = "computed"
    if not isinstance(geom, dict) or not geom.get("coordinates"):
        geom = row.get("geometry")
        geom_source = "raw"
    if not isinstance(geom, dict):
        drop("no_gps")
        return None
    coords = geom.get("coordinates")
    if not isinstance(coords, (list, tuple)) or len(coords) < 2:
        drop("no_gps")
        return None
    try:
        lon = float(coords[0])
        lat = float(coords[1])
    except (TypeError, ValueError):
        drop("no_gps")
        return None
    if not (math.isfinite(lat) and math.isfinite(lon)) or (lat == 0.0 and lon == 0.0):
        drop("no_gps")
        return None
    if not bbox.contains(lon, lat):
        # Subdivided tiles overlap on shared edges; also SfM can nudge a point out
        # of the tile that returned it. Clip to the metro bbox, not the tile.
        drop("outside_bbox")
        return None

    is_pano = bool(row.get("is_pano", False))
    if is_pano and not params.include_panos:
        drop("pano_excluded")
        return None

    angle = row.get("computed_compass_angle")
    if angle is None:
        angle = row.get("compass_angle")
    compass: Optional[float] = None
    if angle is not None:
        try:
            compass = float(angle) % 360.0
        except (TypeError, ValueError):
            compass = None

    thumb_url = row.get("thumb_1024_url") or ""
    try:
        assert_blur_safeguards(row, thumb_url)
    except BlurSafeguardViolation as exc:
        reason = str(exc).split(":", 1)[0]
        drop(reason if reason in DISCARD_REASONS else "blur_safeguard_failed")
        return None

    captured_ms = row.get("captured_at")
    try:
        captured_ms_int: Optional[int] = int(captured_ms) if captured_ms else None
    except (TypeError, ValueError):
        captured_ms_int = None

    quality = row.get("quality_score")
    try:
        quality_f: Optional[float] = float(quality) if quality is not None else None
    except (TypeError, ValueError):
        quality_f = None

    cell_key, sector = cell_and_sector(lat, lon, compass, is_pano, params, ref_lat)
    return Candidate(
        mapillary_id=image_id,
        lat=lat,
        lon=lon,
        compass_angle=compass,
        captured_at=ms_to_iso(captured_ms_int),
        thumb_url=thumb_url,
        sequence_id=str(row["sequence"]) if row.get("sequence") else None,
        is_pano=is_pano,
        blur_applied=True,
        score=best_in_bucket_score(
            has_computed_geometry=(geom_source == "computed"),
            quality_score=quality_f,
            captured_at_ms=captured_ms_int,
        ),
        geom_source=geom_source,
        quality_score=quality_f,
        cell_key=cell_key,
        sector=sector,
    )


# ---------------------------------------------------------------------------
# Checkpoint store (SQLite — stdlib, so resume needs no services running)
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Only COMPLETED tiles are recorded. A parent is written after all four children
-- finish, so an interrupted subtree simply re-descends and its done children are
-- skipped. That is what makes resume both correct and cheap.
CREATE TABLE IF NOT EXISTS tiles (
  key         TEXT PRIMARY KEY,
  depth       INTEGER NOT NULL,
  raw         INTEGER NOT NULL,
  truncated   INTEGER NOT NULL,
  is_leaf     INTEGER NOT NULL,
  finished_at TEXT NOT NULL
);

-- Every id ever considered. Gives idempotent dedupe across overlapping tiles and
-- across runs, and stops a re-descent from re-ranking a candidate that already lost.
CREATE TABLE IF NOT EXISTS seen (mapillary_id TEXT PRIMARY KEY);

-- Bucket winners == the index. One row per (cell x heading sector).
CREATE TABLE IF NOT EXISTS records (
  bucket_key    TEXT PRIMARY KEY,
  cell_key      TEXT NOT NULL,
  sector        TEXT NOT NULL,
  mapillary_id  TEXT NOT NULL UNIQUE,
  lat           REAL NOT NULL,
  lon           REAL NOT NULL,
  compass_angle REAL,
  captured_at   TEXT,
  thumb_url     TEXT NOT NULL,
  sequence_id   TEXT,
  is_pano       INTEGER NOT NULL,
  blur_applied  INTEGER NOT NULL CHECK (blur_applied = 1),
  score         REAL NOT NULL,
  geom_source   TEXT NOT NULL,
  quality_score REAL,
  embedded_at   TEXT,
  embed_model   TEXT,
  embed_dim     INTEGER
);
CREATE INDEX IF NOT EXISTS records_unembedded ON records (embedded_at) WHERE embedded_at IS NULL;
CREATE INDEX IF NOT EXISTS records_cell ON records (cell_key);

CREATE TABLE IF NOT EXISTS discards (reason TEXT PRIMARY KEY, n INTEGER NOT NULL);
"""


class ParamsChanged(RuntimeError):
    pass


class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        # WAL + NORMAL: a kill -9 mid-harvest loses at most the last transaction,
        # and every transaction is one tile.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(_SCHEMA)
        self.db.commit()

    def close(self) -> None:
        self.db.commit()
        self.db.close()

    # -- meta ---------------------------------------------------------------

    def get_meta(self, key: str) -> Optional[str]:
        row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def bind_params(self, fingerprint: str) -> None:
        """Refuse to resume into a store built with different bucketing."""
        existing = self.get_meta("params")
        if existing is None:
            self.set_meta("params", fingerprint)
            self.db.commit()
            return
        if existing != fingerprint:
            raise ParamsChanged(
                "checkpoint at %s was built with different harvest parameters.\n"
                "  stored: %s\n  now:    %s\n"
                "Bucket keys are derived from these, so resuming would mix two grids. "
                "Use a fresh --db path, or pass --reset." % (self.path, existing, fingerprint)
            )

    # -- tiles --------------------------------------------------------------

    def tile_done(self, key: str) -> bool:
        return (
            self.db.execute("SELECT 1 FROM tiles WHERE key = ?", (key,)).fetchone() is not None
        )

    def mark_tile(self, key: str, depth: int, raw: int, truncated: bool, is_leaf: bool) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO tiles(key, depth, raw, truncated, is_leaf, finished_at) "
            "VALUES(?, ?, ?, ?, ?, ?)",
            (
                key,
                depth,
                raw,
                1 if truncated else 0,
                1 if is_leaf else 0,
                datetime.now(timezone.utc).isoformat(),
            ),
        )

    # -- candidates ---------------------------------------------------------

    def offer(self, cand: Candidate) -> str:
        """Insert-or-win. Returns 'kept' | 'replaced' | 'duplicate_id' | 'thinned_bucket_loser'.

        The whole idempotency story lives here: `seen` makes a re-read of the same
        tile a no-op, and the conditional upsert makes bucket selection independent
        of the order tiles happen to complete in.
        """
        bucket = cand.bucket_key
        cur = self.db.execute(
            "INSERT OR IGNORE INTO seen(mapillary_id) VALUES(?)", (cand.mapillary_id,)
        )
        if cur.rowcount == 0:
            return "duplicate_id"

        existing = self.db.execute(
            "SELECT mapillary_id, score FROM records WHERE bucket_key = ?", (bucket,)
        ).fetchone()
        if existing is None:
            self.db.execute(
                "INSERT INTO records(bucket_key, cell_key, sector, mapillary_id, lat, lon, "
                "compass_angle, captured_at, thumb_url, sequence_id, is_pano, blur_applied, "
                "score, geom_source, quality_score) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
                (
                    bucket,
                    cand.cell_key,
                    cand.sector,
                    cand.mapillary_id,
                    cand.lat,
                    cand.lon,
                    cand.compass_angle,
                    cand.captured_at,
                    cand.thumb_url,
                    cand.sequence_id,
                    1 if cand.is_pano else 0,
                    cand.score,
                    cand.geom_source,
                    cand.quality_score,
                ),
            )
            return "kept"

        # Total order: score, then id ascending. Deterministic regardless of arrival.
        wins = cand.score > existing["score"] or (
            cand.score == existing["score"] and cand.mapillary_id < existing["mapillary_id"]
        )
        if not wins:
            return "thinned_bucket_loser"

        self.db.execute(
            "UPDATE records SET mapillary_id=?, lat=?, lon=?, compass_angle=?, captured_at=?, "
            "thumb_url=?, sequence_id=?, is_pano=?, score=?, geom_source=?, quality_score=?, "
            "embedded_at=NULL, embed_model=NULL, embed_dim=NULL WHERE bucket_key=?",
            (
                cand.mapillary_id,
                cand.lat,
                cand.lon,
                cand.compass_angle,
                cand.captured_at,
                cand.thumb_url,
                cand.sequence_id,
                1 if cand.is_pano else 0,
                cand.score,
                cand.geom_source,
                cand.quality_score,
                bucket,
            ),
        )
        return "replaced"

    def bump_discards(self, counters: Dict[str, int]) -> None:
        for reason, n in counters.items():
            if not n:
                continue
            self.db.execute(
                "INSERT INTO discards(reason, n) VALUES(?, ?) "
                "ON CONFLICT(reason) DO UPDATE SET n = n + excluded.n",
                (reason, n),
            )

    # -- reads --------------------------------------------------------------

    def kept_count(self) -> int:
        return int(self.db.execute("SELECT COUNT(*) AS c FROM records").fetchone()["c"])

    def seen_count(self) -> int:
        return int(self.db.execute("SELECT COUNT(*) AS c FROM seen").fetchone()["c"])

    def tiles_done_count(self) -> int:
        return int(
            self.db.execute("SELECT COUNT(*) AS c FROM tiles WHERE is_leaf = 1").fetchone()["c"]
        )

    def discard_counts(self) -> Dict[str, int]:
        return {r["reason"]: r["n"] for r in self.db.execute("SELECT reason, n FROM discards")}

    def iter_records(self, only_unembedded: bool = False) -> Iterator[sqlite3.Row]:
        sql = "SELECT * FROM records"
        if only_unembedded:
            sql += " WHERE embedded_at IS NULL"
        sql += " ORDER BY bucket_key"
        return self.db.execute(sql)


# ---------------------------------------------------------------------------
# Progress reporting
# ---------------------------------------------------------------------------


def emit(event: str, **fields: Any) -> None:
    """One JSON object per line on stderr. Greppable, and safe to pipe to a log sink."""
    payload = {"ts": datetime.now(timezone.utc).isoformat(), "event": event}
    payload.update(fields)
    sys.stderr.write(json.dumps(payload, default=str) + "\n")
    sys.stderr.flush()


@dataclass
class Progress:
    total_root_tiles: int
    started: float = field(default_factory=time.monotonic)
    leaf_tiles: int = 0
    root_tiles: int = 0
    raw_seen: int = 0
    kept: int = 0
    replaced: int = 0
    discards: Dict[str, int] = field(default_factory=dict)

    def add_discards(self, counters: Dict[str, int]) -> None:
        for k, v in counters.items():
            self.discards[k] = self.discards.get(k, 0) + v

    @property
    def elapsed(self) -> float:
        return max(1e-6, time.monotonic() - self.started)

    def eta_seconds(self) -> Optional[float]:
        if self.root_tiles <= 0:
            return None
        per_tile = self.elapsed / self.root_tiles
        return per_tile * max(0, self.total_root_tiles - self.root_tiles)

    def snapshot(self, budget: str) -> Dict[str, Any]:
        eta = self.eta_seconds()
        return {
            "root_tiles": "%d/%d" % (self.root_tiles, self.total_root_tiles),
            "leaf_tiles": self.leaf_tiles,
            "raw_seen": self.raw_seen,
            "kept": self.kept,
            "replaced": self.replaced,
            "discarded": sum(self.discards.values()),
            "discards": dict(sorted(self.discards.items())),
            "images_per_sec": round(self.raw_seen / self.elapsed, 1),
            "tiles_per_sec": round(self.root_tiles / self.elapsed, 2),
            "elapsed_s": round(self.elapsed),
            "eta_s": None if eta is None else round(eta),
            "rate_budget": budget,
        }


# ---------------------------------------------------------------------------
# The walk
# ---------------------------------------------------------------------------


def grid(bbox: Bbox, tile_deg: float) -> List[Bbox]:
    """Row-major tiles covering bbox. The last row/column is clipped, not extended."""
    out: List[Bbox] = []
    n_lat = max(1, int(math.ceil(bbox.height / tile_deg)))
    n_lon = max(1, int(math.ceil(bbox.width / tile_deg)))
    for i in range(n_lat):
        lo_lat = bbox.min_lat + i * tile_deg
        hi_lat = min(bbox.max_lat, lo_lat + tile_deg)
        if hi_lat - lo_lat < 1e-9:
            continue
        for j in range(n_lon):
            lo_lon = bbox.min_lon + j * tile_deg
            hi_lon = min(bbox.max_lon, lo_lon + tile_deg)
            if hi_lon - lo_lon < 1e-9:
                continue
            out.append(Bbox(lo_lon, lo_lat, hi_lon, hi_lat))
    return out


class Harvester:
    def __init__(
        self,
        client: MapillaryClient,
        store: Store,
        metro: Metro,
        params: HarvestParams,
        *,
        concurrency: int = 8,
        progress_every: int = 10,
    ) -> None:
        self.client = client
        self.store = store
        self.metro = metro
        self.params = params
        self.ref_lat = metro.bbox.center[1]
        self.sem = asyncio.Semaphore(concurrency)
        self.db_lock = asyncio.Lock()
        self.progress_every = progress_every
        self.progress = Progress(total_root_tiles=0)
        self.stop = False

    async def walk_tile(self, tile: Bbox, depth: int = 0) -> None:
        """Fetch a tile; subdivide on cap-truncation.

        Truncation detection is the whole reason this is recursive. `/images?bbox=`
        returns at most 2000 rows with no cursor, so `len(rows) == limit` is
        indistinguishable from "there are 40,000 here" — except by shrinking the box.
        """
        key = tile.to_param()
        if self.stop or self.store.tile_done(key):
            return

        async with self.sem:
            try:
                rows, truncated = await self.client.search_images(tile, fields=IMAGE_FIELDS)
            except MapillaryError as exc:
                # Leave the tile unmarked so the next run retries exactly this box.
                emit("tile_failed", tile=key, depth=depth, status=exc.status, error=str(exc))
                return

        if truncated and depth < MAX_SUBDIVIDE_DEPTH:
            emit("tile_truncated", tile=key, depth=depth, rows=len(rows), action="subdivide")
            for quad in tile.quadrants():
                await self.walk_tile(quad, depth + 1)
            async with self.db_lock:
                self.store.mark_tile(key, depth, len(rows), True, is_leaf=False)
                self.store.db.commit()
            return

        if truncated:
            # 2000 images inside ~15 m. Either the API changed or something is wrong;
            # coverage in this box is incomplete and we must not pretend otherwise.
            emit(
                "tile_truncated_at_max_depth",
                tile=key,
                depth=depth,
                rows=len(rows),
                severity="error",
                note="coverage here is INCOMPLETE — investigate before trusting the index",
            )

        counters: Dict[str, int] = {}
        kept = replaced = 0
        for row in rows:
            if self.params.max_records is not None:
                async with self.db_lock:
                    if self.store.kept_count() >= self.params.max_records:
                        counters["max_records_reached"] = counters.get("max_records_reached", 0) + 1
                        self.stop = True
                        break
            cand = normalise(
                row,
                bbox=self.metro.bbox,
                params=self.params,
                ref_lat=self.ref_lat,
                counters=counters,
            )
            if cand is None:
                continue
            async with self.db_lock:
                outcome = self.store.offer(cand)
            if outcome == "kept":
                kept += 1
            elif outcome == "replaced":
                replaced += 1
            else:
                counters[outcome] = counters.get(outcome, 0) + 1

        async with self.db_lock:
            self.store.bump_discards(counters)
            self.store.mark_tile(key, depth, len(rows), truncated, is_leaf=True)
            self.store.db.commit()

        self.progress.leaf_tiles += 1
        self.progress.raw_seen += len(rows)
        self.progress.kept += kept
        self.progress.replaced += replaced
        self.progress.add_discards(counters)

    async def run(self, tiles: Sequence[Bbox]) -> None:
        self.progress = Progress(total_root_tiles=len(tiles))
        emit(
            "harvest_start",
            metro=self.metro.slug,
            bbox=self.metro.bbox.to_param(),
            root_tiles=len(tiles),
            tile_deg=self.params.tile_deg,
            cell_meters=self.params.cell_meters,
            heading_sectors=self.params.heading_sectors,
            include_panos=self.params.include_panos,
            resumed_kept=self.store.kept_count(),
            resumed_tiles=self.store.tiles_done_count(),
        )
        for idx, tile in enumerate(tiles, 1):
            if self.stop:
                emit("harvest_stopped_early", reason="max_records", at_tile=idx)
                break
            await self.walk_tile(tile)
            self.progress.root_tiles = idx
            if idx % self.progress_every == 0 or idx == len(tiles):
                emit("progress", **self.progress.snapshot(self.client.budget_line()))
        emit(
            "harvest_done",
            kept_total=self.store.kept_count(),
            considered_total=self.store.seen_count(),
            leaf_tiles_total=self.store.tiles_done_count(),
            discards=self.store.discard_counts(),
            api_requests=self.client.stats.requests,
            api_retries=self.client.stats.retries,
            api_rate_limited=self.client.stats.rate_limited,
            api_mb_in=round(self.client.stats.bytes_in / 1e6, 1),
        )


# ---------------------------------------------------------------------------
# Coverage pre-check — run this BEFORE committing to a harvest
# ---------------------------------------------------------------------------


def sample_tiles(bbox: Bbox, tile_deg: float, n: int) -> List[Bbox]:
    """Deterministic stratified sample: every k-th tile in row-major order.

    A fixed stride rather than random sampling so two pre-checks on the same metro
    are comparable, and so the sample is spread across the whole bbox instead of
    clumping the way small random samples do.
    """
    all_tiles = grid(bbox, tile_deg)
    if n >= len(all_tiles):
        return all_tiles
    stride = len(all_tiles) / float(n)
    return [all_tiles[min(len(all_tiles) - 1, int(i * stride))] for i in range(n)]


async def precheck(
    client: MapillaryClient, metro: Metro, params: HarvestParams, samples: int
) -> Dict[str, Any]:
    """Measure real Mapillary density before spending hours on a full harvest.

    Community coverage is uneven and city-proper can be thin. This costs ~40
    requests and answers the only question that matters up front: is there enough
    imagery here to build an index worth querying?
    """
    tiles = sample_tiles(metro.bbox, params.tile_deg, samples)
    total_tiles = len(grid(metro.bbox, params.tile_deg))
    ref_lat = metro.bbox.center[1]

    per_tile: List[Dict[str, Any]] = []
    years: Dict[str, int] = {}
    counters: Dict[str, int] = {}
    buckets_seen: Dict[str, float] = {}
    seen_ids = set()
    raw_total = 0
    pano_total = 0
    truncated_tiles = 0

    emit("precheck_start", metro=metro.slug, sampled_tiles=len(tiles), total_tiles=total_tiles)

    for i, tile in enumerate(tiles, 1):
        try:
            rows, truncated = await client.search_images(tile, fields=IMAGE_FIELDS)
        except MapillaryError as exc:
            emit("precheck_tile_failed", tile=tile.to_param(), status=exc.status, error=str(exc))
            continue
        raw_total += len(rows)
        if truncated:
            truncated_tiles += 1
        kept_here = 0
        for row in rows:
            if row.get("is_pano"):
                pano_total += 1
            iso = ms_to_iso(row.get("captured_at"))
            if iso:
                years[iso[:4]] = years.get(iso[:4], 0) + 1
            cand = normalise(
                row, bbox=metro.bbox, params=params, ref_lat=ref_lat, counters=counters
            )
            if cand is None:
                continue
            if cand.mapillary_id in seen_ids:
                continue
            seen_ids.add(cand.mapillary_id)
            prev = buckets_seen.get(cand.bucket_key)
            if prev is None:
                buckets_seen[cand.bucket_key] = cand.score
                kept_here += 1
            elif cand.score > prev:
                buckets_seen[cand.bucket_key] = cand.score
        per_tile.append(
            {
                "tile": tile.to_param(),
                "raw": len(rows),
                "kept": kept_here,
                "truncated": truncated,
            }
        )
        if i % 10 == 0:
            emit("precheck_progress", sampled="%d/%d" % (i, len(tiles)), raw_total=raw_total)

    n = max(1, len(per_tile))
    nonempty = [t for t in per_tile if t["raw"] > 0]
    kept_total = len(buckets_seen)
    mean_raw = raw_total / float(n)
    mean_kept = kept_total / float(n)
    coverage_fraction = len(nonempty) / float(n)

    projected_raw = int(round(mean_raw * total_tiles))
    projected_kept = int(round(mean_kept * total_tiles))
    # Independent cross-check from the sizing table: street_km x 200 images/km.
    sizing_target = int(metro.street_km * 50 * params.heading_sectors)

    median_year = None
    if years:
        ordered = sorted(years.items())
        cum, half = 0, sum(years.values()) / 2.0
        for y, c in ordered:
            cum += c
            if cum >= half:
                median_year = int(y)
                break

    warnings: List[str] = []
    if truncated_tiles:
        warnings.append(
            "%d/%d sampled tiles hit the 2000-row cap, so raw counts are LOWER BOUNDS. "
            "The real harvest subdivides these; projected_raw is understated."
            % (truncated_tiles, n)
        )
    if coverage_fraction < 0.5:
        warnings.append(
            "only %.0f%% of sampled tiles contain any imagery — coverage is patchy. "
            "Expect holes in the index and consider widening the bbox." % (coverage_fraction * 100)
        )
    if median_year is not None and median_year < 2019:
        warnings.append(
            "median capture year is %d. Stale imagery degrades VPR recall as streetscapes "
            "change; consider start_captured_at to bias newer, at the cost of coverage."
            % median_year
        )
    if projected_kept < 100_000:
        warnings.append(
            "projected %d indexable images is below the ~100k floor for a usable metro "
            "index. FALLBACK: widen to Allegheny County (--metro allegheny), staged "
            "city -> inner ring -> county." % projected_kept
        )

    if projected_kept >= 100_000 and coverage_fraction >= 0.5:
        verdict = "GO"
    elif projected_kept >= 50_000:
        verdict = "GO-WITH-CAVEATS"
    else:
        verdict = "NO-GO — widen the bbox"

    report = {
        "metro": metro.name,
        "bbox": metro.bbox.to_param(),
        "verdict": verdict,
        "sampled_tiles": n,
        "total_tiles": total_tiles,
        "tiles_with_imagery": len(nonempty),
        "coverage_fraction": round(coverage_fraction, 3),
        "truncated_tiles": truncated_tiles,
        "raw_images_sampled": raw_total,
        "mean_raw_per_tile": round(mean_raw, 1),
        "mean_kept_per_tile": round(mean_kept, 1),
        "thinning_ratio": round(kept_total / float(raw_total), 3) if raw_total else None,
        "pano_share": round(pano_total / float(raw_total), 3) if raw_total else None,
        "projected_raw_images": projected_raw,
        "projected_indexable_images": projected_kept,
        "sizing_table_target": sizing_target,
        "median_capture_year": median_year,
        "capture_year_histogram": dict(sorted(years.items())),
        "discards_in_sample": dict(sorted(counters.items())),
        "warnings": warnings,
        "api_requests": client.stats.requests,
        "per_tile": per_tile,
    }
    emit("precheck_done", verdict=verdict, projected_indexable_images=projected_kept)
    return report


def print_precheck(report: Dict[str, Any]) -> None:
    w = sys.stdout.write
    w("\n%s\n" % ("=" * 74))
    w("Mapillary coverage pre-check — %s\n" % report["metro"])
    w("%s\n" % ("=" * 74))
    w("bbox                     %s\n" % report["bbox"])
    w("tiles sampled            %d of %d\n" % (report["sampled_tiles"], report["total_tiles"]))
    w(
        "tiles with imagery       %d (%.0f%%)\n"
        % (report["tiles_with_imagery"], report["coverage_fraction"] * 100)
    )
    w("raw images in sample     %d (mean %.1f/tile)\n" % (report["raw_images_sampled"], report["mean_raw_per_tile"]))
    w("cap-truncated tiles      %d\n" % report["truncated_tiles"])
    w("thinning keeps           %s of raw\n" % _pct(report["thinning_ratio"]))
    w("panorama share           %s\n" % _pct(report["pano_share"]))
    w("median capture year      %s\n" % report["median_capture_year"])
    w("\nPROJECTED FOR FULL BBOX\n")
    w("  raw images             %s\n" % f"{report['projected_raw_images']:,}")
    w("  indexable after thin   %s\n" % f"{report['projected_indexable_images']:,}")
    w("  sizing-table target    %s  (street_km x 200/km, MASTER_PLAN §3)\n" % f"{report['sizing_table_target']:,}")
    if report["discards_in_sample"]:
        w("\ndiscards in sample\n")
        for k, v in report["discards_in_sample"].items():
            w("  %-24s %d\n" % (k, v))
    if report["warnings"]:
        w("\nWARNINGS\n")
        for msg in report["warnings"]:
            w("  ! %s\n" % msg)
    w("\nVERDICT: %s\n" % report["verdict"])
    w("%s\n\n" % ("=" * 74))


def _pct(v: Optional[float]) -> str:
    return "n/a" if v is None else "%.1f%%" % (v * 100)


# ---------------------------------------------------------------------------
# Export / load / stats
# ---------------------------------------------------------------------------

#: Contract field -> acceptable Postgres column names, most-preferred first.
#: `load` introspects information_schema and maps onto whatever actually shipped
#: rather than hardcoding a guess. Required fields missing => loud failure.
#: Verified against supabase/migrations/20260729180500_reference_data.sql (A2).
COLUMN_ALIASES: Dict[str, Tuple[str, ...]] = {
    "mapillaryId": ("mapillary_id", "mapillaryid", "id"),
    "lat": ("lat", "latitude"),
    "lon": ("lon", "lng", "longitude"),
    "compassAngle": ("compass_angle", "compassangle", "heading"),
    "capturedAt": ("captured_at", "capturedat"),
    "thumbUrl": ("thumb_url", "thumburl", "thumb_1024_url"),
    "sequenceId": ("sequence_id", "sequenceid", "sequence"),
    "isPano": ("is_pano", "ispano"),
    "blurApplied": ("blur_applied", "blurapplied"),
}
REQUIRED_CONTRACT_FIELDS = ("mapillaryId", "lat", "lon", "thumbUrl", "blurApplied")
DEFAULT_TARGET_TABLE = "mapillary_images"

#: Columns A2's table declares NOT NULL with no default, which are harvest-run
#: properties rather than per-image ones, so they are not in MapillaryRecordSchema:
#:   metro       — the submap key retrieval prunes on before the ANN order-by
#:   index_build — e.g. 'mapillary-pittsburgh@2026-07-29'. Copied into every
#:                 ResultProvenance.indexBuild so a result maps to the exact index
#:                 that produced it. Reproducibility is a Daubert requirement, so
#:                 this is pinned in the checkpoint at first run and reused on every
#:                 resume — a resumed harvest must not split across two build tags.
RUN_SCOPED_COLUMNS = ("metro", "index_build")


def default_index_build(metro: Metro) -> str:
    return "mapillary-%s@%s" % (metro.slug, datetime.now(timezone.utc).date().isoformat())


def pinned_index_build(store: "Store", metro: Metro, override: Optional[str] = None) -> str:
    """Read the run's build tag from the checkpoint, minting it once on first use."""
    if override:
        store.set_meta("index_build", override)
        store.db.commit()
        return override
    existing = store.get_meta("index_build")
    if existing:
        return existing
    tag = default_index_build(metro)
    store.set_meta("index_build", tag)
    store.db.commit()
    return tag


def row_to_record(row: sqlite3.Row, with_provenance: bool = False) -> Dict[str, Any]:
    rec: Dict[str, Any] = {
        "mapillaryId": row["mapillary_id"],
        "lat": row["lat"],
        "lon": row["lon"],
        "compassAngle": row["compass_angle"],
        "thumbUrl": row["thumb_url"],
        "isPano": bool(row["is_pano"]),
        "blurApplied": True,
    }
    if row["captured_at"]:
        rec["capturedAt"] = row["captured_at"]
    if row["sequence_id"]:
        rec["sequenceId"] = row["sequence_id"]
    if with_provenance:
        rec["_bucketKey"] = row["bucket_key"]
        rec["_cellKey"] = row["cell_key"]
        rec["_sector"] = row["sector"]
        rec["_score"] = row["score"]
        rec["_geomSource"] = row["geom_source"]
    return rec


def cmd_export(store: Store, out_path: Path, with_provenance: bool) -> int:
    """Newline-delimited MapillaryRecordSchema rows. Loader: docs/HARVEST.md."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out_path.open("w", encoding="utf-8") as fh:
        for row in store.iter_records():
            if row["blur_applied"] != 1:
                raise RuntimeError(
                    "record %s has blur_applied != 1 — refusing to export. This should "
                    "be unreachable (CHECK constraint)." % row["mapillary_id"]
                )
            fh.write(json.dumps(row_to_record(row, with_provenance), separators=(",", ":")) + "\n")
            n += 1
    emit("export_done", path=str(out_path), rows=n)
    return n


def cmd_stats(store: Store, metro: Metro, params: HarvestParams) -> None:
    kept = store.kept_count()
    discards = store.discard_counts()
    tiles = store.tiles_done_count()
    total_tiles = len(grid(metro.bbox, params.tile_deg))
    embedded = int(
        store.db.execute(
            "SELECT COUNT(*) AS c FROM records WHERE embedded_at IS NOT NULL"
        ).fetchone()["c"]
    )
    pano = int(
        store.db.execute("SELECT COUNT(*) AS c FROM records WHERE is_pano = 1").fetchone()["c"]
    )
    computed = int(
        store.db.execute(
            "SELECT COUNT(*) AS c FROM records WHERE geom_source = 'computed'"
        ).fetchone()["c"]
    )
    w = sys.stdout.write
    w("\n%s — harvest state\n" % metro.name)
    w("  db                     %s\n" % store.path)
    w("  index_build            %s\n" % (store.get_meta("index_build") or "(not pinned yet)"))
    w("  leaf tiles complete    %d (root grid %d)\n" % (tiles, total_tiles))
    w("  indexable records      %s\n" % f"{kept:,}")
    w("    with SfM geometry    %s (%s)\n" % (f"{computed:,}", _pct(computed / kept if kept else None)))
    w("    panoramas            %s\n" % f"{pano:,}")
    w("  embedded               %s (%s)\n" % (f"{embedded:,}", _pct(embedded / kept if kept else None)))
    w("  ids considered         %s\n" % f"{store.seen_count():,}")
    if discards:
        w("  discarded\n")
        for k, v in sorted(discards.items()):
            w("    %-22s %s\n" % (k, f"{v:,}"))
    # Coverage sanity against the sizing table rather than a bare row count: an
    # index can look large and still be four dense corridors.
    density = kept / float(metro.street_km) if metro.street_km else 0.0
    w(
        "  density                %.0f images/km of street (practical target %d)\n"
        % (density, 50 * params.heading_sectors)
    )
    cells = int(
        store.db.execute("SELECT COUNT(DISTINCT cell_key) AS c FROM records").fetchone()["c"]
    )
    w("  distinct grid cells    %s (mean %.2f headings/cell)\n" % (f"{cells:,}", kept / cells if cells else 0))
    w("\n")


def cmd_load(
    store: Store, table: str, dsn: str, batch: int, metro: Metro, index_build: str
) -> int:
    """Upsert into Postgres. Idempotent: ON CONFLICT DO NOTHING on the id column."""
    try:
        import psycopg  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise SystemExit(
            "psycopg is required for `load`. pip install -r services/harvest/requirements.txt\n"
            "Or use `export` + the NDJSON loader documented in docs/HARVEST.md."
        ) from exc

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = %s ORDER BY ordinal_position",
                (table,),
            )
            actual = [r[0] for r in cur.fetchall()]
            if not actual:
                raise SystemExit(
                    "table %r does not exist. A2 owns supabase/migrations — apply the "
                    "migration that creates it, or use `export` and load the NDJSON "
                    "later (docs/HARVEST.md)." % table
                )

            actual_set = set(actual)
            mapping: List[Tuple[str, str]] = []  # (contract field, column)
            for field_name, candidates in COLUMN_ALIASES.items():
                col = next((c for c in candidates if c in actual_set), None)
                if col:
                    mapping.append((field_name, col))
                elif field_name in REQUIRED_CONTRACT_FIELDS:
                    raise SystemExit(
                        "table %r has no column for required contract field %r "
                        "(looked for %s). Columns present: %s"
                        % (table, field_name, list(candidates), actual)
                    )
                else:
                    log.warning("no column for optional field %s — skipping it", field_name)

            id_col = dict(mapping)["mapillaryId"]

            # `metro` and `index_build` are NOT NULL with no default in A2's table and
            # are constant for the whole run, so they ride along as literals rather
            # than as per-record fields.
            run_values: List[Tuple[str, Any]] = []
            for col, value in (("metro", metro.slug), ("index_build", index_build)):
                if col in actual_set:
                    run_values.append((col, value))
                elif col in RUN_SCOPED_COLUMNS:
                    log.warning("table %r has no %r column — skipping it", table, col)

            cols = [c for _, c in mapping] + [c for c, _ in run_values]
            emit(
                "load_start",
                table=table,
                columns=cols,
                conflict_target=id_col,
                metro=metro.slug,
                index_build=index_build,
            )

            insert = "INSERT INTO %s (%s) VALUES (%s) ON CONFLICT (%s) DO NOTHING" % (
                table,
                ", ".join(cols),
                ", ".join(["%s"] * len(cols)),
                id_col,
            )
            run_tail = tuple(v for _, v in run_values)

            total = 0
            pending: List[Tuple[Any, ...]] = []
            for row in store.iter_records():
                rec = row_to_record(row)
                pending.append(tuple(rec.get(f) for f, _ in mapping) + run_tail)
                if len(pending) >= batch:
                    cur.executemany(insert, pending)
                    total += len(pending)
                    pending = []
                    conn.commit()
                    emit("load_progress", rows=total)
            if pending:
                cur.executemany(insert, pending)
                total += len(pending)
            conn.commit()
    emit("load_done", table=table, rows_offered=total)
    return total


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def resolve_metro(args: argparse.Namespace) -> Metro:
    if getattr(args, "bbox", None):
        bbox = Bbox.parse(args.bbox)
        # Rough street-km guess from area so `precheck` can still cross-check against
        # the sizing table for an ad-hoc box: dense US urban ≈ 11 km of street per km².
        area = bbox.width * 111.32 * math.cos(math.radians(bbox.center[1])) * bbox.height * 111.32
        return Metro(
            slug=getattr(args, "slug", None) or "adhoc",
            name="ad-hoc bbox %s" % bbox.to_param(),
            bbox=bbox,
            street_km=max(1, int(area * 11)),
            area_km2=max(1, int(area)),
            note="ad-hoc; street_km is estimated from area at 11 km/km^2",
        )
    slug = args.metro
    if slug not in METROS:
        raise SystemExit("unknown metro %r. Known: %s" % (slug, ", ".join(sorted(METROS))))
    return METROS[slug]


def params_from_args(args: argparse.Namespace) -> HarvestParams:
    return HarvestParams(
        cell_meters=getattr(args, "cell_meters", DEFAULT_CELL_METERS),
        heading_sectors=getattr(args, "heading_sectors", DEFAULT_HEADING_SECTORS),
        include_panos=getattr(args, "include_panos", False),
        tile_deg=getattr(args, "tile_deg", DEFAULT_TILE_DEG),
        max_records=getattr(args, "max_records", None),
    )


def db_path(args: argparse.Namespace, metro: Metro) -> Path:
    if getattr(args, "db", None):
        return Path(args.db)
    return DEFAULT_DATA_DIR / ("%s.harvest.sqlite" % metro.slug)


def token_or_die() -> str:
    token = os.environ.get("MAPILLARY_ACCESS_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "MAPILLARY_ACCESS_TOKEN is not set.\n"
            "  1. Register an app at https://www.mapillary.com/dashboard/developers\n"
            "  2. export MAPILLARY_ACCESS_TOKEN=MLY|...\n"
            "See docs/HARVEST.md 'Getting a Mapillary token'."
        )
    return token


def add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--metro", default="pittsburgh", help="metro slug (default: pittsburgh)")
    p.add_argument("--bbox", help="ad-hoc minLon,minLat,maxLon,maxLat instead of --metro")
    p.add_argument("--db", help="checkpoint path (default data/harvest/<metro>.harvest.sqlite)")
    p.add_argument("--tile-deg", type=float, default=DEFAULT_TILE_DEG, dest="tile_deg")
    p.add_argument("--cell-meters", type=float, default=DEFAULT_CELL_METERS, dest="cell_meters")
    p.add_argument(
        "--heading-sectors", type=int, default=DEFAULT_HEADING_SECTORS, dest="heading_sectors",
        help="heading buckets per cell; 4 => the 200 images/km practical row in MASTER_PLAN §3",
    )
    p.add_argument("--include-panos", action="store_true", dest="include_panos")
    p.add_argument("--rate-fraction", type=float, default=0.25, dest="rate_fraction",
                   help="fraction of the documented Mapillary rate ceiling to spend")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="harvest",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    pc = sub.add_parser("precheck", help="measure real coverage before harvesting (DO THIS FIRST)")
    add_common(pc)
    pc.add_argument("--samples", type=int, default=40)
    pc.add_argument("--json-out", help="also write the full report as JSON")

    rn = sub.add_parser("run", help="harvest the metro (resumable)")
    add_common(rn)
    rn.add_argument("--concurrency", type=int, default=8)
    rn.add_argument("--max-records", type=int, default=None, dest="max_records")
    rn.add_argument("--progress-every", type=int, default=10, dest="progress_every")
    rn.add_argument("--reset", action="store_true", help="delete the checkpoint and start over")

    st = sub.add_parser("stats", help="report harvest state and coverage density")
    add_common(st)

    ex = sub.add_parser("export", help="write MapillaryRecordSchema rows as NDJSON")
    add_common(ex)
    ex.add_argument("--out", required=True)
    ex.add_argument("--with-provenance", action="store_true", dest="with_provenance")

    ld = sub.add_parser("load", help="upsert records into Postgres (idempotent)")
    add_common(ld)
    ld.add_argument("--table", default=DEFAULT_TARGET_TABLE)
    ld.add_argument("--dsn", default=os.environ.get("DATABASE_URL", ""))
    ld.add_argument("--batch", type=int, default=1000)
    ld.add_argument(
        "--index-build",
        dest="index_build",
        help="override the build tag pinned at harvest time (default: reuse it)",
    )

    return ap


async def _async_main(args: argparse.Namespace, metro: Metro, params: HarvestParams) -> int:
    token = token_or_die()
    if args.cmd == "precheck":
        # Standalone by design: no SQLite, no Postgres, nothing to clean up.
        async with MapillaryClient(token, rate_fraction=args.rate_fraction) as client:
            report = await precheck(client, metro, params, args.samples)
        print_precheck(report)
        if args.json_out:
            out = Path(args.json_out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(report, indent=2), encoding="utf-8")
            sys.stdout.write("full report: %s\n" % out)
        return 0 if report["verdict"].startswith("GO") else 2

    path = db_path(args, metro)
    if getattr(args, "reset", False) and path.exists():
        path.unlink()
        for suffix in ("-wal", "-shm"):
            side = Path(str(path) + suffix)
            if side.exists():
                side.unlink()
    store = Store(path)
    try:
        store.bind_params(params.fingerprint(metro))
        # Pinned once, before any row exists, so a harvest resumed across days still
        # lands under a single index_build tag.
        emit("index_build_pinned", index_build=pinned_index_build(store, metro))
        tiles = grid(metro.bbox, params.tile_deg)
        async with MapillaryClient(token, rate_fraction=args.rate_fraction) as client:
            harvester = Harvester(
                client,
                store,
                metro,
                params,
                concurrency=args.concurrency,
                progress_every=args.progress_every,
            )
            await harvester.run(tiles)
        cmd_stats(store, metro, params)
    finally:
        store.close()
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
        stream=sys.stderr,
    )
    args = build_parser().parse_args(argv)
    metro = resolve_metro(args)
    params = params_from_args(args)

    if args.cmd in ("precheck", "run"):
        return asyncio.run(_async_main(args, metro, params))

    store = Store(db_path(args, metro))
    try:
        store.bind_params(params.fingerprint(metro))
        if args.cmd == "stats":
            cmd_stats(store, metro, params)
        elif args.cmd == "export":
            n = cmd_export(store, Path(args.out), args.with_provenance)
            sys.stdout.write("wrote %s rows to %s\n" % (f"{n:,}", args.out))
        elif args.cmd == "load":
            if not args.dsn:
                raise SystemExit("--dsn or DATABASE_URL is required for `load`")
            n = cmd_load(
                store,
                args.table,
                args.dsn,
                args.batch,
                metro,
                pinned_index_build(store, metro, args.index_build),
            )
            sys.stdout.write("offered %s rows to %s\n" % (f"{n:,}", args.table))
        else:  # pragma: no cover
            raise SystemExit("unhandled command %r" % args.cmd)
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
