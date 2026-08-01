/**
 * OpenAI vision provider.
 *
 * Request shape verified 2026-07-30 against developers.openai.com and the
 * official openai-python README — not written from memory. What changed since
 * training data is exactly the part that would have been wrong:
 *
 *   POST https://api.openai.com/v1/responses          (Responses API, not chat)
 *   input: [{ role:'user', content:[
 *     { type:'input_image', image_url:'data:image/jpeg;base64,…', detail:'high' },
 *     { type:'input_text', text: prompt } ]}]
 *   forced JSON: text.format = { type:'json_schema', name, schema, strict:true }
 *   response: output[].content[] with type 'output_text' | 'refusal'
 *
 * `store: false` is deliberate: investigative imagery should not sit in a vendor
 * dashboard because a default was left alone.
 *
 * DEFAULTS, AND WHAT THEY WERE MEASURED AGAINST (2026-07-31, `scripts/bench-locate.ts`,
 * a 2560x1440 outdoor Street View frame with a known ground truth):
 *
 *   model   `gpt-5.6-luna`, replacing `gpt-5.5`. Not chosen on price alone —
 *           `gpt-5.5`, `gpt-5.6-terra` and `gpt-5.6-luna` were each run on the
 *           same frame and returned the SAME 17 text observations, the same
 *           region prior at the same self-reported confidence, and the same
 *           confidence band. On a second frame with no legible text, all three
 *           set `insufficientSignal` and named no region — the cheap model
 *           declines to guess exactly where the expensive one does, which is the
 *           failure mode that actually matters here. At matched effort luna is
 *           5.3x cheaper per search than gpt-5.5 and about half its latency
 *           (7.4s p50 against 12.3-13.6s).
 *
 *   effort  `none`. `reasoning.effort` is the single largest latency term: on
 *           gpt-5.5 the vendor default spent 516 hidden reasoning tokens and
 *           22.4s, against 12.4s at `none` for an identical clue list. This is a
 *           schema-constrained extraction of what is visible in a frame — the
 *           model is enumerating, not deducing — so extended reasoning buys
 *           nothing and is billed at the output rate.
 *
 * Both stay overridable (`LANTAGE_OPENAI_VLM_MODEL`,
 * `LANTAGE_OPENAI_REASONING_EFFORT`): a default is a measurement, not a policy,
 * and a harder corpus may well justify escalating.
 */

import { z } from 'zod';
import type { VisionVendor } from '@/lib/live/contract';
import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';
import { CLUES_SCHEMA_NAME, sanitiseVendorJsonSchema, vlmCluesJsonSchema } from './jsonSchema';
import { type PreparedImage, prepareImage } from './image';
import { callVendorJson } from './net';
import { parseCluePayload, parseStructured } from './parse';
import { buildCluePrompt, buildJsonOnlyPrompt } from './prompt';
import { usageFor } from './pricing';
import {
  type JsonSchemaObject,
  type LiveVisionProvider,
  type LiveVlmRequest,
  type LiveVlmResult,
  type StructuredRequest,
  type StructuredResult,
  type VisionUsage,
} from './types';

const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Only the gpt-5 and o-series families accept `reasoning.effort` at all — gpt-4o
 * answers HTTP 400 "Unsupported parameter" (probed 2026-07-31) — so the field is
 * gated on the model id rather than sent unconditionally. Without the gate, an
 * operator setting `LANTAGE_OPENAI_VLM_MODEL=gpt-4o` would get a hard 400 from a
 * default they never chose.
 */
const REASONING_MODEL_PATTERN = /^(gpt-5|o1|o3|o4)/i;

export function supportsReasoningEffort(model: string): boolean {
  return REASONING_MODEL_PATTERN.test(model.trim());
}

const DEFAULT_REASONING_EFFORT = 'none';

const ResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
  error: z.object({ message: z.string().nullish(), code: z.string().nullish() }).nullish(),
  output_text: z.string().nullish(),
  output: z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().nullish(),
              refusal: z.string().nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      input_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
      output_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
    })
    .optional(),
});

type OpenAiResponse = z.infer<typeof ResponseSchema>;

export interface OpenAiVisionOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxLongEdgePx?: number;
  /** 'none' | 'low' | 'medium' | 'high' | 'xhigh'. Ignored by non-reasoning models. */
  reasoningEffort?: string;
}

export class OpenAiVisionProvider implements LiveVisionProvider {
  readonly vendor: VisionVendor = 'openai';
  readonly model: string;
  readonly name: string;
  readonly reasoningEffort: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly maxLongEdgePx: number | undefined;

  constructor(opts: OpenAiVisionOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = opts.model ?? process.env.LANTAGE_OPENAI_VLM_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.maxLongEdgePx = opts.maxLongEdgePx;
    const effort =
      opts.reasoningEffort ?? process.env.LANTAGE_OPENAI_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT;
    // '' or 'default' means "send no reasoning field and take the vendor's own
    // default" — the escape hatch for a model whose supported values change.
    this.reasoningEffort =
      effort && effort !== 'default' && supportsReasoningEffort(this.model) ? effort : undefined;
    this.name = `openai:${this.model}`;
  }

  async extractClues(req: LiveVlmRequest): Promise<Result<LiveVlmResult, StageFailure>> {
    const prepared = await this.prepare(req.image.bytes, req.maxLongEdgePx);
    if (!prepared.ok) return prepared;
    const image = prepared.value;
    const schema = vlmCluesJsonSchema(req.requestRegionCoordinates === true);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildCluePrompt({
        prompt: req.prompt,
        promptSuffix: req.promptSuffix,
        requestRegionCoordinates: req.requestRegionCoordinates,
        repair: attempt === 2,
      });

      const res = await this.post({
        prompt,
        base64: image.base64,
        mediaType: image.mediaType,
        schema,
        schemaName: CLUES_SCHEMA_NAME,
        timeoutMs: req.timeoutMs,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        signal: req.signal,
      });
      if (!res.ok) {
        if (res.error.kind !== 'invalid-response' || attempt === 2) return res;
        continue;
      }

      const content = contentOf(res.value);
      if (content.refusal) {
        return err(
          failure('invalid-response', `The vision model declined the image: ${content.refusal}`),
        );
      }
      if (!content.text) {
        const reason = incompleteReason(res.value);
        if (attempt === 2) return err(failure('invalid-response', reason));
        continue;
      }

      const parsed = parseCluePayload(content.text);
      if (!parsed.ok) {
        if (parsed.error.kind === 'no-input' || attempt === 2) return parsed;
        continue;
      }

      const notes = [...image.notes, ...parsed.value.notes];
      if (res.value.status === 'incomplete') notes.push(incompleteReason(res.value));

      return ok({
        clues: parsed.value.clues,
        modelVersion: res.value.model ?? this.model,
        attempts: attempt,
        usage: this.usage(res.value),
        image: image.facts,
        ...(parsed.value.regionCoordinates ? { regionCoordinates: parsed.value.regionCoordinates } : {}),
        notes,
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
    const schema = req.jsonSchema ? sanitiseVendorJsonSchema(req.jsonSchema) : undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const res = await this.post({
        prompt: buildJsonOnlyPrompt(req.prompt, attempt === 2),
        base64: image.base64,
        mediaType: image.mediaType,
        schema,
        schemaName: req.schemaName ?? 'structured_output',
        timeoutMs: req.timeoutMs,
        maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        signal: req.signal,
      });
      if (!res.ok) {
        if (res.error.kind !== 'invalid-response' || attempt === 2) return res;
        continue;
      }

      const content = contentOf(res.value);
      if (content.refusal) {
        return err(
          failure('invalid-response', `The vision model declined the image: ${content.refusal}`),
        );
      }
      if (!content.text) {
        if (attempt === 2) return err(failure('invalid-response', incompleteReason(res.value)));
        continue;
      }

      const parsed = parseStructured(content.text, req.schema);
      if (!parsed.ok) {
        if (attempt === 2) return parsed;
        continue;
      }

      const notes = [...image.notes];
      if (!schema) {
        notes.push(
          'No vendor-side JSON Schema was supplied, so only JSON-object mode plus the caller\'s zod schema constrained the response.',
        );
      }

      return ok({
        value: parsed.value.value,
        raw: parsed.value.raw,
        modelVersion: res.value.model ?? this.model,
        attempts: attempt,
        usage: this.usage(res.value),
        image: image.facts,
        notes,
      });
    }

    return err(failure('invalid-response', 'The vision model never returned a valid response.'));
  }

  private usage(res: OpenAiResponse): VisionUsage {
    return usageFor({
      vendor: this.vendor,
      model: res.model ?? this.model,
      tokens: {
        ...(res.usage?.input_tokens === undefined ? {} : { inputTokens: res.usage.input_tokens }),
        ...(res.usage?.output_tokens === undefined ? {} : { outputTokens: res.usage.output_tokens }),
        ...(res.usage?.input_tokens_details?.cached_tokens == null
          ? {}
          : { cachedInputTokens: res.usage.input_tokens_details.cached_tokens }),
        ...(res.usage?.output_tokens_details?.reasoning_tokens == null
          ? {}
          : { reasoningTokens: res.usage.output_tokens_details.reasoning_tokens }),
      },
    });
  }

  private async prepare(
    bytes: Uint8Array | undefined,
    maxLongEdgePx: number | undefined,
  ): Promise<Result<PreparedImage, StageFailure>> {
    if (!this.apiKey) {
      return err(failure('not-configured', 'OPENAI_API_KEY is not set, so no vision call was made.'));
    }
    if (!bytes || bytes.byteLength === 0) {
      return err(failure('no-input', 'The vision call needs the image bytes and none were read.'));
    }
    const target = maxLongEdgePx ?? this.maxLongEdgePx;
    return prepareImage(bytes, target === undefined ? {} : { maxLongEdgePx: target });
  }

  private post(args: {
    prompt: string;
    base64: string;
    mediaType: string;
    schema: JsonSchemaObject | undefined;
    schemaName: string;
    timeoutMs: number;
    maxOutputTokens: number;
    signal: AbortSignal | undefined;
  }): Promise<Result<OpenAiResponse, StageFailure>> {
    const { prompt, base64, mediaType, schema, schemaName, timeoutMs, maxOutputTokens, signal } = args;
    return callVendorJson({
      url: `${this.baseUrl}/v1/responses`,
      headers: { authorization: `Bearer ${this.apiKey ?? ''}` },
      body: {
        model: this.model,
        max_output_tokens: maxOutputTokens,
        ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
        // Investigative imagery does not get retained in a vendor dashboard by
        // default. This is a privacy setting, not a performance one.
        store: false,
        text: schema
          ? { format: { type: 'json_schema', name: schemaName, schema, strict: true } }
          : { format: { type: 'json_object' } },
        input: [
          {
            role: 'user',
            content: [
              // Image first: the frame is the subject, the prompt is the question.
              //
              // Reordering to put the (byte-identical) prompt first was tried as a
              // prompt-cache play and MEASURED NOT TO WORK, 2026-07-31: with four
              // different images behind the same 2.4k-token text prefix,
              // `cached_tokens` was 0 every time, with or without
              // `prompt_cache_key`. Only a byte-identical repeat of the whole
              // request cached (5,131 of 5,408). Since every real search carries a
              // new image, there is no cacheable prefix to win, so the ordering
              // stays as it was rather than changing for a benefit that isn't there.
              {
                type: 'input_image',
                image_url: `data:${mediaType};base64,${base64}`,
                // We already capped the long edge locally; 'high' keeps the
                // vendor from throwing away the detail small text lives in.
                detail: 'high',
              },
              { type: 'input_text', text: prompt },
            ],
          },
        ],
      },
      timeoutMs,
      schema: ResponseSchema,
      ...(signal ? { signal } : {}),
      label: 'vision model (OpenAI)',
    });
  }
}

function contentOf(res: OpenAiResponse): { text: string; refusal?: string } {
  const parts: string[] = [];
  let refusal: string | undefined;

  for (const item of res.output ?? []) {
    for (const block of item.content ?? []) {
      if (block.type === 'refusal' && block.refusal) refusal = block.refusal;
      // 'output_text' is the documented type; anything else carrying text is
      // accepted rather than dropped, since a new block type should degrade to
      // "we read it" and not to "the model said nothing".
      else if (block.text) parts.push(block.text);
    }
  }

  const joined = parts.join('').trim();
  const fallback = typeof res.output_text === 'string' ? res.output_text.trim() : '';
  return { text: joined || fallback, ...(refusal ? { refusal } : {}) };
}

function incompleteReason(res: OpenAiResponse): string {
  const reason = res.incomplete_details?.reason;
  if (reason === 'max_output_tokens') {
    return 'The response hit the output-token ceiling before the JSON was complete, so nothing was parsed rather than a truncated object being repaired.';
  }
  const error = res.error?.message;
  if (error) return `The vision model returned an error: ${error}`;
  return `The vision model returned no text content (status ${res.status ?? 'unknown'}).`;
}
