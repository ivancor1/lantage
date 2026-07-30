/**
 * Anthropic vision provider.
 *
 * Request shape verified 2026-07-30 against platform.claude.com docs — not
 * written from memory:
 *
 *   POST https://api.anthropic.com/v1/messages
 *   headers: x-api-key, anthropic-version: 2023-06-01
 *   image block: { type:'image', source:{ type:'base64', media_type, data } }
 *   forced JSON: output_config.format = { type:'json_schema', schema }
 *
 * Two deliberate choices:
 *
 * - **Image before text.** The doc is explicit that Claude works best with the
 *   image ahead of the instruction, and this task is entirely about reading a
 *   frame.
 * - **Model default is Sonnet-class, thinking off.** The cascade's rule (see the
 *   header of `src/lib/cascade/vlmProvider.ts`) is that a reasoning-heavy model
 *   is banned from this slot: it is a structured-extraction call inside an
 *   interactive request, and an Opus-class model with adaptive thinking spends
 *   15-60s and a lot of output tokens producing the same clue list. Override with
 *   `LANTAGE_ANTHROPIC_VLM_MODEL` when you want to pay for that. Note that
 *   `thinking: {type:'disabled'}` is valid on Sonnet 5 and Opus 5 but is rejected
 *   by some newer models, so an override may also need `LANTAGE_VLM_THINKING=on`.
 */

import { z } from 'zod';
import type { VisionVendor } from '@/lib/live/contract';
import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';
import { sanitiseVendorJsonSchema, vlmCluesJsonSchema } from './jsonSchema';
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
} from './types';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8_192;

const MessageSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  stop_reason: z.string().nullish(),
  stop_sequence: z.string().nullish(),
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
    })
    .optional(),
});

type AnthropicMessage = z.infer<typeof MessageSchema>;

export interface AnthropicVisionOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Set false when the configured model rejects `thinking: {type:'disabled'}`. */
  disableThinking?: boolean;
  /** Long edge sent to the vendor. Defaults to the standard-tier cap. */
  maxLongEdgePx?: number;
}

export class AnthropicVisionProvider implements LiveVisionProvider {
  readonly vendor: VisionVendor = 'anthropic';
  readonly model: string;
  readonly name: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly disableThinking: boolean;
  private readonly maxLongEdgePx: number | undefined;

  constructor(opts: AnthropicVisionOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = opts.model ?? process.env.LANTAGE_ANTHROPIC_VLM_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.disableThinking = opts.disableThinking ?? process.env.LANTAGE_VLM_THINKING !== 'on';
    this.maxLongEdgePx = opts.maxLongEdgePx;
    this.name = `anthropic:${this.model}`;
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
        timeoutMs: req.timeoutMs,
        maxTokens: DEFAULT_MAX_TOKENS,
        signal: req.signal,
      });
      if (!res.ok) {
        if (res.error.kind !== 'invalid-response' || attempt === 2) return res;
        continue;
      }

      const text = textOf(res.value);
      if (!text) {
        const reason = `The vision model returned no text content (stop_reason ${res.value.stop_reason ?? 'unknown'}).`;
        if (attempt === 2) return err(failure('invalid-response', reason));
        continue;
      }

      const parsed = parseCluePayload(text);
      if (!parsed.ok) {
        // 'no-input' is the model honestly declining to name a region. Retrying
        // that would be asking it to invent one.
        if (parsed.error.kind === 'no-input' || attempt === 2) return parsed;
        continue;
      }

      const usage = usageFor({
        vendor: this.vendor,
        model: res.value.model ?? this.model,
        tokens: {
          ...(res.value.usage?.input_tokens === undefined ? {} : { inputTokens: res.value.usage.input_tokens }),
          ...(res.value.usage?.output_tokens === undefined ? {} : { outputTokens: res.value.usage.output_tokens }),
          ...(res.value.usage?.cache_read_input_tokens == null
            ? {}
            : { cachedInputTokens: res.value.usage.cache_read_input_tokens }),
        },
      });

      const notes = [...image.notes, ...parsed.value.notes];
      if (res.value.stop_reason === 'max_tokens') {
        notes.push(
          'The response hit the output-token ceiling, so the clue list may be truncated. Treat an absent clue as unreported, not as absent from the frame.',
        );
      }

      return ok({
        clues: parsed.value.clues,
        modelVersion: res.value.model ?? this.model,
        attempts: attempt,
        usage,
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
      const prompt = buildJsonOnlyPrompt(req.prompt, attempt === 2);
      const res = await this.post({
        prompt,
        base64: image.base64,
        mediaType: image.mediaType,
        schema,
        timeoutMs: req.timeoutMs,
        maxTokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        signal: req.signal,
      });
      if (!res.ok) {
        if (res.error.kind !== 'invalid-response' || attempt === 2) return res;
        continue;
      }

      const text = textOf(res.value);
      if (!text) {
        const reason = `The vision model returned no text content (stop_reason ${res.value.stop_reason ?? 'unknown'}).`;
        if (attempt === 2) return err(failure('invalid-response', reason));
        continue;
      }

      const parsed = parseStructured(text, req.schema);
      if (!parsed.ok) {
        if (attempt === 2) return parsed;
        continue;
      }

      const notes = [...image.notes];
      if (!schema) {
        notes.push(
          'No vendor-side JSON Schema was supplied, so the shape was enforced only by the prompt and the caller\'s zod schema on the response.',
        );
      }

      return ok({
        value: parsed.value.value,
        raw: parsed.value.raw,
        modelVersion: res.value.model ?? this.model,
        attempts: attempt,
        usage: usageFor({
          vendor: this.vendor,
          model: res.value.model ?? this.model,
          tokens: {
            ...(res.value.usage?.input_tokens === undefined ? {} : { inputTokens: res.value.usage.input_tokens }),
            ...(res.value.usage?.output_tokens === undefined ? {} : { outputTokens: res.value.usage.output_tokens }),
            ...(res.value.usage?.cache_read_input_tokens == null
              ? {}
              : { cachedInputTokens: res.value.usage.cache_read_input_tokens }),
          },
        }),
        image: image.facts,
        notes,
      });
    }

    return err(failure('invalid-response', 'The vision model never returned a valid response.'));
  }

  private async prepare(
    bytes: Uint8Array | undefined,
    maxLongEdgePx: number | undefined,
  ): Promise<Result<PreparedImage, StageFailure>> {
    if (!this.apiKey) {
      return err(
        failure('not-configured', 'ANTHROPIC_API_KEY is not set, so no vision call was made.'),
      );
    }
    if (!bytes || bytes.byteLength === 0) {
      // The vendor accepts a URL source, but ours are local-disk paths it cannot
      // reach, so bytes are the only honest input.
      return err(failure('no-input', 'The vision call needs the image bytes and none were read.'));
    }
    const options = maxLongEdgePx ?? this.maxLongEdgePx;
    return prepareImage(bytes, options === undefined ? {} : { maxLongEdgePx: options });
  }

  private post(args: {
    prompt: string;
    base64: string;
    mediaType: string;
    schema: JsonSchemaObject | undefined;
    timeoutMs: number;
    maxTokens: number;
    signal: AbortSignal | undefined;
  }): Promise<Result<AnthropicMessage, StageFailure>> {
    const { prompt, base64, mediaType, schema, timeoutMs, maxTokens, signal } = args;
    return callVendorJson({
      url: `${this.baseUrl}/v1/messages`,
      headers: {
        'x-api-key': this.apiKey ?? '',
        'anthropic-version': API_VERSION,
      },
      body: {
        model: this.model,
        max_tokens: maxTokens,
        // Determinism matters more than variety: a result nobody can reproduce is
        // a result nobody can defend. Only legal with thinking off — the API
        // requires temperature 1 when extended thinking is enabled.
        ...(this.disableThinking ? { temperature: 0, thinking: { type: 'disabled' } } : {}),
        ...(schema
          ? {
              // Exactly the two documented fields. This API rejects unknown body
              // params, so `name` is deliberately absent here even though the
              // OpenAI equivalent requires it.
              output_config: { format: { type: 'json_schema', schema } },
            }
          : {}),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
      timeoutMs,
      schema: MessageSchema,
      ...(signal ? { signal } : {}),
      label: 'vision model (Anthropic)',
    });
  }
}

function textOf(message: AnthropicMessage): string {
  return (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}
