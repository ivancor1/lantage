-- Lantage — 05 · corpora, corpus_records, corpus_matches  (the CLAIM module)
--
-- The customer owns the corpus and grants processing rights in the MSA, so there
-- is no data-licensing exposure here at all — which is exactly why CLAIM ships in
-- v1 and the MLS interior index does not (MASTER_PLAN §8).
--
-- We store the POINTER and the derived embedding, never their pixels. That is the
-- same architectural discipline as persisting Street View pano IDs only.

set search_path = public, extensions;

create table public.corpora (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org_id()
                  references public.orgs (id) on delete cascade,
  name          text not null check (length(btrim(name)) > 0),
  kind          text not null check (kind in (
                  'claim-photos',      -- the customer's own claim imagery
                  'licensed-stock',    -- licensed demo set with derivative rights
                  'reference-gallery', -- e.g. vPIC-keyed vehicle reference images
                  'other'
                )),
  -- Denormalised for the corpus list UI. Maintained by the ingest job, not a trigger:
  -- a per-row trigger on a million-row bulk load is a self-inflicted wound.
  record_count  integer not null default 0 check (record_count >= 0),
  created_at    timestamptz not null default now(),

  constraint corpora_org_name_unique unique (org_id, name)
);

create index corpora_org_idx on public.corpora (org_id, created_at desc);

comment on table public.corpora is
  'A customer-owned image corpus for CLAIM self-match. record_count is maintained by the ingest job.';

-- ---------------------------------------------------------------------------
-- corpus_records
-- ---------------------------------------------------------------------------

create table public.corpus_records (
  id             uuid primary key default gen_random_uuid(),
  corpus_id      uuid not null references public.corpora (id) on delete cascade,

  -- The customer's own identifier — claim number, DMS asset id. This is the
  -- referral: it is what an SIU investigator opens next.
  external_ref   text not null check (length(btrim(external_ref)) > 0),

  -- Hot-linked from the customer's system at display time. Not our copy.
  thumbnail_url  text,

  -- Claim metadata that turns a visual match into a finding: policy number,
  -- loss date, adjuster, contractor. Cross-claim timeline conflict is detected here.
  meta           jsonb not null default '{}'::jsonb,

  -- DINOv2 ViT-L/14 → 1024-d. halfvec: <1% recall cost, half the RAM.
  -- pgvector HNSW ceiling is 4,000 dims for halfvec, so 1024-d is comfortable.
  embedding      halfvec(1024),

  created_at     timestamptz not null default now(),

  constraint corpus_records_external_ref_unique unique (corpus_id, external_ref)
);

comment on table public.corpus_records is
  'One customer image: pointer + metadata + derived embedding. Never their pixels.';

-- ---------------------------------------------------------------------------
-- corpus_matches
-- ---------------------------------------------------------------------------

create table public.corpus_matches (
  id             uuid primary key default gen_random_uuid(),
  search_id      uuid not null references public.searches (id) on delete cascade,

  -- Both pointers null out rather than cascade. A customer purging a corpus
  -- (retention policy, contract end) must not silently rewrite the history of a
  -- finding that was already reported — but we also must not keep claiming a
  -- record we no longer hold. So the finding survives and the pointer goes null.
  corpus_id      uuid references public.corpora (id) on delete set null,
  record_id      uuid references public.corpus_records (id) on delete set null,

  rank           integer not null check (rank >= 1),
  similarity     double precision not null check (similarity between 0 and 1),

  -- Materially different findings, and SIU treats them differently:
  -- near-duplicate = the same file resubmitted; same-scene = the same damage
  -- photographed again, which is the recycled-damage pattern.
  relation       text not null check (relation in ('near-duplicate', 'same-scene', 'similar')),

  thumbnail_url  text,
  review         text not null default 'unreviewed'
                   check (review in ('unreviewed', 'confirmed', 'nearby', 'incorrect')),
  created_at     timestamptz not null default now(),

  constraint corpus_matches_rank_unique unique (search_id, rank)
);

create index corpus_matches_record_idx on public.corpus_matches (record_id) where record_id is not null;

create trigger corpus_matches_refusal_guard
  before insert on public.corpus_matches
  for each row execute function public.assert_search_not_refused();

comment on table public.corpus_matches is
  'CLAIM output. Tenant isolation routes through searches.org_id, not corpora, so the row survives corpus deletion.';
