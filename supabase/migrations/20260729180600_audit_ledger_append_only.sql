-- Lantage — 07 · audit_log, ledger_entries  (APPEND-ONLY)
--
-- These two tables are built for defence discovery. Immutability is enforced by
-- the database, at four independent layers, because it must not be possible to
-- bypass from application code:
--
--   1. BEFORE UPDATE OR DELETE  triggers that RAISE EXCEPTION — statement-level,
--      so even a zero-row `delete ... where false` fails loudly instead of
--      silently succeeding.
--   2. BEFORE TRUNCATE          triggers. TRUNCATE bypasses row-level triggers
--      entirely; without this the whole scheme is theatre.
--   3. ENABLE ALWAYS            so `session_replication_role = replica` (the
--      standard trigger-bypass trick) does not disable them.
--   4. REVOKE update, delete, truncate FROM anon, authenticated — PostgREST
--      cannot even form the request.
--
-- RLS adds a fifth: no UPDATE or DELETE policy exists on either table, so those
-- verbs are denied before a trigger is ever reached.
--
-- Residual risk, stated honestly: the table OWNER can still `drop trigger`. The
-- mitigations are operational, not schema-level — restrict the postgres role,
-- keep PITR on, and ship a periodic export to write-once storage. Documented in
-- supabase/README.md.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id            uuid primary key default gen_random_uuid(),

  -- Nullable: pre-authentication events (failed sign-in, rejected token) have no
  -- resolvable org and must still be recorded. Those rows are service-role-only
  -- reads by construction, since RLS matches on org_id.
  org_id        uuid references public.orgs (id) on delete restrict,
  actor_id      uuid references public.app_users (id) on delete restrict,

  -- Dotted verb. Convention, not a CHECK, because the vocabulary grows with the
  -- product and a migration should never be the thing standing between an event
  -- and its audit row:
  --   auth.sign-in · auth.sign-in-failed · case.create · case.close
  --   image.upload · search.create · search.complete · search.refuse
  --   result.review · ledger.append · export.download · corpus.ingest
  --   corpus.delete · admin.role-change · admin.license-verify
  action        text not null check (length(btrim(action)) > 0),

  subject_type  text,
  subject_id    text,

  -- Normalised to a single address by the app; a multi-hop X-Forwarded-For or an
  -- unparseable value is preserved verbatim under detail.ip_raw so nothing is lost.
  ip            inet,
  user_agent    text,

  detail        jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now(),

  constraint audit_log_detail_is_object check (jsonb_typeof(detail) = 'object')
);

create index audit_log_org_at_idx on public.audit_log (org_id, at desc);
create index audit_log_actor_at_idx on public.audit_log (actor_id, at desc);
create index audit_log_subject_idx on public.audit_log (subject_type, subject_id);
create index audit_log_action_at_idx on public.audit_log (action, at desc);

comment on table public.audit_log is
  'APPEND-ONLY. Who, when, what image, what result, what they did with it. Built for defence discovery from day one (MASTER_PLAN §7).';

-- ---------------------------------------------------------------------------
-- ledger_entries
-- ---------------------------------------------------------------------------

-- The case narrative. Corrections are NEW entries, never edits, so the sequence
-- of what an investigator believed and when is itself part of the record.
--
-- No org_id column by design: the case is the tenancy anchor, and a ledger entry
-- whose org disagreed with its case would be a contradiction we would then have to
-- adjudicate. RLS routes through cases.org_id.
create table public.ledger_entries (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid not null references public.cases (id) on delete restrict,
  search_id      uuid not null references public.searches (id) on delete restrict,

  summary        text not null check (length(btrim(summary)) > 0),

  -- { method, note, by, at }. A forced corroboration step before any finding can
  -- be marked confirmed — the Detroit rules as enforced workflow, not a policy PDF.
  -- No photo lineup and no arrest on an AI match alone.
  corroboration  jsonb,

  written_by     uuid default auth.uid() references public.app_users (id) on delete restrict,
  written_at     timestamptz not null default now(),

  constraint ledger_corroboration_shape check (
    corroboration is null
    or (
      length(btrim(coalesce(corroboration ->> 'method', ''))) > 0
      and length(btrim(coalesce(corroboration ->> 'note', ''))) > 0
      and (corroboration ->> 'by') is not null
      and (corroboration ->> 'at') is not null
    )
  )
);

create index ledger_entries_case_written_idx on public.ledger_entries (case_id, written_at desc);
create index ledger_entries_search_idx on public.ledger_entries (search_id);

comment on table public.ledger_entries is
  'APPEND-ONLY case narrative. Corrections are new entries, never edits. Corroboration is required before a finding is confirmed.';

-- ---------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------

create trigger audit_log_no_mutation
  before update or delete on public.audit_log
  for each statement execute function public.reject_mutation();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.reject_mutation();

create trigger ledger_entries_no_mutation
  before update or delete on public.ledger_entries
  for each statement execute function public.reject_mutation();

create trigger ledger_entries_no_truncate
  before truncate on public.ledger_entries
  for each statement execute function public.reject_mutation();

-- ENABLE ALWAYS: fires even when session_replication_role = 'replica', which is
-- the usual way a trigger gets quietly stepped around.
alter table public.audit_log       enable always trigger audit_log_no_mutation;
alter table public.audit_log       enable always trigger audit_log_no_truncate;
alter table public.ledger_entries  enable always trigger ledger_entries_no_mutation;
alter table public.ledger_entries  enable always trigger ledger_entries_no_truncate;

-- Belt and braces: the API roles cannot express the verb at all.
revoke update, delete, truncate on public.audit_log from anon, authenticated;
revoke update, delete, truncate on public.ledger_entries from anon, authenticated;
