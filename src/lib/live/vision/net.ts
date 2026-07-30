/**
 * One JSON call to a vision vendor: timeout, typed failure, schema-validated
 * response — and, unlike the cascade's `callJson`, the vendor's error body.
 *
 * That is the only reason this exists rather than importing `@/lib/cascade/net`.
 * The cascade deliberately reduces a bad response to "returned HTTP 400", which
 * is right for a multi-tenant service where a vendor body may carry request
 * content into a log. LIVE is a single-operator local tool whose whole purpose is
 * to show whether a result is real, and "HTTP 400" with no reason is a dead end
 * when the fix is one field name. The body is truncated, and nothing here ever
 * logs — the string is returned to the caller as a `StageFailure.reason`.
 *
 * The failure kinds match `@/lib/cascade/net` exactly so callers cannot tell the
 * two apart.
 */

import type { z } from 'zod';
import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';

const MAX_ERROR_BODY_CHARS = 600;

export interface VendorCallOptions<T> {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  /** Appears in every failure reason the operator may read. */
  label: string;
}

export async function callVendorJson<T>(
  opts: VendorCallOptions<T>,
): Promise<Result<T, StageFailure>> {
  if (opts.timeoutMs <= 0) {
    return err(failure('budget-exhausted', `${opts.label}: no time left in the budget`));
  }

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal,
      cache: 'no-store',
    });
  } catch (e) {
    if (timeout.aborted) {
      return err(failure('timeout', `${opts.label} did not respond within ${opts.timeoutMs}ms`));
    }
    return err(failure('unavailable', `${opts.label} unreachable: ${describe(e)}`));
  }

  if (!res.ok) {
    const detail = await readErrorBody(res);
    return err(
      failure(
        res.status >= 500 || res.status === 429 ? 'unavailable' : 'invalid-response',
        `${opts.label} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
      ),
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    return err(failure('invalid-response', `${opts.label} returned non-JSON: ${describe(e)}`));
  }

  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return err(
      failure('invalid-response', `${opts.label} response did not match its documented shape: ${detail}`),
    );
  }
  return ok(parsed.data);
}

/**
 * The vendor's own words, truncated. Never the request — an error body echoing a
 * base64 image would otherwise end up in a failure string.
 */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text) return '';
    const collapsed = text.replace(/\s+/g, ' ');
    return collapsed.length > MAX_ERROR_BODY_CHARS
      ? `${collapsed.slice(0, MAX_ERROR_BODY_CHARS)}…`
      : collapsed;
  } catch {
    return '';
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
