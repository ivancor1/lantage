/**
 * Browser client for the live analysis path: POST /api/upload → POST /api/analyze.
 *
 * Two rules shape this file.
 *
 * 1. **The server's words, verbatim.** A 4xx/5xx is surfaced with the message the
 *    route returned (`{ error, message }` is the house shape — see
 *    src/app/api/search/route.ts). We never replace it with a friendly string,
 *    because the message is usually the operator's only instruction — "set
 *    ANTHROPIC_API_KEY", "the file is not an image", "quality gate refused".
 *
 * 2. **Nothing is filled in.** Missing optional fields stay missing all the way to
 *    the screen. The only substitutions made here are values we measured
 *    ourselves from the operator's own `File` (name, byte length, MIME) and the
 *    local object URL used to render their own upload back to them.
 */

import type { Evidence, QualityGate, StageTrace } from '@/lib/contracts/types';
import {
  LIVE_MODULES,
  type CapabilityGap,
  type LiveAnalyzeRequest,
  type LiveAnalyzeResponse,
  type LiveModule,
  type UploadRecord,
} from '@/lib/live/contract';

export class ApiError extends Error {
  readonly status: number;
  /** Extra server-supplied context: validation issues, missing dependencies. */
  readonly detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * The analyse response as the UI holds it.
 *
 * Deliberately looser than `LiveAnalyzeResponse` in exactly one direction:
 * fields the server may omit are optional here, so a section renders only when
 * its data actually arrived. Collections default to empty — an empty list is a
 * true statement, a placeholder value would not be.
 */
export interface Analysis {
  id?: string;
  module: LiveModule;
  uploads: UploadRecord[];
  quality?: QualityGate;
  geo?: LiveAnalyzeResponse['geo'];
  vehicles?: LiveAnalyzeResponse['vehicles'];
  authenticity?: LiveAnalyzeResponse['authenticity'];
  face?: LiveAnalyzeResponse['face'];
  provenanceHits?: LiveAnalyzeResponse['provenanceHits'];
  evidence: Evidence[];
  stages: StageTrace[];
  provenance?: LiveAnalyzeResponse['provenance'];
  unavailable: CapabilityGap[];
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Always throws. Reads the server's own message out of the body first. */
async function throwServerError(response: Response): Promise<never> {
  const raw = await response.text().catch(() => '');
  let message = '';
  let detail: string | undefined;

  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const body = parsed as Record<string, unknown>;
        for (const key of ['message', 'error', 'detail', 'reason'] as const) {
          const value = body[key];
          if (typeof value === 'string' && value.length > 0) {
            message = value;
            break;
          }
        }
        const issues = body.issues;
        if (Array.isArray(issues)) {
          detail = issues
            .map((issue) => {
              if (!issue || typeof issue !== 'object') return String(issue);
              const i = issue as Record<string, unknown>;
              const path = typeof i.path === 'string' ? i.path : '';
              const text = typeof i.message === 'string' ? i.message : JSON.stringify(i);
              return path ? `${path}: ${text}` : text;
            })
            .join(' · ');
        }
        const missing = body.missing;
        if (!detail && Array.isArray(missing)) detail = `missing: ${missing.map(String).join(', ')}`;
        if (!message) message = raw.slice(0, 400);
      } else {
        message = raw.slice(0, 400);
      }
    } catch {
      // Not JSON — an HTML error page or a plain string. Show it as-is, trimmed.
      message = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    }
  }

  throw new ApiError(
    message || `${response.status} ${response.statusText || 'request failed'}`,
    response.status,
    detail,
  );
}

/** A route that does not exist yet is the most likely failure in this build. */
function missingRouteHint(status: number, path: string): string | undefined {
  return status === 404 ? `No route is mounted at ${path} in this build.` : undefined;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Uploads one image and returns the record the server assigned it.
 *
 * `localPreviewUrl` is the operator's own file as an object URL. It is used only
 * as the preview fallback when the server does not hand back a `previewUrl`;
 * nothing else about the record is sourced locally except the three properties
 * the browser itself measured.
 */
export async function uploadImage(
  file: File,
  localPreviewUrl: string,
  signal?: AbortSignal,
): Promise<UploadRecord> {
  const body = new FormData();
  body.append('file', file, file.name);

  const response = await fetch('/api/upload', { method: 'POST', body, signal });
  if (!response.ok) {
    const hint = missingRouteHint(response.status, '/api/upload');
    try {
      await throwServerError(response);
    } catch (error) {
      if (error instanceof ApiError && hint) {
        throw new ApiError(error.message, error.status, error.detail ?? hint);
      }
      throw error;
    }
  }

  const payload: unknown = await response.json().catch(() => null);
  const record = normaliseUpload(payload, file, localPreviewUrl);
  if (!record) {
    throw new ApiError(
      'The upload succeeded but the response carried no upload id, so there is nothing to analyse.',
      response.status,
      payload && typeof payload === 'object'
        ? `keys returned: ${Object.keys(payload as Record<string, unknown>).join(', ') || 'none'}`
        : undefined,
    );
  }
  return record;
}

function normaliseUpload(payload: unknown, file: File, localPreviewUrl: string): UploadRecord | null {
  const raw = findRecord(payload);
  if (!raw) return null;
  const str = (key: string): string | undefined =>
    typeof raw[key] === 'string' ? (raw[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key] as number) ? (raw[key] as number) : undefined;

  return {
    id: raw.id as string,
    // Measured by the browser from the operator's own file when the server is
    // silent. Both sources are real; neither is a guess.
    filename: str('filename') ?? str('name') ?? file.name,
    bytes: num('bytes') ?? num('size') ?? file.size,
    mime: str('mime') ?? str('mimeType') ?? str('type') ?? file.type,
    width: num('width'),
    height: num('height'),
    sha256: str('sha256') ?? '',
    previewUrl: str('previewUrl') ?? str('url') ?? localPreviewUrl,
    createdAt: str('createdAt') ?? '',
  };
}

/** Accepts the record bare, wrapped in a key, or as the first element of a list. */
function findRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.id === 'string') return body;

  for (const key of ['upload', 'record', 'file', 'data', 'result'] as const) {
    const nested = body[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const candidate = nested as Record<string, unknown>;
      if (typeof candidate.id === 'string') return candidate;
    }
  }
  for (const key of ['uploads', 'records', 'files', 'data', 'results'] as const) {
    const list = body[key];
    if (Array.isArray(list) && list.length > 0) {
      const first = list[0] as unknown;
      if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).id === 'string') {
        return first as Record<string, unknown>;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

export interface AnalyzeHandlers {
  /** A stage finished and reported its real trace. Called as events arrive. */
  onStage?: (trace: StageTrace) => void;
  /** A stage started. There is no timing yet, so nothing numeric is emitted. */
  onStageStart?: (stage: StageTrace['stage']) => void;
  onNote?: (message: string) => void;
  /** Fires once we know the response is a stage stream rather than one JSON blob. */
  onStream?: (streaming: boolean) => void;
}

export async function analyze(
  request: LiveAnalyzeRequest,
  handlers: AnalyzeHandlers = {},
  signal?: AbortSignal,
): Promise<Analysis> {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    // Ask for the stream and take JSON if the route does not implement one.
    headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const hint = missingRouteHint(response.status, '/api/analyze');
    try {
      await throwServerError(response);
    } catch (error) {
      if (error instanceof ApiError && hint) {
        throw new ApiError(error.message, error.status, error.detail ?? hint);
      }
      throw error;
    }
  }

  const contentType = response.headers.get('content-type') ?? '';
  const streaming = contentType.includes('text/event-stream') && response.body !== null;
  handlers.onStream?.(streaming);

  if (!streaming) {
    const payload: unknown = await response.json().catch(() => null);
    return normaliseAnalysis(payload, request.module, response.status);
  }
  return readStream(response, request.module, handlers);
}

async function readStream(
  response: Response,
  module: LiveModule,
  handlers: AnalyzeHandlers,
): Promise<Analysis> {
  const body = response.body;
  if (!body) throw new ApiError('The stream ended before it began.', response.status);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  /* Assignments stay in this scope rather than in a nested drain() closure:
     TypeScript's control-flow analysis does not see writes made inside a
     callback, which would leave both of these narrowed to `null` below. */
  let buffer = '';
  let analysis: Analysis | null = null;
  let failure: ApiError | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    // CRLF-delimited streams are legal SSE; normalise so one splitter works.
    if (value) buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    if (done) buffer += decoder.decode().replace(/\r\n/g, '\n');

    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');
      const event = parseSseBlock(block);
      if (!event) continue;
      const outcome = dispatch(event, module, response.status, handlers);
      if (outcome instanceof ApiError) failure = outcome;
      else if (outcome) analysis = outcome;
    }

    if (done) {
      // A trailing block that never got its blank line.
      if (buffer.trim().length > 0) {
        const event = parseSseBlock(buffer);
        if (event) {
          const outcome = dispatch(event, module, response.status, handlers);
          if (outcome instanceof ApiError) failure = outcome;
          else if (outcome) analysis = outcome;
        }
      }
      break;
    }
  }

  if (failure) throw failure;
  if (!analysis) {
    throw new ApiError(
      'The stage stream closed without returning a result.',
      response.status,
      'The run may have been interrupted server-side. Nothing is shown rather than a partial finding.',
    );
  }
  return analysis;
}

interface SseEvent {
  event: string;
  data: unknown;
}

function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line.length === 0) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const text = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(text) as unknown };
  } catch {
    return { event, data: text };
  }
}

/** Returns the finished analysis, an error to throw, or nothing. */
function dispatch(
  { event, data }: SseEvent,
  module: LiveModule,
  status: number,
  handlers: AnalyzeHandlers,
): Analysis | ApiError | null {
  if (event === 'error') {
    const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const message =
      typeof body.message === 'string'
        ? body.message
        : typeof data === 'string'
          ? data
          : 'The run failed and the server did not say why.';
    const detail = typeof body.error === 'string' ? body.error : undefined;
    return new ApiError(message, status, detail);
  }

  if (!data || typeof data !== 'object') return null;
  const body = data as Record<string, unknown>;

  // A result can arrive as the response itself or wrapped in `result`.
  if (event === 'result' || looksLikeAnalysis(body)) {
    try {
      return normaliseAnalysis(body, module, status);
    } catch (error) {
      return error instanceof ApiError ? error : new ApiError(String(error), status);
    }
  }

  if (body.type === 'stage-start' && typeof body.stage === 'string') {
    handlers.onStageStart?.(body.stage as StageTrace['stage']);
    return null;
  }
  if (body.type === 'note' && typeof body.message === 'string') {
    handlers.onNote?.(body.message);
    return null;
  }

  const trace = asStageTrace(body.trace) ?? asStageTrace(body);
  if (trace) {
    handlers.onStage?.(trace);
    return null;
  }
  if (Array.isArray(body.stages)) {
    for (const entry of body.stages) {
      const each = asStageTrace(entry);
      if (each) handlers.onStage?.(each);
    }
  }
  return null;
}

function asStageTrace(value: unknown): StageTrace | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.stage !== 'string' || typeof o.ranMs !== 'number') return null;
  return o as unknown as StageTrace;
}

function looksLikeAnalysis(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.stages) && (typeof body.module === 'string' || typeof body.quality === 'object')) {
    return true;
  }
  const nested = body.result;
  return Boolean(nested && typeof nested === 'object' && Array.isArray((nested as Record<string, unknown>).stages));
}

// ---------------------------------------------------------------------------
// Response normalisation
// ---------------------------------------------------------------------------

function normaliseAnalysis(payload: unknown, requested: LiveModule, status: number): Analysis {
  const unwrapped = unwrap(payload);
  if (!unwrapped) {
    throw new ApiError(
      'The analyse response did not contain a result this UI can read.',
      status,
      payload && typeof payload === 'object'
        ? `keys returned: ${Object.keys(payload as Record<string, unknown>).join(', ') || 'none'}`
        : `received: ${typeof payload}`,
    );
  }

  const stages = Array.isArray(unwrapped.stages)
    ? unwrapped.stages.map(asStageTrace).filter((t): t is StageTrace => t !== null)
    : null;
  if (!stages) {
    throw new ApiError(
      'The analyse response carried no stage trace, so there is no record of what actually ran.',
      status,
      'A result without a trace is not shown — see AGENTS.md, "no result without cited evidence".',
    );
  }

  /* Named `resolvedModule`, not `module`: `module` is a reserved binding in a
     Next.js module scope (@next/next/no-assign-module-variable). */
  const resolvedModule = LIVE_MODULES.includes(unwrapped.module as LiveModule)
    ? (unwrapped.module as LiveModule)
    : requested;

  return {
    id: typeof unwrapped.id === 'string' ? unwrapped.id : undefined,
    module: resolvedModule,
    uploads: Array.isArray(unwrapped.uploads) ? (unwrapped.uploads as UploadRecord[]) : [],
    quality: isObject(unwrapped.quality) ? (unwrapped.quality as unknown as QualityGate) : undefined,
    geo: Array.isArray(unwrapped.geo) ? (unwrapped.geo as Analysis['geo']) : undefined,
    vehicles: Array.isArray(unwrapped.vehicles) ? (unwrapped.vehicles as Analysis['vehicles']) : undefined,
    authenticity: isObject(unwrapped.authenticity)
      ? (unwrapped.authenticity as Analysis['authenticity'])
      : undefined,
    face: isObject(unwrapped.face) ? (unwrapped.face as Analysis['face']) : undefined,
    provenanceHits: Array.isArray(unwrapped.provenanceHits)
      ? (unwrapped.provenanceHits as Analysis['provenanceHits'])
      : undefined,
    evidence: Array.isArray(unwrapped.evidence) ? (unwrapped.evidence as Evidence[]) : [],
    stages,
    provenance: isObject(unwrapped.provenance) ? (unwrapped.provenance as Analysis['provenance']) : undefined,
    unavailable: Array.isArray(unwrapped.unavailable) ? (unwrapped.unavailable as CapabilityGap[]) : [],
    createdAt: typeof unwrapped.createdAt === 'string' ? unwrapped.createdAt : undefined,
  };
}

function unwrap(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload)) return null;
  const body = payload as Record<string, unknown>;
  if (Array.isArray(body.stages)) return body;
  for (const key of ['result', 'analysis', 'data', 'response'] as const) {
    const nested = body[key];
    if (isObject(nested) && Array.isArray((nested as Record<string, unknown>).stages)) {
      return nested as Record<string, unknown>;
    }
  }
  return null;
}

function isObject(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
