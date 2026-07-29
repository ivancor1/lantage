/**
 * POST /api/search — run a module against an uploaded frame.
 *
 * Order of operations is a security property, not a style choice:
 *
 *   validate -> authenticate -> verify the account -> check the module is
 *   permitted in this jurisdiction -> write the audit row -> resolve the image ->
 *   run the cascade -> write the outcome row -> persist -> respond
 *
 * The audit row is written **before** the cascade runs, and the outcome is a
 * second row rather than an update, because audit rows are immutable (AGENTS.md).
 * If auth or audit is unavailable this endpoint returns 503: a search that cannot
 * be attributed to a verified user, or cannot be recorded, is a search this
 * product does not perform.
 *
 * Two response shapes:
 *   - `Accept: text/event-stream` (or `?stream=1`) streams stage progress as SSE
 *     and ends with a `result` event, which is what the live pipeline readout in
 *     the UI consumes.
 *   - otherwise, a single JSON `SearchResult`.
 */

import { SearchRequestSchema } from '@/lib/contracts/schemas';
import type { SearchRequest, SearchResult } from '@/lib/contracts/types';
import {
  type CascadeRuntime,
  type SearchPrincipal,
  getCascadeRuntime,
  missingRequiredDependencies,
} from '@/lib/cascade/deps';
import { ModuleNotImplementedError, runCascade } from '@/lib/cascade/orchestrator';
import type { ProgressEvent } from '@/lib/cascade/types';
import { wireCascade } from '@/lib/cascade/wiring';

/** Node runtime: the cascade uses Buffer and reads image bytes. */
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  wireCascade();
  const cascade = getCascadeRuntime();

  // --- dependency preconditions (fail closed) ------------------------------
  const missing = missingRequiredDependencies(cascade);
  if (missing.length > 0) {
    return json(
      {
        error: 'service-unavailable',
        message:
          'Search is not available because required dependencies are not wired. A search that cannot be authenticated, audited, and sourced from stored media is not performed.',
        missing,
      },
      503,
    );
  }
  // Narrowed by the check above; kept local so TypeScript sees non-null.
  const auth = cascade.auth;
  const audit = cascade.audit;
  const imageStore = cascade.imageStore;
  if (!auth || !audit || !imageStore) {
    return json({ error: 'service-unavailable', message: 'Dependency check inconsistent.' }, 503);
  }

  // --- request validation --------------------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad-request', message: 'Body must be JSON.' }, 400);
  }
  const parsed = SearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: 'bad-request',
        message: 'The search request did not match the contract.',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      400,
    );
  }
  const searchRequest: SearchRequest = parsed.data;

  // --- authentication + verification --------------------------------------
  const decision = await auth.canSearch(request);
  if (!decision.allowed || !decision.principal) {
    return json(
      {
        error: decision.status === 403 ? 'forbidden' : 'unauthorized',
        message: decision.reason ?? 'Not permitted to run a search.',
      },
      decision.status ?? 401,
    );
  }
  const principal: SearchPrincipal = decision.principal;
  if (!principal.verified) {
    return json(
      {
        error: 'forbidden',
        message: 'This account is not verified. Verified users only may run searches.',
      },
      403,
    );
  }

  // --- jurisdiction policy -------------------------------------------------
  if (!auth.isModuleAllowed(searchRequest.module, principal.jurisdiction)) {
    return json(
      {
        error: 'forbidden',
        message: `The ${searchRequest.module} module is not permitted for this organisation's jurisdiction.`,
        module: searchRequest.module,
        jurisdiction: principal.jurisdiction,
      },
      403,
    );
  }

  // --- audit (before anything runs) ---------------------------------------
  const searchId = crypto.randomUUID();
  const requestMeta = {
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
  };
  const requested = await audit.writeSearchAudit({
    searchId,
    phase: 'requested',
    module: searchRequest.module,
    imageId: searchRequest.imageId,
    caseId: searchRequest.caseId,
    userId: principal.userId,
    orgId: principal.orgId,
    at: new Date().toISOString(),
    hints: searchRequest.hints,
    ...requestMeta,
  });
  if (!requested.ok) {
    return json(
      {
        error: 'service-unavailable',
        message: `The search was not run because it could not be recorded in the audit log: ${requested.error.reason}`,
      },
      503,
    );
  }

  // --- resolve the image ---------------------------------------------------
  const image = await imageStore.resolve({
    imageId: searchRequest.imageId,
    orgId: principal.orgId,
  });
  if (!image.ok) {
    return json(
      { error: 'not-found', message: `Image could not be resolved: ${image.error.reason}` },
      404,
    );
  }

  const wantsStream =
    new URL(request.url).searchParams.get('stream') === '1' ||
    (request.headers.get('accept') ?? '').includes('text/event-stream');

  const run = async (onProgress?: (event: ProgressEvent) => void): Promise<SearchResult> =>
    runCascade(
      {
        searchId,
        request: searchRequest,
        image: image.value,
        signal: request.signal,
        onProgress,
      },
      cascade,
    );

  if (wantsStream) {
    return streamResponse({ run, cascade, principal, searchRequest, searchId, requestMeta });
  }

  try {
    const result = await run();
    const persisted = await finish({ result, cascade, principal, searchRequest, searchId, requestMeta });
    return json(result, 200, { 'x-lantage-persisted': persisted ? 'true' : 'false' });
  } catch (e) {
    return handleRunError(e, { cascade, principal, searchRequest, searchId, requestMeta });
  }
}

// ---------------------------------------------------------------------------
// Shared tail: outcome audit row + persistence
// ---------------------------------------------------------------------------

interface TailArgs {
  cascade: CascadeRuntime;
  principal: SearchPrincipal;
  searchRequest: SearchRequest;
  searchId: string;
  requestMeta: { ip?: string; userAgent?: string };
}

/** Writes the outcome audit row and persists. Returns whether persistence worked. */
async function finish(args: TailArgs & { result: SearchResult }): Promise<boolean> {
  const { result, cascade, principal, searchRequest, searchId, requestMeta } = args;
  const refused = !result.quality.passed;

  await cascade.audit?.writeSearchAudit({
    searchId,
    phase: refused ? 'refused' : 'completed',
    module: searchRequest.module,
    imageId: searchRequest.imageId,
    caseId: searchRequest.caseId,
    userId: principal.userId,
    orgId: principal.orgId,
    at: new Date().toISOString(),
    note: refused
      ? (result.quality.refusalReason ?? 'Refused at the quality gate.')
      : `${result.geo?.length ?? 0} candidate regions; ${result.stages.filter((s) => s.skipped).length} of ${result.stages.length} stages skipped; $${result.provenance.totalCostUsd.toFixed(5)}.`,
    ...requestMeta,
  });

  if (!cascade.resultStore) return false;
  const saved = await cascade.resultStore.save({
    result,
    orgId: principal.orgId,
    userId: principal.userId,
    caseId: searchRequest.caseId,
  });
  return saved.ok;
}

async function handleRunError(e: unknown, args: TailArgs): Promise<Response> {
  const { cascade, principal, searchRequest, searchId, requestMeta } = args;
  await cascade.audit?.writeSearchAudit({
    searchId,
    phase: 'error',
    module: searchRequest.module,
    imageId: searchRequest.imageId,
    caseId: searchRequest.caseId,
    userId: principal.userId,
    orgId: principal.orgId,
    at: new Date().toISOString(),
    note: e instanceof Error ? e.message : String(e),
    ...requestMeta,
  });

  if (e instanceof ModuleNotImplementedError) {
    return json(
      {
        error: 'not-implemented',
        message: `The ${e.module} module is not available in this build.`,
      },
      501,
    );
  }
  return json(
    { error: 'internal-error', message: 'The search failed. The failure has been recorded.' },
    500,
  );
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function streamResponse(
  args: TailArgs & { run: (onProgress?: (event: ProgressEvent) => void) => Promise<SearchResult> },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('accepted', { searchId: args.searchId, module: args.searchRequest.module });
      try {
        const result = await args.run((progress) => send('progress', progress));
        const persisted = await finish({ ...args, result });
        send('result', { result, persisted });
      } catch (e) {
        send('error', {
          error: e instanceof ModuleNotImplementedError ? 'not-implemented' : 'internal-error',
          message: e instanceof Error ? e.message : String(e),
        });
        await handleRunError(e, args);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}
