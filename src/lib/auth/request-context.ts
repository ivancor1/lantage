/**
 * Request context capture — the IP, user agent, and request id that every audit
 * row needs.
 *
 * Why this is a module and not three `headers().get()` calls at each call site:
 * the Next 16 proxy docs are explicit that the only supported channels from
 * proxy into the app are headers, cookies, rewrites, and the URL — "you should
 * not attempt relying on shared modules or globals". So `proxy.ts` derives the
 * context once and stamps it onto the *request* headers with
 * `NextResponse.next({ request: { headers } })`, and Server Components / Route
 * Handlers read it back with `await headers()`.
 *
 * The `x-lantage-*` names are internal. Trusting a client-supplied
 * `x-lantage-ip` would let a caller forge its own audit trail, so
 * `readRequestContext` marks any value that did not come through the proxy as
 * untrusted — see `RequestContext.trusted`.
 */

/** Internal header names. Keep in sync with `proxy.ts` — it is the only writer. */
export const CTX_HEADERS = {
  ip: 'x-lantage-ip',
  userAgent: 'x-lantage-ua',
  requestId: 'x-lantage-request-id',
  path: 'x-lantage-path',
  /**
   * Proof the proxy ran. Compared against `LANTAGE_PROXY_SECRET` so a client
   * cannot hand-roll the four headers above and poison the audit trail. Without
   * the env var set we still work, but every context is marked untrusted.
   */
  stamp: 'x-lantage-proxy-stamp',
} as const;

export interface RequestContext {
  /** Client IP, best effort. `null` when nothing usable was present. */
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Correlates the audit rows written while serving one request. */
  readonly requestId: string;
  readonly path: string | null;
  /**
   * `true` only when the proxy stamped these values in this request. A `false`
   * here in a production audit row means someone bypassed the proxy — worth
   * alerting on, and the reason this flag is persisted rather than dropped.
   */
  readonly trusted: boolean;
}

/**
 * First entry in `x-forwarded-for` is the client; the rest are proxies.
 *
 * `x-forwarded-for` is spoofable in general. On Vercel the platform overwrites
 * the leftmost entry, so it is trustworthy *there* and only there. Self-hosting
 * behind another proxy requires re-checking this. Recorded as best-effort
 * evidence, never used as an authorization input.
 */
export function clientIpFrom(headers: Headers): string | null {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return normaliseIp(first);
  }
  const alternatives = ['x-real-ip', 'cf-connecting-ip', 'x-vercel-forwarded-for'];
  for (const name of alternatives) {
    const v = headers.get(name)?.trim();
    if (v) return normaliseIp(v);
  }
  return null;
}

function normaliseIp(raw: string): string | null {
  // Strip an IPv4-mapped IPv6 prefix and any :port suffix, and cap the length so
  // a hostile header cannot bloat every audit row.
  let v = raw.replace(/^::ffff:/i, '');
  const portMatch = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
  if (portMatch?.[1]) v = portMatch[1];
  v = v.slice(0, 45);
  return v.length > 0 ? v : null;
}

/** Truncated: audit rows are queried in bulk for discovery, and UA strings bloat. */
export function userAgentFrom(headers: Headers): string | null {
  const ua = headers.get('user-agent');
  if (!ua) return null;
  return ua.slice(0, 512);
}

export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Derive the context from raw request headers. Pure — called by `proxy.ts`,
 * which then stamps the result onto the forwarded request.
 */
export function deriveRequestContext(request: {
  headers: Headers;
  url?: string;
  nextUrl?: { pathname: string };
}): RequestContext {
  const path = request.nextUrl?.pathname ?? safePathname(request.url);
  return {
    ip: clientIpFrom(request.headers),
    userAgent: userAgentFrom(request.headers),
    requestId: newRequestId(),
    path,
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

/** Values the proxy stamps onto the forwarded request. */
export function contextHeaderEntries(ctx: RequestContext): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [[CTX_HEADERS.requestId, ctx.requestId]];
  if (ctx.ip) entries.push([CTX_HEADERS.ip, ctx.ip]);
  if (ctx.userAgent) entries.push([CTX_HEADERS.userAgent, ctx.userAgent]);
  if (ctx.path) entries.push([CTX_HEADERS.path, ctx.path]);
  const secret = proxyStamp();
  if (secret) entries.push([CTX_HEADERS.stamp, secret]);
  return entries;
}

/**
 * Shared secret proving the proxy handled this request. Server-only env var —
 * never `NEXT_PUBLIC_`. Absent in local dev, which only costs us the `trusted`
 * flag.
 */
function proxyStamp(): string | null {
  return process.env.LANTAGE_PROXY_SECRET ?? null;
}

/**
 * Read the context back inside a Server Component, Server Function, or Route
 * Handler. Pass the result of `await headers()`.
 *
 * Never throws. A missing context yields a null-ip, untrusted context rather
 * than blocking the request: refusing to *serve* because we could not identify
 * the caller's IP would be the wrong trade, but refusing to *trust* it is right.
 */
export function readRequestContext(headers: Headers): RequestContext {
  const expected = proxyStamp();
  const presented = headers.get(CTX_HEADERS.stamp);
  const trusted = expected !== null && presented !== null && timingSafeEqualStr(expected, presented);

  return {
    ip: trusted ? headers.get(CTX_HEADERS.ip) : clientIpFrom(headers),
    userAgent: headers.get(CTX_HEADERS.userAgent) ?? userAgentFrom(headers),
    requestId: headers.get(CTX_HEADERS.requestId) ?? newRequestId(),
    path: headers.get(CTX_HEADERS.path),
    trusted,
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
  return { ip: null, userAgent: `lantage-system/${label}`, requestId: newRequestId(), path: null, trusted: true };
}
