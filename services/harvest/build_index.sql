-- ===========================================================================
-- Lantage — HNSW index build for the Mapillary VPR submap
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f services/harvest/build_index.sql
--
-- Run this per metro, AFTER embed_index.py has finished.
--
-- WHY THIS FILE EXISTS AT ALL, given that A2 already creates the index
-- -------------------------------------------------------------------
-- supabase/migrations/20260729180700_vector_indexes.sql creates
-- `mapillary_images_embedding_hnsw` during migration, on an EMPTY table — where it
-- is free. That is the right call, but it means the graph that exists after a bulk
-- harvest was built incrementally, one insert at a time, at whatever
-- maintenance_work_mem the ingest session happened to have (64 MB by default).
-- This script REBUILDS it in one pass with the memory it actually needs.
--
-- IT REINDEXES; IT DOES NOT REDEFINE
-- ----------------------------------
-- Verified against A2's migration on 2026-07-29:
--
--     create index mapillary_images_embedding_hnsw
--       on public.mapillary_images
--       using hnsw (embedding halfvec_cosine_ops);          -- BARE COLUMN
--
-- and search_geo_candidates() orders by `m.embedding <=> query_embedding` — also a
-- bare column reference. An expression index such as
-- `hnsw ((embedding::halfvec(512)) halfvec_cosine_ops)` would be a DIFFERENT index
-- that this query can never use: retrieval would silently fall back to a
-- sequential scan over the whole metro and still return plausible neighbours.
-- Mixing index and query expressions is the quietest way to disable an ANN index.
--
-- So the rebuild path here is REINDEX, which preserves the existing definition by
-- construction and therefore cannot drift from A2's migration. Do not replace it
-- with DROP + CREATE unless you are deliberately changing the index and are
-- changing A2's migration in the same commit.
--
-- Prerequisites
--   * pgvector >= 0.7.0 (halfvec, and halfvec HNSW support, arrived in 0.7.0)
--   * A2's migrations applied; `embedding halfvec(512)` populated by embed_index.py
--
-- Identifiers, per A2's migration: table `mapillary_images`; columns `embedding`,
-- `blur_applied`, `mapillary_id`, `lat`, `lon`, `metro`, `index_build`. SQL cannot
-- parameterise an identifier, so these are the one thing here that must be edited
-- by hand if the schema moves.
--
-- Idempotent: safe to re-run.
-- ===========================================================================

\timing on

-- ---------------------------------------------------------------------------
-- 1. maintenance_work_mem — THE trap. Read this before changing it.
-- ---------------------------------------------------------------------------
-- pgvector builds an HNSW graph IN MEMORY. If the graph does not fit in
-- maintenance_work_mem, Postgres does NOT error and does NOT warn at a level
-- anyone notices — it silently switches to a disk-based build that is 10-50x
-- slower. A 10-minute build becomes an overnight job and nothing tells you why.
--
-- The default is 64 MB. Our graph needs roughly:
--     rows x dim x bytes_per_component x ~1.7 (graph overhead)
--   = 320,000 x 512 x 2 (halfvec) x 1.7  ~=  560 MB
-- so 64 MB misses by ~9x and 8 GB has ample headroom for the whole metro plus
-- growth to the ~2M-vector ceiling in docs/MASTER_PLAN.md §3.
--
-- SET LOCAL scopes this to the current transaction, so we never leave an 8 GB
-- setting behind for autovacuum to inherit — that is how you OOM a box at 3am.
-- On Supabase, `ALTER DATABASE` alternatives are restricted; SET LOCAL works.
BEGIN;

SET LOCAL maintenance_work_mem = '8GB';

-- Parallel workers cut wall-clock on the build roughly linearly up to the number
-- of physical cores. Must be set alongside max_parallel_workers at the instance
-- level to actually take effect.
SET LOCAL max_parallel_maintenance_workers = 7;

-- Confirm what actually took effect, because a silently clamped value here is the
-- exact failure this whole comment block exists to prevent.
SELECT
  current_setting('maintenance_work_mem')            AS maintenance_work_mem,
  current_setting('max_parallel_maintenance_workers') AS parallel_workers;

-- ---------------------------------------------------------------------------
-- 2. Pre-build sanity gates
-- ---------------------------------------------------------------------------
-- Refuse to build over a half-embedded table. An HNSW graph over 40% of the rows
-- is worse than no index: retrieval succeeds, returns plausible neighbours, and
-- silently cannot see the other 60% of the metro.
-- NOTE: PL/pgSQL's RAISE has no printf precision specifiers — '%' is a positional
-- placeholder and nothing else, so '%.1f' would consume an argument and then print a
-- literal ".1f". Percentages are rounded in SQL and interpolated as plain '%'.
DO $$
DECLARE
  total    bigint;
  embedded bigint;
  bad_dim  bigint;
  pct      numeric;
BEGIN
  SELECT count(*) INTO total FROM mapillary_images;
  SELECT count(*) INTO embedded FROM mapillary_images WHERE embedding IS NOT NULL;

  IF total = 0 THEN
    RAISE EXCEPTION 'mapillary_images is empty — run harvest.py then embed_index.py first';
  END IF;

  pct := round(100.0 * embedded / total, 1);

  IF embedded < total THEN
    RAISE WARNING
      'only % of % rows are embedded (% percent). Rows without a vector are invisible to retrieval.',
      embedded, total, pct;
  END IF;

  IF embedded < total * 0.95 THEN
    RAISE EXCEPTION
      'refusing to build: % percent embedded, below the 95 percent floor. Finish '
      'embed_index.py (it is resumable and skips completed rows) or override this '
      'check deliberately.', pct;
  END IF;

  -- 512 is load-bearing. pgvector's HNSW dimension ceiling is 2,000 for `vector`
  -- and 4,000 for `halfvec`, so a MegaLoc-8448 descriptor cannot be indexed here at
  -- any price. The halfvec(512) column type already enforces this at insert time;
  -- this check exists so a future column-type change cannot quietly widen it.
  -- See docs/MASTER_PLAN.md §3, decision 1.
  SELECT count(*) INTO bad_dim
  FROM mapillary_images
  WHERE embedding IS NOT NULL AND vector_dims(embedding::vector) <> 512;

  IF bad_dim > 0 THEN
    RAISE EXCEPTION '% rows have a non-512-d embedding — cannot HNSW-index this column', bad_dim;
  END IF;

  -- The blur safeguard, re-asserted at the last possible moment. Mapillary Terms
  -- §12 requires technical safeguards against unblurring/reidentification; every
  -- row in this table is asserted blurred at ingest (harvest.py) and we do not let
  -- an unasserted row into the index.
  IF EXISTS (SELECT 1 FROM mapillary_images WHERE blur_applied IS NOT TRUE) THEN
    RAISE EXCEPTION
      'rows exist with blur_applied IS NOT TRUE — refusing to index. Mapillary ToS §12.';
  END IF;

  RAISE NOTICE 'pre-build gates passed: % rows, % embedded, all 512-d, all blur-asserted',
    total, embedded;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Rebuild the graph
-- ---------------------------------------------------------------------------
-- REINDEX, not DROP + CREATE — see the header. It reuses the definition already in
-- the catalog, so the rebuilt graph is guaranteed to still match the bare-column
-- `embedding <=> $1` in search_geo_candidates().
--
-- For the record, the definition it preserves and why each part is right:
--   halfvec           2 bytes/component instead of 4. Half the RAM and index size
--                     at <1% recall cost on L2-normalised descriptors
--                     (MASTER_PLAN §3) — which EigenPlaces output is, and which
--                     embed_index.py verifies per vector.
--   halfvec_cosine_ops  matches the <=> operator the query helpers use. Mixing
--                     operators between index and query silently disables the index.
--   m=16, ef_construction=64  pgvector's defaults, and the right starting point:
--                     raising ef_construction costs build time, and there is no
--                     point tuning it before BENCH (§10) has an error rate to move.
--
-- Plain REINDEX (not CONCURRENTLY) because it can run inside this transaction and
-- therefore under SET LOCAL. It takes an ACCESS EXCLUSIVE lock, so retrieval is
-- unavailable for the duration — fine for an index build on a table nobody is
-- querying yet. Once the index is serving traffic, use REINDEX INDEX CONCURRENTLY
-- instead, outside a transaction, with `SET maintenance_work_mem` in the session.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'mapillary_images_embedding_hnsw'
  ) THEN
    -- Only reachable if A2's migration has not been applied. Create it with the
    -- exact definition from 20260729180700_vector_indexes.sql — if you change this,
    -- change that migration in the same commit.
    RAISE NOTICE 'mapillary_images_embedding_hnsw is missing — creating it';
    EXECUTE 'CREATE INDEX mapillary_images_embedding_hnsw ON public.mapillary_images '
            'USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64)';
  ELSE
    RAISE NOTICE 'rebuilding mapillary_images_embedding_hnsw in one pass';
    EXECUTE 'REINDEX INDEX mapillary_images_embedding_hnsw';
  END IF;
END $$;

-- The geographic pre-filter for region-pruned retrieval (cascade §3 step 3) is
-- already `mapillary_images_latlon_idx` in A2's migration, and the submap prune is
-- `mapillary_images_metro_build_idx`. Deliberately not duplicated here: a second
-- index on (lat, lon) costs write throughput and buys nothing.
REINDEX INDEX mapillary_images_latlon_idx;
REINDEX INDEX mapillary_images_metro_build_idx;

COMMIT;

-- ---------------------------------------------------------------------------
-- 4. ANALYZE — outside the transaction, and not optional
-- ---------------------------------------------------------------------------
-- The planner has no statistics for a brand-new index. Until ANALYZE runs it will
-- happily choose a sequential scan over the HNSW graph and the index looks like it
-- did nothing.
ANALYZE mapillary_images;

-- ---------------------------------------------------------------------------
-- 5. Post-build verification
-- ---------------------------------------------------------------------------
SELECT
  c.relname                                            AS index_name,
  pg_size_pretty(pg_relation_size(c.oid))              AS index_size,
  pg_size_pretty(pg_relation_size('mapillary_images')) AS table_size,
  (SELECT count(*) FROM mapillary_images)              AS rows
FROM pg_class c
WHERE c.relname IN (
  'mapillary_images_embedding_hnsw',
  'mapillary_images_latlon_idx',
  'mapillary_images_metro_build_idx'
);

-- Per-metro row counts and build tags. More than one index_build for a metro means
-- two harvests were mixed, and a result citing one of them is not reproducible.
SELECT metro, index_build, count(*) AS rows, count(embedding) AS embedded
FROM mapillary_images
GROUP BY 1, 2 ORDER BY 1, 2;

-- Confirm the planner will actually use the graph.
--
-- The probe vector is interpolated as a LITERAL rather than written as a scalar
-- subquery. pgvector only considers the HNSW index when the right-hand operand of
-- <=> is effectively constant; a subquery there produces a Seq Scan plan and would
-- make this check report a failure that is not real.
--
-- The ORDER BY is a BARE `embedding <=> …`, matching both the index definition and
-- search_geo_candidates(). If this plan uses the index, so will real retrieval.
DO $$
DECLARE
  probe     text;
  plan_line text;
  used      boolean := false;
BEGIN
  SELECT embedding::text INTO probe
  FROM mapillary_images WHERE embedding IS NOT NULL LIMIT 1;

  FOR plan_line IN EXECUTE format(
    'EXPLAIN (COSTS OFF) SELECT mapillary_id FROM mapillary_images '
    'WHERE embedding IS NOT NULL '
    'ORDER BY embedding <=> %L::halfvec(512) LIMIT 10', probe)
  LOOP
    RAISE NOTICE '%', plan_line;
    IF plan_line LIKE '%mapillary_images_embedding_hnsw%' THEN
      used := true;
    END IF;
  END LOOP;

  IF used THEN
    RAISE NOTICE 'OK — the planner uses mapillary_images_embedding_hnsw.';
  ELSE
    RAISE WARNING
      'the planner did NOT choose mapillary_images_embedding_hnsw. Check, in order: '
      '(1) ANALYZE ran; (2) the index is on the BARE column with halfvec_cosine_ops '
      'and the query uses <=> on the bare column — an expression index here can '
      'never serve search_geo_candidates(); (3) the table is large enough that a '
      'sequential scan is not genuinely cheaper.';
  END IF;
END $$;

-- Query-time recall knob, for reference — set per session, not here:
--   SET hnsw.ef_search = 100;   -- default 40; raise for recall, lower for latency
-- MASTER_PLAN §3 budgets ~170 ms for this step and flags migration to Qdrant at
-- >20M vectors, p95 >100 ms, or build time >30 min. Record this build's timing
-- (\timing is on) against that threshold.
