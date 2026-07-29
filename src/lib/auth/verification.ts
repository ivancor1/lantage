/**
 * Identity verification — survival infrastructure, not paperwork.
 *
 * ## Why this file exists
 *
 * In January 2025, 404 Media found Discord members using GeoSpy's free anonymous
 * tier to geolocate and stalk specific women. Graylark pulled the free tool the
 * day they were contacted for comment. That nearly ended the company.
 *
 * MASTER_PLAN §7 draws the conclusion: "**from commit one:** no anonymous tier,
 * ever. Identity verification at signup. PI licence validation against state
 * registries. Per-search audit logging with retention. Rate limits. A documented
 * abuse-response process."
 *
 * The whole point is that this cannot be a policy someone forgets to enforce. So
 * the enforcement is structural:
 *
 *  - `canSearch()` is the only way to obtain a `VerifiedSearcher`.
 *  - `VerifiedSearcher` is branded, so it cannot be forged with an object literal.
 *  - Search entry points take a `VerifiedSearcher`, not an `AuthUser`. A code path
 *    that skipped the gate therefore does not compile.
 *
 * There is no `allowAnonymous` flag, no dev bypass, and no "free tier" branch. If
 * one is ever needed for a demo, it belongs in seeded data with a real verified
 * account behind it — not in this file.
 */

import { type Gate, permit, refuse } from '@/lib/auth/result';
import type { AuthUser, VerificationStatus } from './types';
import { roleSatisfies } from './types';

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

declare const verifiedBrand: unique symbol;

/**
 * An account that has cleared every precondition for running a search.
 *
 * Branded and constructible only by `canSearch`. Search entry points should take
 * this type — that is what makes "no anonymous access to any search module" a
 * compile-time property rather than a code-review habit.
 *
 * The brand is **type-only**: `declare const` emits no JavaScript, so the property
 * must never appear in a runtime object literal or it throws `ReferenceError` at
 * the first call. `canSearch` builds the plain object and asserts the type.
 */
export interface VerifiedSearcher {
  readonly [verifiedBrand]: true;
  readonly user: AuthUser;
  readonly userId: string;
  readonly orgId: string;
  readonly email: string | null;
}

export type SearchDenialCode =
  | 'not-authenticated'
  | 'anonymous-session'
  | 'no-org'
  | 'not-verified'
  | 'verification-pending'
  | 'verification-rejected'
  | 'insufficient-role';

/**
 * May this account run a search at all?
 *
 * Pure, synchronous, no I/O — so the same function decides whether the UI enables
 * the module tiles and whether the API accepts the request. Only the second one is
 * load-bearing.
 *
 * Module-level and jurisdiction checks are NOT here: this answers "is this a real,
 * verified professional", and `isModuleAllowed` answers "may they use this module
 * here". `guardSearch()` composes both in the right order.
 */
export function canSearch(user: AuthUser | null): Gate<VerifiedSearcher, SearchDenialCode> {
  if (!user) {
    return refuse('not-authenticated', 'Sign in to run a search.', {
      remedy: 'Lantage has no anonymous access. Every search is attributed to a verified account.',
    });
  }

  // Supabase can mint anonymous sessions. Checked explicitly and refused
  // explicitly, rather than filtered out upstream, so the refusal is recorded
  // with its own code — an anonymous session reaching this point is a
  // configuration error worth seeing in the audit trail.
  if (user.isAnonymous) {
    return refuse('anonymous-session', 'Anonymous sessions cannot run searches.', {
      citation: 'MASTER_PLAN §7 — no anonymous tier, ever (the GeoSpy lesson).',
      remedy: 'Sign in with a verified professional account.',
    });
  }

  if (!user.org) {
    return refuse('no-org', 'Your account is not attached to an organisation yet.', {
      remedy:
        'Search access is granted through an organisation with a signed agreement. An ' +
        'administrator must add you to one.',
    });
  }

  // A viewer reads the case file. Running a search is an act with a name on it.
  if (!roleSatisfies(user.role, 'investigator')) {
    return refuse('insufficient-role', 'Your role does not include running searches.', {
      detail: { held: user.role, required: 'investigator' },
      remedy: 'Ask an administrator for investigator access.',
    });
  }

  switch (user.verification) {
    case 'verified':
      break;
    case 'pending':
      return refuse(
        'verification-pending',
        'Your identity verification is still under review.',
        {
          remedy:
            'Professional licence verification is reviewed by a person, usually within one ' +
            'business day. You will be emailed when it completes.',
        },
      );
    case 'rejected':
      return refuse('verification-rejected', 'Your identity verification was not accepted.', {
        remedy: 'Contact support to appeal or resubmit with corrected licence details.',
      });
    case 'unverified':
      return refuse('not-verified', 'Verify your identity before running a search.', {
        citation: 'MASTER_PLAN §7 — identity verification at signup, licence validation required.',
        remedy: 'Submit your professional licence for verification.',
      });
  }

  // The brand is not set — it does not exist at runtime. See the note on the type.
  return permit({
    user,
    userId: user.id,
    orgId: user.org.id,
    email: user.email,
  } as VerifiedSearcher);
}

/** Cheap predicate for UI. The gate is what enforces; this only styles. */
export function isVerified(user: AuthUser | null): boolean {
  return user?.verification === 'verified' && !user.isAnonymous;
}

// ---------------------------------------------------------------------------
// Professional licence verification
// ---------------------------------------------------------------------------

/**
 * What the account is claiming to be. Each maps to a different registry and a
 * different set of things that can be checked.
 */
export const LICENCE_KINDS = [
  'private-investigator',
  'insurance-adjuster',
  'insurance-siu',
  'law-enforcement',
  'attorney',
  'sar-nonprofit',
] as const;
export type LicenceKind = (typeof LICENCE_KINDS)[number];

export interface LicenceClaim {
  readonly kind: LicenceKind;
  /** As printed on the licence. Not normalised — formats differ per state. */
  readonly number: string;
  /** Two-letter USPS code of the issuing state. */
  readonly state: string;
  /** Name as it appears on the licence, for comparison against the registry. */
  readonly holderName: string;
  /** Employer or agency, where the licence is held through one. */
  readonly organisation?: string;
  /** ISO 8601 date, when the claimant supplies it. */
  readonly expiresOn?: string;
}

/**
 * Outcome of a licence check.
 *
 * `queued` is a first-class outcome, not an error. Manual review IS the v1 path —
 * see `ManualReviewProvider` below.
 */
export type LicenceCheck =
  | {
      readonly outcome: 'verified';
      readonly providerId: string;
      readonly checkedAt: string;
      /** What the registry actually returned. Kept for the audit trail. */
      readonly registryRecord: { readonly status: string; readonly holderName?: string; readonly expiresOn?: string };
    }
  | {
      readonly outcome: 'queued';
      readonly providerId: string;
      readonly queuedAt: string;
      readonly reviewId: string;
      readonly expectedWithin: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly providerId: string;
      readonly checkedAt: string;
      /** Shown to the claimant, so it must be actionable and not accusatory. */
      readonly reason: string;
    }
  | {
      readonly outcome: 'unsupported';
      readonly providerId: string;
      readonly state: string;
      readonly reason: string;
    };

/**
 * A source of truth for one or more states' licence registries.
 *
 * **Every US state publishes a PI licence lookup** (MASTER_PLAN §9 makes licence
 * verification mandatory for the self-serve tier). They are all different: some
 * are a searchable web form, some a downloadable roster, a few have an API. So the
 * interface is written so a per-state adapter can drop in later without touching
 * any call site.
 *
 * **No scrapers are implemented here, deliberately.** A scraper against a state
 * registry is a maintenance liability that breaks silently — and a silently broken
 * verification check is worse than no automated check at all, because it returns
 * `verified` for nobody or, worse, for everybody. Manual review is the v1 path.
 * When a state adapter is added, it must fail to `queued`, never to `verified`.
 */
export interface LicenceVerificationProvider {
  readonly id: string;
  /** States this provider covers, or `'all'` for the manual fallback. */
  readonly states: readonly string[] | 'all';
  readonly kinds: readonly LicenceKind[] | 'all';
  supports(claim: LicenceClaim): boolean;
  verify(claim: LicenceClaim, subject: LicenceSubject): Promise<LicenceCheck>;
}

/** Who the claim belongs to. Needed so a queued review has a person attached. */
export interface LicenceSubject {
  readonly userId: string;
  readonly orgId: string | null;
}

/**
 * Where a manual review lands so a human can action it.
 *
 * TODO(A2): a `verification_reviews` table — `id`, `user_id`, `org_id`, `kind`,
 * `license_number`, `license_state`, `holder_name`, `submitted_at`,
 * `decided_at`, `decided_by`, `decision`, `note`. Until it exists, the default
 * implementation records the submission in the audit trail (which is immutable and
 * queryable) and returns a deterministic review id derived from the claim, so the
 * queue is reconstructible from `verification.change` rows.
 */
export interface ManualReviewQueue {
  enqueue(claim: LicenceClaim, subject: LicenceSubject): Promise<{ reviewId: string }>;
}

/**
 * The default queue while there is no table: a deterministic review id derived
 * from the claim.
 *
 * Deterministic on purpose. Resubmitting the same licence must land on the same
 * review rather than opening a second one, and because the id is a pure function
 * of the claim, the queue is reconstructible from the `verification.change` audit
 * rows alone — which is what makes it safe to have no table yet.
 *
 * The audit row is written by `applyVerificationDecision`, not here, so a queue
 * implementation stays free of a database client.
 */
export function deterministicReviewQueue(): ManualReviewQueue {
  return {
    async enqueue(claim, subject) {
      const seed = `${subject.userId}|${claim.state.toUpperCase()}|${claim.number.replace(/[^a-z0-9]/gi, '').toUpperCase()}`;
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
      const hex = [...new Uint8Array(digest)]
        .slice(0, 8)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return { reviewId: `review_${hex}` };
    },
  };
}

/**
 * The v1 provider: queue everything for a person to check.
 *
 * This is not a placeholder for a scraper. It is the correct v1 answer. At the
 * volumes in MASTER_PLAN §9 — a handful of PI signups per week at $99–199/mo —
 * a human opening the state's lookup page is faster to build, more accurate, and
 * more defensible than any scraper, and it produces a named reviewer for every
 * approval. Build the state adapters when the queue depth justifies them, and
 * keep this as the fallback for every state that has no adapter.
 */
export class ManualReviewProvider implements LicenceVerificationProvider {
  readonly id = 'manual-review';
  readonly states = 'all' as const;
  readonly kinds = 'all' as const;

  constructor(
    private readonly queue: ManualReviewQueue = deterministicReviewQueue(),
    private readonly expectedWithin = 'one business day',
  ) {}

  supports(): boolean {
    return true;
  }

  async verify(claim: LicenceClaim, subject: LicenceSubject): Promise<LicenceCheck> {
    const obvious = obviouslyInvalid(claim);
    if (obvious) {
      // Cheap syntactic rejections happen here rather than wasting a reviewer's
      // time. Note this never *approves* anything — the only automated outcome is
      // a rejection, which is the safe direction.
      return { outcome: 'rejected', providerId: this.id, checkedAt: new Date().toISOString(), reason: obvious };
    }

    const { reviewId } = await this.queue.enqueue(claim, subject);
    return {
      outcome: 'queued',
      providerId: this.id,
      queuedAt: new Date().toISOString(),
      reviewId,
      expectedWithin: this.expectedWithin,
    };
  }
}

/** Syntactic checks only. Never a substitute for the registry lookup. */
function obviouslyInvalid(claim: LicenceClaim): string | null {
  if (claim.state.trim().length !== 2) {
    return 'Enter the two-letter code of the state that issued the licence.';
  }
  if (claim.number.replace(/[^a-z0-9]/gi, '').length < 4) {
    return 'That licence number is too short. Enter it as printed on the licence.';
  }
  if (claim.holderName.trim().split(/\s+/).length < 2) {
    return 'Enter the full name as printed on the licence.';
  }
  if (claim.expiresOn) {
    const expiry = Date.parse(claim.expiresOn);
    if (Number.isNaN(expiry)) return 'The expiry date is not a valid date.';
    if (expiry < Date.now()) return 'That licence has expired. Submit a current one.';
  }
  return null;
}

/**
 * Provider registry. First provider that `supports()` the claim wins, so
 * per-state adapters registered ahead of `ManualReviewProvider` take precedence
 * and anything they do not cover falls through to human review.
 */
export class LicenceVerificationRegistry {
  private readonly providers: LicenceVerificationProvider[] = [];

  register(provider: LicenceVerificationProvider): this {
    this.providers.push(provider);
    return this;
  }

  resolve(claim: LicenceClaim): LicenceVerificationProvider | null {
    return this.providers.find((p) => p.supports(claim)) ?? null;
  }
}

/**
 * Validate a professional licence against a state registry.
 *
 * Returns `unsupported` rather than throwing when no provider matches, because a
 * missing adapter is a product gap the UI should explain, not a 500.
 *
 * The caller is responsible for two things this function does not do, because both
 * need a database client and an authenticated actor:
 *
 *  1. writing the `verification.change` audit row, and
 *  2. setting `app_users.verified_at` / `license_verified_at` — with the
 *     service-role client, since column privileges deliberately forbid a user from
 *     self-attesting verification (see `20260729180800_rls.sql`).
 *
 * `applyVerificationDecision` in `provisioning.ts` does both.
 */
export async function verifyProfessionalLicense(
  claim: LicenceClaim,
  subject: LicenceSubject,
  registry: LicenceVerificationRegistry = defaultLicenceRegistry(),
): Promise<LicenceCheck> {
  const provider = registry.resolve(claim);
  if (!provider) {
    return {
      outcome: 'unsupported',
      providerId: 'none',
      state: claim.state.toUpperCase(),
      reason:
        `No licence-verification provider is configured for ${claim.state.toUpperCase()}. ` +
        `Register a state adapter or a ManualReviewProvider.`,
    };
  }
  return provider.verify(claim, subject);
}

/**
 * The v1 registry: manual review for every state.
 *
 * Register per-state adapters *ahead* of the manual provider as they are built —
 * `resolve` takes the first match, so anything a state adapter does not cover
 * falls through to a human. An adapter must never fail to `verified`; failing to
 * `queued` is the only safe failure mode for an automated registry check.
 */
export function defaultLicenceRegistry(): LicenceVerificationRegistry {
  return new LicenceVerificationRegistry().register(new ManualReviewProvider());
}

/** Maps a check outcome onto the stored status. `unsupported` stays `pending`. */
export function statusForCheck(check: LicenceCheck): VerificationStatus {
  switch (check.outcome) {
    case 'verified':
      return 'verified';
    case 'rejected':
      return 'rejected';
    case 'queued':
    case 'unsupported':
      // Deliberately not 'unverified': the claimant has done their part, and the
      // distinction is what the UI uses to say "under review" instead of
      // "submit your licence". Neither status can search.
      return 'pending';
  }
}
