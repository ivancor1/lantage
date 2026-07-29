/**
 * Gate primitives — typed refusals.
 *
 * Every authorization decision in Lantage returns a value, never a thrown
 * string. Two reasons, both load-bearing:
 *
 * 1. A refusal is a *product surface*. `docs/MASTER_PLAN.md` §7 requires that a
 *    blocked module tell the analyst which ordinance blocked it. A thrown
 *    `Error('forbidden')` cannot carry a citation; a `Refusal` can, and the UI
 *    renders it.
 * 2. `Gate<T>` in a return type forces the caller to narrow before touching the
 *    value. `try { … } catch {}` does not. Under `strict` this is the only
 *    mechanism that makes "forgot to check the gate" a compile error rather
 *    than a production incident.
 *
 * Do not add a `throwIfDenied()` convenience that call sites can reach for by
 * default. `unwrapOrThrow` exists for one narrow case — the HTTP boundary,
 * where a `Refusal` becomes a status code — and it is documented there.
 */

/** Machine-readable refusal. `code` is switched on; `reason` is shown to humans. */
export interface Refusal<C extends string = string> {
  readonly ok: false;
  readonly code: C;
  /**
   * One line, plain English, safe to render. Written for the person who hit the
   * wall, not for the log. Must not leak another tenant's data or internal ids.
   */
  readonly reason: string;
  /** What the user can actually do about it, if anything. */
  readonly remedy?: string;
  /**
   * The authority this refusal rests on: an ordinance, a statute, an MSA
   * clause, a rate-limit policy id. Required for jurisdiction denials — a block
   * with no cited reason is not shippable (same rule as `Confidence.reason`).
   */
  readonly citation?: string;
  /** JSON-safe extras carried into the audit record. Never free-form objects. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface Permit<T> {
  readonly ok: true;
  readonly value: T;
}

export type Gate<T, C extends string = string> = Permit<T> | Refusal<C>;

export function permit<T>(value: T): Permit<T> {
  return { ok: true, value };
}

export function refuse<C extends string>(
  code: C,
  reason: string,
  extra?: Omit<Refusal<C>, 'ok' | 'code' | 'reason'>,
): Refusal<C> {
  return { ok: false, code, reason, ...extra };
}

export function isPermitted<T, C extends string>(g: Gate<T, C>): g is Permit<T> {
  return g.ok;
}

export function isRefusal<T, C extends string>(g: Gate<T, C>): g is Refusal<C> {
  return !g.ok;
}

/**
 * Carries a `Refusal` across a boundary that only speaks exceptions — a Route
 * Handler, a Server Function. Catch it at that boundary and map
 * `err.refusal.code` to a status code. Do not catch it to ignore it.
 */
export class GateError<C extends string = string> extends Error {
  readonly refusal: Refusal<C>;

  constructor(refusal: Refusal<C>) {
    super(`${refusal.code}: ${refusal.reason}`);
    this.name = 'GateError';
    this.refusal = refusal;
  }
}

/** Only for the HTTP boundary. Everywhere else, narrow the `Gate`. */
export function unwrapOrThrow<T, C extends string>(g: Gate<T, C>): T {
  if (g.ok) return g.value;
  throw new GateError(g);
}

/** HTTP status for a refusal code family. Used by Route Handlers. */
export function refusalStatus(code: string): number {
  if (code === 'not-authenticated') return 401;
  if (code === 'rate-limited') return 429;
  if (code === 'audit-unavailable') return 503;
  return 403;
}
