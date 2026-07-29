/**
 * The case ledger. Append-only, enforced by the database.
 *
 * A correction is a new entry. That is not a limitation to work around — the
 * sequence of what an investigator believed and when is itself part of the record,
 * and an editable narrative is worth nothing in discovery.
 */

import type { LedgerEntry } from '@/lib/contracts/types';

import type { LantageClient } from '../client';
import { unwrap } from '../errors';
import type { LedgerEntryRow } from '../types';

export type AppendLedgerInput = {
  caseId: string;
  searchId: string;
  summary: string;
  /**
   * Required before a finding may be marked confirmed. The Detroit rules
   * (MASTER_PLAN §7): no arrest on an AI match alone, and no photo lineup built
   * from a match without independent linking evidence.
   */
  corroboration?: NonNullable<LedgerEntry['corroboration']>;
  /** Defaults to the caller's auth.uid() in the database. */
  writtenBy?: string;
};

export async function appendLedger(
  client: LantageClient,
  input: AppendLedgerInput,
): Promise<LedgerEntryRow> {
  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new Error('appendLedger: summary is required. An entry with nothing in it records nothing.');
  }

  return unwrap(
    'appendLedger',
    await client
      .from('ledger_entries')
      .insert({
        case_id: input.caseId,
        search_id: input.searchId,
        summary,
        corroboration: input.corroboration ?? null,
        ...(input.writtenBy ? { written_by: input.writtenBy } : {}),
      })
      .select('*')
      .single(),
  );
}

/** Chronological, because a ledger read out of order is not a narrative. */
export async function listLedger(
  client: LantageClient,
  caseId: string,
  limit = 500,
): Promise<LedgerEntryRow[]> {
  return unwrap(
    'listLedger',
    await client
      .from('ledger_entries')
      .select('*')
      .eq('case_id', caseId)
      .order('written_at', { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 2000)),
  );
}
