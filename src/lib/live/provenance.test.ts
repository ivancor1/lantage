/**
 * Reverse-image-search tests.
 *
 *   node --test src/lib/live/provenance.test.ts
 *
 * What these exist to pin down is the no-fabrication rule, which is not a style
 * preference here: no score we did not receive, no hit we cannot attribute, and
 * "nothing configured" reported as a capability gap rather than as an empty
 * finding. The two provider tests drive the real response-parsing code against
 * canned payloads in each service's documented shape, so a vendor field rename
 * fails a test instead of silently producing zero results.
 *
 * See `../cascade/testing/aliasHooks.ts` for why modules load through variable
 * specifiers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type * as AliasHooks from '@/lib/cascade/testing/aliasHooks';
import type * as ProvenanceModule from './provenance';
import type { ProvenanceHit } from './contract';

const hooksSpecifier = '../cascade/testing/aliasHooks.ts';
const hooks = (await import(hooksSpecifier)) as typeof AliasHooks;
hooks.registerAliasHooks();

const specifier = './provenance.ts';
const {
  GoogleVisionWebDetectionProvider,
  PROVENANCE_COSTS_USD,
  TinEyeProvider,
  allProviders,
  configuredProviders,
  dedupeHits,
  extractAddressLike,
  findPublishedCopies,
  hostPathKey,
  isPubliclyFetchableUrl,
  provenanceGaps,
} = (await import(specifier)) as typeof ProvenanceModule;

const IMAGE = { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/jpeg', filename: 'x.jpg' };

// ---------------------------------------------------------------------------
// Nothing configured
// ---------------------------------------------------------------------------

test('an empty provider set yields no hits plus a capability gap per service', async () => {
  const res = await findPublishedCopies(IMAGE, { providers: [], env: {} });
  assert.ok(res.ok, 'a missing key is a degradation, not a failure');
  if (!res.ok) return;

  assert.deepEqual(res.value.hits, [], 'no hits may be invented when nothing ran');
  assert.equal(res.value.attempts.length, 0);
  assert.equal(res.value.costUsd, 0);

  const envVars = res.value.unavailable.map((g) => g.envVar);
  assert.ok(envVars.includes('TINEYE_API_KEY'), 'the gap must name the env var to set');
  assert.ok(envVars.includes('GOOGLE_CLOUD_VISION_API_KEY'));
  for (const gap of res.value.unavailable) {
    assert.ok(gap.impact.length > 0, 'a gap without a stated impact is not actionable');
  }
});

test('provider selection is driven only by keys actually present', () => {
  assert.equal(configuredProviders({}).length, 0);
  assert.equal(allProviders({}).length, 2, 'both services stay known even when unwired');
  assert.equal(configuredProviders({ TINEYE_API_KEY: 'k' }).length, 1);
  assert.equal(provenanceGaps({ TINEYE_API_KEY: 'k' }).length, 1);
  // A Generative-Language key is deliberately not accepted as a Cloud Vision key.
  assert.equal(configuredProviders({ GOOGLE_API_KEY: 'k', GEMINI_API_KEY: 'k' }).length, 0);
  assert.equal(configuredProviders({ GOOGLE_CLOUD_VISION_API_KEY: 'k' }).length, 1);
});

test('an unconfigured provider returns a typed not-configured failure and never throws', async () => {
  const tineye = new TinEyeProvider({});
  const res = await tineye.search(IMAGE, { limit: 5, timeoutMs: 1_000 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, 'not-configured');
  assert.match(res.error.reason, /TINEYE_API_KEY/);
});

test('with nothing searchable at all, the whole search fails typed rather than empty', async () => {
  const res = await findPublishedCopies({}, { providers: [], env: {} });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, 'no-input');
});

test('a local preview URL is not offered to a third-party crawler', async () => {
  assert.equal(isPubliclyFetchableUrl('http://localhost:3000/api/uploads/abc'), false);
  assert.equal(isPubliclyFetchableUrl('http://127.0.0.1/x.jpg'), false);
  assert.equal(isPubliclyFetchableUrl('http://192.168.1.9/x.jpg'), false);
  assert.equal(isPubliclyFetchableUrl('file:///tmp/x.jpg'), false);
  assert.equal(isPubliclyFetchableUrl('https://example.com/x.jpg'), true);

  const res = await findPublishedCopies(
    { publicUrl: 'http://localhost:3000/x.jpg' },
    { providers: [], env: {} },
  );
  assert.equal(res.ok, false, 'a URL only we can reach is the same as having no input');
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

test('hits are de-duplicated by host + path, ignoring query and fragment', () => {
  const hits: ProvenanceHit[] = [
    { url: 'https://Example.com/listing/42?utm_source=a', source: 'TinEye', score: 96 },
    { url: 'https://example.com/listing/42/#photos', source: 'Google' },
    { url: 'https://example.com/listing/43', source: 'Google' },
    { url: 'not a url', source: 'Google' },
  ];
  const deduped = dedupeHits(hits);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].source, 'TinEye', 'first occurrence wins, so scores are never merged');
  assert.equal(deduped[0].score, 96);
  assert.equal(hostPathKey('https://Example.com/A/'), 'example.com/a');
  assert.equal(hostPathKey('nonsense'), null);
});

test('a hit carries a score only when the service reported one', async () => {
  const fake: ProvenanceModule.ProvenanceProvider = {
    name: 'Fake Service',
    gap: { capability: 'x', impact: 'y' },
    configured: true,
    usdPerSearch: 0,
    async search() {
      return {
        ok: true,
        value: { hits: [{ url: 'https://example.com/a', source: 'Fake Service' }] },
      };
    },
  };
  const res = await findPublishedCopies(IMAGE, { providers: [fake], env: {} });
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.value.hits.length, 1);
  assert.equal(res.value.hits[0].score, undefined, 'no score must be synthesised');
  assert.equal(res.value.attempts[0].ok, true);
});

test('a provider that throws degrades to a typed attempt failure', async () => {
  const exploding: ProvenanceModule.ProvenanceProvider = {
    name: 'Exploding Service',
    gap: { capability: 'x', impact: 'y' },
    configured: true,
    usdPerSearch: 1,
    async search() {
      throw new Error('socket hang up');
    },
  };
  const res = await findPublishedCopies(IMAGE, { providers: [exploding], env: {} });
  assert.ok(res.ok, 'one bad vendor must not take the search down');
  if (!res.ok) return;
  assert.deepEqual(res.value.hits, []);
  assert.equal(res.value.attempts[0].ok, false);
  assert.match(res.value.attempts[0].failure?.reason ?? '', /socket hang up/);
  assert.equal(res.value.costUsd, 0, 'a call that never landed is not billed');
});

// ---------------------------------------------------------------------------
// Address-looking text
// ---------------------------------------------------------------------------

test('address extraction only fires on text that actually looks like an address', () => {
  assert.equal(extractAddressLike('1234 N Maple Street — For Sale'), '1234 N Maple Street');
  assert.equal(
    extractAddressLike('For sale: 1234 N Maple Street, Springfield, IL 62704'),
    '1234 N Maple Street, Springfield, IL 62704',
    'adjacent street and city/state/zip matches are one address, returned whole',
  );
  assert.equal(extractAddressLike('Cosy flat, 12 Acacia Avenue'), '12 Acacia Avenue');
  assert.equal(extractAddressLike('Home for sale in Springfield, IL 62704'), 'Springfield, IL 62704');
  assert.equal(extractAddressLike('Flat to let SW1A 1AA'), 'SW1A 1AA');
  assert.equal(extractAddressLike('Beautiful sunlit living room'), undefined);
  assert.equal(extractAddressLike(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Real response parsing
// ---------------------------------------------------------------------------

/** Swap `fetch` for one call, restoring it even when the assertion throws. */
async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test("TinEye's documented response shape maps backlinks to page URLs", async () => {
  let seenUrl = '';
  let seenKey: string | null = null;

  const res = await withFetch(
    async (url, init) => {
      seenUrl = url;
      seenKey = new Headers(init?.headers).get('x-api-key');
      return json({
        code: 200,
        messages: [],
        stats: { total_results: 2, total_backlinks: 2 },
        results: {
          matches: [
            {
              score: 96.7,
              domain: 'example-realty.com',
              image_url: 'https://cdn.example-realty.com/img/1.jpg',
              backlinks: [
                {
                  url: 'https://cdn.example-realty.com/img/1.jpg',
                  backlink: 'https://example-realty.com/listing/1234-n-maple-street',
                  crawl_date: '2026-02-11',
                },
              ],
            },
            // No backlink recorded: still a real copy, reported as the image URL.
            { domain: 'stock.example.net', image_url: 'https://stock.example.net/p/9.jpg', backlinks: [] },
          ],
        },
      });
    },
    async () => {
      const provider = new TinEyeProvider({ TINEYE_API_KEY: 'test-key' });
      return provider.search(IMAGE, { limit: 10, timeoutMs: 2_000 });
    },
  );

  assert.equal(seenUrl, 'https://api.tineye.com/rest/search/');
  assert.equal(seenKey, 'test-key', 'auth is the x-api-key header');
  assert.ok(res.ok);
  if (!res.ok) return;

  assert.equal(res.value.hits.length, 2);
  assert.equal(res.value.hits[0].url, 'https://example-realty.com/listing/1234-n-maple-street');
  assert.equal(res.value.hits[0].source, 'TinEye', 'a hit is never presented as our own finding');
  assert.equal(res.value.hits[0].score, 96.7, "TinEye's 0-100 score is passed through untouched");
  assert.equal(res.value.hits[1].url, 'https://stock.example.net/p/9.jpg');
  assert.equal(res.value.hits[1].score, undefined);
  assert.equal(res.value.reportedTotal, 2);
});

test('a TinEye error code becomes a typed failure, not an empty result', async () => {
  const res = await withFetch(
    async () => json({ code: 400, messages: ['NO_SIGNATURE'] }),
    async () => new TinEyeProvider({ TINEYE_API_KEY: 'k' }).search(IMAGE, { limit: 5, timeoutMs: 1_000 }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error.reason, /400/);
});

test("Cloud Vision's WEB_DETECTION response maps pages, full matches and labels", async () => {
  let seenUrl = '';
  let seenBody: unknown;

  const res = await withFetch(
    async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body));
      return json({
        responses: [
          {
            webDetection: {
              webEntities: [{ entityId: '/m/01', score: 1.44, description: 'Living room' }],
              fullMatchingImages: [{ url: 'https://cdn.example.com/full.jpg', score: 0.9 }],
              partialMatchingImages: [{ url: 'https://cdn.example.com/part.jpg' }],
              pagesWithMatchingImages: [
                {
                  url: 'https://rentals.example.com/unit/7',
                  pageTitle: '2 bed at 1234 N Maple Street, Springfield, IL 62704',
                  score: 3.1,
                },
                { url: 'https://news.example.com/story', pageTitle: 'Inside the house' },
              ],
              visuallySimilarImages: [{ url: 'https://other.example.com/similar.jpg' }],
              bestGuessLabels: [{ label: 'living room', languageCode: 'en' }],
            },
          },
        ],
      });
    },
    async () =>
      new GoogleVisionWebDetectionProvider({ GOOGLE_CLOUD_VISION_API_KEY: 'vkey' }).search(IMAGE, {
        limit: 10,
        timeoutMs: 2_000,
      }),
  );

  assert.match(seenUrl, /^https:\/\/vision\.googleapis\.com\/v1\/images:annotate\?key=vkey$/);
  const body = seenBody as {
    requests: Array<{
      image: { content?: string };
      features: Array<{ type: string; maxResults: number }>;
      imageContext: { webDetectionParams: { includeGeoResults: boolean } };
    }>;
  };
  assert.equal(body.requests[0].features[0].type, 'WEB_DETECTION');
  assert.equal(body.requests[0].imageContext.webDetectionParams.includeGeoResults, true);
  assert.equal(body.requests[0].image.content, Buffer.from(IMAGE.bytes).toString('base64'));

  assert.ok(res.ok);
  if (!res.ok) return;

  const pageHits = res.value.hits.filter((h) => h.source === 'Google Cloud Vision (WEB_DETECTION)');
  assert.equal(pageHits.length, 2);
  assert.equal(pageHits[0].url, 'https://rentals.example.com/unit/7');
  assert.equal(pageHits[0].score, 3.1, "Google's own relevance is passed through, not rescaled");
  assert.equal(
    pageHits[0].place,
    '1234 N Maple Street, Springfield, IL 62704',
    'an address is lifted only from the title the service returned',
  );
  assert.equal(pageHits[1].place, undefined, 'no address in the title means no address claimed');

  assert.ok(res.value.hits.some((h) => h.source.includes('full image match')));
  assert.equal(
    res.value.hits.some((h) => h.url.includes('similar.jpg')),
    false,
    'visually similar is not a published copy and must be off by default',
  );
  assert.ok((res.value.labels ?? []).some((l) => l.label === 'living room'));
});

test('a per-request Cloud Vision error is surfaced as a failure', async () => {
  const res = await withFetch(
    async () => json({ responses: [{ error: { code: 403, message: 'Cloud Vision API has not been used' } }] }),
    async () =>
      new GoogleVisionWebDetectionProvider({ GOOGLE_CLOUD_VISION_API_KEY: 'k' }).search(IMAGE, {
        limit: 5,
        timeoutMs: 1_000,
      }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error.reason, /has not been used/);
});

test('a service is billed only when it answered, at the documented rate', async () => {
  const res = await withFetch(
    async () => json({ code: 200, results: { matches: [] } }),
    async () =>
      findPublishedCopies(IMAGE, {
        providers: [new TinEyeProvider({ TINEYE_API_KEY: 'k' })],
        env: { TINEYE_API_KEY: 'k' },
      }),
  );
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.value.costUsd, PROVENANCE_COSTS_USD.tineyePerSearch);
  assert.ok(res.value.ranMs >= 0);
  assert.deepEqual(res.value.hits, []);
});
