/**
 * Verifier — signage OCR -> geocode.
 *
 * This is the highest-yield street-level signal in the whole cascade. A legible
 * business name plus a geocode beats any embedding model, and it is the reason
 * `signage-ocr` is one of only two evidence kinds that can earn street
 * precision: it is a fact about the frame that a human can check in ten seconds.
 *
 * Geocoder policy, which is not optional: the **public** Nominatim instance
 * forbids systematic and grid queries, and ours is exactly that pattern. The
 * planned backend is a self-hosted Nominatim on a US extract (~$35/mo). This
 * module refuses to talk to the public instance in code, not in a comment.
 */

import { z } from 'zod';
import type { Evidence } from '@/lib/contracts/types';
import type { VlmClues } from '@/lib/contracts/schemas';
import { COSTS, ENDPOINTS, MODEL_VERSIONS, TIMEOUTS_MS, VERIFIERS } from '@/lib/cascade/config';
import { type WorkingCandidate, applyMultiplier } from '@/lib/cascade/candidate';
import { haversineM } from '@/lib/cascade/geo';
import { callJson } from '@/lib/cascade/net';
import {
  type Bbox,
  type Result,
  type StageContext,
  type StageFailure,
  type StageOutput,
  err,
  failure,
  ok,
  skipped,
} from '@/lib/cascade/types';

// ---------------------------------------------------------------------------
// Geocoder interface
// ---------------------------------------------------------------------------

export interface GeocodeHit {
  label: string;
  lat: number;
  lon: number;
  bbox?: Bbox;
  /** Nominatim class/type, e.g. "shop"/"supermarket". Kept for the ledger. */
  category?: string;
  /** Provider's own relevance, 0..1. Recalibrated before it means anything. */
  importance?: number;
}

export interface GeocodeOptions {
  /** Restrict to the region prior. Narrowing a search is legitimate. */
  viewbox?: Bbox;
  limit: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface Geocoder {
  readonly name: string;
  geocode(query: string, opts: GeocodeOptions): Promise<Result<GeocodeHit[], StageFailure>>;
}

/** Hosts we must never query systematically. Enforced, not documented. */
const FORBIDDEN_GEOCODER_HOSTS = [
  'nominatim.openstreetmap.org',
  'nominatim.osm.org',
  'osm.org',
];

const NominatimResponseSchema = z.array(
  z.object({
    display_name: z.string(),
    lat: z.string(),
    lon: z.string(),
    boundingbox: z.array(z.string()).length(4).optional(),
    class: z.string().optional(),
    type: z.string().optional(),
    importance: z.number().optional(),
  }),
);

export class NominatimGeocoder implements Geocoder {
  readonly name = MODEL_VERSIONS.geocoder;
  private readonly baseUrl: string | undefined;

  constructor(baseUrl: string | undefined = ENDPOINTS.nominatim) {
    this.baseUrl = baseUrl;
  }

  async geocode(query: string, opts: GeocodeOptions): Promise<Result<GeocodeHit[], StageFailure>> {
    if (!this.baseUrl) {
      return err(
        failure(
          'not-configured',
          'No geocoder configured (NOMINATIM_URL unset), so text found in the frame could not be geocoded. This is the highest-yield street-level signal — wiring the self-hosted instance is the single biggest accuracy win available.',
        ),
      );
    }
    let host: string;
    try {
      host = new URL(this.baseUrl).host.toLowerCase();
    } catch {
      return err(failure('not-configured', 'NOMINATIM_URL is not a valid URL.'));
    }
    if (FORBIDDEN_GEOCODER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      return err(
        failure(
          'policy',
          'Refusing to geocode against the public Nominatim instance: its usage policy forbids systematic and grid queries, which is exactly this workload. Point NOMINATIM_URL at the self-hosted instance.',
        ),
      );
    }

    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(opts.limit));
    url.searchParams.set('addressdetails', '0');
    if (opts.viewbox) {
      url.searchParams.set('viewbox', opts.viewbox.join(','));
      url.searchParams.set('bounded', '1');
    }

    const res = await callJson({
      url: url.toString(),
      method: 'GET',
      schema: NominatimResponseSchema,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      label: 'geocoder',
    });
    if (!res.ok) return res;

    return ok(
      res.value.map((r) => ({
        label: r.display_name,
        lat: Number(r.lat),
        lon: Number(r.lon),
        bbox: r.boundingbox
          ? ([
              Number(r.boundingbox[2]),
              Number(r.boundingbox[0]),
              Number(r.boundingbox[3]),
              Number(r.boundingbox[1]),
            ] as Bbox)
          : undefined,
        category: r.class && r.type ? `${r.class}/${r.type}` : undefined,
        importance: r.importance,
      })),
    );
  }
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

/**
 * Which text clues are worth a geocode call.
 *
 * Phone numbers and plate styles are excluded: a phone number is a lookup
 * against a directory we do not license, and plate characters are prohibited
 * output entirely. `guessed` legibility is excluded because geocoding a
 * hallucinated business name produces a confident wrong street address — the
 * exact failure the GeoRC study documented.
 */
const GEOCODABLE_KINDS = new Set(['business-name', 'street-sign', 'address-number', 'transit-sign']);

export interface OcrGeocodeResult {
  /** Candidates that gained corroboration, by id. */
  corroborated: string[];
  geocodeCalls: number;
}

/**
 * Corroborates existing candidates. It does not seed new ones: a geocoded string
 * with no independent visual match is a place *name* in the frame, not evidence
 * that the frame was taken there, and a delivery van parked outside a business
 * would produce a confident wrong address.
 */
export async function runOcrGeocodeVerifier(args: {
  candidates: WorkingCandidate[];
  clues: VlmClues | null;
  geocoder: Geocoder | null;
  priorBbox?: Bbox;
  ctx: StageContext;
}): Promise<StageOutput<OcrGeocodeResult>> {
  const started = Date.now();
  const { candidates, clues, geocoder, ctx } = args;

  if (!clues) {
    return skipped(
      'verify-ocr',
      Date.now() - started,
      failure('no-input', 'No text clues were extracted, so there was nothing to geocode.'),
    );
  }
  if (!geocoder) {
    return skipped(
      'verify-ocr',
      Date.now() - started,
      failure('not-configured', 'No geocoder is wired, so text clues could not be checked.'),
    );
  }

  const queries = clues.text
    .filter((t) => GEOCODABLE_KINDS.has(t.kind) && t.legibility !== 'guessed')
    .filter((t) => t.observed.trim().length >= 3)
    .slice(0, 4); // Latency budget: 4 calls at ~200ms against a local instance.

  if (queries.length === 0) {
    return skipped(
      'verify-ocr',
      Date.now() - started,
      failure(
        'no-input',
        'No legible business, street, or address text was found in the frame to geocode.',
      ),
    );
  }

  const evidence: Evidence[] = [];
  const result: OcrGeocodeResult = { corroborated: [], geocodeCalls: 0 };

  for (const clue of queries) {
    if (!ctx.budget.canAfford(TIMEOUTS_MS.geocode)) break;
    const res = await geocoder.geocode(clue.observed, {
      viewbox: args.priorBbox,
      limit: 3,
      timeoutMs: ctx.budget.timeoutFor(TIMEOUTS_MS.geocode),
      signal: ctx.signal,
    });
    result.geocodeCalls += 1;
    if (!res.ok || res.value.length === 0) continue;

    for (const hit of res.value.slice(0, 3)) {
      const nearest = nearestCandidate(candidates, hit);
      if (nearest && nearest.distanceM <= VERIFIERS.ocrAgreementRadiusM) {
        const ev = agreementEvidence(clue.observed, hit, nearest.distanceM, clue.bbox, ctx);
        nearest.candidate.evidence.push(ev);
        applyMultiplier(nearest.candidate, VERIFIERS.ocrBoost);
        // Text agreeing with a retrieval match is the strongest combination we
        // produce, and it is what earns street precision.
        nearest.candidate.precision = 'street';
        nearest.candidate.calibrationSet = 'ocrGeocode';
        nearest.candidate.facts = {
          kind: 'ocr-agreement',
          text: clue.observed,
          distanceM: nearest.distanceM,
        };
        if (!result.corroborated.includes(nearest.candidate.id)) {
          result.corroborated.push(nearest.candidate.id);
        }
        evidence.push(ev);
        break;
      }
    }
  }

  const trace = {
    stage: 'verify-ocr' as const,
    ranMs: Date.now() - started,
    costUsd: result.geocodeCalls * COSTS.geocodeUsdPerCall,
  };
  return { evidence, trace, output: result };
}

function nearestCandidate(
  candidates: WorkingCandidate[],
  hit: GeocodeHit,
): { candidate: WorkingCandidate; distanceM: number } | null {
  let best: { candidate: WorkingCandidate; distanceM: number } | null = null;
  for (const candidate of candidates) {
    const distanceM = haversineM(candidate.center, { lat: hit.lat, lon: hit.lon });
    if (!best || distanceM < best.distanceM) best = { candidate, distanceM };
  }
  return best;
}

function agreementEvidence(
  text: string,
  hit: GeocodeHit,
  distanceM: number,
  bbox: readonly number[] | undefined,
  ctx: StageContext,
): Evidence {
  return {
    kind: 'signage-ocr',
    claim: `Text read in the frame — "${text}" — geocodes to ${hit.label}, ${Math.round(distanceM)} m from this candidate.`,
    verifiable: `Read the text yourself in the linked crop, then search "${text}" in any mapping tool and compare the result to this candidate's location. If the text does not say what we claim it says, discard this candidate.`,
    cropUrl: bbox ? cropUrl(ctx.image.imageId, bbox) : undefined,
    reference: {
      label: hit.label,
      url: `https://www.openstreetmap.org/?mlat=${hit.lat}&mlon=${hit.lon}#map=18/${hit.lat}/${hit.lon}`,
    },
    weight: 0.8,
  };
}

/**
 * Citation crop URL convention.
 *
 * TODO(A1/A2): the crop endpoint is not in B2's scope. The bbox travels with the
 * evidence either way, so the UI can crop client-side from the source image if
 * the endpoint never materialises. Do not make evidence depend on it.
 */
export function cropUrl(imageId: string, bbox: readonly number[]): string {
  return `/api/images/${encodeURIComponent(imageId)}/crop?bbox=${bbox.map((n) => n.toFixed(4)).join(',')}`;
}
