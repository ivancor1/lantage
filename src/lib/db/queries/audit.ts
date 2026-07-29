/**
 * The audit trail.
 *
 * MASTER_PLAN §7: "Immutable audit log per search: who, when, what image, what
 * result, what they did with it — built for defence discovery from day one." The
 * table refuses UPDATE and DELETE at the database level, so the only thing this
 * module can do is append.
 *
 * Every call site can record actor, action, subject, IP, and user agent.
 * `auditContextFromHeaders` exists so that no route handler has to remember how to
 * parse X-Forwarded-For, and so the parsing lives in exactly one place.
 */

import type { LantageClient } from '../client';
import { unwrap } from '../errors';
import type { AuditAction, AuditLogRow, Json } from '../types';

export type AuditActor = {
  /** Null only for pre-authentication events, which have no resolvable org. */
  orgId?: string | null;
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type WriteAuditInput = AuditActor & {
  action: AuditAction;
  /** 'search' | 'case' | 'image' | 'geo_candidate' | 'corpus' | 'app_user' | … */
  subjectType?: string | null;
  subjectId?: string | null;
  /** Anything the action needs to be reconstructible later. Never plate characters. */
  detail?: Record<string, Json>;
};

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;

/**
 * Reduces whatever the proxy sent to something Postgres `inet` will accept.
 *
 * X-Forwarded-For is a list, Vercel and Cloudflare disagree about which header is
 * authoritative, and a client can put anything in there. Takes the first hop,
 * strips a port, and validates. Anything unparseable is NOT dropped — it is
 * returned as `raw` and written into `detail.ip_raw`, because an audit row that
 * quietly loses the requester's address is worse than an ugly one.
 */
export function normalizeIp(value: string | null | undefined): { ip: string | null; raw?: string } {
  if (!value) return { ip: null };

  const first = value.split(',')[0]?.trim() ?? '';
  if (first.length === 0) return { ip: null };

  // [2001:db8::1]:443 → 2001:db8::1
  let candidate = first.replace(/^\[([^\]]+)\](:\d+)?$/, '$1');
  // 203.0.113.7:54321 → 203.0.113.7 (never strip from bare IPv6, whose colons are the address)
  if (IPV4.test(candidate.replace(/:\d+$/, '')) && /:\d+$/.test(candidate)) {
    candidate = candidate.replace(/:\d+$/, '');
  }

  if (IPV4.test(candidate)) {
    const octets = candidate.split('/')[0].split('.').map(Number);
    if (octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) return { ip: candidate };
    return { ip: null, raw: first };
  }

  if (candidate.includes(':') && IPV6.test(candidate)) return { ip: candidate };

  return { ip: null, raw: first };
}

/**
 * Builds an audit context from a request's headers. Works with a route handler's
 * `request.headers` and with `await headers()` in a Server Component — it takes a
 * plain `Headers`, so it stays importable from anywhere.
 */
export function auditContextFromHeaders(
  headers: Headers,
  identity: Pick<AuditActor, 'orgId' | 'actorId'> = {},
): AuditActor {
  const forwarded =
    headers.get('x-forwarded-for') ??
    headers.get('x-real-ip') ??
    headers.get('cf-connecting-ip') ??
    null;

  const { ip } = normalizeIp(forwarded);

  return {
    orgId: identity.orgId ?? null,
    actorId: identity.actorId ?? null,
    ip,
    userAgent: headers.get('user-agent'),
  };
}

/**
 * Appends one audit row. Throws if it cannot.
 *
 * Failing the caller's request when the audit write fails is the intended
 * behaviour: if an action cannot be recorded, the product should not take it. Do
 * not wrap this in a silent try/catch to keep a page rendering.
 */
export async function writeAudit(
  client: LantageClient,
  input: WriteAuditInput,
): Promise<AuditLogRow> {
  const { ip, raw } = normalizeIp(input.ip);
  const detail: Record<string, Json> = { ...(input.detail ?? {}) };
  if (raw) detail.ip_raw = raw;

  return unwrap(
    'writeAudit',
    await client
      .from('audit_log')
      .insert({
        org_id: input.orgId ?? null,
        actor_id: input.actorId ?? null,
        action: input.action,
        subject_type: input.subjectType ?? null,
        subject_id: input.subjectId ?? null,
        ip,
        user_agent: input.userAgent ?? null,
        detail,
      })
      .select('*')
      .single(),
  );
}

export type ListAuditOptions = {
  subjectType?: string;
  subjectId?: string;
  actorId?: string;
  action?: string;
  /** ISO 8601, inclusive. */
  since?: string;
  limit?: number;
};

/** Newest first. Org-scoped by RLS. This is the discovery-export read path. */
export async function listAudit(
  client: LantageClient,
  options: ListAuditOptions = {},
): Promise<AuditLogRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);

  let q = client.from('audit_log').select('*').order('at', { ascending: false }).limit(limit);
  if (options.subjectType) q = q.eq('subject_type', options.subjectType);
  if (options.subjectId) q = q.eq('subject_id', options.subjectId);
  if (options.actorId) q = q.eq('actor_id', options.actorId);
  if (options.action) q = q.eq('action', options.action);
  if (options.since) q = q.gte('at', options.since);

  return unwrap('listAudit', await q);
}
