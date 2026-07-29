/**
 * The only place the cascade touches the network.
 *
 * Every external call in this product is wrapped here so that three properties
 * are true by construction rather than by review: it has a timeout, it returns a
 * typed failure instead of throwing, and its response is validated against a
 * schema before any of our code reads a field off it.
 */

import type { z } from 'zod';
import { type Result, type StageFailure, err, failure, ok } from './types';

export interface JsonCallOptions<T> {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Response validator. Non-negotiable: unvalidated vendor JSON is not data. */
  schema: z.ZodType<T>;
  /** Caller's abort signal, combined with the timeout. */
  signal?: AbortSignal;
  /** Label used in failure reasons the analyst may read. */
  label: string;
}

/** POST/GET JSON with a timeout, returning a typed failure rather than throwing. */
export async function callJson<T>(opts: JsonCallOptions<T>): Promise<Result<T, StageFailure>> {
  if (opts.timeoutMs <= 0) {
    return err(failure('budget-exhausted', `${opts.label}: no time left in the search budget`));
  }

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: opts.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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
    return err(
      failure(
        res.status >= 500 || res.status === 429 ? 'unavailable' : 'invalid-response',
        `${opts.label} returned HTTP ${res.status}`,
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
    return err(
      failure(
        'invalid-response',
        `${opts.label} response did not match the expected contract: ${summariseIssues(parsed.error)}`,
      ),
    );
  }
  return ok(parsed.data);
}

/** Fetch raw bytes with a timeout. Used for image bytes when no URL-only path exists. */
export async function fetchBytes(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Result<{ bytes: Uint8Array; mimeType?: string }, StageFailure>> {
  if (timeoutMs <= 0) {
    return err(failure('budget-exhausted', 'no time left to fetch the image'));
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(url, { signal: combined, cache: 'no-store' });
    if (!res.ok) {
      return err(failure('unavailable', `image fetch returned HTTP ${res.status}`));
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return ok({ bytes: buf, mimeType: res.headers.get('content-type') ?? undefined });
  } catch (e) {
    if (timeout.aborted) {
      return err(failure('timeout', `image fetch exceeded ${timeoutMs}ms`));
    }
    return err(failure('unavailable', `image fetch failed: ${describe(e)}`));
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function summariseIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}
