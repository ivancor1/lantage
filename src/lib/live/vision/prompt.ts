/**
 * Prompt assembly for the LIVE vision providers.
 *
 * `CLUE_EXTRACTION_PROMPT` is imported from the cascade and never rewritten
 * here: it is the load-bearing artefact that keeps the model enumerating
 * checkable observations instead of naming places. Everything in this file
 * *appends* to it.
 */

import { CLUE_EXTRACTION_PROMPT } from '@/lib/cascade/vlmProvider';

/**
 * Mirror of the cascade's private `REPAIR_SUFFIX`.
 *
 * It is `const`, not `export const`, in `src/lib/cascade/vlmProvider.ts`, and
 * that file is owned elsewhere — so the string is duplicated rather than the
 * module edited. Keep the two in sync; the retry semantics are the contract, not
 * the wording.
 */
export const REPAIR_SUFFIX =
  `\n\nYour previous response did not match the required JSON shape. Return ONLY the JSON object, no prose, no markdown fences, and include every required field.`;

/**
 * Asks the model to place the regions it named, for deployments with no
 * gazetteer.
 *
 * This is the only place the model is ever asked for a coordinate, and the
 * result is labelled `model-estimated` all the way to the screen. The wording
 * matters: an omitted region must be cheaper for the model than a guessed one,
 * because an unresolved region is a correct outcome and a hallucinated centroid
 * sends an investigator to the wrong county.
 */
export const REGION_COORDINATE_ADDENDUM = `

ADDITIONAL FIELD — no gazetteer is available in this deployment, so add exactly one more top-level key:
  "regionCoordinates": [{ "label": string, "lat": number, "lon": number, "radiusKm": number }]

One entry per "regionPrior" entry, using the same "label" string. Give the approximate centre of that named region and a radius in kilometres that honestly covers your uncertainty about it — tens of kilometres for a metro area, hundreds for a state or province. These are YOUR estimates from memory, not a gazetteer lookup, and they will be shown to the investigator labelled as such. If you cannot place a region on the globe, LEAVE IT OUT of this list: an unresolved region is reported as unresolved, which is the correct outcome, whereas a guessed centroid sends someone to the wrong place.`;

/**
 * The suffix that turns a caller's arbitrary prompt into a JSON-only prompt.
 * Used by `extractStructured` when no vendor-side schema is supplied, since then
 * the prompt is the only thing keeping prose out of the response.
 */
export const JSON_ONLY_SUFFIX = `\n\nReturn ONLY a single JSON object. No prose, no explanation, no markdown fences.`;

export interface CluePromptOptions {
  /** Full override — INTERIOR's indoor prompt, for example. */
  prompt?: string;
  promptSuffix?: string;
  requestRegionCoordinates?: boolean;
  /** Second attempt: append the repair instruction. */
  repair?: boolean;
}

export function buildCluePrompt(opts: CluePromptOptions = {}): string {
  let prompt = opts.prompt?.trim() ? opts.prompt.trim() : CLUE_EXTRACTION_PROMPT;
  if (opts.requestRegionCoordinates) prompt += REGION_COORDINATE_ADDENDUM;
  if (opts.promptSuffix?.trim()) prompt += `\n\n${opts.promptSuffix.trim()}`;
  if (opts.repair) prompt += REPAIR_SUFFIX;
  return prompt;
}

export function buildJsonOnlyPrompt(prompt: string, repair: boolean): string {
  let out = prompt.trim();
  if (!/ONLY.{0,20}JSON/i.test(out)) out += JSON_ONLY_SUFFIX;
  if (repair) out += REPAIR_SUFFIX;
  return out;
}
