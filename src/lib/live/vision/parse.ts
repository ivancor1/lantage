/**
 * Response parsing.
 *
 * `parseClues` and `scrubPlateCharacters` come from the cascade and do the real
 * work — the array caps, the `VlmCluesSchema` validation, and the plate-character
 * redaction that Mapillary ToS §12 requires as a *technical* safeguard rather
 * than an instruction. Nothing here reimplements any of that.
 *
 * What this file adds is the two-step the vendor JSON Schema forces on us:
 * nullable-optional fields come back as explicit `null`, and zod's `.optional()`
 * rejects `null`. So nulls are stripped, then the cascade's validator runs.
 */

import { z } from 'zod';
import type { VlmClues } from '@/lib/contracts/schemas';
import { parseClues, scrubPlateCharacters } from '@/lib/cascade/vlmProvider';
import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';
import type { ModelEstimatedRegion } from './types';

/** Markdown fences, which models still emit despite a JSON response format. */
function stripFences(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Drops keys whose value is `null`, and null elements inside arrays.
 *
 * This is not data cleaning — it is the inverse of the nullable-optional
 * encoding the vendor schema requires. A null here means "the model had nothing
 * for this field", which in the contract is expressed by the field's absence.
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(stripNulls);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[key] = stripNulls(v);
    }
    return out;
  }
  return value;
}

const RegionCoordinatesSchema = z.array(
  z.object({
    label: z.string().min(1),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    radiusKm: z.number().positive().optional(),
  }),
);

export interface ParsedCluePayload {
  clues: VlmClues;
  /** Present only when the model was asked for coordinates and gave usable ones. */
  regionCoordinates?: ModelEstimatedRegion[];
  /** Honest caveats produced while parsing. */
  notes: string[];
}

/**
 * Validate a raw model response into `VlmClues`.
 *
 * One case is singled out deliberately. `VlmCluesSchema` requires at least one
 * `regionPrior`, while the prompt tells the model to return few or none when the
 * frame has no usable signal — so "I can't tell" is, strictly, off-contract. That
 * is reported as `no-input` with the model's own reason rather than as a vendor
 * fault, because a model declining to guess is the correct outcome and the caller
 * needs to render it as such, not as a broken provider.
 */
export function parseCluePayload(text: string): Result<ParsedCluePayload, StageFailure> {
  const notes: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(text));
  } catch {
    // Hand the original text to the cascade's parser so the failure wording and
    // fence handling stay in one place.
    const fallback = parseClues(text);
    if (!fallback.ok) return fallback;
    return ok({ clues: scrubPlateCharacters(fallback.value), notes });
  }

  const stripped = stripNulls(raw);

  let regionCoordinates: ModelEstimatedRegion[] | undefined;
  if (typeof stripped === 'object' && stripped !== null && 'regionCoordinates' in stripped) {
    const candidate = (stripped as Record<string, unknown>).regionCoordinates;
    const parsed = RegionCoordinatesSchema.safeParse(candidate);
    if (parsed.success && parsed.data.length > 0) {
      regionCoordinates = parsed.data;
    } else if (candidate !== undefined) {
      notes.push(
        'The model returned a regionCoordinates block that did not validate as latitude/longitude pairs, so it was discarded rather than repaired.',
      );
    }
  }

  const validated = parseClues(JSON.stringify(stripped));
  if (!validated.ok) {
    if (declinedToGuess(stripped)) {
      return err(
        failure(
          'no-input',
          'The vision model reported insufficient signal in the frame and named no region it could support. That is a valid answer, not an error: nothing was ranked and nothing was invented.',
        ),
      );
    }
    return validated;
  }

  return ok({
    clues: scrubPlateCharacters(validated.value),
    ...(regionCoordinates ? { regionCoordinates } : {}),
    notes,
  });
}

/** `insufficientSignal: true` with an empty region list. */
function declinedToGuess(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const bag = value as Record<string, unknown>;
  const priors = bag.regionPrior;
  const empty = priors === undefined || (Array.isArray(priors) && priors.length === 0);
  return bag.insufficientSignal === true && empty;
}

/** Generic validation for `extractStructured`. */
export function parseStructured<T>(
  text: string,
  schema: z.ZodType<T>,
): Result<{ value: T; raw: string }, StageFailure> {
  const cleaned = stripFences(text);
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return err(failure('invalid-response', 'the vision model did not return parseable JSON.'));
  }
  const parsed = schema.safeParse(stripNulls(raw));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return err(failure('invalid-response', `the vision model's response was off-contract: ${detail}`));
  }
  return ok({ value: parsed.data, raw: cleaned });
}
