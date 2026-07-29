-- Lantage — 11 · development seed
--
-- One demo org, one case, one small corpus, and 20 Pittsburgh mapillary_images
-- rows with normalized 512-d embeddings, so every other agent can develop against
-- real rows instead of mocks.
--
-- Idempotent (ON CONFLICT DO NOTHING) and safe to leave in the migration chain.
-- Fixed uuids, so a `supabase db reset` gives you the same ids every time and
-- hard-coded demo links keep working.
--
-- What is NOT seeded: app_users. Its id is an FK onto auth.users, so a user must
-- come from a real sign-up. The demo case therefore has created_by = null.
-- Provision the membership row server-side after sign-up with the service-role key
-- (see supabase/README.md § "Provisioning a user").

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Deterministic unit vectors
-- ---------------------------------------------------------------------------

-- Random-but-normalized, and reproducible: same seed, same vector, every reset.
-- Cosine distance on these is meaningless as geography — they exist so that ANN
-- queries return rows, plans can be EXPLAINed, and the UI has something to draw.
-- Real embeddings arrive from the Modal service.
--
-- Dropped at the end of this migration. It is a seeding tool, not schema.
create function public.__seed_unit_vector(dim integer, seed double precision)
returns halfvec
language plpgsql
immutable
as $$
declare
  vals  double precision[] := array[]::double precision[];
  parts text[] := array[]::text[];
  norm  double precision := 0;
  x     double precision;
  i     integer;
begin
  for i in 1..dim loop
    -- The GLSL fract(sin(x) * k) hash. Deterministic, uniform enough, no PRNG state.
    x := sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    x := x - floor(x) - 0.5;
    vals := vals || x;
    norm := norm + x * x;
  end loop;

  norm := sqrt(norm);

  -- L2-normalized on the way in. Non-negotiable for halfvec: unnormalized
  -- magnitudes lose precision in fp16, and cosine only equals inner product on
  -- the unit sphere.
  for i in 1..dim loop
    parts := parts || ((vals[i] / norm)::real)::text;
  end loop;

  return ('[' || array_to_string(parts, ',') || ']')::halfvec;
end;
$$;

-- ---------------------------------------------------------------------------
-- Demo tenant
-- ---------------------------------------------------------------------------

insert into public.orgs (id, name) values
  ('00000000-0000-4000-8000-000000000001', 'Lantage Demo SIU')
on conflict (id) do nothing;

insert into public.cases (id, org_id, title, reference, status, created_by) values
  (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'DEMO · Recycled roof damage, three policies',
    'DEMO-0001',
    'open',
    null
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Demo corpus (CLAIM)
-- ---------------------------------------------------------------------------

insert into public.corpora (id, org_id, name, kind, record_count) values
  (
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000001',
    'Demo claim photos 2026',
    'claim-photos',
    8
  )
on conflict (id) do nothing;

-- meta is what turns a visual match into a referral: same property, two loss
-- dates, two adjusters. Records 1/2 and 5/6 are built to collide.
insert into public.corpus_records (corpus_id, external_ref, thumbnail_url, meta, embedding)
select
  '00000000-0000-4000-8000-000000000003',
  v.external_ref,
  'https://demo.lantage.invalid/seed/corpus/' || v.external_ref || '/thumb.jpg',
  v.meta::jsonb,
  public.__seed_unit_vector(1024, v.seed::double precision)
from (values
  ('CLM-2026-0417-a', '{"claimNumber":"CLM-2026-0417","policyNumber":"HO-8841203","lossDate":"2026-03-02","peril":"hail","adjuster":"R. Vance","contractor":"Keystone Exteriors","address":"Squirrel Hill, Pittsburgh PA"}', 101),
  ('CLM-2026-0512-a', '{"claimNumber":"CLM-2026-0512","policyNumber":"HO-9920118","lossDate":"2026-04-19","peril":"hail","adjuster":"R. Vance","contractor":"Keystone Exteriors","address":"Shadyside, Pittsburgh PA"}', 101.0004),
  ('CLM-2026-0530-a', '{"claimNumber":"CLM-2026-0530","policyNumber":"HO-7712554","lossDate":"2026-04-28","peril":"wind","adjuster":"D. Ochoa","contractor":"Allegheny Roofworks","address":"Lawrenceville, Pittsburgh PA"}', 103),
  ('CLM-2026-0602-a', '{"claimNumber":"CLM-2026-0602","policyNumber":"HO-6620931","lossDate":"2026-05-11","peril":"water","adjuster":"D. Ochoa","contractor":null,"address":"Bloomfield, Pittsburgh PA"}', 104),
  ('CLM-2026-0641-a', '{"claimNumber":"CLM-2026-0641","policyNumber":"AU-3391847","lossDate":"2026-05-22","peril":"hail","adjuster":"M. Iyer","contractor":null,"address":"South Side Flats, Pittsburgh PA"}', 105),
  ('CLM-2026-0703-a', '{"claimNumber":"CLM-2026-0703","policyNumber":"AU-4410265","lossDate":"2026-06-08","peril":"hail","adjuster":"M. Iyer","contractor":null,"address":"Mount Washington, Pittsburgh PA"}', 105.0006),
  ('CLM-2026-0755-a', '{"claimNumber":"CLM-2026-0755","policyNumber":"HO-5583019","lossDate":"2026-06-21","peril":"fire","adjuster":"R. Vance","contractor":"Three Rivers Restoration","address":"North Shore, Pittsburgh PA"}', 107),
  ('CLM-2026-0791-a', '{"claimNumber":"CLM-2026-0791","policyNumber":"HO-4471882","lossDate":"2026-07-03","peril":"wind","adjuster":"K. Brandt","contractor":"Keystone Exteriors","address":"East Liberty, Pittsburgh PA"}', 108)
) as v(external_ref, meta, seed)
on conflict (corpus_id, external_ref) do nothing;

-- ---------------------------------------------------------------------------
-- Pittsburgh submap — 20 rows
-- ---------------------------------------------------------------------------

-- Pittsburgh is metro #1 because its built environment is unusually legible to
-- VPR: bridges, stair streets, and hillside row houses give retrieval something
-- to bite on that a suburban arterial does not.
--
-- Coordinates are real street locations (~40.44 N, -79.99 W). The ids and thumb
-- URLs are deliberately, visibly synthetic — a `seed-pgh-` prefix and an .invalid
-- host — so nobody mistakes a seed row for a harvested one, and so no code path
-- ever tries to fetch a Mapillary asset that does not exist. index_build says
-- `seed` for the same reason: a result citing this build is a development result.
insert into public.mapillary_images (
  mapillary_id, lat, lon, compass_angle, captured_at, thumb_url,
  sequence_id, is_pano, blur_applied, metro, index_build, embedding
)
select
  v.mapillary_id,
  v.lat,
  v.lon,
  v.compass_angle,
  v.captured_at::timestamptz,
  'https://demo.lantage.invalid/seed/pittsburgh/' || v.mapillary_id || '/thumb-1024.jpg',
  v.sequence_id,
  v.is_pano,
  true,  -- upstream blur asserted intact at ingest; CHECK-enforced
  'pittsburgh',
  'seed-pittsburgh@2026-07-29',
  public.__seed_unit_vector(512, v.seed::double precision)
from (values
  -- Downtown / Golden Triangle
  ('seed-pgh-0001', 40.44060, -79.99590,  47.0, '2025-04-12T15:22:04Z', 'seed-seq-downtown',   false,  1),
  ('seed-pgh-0002', 40.44230, -79.99740, 137.0, '2025-04-12T15:22:31Z', 'seed-seq-downtown',   false,  2),
  ('seed-pgh-0003', 40.44118, -79.99485, 228.0, '2025-04-12T15:23:02Z', 'seed-seq-downtown',   false,  3),
  -- Strip District — Penn & Smallman
  ('seed-pgh-0004', 40.45010, -79.98250,  62.0, '2025-06-03T18:41:12Z', 'seed-seq-strip',      false,  4),
  ('seed-pgh-0005', 40.45300, -79.97500,  61.0, '2025-06-03T18:42:07Z', 'seed-seq-strip',      false,  5),
  ('seed-pgh-0006', 40.45185, -79.97880, 241.0, '2025-06-03T18:43:19Z', 'seed-seq-strip',       true,  6),
  -- Lawrenceville — Butler St
  ('seed-pgh-0007', 40.46650, -79.96110,  55.0, '2025-09-21T13:05:44Z', 'seed-seq-lville',     false,  7),
  ('seed-pgh-0008', 40.47000, -79.95500,  54.0, '2025-09-21T13:06:58Z', 'seed-seq-lville',     false,  8),
  -- Oakland — Forbes & Fifth
  ('seed-pgh-0009', 40.44440, -79.95300,  95.0, '2025-10-08T16:12:20Z', 'seed-seq-oakland',    false,  9),
  ('seed-pgh-0010', 40.44150, -79.94810, 274.0, '2025-10-08T16:13:41Z', 'seed-seq-oakland',    false, 10),
  -- Shadyside / East Liberty
  ('seed-pgh-0011', 40.45300, -79.93400,  12.0, '2026-01-17T14:55:09Z', 'seed-seq-eastend',    false, 11),
  ('seed-pgh-0012', 40.45570, -79.92500,  88.0, '2026-01-17T14:56:33Z', 'seed-seq-eastend',     true, 12),
  -- Squirrel Hill — Forbes & Murray
  ('seed-pgh-0013', 40.43800, -79.92300, 180.0, '2026-02-04T11:31:50Z', 'seed-seq-sqhill',     false, 13),
  ('seed-pgh-0014', 40.43400, -79.92200, 176.0, '2026-02-04T11:32:44Z', 'seed-seq-sqhill',     false, 14),
  -- South Side Flats — E Carson St
  ('seed-pgh-0015', 40.42830, -79.98080,  70.0, '2026-03-22T17:48:02Z', 'seed-seq-southside',  false, 15),
  ('seed-pgh-0016', 40.42650, -79.97200,  69.0, '2026-03-22T17:49:15Z', 'seed-seq-southside',  false, 16),
  -- Mount Washington — Grandview Ave (the skyline overlook)
  ('seed-pgh-0017', 40.43100, -80.00600,  22.0, '2026-05-09T19:03:27Z', 'seed-seq-mtwash',     false, 17),
  ('seed-pgh-0018', 40.42870, -80.01100,  35.0, '2026-05-09T19:04:51Z', 'seed-seq-mtwash',     false, 18),
  -- North Shore / Allegheny Commons
  ('seed-pgh-0019', 40.44680, -80.00600, 300.0, '2026-06-14T12:19:38Z', 'seed-seq-northshore', false, 19),
  ('seed-pgh-0020', 40.44700, -80.01550, 296.0, '2026-06-14T12:20:55Z', 'seed-seq-northshore', false, 20)
) as v(mapillary_id, lat, lon, compass_angle, captured_at, sequence_id, is_pano, seed)
on conflict (mapillary_id) do nothing;

drop function public.__seed_unit_vector(integer, double precision);
