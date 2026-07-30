/**
 * Vendor-side JSON Schema, hand-written against the vendor rules.
 *
 * Why hand-written rather than derived from `VlmCluesSchema`: both vendors
 * reject most of what a zod-to-JSON-Schema conversion emits. Verified against
 * the current docs (fetched 2026-07-30):
 *
 *   - `additionalProperties: false` is MANDATORY on every object (both vendors).
 *   - every non-nullable property must be listed in `required` (both vendors).
 *     An optional field is expressed as `anyOf: [T, {type:'null'}]`, which is the
 *     pattern both vendors document.
 *   - Anthropic rejects `minimum`/`maximum`/`minLength`/`maxLength` and array
 *     constraints beyond `minItems: 0|1`; OpenAI rejects `allOf`/`not`/`if`.
 *
 * So the vendor schema deliberately carries *no* bounds. `VlmCluesSchema` is
 * still the contract — it runs on the response, where the bounds are enforced
 * for real. The vendor schema's only job is to stop the model emitting prose or
 * inventing key names.
 *
 * Consequence handled in `parse.ts`: nullable-optional means the model returns
 * `"bbox": null`, and zod's `.optional()` rejects an explicit null. Nulls are
 * stripped before validation.
 */

import type { JsonSchemaObject } from './types';

const LEGIBILITY = ['clear', 'partial', 'guessed'] as const;

function nullable(schema: JsonSchemaObject): JsonSchemaObject {
  return { anyOf: [schema, { type: 'null' }] };
}

/** Normalised 0..1 box. No `minItems`/`maxItems`: zod's tuple enforces length 4. */
const BBOX: JsonSchemaObject = { type: 'array', items: { type: 'number' } };

function clueObject(
  kinds: readonly string[],
  extra: Record<string, JsonSchemaObject>,
): JsonSchemaObject {
  const properties: Record<string, JsonSchemaObject> = {
    observed: { type: 'string' },
    legibility: { type: 'string', enum: [...LEGIBILITY] },
    bbox: nullable(BBOX),
    kind: { type: 'string', enum: [...kinds] },
    ...extra,
  };
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const IMPLIES_REGIONS: JsonSchemaObject = { type: 'array', items: { type: 'string' } };

const TEXT_CLUE = clueObject(
  [
    'business-name',
    'street-sign',
    'address-number',
    'transit-sign',
    'phone-number',
    'license-plate-region',
    'other',
  ],
  { script: nullable({ type: 'string' }) },
);

const INFRASTRUCTURE_CLUE = clueObject(
  [
    'driving-side',
    'road-marking',
    'utility-pole',
    'bollard',
    'traffic-light',
    'curb-style',
    'guardrail',
    'fire-hydrant',
    'manhole',
  ],
  { impliesRegions: IMPLIES_REGIONS },
);

const ENVIRONMENT_CLUE = clueObject(['vegetation', 'soil', 'terrain', 'sky', 'snow', 'water'], {
  impliesRegions: IMPLIES_REGIONS,
});

const ARCHITECTURE_CLUE = clueObject(
  [
    'building-material',
    'roof-style',
    'window-style',
    'row-house',
    'bridge',
    'stair-street',
    'signage-style',
  ],
  { impliesRegions: IMPLIES_REGIONS },
);

const SOLAR: JsonSchemaObject = {
  type: 'object',
  properties: {
    shadowsVisible: { type: 'boolean' },
    shadowAzimuthDeg: nullable({ type: 'number' }),
    shadowToHeightRatio: nullable({ type: 'number' }),
    estimatedTimeOfDay: {
      type: 'string',
      enum: ['dawn', 'morning', 'midday', 'afternoon', 'dusk', 'night', 'unknown'],
    },
  },
  required: ['shadowsVisible', 'shadowAzimuthDeg', 'shadowToHeightRatio', 'estimatedTimeOfDay'],
  additionalProperties: false,
};

const REGION_PRIOR: JsonSchemaObject = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    country: nullable({ type: 'string' }),
    admin1: nullable({ type: 'string' }),
    rawConfidence: { type: 'number' },
    supportedBy: { type: 'array', items: { type: 'string' } },
  },
  required: ['label', 'country', 'admin1', 'rawConfidence', 'supportedBy'],
  additionalProperties: false,
};

const REGION_COORDINATE: JsonSchemaObject = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    lat: { type: 'number' },
    lon: { type: 'number' },
    radiusKm: nullable({ type: 'number' }),
  },
  required: ['label', 'lat', 'lon', 'radiusKm'],
  additionalProperties: false,
};

/** Name handed to vendors that require one for the schema. */
export const CLUES_SCHEMA_NAME = 'lantage_visual_clues';

export function vlmCluesJsonSchema(withRegionCoordinates = false): JsonSchemaObject {
  const properties: Record<string, JsonSchemaObject> = {
    text: { type: 'array', items: TEXT_CLUE },
    infrastructure: { type: 'array', items: INFRASTRUCTURE_CLUE },
    environment: { type: 'array', items: ENVIRONMENT_CLUE },
    architecture: { type: 'array', items: ARCHITECTURE_CLUE },
    solar: nullable(SOLAR),
    regionPrior: { type: 'array', items: REGION_PRIOR },
    insufficientSignal: { type: 'boolean' },
  };
  if (withRegionCoordinates) {
    properties.regionCoordinates = { type: 'array', items: REGION_COORDINATE };
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------
// Sanitiser for caller-supplied schemas
// ---------------------------------------------------------------------------

/**
 * Keywords both vendors reject or ignore. Dropped rather than passed through,
 * because a rejected schema is an HTTP 400 the operator has to debug.
 */
const UNSUPPORTED_KEYWORDS: readonly string[] = [
  '$schema',
  '$id',
  '$comment',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'examples',
];

/**
 * Makes a caller's JSON Schema acceptable to both vendors: strips the keywords
 * they reject, forces `additionalProperties: false`, and lists every property as
 * required.
 *
 * Note what that last rule means: a property you intended to be optional becomes
 * required. Express optionality as a union with null (`anyOf: [T, {type:'null'}]`)
 * and strip the nulls before your zod validation — that is what the clue schema
 * above does. The bounds this drops are not lost; they are enforced by the zod
 * schema on the response, which is the only validation that was ever binding.
 */
export function sanitiseVendorJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const out = walk(schema);
  return isRecord(out) ? out : { type: 'object', properties: {}, required: [], additionalProperties: false };
}

function walk(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(walk);
  if (!isRecord(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) continue;
    if (key === 'minItems') {
      // Anthropic supports only 0 or 1.
      if (value === 0 || value === 1) out[key] = value;
      continue;
    }
    out[key] = walk(value);
  }

  const properties = out.properties;
  if (isRecord(properties)) {
    out.additionalProperties = false;
    out.required = Object.keys(properties);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
