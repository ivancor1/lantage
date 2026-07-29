-- Lantage — 03 · cases, images, searches
--
-- Nothing here is deletable by an authenticated user. Cases close, they do not
-- vanish; searches and the images they ran against are the evidentiary spine the
-- ledger and the audit log point at. All the FKs into this file are
-- `on delete restrict` for that reason, and the RLS migration grants no DELETE
-- policy on these three tables.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- cases
-- ---------------------------------------------------------------------------

create table public.cases (
  id          uuid primary key default gen_random_uuid(),
  -- Defaulted from the caller's JWT so a client cannot forget it and cannot
  -- forge it: the RLS WITH CHECK re-verifies the value on every insert.
  org_id      uuid not null default public.current_org_id()
                references public.orgs (id) on delete restrict,
  title       text not null check (length(btrim(title)) > 0),
  reference   text,
  status      text not null default 'open' check (status in ('open', 'closed')),
  created_by  uuid default auth.uid() references public.app_users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index cases_org_created_idx on public.cases (org_id, created_at desc);
-- A carrier's claim number identifies exactly one case within one org.
create unique index cases_org_reference_key
  on public.cases (org_id, reference)
  where reference is not null;

comment on table public.cases is
  'Case file. Not deletable through the API — status = closed instead, because ledger_entries reference cases with on delete restrict.';

-- ---------------------------------------------------------------------------
-- images
-- ---------------------------------------------------------------------------

create table public.images (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org_id()
                  references public.orgs (id) on delete restrict,
  case_id       uuid references public.cases (id) on delete restrict,
  -- Path in Supabase Storage. Pixels never live in this table.
  storage_path  text not null check (length(btrim(storage_path)) > 0),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width         integer check (width > 0),
  height        integer check (height > 0),
  mime          text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/tiff')),

  -- EXIF/XMP verbatim. Kept for the ledger, NEVER trusted as a location claim:
  -- falsified GPS is the single most common trap in this domain, so the cascade
  -- treats this as a lead to corroborate, never as an answer.
  --
  -- Must not contain license-plate characters. We ship no ALPR and never persist
  -- plate text (Mapillary ToS §12, MASTER_PLAN §7) — the upload path strips any
  -- OCR output before it reaches this column.
  exif          jsonb not null default '{}'::jsonb,

  uploaded_by   uuid default auth.uid() references public.app_users (id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Dedup is per-tenant, never global: two carriers can legitimately hold the same
-- photograph, and a cross-org hash collision must not leak that fact.
create unique index images_org_sha256_key on public.images (org_id, sha256);
create index images_case_idx on public.images (case_id) where case_id is not null;

comment on table public.images is
  'Uploaded frame. storage_path points at Supabase Storage; sha256 is the dedup key within an org.';
comment on column public.images.exif is
  'Raw EXIF/XMP. Recorded for the ledger, never trusted (falsified GPS). Must never contain plate characters.';

-- ---------------------------------------------------------------------------
-- searches
-- ---------------------------------------------------------------------------

create table public.searches (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id()
                references public.orgs (id) on delete restrict,
  case_id     uuid references public.cases (id) on delete restrict,
  image_id    uuid not null references public.images (id) on delete restrict,
  module      text not null check (module in ('GEO', 'STREET', 'VEHICLE', 'VERIFY', 'CLAIM', 'MATCH')),

  -- SearchRequest.hints: { bbox?, capturedAt?, corpusId? }. Narrowing the search
  -- is legitimate; seeding the answer is not — hints are recorded so a reviewer
  -- can see exactly what the analyst constrained.
  hints       jsonb not null default '{}'::jsonb,

  -- QualityGate. Written when the gate runs; '{}' means the cascade has not
  -- reached it yet. quality->>'passed' = 'false' hard-blocks candidate inserts
  -- (see the trigger in 20260729180300).
  quality     jsonb not null default '{}'::jsonb,

  -- StageTrace[]: which cascade stages actually ran, with timings and cost.
  stages      jsonb not null default '[]'::jsonb,

  -- ResultProvenance: model + index versions. This is a Daubert requirement,
  -- not bookkeeping — a result nobody can reproduce is not admissible.
  provenance  jsonb not null default '{}'::jsonb,

  created_by  uuid default auth.uid() references public.app_users (id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint searches_hints_is_object check (jsonb_typeof(hints) = 'object'),
  constraint searches_stages_is_array check (jsonb_typeof(stages) = 'array'),
  constraint searches_quality_is_object check (jsonb_typeof(quality) = 'object'),
  constraint searches_provenance_is_object check (jsonb_typeof(provenance) = 'object')
);

create index searches_org_created_idx on public.searches (org_id, created_at desc);
create index searches_case_idx on public.searches (case_id) where case_id is not null;
create index searches_image_idx on public.searches (image_id);

comment on table public.searches is
  'One cascade run. Append-in-practice: only quality/stages/provenance are patched, by the server, as the cascade completes.';
