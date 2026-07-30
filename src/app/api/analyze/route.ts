/**
 * POST /api/analyze — run one LIVE module against stored uploads.
 *
 * THIS ROUTE IS INTENTIONALLY UNAUTHENTICATED. It is for local single-operator
 * use only: no session, no org scoping, no audit row, and it reads images from
 * `.lantage-uploads/` on the machine running the dev server. The authenticated,
 * audited, org-scoped production path is `/api/search` — deploy that one
 * publicly, never this one.
 *
 * Two response shapes, chosen the same way `/api/search` chooses:
 *   - `Accept: text/event-stream` (or `?stream=1`) streams stage progress and ends
 *     with a `result` event, which is what the live pipeline readout consumes.
 *   - otherwise, a single JSON `LiveAnalyzeResponse`.
 *
 * The request is validated before either shape is committed to, because a 400 has
 * to be a 400 — once an SSE body has started, the status line is already sent.
 */

import type { LiveAnalyzeRequest, LiveAnalyzeResponse } from '@/lib/live/contract';
import {
  LiveAnalyzeRequestSchema,
  LiveRequestError,
  type LiveProgressEvent,
  analyze,
} from '@/lib/live/orchestrator';

/** Node runtime: the modules read files, decode images and run local ONNX models. */
export const runtime = 'nodejs';

/**
 * Vehicle identification allows a 150s vision budget and the face model may have
 * to fetch weights on first use, so the platform default is not enough.
 */
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad-request', message: 'Body must be JSON.' }, 400);
  }

  const parsed = LiveAnalyzeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: 'bad-request',
        message: 'The analyse request did not match the contract.',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      400,
    );
  }
  const analyzeRequest: LiveAnalyzeRequest = parsed.data;

  const wantsStream =
    new URL(request.url).searchParams.get('stream') === '1' ||
    (request.headers.get('accept') ?? '').includes('text/event-stream');

  if (!wantsStream) {
    try {
      const result = await analyze(analyzeRequest, { signal: request.signal });
      return json(result, 200);
    } catch (e) {
      return errorResponse(e);
    }
  }

  return streamResponse(analyzeRequest, request.signal);
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function streamResponse(analyzeRequest: LiveAnalyzeRequest, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('accepted', { module: analyzeRequest.module, uploadIds: analyzeRequest.uploadIds });
      try {
        const result: LiveAnalyzeResponse = await analyze(analyzeRequest, {
          signal,
          onProgress: (event: LiveProgressEvent) => send('progress', event),
        });
        send('result', { result });
      } catch (e) {
        // A client error still has to reach the operator. The stream cannot carry a
        // status code, so the shape mirrors the JSON error body instead.
        const status = e instanceof LiveRequestError ? e.status : 500;
        send('error', {
          error: status === 404 ? 'not-found' : status === 400 ? 'bad-request' : 'internal-error',
          message: e instanceof Error ? e.message : String(e),
          ...(e instanceof LiveRequestError && e.issues.length > 0 ? { issues: e.issues } : {}),
        });
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A module that fails is not an error here — the orchestrator turns it into a
 * well-formed response with a stated gap. What reaches this function is either a
 * client mistake (unknown upload id, bad body) or a genuine bug, and the two are
 * reported differently on purpose.
 */
function errorResponse(e: unknown): Response {
  if (e instanceof LiveRequestError) {
    return json(
      {
        error: e.status === 404 ? 'not-found' : 'bad-request',
        message: e.message,
        ...(e.issues.length > 0 ? { issues: e.issues } : {}),
      },
      e.status,
    );
  }
  return json(
    {
      error: 'internal-error',
      message: `The analysis failed before any module ran: ${e instanceof Error ? e.message : String(e)}`,
    },
    500,
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
