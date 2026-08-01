"""Metro registry — bboxes, measured street kilometres, and the projection maths.

`harvest.py` imports `METRO_SPECS` from here and wraps each entry in its own `Metro`
dataclass. Nothing else about the harvester changes: same tiling, same thinning, same
checkpoint, same rate limiter.

WHY THIS IS A SEPARATE, DEPENDENCY-FREE MODULE
----------------------------------------------
`scripts/harvest/greenwich.sh` prints projected row counts and dollar cost in its
confirmation prompt *before* the operator has run `pip install -r requirements.txt`.
`harvest.py` cannot be imported without `httpx`, so a prompt that sourced its numbers
from there would either crash or be silently omitted on a fresh checkout — and a
confirmation prompt nobody can read is a confirmation prompt nobody reads. Stdlib only.

Never import `harvest` or `mapillary_api` from this module: `harvest` imports *this*
one, and the cycle would break the harvester rather than this file.

BBOX PROVENANCE
---------------
Every bbox below is derived from OpenStreetMap, measured 2026-07-31, not estimated:

  * Administrative extent from the Nominatim record for the OSM relation named in
    each entry's `source` field.
  * Southern edges are trimmed to just below the southernmost *mapped road*, measured
    with an Overpass `out bb` query over the same relation. Every Connecticut coastal
    town's legal boundary runs out into Long Island Sound to the New York state line —
    Greenwich's reaches 40.9510 N — and every tile below ~40.988 N is open water. That
    trim removes 2 full rows of the root tile grid from the Greenwich box and 20 rows
    from the county box, for zero lost imagery.
  * `street_km` is `sum(length())` over OSM `highway=*` ways of drivable public
    classes **inside the rectangle**, via Overpass. Not inside the town polygon —
    inside the *rectangle*, because a rectangle is what the harvester enumerates. For
    Greenwich the difference is a factor of two and it is the single most surprising
    number in this file. See the note on the `greenwich` entry.

Re-measure with `python3 services/harvest/metros.py --overpass <slug>`, which prints
the exact Overpass query for a given entry so the figure can be audited or refreshed.

WHAT `street_km` IS FOR
-----------------------
Exactly two things, both sanity checks, neither a control input:
  * `precheck` compares measured, projected imagery against `street_km x 200` — the
    "Practical (20 m, 4 headings)" row of MASTER_PLAN §3 — to tell "Mapillary has no
    coverage here" apart from "the thinning is too aggressive".
  * `stats` reports achieved images/km against the same target after a run.
It never limits, filters, or drives a request.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Mirrored harvest defaults
# ---------------------------------------------------------------------------

# These three mirror DEFAULT_CELL_METERS / DEFAULT_HEADING_SECTORS / DEFAULT_TILE_DEG
# in harvest.py, which remains authoritative. They exist here only so the projection
# maths runs without importing the harvester (see module docstring). harvest.py
# raises at import if they ever drift — silently projecting a 360-tile grid for a run
# that actually walks 5,600 tiles is exactly the kind of quiet wrongness the whole
# pre-check discipline exists to prevent.
PROJECTION_CELL_METERS = 20.0
PROJECTION_HEADING_SECTORS = 4
PROJECTION_TILE_DEG = 0.009
PROJECTION_DEFAULTS = (
    PROJECTION_CELL_METERS,
    PROJECTION_HEADING_SECTORS,
    PROJECTION_TILE_DEG,
)

# ---------------------------------------------------------------------------
# Sizing model — MASTER_PLAN §3
# ---------------------------------------------------------------------------

#: 20 m spacing => 50 distinct locations per km of centreline. Multiply by the number
#: of heading sectors for images/km: 4 headings => the 200 images/km "Practical" row.
LOCATIONS_PER_KM = 50

#: halfvec(512): 512 dimensions x 2 bytes. The dimension is load-bearing — pgvector's
#: HNSW ceiling is 2,000 for `vector` / 4,000 for `halfvec`, so this is not a knob.
VECTOR_BYTES = 512 * 2

#: Per-row overheads, back-derived from the Pittsburgh figures in docs/HARVEST.md §9
#: (320k rows => ~330 MB vectors + ~65 MB metadata + ~40 MB graph links).
ROW_METADATA_BYTES = 213
HNSW_LINK_BYTES = 131

#: pgvector builds the HNSW graph in RAM. Under-provisioning `maintenance_work_mem`
#: does not error — it silently falls back to a 10-50x slower disk build. Factor from
#: docs/HARVEST.md §6.
HNSW_BUILD_MEM_FACTOR = 1.7

#: MASTER_PLAN §3. Exceeding these is the documented trigger to migrate to Qdrant or
#: Turbopuffer — it is not a cue to squeeze the thinning.
VECTORS_PER_METRO_CEILING = 2_000_000
VECTORS_PER_INSTANCE_CEILING = 3_000_000

#: Anchored on docs/HARVEST.md §9: 320k images => 6-12 h on one warm L4, ~48 GB of
#: thumbnail transfer. Embedding is the entire schedule; everything else is minutes.
EMBED_HOURS_PER_100K = (1.9, 3.8)
THUMB_GB_PER_100K = 15.0
GPU_USD_PER_HOUR = 0.80

#: Harvest walk, anchored on Pittsburgh's 416 root tiles / 320k kept => 15-25 min.
#: Bound by JSON transfer and per-candidate SQLite work, not by rate limits.
HARVEST_MINUTES_PER_100_TILES = (2.0, 3.4)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MetroSpec:
    slug: str
    name: str
    #: (minLon, minLat, maxLon, maxLat) — the order the Mapillary API documents.
    bbox: Tuple[float, float, float, float]
    #: Drivable public centreline km measured INSIDE `bbox` (not inside a town
    #: polygon). Projection and density sanity only; never limits a request.
    street_km: int
    #: Land area km^2 of the named jurisdiction, for density sanity in reports.
    area_km2: int
    note: str = ""
    #: Where `bbox` and `street_km` came from, so they can be audited or refreshed.
    source: str = ""
    #: Slugs whose bbox this one fully contains. Verified geometrically at import —
    #: a wrong claim here would misreport "new vectors" for a widening stage.
    contains: Tuple[str, ...] = ()
    #: Staging ladder this entry belongs to, and its position in it.
    ladder: Optional[str] = None
    ladder_stage: Optional[int] = None


METRO_SPECS: Dict[str, MetroSpec] = {}


def _add(spec: MetroSpec) -> None:
    METRO_SPECS[spec.slug] = spec


# ---------------------------------------------------------------------------
# Metro #1 — Greenwich, CT and the Fairfield County ladder
# ---------------------------------------------------------------------------
#
# Greenwich is metro #1 because the operator lives there. Every other candidate makes
# ground truth a research project; here a disagreement between the index and reality
# is settled by walking outside with a phone. That is the entire argument, and it is
# worth more than any amount of extra street mileage.

_add(
    MetroSpec(
        slug="greenwich-pilot",
        name="Greenwich, CT — shoreline pilot",
        # Byram / Chickahominy / downtown Greenwich / Cos Cob / Riverside /
        # Old Greenwich / Greenwich Point. The built-up strip south of the Post Road
        # corridor, where the operator can produce a test photo on foot. The east edge
        # is set equal to the `greenwich` box's so the two tile grids align instead of
        # meeting on a fractional-tile boundary.
        bbox=(-73.6620, 40.9880, -73.5530, 41.0500),
        street_km=396,
        area_km2=55,
        ladder="greenwich",
        ladder_stage=0,
        source=(
            "OSM/Overpass 2026-07-31: way(40.9880,-73.6620,41.0500,-73.5540)"
            "[highway~drivable] => 396.06 km over 1,716 ways. The east edge was then "
            "moved 90 m to -73.5530 to align with the `greenwich` grid; that strip is "
            "Long Island Sound and adds no measurable centreline."
        ),
        note=(
            "STAGE 0 / PILOT. ~79k images, 91 root tiles, embeds in ~1.5-3 h for ~$2. "
            "Run this first: it is the smallest box that still contains the operator's "
            "own street, so it converts 'is the index any good' from an argument into a "
            "20-minute walk. Not a substitute for stage 1 — it has no backcountry, no "
            "Merritt Parkway, and no state-line coverage."
        ),
    )
)

_add(
    MetroSpec(
        slug="greenwich",
        name="Greenwich, CT (town) + lower Westchester spill",
        # Nominatim relation 4119957 gives the town as
        #   40.950983..41.144048 N, -73.727811..-73.547487 W.
        # Southern edge trimmed from 40.9510 to 40.9860: the southernmost mapped road
        # in the town is at 40.98848 N (Great Captain Island). Everything below that is
        # Long Island Sound out to the NY line. Other edges buffered ~200 m outward so
        # imagery on a boundary street is not clipped by `outside_bbox`.
        bbox=(-73.7290, 40.9860, -73.5530, 41.1450),
        street_km=1375,
        area_km2=124,
        contains=("greenwich-pilot",),
        ladder="greenwich",
        ladder_stage=1,
        source=(
            "Nominatim relation 4119957 (Town of Greenwich), retrieved 2026-07-31. "
            "Street extent from Overpass `out bb` over the same relation: "
            "40.98848..41.14398 N, -73.72668..-73.55534 W. "
            "street_km from Overpass way(40.9860,-73.7290,41.1450,-73.5530)"
            "[highway~drivable] => 1,375.55 km over 4,826 ways. "
            "Land area 47.8 sq mi = 123.8 km^2 (US Census via Wikipedia, 2026-07-31)."
        ),
        note=(
            "STAGE 1. READ THE STREET_KM BEFORE BUDGETING. Greenwich town itself has "
            "only 667 km of street (Overpass, inside the town polygon) — 2.4x less than "
            "Pittsburgh's 1,600 km, which is the whole reason this metro is cheap. But "
            "the harvester enumerates a RECTANGLE, and the town is a tall narrow "
            "parallelogram, so its rectangle also contains 511 km of New York State "
            "(Port Chester, Rye Brook, Purchase, Armonk) and ~197 km of west Stamford. "
            "1,375 km in the box, 667 km of it Greenwich => ~275k images, not ~133k. "
            "The NY spill is not waste: it is contiguous suburban Northeast within a "
            "10-minute drive of the operator, so it is testable ground truth too. It "
            "does double the embed bill. Use greenwich-pilot if that matters."
        ),
    )
)

_add(
    MetroSpec(
        slug="stamford",
        name="Stamford, CT (east of the Greenwich box)",
        # Nominatim relation 3306055 gives Stamford as
        #   40.964514..41.179929 N, -73.633981..-73.495401 W.
        # The west edge is CLIPPED from -73.6340 to -73.5530 so it abuts the greenwich
        # box instead of overlapping it by ~7 km. Rectangles for interlocking New
        # England towns overlap badly, and an overlap is not cosmetic: `mapillary_id`
        # is the primary key and `load` is ON CONFLICT DO NOTHING, so an image found by
        # both harvests keeps whichever `metro` label was loaded first, and the second
        # metro's row count silently under-reports its own area. Clipping keeps `metro`
        # an actual partition. West Stamford is still covered — by the greenwich box.
        bbox=(-73.5530, 40.9860, -73.4945, 41.1810),
        street_km=593,
        area_km2=98,
        ladder="greenwich",
        ladder_stage=2,
        source=(
            "Nominatim relation 3306055 (City of Stamford), retrieved 2026-07-31, "
            "west edge clipped to the greenwich box. street_km from Overpass "
            "way(40.9860,-73.5530,41.1810,-73.4945)[highway~drivable] => 593.34 km "
            "over 2,306 ways. Land area 37.7 sq mi = 97.6 km^2 (US Census)."
        ),
        note=(
            "STAGE 2, as an INCREMENT rather than a superset. Harvest it alongside "
            "`greenwich`, not instead of it: the two boxes tile the Greenwich+Stamford "
            "area between them with no interior overlap, so the pair costs ~394k "
            "vectors total and each keeps its own honest coverage row. Retrieval must "
            "then prune on `metro = ANY(...)`, not `metro = '...'` — see the coverage "
            "manifest section of docs/HARVEST.md."
        ),
    )
)

_add(
    MetroSpec(
        slug="fairfield-lower",
        name="Lower Fairfield County, CT (Greenwich - Stratford coastal band)",
        # Greenwich, Stamford, Darien, New Canaan, Norwalk, Westport, Weston, Wilton,
        # Fairfield, Bridgeport, Trumbull, Stratford — the populated coastal band, plus
        # unavoidable Westchester NY spill on the west edge.
        bbox=(-73.7290, 40.9860, -73.1000, 41.2600),
        street_km=6206,
        area_km2=760,
        contains=("greenwich-pilot", "greenwich", "stamford"),
        ladder="greenwich",
        ladder_stage=3,
        source=(
            "Overpass way(40.9860,-73.7290,41.2600,-73.1000)[highway~drivable] => "
            "6,205.75 km over 21,413 ways, measured 2026-07-31."
        ),
        note=(
            "STAGE 3, and the realistic ceiling on this Postgres instance: ~1.24M "
            "vectors, 41% of the ~3M/instance budget in MASTER_PLAN §3, ~20-40 embed "
            "hours, ~$25 of L4. SUPERSET of stages 0-2, so if you already loaded them "
            "their rows keep their own `metro` labels and only the new area lands under "
            "this one — which is correct, but means the manifest must be read as a "
            "union. If lower Fairfield is where you are going anyway, harvest THIS box "
            "first and skip stages 1-2: re-walking is cheap, but re-embedding the same "
            "275k images under a second slug is not."
        ),
    )
)

_add(
    MetroSpec(
        slug="fairfield",
        name="Fairfield County, CT (full, historic county extent)",
        # Nominatim relation 2516994 (historic county — Connecticut replaced county
        # government with planning regions in 2022; the county survives as a
        # statistical/geographic area) gives 40.950983..41.666723 N,
        # -73.727811..-73.065051 W. Southern edge trimmed to 40.9860 as above.
        bbox=(-73.7290, 40.9860, -73.0645, 41.6675),
        street_km=14380,
        area_km2=1620,
        contains=("greenwich-pilot", "greenwich", "stamford", "fairfield-lower"),
        ladder="greenwich",
        ladder_stage=4,
        source=(
            "Nominatim relation 2516994 (Fairfield County, historic), retrieved "
            "2026-07-31. street_km from Overpass "
            "way(40.9860,-73.7290,41.6675,-73.0645)[highway~drivable] => 14,379.53 km "
            "over 41,266 ways. Inside the county POLYGON it is 8,368.54 km over 26,551 "
            "ways. Land area 625 sq mi = 1,620 km^2 (US Census)."
        ),
        note=(
            "DOES NOT FIT. DEFINED SO THE ARITHMETIC IS ON THE RECORD, NOT SO IT GETS "
            "HARVESTED. The county polygon is 8,369 km => 1.67M vectors, already 56% of "
            "the ~3M/instance budget. But its RECTANGLE is 14,380 km — the county is an "
            "L wrapped around the NY line, so the box swallows Westchester and Putnam "
            "counties NY and part of New Haven County CT — which is 2.88M vectors at "
            "practical density: over the 2M/metro ceiling AND over the ~3M/instance "
            "ceiling on its own, with nothing left for any second metro. Three ways out, "
            "in preference order: (1) stop at fairfield-lower; (2) harvest the county as "
            "several bboxes tracking its actual shape, each its own metro; (3) treat it "
            "as the documented MASTER_PLAN §3 migration trigger to Qdrant/Turbopuffer. "
            "Dropping to lean density (100 img/km) still gives 1.44M and buys nothing "
            "but a thinner index."
        ),
    )
)


# ---------------------------------------------------------------------------
# Metro #2 — Pittsburgh, PA. Kept, not deleted.
# ---------------------------------------------------------------------------
#
# Pittsburgh was metro #1 until 2026-07-31 and remains fully defined as metro #2. The
# bbox and street_km below are carried over verbatim from harvest.py's original METROS
# dict; the Pittsburgh bbox matches Nominatim relation 188553 exactly.

_add(
    MetroSpec(
        slug="pittsburgh",
        name="Pittsburgh, PA (city)",
        bbox=(-80.0958, 40.3617, -79.8657, 40.5011),
        street_km=1600,
        area_km2=151,
        ladder="pittsburgh",
        ladder_stage=0,
        source="City boundary extent; matches Nominatim relation 188553.",
        note=(
            "Metro #2 as of 2026-07-31 (was #1). ~1,600 km of city streets => ~320k "
            "images at practical density. The rectangle necessarily includes river "
            "surface and slivers of neighbouring boroughs, which is fine — empty tiles "
            "cost one cheap request each."
        ),
    )
)

_add(
    MetroSpec(
        slug="allegheny",
        name="Allegheny County, PA",
        bbox=(-80.3700, 40.1900, -79.6900, 40.6800),
        street_km=9000,
        area_km2=1891,
        contains=("pittsburgh",),
        ladder="pittsburgh",
        ladder_stage=1,
        source="County extent.",
        note=(
            "FALLBACK ONLY. ~1.8M images at practical density — at the pgvector/metro "
            "ceiling."
        ),
    )
)


# ---------------------------------------------------------------------------
# Geometry + projection
# ---------------------------------------------------------------------------

_EARTH_DEG_KM = 111.32  # km per degree; harvest.py uses the same figure for both axes


def bbox_dims_km(bbox: Sequence[float]) -> Tuple[float, float, float]:
    """-> (width_km, height_km, area_km2) for a lon/lat rectangle."""
    min_lon, min_lat, max_lon, max_lat = bbox
    mid_lat = (min_lat + max_lat) / 2.0
    w = (max_lon - min_lon) * _EARTH_DEG_KM * math.cos(math.radians(mid_lat))
    h = (max_lat - min_lat) * _EARTH_DEG_KM
    return w, h, w * h


def tile_grid(bbox: Sequence[float], tile_deg: float = PROJECTION_TILE_DEG) -> Tuple[int, int, int]:
    """-> (cols, rows, total). Mirrors `grid()` in harvest.py: ceil, last row clipped."""
    min_lon, min_lat, max_lon, max_lat = bbox
    cols = max(1, int(math.ceil((max_lon - min_lon) / tile_deg)))
    rows = max(1, int(math.ceil((max_lat - min_lat) / tile_deg)))
    return cols, rows, cols * rows


def contains_bbox(outer: Sequence[float], inner: Sequence[float]) -> bool:
    return (
        outer[0] <= inner[0]
        and outer[1] <= inner[1]
        and outer[2] >= inner[2]
        and outer[3] >= inner[3]
    )


def _verify_containment() -> None:
    """A wrong `contains` would misreport a widening stage's incremental cost."""
    for spec in METRO_SPECS.values():
        for other in spec.contains:
            if other not in METRO_SPECS:
                raise RuntimeError("%s declares contains=%r, which is not a metro" % (spec.slug, other))
            if not contains_bbox(spec.bbox, METRO_SPECS[other].bbox):
                raise RuntimeError(
                    "%s declares it contains %s but %s is not inside %s"
                    % (spec.slug, other, METRO_SPECS[other].bbox, spec.bbox)
                )


_verify_containment()


def maximal_contained(spec: MetroSpec) -> List[str]:
    """The members of `spec.contains` not themselves contained by another member.

    `contains` is transitive so that a coverage-manifest consumer can union a region's
    rows in one pass. Cost arithmetic needs the non-overlapping subset instead.
    """
    return [
        m
        for m in spec.contains
        if not any(
            other != m and contains_bbox(METRO_SPECS[other].bbox, METRO_SPECS[m].bbox)
            for other in spec.contains
        )
    ]


def project(
    spec: MetroSpec,
    heading_sectors: int = PROJECTION_HEADING_SECTORS,
    tile_deg: float = PROJECTION_TILE_DEG,
) -> Dict[str, object]:
    """Projected size, time and cost for one metro at the MASTER_PLAN §3 sizing model.

    This is the same arithmetic `precheck` uses for its `sizing_table_target`, exposed
    ahead of time so a run can be budgeted before a token exists. It is a MODEL, not a
    measurement: it says how many images the area *could* support, and says nothing
    about whether Mapillary contributors actually drove it. Only `precheck` answers
    that, and only with a token.
    """
    images_per_km = LOCATIONS_PER_KM * heading_sectors
    images = spec.street_km * images_per_km
    cols, rows, tiles = tile_grid(spec.bbox, tile_deg)
    w_km, h_km, area = bbox_dims_km(spec.bbox)

    vec_mb = images * VECTOR_BYTES / 1e6
    meta_mb = images * ROW_METADATA_BYTES / 1e6
    link_mb = images * HNSW_LINK_BYTES / 1e6
    build_mem_mb = images * VECTOR_BYTES * HNSW_BUILD_MEM_FACTOR / 1e6

    embed_lo = images / 100_000.0 * EMBED_HOURS_PER_100K[0]
    embed_hi = images / 100_000.0 * EMBED_HOURS_PER_100K[1]
    walk_lo = tiles / 100.0 * HARVEST_MINUTES_PER_100_TILES[0]
    walk_hi = tiles / 100.0 * HARVEST_MINUTES_PER_100_TILES[1]

    # `contains` is the full transitive list — the API needs that to union coverage
    # rows — but only the MAXIMAL members may be subtracted here. greenwich-pilot sits
    # inside greenwich, so subtracting both from fairfield-lower would remove the pilot
    # twice and understate the incremental cost of widening.
    new_images = images - sum(
        METRO_SPECS[m].street_km * images_per_km for m in maximal_contained(spec)
    )

    return {
        "slug": spec.slug,
        "name": spec.name,
        "bbox": "%.4f,%.4f,%.4f,%.4f" % tuple(spec.bbox),
        "bbox_km": (round(w_km, 2), round(h_km, 2)),
        "bbox_area_km2": round(area),
        "street_km": spec.street_km,
        "images_per_km": images_per_km,
        "projected_images": images,
        "projected_new_images": new_images,
        "root_tiles": tiles,
        "tile_grid": "%dx%d" % (cols, rows),
        "vectors_mb": round(vec_mb),
        "total_db_mb": round(vec_mb + meta_mb + link_mb),
        "maintenance_work_mem_mb": round(build_mem_mb),
        "walk_minutes": (round(walk_lo), round(walk_hi)),
        "embed_hours": (round(embed_lo, 1), round(embed_hi, 1)),
        "thumb_gb": round(images / 100_000.0 * THUMB_GB_PER_100K),
        "embed_usd": (round(embed_lo * GPU_USD_PER_HOUR), round(embed_hi * GPU_USD_PER_HOUR)),
        "pct_of_metro_ceiling": round(100.0 * images / VECTORS_PER_METRO_CEILING),
        "pct_of_instance_ceiling": round(100.0 * images / VECTORS_PER_INSTANCE_CEILING),
        "over_budget": images > VECTORS_PER_METRO_CEILING or images > VECTORS_PER_INSTANCE_CEILING,
    }


def ladder(name: str) -> List[MetroSpec]:
    return sorted(
        (s for s in METRO_SPECS.values() if s.ladder == name),
        key=lambda s: (s.ladder_stage if s.ladder_stage is not None else 0),
    )


# ---------------------------------------------------------------------------
# Coverage manifest
# ---------------------------------------------------------------------------

#: Version of the manifest row shape. Bump it if a field's meaning changes, so a
#: consumer can refuse a manifest it does not understand rather than misread one.
COVERAGE_MANIFEST_VERSION = 1


def coverage_manifest_row(
    spec: MetroSpec,
    *,
    index_build: str,
    image_count: int,
    embedded_count: int,
    harvested_at: Optional[str] = None,
    distinct_cells: Optional[int] = None,
    coverage_fraction: Optional[float] = None,
    median_capture_year: Optional[int] = None,
    precheck_path: Optional[str] = None,
    heading_sectors: int = PROJECTION_HEADING_SECTORS,
    cell_meters: float = PROJECTION_CELL_METERS,
) -> Dict[str, object]:
    """The row the API needs to say "street precision is available here" honestly.

    Raven's UI shows "Street precision available" only where their street index
    actually reaches. We need the same honesty, and honesty here is not a UI decision —
    it is a data question the API cannot answer from `mapillary_images` alone. That
    table has `metro` and `index_build` per row, so you can count rows for a metro, but
    a metro slug is not a geometry: nothing in the schema says where 'greenwich'
    *is*, so nothing can decide whether a given lat/lon falls inside it.

    This row supplies the missing geometry and the missing quality evidence. See the
    "Coverage manifest" section of docs/HARVEST.md for the DDL and the API contract.

    `min_images_for_street_precision` is deliberately part of the row rather than a
    constant in the API: it is a property of how a metro was harvested, and a metro
    harvested at 8 heading sectors should not be judged against a 4-sector floor.
    """
    w_km, h_km, area = bbox_dims_km(spec.bbox)
    target = spec.street_km * LOCATIONS_PER_KM * heading_sectors
    return {
        "manifest_version": COVERAGE_MANIFEST_VERSION,
        # --- identity: joins to mapillary_images (metro, index_build) ------------
        "metro": spec.slug,
        "display_name": spec.name,
        "index_build": index_build,
        # --- geometry: the ONLY reason this row exists -------------------------
        "min_lon": spec.bbox[0],
        "min_lat": spec.bbox[1],
        "max_lon": spec.bbox[2],
        "max_lat": spec.bbox[3],
        "bbox_area_km2": round(area),
        # --- what actually landed ----------------------------------------------
        "image_count": image_count,
        "embedded_count": embedded_count,
        "distinct_cells": distinct_cells,
        "street_km": spec.street_km,
        "images_per_km": round(image_count / float(spec.street_km), 1) if spec.street_km else None,
        "sizing_target_images": target,
        "target_attainment": round(image_count / float(target), 3) if target else None,
        # --- harvest parameters: two metros are only comparable at equal grids ---
        "cell_meters": cell_meters,
        "heading_sectors": heading_sectors,
        # --- quality evidence from the pre-check --------------------------------
        "coverage_fraction": coverage_fraction,
        "median_capture_year": median_capture_year,
        "precheck_report": precheck_path,
        # --- provenance ----------------------------------------------------------
        "harvested_at": harvested_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "mapillary",
        "attribution_required": True,
        "bbox_source": spec.source,
        # --- the gate the API applies before promising street precision ---------
        # 50 images inside a 0.005-deg (~550 m) block is the coverage-hole threshold
        # already used in docs/HARVEST.md §8. Reuse it rather than inventing a second
        # definition of "covered".
        "min_images_for_street_precision": 50,
        "hole_block_degrees": 0.005,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _fmt_table(specs: Sequence[MetroSpec], heading_sectors: int) -> str:
    """Staging ladder as a table. `cumulative` is what actually lands in Postgres if
    you run every stage in order — supersets contribute only their new area, because
    `load` is ON CONFLICT DO NOTHING on the mapillary_id primary key."""
    out: List[str] = []
    w = out.append
    header = "%-17s %9s %11s %7s %11s %9s %11s %8s" % (
        "metro", "street km", "images", "tiles", "embed h", "USD", "cumulative", "% of 3M"
    )
    w("")
    w(header)
    w("-" * len(header))
    cumulative = 0
    for s in specs:
        p = project(s, heading_sectors=heading_sectors)
        cumulative += int(p["projected_new_images"])
        w(
            "%-17s %9s %11s %7s %5.1f-%-5.1f %4d-%-4d %11s %7d%%%s"
            % (
                s.slug,
                f"{s.street_km:,}",
                f"{p['projected_images']:,}",
                f"{p['root_tiles']:,}",
                p["embed_hours"][0],
                p["embed_hours"][1],
                p["embed_usd"][0],
                p["embed_usd"][1],
                f"{cumulative:,}",
                round(100.0 * cumulative / VECTORS_PER_INSTANCE_CEILING),
                "  ** OVER BUDGET **" if p["over_budget"] else "",
            )
        )
    w("")
    w("images = street_km x %d (MASTER_PLAN §3 practical density, %d heading sectors)."
      % (LOCATIONS_PER_KM * heading_sectors, heading_sectors))
    w("A MODEL, not a measurement. Only `harvest.py precheck` (needs a token) says")
    w("whether Mapillary contributors actually drove these streets.")
    w("")
    return "\n".join(out)


def _overpass_query(spec: MetroSpec) -> str:
    cls = (
        "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
        "living_street|motorway_link|trunk_link|primary_link|secondary_link|"
        "tertiary_link)$"
    )
    min_lon, min_lat, max_lon, max_lat = spec.bbox
    return (
        "[out:json][timeout:900];\n"
        'way(%.4f,%.4f,%.4f,%.4f)["highway"~"%s"];\n'
        "make stat km=sum(length())/1000, n=count(ways);\n"
        "out;\n" % (min_lat, min_lon, max_lat, max_lon, cls)
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="metros",
        description="Metro registry: bboxes, measured street km, projected index size.",
    )
    ap.add_argument("--ladder", help="print a staging ladder (e.g. greenwich, pittsburgh)")
    ap.add_argument("--metro", help="print one metro's projection")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--overpass", metavar="SLUG", help="print the Overpass query that measures street_km")
    ap.add_argument(
        "--heading-sectors", type=int, default=PROJECTION_HEADING_SECTORS, dest="heading_sectors"
    )
    args = ap.parse_args(argv)

    if args.overpass:
        if args.overpass not in METRO_SPECS:
            print("unknown metro %r" % args.overpass, file=sys.stderr)
            return 2
        sys.stdout.write(_overpass_query(METRO_SPECS[args.overpass]))
        return 0

    if args.metro:
        if args.metro not in METRO_SPECS:
            print("unknown metro %r. Known: %s" % (args.metro, ", ".join(sorted(METRO_SPECS))), file=sys.stderr)
            return 2
        spec = METRO_SPECS[args.metro]
        p = project(spec, heading_sectors=args.heading_sectors)
        if args.json:
            print(json.dumps(p, indent=2))
        else:
            print("\n%s  [%s]" % (spec.name, spec.slug))
            print("  bbox                  %s" % p["bbox"])
            print("  bbox size             %.1f x %.1f km (%s km^2)" % (p["bbox_km"][0], p["bbox_km"][1], f"{p['bbox_area_km2']:,}"))
            print("  street km in bbox     %s (measured, OSM)" % f"{spec.street_km:,}")
            print("  root tiles            %s (%s at %.4f deg)" % (f"{p['root_tiles']:,}", p["tile_grid"], PROJECTION_TILE_DEG))
            print("  projected images      %s  (%d/km, MASTER_PLAN §3 practical)" % (f"{p['projected_images']:,}", p["images_per_km"]))
            if p["projected_new_images"] != p["projected_images"]:
                print("    new beyond stages   %s" % f"{p['projected_new_images']:,}")
            print("  vectors               %s MB halfvec(512); %s MB total in Postgres" % (f"{p['vectors_mb']:,}", f"{p['total_db_mb']:,}"))
            print("  maintenance_work_mem  >= %s MB (default is 64 MB — see HARVEST.md §6)" % f"{p['maintenance_work_mem_mb']:,}")
            print("  harvest walk          %d-%d min" % p["walk_minutes"])
            print("  embed                 %.1f-%.1f h on one warm L4, ~%s GB thumbnails, $%d-%d" % (p["embed_hours"][0], p["embed_hours"][1], f"{p['thumb_gb']:,}", p["embed_usd"][0], p["embed_usd"][1]))
            print("  vector budget         %d%% of the 2M/metro ceiling, %d%% of ~3M/instance" % (p["pct_of_metro_ceiling"], p["pct_of_instance_ceiling"]))
            if p["over_budget"]:
                print("  ** OVER BUDGET — see MASTER_PLAN §3 migration trigger **")
            if spec.note:
                print("\n  %s" % spec.note)
            print("\n  source: %s\n" % spec.source)
        return 0

    name = args.ladder or "greenwich"
    specs = ladder(name)
    if not specs:
        print("unknown ladder %r" % name, file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps([project(s, heading_sectors=args.heading_sectors) for s in specs], indent=2))
    else:
        print(_fmt_table(specs, args.heading_sectors))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
