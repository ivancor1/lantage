/**
 * The composed search authorization pipeline, and the adapter B2's cascade binds.
 *
 * Order is a security property, not a style choice. `/api/search` documents it as:
 *
 *   validate -> authenticate -> verify the account -> check the module is
 *   permitted in this jurisdiction -> write the audit row -> run
 *
 * `guardSearch()` is steps 2–4 in one call, in that order, and the order matters
 * for a specific reason: the *first* refusal is the one the analyst sees, so an
 * unverified user in a banned city must be told they are unverified rather than
 * shown a legal citation they cannot act on. Cheapest and most actionable refusal
 * first.
 *
 * Every refusal writes an audit row. A rate-limit hit writes `ratelimit.hit` and a
 * jurisdiction block writes `module.blocked` — the two refusals MASTER_PLAN §7
 * specifically wants on the record, since one is the abuse signal and the other is
 * the compliance evidence.
 */

import type { ModuleId } from '@/lib/contracts/types';
import type { AuthGate, SearchPrincipal } from '@/lib/cascade/deps';
import { createServerSupabaseClient, type LantageClient } from '@/lib/db/client';
import { auditRefusal } from '@/lib/audit/with-audit';
import type { AuditActorRef, AuditAction } from '@/lib/audit/types';
import {
  formatJurisdiction,
  isModuleAllowed,
  parseJurisdiction,
  type ModuleBlocked,
} from '@/lib/jurisdiction';

import { readRequestContext, type RequestContext } from './request-context';
import { type Gate, isRefusal, permit, refuse, type Refusal } from './result';
import { getCurrentUser } from './session';
import type { AuthUser } from './types';
import {
  auditBackedCounter,
  checkRateLimit,
  DEFAULT_RATE_LIMITS,
  type RateLimitCode,
  type RateLimitGrant,
} from './rate-limit';
import { canSearch, type SearchDenialCode, type VerifiedSearcher } from './verification';

export type SearchGuardCode = SearchDenialCode | RateLimitCode | 'module-blocked';

export interface SearchGrant {
  readonly searcher: VerifiedSearcher;
  readonly user: AuthUser;
  readonly module: ModuleId;
  readonly context: RequestContext;
  readonly rateLimit: RateLimitGrant;
  /** Conditions the analyst must be shown, e.g. `not-sole-basis-for-arrest`. */
  readonly constraints: readonly string[];
  readonly client: LantageClient;
}

/**
 * Authorize one search. The single entry point — do not reimplement any part of
 * this chain at a call site.
 *
 * `headers` is whatever the caller has: a Route Handler's `request.headers` or the
 * result of `await headers()`. It is used for the audit context only, never for
 * authorization.
 */
export async function guardSearch(args: {
  readonly module: ModuleId;
  readonly headers: Headers;
  readonly imageId?: string;
  readonly caseId?: string;
  readonly client?: LantageClient;
}): Promise<Gate<SearchGrant, SearchGuardCode>> {
  const client = args.client ?? (await createServerSupabaseClient());
  const context = readRequestContext(args.headers);
  const user = await getCurrentUser(client);

  const subject = {
    type: 'module' as const,
    id: args.module,
    module: args.module,
    imageId: args.imageId,
    caseId: args.caseId,
  };

  // --- 1. authenticated + identity-verified --------------------------------
  const verified = canSearch(user);
  if (isRefusal(verified)) {
    await recordRefusal(client, 'search.refuse', user, context, subject, verified);
    return verified;
  }
  const searcher = verified.value;

  // --- 2. jurisdiction ------------------------------------------------------
  const org = searcher.user.org;
  const decision = isModuleAllowed(args.module, org?.jurisdiction, {
    customerType: org?.customerType,
    disabledModules: org?.disabledModules,
    enabledModules: org?.enabledModules,
    // Warrants and court orders are per-search authority and are not yet captured
    // on the request. Until they are, a warrant state denies MATCH — which is the
    // correct default: MATCH is v2 and gated anyway.
    // TODO: accept a recorded warrant reference on the search request and pass it
    // here, so a Montana or Utah agency can run MATCH with the warrant on the row.
  });

  if (!decision.allowed) {
    const blocked = moduleBlockedRefusal(decision);
    await recordRefusal(client, 'module.blocked', searcher.user, context, subject, blocked);
    return blocked;
  }

  // --- 3. rate limit --------------------------------------------------------
  const limit = await checkRateLimit(
    auditBackedCounter(client),
    searcher.user,
    'search',
    DEFAULT_RATE_LIMITS.search,
  );
  if (isRefusal(limit)) {
    // The audit row is the point of the rate limit — see rate-limit.ts.
    await recordRefusal(client, 'ratelimit.hit', searcher.user, context, subject, limit);
    return limit;
  }

  return permit({
    searcher,
    user: searcher.user,
    module: args.module,
    context,
    rateLimit: limit.value,
    constraints: decision.constraints,
    client,
  });
}

/** Turns a jurisdiction block into a refusal that keeps its citation. */
export function moduleBlockedRefusal(blocked: ModuleBlocked): Refusal<'module-blocked'> {
  return refuse('module-blocked', blocked.summary, {
    citation: blocked.reasons.map((r) => `${r.authority}: ${r.summary}`).join(' · '),
    remedy: blocked.remedy,
    detail: {
      module: blocked.capability,
      headline: blocked.headline,
      state: blocked.jurisdiction.state,
      ...(blocked.jurisdiction.city ? { city: blocked.jurisdiction.city } : {}),
      basis: blocked.reasons.map((r) => r.kind).join(','),
    },
  });
}

async function recordRefusal(
  client: LantageClient,
  action: AuditAction,
  user: AuthUser | null,
  context: RequestContext,
  subject: {
    type: 'module';
    id: string;
    module: ModuleId;
    imageId?: string;
    caseId?: string;
  },
  refusal: Refusal<string>,
): Promise<void> {
  await auditRefusal(
    client,
    { action, actor: actorRef(user), subject, context, detail: refusal.detail ?? {} },
    { code: refusal.code, reason: refusal.reason, citation: refusal.citation },
  );
}

function actorRef(user: AuthUser | null): AuditActorRef {
  if (!user) return { userId: null, orgId: null };
  return {
    userId: user.id,
    orgId: user.org?.id ?? null,
    email: user.email,
    role: user.role,
    verification: user.verification,
  };
}

// ---------------------------------------------------------------------------
// Adapter for B2's cascade
// ---------------------------------------------------------------------------

/**
 * Binds this module to `CascadeRuntime.auth`.
 *
 * `POST /api/search` returns 503 until this is registered — by design, per
 * `src/lib/cascade/wiring.ts`: "A search that cannot be attributed to a verified
 * user and written to an immutable audit row is not a search this product
 * performs."
 *
 * **To open the route, `src/lib/cascade/wiring.ts` (B2's file) needs one line
 * inside `registerCascadeRuntime`:**
 *
 * ```ts
 * import { cascadeAuthGate } from '@/lib/auth/guard';
 * // …
 * auth: cascadeAuthGate,
 * ```
 *
 * Nothing else changes — the shapes already match `AuthGate`.
 *
 * ### What is lost at this boundary, and why it is acceptable
 *
 * `AuthGate.canSearch` returns `{ allowed, reason, status }`, so the citation and
 * the remedy do not survive. That is fine here because the refusal has *already*
 * been written to the audit trail with its citation intact by the time this
 * returns, and because the module tiles in the UI call `isModuleAllowed` directly
 * and render the full `ModuleBlocked`. The analyst never sees only this string.
 *
 * `AuthGate.canSearch` also takes no module, so the jurisdiction and rate-limit
 * checks cannot run here — they need to know which module. It therefore performs
 * steps 2–3 of the chain (authenticate, verify) and the route's own
 * `isModuleAllowed` call covers the rest. Use `guardSearch` for the full chain.
 */
export const cascadeAuthGate: AuthGate = {
  async canSearch(request: Request) {
    // `AuthGate.canSearch` returns a decision and never throws. Everything below
    // touches infrastructure — an unset SUPABASE_URL, an unreachable database, a
    // malformed JWT — and any of it throwing must surface as an explicit 503
    // rather than an opaque 500 from the route handler.
    //
    // It fails CLOSED: an infrastructure fault denies the search. It is not
    // reported as 403, because telling an operator "forbidden" when the database
    // is merely unconfigured sends them to audit their permissions instead of
    // their .env.local.
    let client: Awaited<ReturnType<typeof createServerSupabaseClient>>;
    let context: ReturnType<typeof readRequestContext>;
    let user: Awaited<ReturnType<typeof getCurrentUser>>;
    try {
      client = await createServerSupabaseClient();
      context = readRequestContext(request.headers);
      user = await getCurrentUser(client);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        allowed: false,
        reason: `Authorization backend unavailable: ${detail}`,
        status: 503,
      };
    }

    const gate = canSearch(user);
    if (isRefusal(gate)) {
      // A refusal we cannot record is a refusal we cannot prove we made. Audit is
      // fail-closed here too: if the append fails, report 503 rather than denying
      // silently and leaving no row behind.
      try {
        await auditRefusal(
          client,
          {
            action: 'search.refuse',
            actor: actorRef(user),
            subject: { type: 'module', id: null },
            context,
            detail: gate.detail ?? {},
          },
          { code: gate.code, reason: gate.reason, citation: gate.citation },
        );
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return {
          allowed: false,
          reason: `Refusal could not be audited, so the request is rejected: ${detail}`,
          status: 503,
        };
      }

      return {
        allowed: false,
        reason: gate.reason,
        status: gate.code === 'not-authenticated' ? 401 : 403,
      };
    }

    const searcher = gate.value;
    const principal: SearchPrincipal = {
      userId: searcher.userId,
      orgId: searcher.orgId,
      email: searcher.email ?? undefined,
      verified: searcher.user.verification === 'verified',
      jurisdiction: formatJurisdiction(searcher.user.org?.jurisdiction),
    };

    return { allowed: true, principal };
  },

  /**
   * Predicate form. The `jurisdiction` string is the canonical
   * `"PA/Pittsburgh"` form produced by `formatJurisdiction` — parsing it back
   * rather than treating it as a state code is what keeps a CCOPS city from
   * silently reading as a permissive state.
   *
   * Customer type is not carried in the string, so this falls back to
   * `government-agency`, the most restricted reading. An SIU customer therefore
   * gets a *stricter* answer here than `guardSearch` gives them — wrong in the
   * safe direction, and the reason the route should prefer `guardSearch`.
   */
  isModuleAllowed(module: ModuleId, jurisdiction: string | undefined): boolean {
    return isModuleAllowed(module, parseJurisdiction(jurisdiction)).allowed;
  },
};
