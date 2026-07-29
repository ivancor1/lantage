-- Lantage — 01 · extensions, tenancy helpers, append-only guard
--
-- Runs first. Everything downstream depends on the helpers defined here.
--
-- Target: Supabase Postgres 15+ (the `auth` schema and the anon /
-- authenticated / service_role roles must already exist). See supabase/README.md
-- for how to apply this on a local stack or a hosted project.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    raise exception 'The auth schema is missing. These migrations target a Supabase database: they use auth.uid(), auth.users, and the anon/authenticated/service_role roles. Run them against `supabase start` or a hosted project, not a bare Postgres.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- pgvector
-- ---------------------------------------------------------------------------

-- Supabase installs extensions into `extensions`; some older projects have
-- pgvector in `public`. `if not exists` keeps whichever is already there, and
-- every migration sets search_path to cover both, so `halfvec` resolves either way.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

grant usage on schema extensions to anon, authenticated, service_role;

-- Why halfvec, and why 512-d / 1024-d descriptors (docs/MASTER_PLAN.md §3):
--
--   * pgvector's HNSW index has a hard dimension ceiling: 2,000 dims for
--     `vector`, 4,000 for `halfvec`. MegaLoc-8448 cannot be HNSW-indexed in
--     pgvector at ALL, at any storage cost. That is the reason EigenPlaces-512
--     is the retrieval model and MegaLoc is only ever a top-50 re-ranker.
--   * halfvec (fp16) costs <1% recall on L2-normalized embeddings while halving
--     both RAM and on-disk index size. At practical harvest density one metro is
--     ~0.8–1.4 GB of vectors as halfvec, which fits a single Supabase XL node.
--   * Descriptor dimensions are therefore fixed by contract:
--       mapillary_images.embedding  halfvec(512)   EigenPlaces / GeoCLIP
--       corpus_records.embedding    halfvec(1024)  DINOv2 ViT-L/14
--     Changing either one is an index rebuild plus a re-embed of the corpus.

-- ---------------------------------------------------------------------------
-- Tenancy helper
-- ---------------------------------------------------------------------------

-- Resolves the caller's org. Every RLS policy in this schema routes through it.
--
-- SECURITY DEFINER is load-bearing, not laziness: the fallback path reads
-- app_users, and app_users itself has an RLS policy that calls this function.
-- Running as the table owner means that read is not subject to RLS, which is
-- what breaks the recursion. The function is deliberately tiny and takes no
-- arguments so there is no injection surface.
create or replace function public.current_org_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb;
  claim_org text;
  resolved uuid;
begin
  claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;

  if claims is not null then
    -- Fast path: org_id stamped into the JWT at sign-in. Costs no I/O, which
    -- matters because this runs once per RLS-checked statement.
    claim_org := coalesce(
      nullif(claims -> 'app_metadata' ->> 'org_id', ''),
      nullif(claims ->> 'org_id', '')
    );
    if claim_org is not null then
      return claim_org::uuid;
    end if;
  end if;

  -- Fallback: the user row is authoritative. Used until the sign-in hook that
  -- stamps app_metadata.org_id is wired up, and whenever a token predates a
  -- membership change.
  select u.org_id into resolved
  from public.app_users u
  where u.id = auth.uid();

  return resolved;
end;
$$;

comment on function public.current_org_id() is
  'The calling user''s org_id, from JWT app_metadata.org_id if present, else their app_users row. SECURITY DEFINER to avoid RLS recursion on app_users.';

revoke all on function public.current_org_id() from public;
grant execute on function public.current_org_id() to anon, authenticated, service_role;

create or replace function public.is_service_role()
returns boolean
language sql
stable
set search_path = ''
as $$
  -- current_user is a SQL keyword construct, not a catalog function, so it cannot
  -- be schema-qualified — and does not need to be, since search_path cannot
  -- influence it. It covers direct psql/pooler connections that carry no JWT.
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    current_user::text
  ) = 'service_role';
$$;

comment on function public.is_service_role() is
  'True for the service-role key. Reference data (mapillary_images, benchmark_runs) is writable only by this.';

grant execute on function public.is_service_role() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Append-only guard
-- ---------------------------------------------------------------------------

-- Attached to audit_log and ledger_entries in 20260729180600. It exists to
-- survive legal discovery: the immutability of those two tables must not depend
-- on application code being correct, or on a future engineer knowing the rule.
--
-- 42501 (insufficient_privilege) so PostgREST surfaces it as 403 rather than 500.
create or replace function public.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    '%.% is append-only; % is not permitted. Corrections are new rows, never edits.',
    tg_table_schema, tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

comment on function public.reject_mutation() is
  'Trigger function that refuses UPDATE/DELETE/TRUNCATE. Used by audit_log and ledger_entries.';
