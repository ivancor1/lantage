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
 * The default model is `gpt-5.5`, which is what the current official SDK README
 * uses in every vision example. Cheaper current models exist (`gpt-5.6-terra`,
 * `gpt-5.6-luna`) and are priced in `pricing.ts`, but their vision behaviour was
 * not verified here, so they are an opt-in via `LANTAGE_OPENAI_VLM_MODEL` rather
 * than a default chosen on price.
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

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

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
    })
    .optional(),
});

type OpenAiResponse = z.infer<typeof ResponseSchema>;

export interface OpenAiVisionOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxLongEdgePx?: number;
}

export class OpenAiVisionProvider implements LiveVisionProvider {
  readonly vendor: VisionVendor = 'openai';
  readonly model: string;
  readonly name: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly maxLongEdgePx: number | undefined;

  constructor(opts: OpenAiVisionOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = opts.model ?? process.env.LANTAGE_OPENAI_VLM_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.maxLongEdgePx = opts.maxLongEdgePx;
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
