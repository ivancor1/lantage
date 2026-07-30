/**
 * Gemini adapter.
 *
 * The cascade already ships `GeminiFlashVlmProvider`, and it is the audited
 * implementation for this vendor — so the default clue path *delegates to it*
 * rather than reimplementing a second Gemini client. This class adds only what
 * that provider cannot do:
 *
 *   - honour a caller-supplied prompt. `GeminiFlashVlmProvider` bakes
 *     `CLUE_EXTRACTION_PROMPT` in, so INTERIOR's indoor prompt would be silently
 *     dropped. When a prompt override, suffix, or coordinate request is present,
 *     the call is issued here instead — same endpoint, same body shape as the
 *     cascade's, just with the prompt the caller actually asked for.
 *   - `extractStructured`, for callers whose schema is not `VlmClues`.
 *
 * Cost: Gemini's own token usage is not surfaced by the delegate, so cost comes
 * from `COSTS.vlmUsdPerCall` — the repo's sanctioned per-call figure for this
 * Flash-class slot, and the same number INTERIOR uses. That is a recorded
 * in-repo price rather than a per-token guess, and `costBasis` says so.
 */

import { z } from 'zod';
import type { VisionVendor } from '@/lib/live/contract';
import { COSTS, ENDPOINTS, MODEL_VERSIONS } from '@/lib/cascade/config';
import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';
import { GeminiFlashVlmProvider } from '@/lib/cascade/vlmProvider';
import { type PreparedImage, prepareImage } from './image';
import { callVendorJson } from './net';
import { parseCluePayload, parseStructured } from './parse';
import { buildCluePrompt, buildJsonOnlyPrompt } from './prompt';
import type {
  LiveVisionProvider,
  LiveVlmRequest,
  LiveVlmResult,
  SentImageFacts,
  StructuredRequest,
  StructuredResult,
  VisionUsage,
} from './types';

const GenerateContentSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().optional() })).optional() })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      cachedContentTokenCount: z.number().optional(),
    })
    .optional(),
});

type GenerateContentResponse = z.infer<typeof GenerateContentSchema>;

export interface GeminiVisionOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxLongEdgePx?: number;
}

export class GeminiVisionProvider implements LiveVisionProvider {
  readonly vendor: VisionVendor = 'gemini';
  readonly model: string;
  /** Contains 'gemini' on purpose: callers key their cost model off this string. */
  readonly name: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly maxLongEdgePx: number | undefined;
  private readonly delegate: GeminiFlashVlmProvider;

  constructor(opts: GeminiVisionOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    this.model = opts.model ?? MODEL_VERSIONS.vlm;
    this.baseUrl = (opts.baseUrl ?? ENDPOINTS.vlm).replace(/\/$/, '');
    this.maxLongEdgePx = opts.maxLongEdgePx;
    this.name = `gemini:${this.model}`;
    this.delegate = new GeminiFlashVlmProvider(this.apiKey, this.model, this.baseUrl);
  }

  async extractClues(req: LiveVlmRequest): Promise<Result<LiveVlmResult, StageFailure>> {
    const customised =
      req.prompt !== undefined || req.promptSuffix !== undefined || req.requestRegionCoordinates === true;

    if (!customised) {
      const res = await this.delegate.extractClues(req);
      if (!res.ok) return res;
      return ok({
        ...res.value,
        usage: this.flatUsage(res.value.attempts),
        image: {
          scale: 1,
          mediaType: req.image.mimeType ?? 'image/jpeg',
          bytes: req.image.bytes?.byteLength ?? 0,
          method: 'passthrough (cascade Gemini provider)',
        },
        notes: [],
      });
    }

    const prepared = await this.prepare(req.image.bytes, req.maxLongEdgePx);
    if (!prepared.ok) return prepared;
    const image = prepared.value;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildCluePrompt({
        prompt: req.prompt,
        promptSuffix: req.promptSuffix,
        requestRegionCoordinates: req.requestRegionCoordinates,
        repair: attempt === 2,
      });
      const res = await this.post(prompt, image, req.timeoutMs, req.signal);
      if (!res.ok) {
        if (res.error.kind !== 'invalid-response' || attempt === 2) return res;
        continue;
      }
      const text = textOf(res.value);
      if (!text) {
        if (attempt === 2) return err(failure('invalid-response', noContentReason(res.value)));
        continue;
      }
      const parsed = parseCluePayload(text);
      if (!parsed.ok) {
        if (parsed.error.kind === 'no-input' || attempt === 2) return parsed;
        continue;
      }
      return ok({
        clues: parsed.value.clues,
        modelVersion: this.model,
        attempts: attempt,
        usage: this.flatUsage(attempt, res.value),
        image: image.facts,
        ...(parsed.value.regionCoordinates ? { regionCoordinates: parsed.value.regionCoordinates } : {}),
        notes: [...image.notes, ...parsed.value.notes],
      });
    }
    return err(failure('invalid-response', 'The vision model never returned a valid clue list.'));
  }

  async extractStructured<T>(
    req: StructuredRequest<T>,
  ): Promise<Result<StructuredResult<T>, StageFailure>> {
    const prepared = await this.prepare(req.image.bytes, req.maxLongEdgePx);
    if (!prepared.ok) return prepared;
    const image = prepared.value;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const res = await this.post(
        buildJsonOnlyPrompt(req.prompt, attempt === 2),
        image,
        req.timeoutMs,
        req.signal,
        req.maxOutputTokens,
      );
      if (!res.ok) {
        if (res.error.kind !== 'invalid-response' || attempt === 2) return res;
        continue;
      }
      const text = textOf(res.value);
      if (!text) {
        if (attempt === 2) return err(failure('invalid-response', noContentReason(res.value)));
        continue;
      }
      const parsed = parseStructured(text, req.schema);
      if (!parsed.ok) {
        if (attempt === 2) return parsed;
        continue;
      }
      return ok({
        value: parsed.value.value,
        raw: parsed.value.raw,
        modelVersion: this.model,
        attempts: attempt,
        usage: this.flatUsage(attempt, res.value),
        image: image.facts,
        notes: [
          ...image.notes,
          'Shape was enforced by JSON response mode plus the caller\'s zod schema; no vendor-side JSON Schema was sent.',
        ],
      });
    }
    return err(failure('invalid-response', 'The vision model never returned a valid response.'));
  }

  private flatUsage(attempts: number, res?: GenerateContentResponse): VisionUsage {
    const calls = Math.max(1, attempts);
    return {
      ...(res?.usageMetadata?.promptTokenCount === undefined
        ? {}
        : { inputTokens: res.usageMetadata.promptTokenCount }),
      ...(res?.usageMetadata?.candidatesTokenCount === undefined
        ? {}
        : { outputTokens: res.usageMetadata.candidatesTokenCount }),
      costUsd: COSTS.vlmUsdPerCall * calls,
      costBasis: `${calls} call(s) at the flat per-call figure recorded in src/lib/cascade/config.ts (COSTS.vlmUsdPerCall = ${COSTS.vlmUsdPerCall}) for this Flash-class slot. Not derived from token counts.`,
    };
  }

  private async prepare(
    bytes: Uint8Array | undefined,
    maxLongEdgePx: number | undefined,
  ): Promise<Result<PreparedImage, StageFailure>> {
    if (!this.apiKey) {
      return err(
        failure('not-configured', 'No GEMINI_API_KEY / GOOGLE_API_KEY is set, so no vision call was made.'),
      );
    }
    if (!bytes || bytes.byteLength === 0) {
      return err(failure('no-input', 'The vision call needs the image bytes and none were read.'));
    }
    const target = maxLongEdgePx ?? this.maxLongEdgePx;
    return prepareImage(bytes, target === undefined ? {} : { maxLongEdgePx: target });
  }

  private post(
    prompt: string,
    image: { base64: string; mediaType: string; facts: SentImageFacts },
    timeoutMs: number,
    signal: AbortSignal | undefined,
    maxOutputTokens = 8_192,
  ): Promise<Result<GenerateContentResponse, StageFailure>> {
    return callVendorJson({
      url: `${this.baseUrl}/models/${this.model}:generateContent`,
      headers: { 'x-goog-api-key': this.apiKey ?? '' },
      body: {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: image.mediaType, data: image.base64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          maxOutputTokens,
        },
      },
      timeoutMs,
      schema: GenerateContentSchema,
      ...(signal ? { signal } : {}),
      label: 'vision model (Gemini)',
    });
  }
}

function textOf(res: GenerateContentResponse): string {
  return (res.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}

function noContentReason(res: GenerateContentResponse): string {
  const blocked = res.promptFeedback?.blockReason;
  if (blocked) return `The vision model declined the image (${blocked}).`;
  const finish = res.candidates?.[0]?.finishReason;
  return `The vision model returned no content${finish ? ` (finishReason ${finish})` : ''}.`;
}
