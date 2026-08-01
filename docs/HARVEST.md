# HARVEST — building the Mapillary VPR index

Owner: B3. Sizing rationale and the three irreversible decisions: `docs/MASTER_PLAN.md` §3.
Row shape: `MapillaryRecordSchema` in `src/lib/contracts/schemas.ts`.

This is the pipeline that turns Mapillary's public imagery into the retrieval index
behind GEO/STREET. **Metro #1 is Greenwich, CT** as of 2026-07-31 — see §12, which has
the bboxes, the measured street mileage, the projected counts and the one command
sequence to run. Pittsburgh is metro #2 and stays fully defined; everything in §0–§11
below is written against Pittsburgh and still applies unchanged, except where §12 says
a threshold does not transfer to a metro this size.

```
harvest.py precheck   measure real coverage        ~40 requests, <1 min   ← ALWAYS FIRST
harvest.py run        walk tiles, thin, checkpoint 15–25 min, ~1 GB in
embed_index.py        EigenPlaces-512 via B1        6–12 h on one warm L4  ← the long stage
harvest.py load       upsert into Postgres          2–5 min
build_index.sql       HNSW build + ANALYZE          5–15 min
```

Every stage is resumable and idempotent. Re-running never duplicates a row and never
re-embeds one.

---

## 0. Run the coverage pre-check first. Not optional.

Mapillary coverage is contributed, not systematic. A city can have 40 dense corridors
and nothing else, and you cannot tell from the outside. The pre-check costs about 40
API requests and answers the only question worth answering before committing a GPU
day: **is there enough imagery here to build an index worth querying?**

```bash
export MAPILLARY_ACCESS_TOKEN='MLY|...'
python3 services/harvest/harvest.py precheck --metro pittsburgh \
  --samples 40 --json-out data/harvest/pittsburgh.precheck.json
```

It samples a deterministic stride of tiles across the whole bbox, runs the *real*
thinning logic on what comes back, and prints:

```
tiles with imagery       31 (78%)
raw images in sample     18,430 (mean 460.8/tile)
cap-truncated tiles      3
thinning keeps           12.4% of raw
panorama share           7.1%
median capture year      2022

PROJECTED FOR FULL BBOX
  raw images             191,700
  indexable after thin   23,700
  sizing-table target    320,000

VERDICT: GO
```

(Illustrative shape, not measured — nobody has run this yet, see §9.)

Read three things:

- **`indexable after thin` vs `sizing-table target`.** The target is `street_km × 200`
  from the MASTER_PLAN §3 density table. Coming in far under it means Mapillary simply
  does not have the coverage, not that thinning is too aggressive.
- **`cap-truncated tiles`.** Any non-zero value means those raw counts are *lower
  bounds* — the real run subdivides those tiles and finds more. Projected raw is
  understated whenever this is non-zero.
- **`coverage_fraction`.** Below 50% means the index will have holes. A retrieval miss
  in a hole is indistinguishable from a retrieval miss on a hard image, which is
  exactly the failure mode BENCH (§10) has to be able to attribute.

Exit code is 0 on `GO` / `GO-WITH-CAVEATS`, 2 on `NO-GO`, so it gates a scripted run.

### Verdict thresholds

| Projected indexable | Coverage fraction | Verdict | Action |
|---|---|---|---|
| ≥ 100k | ≥ 50% | `GO` | proceed |
| ≥ 50k | any | `GO-WITH-CAVEATS` | proceed, but expect holes; document them for BENCH |
| < 50k | any | `NO-GO` | widen the bbox — see below |

### Fallback: widen to Allegheny County

City-proper Pittsburgh is only 151 km². If it comes back thin:

```bash
python3 services/harvest/harvest.py precheck --metro allegheny --samples 60
```

**Stage the widening; do not jump straight to the county.** Allegheny County is
1,891 km² and ~9,000 km of street, which at practical density is ~1.8M images — at
the ≤2M-vectors-per-metro ceiling in MASTER_PLAN §3, with nothing left for metro #2 on
the same instance. The order is: city → city + inner-ring boroughs → full county, and
you re-check the vector budget at each step.

The intermediate step is an ad-hoc bbox, which every subcommand accepts:

```bash
python3 services/harvest/harvest.py precheck \
  --bbox '-80.15,40.32,-79.80,40.55' --samples 50
```

---

## 1. Prerequisites

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r services/harvest/requirements.txt
```

Python 3.9+. Checkpointing uses stdlib `sqlite3`, so a resume never depends on a
service being reachable. `psycopg` is only needed for the Postgres stages.

| Variable | Needed by | Notes |
|---|---|---|
| `MAPILLARY_ACCESS_TOKEN` | `precheck`, `run`, thumb-URL refresh | see below |
| `INFERENCE_SERVICE_URL` | `embed_index.py` | B1's Modal endpoint |
| `DATABASE_URL` | `load`, `build_index.sql` | Supabase connection string |

### Getting a Mapillary token

1. Sign in at <https://www.mapillary.com> and open
   <https://www.mapillary.com/dashboard/developers>.
2. **Register an application.** Request the read scopes only —
   `read` / `read:images`. Nothing in this pipeline writes to Mapillary.
3. Copy the **client token** (`MLY|<app_id>|<secret>`). That is an app token, not a
   user token: it is the right kind for a server-side batch job and it is what the
   per-app rate limits are measured against.
4. `export MAPILLARY_ACCESS_TOKEN='MLY|...'` — or put it in `.env` (gitignored).

The token is sent as `Authorization: OAuth <token>`, never as `?access_token=`, so it
stays out of proxy and CDN access logs.

Imagery access itself is **$0**. There is no paid tier to reach and no quota to buy.

---

## 2. The verified API shape, and the one trap in it

Verified against <https://www.mapillary.com/developer/api-documentation> on
**2026-07-29**. Re-verify before changing any of this; field names have moved across
versions. The constants live in `services/harvest/mapillary_api.py`.

| | |
|---|---|
| Base | `https://graph.mapillary.com` |
| Search | `GET /images?bbox=<minLon,minLat,maxLon,maxLat>&fields=…&limit=…` |
| Entity | `GET /<image_id>?fields=…` |
| Auth | `Authorization: OAuth <token>` (or `?access_token=`) |
| bbox order | `left, bottom, right, top` = `minLon, minLat, maxLon, maxLat` |
| bbox size | "The bbox area must be smaller than 0.01 degrees square." |
| `limit` | "Max and default is 2000" |
| `captured_at` | Unix **milliseconds** (e.g. `1641206630491`) |
| `geometry` | GeoJSON Point, `[longitude, latitude]` |
| `computed_geometry` | GeoJSON Point, "location after running image processing" (SfM-refined) |
| Rate limits | Entity 60,000/min · Search 10,000/min · Tiles 50,000/day |

Fields requested: `id`, `geometry`, `computed_geometry`, `compass_angle`,
`computed_compass_angle`, `captured_at`, `thumb_1024_url`, `sequence`, `is_pano`,
`camera_type`, `quality_score`.

### The trap: bbox search does not paginate

> "Pagination is currently supported only in combination with **creator_username**
> parameter."

A bbox query that returns exactly 2000 rows is **silently truncated**. There is no
cursor, no `next` URL, and no error. If you tile a city at any convenient tile size
and trust the counts, you will build an index that is quietly missing every dense
downtown block — and it will look fine, because retrieval will still return
neighbours, just never the right ones.

`harvest.py` handles this by treating `len(rows) == limit` as a signal to subdivide the
tile into quadrants and re-query, recursively, to a depth of 6. Tiles that still hit
the cap at depth 6 (~15 m across) emit a `tile_truncated_at_max_depth` event at
severity `error`, because at that point either the API changed or something is wrong,
and coverage there is genuinely incomplete.

### Tile sizing

The documented phrase "smaller than 0.01 degrees square" is ambiguous between 0.01 deg²
of area and 0.01 deg per side. The default tile is **0.009° per side**, which satisfies
the stricter reading either way. At Pittsburgh's latitude that is ~1.00 × 0.76 km, and
the city bbox becomes **416 root tiles** before any subdivision.

---

## 3. Thinning — why the index is 320k and not 3M

Raw Mapillary density follows contributor sequences: 1 m spacing along a corridor
somebody drove ten times, nothing one street over. Indexing that raw gives you a large
index with the coverage profile of a small one, and every extra near-duplicate costs
storage, build time, and query latency while adding no new place.

So every candidate is bucketed by **(≈20 m grid cell × heading sector)** and one winner
is kept per bucket. Defaults are `--cell-meters 20` and `--heading-sectors 4`, which is
literally the "Practical (20 m, 4 headings) = 200 images/km" row of the MASTER_PLAN §3
table. `--heading-sectors 8` doubles the index for finer heading coverage.

The winner is chosen by a deterministic total order:

1. **SfM-refined `computed_geometry` beats raw GPS** (weight 2.0). An image in the wrong
   place is worse than a slightly older or blurrier image in the right one — the whole
   index is a positional lookup.
2. `quality_score` (0–1).
3. Recency, normalised against a fixed epoch so scores are reproducible across runs.
4. Ties break on `mapillary_id` ascending.

Because that is a total order and every id is considered exactly once, **the surviving
set does not depend on the order tiles happen to finish in.** Two runs over the same
area produce the same index. The grid uses a single reference latitude per metro so a
record lands in the same cell no matter which tile found it.

Also dropped, each counted separately in `harvest.py stats`:

| Reason | Meaning |
|---|---|
| `no_gps` | null/absent/(0,0) geometry — unplaceable, so useless to a positional index |
| `outside_bbox` | subdivided tiles share edges; SfM can nudge a point out of its tile |
| `duplicate_id` | seen in an overlapping tile or a previous run |
| `pano_excluded` | `is_pano` and `--include-panos` not set (see below) |
| `missing_thumb` / `bad_thumb_host` | blur safeguard, §7 |
| `blur_safeguard_failed` | response carried `detections` |
| `thinned_bucket_loser` | lost its bucket to a better image |

### Panoramas

Excluded by default. EigenPlaces expects perspective frames; feeding it equirectangular
panoramas embeds a distorted image and pollutes the neighbourhood structure of the
index. Correct handling is equirect → 4 perspective crops, which is B1's call, not the
harvester's. `--include-panos` keeps them (one bucket per cell rather than per sector,
since a pano covers every heading) if B1 ships crop support. The pre-check reports
`pano_share` so you know what you are leaving on the table.

---

## 4. Run it

```bash
# resumable; safe to Ctrl-C
python3 services/harvest/harvest.py run --metro pittsburgh --concurrency 8
```

Or the whole runbook as one script:

```bash
MAPILLARY_ACCESS_TOKEN='MLY|...' INFERENCE_SERVICE_URL=https://… DATABASE_URL=postgres://… \
  scripts/harvest/pittsburgh.sh all
```

Progress is one JSON object per line on stderr — greppable, pipeable to a log sink:

```json
{"event":"progress","root_tiles":"180/416","leaf_tiles":263,"raw_seen":412088,
 "kept":141902,"replaced":9330,"discarded":270186,
 "discards":{"duplicate_id":31004,"no_gps":118,"pano_excluded":29401,"thinned_bucket_loser":209663},
 "images_per_sec":611.4,"tiles_per_sec":0.27,"elapsed_s":662,"eta_s":868,
 "rate_budget":"search 2412/2500 tokens (1043 spent, ceiling 10000/min) | entity 15000/15000 tokens (0 spent, ceiling 60000/min)"}
```

`rate_budget` is the live token-bucket state. By default the client spends 25% of each
documented ceiling (`--rate-fraction`), so a retry storm cannot exhaust the app quota
for anything else using the same token. Rate limits are not the binding constraint here
— a full Pittsburgh harvest is ~1,000–1,400 requests against a 2,500/min budget.

Retries: 429 honours `Retry-After`, otherwise exponential backoff with full jitter (the
jitter matters — without it all 8 workers trip the limiter on the same tick and
retry in lockstep). 5xx and transport errors retry the same way. A tile that fails all
attempts is left **unmarked**, so the next run retries exactly that box.

### Resuming

Just re-run the same command. State lives in
`data/harvest/pittsburgh.harvest.sqlite` (gitignored, WAL mode, one transaction per
tile — a `kill -9` loses at most one tile).

- Completed tiles are skipped; a partially-descended subtree re-descends and skips its
  finished children.
- Every id ever considered is in `seen`, so a re-read cannot duplicate or re-rank.
- **Changing `--cell-meters`, `--heading-sectors`, `--include-panos`, `--tile-deg`, or
  the bbox refuses to resume.** Bucket keys derive from those, so resuming would blend
  two different grids into one index. Use a fresh `--db`, or `--reset` to start over.

---

## 5. Embedding

```bash
python3 services/harvest/embed_index.py --metro pittsburgh \
  --service "$INFERENCE_SERVICE_URL" --target sqlite --batch-size 32 --concurrency 4
```

Calls `POST /embed_batch` with `models: ['eigenplaces']`, validates every vector, and
writes it back. Rows with a vector are skipped, so this is resumable by re-running.

**512-d is load-bearing.** pgvector's HNSW index has a hard 2,000-dimension ceiling, so
MegaLoc's 8,448-d descriptor cannot be indexed at all — every query would degrade to a
sequential scan over the whole metro. 512-d is also 16.5× smaller (2.0 GB vs 33.8 GB per
million fp32) and ~21× faster (0.13 s vs 2.80 s per image). And it is not a quality
sacrifice at the retrieval stage: EigenPlaces-512 beat BoQ-16384 in the arXiv 2507.17455
ablation. MegaLoc's job is re-ranking the top 50, where 8,448-d costs 50 comparisons
instead of 320,000. `embed_index.py` **refuses** to store a vector whose dim ≠ 512 and
exits non-zero if it saw one.

Two operational notes:

- **`thumb_*_url` values are short-lived signed CDN URLs.** A harvest from yesterday has
  stale URLs today, so a 403 at embed time is expected, not exceptional. With
  `MAPILLARY_ACCESS_TOKEN` set, `embed_index.py` re-mints them one at a time from the
  Entity API (60,000/min — cheap). Without the token it logs
  `url_refresh_unavailable` and those rows fail. Either embed same-day or keep the
  token available.
- **`--per-image`** falls back to `POST /embed` once per image, using only the
  contract-verified single-image shape from `schemas.ts`. Use it if `/embed_batch` is
  not up yet or its envelope differs. The batch envelope keys are the *only*
  assumption made about B1's endpoint and are overridable via
  `EMBED_BATCH_ITEMS_KEY` / `EMBED_BATCH_RESULTS_KEY`; a malformed batch response
  automatically degrades to per-image rather than losing the batch.

---

## 6. Loading and indexing

### Into A2's table

```bash
python3 services/harvest/harvest.py load --metro pittsburgh --dsn "$DATABASE_URL"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f services/harvest/build_index.sql
```

`load` introspects `information_schema.columns` and maps contract fields onto the
columns that actually shipped, rather than hardcoding a guess. It errors loudly if a
required field has no column. Inserts are `ON CONFLICT (mapillary_id) DO NOTHING`, so
re-running is a no-op.

Verified against `supabase/migrations/20260729180500_reference_data.sql`:

| Contract field | Column | |
|---|---|---|
| `mapillaryId` | `mapillary_id` | PK |
| `lat` / `lon` | `lat` / `lon` | NOT NULL |
| `thumbUrl` | `thumb_url` | NOT NULL |
| `blurApplied` | `blur_applied` | NOT NULL, `CHECK (blur_applied)` |
| `compassAngle` | `compass_angle` | |
| `capturedAt` | `captured_at` | |
| `sequenceId` | `sequence_id` | |
| `isPano` | `is_pano` | |
| — | `embedding halfvec(512)` | written by `embed_index.py` |

### `metro` and `index_build`

A2's table has two **NOT NULL, no-default** columns that are properties of the harvest
run rather than of an image, so they are not in `MapillaryRecordSchema`:

- **`metro`** — the submap key retrieval prunes on before the ANN order-by. Set from
  the metro slug.
- **`index_build`** — e.g. `mapillary-pittsburgh@2026-07-29`. A2 copies it into every
  `ResultProvenance.indexBuild` so a result maps to the exact index that produced it;
  reproducibility is a Daubert requirement.

The build tag is **pinned in the checkpoint at first run and reused on every resume**,
so a harvest interrupted on Tuesday and finished on Thursday does not split across two
build tags. `harvest.py stats` prints it; `--index-build` on `load` overrides it. After
loading, `build_index.sql` reports rows grouped by `(metro, index_build)` — more than
one tag per metro means two harvests got mixed and results citing them are not
reproducible.

`embed_index.py --target postgres` scopes to one metro for the same reason, and casts to
the column's declared type (`halfvec`, not `vector` — there is no implicit
vector→halfvec assignment cast, so getting this wrong fails at runtime).

### Or via NDJSON

```bash
python3 services/harvest/harvest.py export --metro pittsburgh --out data/harvest/pittsburgh.ndjson
python3 services/harvest/embed_index.py --metro pittsburgh \
  --export-embeddings data/harvest/pittsburgh.embeddings.ndjson
```

One `MapillaryRecordSchema` object per line — `MapillaryRecordSchema.parse(JSON.parse(line))`
passes as-is. `--with-provenance` adds `_bucketKey` / `_cellKey` / `_sector` / `_score` /
`_geomSource` (underscore-prefixed; zod strips unknown keys by default).

Loader for later. Note the improbable quote/delimiter characters — JSON lines contain
commas and backslash escapes, so the default TEXT and CSV settings both corrupt them:

```sql
CREATE TEMP TABLE _ndjson (doc jsonb);
\copy _ndjson (doc) FROM 'data/harvest/pittsburgh.ndjson' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')

INSERT INTO mapillary_images
  (mapillary_id, lat, lon, compass_angle, captured_at, thumb_url, sequence_id, is_pano,
   blur_applied, metro, index_build)
SELECT doc->>'mapillaryId',
       (doc->>'lat')::double precision,
       (doc->>'lon')::double precision,
       (doc->>'compassAngle')::double precision,
       (doc->>'capturedAt')::timestamptz,
       doc->>'thumbUrl',
       doc->>'sequenceId',
       (doc->>'isPano')::boolean,
       (doc->>'blurApplied')::boolean,
       'pittsburgh',                        -- NOT NULL, no default
       'mapillary-pittsburgh@2026-07-29'    -- NOT NULL; use the tag `stats` prints
FROM _ndjson
ON CONFLICT (mapillary_id) DO NOTHING;

-- Then the vectors. Cast to halfvec, not vector: the column is halfvec(512) and
-- pgvector has no implicit vector -> halfvec assignment cast.
CREATE TEMP TABLE _emb (doc jsonb);
\copy _emb (doc) FROM 'data/harvest/pittsburgh.embeddings.ndjson' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
UPDATE mapillary_images m
   SET embedding = (e.doc->>'vector')::halfvec(512)
  FROM _emb e
 WHERE m.mapillary_id = e.doc->>'mapillaryId'
   AND (e.doc->>'dim')::int = 512;   -- never relax this
```

### What `build_index.sql` is for, given A2 already creates the index

A2's migration creates `mapillary_images_embedding_hnsw` on an **empty** table, where it
is free. That is the right call, but it means that after a bulk harvest the graph was
built incrementally, one insert at a time, at whatever `maintenance_work_mem` the ingest
session happened to have. This script rebuilds it in one pass with the memory it needs.

**It `REINDEX`es; it does not redefine.** A2's index is on the **bare column**
(`hnsw (embedding halfvec_cosine_ops)`) and `search_geo_candidates()` orders by
`m.embedding <=> query_embedding` — also bare. An expression index such as
`hnsw ((embedding::halfvec(512)) halfvec_cosine_ops)` would be a *different* index that
query can never use: retrieval would fall back to a sequential scan over the whole metro
and still return plausible-looking neighbours. Mixing index and query expressions is the
quietest way to disable an ANN index. `REINDEX` reuses the catalog definition, so it
cannot drift from A2's migration. Do not swap it for `DROP` + `CREATE` unless you are
changing A2's migration in the same commit.

Plain `REINDEX` takes an `ACCESS EXCLUSIVE` lock, which is fine for a table nobody is
querying yet. Once the index is serving traffic, use `REINDEX INDEX CONCURRENTLY`
outside a transaction with `SET maintenance_work_mem` in the session.

### The `maintenance_work_mem` trap

`build_index.sql` sets `maintenance_work_mem = '8GB'` before the rebuild, and the comment
explaining why is the most important comment in this repo's SQL. pgvector builds the
HNSW graph **in memory**. If it does not fit, Postgres does not error and does not warn
at a level anyone notices — it silently falls back to a disk-based build **10–50×
slower**. The default is 64 MB. Our graph needs roughly
`320,000 × 512 × 2 bytes × 1.7 ≈ 560 MB`, so 64 MB misses by ~9×; a 10-minute build
becomes an overnight job and nothing tells you why.

It uses `SET LOCAL` so an 8 GB setting is never left behind for autovacuum to inherit,
and it echoes the value that actually took effect, because a silently clamped setting is
the exact failure the whole block exists to prevent. Afterwards it runs `ANALYZE` — the
planner has no statistics for a freshly built index and will happily sequential-scan past
it — then verifies from `EXPLAIN` output that the planner really does choose the graph.

The script also refuses to build when <95% of rows are embedded. An HNSW graph over 40%
of the rows is worse than no index: retrieval succeeds, returns plausible neighbours, and
silently cannot see the rest of the metro.

---

## 7. The blur safeguard

Mapillary Terms §12 requires commercial users to "implement and maintain technical
safeguards and business processes that prohibit reidentification or unblurring of any
Content, including any individual or license plate." That is a condition on the licence
that makes this whole index possible, so it is enforced structurally, not by convention:

1. **`detections` is refused at the field allowlist.** It is the one image field that can
   carry per-object geometry and OCR'd sign and plate text. `assert_fields_permitted()`
   raises rather than requesting it, and a response that somehow contains it is dropped
   as `blur_safeguard_failed`.
2. **Thumbnail hosts are pinned** to Mapillary/Meta CDNs (`mapillary.com`, `fbcdn.net`,
   `cdninstagram.com`). Those renditions are the blurred ones; a URL anywhere else is not
   a verified blurred rendition and the record is dropped as `bad_thumb_host`.
   *Confirm and tighten this list against real URLs on the first live run.*
3. **`blurApplied: true` is asserted per record before storage**, backed by a SQLite
   `CHECK (blur_applied = 1)`, re-checked at export, and re-checked again in
   `build_index.sql` before the index is built.
4. **No OCR, no detection, no crops, no pixel cache anywhere in this pipeline.** Not plate
   characters, not plate *style*, not signage. Thumbnails are fetched by the inference
   service, embedded, and discarded; the only artifact that reaches the database is a
   float vector, which is not a reidentifiable image.
5. **`attribution.ts` forbids enhance/sharpen/upscale/deblur controls** on any UI surface
   showing harvested imagery — a client-side enhance affordance is precisely the process
   §12 prohibits and would undo the assertion made here.

Terms §5 also prohibits "data mining, robots or similar data gathering or extraction
methods not approved by Mapillary." This pipeline uses only the documented, approved v4
REST endpoints. It does not touch `www.mapillary.com`, does not scrape, does not bypass
`robots.txt`, and never calls an undocumented endpoint. It also deliberately avoids the
Tile API entirely — 50,000/day is the real bottleneck for wide-area work, and the
Search API gives us everything we need.

Attribution (§11) is a hard UI requirement, specified in
`services/harvest/attribution.ts`: **visible Mapillary logo** (a text credit alone does
not satisfy §11) plus a link back to the homepage or the corresponding image page,
`https://www.mapillary.com/app/?pKey=<imageId>&focus=photo`.

---

## 8. Verifying coverage after a run

```bash
python3 services/harvest/harvest.py stats --metro pittsburgh
```

```
Pittsburgh, PA (city) — harvest state
  leaf tiles complete    537 (root grid 416)
  indexable records      318,442
    with SfM geometry    301,118 (94.6%)
  embedded               318,442 (100.0%)
  density                199 images/km of street (practical target 200)
  distinct grid cells    88,301 (mean 3.61 headings/cell)
```

The two numbers that matter are the last two, not the row count. **A row count can be
large and still describe four dense corridors.**

- `density` against the 200 images/km target says whether you hit the sizing model.
- `mean headings/cell` near 4.0 says coverage is *even*. Well under 2.0 with a healthy
  row count means the imagery is single-pass drive-bys — fine for retrieval from the
  same direction, weak from any other, which is a real recall limit worth recording for
  BENCH (§10).
- `leaf tiles complete` exceeding the root grid count is expected and healthy: it is the
  subdivision working.

In SQL, after loading:

```sql
-- Coverage holes: 0.005° ≈ 550 m blocks with fewer than 50 images.
SELECT round(lat/0.005) AS lat_b, round(lon/0.005) AS lon_b, count(*) AS n
FROM mapillary_images GROUP BY 1,2 HAVING count(*) < 50 ORDER BY n;

-- Heading balance. Four roughly equal buckets is the goal.
SELECT width_bucket(compass_angle, 0, 360, 4) AS sector, count(*)
FROM mapillary_images WHERE compass_angle IS NOT NULL GROUP BY 1 ORDER BY 1;

-- Staleness. Streetscapes change; old imagery quietly costs recall.
SELECT date_trunc('year', captured_at) AS yr, count(*)
FROM mapillary_images GROUP BY 1 ORDER BY 1;
```

Best visual check: load the exported NDJSON as a MapLibre point layer and look at it.
Holes are obvious to an eye and invisible in an aggregate.

---

## 9. Expected wall-clock, row counts, and cost

**Nobody has run this against the live API yet** — there is no Mapillary token
configured (see the pre-check gate in §0). The numbers below are derived from the
MASTER_PLAN §3 sizing model and the verified API limits, not measured. Replace them with
measurements from the first real run.

### Rows

| | |
|---|---|
| Pittsburgh city streets | ~1,600 km |
| Target density | 200 images/km (20 m × 4 headings) |
| **Projected indexable rows** | **~320,000** |
| Max possible buckets | 80,000 cells × 4 sectors = 320,000 (consistent by construction) |
| Raw candidates examined | ~1–3M, i.e. thinning discards 70–90% |
| Vectors at 512-d `halfvec` | ~330 MB (+ ~65 MB metadata, ~40 MB graph links) |

Comfortably inside the ≤2M-vectors-per-metro budget and the ~3M that Supabase XL handles
at <10 ms p99. Leaves room for metro #2 on the same instance.

If the pre-check projects materially less than 320k, **that is Mapillary's coverage, not
a bug in the thinning** — check `coverage_fraction` and `thinning_ratio` to tell which.

### Wall-clock

| Stage | Estimate | Bound by |
|---|---|---|
| `precheck` | <1 min, ~40 requests | round-trips |
| `run` | **15–25 min**, ~1,000–1,400 requests, ~1 GB in | JSON transfer + per-candidate SQLite work, *not* rate limits |
| `embed_index` | **6–12 h** on one warm L4 | GPU forward passes (0.13 s/img serial → 11.6 h; batching cuts it) + ~48 GB of thumbnail fetch |
| `load` | 2–5 min | round-trips |
| `build_index.sql` | **5–15 min** | HNSW build; >30 min means check `maintenance_work_mem` actually took effect before believing the MASTER_PLAN §3 migration trigger |

Embedding is the whole schedule. It parallelises linearly across Modal replicas — 4×L4
brings 8 h down to ~2 h for the same total GPU-hours and the same cost.

### Cost

| | |
|---|---|
| Mapillary imagery and API | **$0** — no paid tier, no quota to buy |
| Modal L4 for embedding | **$5–12 one-time per metro** (~8–12 GPU-hours at $0.80/hr) |
| Storage | inside the existing Supabase XL line ($210/mo, shared with the app DB) |
| **Marginal cost of metro #1's index** | **~$10, once** |

Not a monthly cost. The index is built once and only re-embedded if the descriptor model
changes.

---

## 10. Adding metro #2

1. Add a `Metro` to `METROS` in `services/harvest/harvest.py`: slug, display name, bbox
   (`minLon, minLat, maxLon, maxLat`), centreline `street_km`, land `area_km2`.
   `street_km` is only used to project row counts and sanity-check density against the
   sizing table — get it from the city's own street-mileage figure, not an estimate.
2. **Pre-check before anything else.** `precheck --metro <slug> --samples 40`. A
   `NO-GO` here saves a GPU day.
3. Check the vector budget *before* harvesting: existing rows + projected new rows
   against the ≤2M/metro and ~3M/instance ceilings in MASTER_PLAN §3. Exceeding them is
   the documented trigger to migrate to Qdrant or Turbopuffer, not to squeeze.
4. `run` → `embed_index` → `load`, then re-run `build_index.sql`. The build covers the
   whole table, so adding a metro means rebuilding the graph — schedule it, and watch the
   30-minute threshold.
5. Verify with `stats` and the coverage-hole query in §8 before anyone queries it.

Each metro gets its own checkpoint DB (`data/harvest/<slug>.harvest.sqlite`), so metros
can be harvested concurrently and resumed independently.

---

## 11. Files

| Path | What |
|---|---|
| `services/harvest/mapillary_api.py` | v4 client: token buckets, backoff, field allowlist, bbox guards |
| `services/harvest/metros.py` | metro registry: bboxes + measured `street_km` + provenance, projection maths, coverage-manifest row. Stdlib only — see §12 |
| `services/harvest/harvest.py` | CLI: `precheck` · `run` · `stats` · `export` · `load`; tiling, thinning, SQLite checkpoint |
| `services/harvest/embed_index.py` | EigenPlaces-512 via B1's service; SQLite or Postgres write-back |
| `services/harvest/build_index.sql` | HNSW build: `maintenance_work_mem`, `halfvec`, cosine ops, gates, `ANALYZE` |
| `services/harvest/attribution.ts` | Mapillary §11 attribution spec + helpers for A1 |
| `services/harvest/requirements.txt` | `httpx`, `psycopg` |
| `scripts/harvest/greenwich.sh` | metro #1, the runbook executable — `plan` · `precheck` · … · `manifest` |
| `scripts/harvest/pittsburgh.sh` | metro #2, same shape |
| `data/harvest/` | checkpoints, exports, pre-check reports, coverage manifests (gitignored) |

---

## 12. Greenwich, CT — metro #1

Metro #1 moved from Pittsburgh to Greenwich on 2026-07-31 for one reason: **the operator
lives there.** Every other candidate makes ground truth a research project. Here, a
disagreement between the index and reality is settled by walking outside with a phone,
so the feedback loop is minutes instead of never. That is worth more than street
mileage, and it is the only justification this decision needs. Pittsburgh is not
deleted — it is metro #2, unchanged, in `metros.py` and `scripts/harvest/pittsburgh.sh`.

### 12.1 The bboxes, and where they came from

All four boxes are derived from OpenStreetMap on **2026-07-31**, not estimated. Each
entry in `services/harvest/metros.py` carries its own `source` string with the exact
Nominatim relation and Overpass query; `metros.py --overpass <slug>` reprints the query
so any number here can be re-measured or audited.

| slug | bbox (`minLon,minLat,maxLon,maxLat`) | size | derived from |
|---|---|---|---|
| `greenwich-pilot` | `-73.6620,40.9880,-73.5530,41.0500` | 9.2 × 6.9 km | built-up shoreline strip: Byram → Old Greenwich |
| `greenwich` | `-73.7290,40.9860,-73.5530,41.1450` | 14.8 × 17.7 km | Nominatim relation **4119957** (Town of Greenwich) |
| `stamford` | `-73.5530,40.9860,-73.4945,41.1810` | 4.9 × 21.7 km | Nominatim relation **3306055**, west edge clipped |
| `fairfield-lower` | `-73.7290,40.9860,-73.1000,41.2600` | 52.7 × 30.5 km | Greenwich → Stratford coastal band |
| `fairfield` | `-73.7290,40.9860,-73.0645,41.6675` | 55.6 × 75.9 km | Nominatim relation **2516994** (historic county) |

Two adjustments were made to the raw administrative extents, and both matter:

- **The southern edge is trimmed to 40.9860, not the legal 40.9510.** Every Connecticut
  coastal town's boundary runs out into Long Island Sound to the New York state line.
  Greenwich's does; so does the county's. An Overpass `out bb` over relation 4119957
  puts the southernmost *mapped road* at **40.98848 N** (Great Captain Island). Below
  that is open water. The trim removes 2 full rows from the Greenwich root grid and 20
  from the county grid at zero cost in imagery.
- **Stamford's west edge is clipped from −73.6340 to −73.5530** so it abuts the
  Greenwich box rather than overlapping it by ~7 km. This is not cosmetic. `mapillary_id`
  is the primary key and `load` is `ON CONFLICT DO NOTHING`, so an image found by two
  harvests keeps whichever `metro` label was loaded first — and the second metro's row
  count then silently under-reports its own area. Clipping keeps `metro` an actual
  partition. West Stamford is still covered; it is covered by the `greenwich` box.

### 12.2 The number that will surprise you

The town of Greenwich has **667 km** of drivable public street inside its polygon
(Overpass, 2026-07-31). Pittsburgh has 1,600 km. That 2.4× is the whole reason this
metro is cheap, and it is real.

But **the harvester enumerates a rectangle, not a polygon.** Greenwich is a tall narrow
parallelogram wedged against the New York line, so its bounding rectangle also contains
**511 km of New York State** (Port Chester, Rye Brook, Purchase, Armonk) and ~197 km of
west Stamford. Measured inside the actual `greenwich` bbox: **1,375 km**, 4,826 ways.

So stage 1 projects **275,000 images, not 133,000.** Budget against the rectangle
figure, always — `metros.py` stores `street_km` measured inside the bbox for exactly
this reason, and `precheck`'s `sizing_table_target` is derived from it.

The New York spill is not waste. It is contiguous suburban Northeast within a
ten-minute drive of the operator, which makes it testable ground truth too. It does
double the embed bill, which is what `greenwich-pilot` exists to avoid.

### 12.3 Staging, with the vector budget checked at every step

`street_km × 200` is the "Practical (20 m, 4 headings)" row of MASTER_PLAN §3. Run
`python3 services/harvest/metros.py --ladder greenwich` for this table live.

| stage | slug | street km in bbox | root tiles | images | vectors | cumulative | % of ~3M instance |
|---|---|---|---|---|---|---|---|
| 0 | `greenwich-pilot` | 396 | 91 | **79,200** | 81 MB | 79,200 | 3% |
| 1 | `greenwich` | 1,375 | 360 | **275,000** | 282 MB | 275,000 | 9% |
| 2 | `stamford` | 593 | 154 | **118,600** | 121 MB | 393,600 | 13% |
| 3 | `fairfield-lower` | 6,206 | 2,170 | **1,241,200** | 1,271 MB | 1,241,200 | 41% |
| — | `fairfield` | 14,380 | 5,624 | **2,876,000** | 2,945 MB | — | **96% — does not fit** |

Stage 2 is an **increment**, not a superset: harvest `stamford` *alongside* `greenwich`,
and the pair tiles the area between them with no interior overlap. Stage 3 *is* a
superset of stages 0–2, so if you have already loaded them their rows keep their own
`metro` labels and only the new area lands under `fairfield-lower`. That is correct
behaviour, and §13 is how the API copes with it. **If lower Fairfield is where you are
going anyway, harvest that box first and skip stages 1–2** — re-walking tiles is cheap,
re-embedding the same 275k images under a second slug is not.

**Full Fairfield County does not fit, and the arithmetic is worth writing down.** Inside
the county polygon it is 8,369 km ⇒ 1.67M vectors — already 56% of the instance budget.
But the county is an L wrapped around the New York line, so its *rectangle* swallows
Westchester and Putnam counties NY and part of New Haven County CT: **14,380 km ⇒ 2.88M
vectors**, over the ≤2M-per-metro ceiling and over the ~3M-per-instance ceiling at once,
with nothing left for metro #2. Three ways out, in preference order: (1) stop at
`fairfield-lower`; (2) harvest the county as several bboxes tracking its actual shape,
each its own metro; (3) treat it as the documented MASTER_PLAN §3 migration trigger to
Qdrant or Turbopuffer. Dropping to lean density (100 img/km) still gives 1.44M and buys
nothing but a thinner index.

### 12.4 Coverage: there is no way to measure it without a token, and here is the proof

`harvest.py precheck` needs `MAPILLARY_ACCESS_TOKEN`. Before writing that off as a
formality, every unauthenticated route was tried on **2026-07-31**:

| Probe | Result |
|---|---|
| `GET graph.mapillary.com/images?bbox=…` no auth | HTTP 500, `OAuthException` code 190 "Invalid OAuth 2.0 Access Token" |
| `GET graph.mapillary.com/<image_id>` no auth | same |
| `GET tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}` no token | **HTTP 403**, 0 bytes |
| `GET tiles.mapillary.com/maps/vtp/mly_map_feature_point/…` no token | **HTTP 403**, 0 bytes |
| legacy `a.mapillary.com/v3/images` | host no longer resolves |
| OSM objects tagged `mapillary=*` as a proxy | 6 in Greenwich, 1 in Pittsburgh — measures OSM mapper convention, not Mapillary coverage. Dead end; do not retry it |

The API documentation agrees: *"All requests against `https://graph.mapillary.com` and
`https://tiles.mapillary.com` must be authorized."* **There is no unauthenticated
endpoint and no public coverage tile.** The web viewer at `www.mapillary.com/app` does
render coverage without a login, and a human is welcome to eyeball it in a browser —
but this pipeline does not touch `www.mapillary.com` (Terms §5, and see the
`mapillary_api.py` module docstring), and borrowing the client token embedded in that
page's JavaScript is somebody else's credential, not ours.

So: **Fairfield County is dense suburban Northeast and probably has good contributor
coverage — and "probably" is not a number.** Nothing in this repo asserts Greenwich
coverage. The pre-check is one command and it is the first thing the script runs:

```bash
export MAPILLARY_ACCESS_TOKEN='MLY|...'
python3 services/harvest/harvest.py precheck --metro greenwich-pilot --samples 60 \
  --json-out data/harvest/greenwich-pilot.precheck.json
```

60 samples rather than Pittsburgh's 40 because roughly 30% of the Greenwich box is Long
Island Sound and water tiles dilute the estimate.

### 12.5 Reading the verdict at this scale — the thresholds do not transfer

§0's verdict table (`≥100k` = GO, `<50k` = NO-GO) is **absolute**, and it was written
for a 1,600 km city. The `greenwich-pilot` box supports **79,200 images at perfect
coverage**, so it can never reach the GO line, and a genuinely usable harvest at 60% of
its own sizing model trips the NO-GO line. The fallback text it prints ("widen to
Allegheny County") is Pittsburgh boilerplate.

Read the **ratio** instead — `projected_indexable_images / sizing_table_target`:

| ratio | reading |
|---|---|
| ≥ 0.75 | healthy; Mapillary coverage supports the sizing model here |
| 0.40 – 0.75 | usable with holes. Expect misses in whole neighbourhoods, not just on hard images. Record which, for BENCH (§10) |
| < 0.40 | thin. Widening will not fix it — it buys more thin area. Check `coverage_fraction` and `thinning_ratio` to tell coverage from over-thinning |

`scripts/harvest/greenwich.sh precheck` prints exactly this interpretation after the
raw report, and exits non-zero on a NO-GO. If the ratio is healthy but the absolute
verdict is NO-GO, `FORCE=1` proceeds — deliberately, loudly, and worth recording
wherever BENCH caveats are recorded. `coverage_fraction` below 0.50 is *expected* here:
with a ~30% water box its ceiling is near 0.70 even with perfect coverage.

### 12.6 The one command sequence

Nothing below runs until a token exists. Getting one is free, instant, and has no
approval queue: sign in at <https://www.mapillary.com>, open
<https://www.mapillary.com/dashboard/developers>, register an application with read
scopes only, copy the **client** token (`MLY|<app_id>|<secret>`). Imagery access is
**$0** — there is no paid tier to reach.

```bash
# 0. once
python3 -m venv .venv && source .venv/bin/activate
pip install -r services/harvest/requirements.txt

# 1. projected counts and dollar cost — no token, no network, no dependencies
scripts/harvest/greenwich.sh plan

# 2. the whole runbook, gated on a real coverage measurement
export MAPILLARY_ACCESS_TOKEN='MLY|...'
export INFERENCE_SERVICE_URL='https://…'      # B1's Modal endpoint
export DATABASE_URL='postgres://…'
scripts/harvest/greenwich.sh all
```

`all` runs `plan → precheck → confirm → run → stats → embed → load → build_index.sql →
manifest`, stopping at the confirmation prompt with the real projected counts in front
of you. Every stage is resumable and idempotent: re-run `all` after an interruption and
it picks up where it stopped, without duplicating a row or re-embedding one.

Widen by slug — each metro gets its own checkpoint, so they resume independently:

```bash
METRO=greenwich       scripts/harvest/greenwich.sh all
METRO=stamford        scripts/harvest/greenwich.sh all
METRO=fairfield-lower scripts/harvest/greenwich.sh all   # check §12.3 first
```

Individual stages, for when something needs re-running on its own:

```bash
scripts/harvest/greenwich.sh precheck | harvest | embed | load | index | stats | manifest
```

### 12.7 Expected wall-clock, row counts, and cost

Derived from the MASTER_PLAN §3 sizing model and the §9 Pittsburgh anchors, scaled by
measured street kilometres. **Not measured — nobody has run this against the live API.**
Replace these with real numbers after the first run.

| Stage | `greenwich-pilot` | `greenwich` | `stamford` | `fairfield-lower` |
|---|---|---|---|---|
| `precheck` | <1 min, ~60 req | <1 min, ~60 req | <1 min, ~60 req | ~1 min, ~80 req |
| `run` (walk) | **2–3 min** | **7–12 min** | **3–5 min** | **43–74 min** |
| `embed_index` | **1.5–3.0 h** | **5.2–10.4 h** | **2.3–4.5 h** | **23.6–47.2 h** |
| thumbnails fetched | ~12 GB | ~41 GB | ~18 GB | ~186 GB |
| `load` | ~1 min | 1–2 min | ~1 min | 3–6 min |
| `build_index.sql` | **1–4 min** | **4–12 min** | **2–5 min** | **20–50 min** |
| indexable rows | **79,200** | **275,000** | **118,600** | **1,241,200** |
| `maintenance_work_mem` needed | **≥138 MB** | **≥479 MB** | **≥206 MB** | **≥2.2 GB** |
| total in Postgres | 108 MB | 376 MB | 162 MB | 1.7 GB |
| **Modal L4, one-time** | **$1–2** | **$4–8** | **$2–4** | **$19–38** |

Mapillary imagery and API: **$0**, at every stage. Storage sits inside the existing
Supabase XL line. **Token to queryable pilot index: about 2–4 hours, ~$2, and all but
five minutes of it is the GPU.**

The `maintenance_work_mem` row is the one to actually act on. Even the 79k-row pilot
needs ~138 MB and the Postgres default is **64 MB** — over 2× short. The §6 trap is not
something only big metros hit; a small index just fails silently faster.

`build_index.sql` rebuilds the HNSW graph over the **whole table**, so adding any
Greenwich stage means rebuilding Pittsburgh's rows too if they are loaded. Schedule it,
and watch the 30-minute MASTER_PLAN §3 migration threshold.

### 12.8 Verifying coverage actually landed — before trusting any street-level result

`precision: 'street'` is gated by `assertStreetPrecisionIsEarned()` in the contracts,
which requires a `vpr-match` in the evidence chain. That assertion is about the *shape*
of a result. It cannot tell you whether the index behind the match has any imagery on
the street in question. Do all four of these before letting anyone query the metro.

**1. Density and evenness, not the row count.**

```bash
python3 services/harvest/harvest.py stats --metro greenwich-pilot
```

Target is 200 images/km against the box's `street_km` (396 for the pilot), and
`mean headings/cell` near 4.0. A big row count with `mean headings/cell` under 2.0 is
single-pass drive-bys: fine for retrieval from the same direction, weak from any other,
and a real recall limit to record for BENCH. Read §8 for the full interpretation.

**2. Holes, in SQL, per metro.** §8's block query, scoped — Greenwich's box is mostly
water and backcountry estate lots, so an unscoped hole count is meaningless here:

```sql
SELECT round(lat/0.005) AS lat_b, round(lon/0.005) AS lon_b, count(*) AS n
FROM mapillary_images
WHERE metro = 'greenwich-pilot'
GROUP BY 1,2 HAVING count(*) < 50
ORDER BY n;
```

**3. The manifest, which is what the API will actually read.**

```bash
scripts/harvest/greenwich.sh manifest
```

Check `target_attainment` and `embedded_count == image_count`. See §13.

**4. Go outside.** This is the entire reason Greenwich is metro #1 and it is not a
joke. Stand on a street inside the pilot box, take a photo, run it through the cascade,
and see whether the returned candidates are the block you are standing on. Ten photos
across ten different streets — including one deliberately hard one, a hedge-lined
backcountry road with no signage — will tell you more about this index in twenty
minutes than any aggregate. Log them as the first BENCH entries (§10). No other metro
can be checked this way, which is exactly why the numbers above were worth trading away.

---

## 13. Coverage manifest — how the UI earns the right to say "street precision available"

Raven's UI shows "Street precision available" only on results in areas their street
index actually covers. We need the same honesty, and here it is not a UI decision — it
is a data question that **cannot currently be answered at all.**

`mapillary_images` carries `metro` and `index_build` on every row (see
`supabase/migrations/20260729180500_reference_data.sql`), so the API can count rows for
a metro and prune on `(metro, index_build)` before the ANN order-by. What it cannot do
is the thing the UI needs: **a metro slug is not a geometry.** Nothing in that schema
says where `'greenwich'` *is*, so given a lat/lon nothing can decide which metro it
falls in, or whether any metro covers it at all. The only way to answer it from the
existing table is `SELECT ... WHERE lat BETWEEN … AND lon BETWEEN …`, which is a
sequential probe of a multi-million-row table to answer a question about metadata.

Worse, the honest answer is not even "yes/no per metro". Stage 1 covers 1,375 km of
rectangle at maybe 70% attainment: some blocks inside the box have 400 images and some
have zero. "Street precision available in Greenwich" is false at the granularity that
matters. The gate has to be per-block, and it needs a recorded threshold to compare
against.

So the harvest must record a **coverage manifest row per (metro, index_build)**.
`scripts/harvest/greenwich.sh manifest` emits exactly this, straight from the
checkpoint, to `data/harvest/<metro>.coverage.json` — no Postgres and no extra harvest
pass. The row shape is built by `coverage_manifest_row()` in `services/harvest/metros.py`,
which is the authoritative definition.

### 13.1 What a coverage-manifest row contains

| Field | Type | Why it is in the row |
|---|---|---|
| `manifest_version` | int | Lets a consumer refuse a shape it does not understand instead of misreading one |
| **`metro`** | text | Joins to `mapillary_images.metro`. The submap key retrieval prunes on |
| **`index_build`** | text | Joins to `mapillary_images.index_build`, e.g. `mapillary-greenwich-pilot@2026-08-01`. Copied into every `ResultProvenance.indexBuild`; reproducibility is a Daubert requirement |
| `display_name` | text | What the UI is allowed to call this area |
| **`min_lon` `min_lat` `max_lon` `max_lat`** | float8 | **The missing geometry.** The entire reason this table exists |
| `bbox_area_km2` | int | Sanity/reporting |
| **`image_count`** | int | Rows this harvest kept |
| **`embedded_count`** | int | Rows with a vector. `image_count − embedded_count > 5%` means the index is partial and `build_index.sql` will refuse |
| `distinct_cells` | int | With `image_count`, gives mean headings/cell — evenness, not just volume |
| `street_km` | int | Measured inside the bbox (§12.2) |
| `images_per_km` | float | Achieved density against the 200/km target |
| `sizing_target_images` | int | `street_km × 50 × heading_sectors` |
| **`target_attainment`** | float | `image_count / sizing_target_images`. The single number that says how well this metro is actually covered |
| `cell_meters` · `heading_sectors` | float · int | Two metros are only comparable at equal grids. A metro harvested at 8 sectors must not be judged against a 4-sector floor |
| `coverage_fraction` | float | From the pre-check: share of sampled tiles with any imagery |
| `median_capture_year` | int | Staleness. Streetscapes change; old imagery quietly costs recall |
| `precheck_report` | text | Path/URI to the full pre-check JSON, so a disputed result can be traced to the measurement that justified building the index |
| **`harvested_at`** | timestamptz | Harvest date. "This index is from 2026-08" is a caveat a report has to be able to state |
| `source` | text | `'mapillary'`. There will be other sources; there will never be a GSV-derived one |
| `attribution_required` | bool | Mapillary ToS §11 attribution is mandatory wherever these images surface — `services/harvest/attribution.ts` |
| `bbox_source` | text | Provenance of the bbox and `street_km`, verbatim from `metros.py` |
| **`min_images_for_street_precision`** | int | Default 50 — the per-block floor. In the row, not a constant in the API, because it is a property of how this metro was harvested |
| `hole_block_degrees` | float8 | Default 0.005 (~550 m). Same block size as the §8 hole query; one definition of "covered", not two |

### 13.2 The table A2 needs to ship

Not written by this agent — `supabase/migrations/` is A2's. This is the shape the
harvest is already producing.

```sql
create table public.mapillary_coverage (
  metro            text not null,
  index_build      text not null,
  primary key (metro, index_build),

  display_name     text not null,

  -- The geometry mapillary_images does not have.
  min_lon          double precision not null,
  min_lat          double precision not null,
  max_lon          double precision not null,
  max_lat          double precision not null,
  bbox_area_km2    integer,

  image_count      integer not null check (image_count >= 0),
  embedded_count   integer not null check (embedded_count >= 0),
  distinct_cells   integer,
  street_km        integer,
  sizing_target_images integer,
  target_attainment    double precision,

  cell_meters      double precision not null,
  heading_sectors  integer not null,

  coverage_fraction    double precision,
  median_capture_year  integer,
  precheck_report      text,

  harvested_at     timestamptz not null,
  source           text not null default 'mapillary',
  attribution_required boolean not null default true,
  bbox_source      text,

  min_images_for_street_precision integer not null default 50,
  hole_block_degrees              double precision not null default 0.005,

  manifest_version integer not null default 1,

  constraint mapillary_coverage_bbox_ordered
    check (min_lon < max_lon and min_lat < max_lat),
  -- An index the UI advertises but has not embedded is worse than no index: retrieval
  -- succeeds and silently cannot see most of the metro.
  constraint mapillary_coverage_embedded_le_total
    check (embedded_count <= image_count)
);

create index mapillary_coverage_bbox_idx
  on public.mapillary_coverage (min_lat, max_lat, min_lon, max_lon);
```

Same posture as `mapillary_images`: global reference data, readable by every
authenticated user, writable only by the service role, no tenant scoping, no customer
data.

### 13.3 The question the API answers with it

```sql
-- Which indexes claim to cover this point, and are they worth believing?
SELECT metro, index_build, display_name, target_attainment, harvested_at
FROM mapillary_coverage
WHERE $lat BETWEEN min_lat AND max_lat
  AND $lon BETWEEN min_lon AND max_lon;
```

Then, and only then, the per-block gate — a bbox hit is a *claim*, not coverage:

```sql
-- Does the specific block have enough imagery to support a street-precision claim?
SELECT count(*) >= c.min_images_for_street_precision
FROM mapillary_coverage c
JOIN mapillary_images m
  ON m.metro = c.metro AND m.index_build = c.index_build
WHERE c.metro = $metro
  AND m.embedding IS NOT NULL
  AND m.lat BETWEEN $lat - c.hole_block_degrees AND $lat + c.hole_block_degrees
  AND m.lon BETWEEN $lon - c.hole_block_degrees AND $lon + c.hole_block_degrees;
```

Three rules that fall out of this, all of which the UI has to honour:

1. **A bbox hit alone never earns "street precision available."** It earns "a street
   index claims this area." Only the block-level count above earns the badge. Skipping
   the second query is how you ship a UI that promises street precision over the Long
   Island Sound tiles in the Greenwich box.
2. **Coverage is a UNION of rows, never a single metro.** Stage 2 is `greenwich` +
   `stamford` as two disjoint boxes; stage 3 is a superset whose already-loaded rows
   keep their older `metro` labels (§12.1, §12.3). So retrieval prunes on
   `metro = ANY($1)` — the list returned by the first query — not `metro = $1`. A
   `metro = 'fairfield-lower'` query after staging would be blind to every row loaded
   as `greenwich`, return plausible neighbours from 20 km away, and look fine.
3. **No manifest row ⇒ no street precision, full stop.** Not "probably fine", not "we
   have a Greenwich index so Connecticut is covered." A missing row is the honest
   answer `precision: 'region'` and the refusal path the contracts already require.

`target_attainment`, `median_capture_year` and `harvested_at` are what turn the badge
into a sentence a report can defend: *"street-level match against the Mapillary
Greenwich index, build `mapillary-greenwich-pilot@2026-08-01`, harvested 2026-08-01,
77% of modelled density, median capture year 2023."* That is a `verifiable` string in
the sense `Evidence` requires. "Street precision available" on its own is not.
