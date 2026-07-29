/**
 * Identity model.
 *
 * Leaf module — imports nothing from `audit/`, `jurisdiction/`, or `db/` beyond
 * A2's row types, so all three can depend on it without a cycle.
 *
 * This file reconciles two vocabularies. A2's schema (`src/lib/db/types.ts`)
 * calls roles `owner | admin | analyst | viewer` and stores verification as
 * nullable timestamps. The governance spec calls roles
 * `admin | investigator | viewer` and verification a four-state enum. Rather
 * than force a migration on A2 or quietly drop a state, the mapping is explicit
 * and lives here, in one direction only: the database is the source of truth,
 * this module is the domain view of it.
 */

import type { AppUserRow, OrgRow, UserRole } from '@/lib/db/types';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Three roles, ordered. Deliberately small.
 *
 * - `viewer`       — reads case files and results. Cannot run a search, cannot export.
 * - `investigator` — runs searches, reviews results, records corroboration.
 * - `admin`        — the above, plus membership, export, and verification decisions.
 *
 * Note what is NOT here: no role can edit or delete an audit row. That
 * capability does not exist in the product, and it is enforced by a Postgres
 * trigger (`reject_mutation`), not by this union.
 */
export const ROLES = ['viewer', 'investigator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { viewer: 0, investigator: 1, admin: 2 };

/** Strictly ordered, not a set: `admin` satisfies `requireRole('investigator')`. */
export function roleSatisfies(held: Role, required: Role): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

/**
 * DB role -> domain role. `owner` collapses into `admin` because the extra
 * capability an owner has (billing) is not modelled here, and `analyst` is what
 * the schema calls an investigator.
 *
 * Safe in this direction only. Do not write the inverse without deciding what
 * `admin` means on the way back — it is ambiguous.
 */
export function roleFromDb(role: UserRole): Role {
  switch (role) {
    case 'owner':
    case 'admin':
      return 'admin';
    case 'analyst':
      return 'investigator';
    case 'viewer':
      return 'viewer';
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Account verification state. Gates every search module — see `verification.ts`
 * and the GeoSpy note there.
 *
 * `pending` is not a soft yes. A pending account has exactly the search rights
 * of an unverified one: none.
 */
export const VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export function isVerificationStatus(v: unknown): v is VerificationStatus {
  return typeof v === 'string' && (VERIFICATION_STATUSES as readonly string[]).includes(v);
}

/**
 * Derives the four-state status from the columns A2 actually ships:
 * `verified_at`, `license_number`, `license_verified_at`.
 *
 *   verified_at set                       -> verified
 *   licence claimed, not yet adjudicated  -> pending
 *   nothing claimed                       -> unverified
 *
 * `rejected` is NOT derivable from these columns — nothing records a refusal. It
 * is returned by `verifyProfessionalLicense` and written to the audit trail as
 * `verification.change`, so a reviewer can always answer "was this person turned
 * down, and when". But a fresh page load of a rejected account reads back as
 * `unverified`.
 *
 * TODO(A2): add `app_users.verification_rejected_at timestamptz`, or a
 * `verification_reviews` table, so a rejection survives a reload. Until then the
 * failure direction is the safe one — a rejected account reading as `unverified`
 * is still denied every search — so this is a UX gap, not a security hole.
 */
export function verificationFromRow(
  row: Pick<AppUserRow, 'verified_at' | 'license_number' | 'license_verified_at'>,
): VerificationStatus {
  if (row.verified_at) return 'verified';
  if (row.license_number) return 'pending';
  return 'unverified';
}

// ---------------------------------------------------------------------------
// Customer type — drives jurisdiction gating
// ---------------------------------------------------------------------------

/**
 * Which body of law reaches this org.
 *
 * CCOPS ordinances and municipal face-recognition bans bind *government
 * agencies* acquiring or using surveillance technology. They do not reach an
 * insurance SIU unit reviewing its own claim photos. Getting this wrong in
 * either direction is a real failure: too broad and we block the wedge customer
 * for no legal reason; too narrow and we hand an agency a module its city
 * council banned.
 *
 * Set per-org at contract time, from the signed MSA. Never inferred from an
 * email domain.
 */
export const CUSTOMER_TYPES = [
  'insurance-siu',
  'private-professional',
  'government-agency',
  'nonprofit',
] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export function isCustomerType(v: unknown): v is CustomerType {
  return typeof v === 'string' && (CUSTOMER_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Org + user
// ---------------------------------------------------------------------------

/**
 * The org's operating jurisdiction. This is where the *user* is, whose
 * ordinances govern their use of the tool — not where the imagery was taken. A
 * Pittsburgh detective analysing a photo shot in Ohio is still bound by
 * Pittsburgh's CCOPS ordinance.
 */
export interface OrgJurisdiction {
  /** Two-letter USPS code, upper case. */
  readonly state: string;
  readonly city?: string;
  readonly county?: string;
}

export interface Org {
  readonly id: string;
  readonly name: string;
  readonly customerType: CustomerType;
  readonly jurisdiction: OrgJurisdiction;
  /**
   * Modules switched off for this customer by contract, independent of law.
   * Belt and braces with the jurisdiction table: a customer who has not signed
   * the MATCH addendum does not get MATCH even in a permissive state.
   */
  readonly disabledModules: readonly string[];
}

/**
 * A resolved, authenticated principal.
 *
 * Assembled from a *verified* JWT plus the `app_users` row — never from
 * `getSession()` alone, and never from a client-supplied header.
 */
export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
  readonly role: Role;
  readonly verification: VerificationStatus;
  readonly org: Org | null;
  /**
   * True when the JWT carries `is_anonymous`. Supabase can mint these; Lantage
   * must never honour one for a search. Kept as a field rather than filtered out
   * at load time so `canSearch` can record *why* it refused.
   */
  readonly isAnonymous: boolean;
  /** Licence on file, if any. Drives the verification UI, not authorization. */
  readonly licence: { number: string | null; state: string | null; verifiedAt: string | null };
}

export function authUserFromRows(
  row: AppUserRow,
  org: Org | null,
  opts: { isAnonymous?: boolean } = {},
): AuthUser {
  return {
    id: row.id,
    email: row.email ?? null,
    role: roleFromDb(row.role),
    verification: verificationFromRow(row),
    org,
    isAnonymous: opts.isAnonymous ?? false,
    licence: {
      number: row.license_number,
      state: row.license_state,
      verifiedAt: row.license_verified_at,
    },
  };
}

/**
 * `orgs` currently carries only `id`, `name`, `created_at` — there is no
 * `customer_type` or jurisdiction column. The classification therefore comes
 * from deployment config (`src/lib/jurisdiction/assignment.ts`) and is injected
 * here. See the TODO in that file.
 */
export function orgFromRow(
  row: OrgRow,
  classification: {
    customerType: CustomerType;
    jurisdiction: OrgJurisdiction;
    disabledModules?: readonly string[];
  },
): Org {
  return {
    id: row.id,
    name: row.name,
    customerType: classification.customerType,
    jurisdiction: {
      state: classification.jurisdiction.state.toUpperCase(),
      city: classification.jurisdiction.city,
      county: classification.jurisdiction.county,
    },
    disabledModules: classification.disabledModules ?? [],
  };
}
