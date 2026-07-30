/**
 * Reverse image search — "where else does this exact image appear publicly?"
 *
 * This is the strongest real signal for "which home is this". An interior frame
 * carries no address, but the *page* it was published on usually does: a listing,
 * a short-let page, a news story, an estate agent's brochure. Finding that page
 * is a lookup, not an inference, and the operator can open it and read the
 * address themselves.
 *
 * WHY THIS SHAPE AND NOT AN INDEX OF LISTING PHOTOS
 *
 * We do not build, buy, or scrape an index of MLS / Zillow / Redfin / Realtor
 * listing photos, and no future version of this file should. *VHT v. Zillow*
 * (9th Cir., affirmed 2023) held that a searchable, indexed arrangement of MLS
 * photographs is direct infringement and rejected fair use; NAR IDX Policy 7.58
 * restricts IDX data to display, not indexing. The legitimate route is the one
 * implemented here: query services that already index the open web under their
 * own licences, and retain nothing but the URL they hand back. No third-party
 * pixels are stored, hashed, or embedded by this module.
 *
 * THE RULES THIS FILE ENFORCES (see the no-fabrication rule in ./contract.ts)
 *
 *  1. `score` is only ever the number the service reported. There is no
 *     synthesised, blended, or normalised score anywhere in this file — the two
 *     services use different scales (TinEye 0-100, Google an unbounded
 *     relevance), and inventing a common one would invent information.
 *  2. `source` always names the service, so a hit can never be read as our own
 *     finding.
 *  3. `place` is only ever a substring of text the service itself returned. We do
 *     not fetch or parse third-party pages.
 *  4. Nothing configured => an empty hit list plus a `CapabilityGap` naming the
 *     env var. Never a placeholder result.
 */

import { z } from 'zod';
import { callJson } from '@/lib/cascade/net';
import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';
import type { CapabilityGap, ProvenanceHit } from './contract';

/**
 * Only the shape we read from the environment.
 *
 * Deliberately not `NodeJS.ProcessEnv`: this project's generated Next types make
 * `NODE_ENV` non-optional there, which makes a literal `{}` unassignable and
 * every caller that wants to pass an explicit environment jump through a cast.
 * `process.env` satisfies this.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Both services are crawler-index lookups over the network, so these are
 * generous compared with the 10s cascade budget. The LIVE path is single-operator
 * and has no SLA; the caller clamps these down with its own budget.
 */
export const PROVENANCE_TIMEOUTS_MS = {
  tineye: 9_000,
  googleVision: 9_000,
} as const;

/**
 * Verified 2026-07-30.
 *
 *  - TinEye: billed per search from a prepaid bundle; docs/MASTER_PLAN.md §6
 *    records $0.01/search at volume, which is the number the cost model uses.
 *    Small bundles cost more per search, so this can understate — it is a named
 *    constant so it can be corrected from an invoice rather than a guess.
 *  - Cloud Vision WEB_DETECTION: $3.50 per 1,000 units for units 1,001-5,000,000
 *    per month, first 1,000 units/month free
 *    (https://cloud.google.com/vision/pricing). We bill the marginal rate: a
 *    "free tier" price of $0 would only be true for the first 1,000 searches.
 */
export const PROVENANCE_COSTS_USD = {
  tineyePerSearch: 0.01,
  googleVisionWebDetectionPerCall: 0.0035,
} as const;

/** Hits returned per provider before de-duplication. */
export const PROVENANCE_DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

/**
 * What we can give a reverse-image service.
 *
 * `bytes` is the primary path: LIVE uploads live on local disk, so there is no
 * URL a third-party crawler could fetch. `publicUrl` is only usable when it is
 * genuinely reachable from the internet — see `isPubliclyFetchableUrl`.
 */
export interface ProvenanceImage {
  bytes?: Uint8Array;
  mimeType?: string;
  filename?: string;
  publicUrl?: string;
}

export interface ProvenanceSearchOptions {
  /** Max hits requested per provider. */
  limit?: number;
  /** Wall-clock ceiling for each provider call. Clamped by the caller's budget. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Overridden in tests; defaults to `process.env`. */
  env?: EnvLike;
  /** Injected in tests. Defaults to `configuredProviders(env)`. */
  providers?: readonly ProvenanceProvider[];
  /**
   * Off by default, deliberately. "Visually similar" is not a published copy of
   * this image, and presenting it as provenance would be a fabricated finding.
   */
  includeVisuallySimilar?: boolean;
}

/** A label or entity the service attached to the image. Context, not a location. */
export interface ProvenanceLabel {
  label: string;
  /** Service-reported score, when supplied. Never invented. */
  score?: number;
  source: string;
}

/** Per-provider outcome, so an empty hit list is always explainable. */
export interface ProvenanceAttempt {
  provider: string;
  ok: boolean;
  hits: number;
  ranMs: number;
  costUsd: number;
  /** The verbatim typed failure when the provider produced nothing. */
  failure?: StageFailure;
  /** Service-reported total match count, when supplied. */
  reportedTotal?: number;
}

/**
 * The result of asking every configured service.
 *
 * Note this is richer than a bare `ProvenanceHit[]`: the contract requires that
 * "nothing found" comes back with the *reason* and the env var that would fix it,
 * and an array cannot carry either. `hits` is the list the caller renders.
 */
export interface ProvenanceFindings {
  hits: ProvenanceHit[];
  labels: ProvenanceLabel[];
  attempts: ProvenanceAttempt[];
  unavailable: CapabilityGap[];
  costUsd: number;
  ranMs: number;
}

export interface ProviderFindings {
  hits: ProvenanceHit[];
  labels?: ProvenanceLabel[];
  reportedTotal?: number;
}

export interface ProviderSearchOptions {
  limit: number;
  timeoutMs: number;
  signal?: AbortSignal;
  includeVisuallySimilar?: boolean;
}

export interface ProvenanceProvider {
  /** Goes verbatim into `ProvenanceHit.source`. Must name the service. */
  readonly name: string;
  /** Reported in the `CapabilityGap` when the key is missing. */
  readonly gap: CapabilityGap;
  readonly configured: boolean;
  /** Marginal price of one search, for `StageTrace.costUsd`. */
  readonly usdPerSearch: number;
  search(
    image: ProvenanceImage,
    opts: ProviderSearchOptions,
  ): Promise<Result<ProviderFindings, StageFailure>>;
}

// ---------------------------------------------------------------------------
// Capability gaps
// ---------------------------------------------------------------------------

export const TINEYE_GAP: CapabilityGap = {
  capability: 'Reverse image search (TinEye)',
  impact:
    'Without it we cannot find the listing, rental, or news page this photo was published on — which is the only route from an interior photo to a specific building.',
  envVar: 'TINEYE_API_KEY',
  howTo:
    'Buy a search bundle at https://services.tineye.com/TinEyeAPI and put the key in .env.local. TinEye is the one whole-image reverse-search API licensed for commercial resale.',
};

export const GOOGLE_VISION_GAP: CapabilityGap = {
  capability: 'Reverse image search (Google Cloud Vision WEB_DETECTION)',
  impact:
    'A second, independently built index. It returns the pages hosting a matching image plus the page titles, which is where an address usually appears.',
  envVar: 'GOOGLE_CLOUD_VISION_API_KEY',
  howTo:
    'Enable the Cloud Vision API on a Google Cloud project, create an API key, and set GOOGLE_CLOUD_VISION_API_KEY in .env.local. $3.50 per 1,000 WEB_DETECTION units after the first 1,000 each month. A Gemini/AI-Studio key is NOT the same credential and is deliberately not reused here.',
};

// ---------------------------------------------------------------------------
// TinEye — https://api.tineye.com/rest/search/
// ---------------------------------------------------------------------------

/**
 * Verified 2026-07-30 against TinEye's own client (TinEye/pytineye `api.py`):
 * base URL `https://api.tineye.com/rest/`, method `search`, auth via the
 * `x-api-key` request header, image supplied as either the `image_url` field or
 * the `image_upload` multipart file part, with `offset`/`limit`/`sort`/`order`
 * alongside it. Response: `{ code, messages, stats, results: { matches: [...] } }`
 * where each match carries `score` (0-100), `domain`, `image_url` and
 * `backlinks: [{ url, backlink, crawl_date }]` — `backlink` is the *page* URL and
 * `url` is the image URL on that page.
 */
const TinEyeBacklinkSchema = z.object({
  url: z.string().optional(),
  backlink: z.string().optional(),
  crawl_date: z.string().optional(),
});

const TinEyeMatchSchema = z.object({
  /** 0-100 as reported. Passed through unchanged; see the no-synthesis rule. */
  score: z.number().optional(),
  domain: z.string().optional(),
  image_url: z.string().optional(),
  backlinks: z.array(TinEyeBacklinkSchema).optional(),
  tags: z.array(z.string()).optional(),
});

const TinEyeResponseSchema = z.object({
  code: z.number().optional(),
  /** Shape varies between error classes, so it is read as opaque and stringified. */
  messages: z.array(z.unknown()).optional(),
  stats: z
    .object({
      total_results: z.number().optional(),
      total_backlinks: z.number().optional(),
    })
    .partial()
    .optional(),
  // Accept both documented generations: `results.matches` and a bare array.
  results: z
    .union([z.object({ matches: z.array(TinEyeMatchSchema).optional() }), z.array(TinEyeMatchSchema)])
    .optional(),
});

export const TINEYE_DEFAULT_BASE_URL = 'https://api.tineye.com/rest';

export class TinEyeProvider implements ProvenanceProvider {
  readonly name = 'TinEye';
  readonly gap = TINEYE_GAP;
  readonly usdPerSearch = PROVENANCE_COSTS_USD.tineyePerSearch;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(env: EnvLike = process.env) {
    this.apiKey = env.TINEYE_API_KEY;
    this.baseUrl = env.TINEYE_API_URL ?? TINEYE_DEFAULT_BASE_URL;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async search(
    image: ProvenanceImage,
    opts: ProviderSearchOptions,
  ): Promise<Result<ProviderFindings, StageFailure>> {
    if (!this.apiKey) {
      return err(failure('not-configured', `${TINEYE_GAP.envVar} is not set, so ${this.name} was not queried.`));
    }

    const form = new FormData();
    if (image.bytes && image.bytes.byteLength > 0) {
      form.append(
        'image_upload',
        new Blob([toArrayBuffer(image.bytes)], { type: image.mimeType ?? 'image/jpeg' }),
        image.filename ?? 'upload.jpg',
      );
    } else if (image.publicUrl && isPubliclyFetchableUrl(image.publicUrl)) {
      form.append('image_url', image.publicUrl);
    } else {
      return err(
        failure(
          'no-input',
          `${this.name} needs either the image bytes or a publicly reachable image URL; neither was available.`,
        ),
      );
    }
    form.append('limit', String(Math.max(1, Math.min(100, opts.limit))));
    form.append('offset', '0');
    form.append('sort', 'score');
    form.append('order', 'desc');

    const res = await postForm({
      url: `${this.baseUrl.replace(/\/$/, '')}/search/`,
      form,
      headers: { 'x-api-key': this.apiKey },
      timeoutMs: opts.timeoutMs,
      schema: TinEyeResponseSchema,
      signal: opts.signal,
      label: this.name,
    });
    if (!res.ok) return res;

    const body = res.value;
    if (typeof body.code === 'number' && body.code >= 400) {
      return err(
        failure(
          body.code >= 500 ? 'unavailable' : 'invalid-response',
          `${this.name} returned code ${body.code}${describeMessages(body.messages)}.`,
        ),
      );
    }

    const matches = Array.isArray(body.results) ? body.results : (body.results?.matches ?? []);
    const hits: ProvenanceHit[] = [];
    for (const match of matches) {
      const score = typeof match.score === 'number' ? match.score : undefined;
      const backlinks = match.backlinks ?? [];
      let pageFound = false;
      for (const backlink of backlinks) {
        // `backlink` is the page the image was found on — the thing that may name
        // an address. `url` is the image file itself.
        const page = firstHttpUrl([backlink.backlink, backlink.url]);
        if (!page) continue;
        pageFound = true;
        hits.push({ url: page, source: this.name, ...(score === undefined ? {} : { score }) });
      }
      // A match with no recorded backlink is still a real copy on the open web.
      if (!pageFound) {
        const imageUrl = firstHttpUrl([match.image_url]);
        if (imageUrl) {
          hits.push({ url: imageUrl, source: this.name, ...(score === undefined ? {} : { score }) });
        }
      }
    }

    return ok({
      hits: hits.slice(0, opts.limit),
      reportedTotal: body.stats?.total_results,
    });
  }
}

// ---------------------------------------------------------------------------
// Google Cloud Vision WEB_DETECTION
// ---------------------------------------------------------------------------

/**
 * Verified 2026-07-30 against https://cloud.google.com/vision/docs/detecting-web:
 * `POST https://vision.googleapis.com/v1/images:annotate`, API key as the `key`
 * query parameter (or an OAuth bearer token), body
 * `{ requests: [{ image: { content | source.imageUri }, features: [{ type:
 * 'WEB_DETECTION', maxResults }], imageContext: { webDetectionParams: {
 * includeGeoResults } } }] }`. The `webDetection` response carries
 * `webEntities[]`, `fullMatchingImages[]`, `partialMatchingImages[]`,
 * `pagesWithMatchingImages[]` (each with `url`, `pageTitle`, `score` and its own
 * nested full/partial image lists), `visuallySimilarImages[]` and
 * `bestGuessLabels[]`.
 *
 * `includeGeoResults` is enabled: this module's entire job is provenance, and the
 * operator is searching their own uploaded image.
 */
const WebImageSchema = z.object({
  url: z.string().optional(),
  score: z.number().optional(),
});

const VisionResponseSchema = z.object({
  responses: z
    .array(
      z.object({
        error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
        webDetection: z
          .object({
            webEntities: z
              .array(
                z.object({
                  entityId: z.string().optional(),
                  score: z.number().optional(),
                  description: z.string().optional(),
                }),
              )
              .optional(),
            fullMatchingImages: z.array(WebImageSchema).optional(),
            partialMatchingImages: z.array(WebImageSchema).optional(),
            pagesWithMatchingImages: z
              .array(
                z.object({
                  url: z.string().optional(),
                  pageTitle: z.string().optional(),
                  score: z.number().optional(),
                  fullMatchingImages: z.array(WebImageSchema).optional(),
                  partialMatchingImages: z.array(WebImageSchema).optional(),
                }),
              )
              .optional(),
            visuallySimilarImages: z.array(WebImageSchema).optional(),
            bestGuessLabels: z
              .array(z.object({ label: z.string().optional(), languageCode: z.string().optional() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export const GOOGLE_VISION_DEFAULT_URL = 'https://vision.googleapis.com/v1/images:annotate';

export class GoogleVisionWebDetectionProvider implements ProvenanceProvider {
  readonly name = 'Google Cloud Vision (WEB_DETECTION)';
  readonly gap = GOOGLE_VISION_GAP;
  readonly usdPerSearch = PROVENANCE_COSTS_USD.googleVisionWebDetectionPerCall;
  private readonly apiKey: string | undefined;
  private readonly url: string;

  constructor(env: EnvLike = process.env) {
    // Deliberately NOT falling back to GOOGLE_API_KEY / GEMINI_API_KEY: those are
    // Generative-Language credentials, and silently sending one here produces a
    // 403 that looks like "no results" to the operator.
    this.apiKey = env.GOOGLE_CLOUD_VISION_API_KEY ?? env.GOOGLE_VISION_API_KEY;
    this.url = env.GOOGLE_VISION_API_URL ?? GOOGLE_VISION_DEFAULT_URL;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async search(
    image: ProvenanceImage,
    opts: ProviderSearchOptions,
  ): Promise<Result<ProviderFindings, StageFailure>> {
    if (!this.apiKey) {
      return err(
        failure('not-configured', `${GOOGLE_VISION_GAP.envVar} is not set, so ${this.name} was not queried.`),
      );
    }

    let imagePayload: { content: string } | { source: { imageUri: string } };
    if (image.bytes && image.bytes.byteLength > 0) {
      imagePayload = { content: Buffer.from(image.bytes).toString('base64') };
    } else if (image.publicUrl && isPubliclyFetchableUrl(image.publicUrl)) {
      imagePayload = { source: { imageUri: image.publicUrl } };
    } else {
      return err(
        failure(
          'no-input',
          `${this.name} needs either the image bytes or a publicly reachable image URL; neither was available.`,
        ),
      );
    }

    const res = await callJson({
      url: `${this.url}?key=${encodeURIComponent(this.apiKey)}`,
      method: 'POST',
      body: {
        requests: [
          {
            image: imagePayload,
            features: [{ type: 'WEB_DETECTION', maxResults: Math.max(1, Math.min(50, opts.limit)) }],
            imageContext: { webDetectionParams: { includeGeoResults: true } },
          },
        ],
      },
      timeoutMs: opts.timeoutMs,
      schema: VisionResponseSchema,
      signal: opts.signal,
      label: this.name,
    });
    if (!res.ok) return res;

    const first = res.value.responses?.[0];
    if (first?.error) {
      return err(
        failure(
          (first.error.code ?? 0) >= 500 ? 'unavailable' : 'invalid-response',
          `${this.name} rejected the request: ${first.error.message ?? `code ${first.error.code ?? 'unknown'}`}`,
        ),
      );
    }

    const web = first?.webDetection;
    if (!web) {
      return ok({ hits: [], labels: [] });
    }

    const hits: ProvenanceHit[] = [];
    for (const page of web.pagesWithMatchingImages ?? []) {
      const url = firstHttpUrl([page.url]);
      if (!url) continue;
      const title = clean(page.pageTitle);
      const place = extractAddressLike(title);
      hits.push({
        url,
        source: this.name,
        ...(title === undefined ? {} : { title }),
        ...(typeof page.score === 'number' ? { score: page.score } : {}),
        ...(place === undefined ? {} : { place }),
      });
    }
    // Exact copies of the file itself, hosted somewhere. Labelled distinctly so
    // an image URL is never read as "the page this was published on".
    for (const img of web.fullMatchingImages ?? []) {
      const url = firstHttpUrl([img.url]);
      if (!url) continue;
      hits.push({
        url,
        source: `${this.name} — full image match`,
        ...(typeof img.score === 'number' ? { score: img.score } : {}),
      });
    }
    if (opts.includeVisuallySimilar) {
      for (const img of web.visuallySimilarImages ?? []) {
        const url = firstHttpUrl([img.url]);
        if (!url) continue;
        hits.push({
          url,
          // Named as what it is: this is NOT evidence the image was published there.
          source: `${this.name} — visually similar only, not a copy`,
          ...(typeof img.score === 'number' ? { score: img.score } : {}),
        });
      }
    }

    const labels: ProvenanceLabel[] = [];
    for (const guess of web.bestGuessLabels ?? []) {
      const label = clean(guess.label);
      if (label) labels.push({ label, source: `${this.name} bestGuessLabel` });
    }
    for (const entity of web.webEntities ?? []) {
      const label = clean(entity.description);
      if (!label) continue;
      labels.push({
        label,
        ...(typeof entity.score === 'number' ? { score: entity.score } : {}),
        source: `${this.name} webEntity`,
      });
    }

    return ok({ hits, labels });
  }
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

/**
 * Every provider we know how to call, in the order their hits are preferred.
 * TinEye first: it is the whole-image service licensed for commercial resale and
 * its index is built for exactly this question.
 */
export function allProviders(env: EnvLike = process.env): readonly ProvenanceProvider[] {
  return [new TinEyeProvider(env), new GoogleVisionWebDetectionProvider(env)];
}

export function configuredProviders(env: EnvLike = process.env): readonly ProvenanceProvider[] {
  return allProviders(env).filter((p) => p.configured);
}

/** Gaps for every provider that is not wired. Used when the hit list is empty. */
export function provenanceGaps(env: EnvLike = process.env): CapabilityGap[] {
  return allProviders(env)
    .filter((p) => !p.configured)
    .map((p) => p.gap);
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Ask every configured service where this image appears, merge, de-duplicate.
 *
 * Never throws. Returns `err` only when there is nothing to search with at all;
 * every other degradation (no key, timeout, off-contract response) comes back as
 * an `ok` with an empty or partial hit list plus the reason in `attempts` and
 * `unavailable`.
 */
export async function findPublishedCopies(
  image: ProvenanceImage,
  opts: ProvenanceSearchOptions = {},
): Promise<Result<ProvenanceFindings, StageFailure>> {
  const started = Date.now();
  const env = opts.env ?? process.env;
  const limit = opts.limit ?? PROVENANCE_DEFAULT_LIMIT;
  const providers = opts.providers ?? configuredProviders(env);

  const hasBytes = Boolean(image.bytes && image.bytes.byteLength > 0);
  const hasUrl = Boolean(image.publicUrl && isPubliclyFetchableUrl(image.publicUrl));
  if (!hasBytes && !hasUrl) {
    return err(
      failure(
        'no-input',
        'Reverse image search needs the image bytes, or a URL a third-party service can fetch. A local .lantage-uploads preview URL is not reachable from the internet.',
      ),
    );
  }

  if (providers.length === 0) {
    return ok({
      hits: [],
      labels: [],
      attempts: [],
      unavailable: provenanceGaps(env),
      costUsd: 0,
      ranMs: Date.now() - started,
    });
  }

  const timeoutMs =
    opts.timeoutMs ?? Math.max(PROVENANCE_TIMEOUTS_MS.tineye, PROVENANCE_TIMEOUTS_MS.googleVision);

  // Independent indexes, so run them together; each one's ranMs is its own.
  const settled = await Promise.all(
    providers.map(async (provider): Promise<{ attempt: ProvenanceAttempt; found: ProviderFindings }> => {
      const at = Date.now();
      let result: Result<ProviderFindings, StageFailure>;
      try {
        result = await provider.search(image, {
          limit,
          timeoutMs,
          signal: opts.signal,
          includeVisuallySimilar: opts.includeVisuallySimilar,
        });
      } catch (e) {
        // A provider must not be able to take the search down.
        result = err(failure('unavailable', `${provider.name} threw: ${describeError(e)}`));
      }
      const ranMs = Date.now() - at;

      if (!result.ok) {
        return {
          attempt: { provider: provider.name, ok: false, hits: 0, ranMs, costUsd: 0, failure: result.error },
          found: { hits: [] },
        };
      }
      // Charged only when the service actually answered: a transport failure or a
      // missing key costs nothing, and pretending otherwise makes the per-search
      // number unauditable.
      return {
        attempt: {
          provider: provider.name,
          ok: true,
          hits: result.value.hits.length,
          ranMs,
          costUsd: provider.usdPerSearch,
          ...(result.value.reportedTotal === undefined ? {} : { reportedTotal: result.value.reportedTotal }),
        },
        found: result.value,
      };
    }),
  );

  const hits = dedupeHits(settled.flatMap((s) => s.found.hits));
  const labels = settled.flatMap((s) => s.found.labels ?? []);
  const attempts = settled.map((s) => s.attempt);
  const costUsd = attempts.reduce((sum, a) => sum + a.costUsd, 0);

  // Gaps are reported whenever a provider is unwired, even if another found hits:
  // the operator needs to know which indexes were actually consulted.
  const unavailable = provenanceGaps(env);

  return ok({ hits, labels, attempts, unavailable, costUsd, ranMs: Date.now() - started });
}

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

/**
 * Key on host + path, ignoring scheme, query and fragment: the same listing
 * arrives from two services with different tracking parameters, and counting it
 * twice would inflate the apparent corroboration. First occurrence wins, so
 * provider order decides which service is credited — and we never merge two
 * services' scores into one hit.
 */
export function dedupeHits(hits: readonly ProvenanceHit[]): ProvenanceHit[] {
  const seen = new Set<string>();
  const out: ProvenanceHit[] = [];
  for (const hit of hits) {
    const key = hostPathKey(hit.url);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

export function hostPathKey(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.host.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Address-looking text
// ---------------------------------------------------------------------------

const STREET_SUFFIX =
  'street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|place|pl|way|terrace|ter|circle|cir|trail|trl|parkway|pkwy|highway|hwy|crescent|close|walk|row|square|sq|gardens|grove|mews';

const ADDRESS_PATTERNS: readonly RegExp[] = [
  // "1234 N Maple Street", "12 Acacia Ave"
  new RegExp(`\\b\\d{1,6}[a-z]?\\s+(?:[A-Za-z0-9.'’\\-]+\\s+){0,4}(?:${STREET_SUFFIX})\\b\\.?`, 'i'),
  // "Springfield, IL 62704"
  /\b[A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+)*,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/,
  // UK postcode
  /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/,
];

/**
 * Pull an address-looking substring out of text **the service gave us** — a page
 * title, nothing else. We do not fetch or parse third-party pages.
 *
 * Whatever comes back is the *source page's* claim about itself and must be
 * attributed that way. It is a pattern match on a title, not a verified address,
 * and a title can be wrong or stale.
 */
export function extractAddressLike(text: string | undefined): string | undefined {
  if (!text) return undefined;

  const spans: Array<{ start: number; end: number }> = [];
  for (const pattern of ADDRESS_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  if (spans.length === 0) return undefined;

  // "1234 N Maple Street" and "Springfield, IL 62704" in one title are one
  // address, so near-adjacent spans are merged and the whole thing is returned —
  // more of the page's own words, which is what the reader has to judge.
  spans.sort((a, b) => a.start - b.start);
  let best = spans[0];
  let current = spans[0];
  for (const span of spans.slice(1)) {
    if (span.start - current.end <= 2) {
      current = { start: current.start, end: Math.max(current.end, span.end) };
    } else {
      current = span;
    }
    if (current.end - current.start > best.end - best.start) best = current;
  }
  return text.slice(best.start, best.end).trim();
}

// ---------------------------------------------------------------------------
// HTTP + URL helpers
// ---------------------------------------------------------------------------

/**
 * Hosts a third-party crawler cannot reach. LIVE serves uploads off local disk,
 * so handing a service `http://localhost:3000/...` produces an error that reads
 * to the operator like "no copies found" — which would be a false negative
 * dressed as a finding.
 */
const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

export function isPubliclyFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname;
  return !PRIVATE_HOST_PATTERNS.some((p) => p.test(host));
}

function firstHttpUrl(candidates: ReadonlyArray<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!/^https?:\/\//i.test(trimmed)) continue;
    try {
      // Normalising through URL also rejects the malformed strings crawlers emit.
      return new URL(trimmed).toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 300) : undefined;
}

/**
 * Multipart POST with the same three guarantees as `callJson`: a timeout, a typed
 * failure instead of a throw, and a schema-validated body before any field of it
 * is read. `callJson` cannot be reused because TinEye's upload path is
 * `multipart/form-data`, and the boundary has to come from `fetch`.
 */
async function postForm<T>(opts: {
  url: string;
  form: FormData;
  headers?: Record<string, string>;
  timeoutMs: number;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  label: string;
}): Promise<Result<T, StageFailure>> {
  if (opts.timeoutMs <= 0) {
    return err(failure('budget-exhausted', `${opts.label}: no time left in the search budget`));
  }

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      // No content-type header: fetch must set it so the multipart boundary matches.
      headers: { accept: 'application/json', ...opts.headers },
      body: opts.form,
      signal,
      cache: 'no-store',
    });
  } catch (e) {
    if (timeout.aborted) {
      return err(failure('timeout', `${opts.label} did not respond within ${opts.timeoutMs}ms`));
    }
    return err(failure('unavailable', `${opts.label} unreachable: ${describeError(e)}`));
  }

  if (!res.ok) {
    return err(
      failure(
        res.status >= 500 || res.status === 429 ? 'unavailable' : 'invalid-response',
        `${opts.label} returned HTTP ${res.status}`,
      ),
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    return err(failure('invalid-response', `${opts.label} returned non-JSON: ${describeError(e)}`));
  }

  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return err(failure('invalid-response', `${opts.label} response was off-contract: ${detail}`));
  }
  return ok(parsed.data);
}

/** Copy into a standalone ArrayBuffer so a pooled Buffer's offset can't leak. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function describeMessages(messages: readonly unknown[] | undefined): string {
  if (!messages || messages.length === 0) return '';
  const parts = messages.map((m) => (typeof m === 'string' ? m : JSON.stringify(m)));
  return `: ${parts.join('; ').slice(0, 300)}`;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
