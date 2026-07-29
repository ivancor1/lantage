-- Lantage — 08 · HNSW indexes
--
-- ⚠ READ supabase/README.md § "The maintenance_work_mem trap" BEFORE running this
--   on a table that already holds rows.
--
--   maintenance_work_mem defaults to 64 MB. If the HNSW graph does not fit in it,
--   Postgres does NOT warn, does NOT fail, and does NOT log at default settings —
--   it silently falls back to a disk-based build that is 10–50× slower. A build
--   you expected to take 4 minutes takes 3 hours and looks identical while doing it.
--
--   Run this first, in the same session as the build:
--
--       SET maintenance_work_mem = '8GB';
--       SET max_parallel_maintenance_workers = 7;
--
--   On an empty table (the case during a fresh migration) this is free, which is
--   why the indexes are created here rather than after bulk ingest.

set search_path = public, extensions;

-- Cosine distance (<=>) for both. EigenPlaces and DINOv2 descriptors are
-- L2-normalized, so cosine and inner product rank identically — cosine is chosen
-- because it is the operator the query helpers use and mixing operators between
-- index and query silently disables the index.
--
-- m = 16, ef_construction = 64 are the pgvector defaults and the right starting
-- point. Raise ef_construction (128–200) only if measured recall@10 is short;
-- it costs build time, not query time.

create index mapillary_images_embedding_hnsw
  on public.mapillary_images
  using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);

create index corpus_records_embedding_hnsw
  on public.corpus_records
  using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);

comment on index public.mapillary_images_embedding_hnsw is
  'Global HNSW over all metros. When a second metro lands, replace with partial indexes per metro — see supabase/README.md.';

-- ef_search is deliberately NOT set here.
--
-- It is a read-time knob (default 40) and the right value depends on how hard the
-- query is filtered, not on how the index was built. Baking a high value into the
-- index makes every cheap query pay for the expensive ones. Set it per query with
-- SET LOCAL inside the transaction instead — search_geo_candidates() does exactly
-- that in 20260729180900_search_functions.sql.
--
-- The escalation path when one metro is no longer the whole index: a partial HNSW
-- index per metro, so the filter and the graph agree and the ANN walk never
-- traverses another city's vectors.
--
--     SET maintenance_work_mem = '8GB';
--     CREATE INDEX CONCURRENTLY mapillary_images_embedding_hnsw_pittsburgh
--       ON public.mapillary_images USING hnsw (embedding halfvec_cosine_ops)
--       WHERE metro = 'pittsburgh';
--
-- Migration trigger away from pgvector entirely (MASTER_PLAN §3): >20M vectors,
-- p95 >100 ms, or build time >30 min. pgvector's practical single-node ceiling is
-- ~50M vectors.
