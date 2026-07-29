-- Lantage — 09 · Row Level Security
--
-- Every table in this schema has RLS enabled. Two shapes:
--
--   Tenant tables      — isolated on org_id via public.current_org_id().
--   Reference tables   — mapillary_images, benchmark_runs: readable by every
--                        authenticated user, writable only by the service role.
--
-- Three conventions used throughout, each for a reason:
--
--   `to authenticated`        anon appears in no policy. There is no anonymous
--                             tier in this product (MASTER_PLAN §7 — the GeoSpy
--                             lesson), and the blanket revoke at the bottom of
--                             this file makes that structural.
--   `(select current_org_id())` The subselect form lets the planner hoist the call
--                             into an InitPlan and evaluate it ONCE per statement
--                             instead of once per row. On a 100k-row scan that is
--                             the difference between milliseconds and seconds.
--   no DELETE policy          on cases / images / searches / results / audit /
--                             ledger. Evidence does not get deleted through the
--                             API. Cases close.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- orgs
-- ---------------------------------------------------------------------------

alter table public.orgs enable row level security;

create policy orgs_select_own on public.orgs
  for select to authenticated
  using (id = (select public.current_org_id()));

-- Insert/update/delete: service role only (it bypasses RLS). Org creation is a
-- provisioning action that runs after identity verification, never a client call.

-- ---------------------------------------------------------------------------
-- app_users
-- ---------------------------------------------------------------------------

alter table public.app_users enable row level security;

create policy app_users_select_same_org on public.app_users
  for select to authenticated
  using (org_id = (select public.current_org_id()));

-- A user may edit their own row, but only the columns left grantable below.
create policy app_users_update_self on public.app_users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()) and org_id = (select public.current_org_id()));

-- The teeth: RLS decides WHICH rows, column privileges decide WHICH columns. A
-- user must never be able to move themselves to another org, promote themselves,
-- or self-attest identity/licence verification.
revoke update on public.app_users from authenticated;
grant update (email) on public.app_users to authenticated;

-- ---------------------------------------------------------------------------
-- cases
-- ---------------------------------------------------------------------------

alter table public.cases enable row level security;

create policy cases_select on public.cases
  for select to authenticated
  using (org_id = (select public.current_org_id()));

create policy cases_insert on public.cases
  for insert to authenticated
  with check (org_id = (select public.current_org_id()));

create policy cases_update on public.cases
  for update to authenticated
  using (org_id = (select public.current_org_id()))
  with check (org_id = (select public.current_org_id()));

-- Who opened a case and when are facts, not fields.
revoke update on public.cases from authenticated;
grant update (title, reference, status) on public.cases to authenticated;

-- ---------------------------------------------------------------------------
-- images
-- ---------------------------------------------------------------------------

alter table public.images enable row level security;

create policy images_select on public.images
  for select to authenticated
  using (org_id = (select public.current_org_id()));

create policy images_insert on public.images
  for insert to authenticated
  with check (org_id = (select public.current_org_id()));

-- Re-filing an image under a different case is legitimate; deleting the frame a
-- finding was based on is not.
create policy images_update on public.images
  for update to authenticated
  using (org_id = (select public.current_org_id()))
  with check (org_id = (select public.current_org_id()));

-- Only the case assignment moves. The hash, the EXIF, and the storage pointer are
-- what make the frame the frame.
revoke update on public.images from authenticated;
grant update (case_id) on public.images to authenticated;

-- ---------------------------------------------------------------------------
-- searches
-- ---------------------------------------------------------------------------

alter table public.searches enable row level security;

create policy searches_select on public.searches
  for select to authenticated
  using (org_id = (select public.current_org_id()));

create policy searches_insert on public.searches
  for insert to authenticated
  with check (org_id = (select public.current_org_id()));

-- quality / stages / provenance are patched as the cascade completes. The columns
-- that identify WHAT was searched are locked after insert.
create policy searches_update on public.searches
  for update to authenticated
  using (org_id = (select public.current_org_id()))
  with check (org_id = (select public.current_org_id()));

revoke update on public.searches from authenticated;
grant update (quality, stages, provenance) on public.searches to authenticated;

-- ---------------------------------------------------------------------------
-- Result tables — tenancy routes through searches
-- ---------------------------------------------------------------------------

-- One helper predicate, three tables. Written as EXISTS against the parent rather
-- than denormalising org_id, so there is exactly one place where a result's
-- tenancy can be defined and no possibility of the two disagreeing.
create or replace function public.search_in_caller_org(p_search_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.searches s
    where s.id = p_search_id
      and s.org_id = public.current_org_id()
  );
$$;

comment on function public.search_in_caller_org(uuid) is
  'RLS predicate for the result tables. Their tenancy is defined once, on searches.';

grant execute on function public.search_in_caller_org(uuid) to authenticated, service_role;

alter table public.geo_candidates enable row level security;

create policy geo_candidates_select on public.geo_candidates
  for select to authenticated
  using ((select public.search_in_caller_org(search_id)));

create policy geo_candidates_insert on public.geo_candidates
  for insert to authenticated
  with check ((select public.search_in_caller_org(search_id)));

-- Review disposition is the analyst's workflow. Everything else about a candidate
-- is what the model said, and is not editable.
create policy geo_candidates_update on public.geo_candidates
  for update to authenticated
  using ((select public.search_in_caller_org(search_id)))
  with check ((select public.search_in_caller_org(search_id)));

revoke update on public.geo_candidates from authenticated;
grant update (review) on public.geo_candidates to authenticated;

alter table public.vehicle_candidates enable row level security;

create policy vehicle_candidates_select on public.vehicle_candidates
  for select to authenticated
  using ((select public.search_in_caller_org(search_id)));

create policy vehicle_candidates_insert on public.vehicle_candidates
  for insert to authenticated
  with check ((select public.search_in_caller_org(search_id)));

create policy vehicle_candidates_update on public.vehicle_candidates
  for update to authenticated
  using ((select public.search_in_caller_org(search_id)))
  with check ((select public.search_in_caller_org(search_id)));

revoke update on public.vehicle_candidates from authenticated;
grant update (review) on public.vehicle_candidates to authenticated;

alter table public.authenticity_results enable row level security;

create policy authenticity_results_select on public.authenticity_results
  for select to authenticated
  using ((select public.search_in_caller_org(search_id)));

create policy authenticity_results_insert on public.authenticity_results
  for insert to authenticated
  with check ((select public.search_in_caller_org(search_id)));

-- No update policy. A verdict is not revisable — re-run VERIFY and get a new search.
revoke update on public.authenticity_results from authenticated;

alter table public.corpus_matches enable row level security;

create policy corpus_matches_select on public.corpus_matches
  for select to authenticated
  using ((select public.search_in_caller_org(search_id)));

create policy corpus_matches_insert on public.corpus_matches
  for insert to authenticated
  with check ((select public.search_in_caller_org(search_id)));

create policy corpus_matches_update on public.corpus_matches
  for update to authenticated
  using ((select public.search_in_caller_org(search_id)))
  with check ((select public.search_in_caller_org(search_id)));

revoke update on public.corpus_matches from authenticated;
grant update (review) on public.corpus_matches to authenticated;

-- ---------------------------------------------------------------------------
-- corpora / corpus_records
-- ---------------------------------------------------------------------------

alter table public.corpora enable row level security;

create policy corpora_select on public.corpora
  for select to authenticated
  using (org_id = (select public.current_org_id()));

create policy corpora_insert on public.corpora
  for insert to authenticated
  with check (org_id = (select public.current_org_id()));

create policy corpora_update on public.corpora
  for update to authenticated
  using (org_id = (select public.current_org_id()))
  with check (org_id = (select public.current_org_id()));

-- Deletable, unlike the evidence tables: it is the customer's data and their
-- retention policy governs it. corpus_matches null out their pointers rather than
-- cascading, so historical findings survive the purge.
create policy corpora_delete on public.corpora
  for delete to authenticated
  using (org_id = (select public.current_org_id()));

create or replace function public.corpus_in_caller_org(p_corpus_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.corpora c
    where c.id = p_corpus_id
      and c.org_id = public.current_org_id()
  );
$$;

grant execute on function public.corpus_in_caller_org(uuid) to authenticated, service_role;

alter table public.corpus_records enable row level security;

create policy corpus_records_select on public.corpus_records
  for select to authenticated
  using ((select public.corpus_in_caller_org(corpus_id)));

create policy corpus_records_insert on public.corpus_records
  for insert to authenticated
  with check ((select public.corpus_in_caller_org(corpus_id)));

create policy corpus_records_update on public.corpus_records
  for update to authenticated
  using ((select public.corpus_in_caller_org(corpus_id)))
  with check ((select public.corpus_in_caller_org(corpus_id)));

create policy corpus_records_delete on public.corpus_records
  for delete to authenticated
  using ((select public.corpus_in_caller_org(corpus_id)));

-- ---------------------------------------------------------------------------
-- Reference data — global read, service-role write
-- ---------------------------------------------------------------------------

alter table public.mapillary_images enable row level security;

create policy mapillary_images_select on public.mapillary_images
  for select to authenticated
  using (true);

-- The service role bypasses RLS, so these exist to make the intent explicit and
-- to keep working if the harvester is ever moved onto a non-bypassing role.
create policy mapillary_images_write_service on public.mapillary_images
  for all to service_role
  using (true) with check (true);

revoke insert, update, delete, truncate on public.mapillary_images from authenticated;

alter table public.benchmark_runs enable row level security;

-- Published error rates. Every authenticated user can read the numbers their
-- confidence bands are calibrated against — that is the point of BENCH.
create policy benchmark_runs_select on public.benchmark_runs
  for select to authenticated
  using (true);

create policy benchmark_runs_write_service on public.benchmark_runs
  for all to service_role
  using (true) with check (true);

revoke insert, update, delete, truncate on public.benchmark_runs from authenticated;

-- ---------------------------------------------------------------------------
-- audit_log / ledger_entries — insert + select only
-- ---------------------------------------------------------------------------

alter table public.audit_log enable row level security;

create policy audit_log_select on public.audit_log
  for select to authenticated
  using (org_id = (select public.current_org_id()));

-- A user can write their own org's audit trail but cannot attribute an action to
-- another org. The absence of UPDATE/DELETE policies is the point: RLS denies both
-- before the append-only triggers are ever consulted.
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (org_id = (select public.current_org_id()));

alter table public.ledger_entries enable row level security;

create policy ledger_entries_select on public.ledger_entries
  for select to authenticated
  using (exists (
    select 1 from public.cases c
    where c.id = ledger_entries.case_id
      and c.org_id = (select public.current_org_id())
  ));

create policy ledger_entries_insert on public.ledger_entries
  for insert to authenticated
  with check (
    exists (
      select 1 from public.cases c
      where c.id = ledger_entries.case_id
        and c.org_id = (select public.current_org_id())
    )
    -- A ledger entry must cite a search from the same case (or a case-less search
    -- in the same org). An entry pointing at someone else's search would be a
    -- corroboration record that cannot be corroborated.
    and exists (
      select 1 from public.searches s
      where s.id = ledger_entries.search_id
        and s.org_id = (select public.current_org_id())
    )
  );

-- ---------------------------------------------------------------------------
-- No anonymous tier. Ever.
-- ---------------------------------------------------------------------------

-- January 2025: 404 Media found Discord members using GeoSpy's free public tier to
-- geolocate and stalk specific women. Graylark pulled the tool the day they were
-- contacted for comment, and it nearly ended the company. This revoke, plus the
-- absence of anon from every policy above, is how that failure mode is designed
-- out rather than moderated.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;
