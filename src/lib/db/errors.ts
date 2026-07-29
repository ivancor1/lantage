/**
 * One error type for the whole data layer.
 *
 * Every helper in `queries/` throws rather than returning `{ data, error }`. That
 * is a deliberate choice for this product: a silently swallowed Postgres error in
 * a forensic tool means a search that looks complete but isn't, or an audit row
 * that was never written. Failing loudly is the safe direction.
 */

import type { PostgrestError } from '@supabase/supabase-js';

export class DbError extends Error {
  readonly operation: string;
  readonly pgError: PostgrestError;

  constructor(operation: string, pgError: PostgrestError) {
    const detail = [pgError.message, pgError.details, pgError.hint].filter(Boolean).join(' · ');
    super(`${operation}: ${detail} [${pgError.code ?? 'unknown'}]`);
    this.name = 'DbError';
    this.operation = operation;
    this.pgError = pgError;
  }

  /**
   * True when the database refused the write because a row is immutable or a
   * product invariant was violated — the append-only triggers, the refused
   * quality gate guard, and RLS denials all raise 42501. Distinguishing this from
   * a transient failure matters: retrying will never help.
   */
  get isRefusal(): boolean {
    return this.pgError.code === '42501';
  }
}

type Result<T> = { data: T | null; error: PostgrestError | null };

/** Throws on error, and on an unexpectedly absent row. */
export function unwrap<T>(operation: string, result: Result<T>): T {
  if (result.error) throw new DbError(operation, result.error);
  if (result.data === null || result.data === undefined) {
    throw new Error(`${operation}: returned no row. Expected exactly one.`);
  }
  return result.data;
}

/** Throws on error; a null payload is a legitimate "not found". */
export function unwrapMaybe<T>(operation: string, result: Result<T>): T | null {
  if (result.error) throw new DbError(operation, result.error);
  return result.data ?? null;
}
