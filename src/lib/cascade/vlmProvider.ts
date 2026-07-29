/**
 * The vision-model boundary.
 *
 * Two rules, both load-bearing:
 *
 * 1. **The model is never asked "where is this?"** It is asked to enumerate
 *    discrete, individually checkable observations against `VlmCluesSchema`.
 *    The ACL 2026 GeoRC study found frontier models "couldn't provide reasoning
 *    for their guesses or were vague", with experts identifying "many suspicious
 *    or hallucinated attributes" — the model recognises a place and then
 *    fabricates the evidence. A structured clue list makes that failure visible.
 *
 * 2. **Never a reasoning-heavy model in the hot path.** o3/Opus-high class models
 *    run 15-60s and blow a 10s budget on their own. This is a Gemini 3 Flash
 *    class slot (~$2.25/1k) and the interface exists so the provider can be
 *    swapped without any stage learning a vendor's request shape.
 */

import { z } from 'zod';
import { VlmCluesSchema, type VlmClues } from '@/lib/contracts/schemas';
import { ENDPOINTS, MODEL_VERSIONS } from './config';
import { callJson } from './net';
import { type ImageRef, type Result, type StageFailure, err, failure, ok } from './types';

export interface VlmRequest {
  image: ImageRef;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface VlmResult {
  clues: VlmClues;
  /** Model identifier for `ResultProvenance.models`. */
  modelVersion: string;
  /** Number of provider round-trips, including schema-repair retries. */
  attempts: number;
}

export interface VlmProvider {
  readonly name: string;
  extractClues(req: VlmRequest): Promise<Result<VlmResult, StageFailure>>;
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * Note what this prompt does NOT contain: any request for a location, address,
 * coordinate, or "best guess". `regionPrior` is asked for last, is capped at 5
 * entries, must cite the observations that support it, and downstream is used
 * only to select the retrieval submap.
 */
export const CLUE_EXTRACTION_PROMPT = `You are a forensic image analyst producing an evidence list for a human investigator who will independently verify every line you write.

Your job is to ENUMERATE WHAT IS VISIBLE. It is not to identify the location. A named place with no visible support is worse than no answer, because a human will waste hours checking it.

Rules:
1. "observed" contains only what is literally visible — verbatim text, the shape of a thing, a colour. No inference, no place names, no interpretation.
2. "legibility" describes how clearly you SEE the thing, not how confident you are in what it means: "clear" = unambiguous, "partial" = occluded/blurred but readable, "guessed" = you are reconstructing it.
3. "bbox" is [x0, y0, x1, y1] normalised to 0..1 with the origin at the TOP-LEFT of the frame. Include it whenever you can localise the observation, so the investigator can look at the same pixels you did.
4. NEVER transcribe licence-plate characters, and never guess them. For plates, describe only the jurisdiction STYLE — plate proportions, colour bands, slogan placement, mounting. The characters are prohibited output.
5. Read every piece of text you can, even partial words. Legible text is the single highest-value observation in this task.
6. "impliesRegions" lists regions a convention is consistent with. It is allowed to be wrong — that is why it is cited separately from the observation.
7. If the frame does not contain enough signal to constrain a region, set "insufficientSignal": true and return few or no region priors. "I cannot tell" is a useful and correct answer here.
8. "regionPrior" comes last and every entry's "supportedBy" must quote observations you actually listed above. Do not include a region you cannot support.

Return ONLY JSON matching this shape:
{
  "text": [{ "observed": string, "legibility": "clear"|"partial"|"guessed", "bbox"?: [number,number,number,number], "kind": "business-name"|"street-sign"|"address-number"|"transit-sign"|"phone-number"|"license-plate-region"|"other", "script"?: string }],
  "infrastructure": [{ "observed": string, "legibility": ..., "bbox"?: ..., "kind": "driving-side"|"road-marking"|"utility-pole"|"bollard"|"traffic-light"|"curb-style"|"guardrail"|"fire-hydrant"|"manhole", "impliesRegions": string[] }],
  "environment": [{ "observed": string, "legibility": ..., "bbox"?: ..., "kind": "vegetation"|"soil"|"terrain"|"sky"|"snow"|"water", "impliesRegions": string[] }],
  "architecture": [{ "observed": string, "legibility": ..., "bbox"?: ..., "kind": "building-material"|"roof-style"|"window-style"|"row-house"|"bridge"|"stair-street"|"signage-style", "impliesRegions": string[] }],
  "solar": { "shadowsVisible": boolean, "shadowAzimuthDeg"?: number, "shadowToHeightRatio"?: number, "estimatedTimeOfDay": "dawn"|"morning"|"midday"|"afternoon"|"dusk"|"night"|"unknown" },
  "regionPrior": [{ "label": string, "country"?: string, "admin1"?: string, "rawConfidence": number, "supportedBy": string[] }],
  "insufficientSignal": boolean
}`;

const REPAIR_SUFFIX = `\n\nYour previous response did not match the required JSON shape. Return ONLY the JSON object, no prose, no markdown fences, and include every required field.`;

// ---------------------------------------------------------------------------
// Gemini-class provider
// ---------------------------------------------------------------------------

const GeminiEnvelopeSchema = z.object({
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
});

export class GeminiFlashVlmProvider implements VlmProvider {
  readonly name: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(
    apiKey: string | undefined = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    model: string = MODEL_VERSIONS.vlm,
    baseUrl: string = ENDPOINTS.vlm,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.name = `gemini:${model}`;
  }

  async extractClues(req: VlmRequest): Promise<Result<VlmResult, StageFailure>> {
    if (!this.apiKey) {
      return err(
        failure(
          'not-configured',
          'No vision-model API key configured, so clue extraction was skipped. The cascade continued on the embedding prior alone.',
        ),
      );
    }
    if (!req.image.bytes) {
      // Gemini takes inline bytes or a Files API handle; a signed URL from our
      // storage is not fetchable by the provider.
      return err(failure('no-input', 'Clue extraction needs the image bytes and none were read.'));
    }

    const base64 = Buffer.from(req.image.bytes).toString('base64');
    const mimeType = req.image.mimeType ?? 'image/jpeg';
    const url = `${this.baseUrl.replace(/\/$/, '')}/models/${this.model}:generateContent`;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const res = await callJson({
        url,
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey },
        body: {
          contents: [
            {
              role: 'user',
              parts: [
                { text: attempt === 1 ? CLUE_EXTRACTION_PROMPT : CLUE_EXTRACTION_PROMPT + REPAIR_SUFFIX },
                { inline_data: { mime_type: mimeType, data: base64 } },
              ],
            },
          ],
          generationConfig: {
            // Low temperature: we want the same clues for the same pixels, because
            // a result nobody can reproduce is a result nobody can defend.
            temperature: 0.1,
            responseMimeType: 'application/json',
            maxOutputTokens: 4096,
          },
        },
        timeoutMs: req.timeoutMs,
        schema: GeminiEnvelopeSchema,
        signal: req.signal,
        label: 'vision model',
      });

      if (!res.ok) {
        // Transport and timeout failures are not worth a retry inside a 10s budget.
        if (res.error.kind !== 'invalid-response') return res;
        if (attempt === 2) return res;
        continue;
      }

      const blocked = res.value.promptFeedback?.blockReason;
      if (blocked) {
        return err(
          failure('invalid-response', `The vision model declined the image (${blocked}).`),
        );
      }

      const text = res.value.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? '')
        .join('')
        .trim();
      const finish = res.value.candidates?.[0]?.finishReason;

      if (!text) {
        if (attempt === 2) {
          return err(
            failure(
              'invalid-response',
              `The vision model returned no content${finish ? ` (finishReason ${finish})` : ''}.`,
            ),
          );
        }
        continue;
      }

      const parsed = parseClues(text);
      if (parsed.ok) {
        return ok({
          clues: scrubPlateCharacters(parsed.value),
          modelVersion: `${this.model}`,
          attempts: attempt,
        });
      }
      if (attempt === 2) return parsed;
    }

    return err(failure('invalid-response', 'The vision model never returned a valid clue list.'));
  }
}

// ---------------------------------------------------------------------------
// Parsing + safety scrub
// ---------------------------------------------------------------------------

/** Strip markdown fences some models still emit despite a JSON response type. */
function stripFences(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Validate against the contract, with array caps applied *before* validation.
 *
 * A model that returns 24 useful text clues when the cap is 20 should not cost us
 * a second round-trip inside a latency budget — truncating is lossless in the
 * only direction that matters (we keep the earliest, and the model is instructed
 * to lead with what is legible).
 */
export function parseClues(text: string): Result<VlmClues, StageFailure> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(text));
  } catch {
    return err(failure('invalid-response', 'The vision model did not return parseable JSON.'));
  }

  const capped = capArrays(raw);
  const parsed = VlmCluesSchema.safeParse(capped);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return err(
      failure('invalid-response', `The vision model's clue list was off-contract: ${detail}`),
    );
  }
  return ok(parsed.data);
}

const CAPS: Record<string, number> = {
  text: 20,
  infrastructure: 20,
  environment: 12,
  architecture: 15,
  regionPrior: 5,
};

function capArrays(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  for (const [key, cap] of Object.entries(CAPS)) {
    const value = obj[key];
    if (Array.isArray(value) && value.length > cap) obj[key] = value.slice(0, cap);
  }
  // impliesRegions has its own cap per clue.
  for (const key of ['infrastructure', 'environment', 'architecture']) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    obj[key] = value.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const clue = { ...(entry as Record<string, unknown>) };
      if (Array.isArray(clue.impliesRegions) && clue.impliesRegions.length > 10) {
        clue.impliesRegions = clue.impliesRegions.slice(0, 10);
      }
      return clue;
    });
  }
  return obj;
}

/**
 * Belt-and-braces enforcement of the no-plate-characters rule.
 *
 * The prompt forbids transcribing plates, but Mapillary ToS §12 requires
 * *technical safeguards*, not just instructions — and this string is about to be
 * persisted in an audit record we can never edit. Anything plate-shaped inside a
 * `license-plate-region` clue is redacted before it can be stored or logged.
 */
export function scrubPlateCharacters(clues: VlmClues): VlmClues {
  const scrubbed = clues.text.map((clue) => {
    if (clue.kind !== 'license-plate-region') return clue;
    const observed = clue.observed
      .replace(/[A-Z0-9]{2,}(?:[-\s][A-Z0-9]{2,})*/g, '[plate characters redacted]')
      .replace(/\d{2,}/g, '[redacted]');
    return { ...clue, observed };
  });
  return { ...clues, text: scrubbed };
}
