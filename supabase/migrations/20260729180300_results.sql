-- Lantage — 04 · geo_candidates, vehicle_candidates, authenticity_results
--
-- The product invariants in src/lib/contracts/types.ts are mirrored here as CHECK
-- constraints and triggers. Deliberate duplication: the TypeScript assertions
-- protect the running app, these protect the record. A bug, a raw SQL script, or
-- a future service that skips the contracts module still cannot write a result
-- that lacks evidence or claims street precision it did not earn.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Shared guard: a refused quality gate returns no ranking
-- ---------------------------------------------------------------------------

-- The DB half of assertRefusalIsHonoured(). Show the refusal, not a ranking.
create or replace function public.assert_search_not_refused()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  passed text;
begin
  select s.quality ->> 'passed' into passed
  from public.searches s
  where s.id = new.search_id;

  if passed = 'false' then
    raise exception
      'search % failed its quality gate; it cannot carry ranked % rows. Show the refusal.',
      new.search_id, tg_table_name
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.assert_search_not_refused() is
  'Blocks candidate inserts against a search whose quality gate failed. Mirrors assertRefusalIsHonoured() in src/lib/contracts/types.ts.';

-- ---------------------------------------------------------------------------
-- geo_candidates
-- ---------------------------------------------------------------------------

create table public.geo_candidates (
  id           uuid primary key default gen_random_uuid(),
  search_id    uuid not null references public.searches (id) on delete cascade,
  rank         integer not null check (rank >= 1),

  lat          double precision not null check (lat between -90 and 90),
  lon          double precision not null check (lon between -180 and 180),

  -- A REGION, not a pin. Never zero: a point estimate is a claim we do not make.
  radius_m     double precision not null check (radius_m > 0),

  "precision"  text not null
                 check ("precision" in ('continent', 'country', 'region', 'city', 'street')),

  -- { label, admin1?, country? }
  place        jsonb not null default '{}'::jsonb,

  -- Confidence: a band plus a reason, never a bare percentage.
  confidence   jsonb not null,

  -- EvidenceChain — non-empty by construction in the type system, and here too.
  evidence     jsonb not null,

  review       text not null default 'unreviewed'
                 check (review in ('unreviewed', 'confirmed', 'nearby', 'incorrect')),
  created_at   timestamptz not null default now(),

  constraint geo_candidates_rank_unique unique (search_id, rank),

  -- No result without cited evidence.
  constraint geo_candidates_evidence_non_empty check (
    jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0
  ),

  -- Confidence is a band plus a reason. A band with no stated reason is not shippable.
  constraint geo_candidates_confidence_shape check (
    confidence ->> 'band' in ('high', 'moderate', 'weak', 'refused')
    and length(btrim(coalesce(confidence ->> 'reason', ''))) > 0
  ),

  -- Street precision must be EARNED by retrieval or OCR, never by inference.
  -- Best published 1 km accuracy on the only area-weighted benchmark (GWS15k) is
  -- 0.7%, so an embedding prior alone can never support a street-level claim.
  -- Mirrors assertStreetPrecisionIsEarned().
  constraint geo_candidates_street_precision_earned check (
    "precision" <> 'street'
    or evidence @> '[{"kind": "vpr-match"}]'::jsonb
    or evidence @> '[{"kind": "signage-ocr"}]'::jsonb
  )
);

-- No separate (search_id, rank) index: geo_candidates_rank_unique already builds one.
create index geo_candidates_review_idx on public.geo_candidates (review) where review <> 'unreviewed';

create trigger geo_candidates_refusal_guard
  before insert on public.geo_candidates
  for each row execute function public.assert_search_not_refused();

comment on table public.geo_candidates is
  'Ranked geolocation hypotheses. Regions with a radius, each carrying its own evidence chain. Street precision is constraint-enforced.';

-- ---------------------------------------------------------------------------
-- vehicle_candidates
-- ---------------------------------------------------------------------------

-- Always a ranked set, never a top-1. Fine-grained make/model/year has high
-- intra-class and low inter-class variance; the UI renders top-5 minimum.
create table public.vehicle_candidates (
  id                   uuid primary key default gen_random_uuid(),
  search_id            uuid not null references public.searches (id) on delete cascade,
  rank                 integer not null check (rank >= 1),

  make                 text not null,
  model                text not null,
  -- A generation or year range. A single model year is a claim the reference
  -- gallery usually cannot support.
  generation           text not null,
  color                text,

  -- NHTSA vPIC ids: { makeId?, modelId? }. Keeps the taxonomy auditable rather
  -- than free-text — the open VMMR datasets are non-commercial and stale.
  vpic                 jsonb not null default '{}'::jsonb,

  similarity           double precision not null check (similarity between 0 and 1),
  reference_image_url  text,
  review               text not null default 'unreviewed'
                         check (review in ('unreviewed', 'confirmed', 'nearby', 'incorrect')),
  created_at           timestamptz not null default now(),

  constraint vehicle_candidates_rank_unique unique (search_id, rank)
);

create trigger vehicle_candidates_refusal_guard
  before insert on public.vehicle_candidates
  for each row execute function public.assert_search_not_refused();

comment on table public.vehicle_candidates is
  'Top-N make/model/generation candidates from gallery retrieval, keyed to the NHTSA vPIC taxonomy.';

-- ---------------------------------------------------------------------------
-- authenticity_results
-- ---------------------------------------------------------------------------

-- Note the asymmetry and preserve it: there is no 'authentic' verdict, by
-- design. We can find indicators of generation; absence of indicators is not
-- proof of anything, and platforms strip C2PA manifests on upload ~100% of the
-- time. The CHECK below is the schema-level statement of that rule.
create table public.authenticity_results (
  id             uuid primary key default gen_random_uuid(),
  -- One verdict per search. UNIQUE also makes the PostgREST embed one-to-one.
  search_id      uuid not null unique references public.searches (id) on delete cascade,

  verdict        text not null check (verdict in (
                   'strong-indicators',
                   'moderate-indicators',
                   'weak-indicators',
                   'no-indicators-found',  -- NOT "authentic"
                   'inconclusive'
                 )),

  confidence     jsonb not null,
  evidence       jsonb not null,

  -- Documented false-positive classes that suppressed the verdict. Consumer
  -- detectors run 5–15% FPR on real photographs, and the worst audited detector
  -- flagged 40% of authentic news photos as AI — so suppression is routine.
  suppressed_by  text[] not null default '{}'::text[],

  -- { value, assumedBaseRate }. Surfaced in the UI because at those FPRs and a
  -- low caseload prevalence, most positive flags are false positives, and the
  -- analyst must see that arithmetic rather than a fused magic number.
  ppv            jsonb not null,

  -- C2PA manifest: { hasManifest, issuer?, valid?, generator? }. Deterministic,
  -- checked first. Absence means nothing and must never be shown as fakery.
  provenance     jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),

  constraint authenticity_evidence_non_empty check (
    jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0
  ),
  constraint authenticity_confidence_shape check (
    confidence ->> 'band' in ('high', 'moderate', 'weak', 'refused')
    and length(btrim(coalesce(confidence ->> 'reason', ''))) > 0
  ),
  constraint authenticity_ppv_shape check (
    (ppv ->> 'value') is not null and (ppv ->> 'assumedBaseRate') is not null
  ),
  constraint authenticity_suppression_reasons check (
    suppressed_by <@ array[
      'computational-photography',
      'ai-upscaled',
      'heavy-retouching',
      'screenshot',
      'recompressed',
      'resolution-too-low'
    ]::text[]
  ),
  -- suppressedBy is present iff the verdict is 'inconclusive'.
  constraint authenticity_suppression_matches_verdict check (
    (verdict = 'inconclusive') = (cardinality(suppressed_by) > 0)
  )
);

comment on table public.authenticity_results is
  'VERIFY output. There is no authentic verdict by design — only no-indicators-found. PPV at a stated base rate is mandatory.';
