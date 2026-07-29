/**
 * Per-user and per-org rate limits.
 *
 * MASTER_PLAN §7, the GeoSpy lesson: "no anonymous tier, ever. Identity
 * verification at signup. PI licence validation against state registries.
 * Per-search audit logging with retention. **Rate limits.** A documented
 * abuse-response process."
 *
 * The limit is not primarily about cost. It is an abuse control: the January 2025
 * GeoSpy incident was a small number of accounts running a large number of
 * searches against images of specific people. A per-account ceiling makes that
 * pattern expensive and, more importantly, makes it *visible* — every hit writes a
 * `ratelimit.hit` audit row, which is what turns "someone was hammering the tool"
 * into a reviewable record with a name on it.
 *
 * ## Why the counter reads the audit log
 *
 * The default counter counts `search.create` rows in the window rather than
 * keeping an in-process tally. An in-memory counter is wrong on Vercel: each
 * Function instance has its own memory, so N instances means N× the limit, and the
 * limit silently loosens under exactly the load that makes it matter. Counting the
 * audit table is correct across instances, needs no new infrastructure, and has a
 * useful property — the thing enforcing the limit is the same immutable record
 * that would be produced in discovery.
 *
 * It costs one indexed count per search. That is acceptable at the search volumes
 * in MASTER_PLAN §9 (350 searches/licence/year at the low end, 150k/year at the
 * Miami-Dade end). If it stops being acceptable, swap in a Redis counter behind
 * `RateLimitCounter` — the interface exists for that.
 */

import { type Gate, permit, refuse } from '@/lib/auth/result';
import type { LantageClient } from '@/lib/db/client';
import { DbError } from '@/lib/db/errors';

import type { AuthUser } from './types';

export interface RateLimitPolicy {
  readonly windowSec: number;
  /** Ceiling for one user in the window. */
  readonly maxPerUser: number;
  /** Ceiling for the whole org in the window. Not the sum of its users'. */
  readonly maxPerOrg: number;
  /** Stable id, recorded on the audit row so a hit is traceable to a policy. */
  readonly id: string;
}

/**
 * Defaults, calibrated against the contract data in MASTER_PLAN §9 rather than
 * guessed. GeoSpy's list price includes 350 searches/licence/year; Miami-Dade's
 * quote covers 150k searches. So a legitimate heavy user runs single-digit
 * searches an hour, and a hundred an hour is not investigation.
 *
 * Set generously on purpose. A limit that catches real work generates support
 * tickets and gets raised until it means nothing; one that only catches abuse
 * survives. Tune per contract, not by loosening these.
 */
export const DEFAULT_RATE_LIMITS: Readonly<Record<'search' | 'export' | 'upload', RateLimitPolicy>> =
  {
    search: { id: 'search.hourly.v1', windowSec: 3600, maxPerUser: 120, maxPerOrg: 600 },
    // Exports leave the building. Tighter, and every one is already audited.
    export: { id: 'export.hourly.v1', windowSec: 3600, maxPerUser: 30, maxPerOrg: 150 },
    upload: { id: 'upload.hourly.v1', windowSec: 3600, maxPerUser: 300, maxPerOrg: 1500 },
  };

export type RateLimitScope = keyof typeof DEFAULT_RATE_LIMITS;

/** Which audit action each scope counts. */
const COUNTED_ACTION: Record<RateLimitScope, string> = {
  search: 'search.create',
  export: 'case.export',
  upload: 'image.upload',
};

export interface RateLimitGrant {
  readonly policyId: string;
  readonly scope: RateLimitScope;
  /** Uses consumed by this user in the window, before this one. */
  readonly userCount: number;
  readonly orgCount: number;
  readonly userLimit: number;
  readonly orgLimit: number;
  /** ISO 8601 — when the window rolls and the caller may retry. */
  readonly resetsAt: string;
}

export type RateLimitCode = 'rate-limited';

/**
 * Pluggable counter. Swap for Redis when the count query stops being cheap.
 * `windowStart` is ISO 8601.
 */
export interface RateLimitCounter {
  countForUser(scope: RateLimitScope, userId: string, windowStart: string): Promise<number>;
  countForOrg(scope: RateLimitScope, orgId: string, windowStart: string): Promise<number>;
}

/** Counts rows in `audit_log`. Correct across instances; see the module note. */
export function auditBackedCounter(client: LantageClient): RateLimitCounter {
  async function count(
    scope: RateLimitScope,
    column: 'actor_id' | 'org_id',
    value: string,
    windowStart: string,
  ): Promise<number> {
    // `head: true` — the row bodies are never needed, only the count, and a
    // multi-year audit table is not something to pull into memory hourly.
    const { count: n, error } = await client
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('action', COUNTED_ACTION[scope])
      .eq(column, value)
      .gte('at', windowStart);

    // `unwrap` from the data layer expects a `data` field, which a head+count
    // query does not return. Thrown here and caught by `checkRateLimit`, which
    // fails open — see the note on that function for why this one control does.
    if (error) throw new DbError(`rateLimitCount(${scope}/${column})`, error);
    return n ?? 0;
  }

  return {
    countForUser: (scope, userId, windowStart) => count(scope, 'actor_id', userId, windowStart),
    countForOrg: (scope, orgId, windowStart) => count(scope, 'org_id', orgId, windowStart),
  };
}

/**
 * Check and consume one unit.
 *
 * Returns a typed refusal on a hit — and the caller MUST write the
 * `ratelimit.hit` audit row. `guardSearch` in `guard.ts` does that; if you call
 * this directly, do the same. The audit row is the point of the limit.
 *
 * Fails **open** if the counter itself errors, and this is the one place in the
 * governance layer that does. Rationale: the rate limit is an abuse control, not
 * an authorization control. Verification, jurisdiction, and audit all fail closed
 * ahead of it, so a counter outage cannot let an unverified account search — it
 * can only let a verified one search more than intended, for the duration of the
 * outage, with every search still audited. Turning a Postgres blip into a
 * total product outage would be the worse trade.
 */
export async function checkRateLimit(
  counter: RateLimitCounter,
  user: AuthUser,
  scope: RateLimitScope,
  policy: RateLimitPolicy = DEFAULT_RATE_LIMITS[scope],
): Promise<Gate<RateLimitGrant, RateLimitCode>> {
  const now = Date.now();
  const windowStart = new Date(now - policy.windowSec * 1000).toISOString();
  const resetsAt = new Date(now + policy.windowSec * 1000).toISOString();
  const orgId = user.org?.id ?? null;

  let userCount = 0;
  let orgCount = 0;
  try {
    userCount = await counter.countForUser(scope, user.id, windowStart);
    orgCount = orgId ? await counter.countForOrg(scope, orgId, windowStart) : 0;
  } catch (cause) {
    console.error(
      `[rate-limit] counter unavailable for ${scope}/${policy.id}, failing open: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return permit({
      policyId: policy.id,
      scope,
      userCount: 0,
      orgCount: 0,
      userLimit: policy.maxPerUser,
      orgLimit: policy.maxPerOrg,
      resetsAt,
    });
  }

  const grant: RateLimitGrant = {
    policyId: policy.id,
    scope,
    userCount,
    orgCount,
    userLimit: policy.maxPerUser,
    orgLimit: policy.maxPerOrg,
    resetsAt,
  };

  if (userCount >= policy.maxPerUser) {
    return refuse('rate-limited', rateLimitMessage(scope, 'account', policy), {
      remedy: `The limit resets by ${resetsAt}. Contact support if your work needs a higher ceiling.`,
      detail: {
        policy: policy.id,
        scope,
        bound: 'user',
        count: userCount,
        limit: policy.maxPerUser,
        window_sec: policy.windowSec,
        resets_at: resetsAt,
      },
    });
  }

  if (orgId && orgCount >= policy.maxPerOrg) {
    return refuse('rate-limited', rateLimitMessage(scope, 'organisation', policy), {
      remedy: `The limit resets by ${resetsAt}. Contact your Lantage account contact to raise it.`,
      detail: {
        policy: policy.id,
        scope,
        bound: 'org',
        count: orgCount,
        limit: policy.maxPerOrg,
        window_sec: policy.windowSec,
        resets_at: resetsAt,
      },
    });
  }

  return permit(grant);
}

function rateLimitMessage(scope: RateLimitScope, bound: string, policy: RateLimitPolicy): string {
  const hours = Math.round(policy.windowSec / 3600);
  const per = hours === 1 ? 'in the last hour' : `in the last ${hours} hours`;
  const noun = scope === 'search' ? 'searches' : scope === 'export' ? 'exports' : 'uploads';
  return `This ${bound} has reached its limit of ${noun} ${per}.`;
}
