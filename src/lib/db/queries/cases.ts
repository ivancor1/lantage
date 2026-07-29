import type { LantageClient } from '../client';
import { unwrap, unwrapMaybe } from '../errors';
import type { CaseRow, CaseStatus } from '../types';

export type CreateCaseInput = {
  title: string;
  reference?: string | null;
  /**
   * Only pass this from the service role. For a signed-in analyst the database
   * defaults it from their JWT, and RLS re-checks the value — which means a
   * client-supplied org_id can never widen access, only fail.
   */
  orgId?: string;
  createdBy?: string;
};

export async function createCase(
  client: LantageClient,
  input: CreateCaseInput,
): Promise<CaseRow> {
  return unwrap(
    'createCase',
    await client
      .from('cases')
      .insert({
        title: input.title,
        reference: input.reference ?? null,
        ...(input.orgId ? { org_id: input.orgId } : {}),
        ...(input.createdBy ? { created_by: input.createdBy } : {}),
      })
      .select('*')
      .single(),
  );
}

export type ListCasesOptions = {
  status?: CaseStatus;
  /** Substring match on title or reference. */
  query?: string;
  limit?: number;
  offset?: number;
};

/** Newest first. Scoped to the caller's org by RLS, not by a filter here. */
export async function listCases(
  client: LantageClient,
  options: ListCasesOptions = {},
): Promise<CaseRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  let q = client
    .from('cases')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (options.status) q = q.eq('status', options.status);
  if (options.query) {
    const term = options.query.replace(/[%,()]/g, '');
    if (term.length > 0) q = q.or(`title.ilike.%${term}%,reference.ilike.%${term}%`);
  }

  return unwrap('listCases', await q);
}

export async function getCase(client: LantageClient, caseId: string): Promise<CaseRow | null> {
  return unwrapMaybe(
    'getCase',
    await client.from('cases').select('*').eq('id', caseId).maybeSingle(),
  );
}

/**
 * Cases close; they are never deleted. ledger_entries reference cases with
 * `on delete restrict` and there is no DELETE policy, so this is the only exit.
 */
export async function closeCase(client: LantageClient, caseId: string): Promise<CaseRow> {
  return unwrap(
    'closeCase',
    await client.from('cases').update({ status: 'closed' }).eq('id', caseId).select('*').single(),
  );
}
