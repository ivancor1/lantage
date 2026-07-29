-- Lantage — 10 · region-pruned ANN retrieval
--
-- "The vision model's job is not to answer. It's to prune the search space."
-- (arXiv 2507.17455, adopted as the spine of the GEO cascade — MASTER_PLAN §3.)
--
-- This file is where that sentence becomes SQL. The ordering is the whole point:
-- the metro / index_build / bbox predicates cut the candidate set FIRST, and only
-- then does the cosine order-by run. Written the other way round — ANN over the
-- planet, then filter — the same query returns the same shape and is both slower
-- and worse, because the top-k the graph walk returns is dominated by vectors that
-- the filter is about to throw away.
--
-- Verify with EXPLAIN (ANALYZE, BUFFERS) that the plan shows the metro predicate
-- applied before the index scan's ordering, and that rows-removed-by-filter is
-- small. If it is large, the graph is being walked outside the submap; build the
-- per-metro partial HNSW index documented in supabase/README.md.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- search_geo_candidates — VPR retrieval against the Mapillary submap
-- ---------------------------------------------------------------------------

create or replace function public.search_geo_candidates(
  query_embedding  halfvec(512),
  p_metro          text default null,
  p_index_build    text default null,
  -- [min_lon, min_lat, max_lon, max_lat] — GeoJSON / Mapillary bbox order, which
  -- is also SearchRequest.hints.bbox order. Lon first. Getting this backwards
  -- silently returns zero rows, so it is asserted below rather than trusted.
  p_bbox           double precision[] default null,
  p_limit          integer default 50,
  -- Read-time HNSW breadth. Not baked into the index: the right value depends on
  -- how hard THIS query is filtered. 40 is the pgvector default; a hard bbox
  -- filter wants more, an unfiltered metro query wants less.
  p_ef_search      integer default 100
)
returns table (
  mapillary_id   text,
  lat            double precision,
  lon            double precision,
  compass_angle  double precision,
  captured_at    timestamptz,
  thumb_url      text,
  sequence_id    text,
  is_pano        boolean,
  metro          text,
  index_build    text,
  distance       double precision,
  similarity     double precision
)
language plpgsql
-- VOLATILE, not STABLE, and not by accident: PL/pgSQL executes a non-volatile
-- function's body with SPI read_only = true, which rejects utility statements
-- outright — "SET is not allowed in a non-volatile function". The per-query
-- SET LOCAL below is worth more than the planner's stable-function inlining,
-- which does nothing for a set-returning function called as an RPC anyway.
volatile
set search_path = public, extensions, pg_catalog
as $$
declare
  eff_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  eff_ef    integer;
begin
  if p_bbox is not null and array_length(p_bbox, 1) <> 4 then
    raise exception
      'p_bbox must be exactly [min_lon, min_lat, max_lon, max_lat]; got % elements',
      array_length(p_bbox, 1)
      using errcode = '22023';
  end if;

  if p_bbox is not null and (p_bbox[1] > p_bbox[3] or p_bbox[2] > p_bbox[4]) then
    raise exception
      'p_bbox is inverted: expected [min_lon, min_lat, max_lon, max_lat], got [%, %, %, %]',
      p_bbox[1], p_bbox[2], p_bbox[3], p_bbox[4]
      using errcode = '22023';
  end if;

  -- ef_search must be >= the requested limit or HNSW cannot return a full page.
  eff_ef := least(greatest(coalesce(p_ef_search, 100), eff_limit), 1000);

  -- SET LOCAL, so it dies with the transaction and never leaks into an unrelated
  -- query on a pooled connection. Wrapped because these GUCs only exist once the
  -- vector extension is loaded and iterative_scan needs pgvector >= 0.8 — on an
  -- older build we degrade to default breadth rather than failing the search.
  begin
    execute format('set local hnsw.ef_search = %s', eff_ef);
  exception when others then
    null;
  end;

  -- The filtered-ANN fix. Without it, HNSW returns ef_search candidates and THEN
  -- applies the metro/bbox predicate, so a tight filter can silently yield fewer
  -- rows than requested — the classic "my vector search lost results" bug.
  -- Iterative scan keeps resuming the walk until the limit is genuinely filled.
  begin
    execute 'set local hnsw.iterative_scan = ''relaxed_order''';
  exception when others then
    null;
  end;

  return query
  select
    m.mapillary_id,
    m.lat,
    m.lon,
    m.compass_angle,
    m.captured_at,
    m.thumb_url,
    m.sequence_id,
    m.is_pano,
    m.metro,
    m.index_build,
    (m.embedding <=> query_embedding)::double precision       as distance,
    (1 - (m.embedding <=> query_embedding))::double precision  as similarity
  from public.mapillary_images m
  where m.embedding is not null
    -- ── prune ──────────────────────────────────────────────────────────────
    and (p_metro is null or m.metro = p_metro)
    and (p_index_build is null or m.index_build = p_index_build)
    and (
      p_bbox is null
      or (m.lon between p_bbox[1] and p_bbox[3] and m.lat between p_bbox[2] and p_bbox[4])
    )
  -- ── then, and only then, rank ─────────────────────────────────────────────
  order by m.embedding <=> query_embedding
  limit eff_limit;
end;
$$;

comment on function public.search_geo_candidates(halfvec, text, text, double precision[], integer, integer) is
  'Region-pruned VPR retrieval. Filters by metro/index_build/bbox first, then orders by cosine distance. bbox is [min_lon, min_lat, max_lon, max_lat].';

grant execute on function public.search_geo_candidates(halfvec, text, text, double precision[], integer, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- search_corpus_records — CLAIM self-match
-- ---------------------------------------------------------------------------

-- Same discipline, different pruning key: the corpus, not the metro. The corpus_id
-- filter is also the tenancy boundary, so it is required — there is no "search all
-- corpora" mode, by design. SECURITY INVOKER, so corpus_records RLS still applies
-- and a caller cannot reach another org's vectors even with a valid corpus uuid.
create or replace function public.search_corpus_records(
  query_embedding  halfvec(1024),
  p_corpus_id      uuid,
  p_limit          integer default 20,
  -- Cosine distance ceiling. 0.10 ≈ near-duplicate, 0.10–0.25 ≈ same scene from a
  -- different angle. Left to the caller because the boundary between those two is
  -- what the CLAIM module is calibrating.
  p_max_distance   double precision default 0.35,
  p_ef_search      integer default 100
)
returns table (
  record_id      uuid,
  corpus_id      uuid,
  external_ref   text,
  thumbnail_url  text,
  meta           jsonb,
  distance       double precision,
  similarity     double precision
)
language plpgsql
volatile  -- see search_geo_candidates: SET LOCAL requires a volatile function
set search_path = public, extensions, pg_catalog
as $$
declare
  eff_limit integer := least(greatest(coalesce(p_limit, 20), 1), 200);
  eff_ef    integer;
begin
  if p_corpus_id is null then
    raise exception 'p_corpus_id is required: corpus scoping is the tenancy boundary'
      using errcode = '22023';
  end if;

  eff_ef := least(greatest(coalesce(p_ef_search, 100), eff_limit), 1000);

  begin
    execute format('set local hnsw.ef_search = %s', eff_ef);
  exception when others then
    null;
  end;

  begin
    execute 'set local hnsw.iterative_scan = ''relaxed_order''';
  exception when others then
    null;
  end;

  return query
  select
    r.id            as record_id,
    r.corpus_id,
    r.external_ref,
    r.thumbnail_url,
    r.meta,
    (r.embedding <=> query_embedding)::double precision       as distance,
    (1 - (r.embedding <=> query_embedding))::double precision  as similarity
  from public.corpus_records r
  where r.corpus_id = p_corpus_id
    and r.embedding is not null
    and (r.embedding <=> query_embedding) <= coalesce(p_max_distance, 1.0)
  order by r.embedding <=> query_embedding
  limit eff_limit;
end;
$$;

comment on function public.search_corpus_records(halfvec, uuid, integer, double precision, integer) is
  'Corpus-pruned near-duplicate retrieval for CLAIM. corpus_id is required; RLS on corpus_records still applies.';

grant execute on function public.search_corpus_records(halfvec, uuid, integer, double precision, integer)
  to authenticated, service_role;
