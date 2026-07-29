# Lantage database

Postgres schema, RLS, and pgvector indexes. Owned by A2; the typed access layer that
consumes it lives in `src/lib/db/`.

**Nothing here has been applied to a live project yet.** No Supabase project has been
chosen. The migrations are written to run cleanly top to bottom on a fresh database —
apply them to a local stack first.

---

## Applying the schema

### Local (do this first)

```bash
npm i -g supabase            # or: brew install supabase/tap/supabase
cd /Users/ivan/lantage
supabase init                # writes supabase/config.toml — keep the migrations dir as-is
supabase start               # Postgres + auth + storage in Docker
supabase db reset            # drops, recreates, replays every migration + seed
```

`supabase db reset` is the only command that proves the chain actually runs top to
bottom. Use it after every migration edit — a migration that only works when applied
on top of your current local state is a migration that will fail in production.

### Hosted project, once one exists

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push             # applies pending migrations
```

Verify before trusting it:

```bash
supabase migration list      # local vs remote, side by side
supabase db diff --linked    # must print nothing; anything here is drift
```

### No CLI available

Paste each file in `supabase/migrations/` into the SQL editor **in filename order**.
They are ordered by timestamp and are not independent — `20260729180000` defines the
helper functions every later file depends on.

### Environment

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable / anon key>
SUPABASE_SECRET_KEY=<service-role key>        # server-only, never NEXT_PUBLIC_*
SUPABASE_PROJECT_ID=<project-ref>             # only for `npm run db:types`
```

`npm run db:types` regenerates `src/lib/db/types.generated.ts` from the live schema.
It does not overwrite the hand-written `src/lib/db/types.ts` — diff them. If they
disagree, the generated file is right about the database and the hand-written one is
right about the domain (its jsonb columns are typed as the contract types from
`src/lib/contracts/types.ts`, not as `Json`). Reconcile; do not blindly copy.

---

## The `maintenance_work_mem` trap

**Read this before building an HNSW index on a table that already has rows.**

`maintenance_work_mem` defaults to **64 MB**. If the HNSW graph does not fit in it,
Postgres does not warn, does not error, and logs nothing at default settings — it
**silently** falls back to a disk-based build that is **10–50× slower**. A build you
sized at four minutes takes three hours and looks exactly the same while doing it.

Set it in the same session as the build:

```sql
SET maintenance_work_mem = '8GB';
SET max_parallel_maintenance_workers = 7;   -- one less than available cores

CREATE INDEX CONCURRENTLY mapillary_images_embedding_hnsw
  ON public.mapillary_images USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

Rules of thumb:

- Budget roughly **1.5–2× the raw vector size** for the graph. One metro at practical
  density is ~800k–1.4M × 512-d `halfvec` ≈ 0.8–1.4 GB of vectors, so 4–8 GB of
  `maintenance_work_mem` is the right order of magnitude.
- Bulk-load rows **first**, then build the index. Building it up-front and inserting
  into it is several times slower.
- Confirm you did not get the disk fallback:
  ```sql
  SET client_min_messages = 'debug1';   -- the in-memory build announces itself
  ```
  and sanity-check the wall time against `pg_relation_size('mapillary_images_embedding_hnsw')`.
- The migration creates both HNSW indexes on **empty** tables, where this is free.
  The trap is a re-index or a per-metro partial index after ingest.

### `hnsw.ef_search` — tune per query, not per index

`ef_search` (default 40) is a **read-time** knob. Baking a high value into the index
makes every cheap query pay for the expensive ones, so set it inside the transaction:

```sql
BEGIN;
SET LOCAL hnsw.ef_search = 200;
SET LOCAL hnsw.iterative_scan = 'relaxed_order';
SELECT * FROM public.search_geo_candidates(...);
COMMIT;
```

`public.search_geo_candidates()` already does both, driven by its `p_ef_search`
argument. Raise it when the bbox filter is tight: a hard filter makes the graph walk
discard more of what it finds, so it has to look at more to fill the page.

`hnsw.iterative_scan` (pgvector ≥ 0.8) is the fix for the classic filtered-ANN bug —
without it, HNSW returns `ef_search` candidates and *then* applies your `WHERE`, so a
tight filter silently returns fewer rows than you asked for. Both SET LOCALs are
wrapped in exception handlers inside the functions, so an older pgvector degrades to
default breadth instead of failing the search.

### Per-metro partial indexes

One global HNSW index is correct while Pittsburgh is the whole index. When a second
metro lands, the ANN walk starts traversing another city's vectors before the filter
throws them away. Fix:

```sql
SET maintenance_work_mem = '8GB';
CREATE INDEX CONCURRENTLY mapillary_images_embedding_hnsw_pittsburgh
  ON public.mapillary_images USING hnsw (embedding halfvec_cosine_ops)
  WHERE metro = 'pittsburgh';
```

Verify the planner uses it, and that the metro predicate is applied before the
ordering rather than after:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.search_geo_candidates('[...]'::halfvec(512), 'pittsburgh');
```

A large `Rows Removed by Filter` means the walk is happening outside the submap.

**Migration trigger away from pgvector** (MASTER_PLAN §3): >20M vectors, p95 >100 ms,
or build time >30 min. Target Qdrant self-hosted, or Turbopuffer if QPS stays
moderate. pgvector's practical single-node ceiling is ~50M vectors.

---

## Append-only: how it is enforced

`audit_log` and `ledger_entries` must survive legal discovery, so immutability is
enforced in the database at five independent layers. None of them is application code.

1. **`BEFORE UPDATE OR DELETE` triggers**, statement-level, calling
   `public.reject_mutation()` which raises `42501`. Statement-level means even
   `DELETE FROM audit_log WHERE false` fails loudly instead of succeeding silently.
2. **`BEFORE TRUNCATE` triggers.** TRUNCATE bypasses row-level triggers entirely;
   without this the scheme is theatre.
3. **`ENABLE ALWAYS`**, so `session_replication_role = 'replica'` — the standard way
   a trigger gets quietly stepped around — does not disable them.
4. **`REVOKE update, delete, truncate FROM anon, authenticated`.** PostgREST cannot
   form the request at all.
5. **No UPDATE or DELETE policy exists** on either table, so RLS denies both verbs
   before a trigger is ever consulted.

Verify after applying (all four must fail):

```sql
UPDATE public.audit_log SET action = 'x';          -- 42501
DELETE FROM public.audit_log WHERE false;          -- 42501
TRUNCATE public.audit_log;                         -- 42501
UPDATE public.ledger_entries SET summary = 'x';    -- 42501
```

**The residual risk, stated plainly:** the table *owner* can still
`DROP TRIGGER`/`ALTER TABLE ... DISABLE TRIGGER`. Schema-level enforcement cannot
close that, so it closes operationally:

- Keep the `postgres` role out of application credentials; the app uses the anon and
  service-role keys, neither of which owns these tables.
- Point-in-time recovery on, so a trigger drop is itself recoverable and visible.
- Before the first real customer: periodic export of both tables to write-once
  storage (S3 Object Lock or equivalent). That is what makes the chain of custody
  defensible rather than merely difficult to break.

**One consequence to know about before it surprises you:** `audit_log.actor_id` and
`ledger_entries.written_by` reference `app_users` with `ON DELETE RESTRICT`, and
`app_users.id` cascades from `auth.users`. So a user who has written an audit row or a
ledger entry **cannot be deleted** — the delete fails rather than orphaning the trail.
That is the intended trade: attribution outlives the account. Deactivate by clearing
`verified_at` and revoking the role, not by deleting the row.

Related product invariants that are also enforced in SQL, not just in TypeScript:

| Invariant | Where |
|---|---|
| No result without cited evidence | `geo_candidates_evidence_non_empty`, `authenticity_evidence_non_empty` |
| Confidence is a band **plus a reason** | `*_confidence_shape` |
| Street precision must be earned by `vpr-match` or `signage-ocr` | `geo_candidates_street_precision_earned` |
| A failed quality gate returns no ranking | `assert_search_not_refused()` trigger on all three candidate tables |
| Never assert authenticity | `verdict` CHECK has no `'authentic'` member |
| `suppressedBy` present iff `inconclusive` | `authenticity_suppression_matches_verdict` |
| Upstream blur is never undone | `mapillary_images_blur_intact` CHECK |

---

## RLS model

Every table has RLS enabled. Two shapes:

- **Tenant tables** — `orgs`, `app_users`, `cases`, `images`, `searches`,
  `geo_candidates`, `vehicle_candidates`, `authenticity_results`, `corpora`,
  `corpus_records`, `corpus_matches`, `audit_log`, `ledger_entries`. Isolated on
  `org_id` through `public.current_org_id()`.
- **Global reference** — `mapillary_images`, `benchmark_runs`. Readable by every
  authenticated user, writable only by the service role.

`public.current_org_id()` reads `app_metadata.org_id` from the caller's JWT and falls
back to their `app_users` row. It is `SECURITY DEFINER` because the fallback reads
`app_users`, whose own policy calls this function — running as the table owner is what
breaks that recursion.

**A1 should stamp `org_id` into `app_metadata` at sign-in** (custom access-token hook).
Everything works without it via the fallback; the hook removes one index lookup per
RLS-checked statement, which on a wide scan is worth having.

Result tables route their tenancy through `public.search_in_caller_org(search_id)`
rather than carrying their own `org_id`, so a result's tenancy is defined in exactly
one place and the two can never disagree.

Policies use `(select public.current_org_id())` rather than a bare call. The subselect
lets the planner hoist it into an InitPlan and evaluate it **once per statement**
instead of once per row.

### What cannot be deleted through the API

There is no DELETE policy on `cases`, `images`, `searches`, any result table,
`audit_log`, or `ledger_entries`. Cases **close**; evidence stays. `ledger_entries`
reference `cases` and `searches` with `ON DELETE RESTRICT`, so a case delete could not
silently cascade away append-only rows even if a policy were added later.

`corpora` and `corpus_records` **are** deletable — it is the customer's data and their
retention policy governs it. `corpus_matches` null their `corpus_id`/`record_id`
pointers rather than cascading, so a reported finding survives the purge while no
longer claiming to point at a record we hold.

### Column-level locks

RLS decides *which rows*; column privileges decide *which columns*. Combined:

| Table | Authenticated may UPDATE |
|---|---|
| `app_users` | `email` — never `org_id`, `role`, `verified_at`, `license_verified_at` |
| `cases` | `title`, `reference`, `status` |
| `images` | `case_id` |
| `searches` | `quality`, `stages`, `provenance` |
| `geo_candidates`, `vehicle_candidates`, `corpus_matches` | `review` |
| `authenticity_results` | nothing |

A user cannot move themselves to another org, promote themselves, self-attest identity
or licence verification, or rewrite what a past result claimed.

### No anonymous tier

`anon` appears in no policy, and the RLS migration ends with
`REVOKE ALL ... FROM anon` plus a matching `ALTER DEFAULT PRIVILEGES`. In January 2025
404 Media found Discord members using GeoSpy's free public tier to geolocate and stalk
specific women; Graylark pulled the tool the day they were contacted for comment. That
failure mode is designed out here, not moderated (MASTER_PLAN §7).

### Verifying tenant isolation

With two orgs and one user in each, from each user's session:

```sql
select count(*) from public.cases;             -- only their own org's rows
select count(*) from public.mapillary_images;  -- all rows (global reference)
insert into public.cases (org_id, title)
values ('<other org uuid>', 'leak');           -- must fail the WITH CHECK
```

---

## Provisioning a user

`app_users.id` is a foreign key onto `auth.users(id)`, and `org_id` is `NOT NULL` and
never client-supplied. So membership is created **server-side with the service-role
key** after identity verification, not by the client and not by a trigger on
`auth.users` (a trigger has no way to know which org a new sign-up belongs to):

```ts
import { createServiceClient } from '@/lib/db/service';

const admin = createServiceClient();
await admin.from('app_users').insert({
  id: authUser.id,          // auth.users.id — the JWT `sub`
  org_id: orgId,
  email: authUser.email!,
  role: 'analyst',
  verified_at: new Date().toISOString(),   // only once identity is actually verified
});
```

This is A1's wiring; the table and its constraints are A2's. `verified_at` null means
unverified — the app must gate search on it, not merely display it.

---

## Migrations

Run in filename order. Not independent.

| File | Contents |
|---|---|
| `20260729180000_extensions_and_helpers.sql` | pgvector, `current_org_id()`, `is_service_role()`, `reject_mutation()` |
| `20260729180100_tenancy.sql` | `orgs`, `app_users` |
| `20260729180200_cases_images_searches.sql` | `cases`, `images`, `searches` |
| `20260729180300_results.sql` | `geo_candidates`, `vehicle_candidates`, `authenticity_results`, refusal guard |
| `20260729180400_corpora.sql` | `corpora`, `corpus_records`, `corpus_matches` |
| `20260729180500_reference_data.sql` | `mapillary_images`, `benchmark_runs` |
| `20260729180600_audit_ledger_append_only.sql` | `audit_log`, `ledger_entries` + append-only enforcement |
| `20260729180700_vector_indexes.sql` | HNSW indexes, cosine, `halfvec` |
| `20260729180800_rls.sql` | RLS on every table, policies, grants, anon revoke |
| `20260729180900_search_functions.sql` | `search_geo_candidates()`, `search_corpus_records()` |
| `20260729181000_seed_demo.sql` | Demo org, case, corpus, 20 Pittsburgh rows |

New migrations get a **later** timestamp and never edit an applied file:

```bash
supabase migration new add_thing
```

### Why `halfvec`, and why 512-d / 1024-d

pgvector's HNSW index has a hard dimension ceiling: **2,000 dims for `vector`, 4,000
for `halfvec`**. MegaLoc-8448 cannot be HNSW-indexed in pgvector at all, at any
storage cost — which is the reason EigenPlaces-512 is the retrieval model and MegaLoc
is only ever a top-50 re-ranker. `halfvec` (fp16) costs **<1% recall** on L2-normalized
embeddings for half the RAM and half the index size.

```
mapillary_images.embedding   halfvec(512)    EigenPlaces / GeoCLIP
corpus_records.embedding     halfvec(1024)   DINOv2 ViT-L/14
```

Both are fixed by contract. Changing either is an index rebuild plus a re-embed, and
`src/lib/db/queries/` rejects a wrong-length vector before it reaches the database.

**Always L2-normalize before storing.** `halfvec` is fp16, unnormalized magnitudes
lose precision, and cosine only equals inner product on the unit sphere.

### Seed data

```
org      00000000-0000-4000-8000-000000000001   Lantage Demo SIU
case     00000000-0000-4000-8000-000000000002   DEMO-0001
corpus   00000000-0000-4000-8000-000000000003   8 records, 1024-d
mapillary_images                                20 rows, metro 'pittsburgh',
                                                index_build 'seed-pittsburgh@2026-07-29'
```

Coordinates are real Pittsburgh street locations. Ids (`seed-pgh-####`) and thumb URLs
(`*.invalid`) are deliberately, visibly synthetic so a seed row is never mistaken for a
harvested one and nothing tries to fetch a Mapillary asset that does not exist.
Embeddings are deterministic-random unit vectors — cosine distance between them is
meaningless as geography. They exist so ANN queries return rows and plans can be
EXPLAINed.

`app_users` is not seeded: its id is an FK onto `auth.users`, so a user has to come
from a real sign-up. The demo case therefore has `created_by = null`.

---

## Using it from TypeScript

```ts
// Server Component / Server Action / route handler.
// Next 16: cookies() is async and synchronous access is REMOVED — note the await.
import { createServerSupabaseClient } from '@/lib/db/client';
import { createCase, createSearch, searchGeoCandidates, writeAudit,
         auditContextFromHeaders, toSearchResult, getSearch } from '@/lib/db';

const supabase = await createServerSupabaseClient();

const record = await createCase(supabase, { title: 'Hail claim cluster, Allegheny Co.' });

const search = await createSearch(supabase, {
  module: 'GEO',
  imageId,
  caseId: record.id,
  hints: { bbox: [-80.1, 40.36, -79.85, 40.51] },   // [minLon, minLat, maxLon, maxLat]
});

const hits = await searchGeoCandidates(supabase, {
  embedding,            // 512-d, L2-normalized
  metro: 'pittsburgh',
  bbox: [-80.1, 40.36, -79.85, 40.51],
  limit: 50,
  efSearch: 200,        // tight bbox ⇒ more breadth
});

await writeAudit(supabase, {
  ...auditContextFromHeaders(request.headers, { orgId, actorId }),
  action: 'search.create',
  subjectType: 'search',
  subjectId: search.id,
  detail: { module: 'GEO', hitCount: hits.length },
});

const full = await getSearch(supabase, search.id);
const result = full ? toSearchResult(full) : null;   // contract-shaped SearchResult
```

Every helper takes the client as its first argument, so the same function runs against
a request-scoped RLS client and against the service-role client without a second
implementation. Reaching for `createServiceClient()` because a policy is in the way
means the policy is wrong.

Helpers throw `DbError` rather than returning `{ data, error }`. In a forensic tool a
swallowed Postgres error means a search that looks complete but isn't. `DbError.isRefusal`
is true for `42501` — an append-only violation, a refused quality gate, or an RLS
denial. Retrying those will never help.

`writeAudit` throwing fails the caller's request, and that is intended: if an action
cannot be recorded, the product should not take it.
