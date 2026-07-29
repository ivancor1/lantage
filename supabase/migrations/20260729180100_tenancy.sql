-- Lantage — 02 · orgs and app_users
--
-- No anonymous tier, ever (docs/MASTER_PLAN.md §7, the GeoSpy lesson). Every row
-- in this database belongs to an org, and every org member is an identified,
-- verifiable person. The columns that carry that proof — verified_at,
-- license_number, license_state, license_verified_at — are not decorative and
-- are not self-editable (see the column-level revoke in the RLS migration).

set search_path = public, extensions;

create table public.orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  created_at  timestamptz not null default now()
);

comment on table public.orgs is 'Tenant boundary. Every RLS policy in this schema keys off org_id.';

-- Named app_users, not users: auth.users belongs to Supabase and we do not own
-- it. id is 1:1 with auth.users.id rather than a fresh uuid, so a token's `sub`
-- claim is directly joinable and there is no second identity to keep in sync.
create table public.app_users (
  id                   uuid primary key references auth.users (id) on delete cascade,
  org_id               uuid not null references public.orgs (id) on delete cascade,
  email                text not null,
  role                 text not null default 'analyst'
                         check (role in ('owner', 'admin', 'analyst', 'viewer')),

  -- Identity verification at signup. Null means unverified: the app must gate
  -- search on this, not merely display it.
  verified_at          timestamptz,

  -- PI / investigator licence, validated against the state registry.
  license_number       text,
  license_state        text check (license_state is null or license_state ~ '^[A-Z]{2}$'),
  license_verified_at  timestamptz,

  created_at           timestamptz not null default now(),

  -- A licence claim is incomplete without the jurisdiction that issued it, and
  -- cannot be marked verified before it is recorded.
  constraint app_users_license_pair check (
    (license_number is null) = (license_state is null)
  ),
  constraint app_users_license_verified_needs_license check (
    license_verified_at is null or license_number is not null
  )
);

create unique index app_users_org_email_key on public.app_users (org_id, lower(email));

comment on table public.app_users is
  'Org membership + identity/licence verification state. id mirrors auth.users.id. Provisioned server-side with the service-role key after signup — org_id is never client-supplied.';
comment on column public.app_users.verified_at is
  'Identity verification timestamp. Null = unverified; the product has no anonymous tier (MASTER_PLAN §7).';
