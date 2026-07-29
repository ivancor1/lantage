/**
 * Request context capture — the IP, user agent, and request id every audit row
 * needs.
 *
 * Why this is a module and not three `headers().get()` calls per call site: the
 * Next 16 proxy docs are explicit that the only supported channels from proxy
 * into the app are headers, cookies, rewrites, and the URL — "you should not
 * attempt relying on shared modules or globals". So `proxy.ts` derives the
 * context once and stamps it onto the *forwarded request* via
 * `NextResponse.next({ request: { headers } })`, and Server Components / Route
 * Handlers read it back with `await headers()`.
 *
 * X-Forwarded-For parsing is NOT reimplemented here. A2's `normalizeIp` in
 * `src/lib/db/queries/audit.ts` is the single place that knows how to reduce a
 * forwarding chain to something Postgres `inet` accepts, and it deliberately
 * preserves an unparseable value rather than dropping it. This module only
 * decides *which* header to feed it and whether the result is trustworthy.
 */

import { auditContextFromHeaders, normalizeIp } from '@/lib/db/queries/audit';

/** Internal header names. Keep in sync with `proxy.ts` — its only writer. */
export const CTX_HEADERS = {
  ip: 'x-lantage-ip',
  userAgent: 'x-lantage-ua',
  requestId: 'x-lantage-request-id',
  path: 'x-lantage-path',
  /**
   * Proof the proxy handled this request, compared against
   * `LANTAGE_PROXY_SECRET`. Without it a caller could hand-roll the four headers
   * above and write a false IP into the audit trail — which for a tool built for
   * defence discovery is the one forgery that matters. Unset in local dev, which
   * costs only the `trusted` flag.
   */
  stamp: 'x-lantage-proxy-stamp',
} as const;

export interface RequestContext {
  /** Client IP, normalised by A2's `normalizeIp`. `null` when nothing usable. */
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Correlates every audit row written while serving one request. */
  readonly requestId: string;
  readonly path: string | null;
  /**
   * `true` only when the proxy stamped these values on this request. A `false`
   * in a production audit row means something reached a handler without passing
   * through the proxy — worth alerting on, which is why the flag is persisted
   * into `detail` rather than dropped.
   */
  readonly trusted: boolean;
}

/**
 * Which forwarding header to believe. Vercel and Cloudflare disagree about which
 * is authoritative, so the order is deliberate: `x-forwarded-for` first because
 * the platform overwrites its leftmost entry.
 *
 * Spoofable in general. Recorded as best-effort evidence, never used as an
 * authorization input.
 */
function forwardedFor(headers: Headers): string | null {
  return (
    headers.get('x-forwarded-for') ??
    headers.get('x-real-ip') ??
    headers.get('cf-connecting-ip') ??
    headers.get('x-vercel-forwarded-for') ??
    null
  );
}

/** Truncated: audit rows are read in bulk for discovery, and UA strings bloat. */
function userAgentFrom(headers: Headers): string | null {
  const ua = headers.get('user-agent');
  return ua ? ua.slice(0, 512) : null;
}

export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Derive the context from an incoming request. Pure. Called by `proxy.ts`, which
 * then stamps the result onto the forwarded request headers.
 */
export function deriveRequestContext(request: {
  headers: Headers;
  url?: string;
  nextUrl?: { pathname: string };
}): RequestContext {
  const { ip } = normalizeIp(forwardedFor(request.headers));
  return {
    ip,
    userAgent: userAgentFrom(request.headers),
    requestId: newRequestId(),
    path: request.nextUrl?.pathname ?? safePathname(request.url),
    trusted: true,
  };
}

function safePathname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** The `x-lantage-*` pairs the proxy stamps onto the forwarded request. */
export function contextHeaderEntries(ctx: RequestContext): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [[CTX_HEADERS.requestId, ctx.requestId]];
  if (ctx.ip) entries.push([CTX_HEADERS.ip, ctx.ip]);
  if (ctx.userAgent) entries.push([CTX_HEADERS.userAgent, ctx.userAgent]);
  if (ctx.path) entries.push([CTX_HEADERS.path, ctx.path]);
  const secret = proxyStamp();
  if (secret) entries.push([CTX_HEADERS.stamp, secret]);
  return entries;
}

/** Server-only env var. Never `NEXT_PUBLIC_`. */
function proxyStamp(): string | null {
  return process.env.LANTAGE_PROXY_SECRET ?? null;
}

/**
 * Read the context back inside a Server Component, Server Function, or Route
 * Handler. Pass the result of `await headers()`, or a Route Handler's
 * `request.headers`.
 *
 * Never throws. A missing context yields an untrusted context rather than
 * blocking: refusing to *serve* because we could not identify the caller's IP
 * would be the wrong trade — refusing to *trust* it is the right one.
 */
export function readRequestContext(headers: Headers): RequestContext {
  const expected = proxyStamp();
  const presented = headers.get(CTX_HEADERS.stamp);
  const trusted = expected !== null && presented !== null && timingSafeEqualStr(expected, presented);

  if (trusted) {
    return {
      ip: headers.get(CTX_HEADERS.ip),
      userAgent: headers.get(CTX_HEADERS.userAgent) ?? userAgentFrom(headers),
      requestId: headers.get(CTX_HEADERS.requestId) ?? newRequestId(),
      path: headers.get(CTX_HEADERS.path),
      trusted: true,
    };
  }

  // Untrusted path: ignore anything claiming to be a stamped value and re-derive
  // from the raw forwarding headers. Same parser, no privilege.
  const derived = auditContextFromHeaders(headers);
  return {
    ip: derived.ip ?? null,
    userAgent: derived.userAgent ?? null,
    requestId: headers.get(CTX_HEADERS.requestId) ?? newRequestId(),
    path: headers.get(CTX_HEADERS.path),
    trusted: false,
  };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Context for work with no HTTP request behind it — cron, backfill, tests. */
export function systemRequestContext(label: string): RequestContext {
  return {
    ip: null,
    userAgent: `lantage-system/${label}`,
    requestId: newRequestId(),
    path: null,
    trusted: true,
  };
}
