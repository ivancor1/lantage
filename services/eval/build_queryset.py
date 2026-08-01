#!/usr/bin/env python3
"""Build a leakage-controlled VPR query set from Mapillary.

    services/harvest/.venv/bin/python services/eval/build_queryset.py \
        --db data/harvest/greenwich.sqlite --out data/eval/greenwich_queries.json

WHY THIS FILE EXISTS
--------------------
You cannot report a retrieval number without a query set whose answers the index
has not already memorised. The tempting shortcut -- query with images that are in
the index, or with the 15,910 `thinned_bucket_loser` images the harvest dropped --
measures nothing. A thinned loser sits in the *same 20 m cell and heading sector*
as the index image that beat it, usually from the same drive seconds apart. Its
top-1 hit would be a near-duplicate frame and recall would read ~100% while the
product still failed on a real photograph.

THE SPLIT, AND WHY IT IS BY SEQUENCE
------------------------------------
A Mapillary `sequence` is one continuous capture -- one drive, one walk. Frames
inside a sequence are near-duplicates of their neighbours. So the split is:

    a query image is admissible only if its sequence_id appears NOWHERE in the
    reference index.

That is the same protocol MSLS and Pitts30k use (query and reference are
different traversals of the same streets), and it is the only split that makes
recall@k mean "found this place from an independent photograph of it".

We additionally drop query frames that are within `--min-spacing` metres of an
already-accepted query, so that one dense drive cannot dominate the metric with
300 views of the same corner.

GROUND TRUTH
------------
Each query carries Mapillary's own coordinate. `computed_geometry` (SfM-refined)
is preferred over raw `geometry` when present, and which one was used is recorded
per query -- raw handheld GPS in a built-up area can sit 10-30 m off, which is
the same order as the 25 m recall threshold, so this is not a detail.

WHAT THIS SCRIPT DOES NOT DO
----------------------------
It does not download image pixels. It stores the short-lived `thumb_1024_url`
plus the permanent image id; the embed step re-mints URLs as needed. No image
bytes are persisted by this script, so nothing here redistributes Mapillary
content.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import pathlib
import sqlite3
import sys
from typing import Any, Dict, List, Optional, Set, Tuple

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "services" / "harvest"))

from mapillary_api import (  # noqa: E402
    AreaTooDense,
    Bbox,
    IMAGE_FIELDS,
    MapillaryClient,
    MapillaryError,
)

EARTH_R = 6_371_000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def index_facts(db_path: pathlib.Path) -> Tuple[Set[str], Set[str], Bbox]:
    """-> (sequence ids in the index, mapillary ids in the index, index bbox)."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    seqs = {
        r["sequence_id"]
        for r in con.execute("SELECT DISTINCT sequence_id FROM records")
        if r["sequence_id"]
    }
    ids = {r["mapillary_id"] for r in con.execute("SELECT mapillary_id FROM records")}
    row = con.execute(
        "SELECT MIN(lat) a, MAX(lat) b, MIN(lon) c, MAX(lon) d FROM records"
    ).fetchone()
    bbox = Bbox(
        min_lon=row["c"], min_lat=row["a"], max_lon=row["d"], max_lat=row["b"]
    )
    con.close()
    return seqs, ids, bbox


def tile(bbox: Bbox, step: float) -> List[Bbox]:
    """Split into API-legal tiles (every side strictly under 0.01 deg)."""
    out: List[Bbox] = []
    lat = bbox.min_lat
    while lat < bbox.max_lat:
        lon = bbox.min_lon
        while lon < bbox.max_lon:
            east = min(lon + step, bbox.max_lon)
            north = min(lat + step, bbox.max_lat)
            # A trailing sliver can round to a zero-width box, which Bbox refuses.
            if east > lon and north > lat:
                out.append(Bbox(min_lon=lon, min_lat=lat, max_lon=east, max_lat=north))
            lon += step
        lat += step
    return out


async def collect(args: argparse.Namespace) -> Dict[str, Any]:
    db = pathlib.Path(args.db)
    held_seqs, held_ids, bbox = index_facts(db)
    print(
        f"[index] {len(held_ids):,} records across {len(held_seqs):,} sequences; "
        f"bbox {bbox}",
        file=sys.stderr,
    )

    token = os.environ.get("MAPILLARY_ACCESS_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "MAPILLARY_ACCESS_TOKEN is not set. `export MAPILLARY_ACCESS_TOKEN=MLY|...` "
            "(it is in .env.local)."
        )

    tiles = tile(bbox, args.tile_deg)
    print(f"[plan] {len(tiles)} tiles at {args.tile_deg} deg", file=sys.stderr)

    accepted: List[Dict[str, Any]] = []
    stats = {
        "seen": 0,
        "rejected_sequence_in_index": 0,
        "rejected_id_in_index": 0,
        "rejected_pano": 0,
        "rejected_no_geometry": 0,
        "rejected_no_thumb": 0,
        "rejected_too_close": 0,
        "rejected_no_sequence": 0,
    }

    async def fetch(client: MapillaryClient, t: Bbox, depth: int = 0) -> List[Dict[str, Any]]:
        """Rows for one tile, subdividing on either 'too dense' signal.

        `search_images` has no cursor: a full page means rows were silently
        dropped, so `truncated` has to be treated exactly like `AreaTooDense`
        or the query set inherits a biased sample of whatever the API
        happened to return first.
        """
        try:
            rows, truncated = await client.search_images(
                t, fields=IMAGE_FIELDS, limit=args.per_tile
            )
        except AreaTooDense:
            truncated, rows = True, []
        except MapillaryError as e:
            print(f"[tile] error {e}", file=sys.stderr)
            return []
        if truncated and depth < 4:
            out: List[Dict[str, Any]] = []
            for q in t.quadrants():
                out.extend(await fetch(client, q, depth + 1))
            return out
        return rows

    async with MapillaryClient(token=token) as client:
        for i, t in enumerate(tiles):
            rows = await fetch(client, t)
            for row in rows:
                stats["seen"] += 1
                mid = str(row.get("id", ""))
                if not mid:
                    continue
                if mid in held_ids:
                    stats["rejected_id_in_index"] += 1
                    continue

                seq = row.get("sequence")
                seq = str(seq) if seq else ""
                if not seq:
                    stats["rejected_no_sequence"] += 1
                    continue
                # THE SPLIT. Any overlap with a reference sequence is leakage.
                if seq in held_seqs:
                    stats["rejected_sequence_in_index"] += 1
                    continue

                if bool(row.get("is_pano", False)) and not args.include_panos:
                    stats["rejected_pano"] += 1
                    continue

                geom = row.get("computed_geometry") or row.get("geometry")
                geom_source = (
                    "computed" if row.get("computed_geometry") else "raw"
                )
                if not geom or "coordinates" not in geom:
                    stats["rejected_no_geometry"] += 1
                    continue
                lon, lat = float(geom["coordinates"][0]), float(geom["coordinates"][1])

                thumb = row.get("thumb_1024_url")
                if not thumb:
                    stats["rejected_no_thumb"] += 1
                    continue

                if any(
                    haversine_m(lat, lon, a["lat"], a["lon"]) < args.min_spacing
                    for a in accepted
                ):
                    stats["rejected_too_close"] += 1
                    continue

                accepted.append(
                    {
                        "mapillaryId": mid,
                        "lat": lat,
                        "lon": lon,
                        "geomSource": geom_source,
                        "compassAngle": row.get("computed_compass_angle")
                        or row.get("compass_angle"),
                        "capturedAt": row.get("captured_at"),
                        "sequenceId": seq,
                        "isPano": bool(row.get("is_pano", False)),
                        "qualityScore": row.get("quality_score"),
                        "thumbUrl": thumb,
                    }
                )
            print(
                f"[tile {i+1}/{len(tiles)}] accepted={len(accepted)} seen={stats['seen']}",
                file=sys.stderr,
            )
            if args.max_queries and len(accepted) >= args.max_queries:
                break

    return {
        "schema": 1,
        "index": {
            "db": str(db),
            "records": len(held_ids),
            "sequences": len(held_seqs),
            "bbox": [bbox.min_lon, bbox.min_lat, bbox.max_lon, bbox.max_lat],
        },
        "protocol": {
            "split": "held-out-sequence",
            "note": (
                "A query is admissible only if its Mapillary sequence_id appears "
                "nowhere in the reference index. Query and reference are therefore "
                "always different traversals, as in MSLS/Pitts30k."
            ),
            "minSpacingMeters": args.min_spacing,
            "includePanos": args.include_panos,
        },
        "stats": stats,
        "queries": accepted,
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--tile-deg", type=float, default=0.009)
    p.add_argument("--per-tile", type=int, default=2000)
    p.add_argument(
        "--min-spacing",
        type=float,
        default=40.0,
        help="Metres between accepted queries, so one dense drive cannot dominate.",
    )
    p.add_argument("--max-queries", type=int, default=0)
    p.add_argument("--include-panos", action="store_true")
    args = p.parse_args()

    out = asyncio.run(collect(args))
    path = pathlib.Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2))
    print(
        f"\n[done] {len(out['queries']):,} held-out queries -> {path}\n"
        f"       {json.dumps(out['stats'], indent=8)}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
