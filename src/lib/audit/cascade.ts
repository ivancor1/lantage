/**
 * Adapter binding the audit trail to B2's `CascadeRuntime.audit`.
 *
 * **To open `POST /api/search`, `src/lib/cascade/wiring.ts` (B2's file) needs two
 * lines inside `registerCascadeRuntime`:**
 *
 * ```ts
 * import { cascadeAuthGate } from '@/lib/auth/guard';
 * import { cascadeAuditWriter } from '@/lib/audit/cascade';
 * // …
 * auth: cascadeAuthGate,
 * audit: cascadeAuditWriter,
 * ```
 *
 * Both already match the interfaces in `deps.ts`, so there is no glue beyond this
 * file. `imageStore` remains A2/B2's to wire.
 *
 * The phase → action mapping preserves the append-only rule: `requested` writes
 * `search.create`, and `completed` / `refused` / `error` each write a *separate*
 * row rather than updating it. The route already relies on this — it fails the
 * request 503 if the `requested` row cannot be written, and treats the outcome
 * rows as best effort.
 */

import { err, failure, ok, type Result, type StageFailure } from '@/lib/cascade/types';
import type { AuditWriter, SearchAuditRecord } from '@/lib/cascade/deps';
import { createServerSupabaseClient } from '@/lib/db/client';
import type { Json } from '@/lib/db/types';
import { systemRequestContext } from '@/lib/auth/request-context';

import { writeAuditEvent } from './log';
import type { AuditAction } from './types';

const PHASE_ACTION: Record<SearchAuditRecord['phase'], AuditAction> = {
  requested: 'search.create',
  completed: 'search.complete',
  refused: 'search.refuse',
  error: 'search.error',
};

export const cascadeAuditWriter: AuditWriter = {
  async writeSearchAudit(record: SearchAuditRecord): Promise<Result<void, StageFailure>> {
    try {
      const client = await createServerSupabaseClient();

      // The cascade hands us the IP and UA it read off the request rather than a
      // `RequestContext`, so the context is reconstructed here. `trusted` is
      // false: these values did not come through the proxy stamp, and `log.ts`
      // records that fact on the row rather than pretending otherwise.
      const base = systemRequestContext('cascade');
      const context = {
        ...base,
        ip: record.ip ?? null,
        userAgent: record.userAgent ?? null,
        trusted: false,
      };

      await writeAuditEvent(client, {
        action: PHASE_ACTION[record.phase],
        actor: { userId: record.userId, orgId: record.orgId },
        subject: {
          type: 'search',
          id: record.searchId,
          searchId: record.searchId,
          imageId: record.imageId,
          caseId: record.caseId,
          module: record.module,
        },
        context,
        outcome: outcomeFor(record.phase),
        detail: buildDetail(record),
      });

      return ok(undefined);
    } catch (cause) {
      // `unavailable` rather than `policy`: the search was refused because the
      // database could not be written, not because we declined to run it. The
      // route turns this into a 503 with the reason attached, which is the
      // difference between "try again" and "this is not permitted".
      return err(
        failure(
          'unavailable',
          `The audit log could not be written: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  },
};

function outcomeFor(phase: SearchAuditRecord['phase']): 'allowed' | 'denied' | 'error' {
  switch (phase) {
    case 'refused':
      return 'denied';
    case 'error':
      return 'error';
    default:
      return 'allowed';
  }
}

function buildDetail(record: SearchAuditRecord): Record<string, Json> {
  const detail: Record<string, Json> = { phase: record.phase, cascade_at: record.at };
  if (record.note) detail.note = record.note;

  // Hints are the analyst's own priors and are part of reproducing the search, so
  // they belong on the row. Flattened to scalars — a nested object in `detail`
  // makes the discovery export awkward to read and to filter.
  if (record.hints?.bbox) detail.hint_bbox = record.hints.bbox.join(',');
  if (record.hints?.capturedAt) detail.hint_captured_at = record.hints.capturedAt;
  if (record.hints?.corpusId) detail.hint_corpus_id = record.hints.corpusId;

  return detail;
}
