/**
 * Vision-boundary tests.
 *
 *   node --test src/lib/live/vision/vision.test.ts
 *
 * These cover the three things that are silently wrong if they break: the vendor
 * JSON Schema rules (a violation is an HTTP 400 nobody can read), the null
 * handling the nullable-optional encoding forces, and the cost rule — a price we
 * do not know must produce NO number rather than a plausible one.
 *
 * No network. See `@/lib/cascade/testing/aliasHooks` for the loader shim.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as AliasHooks from '@/lib/cascade/testing/aliasHooks';
import type * as JsonSchemaModule from './jsonSchema';
import type * as ParseModule from './parse';
import type * as PricingModule from './pricing';
import type * as IndexModule from './index';
import type * as AnthropicModule from './anthropic';
import type * as OpenAiModule from './openai';
import type * as AdaptersModule from './adapters';
import type { JsonSchemaObject } from './types';

// Relative, and loaded first: the hooks are what teach Node about `@/`, so this
// one specifier cannot itself use the alias.
const hooksSpecifier = '../../cascade/testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();

// Variable specifiers: the repo's tsconfig does not enable
// `allowImportingTsExtensions`, and Node's loader needs the extension. Both halves
// stay type-checked through the sibling `import type`s above.
const jsonSchemaSpecifier = './jsonSchema.ts';
const parseSpecifier = './parse.ts';
const pricingSpecifier = './pricing.ts';
const indexSpecifier = './index.ts';
const anthropicSpecifier = './anthropic.ts';
const openaiSpecifier = './openai.ts';
const adaptersSpecifier = './adapters.ts';

const { sanitiseVendorJsonSchema, vlmCluesJsonSchema } = (await import(
  jsonSchemaSpecifier
)) as typeof JsonSchemaModule;
const { parseCluePayload, parseStructured, stripNulls } = (await import(
  parseSpecifier
)) as typeof ParseModule;
const { priceFor, sumCostUsd, usageFor } = (await import(pricingSpecifier)) as typeof PricingModule;
const { selectProvider, selectedVendor } = (await import(indexSpecifier)) as typeof IndexModule;

// ---------------------------------------------------------------------------
// Vendor JSON Schema rules
// ---------------------------------------------------------------------------

interface SchemaProblem {
  path: string;
  problem: string;
}

/** Both vendors: every object needs additionalProperties:false and full required. */
function auditSchema(node: unknown, at = '<root>', out: SchemaProblem[] = []): SchemaProblem[] {
  if (Array.isArray(node)) {
    node.forEach((entry, i) => auditSchema(entry, `${at}[${i}]`, out));
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const bag = node as Record<string, unknown>;

  if (bag.type === 'object' || bag.properties !== undefined) {
    const properties = bag.properties;
    if (typeof properties !== 'object' || properties === null) {
      out.push({ path: at, problem: 'object without properties' });
    } else {
      if (bag.additionalProperties !== false) {
        out.push({ path: at, problem: 'additionalProperties is not false' });
      }
      const names = Object.keys(properties as Record<string, unknown>);
      const required = Array.isArray(bag.required) ? bag.required : [];
      for (const name of names) {
        if (!required.includes(name)) {
          out.push({ path: at, problem: `"${name}" is not in required` });
        }
      }
    }
  }

  for (const forbidden of ['minLength', 'maxLength', 'minimum', 'maximum', 'maxItems', 'allOf', 'not']) {
    if (forbidden in bag) out.push({ path: at, problem: `unsupported keyword ${forbidden}` });
  }
  if ('minItems' in bag && bag.minItems !== 0 && bag.minItems !== 1) {
    out.push({ path: at, problem: 'minItems must be 0 or 1' });
  }

  for (const [key, value] of Object.entries(bag)) {
    if (key === 'required' || key === 'enum') continue;
    auditSchema(value, `${at}.${key}`, out);
  }
  return out;
}

test('the clue schema obeys both vendors JSON Schema rules', () => {
  const problems = auditSchema(vlmCluesJsonSchema());
  assert.deepEqual(problems, [], `schema violations: ${JSON.stringify(problems)}`);
});

test('the coordinate variant adds regionCoordinates and stays legal', () => {
  const schema = vlmCluesJsonSchema(true);
  const properties = schema.properties as Record<string, unknown>;
  assert.ok('regionCoordinates' in properties);
  assert.deepEqual(auditSchema(schema), []);
  // And the default does NOT ask for coordinates: that is opt-in, because asking
  // a model for a coordinate is the failure mode the clue schema exists to avoid.
  assert.ok(!('regionCoordinates' in (vlmCluesJsonSchema().properties as object)));
});

test('sanitiser strips unsupported keywords and forces the vendor rules', () => {
  const input: JsonSchemaObject = {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      make: { type: 'string', minLength: 1, maxLength: 40 },
      year: { type: 'number', minimum: 1900, maximum: 2030 },
      colors: { type: 'array', items: { type: 'string' }, maxItems: 5, minItems: 2 },
    },
    required: ['make'],
  };
  const out = sanitiseVendorJsonSchema(input);
  assert.deepEqual(auditSchema(out), []);
  assert.equal(out.$schema, undefined);
  const properties = out.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.make.minLength, undefined);
  assert.equal(properties.year.minimum, undefined);
  assert.equal(properties.colors.maxItems, undefined);
  assert.equal(properties.colors.minItems, undefined, 'minItems 2 is not expressible');
  assert.deepEqual(out.required, ['make', 'year', 'colors']);
});

// ---------------------------------------------------------------------------
// Null handling + parsing
// ---------------------------------------------------------------------------

test('stripNulls turns the nullable-optional encoding back into absence', () => {
  const out = stripNulls({ a: 1, b: null, c: { d: null, e: 2 }, f: [1, null, 3] });
  assert.deepEqual(out, { a: 1, c: { e: 2 }, f: [1, 3] });
});

function cluePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: [
      {
        observed: 'FRICK PARK',
        legibility: 'clear',
        bbox: [0.1, 0.2, 0.3, 0.25],
        kind: 'street-sign',
        script: null,
      },
    ],
    infrastructure: [],
    environment: [],
    architecture: [],
    solar: null,
    regionPrior: [
      {
        label: 'Pittsburgh',
        country: 'United States',
        admin1: null,
        rawConfidence: 0.6,
        supportedBy: ['FRICK PARK'],
      },
    ],
    insufficientSignal: false,
    ...overrides,
  };
}

test('a payload full of explicit nulls validates against the clue contract', () => {
  const res = parseCluePayload(JSON.stringify(cluePayload()));
  assert.ok(res.ok, res.ok ? '' : res.error.reason);
  assert.equal(res.value.clues.text[0].script, undefined);
  assert.equal(res.value.clues.text[0].bbox?.length, 4);
  assert.equal(res.value.clues.regionPrior[0].admin1, undefined);
  assert.equal(res.value.clues.solar, undefined);
});

test('markdown fences are tolerated', () => {
  const res = parseCluePayload('```json\n' + JSON.stringify(cluePayload()) + '\n```');
  assert.ok(res.ok);
});

test('plate characters are scrubbed even when the model ignores the instruction', () => {
  const payload = cluePayload({
    text: [
      {
        observed: 'yellow plate reading ABC 1234',
        legibility: 'clear',
        bbox: null,
        kind: 'license-plate-region',
        script: null,
      },
    ],
    regionPrior: [
      { label: 'New York', country: 'US', admin1: null, rawConfidence: 0.4, supportedBy: ['yellow plate'] },
    ],
  });
  const res = parseCluePayload(JSON.stringify(payload));
  assert.ok(res.ok);
  const observed = res.value.clues.text[0].observed;
  assert.ok(!/ABC/.test(observed), `plate characters survived: ${observed}`);
  assert.ok(!/1234/.test(observed), `plate digits survived: ${observed}`);
});

test('"I cannot tell" is reported as no-input, not as a broken provider', () => {
  const res = parseCluePayload(
    JSON.stringify(cluePayload({ regionPrior: [], insufficientSignal: true })),
  );
  assert.ok(!res.ok);
  assert.equal(res.error.kind, 'no-input');
  assert.match(res.error.reason, /insufficient signal/i);
  assert.match(res.error.reason, /valid answer/i);
});

test('an off-contract payload is a schema mismatch, which triggers the repair retry', () => {
  const res = parseCluePayload(JSON.stringify(cluePayload({ text: 'not an array' })));
  assert.ok(!res.ok);
  assert.equal(res.error.kind, 'invalid-response');
});

test('model-estimated coordinates are only accepted when they are real coordinates', () => {
  const good = parseCluePayload(
    JSON.stringify(
      cluePayload({ regionCoordinates: [{ label: 'Pittsburgh', lat: 40.44, lon: -79.99, radiusKm: 30 }] }),
    ),
  );
  assert.ok(good.ok);
  assert.equal(good.value.regionCoordinates?.[0].lat, 40.44);

  const bad = parseCluePayload(
    JSON.stringify(cluePayload({ regionCoordinates: [{ label: 'Nowhere', lat: 999, lon: 0 }] })),
  );
  assert.ok(bad.ok);
  assert.equal(bad.value.regionCoordinates, undefined, 'an impossible latitude must be discarded');
  assert.match(bad.value.notes.join(' '), /discarded/i);
});

test('parseStructured validates with the callers schema and reports the field that failed', async () => {
  const { z } = await import('zod');
  const schema = z.object({ make: z.string(), year: z.number().int() });
  const ok = parseStructured('{"make":"Ford","year":2014}', schema);
  assert.ok(ok.ok);
  assert.equal(ok.value.value.make, 'Ford');

  const bad = parseStructured('{"make":"Ford","year":"twenty fourteen"}', schema);
  assert.ok(!bad.ok);
  assert.match(bad.error.reason, /year/);
});

// ---------------------------------------------------------------------------
// Cost honesty — the rule the operator is testing for
// ---------------------------------------------------------------------------

test('a known model plus real tokens produces a real cost', () => {
  const usage = usageFor({
    vendor: 'anthropic',
    model: 'claude-sonnet-5',
    tokens: { inputTokens: 2_000, outputTokens: 1_000 },
  });
  // 2000 in at $3/MTok + 1000 out at $15/MTok
  assert.equal(usage.costUsd, (2_000 / 1e6) * 3 + (1_000 / 1e6) * 15);
  assert.match(usage.costBasis, /per MTok/);
});

test('an unknown model omits costUsd rather than borrowing a price', () => {
  const usage = usageFor({
    vendor: 'openai',
    model: 'gpt-9-imaginary',
    tokens: { inputTokens: 5_000, outputTokens: 500 },
  });
  assert.equal(usage.costUsd, undefined);
  assert.equal(usage.inputTokens, 5_000, 'real token counts are still reported');
  assert.match(usage.costBasis, /no published price/i);
});

test('no usage block means no cost, not a zero cost', () => {
  const usage = usageFor({ vendor: 'anthropic', model: 'claude-sonnet-5', tokens: {} });
  assert.equal(usage.costUsd, undefined);
  assert.match(usage.costBasis, /no token usage/i);
});

test('cached input is priced correctly for each vendors accounting', () => {
  // OpenAI: input_tokens INCLUDES cached_tokens.
  const openai = usageFor({
    vendor: 'openai',
    model: 'gpt-5.5',
    tokens: { inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 0 },
  });
  assert.equal(openai.costUsd, (200 / 1e6) * 5 + (800 / 1e6) * 0.5);

  // Anthropic: cache reads are a separate bucket from input_tokens.
  const anthropic = usageFor({
    vendor: 'anthropic',
    model: 'claude-sonnet-5',
    tokens: { inputTokens: 200, cachedInputTokens: 800, outputTokens: 0 },
  });
  const expected = (200 / 1e6) * 3 + (800 / 1e6) * 0.3;
  assert.ok(
    Math.abs((anthropic.costUsd ?? 0) - expected) < 1e-12,
    `${anthropic.costUsd} !== ${expected}`,
  );
});

test('snapshot ids resolve to their family price by longest prefix', () => {
  assert.equal(priceFor('anthropic', 'claude-sonnet-5-20260115')?.inputPerMTok, 3);
  assert.equal(priceFor('anthropic', 'claude-opus-5')?.outputPerMTok, 25);
  assert.equal(priceFor('gemini', 'gemini-3-flash'), null, 'gemini is priced per call, not per token');
});

test('summing costs skips unknowns instead of counting them as zero-dollar facts', () => {
  assert.equal(sumCostUsd([0.01, undefined, 0.02]), 0.03);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('selectProvider returns null when no key is configured', () => {
  assert.equal(selectProvider({}), null);
  assert.equal(selectedVendor({}), null);
});

test('selection follows the contracts documented priority order', () => {
  const anthropic = selectProvider({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' });
  assert.equal(anthropic?.vendor, 'anthropic');
  assert.match(anthropic?.name ?? '', /^anthropic:claude-/);

  const openai = selectProvider({ OPENAI_API_KEY: 'k' });
  assert.equal(openai?.vendor, 'openai');
  assert.match(openai?.name ?? '', /^openai:gpt-/);

  const gemini = selectProvider({ GOOGLE_API_KEY: 'k' });
  assert.equal(gemini?.vendor, 'gemini');
  // INTERIOR keys its cost model off /gemini/i in the provider name.
  assert.match(gemini?.name ?? '', /gemini/);
});

test('a model override is honoured, since a default is not a policy', () => {
  const provider = selectProvider({ ANTHROPIC_API_KEY: 'k', LANTAGE_ANTHROPIC_VLM_MODEL: 'claude-opus-5' });
  assert.equal(provider?.model, 'claude-opus-5');
});

test('providers refuse to call out with no key and never throw', async () => {
  const { AnthropicVisionProvider } = (await import(anthropicSpecifier)) as typeof AnthropicModule;
  const provider = new AnthropicVisionProvider({ apiKey: undefined });
  const res = await provider.extractClues({
    image: { imageId: 'x', bytes: new Uint8Array([1, 2, 3]) },
    timeoutMs: 1_000,
  });
  assert.ok(!res.ok);
  assert.equal(res.error.kind, 'not-configured');
});

test('a provider with a key but no bytes fails typed rather than sending nothing', async () => {
  const { OpenAiVisionProvider } = (await import(openaiSpecifier)) as typeof OpenAiModule;
  const provider = new OpenAiVisionProvider({ apiKey: 'k' });
  const res = await provider.extractClues({ image: { imageId: 'x' }, timeoutMs: 1_000 });
  assert.ok(!res.ok);
  assert.equal(res.error.kind, 'no-input');
});

// ---------------------------------------------------------------------------
// The wire format
//
// These are the assertions that catch the failure this module was most likely to
// ship with: a request body written from training data rather than from the
// current docs. `fetch` is stubbed, so no key and no network are involved — what
// is being checked is the exact JSON that would go out.
// ---------------------------------------------------------------------------

/** A small PNG: under every long-edge cap, so it passes through unmodified. */
function smallPng(): Uint8Array {
  const bytes = new Uint8Array(4_096);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  // 800x600
  bytes.set([0x00, 0x00, 0x03, 0x20], 16);
  bytes.set([0x00, 0x00, 0x02, 0x58], 20);
  return bytes;
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Replaces `fetch`, records every request, and replays canned bodies in order. */
async function withStubbedFetch<T>(
  responses: unknown[],
  run: (captured: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    captured.push({
      url: String(url),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const payload = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  try {
    return await run(captured);
  } finally {
    globalThis.fetch = original;
  }
}

test('the Anthropic request matches the documented Messages API shape', async () => {
  const { AnthropicVisionProvider } = (await import(anthropicSpecifier)) as typeof AnthropicModule;
  const provider = new AnthropicVisionProvider({ apiKey: 'test-key', model: 'claude-sonnet-5' });

  const result = await withStubbedFetch(
    [
      {
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(cluePayload()) }],
        usage: { input_tokens: 2_000, output_tokens: 1_000 },
      },
    ],
    async (captured) => {
      const res = await provider.extractClues({
        image: { imageId: 'img_1', bytes: smallPng(), mimeType: 'image/png' },
        timeoutMs: 5_000,
      });
      return { res, captured };
    },
  );

  assert.ok(result.res.ok, result.res.ok ? '' : result.res.error.reason);
  assert.equal(result.captured.length, 1, 'a valid first response must not be retried');

  const req = result.captured[0];
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'test-key');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(
    req.headers.authorization,
    undefined,
    'this API authenticates with x-api-key, not a bearer token',
  );

  const messages = req.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(messages[0].role, 'user');
  // Image before text: the doc is explicit that this ordering performs better.
  assert.equal(messages[0].content[0].type, 'image');
  assert.equal(messages[0].content[1].type, 'text');
  const source = messages[0].content[0].source as Record<string, unknown>;
  assert.equal(source.type, 'base64');
  assert.equal(source.media_type, 'image/png');
  assert.match(String(source.data), /^[A-Za-z0-9+/=]+$/, 'raw base64, not a data URL');

  const format = (req.body.output_config as Record<string, Record<string, unknown>>).format;
  assert.equal(format.type, 'json_schema');
  assert.ok(format.schema, 'the schema must be sent, not just requested in prose');
  assert.equal(format.name, undefined, 'this API rejects unknown body params');
  assert.equal(format.strict, undefined);
  assert.deepEqual(req.body.thinking, { type: 'disabled' });
  assert.equal(req.body.temperature, 0);
  assert.ok(typeof req.body.max_tokens === 'number');

  // Cost is arithmetic on the tokens the vendor reported.
  assert.equal(result.res.value.usage.inputTokens, 2_000);
  assert.equal(result.res.value.usage.costUsd, (2_000 / 1e6) * 3 + (1_000 / 1e6) * 15);
  assert.equal(result.res.value.image.scale, 1);
  assert.equal(result.res.value.image.method, 'passthrough');
});

test('the OpenAI request matches the documented Responses API shape', async () => {
  const { OpenAiVisionProvider } = (await import(openaiSpecifier)) as typeof OpenAiModule;
  const provider = new OpenAiVisionProvider({ apiKey: 'test-key', model: 'gpt-5.5' });

  const result = await withStubbedFetch(
    [
      {
        model: 'gpt-5.5',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(cluePayload()) }],
          },
        ],
        usage: { input_tokens: 3_000, output_tokens: 500, input_tokens_details: { cached_tokens: 0 } },
      },
    ],
    async (captured) => {
      const res = await provider.extractClues({
        image: { imageId: 'img_2', bytes: smallPng(), mimeType: 'image/png' },
        timeoutMs: 5_000,
      });
      return { res, captured };
    },
  );

  assert.ok(result.res.ok, result.res.ok ? '' : result.res.error.reason);
  const req = result.captured[0];
  // The Responses API, not chat/completions — this is the part that moved.
  assert.equal(req.url, 'https://api.openai.com/v1/responses');
  assert.equal(req.headers.authorization, 'Bearer test-key');

  const input = req.body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(input[0].content[0].type, 'input_image');
  assert.match(String(input[0].content[0].image_url), /^data:image\/png;base64,/);
  assert.equal(input[0].content[0].detail, 'high');
  assert.equal(input[0].content[1].type, 'input_text');

  const format = (req.body.text as Record<string, Record<string, unknown>>).format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.strict, true);
  assert.equal(typeof format.name, 'string', 'this API requires a schema name');
  assert.equal(req.body.store, false, 'investigative imagery is not retained by default');

  assert.equal(result.res.value.usage.costUsd, (3_000 / 1e6) * 5 + (500 / 1e6) * 30);
});

test('a schema mismatch triggers exactly one repair retry, then gives up', async () => {
  const { AnthropicVisionProvider } = (await import(anthropicSpecifier)) as typeof AnthropicModule;
  const provider = new AnthropicVisionProvider({ apiKey: 'k', model: 'claude-sonnet-5' });

  // First response is prose, second is valid.
  const repaired = await withStubbedFetch(
    [
      { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'I think this is Paris.' }], usage: {} },
      {
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: JSON.stringify(cluePayload()) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ],
    async (captured) => {
      const res = await provider.extractClues({
        image: { imageId: 'img_3', bytes: smallPng() },
        timeoutMs: 5_000,
      });
      return { res, captured };
    },
  );

  assert.ok(repaired.res.ok);
  assert.equal(repaired.res.value.attempts, 2);
  assert.equal(repaired.captured.length, 2);
  const secondPrompt = String(
    (
      (repaired.captured[1].body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
        .content[1] as { text: string }
    ).text,
  );
  assert.match(secondPrompt, /did not match the required JSON shape/);

  // Two bad responses: one retry, then a typed failure. Never a third call, and
  // never a partially-parsed guess.
  const givenUp = await withStubbedFetch(
    [{ model: 'claude-sonnet-5', content: [{ type: 'text', text: 'still prose' }], usage: {} }],
    async (captured) => {
      const res = await provider.extractClues({
        image: { imageId: 'img_4', bytes: smallPng() },
        timeoutMs: 5_000,
      });
      return { res, captured };
    },
  );
  assert.ok(!givenUp.res.ok);
  assert.equal(givenUp.res.error.kind, 'invalid-response');
  assert.equal(givenUp.captured.length, 2);
});

test('a vendor error body reaches the operator instead of a bare status code', async () => {
  const { AnthropicVisionProvider } = (await import(anthropicSpecifier)) as typeof AnthropicModule;
  const provider = new AnthropicVisionProvider({ apiKey: 'k' });
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'thinking.type: unexpected value' } }), {
      status: 400,
    })) as typeof globalThis.fetch;
  try {
    const res = await provider.extractClues({
      image: { imageId: 'img_5', bytes: smallPng() },
      timeoutMs: 5_000,
    });
    assert.ok(!res.ok);
    assert.match(res.error.reason, /HTTP 400/);
    assert.match(res.error.reason, /unexpected value/, 'the vendor reason is the debuggable part');
  } finally {
    globalThis.fetch = original;
  }
});

test('the pre-encoded adapter fits a caller-owned provider boundary structurally', async () => {
  const { asPreEncodedJsonProvider } = (await import(adaptersSpecifier)) as typeof AdaptersModule;
  const { AnthropicVisionProvider } = (await import(anthropicSpecifier)) as typeof AnthropicModule;

  // The shape VEHICLE declares, written out here rather than imported: if either
  // side drifts, this stops compiling instead of failing at request time.
  interface CallerBoundary {
    readonly name: string;
    extract(req: {
      image: { base64: string; mediaType: string };
      timeoutMs: number;
      signal?: AbortSignal;
    }): Promise<
      | { ok: true; value: { json: unknown; modelVersion: string; costUsd?: number; attempts: number } }
      | { ok: false; error: { kind: string; reason: string } }
    >;
  }

  const adapted: CallerBoundary = asPreEncodedJsonProvider({
    provider: new AnthropicVisionProvider({ apiKey: 'k', model: 'claude-sonnet-5' }),
    prompt: 'List the vehicles. Return ONLY JSON.',
  });

  const out = await withStubbedFetch(
    [
      {
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: '{"candidates":[{"make":"Ford"}]}' }],
        usage: { input_tokens: 1_000, output_tokens: 100 },
      },
    ],
    async () =>
      adapted.extract({
        image: { base64: Buffer.from(smallPng()).toString('base64'), mediaType: 'image/png' },
        timeoutMs: 5_000,
      }),
  );

  assert.ok(out.ok);
  // Raw JSON passes through for the caller to validate, which is their contract.
  assert.deepEqual(out.value.json, { candidates: [{ make: 'Ford' }] });
  assert.equal(out.value.modelVersion, 'anthropic:claude-sonnet-5');
  assert.equal(out.value.costUsd, (1_000 / 1e6) * 3 + (100 / 1e6) * 15);
});

test('the region-coordinate addendum only appears when it is asked for', async () => {
  const { AnthropicVisionProvider } = (await import(anthropicSpecifier)) as typeof AnthropicModule;
  const provider = new AnthropicVisionProvider({ apiKey: 'k' });
  const response = {
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: JSON.stringify(cluePayload()) }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  const withCoords = await withStubbedFetch([response], async (captured) => {
    await provider.extractClues({
      image: { imageId: 'i', bytes: smallPng() },
      timeoutMs: 5_000,
      requestRegionCoordinates: true,
    });
    return captured;
  });
  const promptOf = (c: CapturedRequest): string =>
    String(
      (
        (c.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content[1] as {
          text: string;
        }
      ).text,
    );
  assert.match(promptOf(withCoords[0]), /regionCoordinates/);
  assert.match(promptOf(withCoords[0]), /YOUR estimates from memory/);
  const schema = (withCoords[0].body.output_config as Record<string, Record<string, unknown>>).format
    .schema as Record<string, Record<string, unknown>>;
  assert.ok('regionCoordinates' in schema.properties);

  const without = await withStubbedFetch([response], async (captured) => {
    await provider.extractClues({ image: { imageId: 'i', bytes: smallPng() }, timeoutMs: 5_000 });
    return captured;
  });
  assert.ok(!/regionCoordinates/.test(promptOf(without[0])));
});

// ---------------------------------------------------------------------------
// Reasoning effort — the largest single latency term on this path
// ---------------------------------------------------------------------------

/**
 * Measured 2026-07-31 on a real 2560x1440 frame: the vendor default spent 516
 * hidden reasoning tokens and 22.4s against 12.4s at `none` for an identical
 * clue list. LOCATE asks the model to enumerate what is visible against a strict
 * schema — there is nothing to deduce, so the thinking is pure cost.
 */
test('reasoning effort is sent, defaults to none, and is overridable', async () => {
  const { OpenAiVisionProvider } = (await import(openaiSpecifier)) as typeof OpenAiModule;

  const effortOf = async (provider: InstanceType<typeof OpenAiVisionProvider>): Promise<unknown> => {
    const captured = await withStubbedFetch(
      [
        {
          model: provider.model,
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(cluePayload()) }] }],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      ],
      async (requests) => {
        await provider.extractClues({
          image: { imageId: 'img_effort', bytes: smallPng(), mimeType: 'image/png' },
          timeoutMs: 5_000,
        });
        return requests;
      },
    );
    return (captured[0].body.reasoning as Record<string, unknown> | undefined)?.effort;
  };

  assert.equal(await effortOf(new OpenAiVisionProvider({ apiKey: 'k' })), 'none');
  assert.equal(
    await effortOf(new OpenAiVisionProvider({ apiKey: 'k', reasoningEffort: 'high' })),
    'high',
    'a harder corpus must be able to buy the thinking back',
  );

  // '' and 'default' mean "send nothing and take the vendor's own default" — the
  // escape hatch for a model whose supported effort values change under us.
  assert.equal(await effortOf(new OpenAiVisionProvider({ apiKey: 'k', reasoningEffort: 'default' })), undefined);
});

test('reasoning effort is withheld from models that reject the parameter', async () => {
  const { OpenAiVisionProvider, supportsReasoningEffort } = (await import(
    openaiSpecifier
  )) as typeof OpenAiModule;

  // gpt-4o answers HTTP 400 "Unsupported parameter: 'reasoning.effort'". A model
  // override must not turn into a hard failure on a default nobody chose.
  assert.equal(supportsReasoningEffort('gpt-4o'), false);
  assert.equal(supportsReasoningEffort('gpt-5.6-luna'), true);
  assert.equal(supportsReasoningEffort('o3-mini'), true);

  const provider = new OpenAiVisionProvider({ apiKey: 'k', model: 'gpt-4o', reasoningEffort: 'high' });
  assert.equal(provider.reasoningEffort, undefined);

  const captured = await withStubbedFetch(
    [
      {
        model: 'gpt-4o',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(cluePayload()) }] }],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    ],
    async (requests) => {
      await provider.extractClues({
        image: { imageId: 'img_4o', bytes: smallPng(), mimeType: 'image/png' },
        timeoutMs: 5_000,
      });
      return requests;
    },
  );
  assert.equal(captured[0].body.reasoning, undefined);
});

test('hidden reasoning tokens are reported without being billed twice', async () => {
  const { OpenAiVisionProvider } = (await import(openaiSpecifier)) as typeof OpenAiModule;
  const provider = new OpenAiVisionProvider({ apiKey: 'k', model: 'gpt-5.6-luna' });

  const res = await withStubbedFetch(
    [
      {
        model: 'gpt-5.6-luna',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(cluePayload()) }] }],
        usage: {
          input_tokens: 4_000,
          output_tokens: 1_000,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 600 },
        },
      },
    ],
    async () =>
      provider.extractClues({
        image: { imageId: 'img_r', bytes: smallPng(), mimeType: 'image/png' },
        timeoutMs: 5_000,
      }),
  );

  assert.ok(res.ok, res.ok ? '' : res.error.reason);
  assert.equal(res.value.usage.reasoningTokens, 600);
  // Reasoning tokens sit INSIDE output_tokens. Adding them again would inflate
  // every cost this module reports on a reasoning model.
  assert.equal(res.value.usage.costUsd, (4_000 / 1e6) * 1 + (1_000 / 1e6) * 6);
  assert.match(res.value.usage.costBasis, /600 of the output tokens were hidden reasoning/);
});
