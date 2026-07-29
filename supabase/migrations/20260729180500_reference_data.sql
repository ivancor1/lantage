-- Lantage — 06 · mapillary_images, benchmark_runs  (global reference data)
--
-- These two tables are NOT tenant-scoped. Every authenticated user reads them;
-- only the service role writes them. They carry no customer data.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- mapillary_images — the VPR index
-- ---------------------------------------------------------------------------

-- Mapillary is the only street-imagery source whose licence affirmatively permits
-- what this table is: ToS §12 names "datasets" and "algorithms" as permitted
-- commercial uses, and §11 contemplates self-hosting with attribution. Every
-- canonical VPR dataset (SF-XL, Pitts250k, Tokyo24/7, GSV-Cities, GWS15k) is
-- Google Street View and is therefore evaluation-only, forever. Nothing
-- GSV-derived may ever be inserted here.
--
-- PK is the Mapillary id itself, not a surrogate uuid: it is already globally
-- unique and stable upstream, and it is the join key for re-harvesting.
create table public.mapillary_images (
  mapillary_id   text primary key,

  lat            double precision not null check (lat between -90 and 90),
  lon            double precision not null check (lon between -180 and 180),

  -- Compass heading. Load-bearing for density: 4 headings per location at 20 m
  -- spacing is the practical harvest unit (~200 images/km).
  compass_angle  double precision check (compass_angle between 0 and 360),
  captured_at    timestamptz,

  thumb_url      text not null,
  sequence_id    text,
  is_pano        boolean not null default false,

  -- Mapillary ToS §12 requires "technical safeguards and business processes that
  -- prohibit reidentification or unblurring of any Content, including any
  -- individual or license plate." The CHECK is one of those safeguards: a row
  -- whose upstream blur is not intact cannot physically exist in this table, and
  -- we run no process that undoes blur. We also ship no ALPR.
  blur_applied   boolean not null default true,

  -- Retrieval submap key. The VLM's job is to prune the search space, and this is
  -- the column the pruning lands on.
  metro          text not null check (length(btrim(metro)) > 0),

  -- e.g. 'mapillary-pittsburgh@2026-08-02'. Copied into every
  -- ResultProvenance.indexBuild so a result maps to the exact index that produced
  -- it. Reproducibility is a Daubert requirement.
  index_build    text not null,

  -- EigenPlaces-512 / GeoCLIP → 512-d.
  --
  -- Not MegaLoc-8448: pgvector's HNSW dimension ceiling is 2,000 for `vector` and
  -- 4,000 for `halfvec`, so an 8448-d descriptor cannot be HNSW-indexed here at
  -- any price. It is also 16.5× the storage and 21× the latency. MegaLoc re-ranks
  -- the top 50 only, out of band.
  embedding      halfvec(512),

  created_at     timestamptz not null default now(),

  constraint mapillary_images_blur_intact check (blur_applied)
);

-- Submap pruning happens on these two before the ANN order-by ever runs.
create index mapillary_images_metro_build_idx on public.mapillary_images (metro, index_build);
create index mapillary_images_latlon_idx on public.mapillary_images (lat, lon);
create index mapillary_images_sequence_idx on public.mapillary_images (sequence_id) where sequence_id is not null;

comment on table public.mapillary_images is
  'Mapillary-derived VPR index. Global reference data: readable by all authenticated users, writable only by the service role. Never insert GSV-derived rows.';
comment on column public.mapillary_images.blur_applied is
  'Asserted true at ingest and CHECK-enforced. Mapillary ToS §12 technical safeguard against unblurring/reidentification.';

-- ---------------------------------------------------------------------------
-- benchmark_runs — BENCH
-- ---------------------------------------------------------------------------

-- We publish our error rate. This table is where the numbers on that page come
-- from, so a result can cite the measured performance of the exact model + index
-- build that produced it instead of a vendor claim.
create table public.benchmark_runs (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  -- Mirrors ResultProvenance.models, e.g. { "vpr": "eigenplaces-512@1.2" }.
  model_versions  jsonb not null default '{}'::jsonb,
  index_build     text,
  -- e.g. 'im2gps3k', 'gws15k', 'deepfake-eval-2024', 'chameleon'.
  dataset         text not null,
  -- Per-band recall / FPR / PPV. Bands publish their own measured FPR — that is
  -- what makes ConfidenceBand something other than a vibe.
  metrics         jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now()
);

create index benchmark_runs_dataset_at_idx on public.benchmark_runs (dataset, at desc);

comment on table public.benchmark_runs is
  'BENCH results. Global reference data. Each ConfidenceBand publishes its measured FPR from here.';
