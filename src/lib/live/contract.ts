/**
 * The LIVE analysis contract.
 *
 * Why this exists alongside `src/lib/cascade`: the cascade is the full product
 * pipeline and it hard-requires infrastructure — Supabase for storage and audit,
 * Modal for embeddings, a Mapillary index for retrieval. Correct, but it cannot
 * run until all of that is provisioned, and it fails closed by design.
 *
 * This module is the path that runs with an API key and nothing else. Same
 * contracts (`src/lib/contracts/types.ts`), same integrity rules, but:
 *   - uploads live on local disk under .lantage-uploads, not object storage
 *   - no auth, no audit rows, no org scoping (single-operator local use only)
 *   - every capability degrades to an explicit `not-configured` rather than 503
 *
 * RULE FOR EVERY MODULE HERE: no fabricated values, ever. If a signal cannot be
 * computed, it is absent from the response and the reason is stated. A field that
 * would have to be invented is omitted. There is no demo mode and no sample data.
 */

import type {
  AuthenticityResult,
  Confidence,
  Evidence,
  GeoCandidate,
  QualityGate,
  StageTrace,
  VehicleCandidate,
} from '@/lib/contracts/types';

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

/**
 * The five products, named as the operator thinks of them.
 *
 * LOCATE   — where was this taken (outdoor/street)
 * INTERIOR — which building/home is this inside of
 * FACE     — is the person in image A the same as in image B
 * VEHICLE  — make / model / year / colour
 * AUTHENTIC— was this generated or manipulated
 */
export type LiveModule = 'LOCATE' | 'INTERIOR' | 'FACE' | 'VEHICLE' | 'AUTHENTIC';

export const LIVE_MODULES: readonly LiveModule[] = [
  'LOCATE',
  'INTERIOR',
  'FACE',
  'VEHICLE',
  'AUTHENTIC',
] as const;

export interface ModuleDescriptor {
  id: LiveModule;
  /** Shown in the mode selector. */
  label: string;
  /** One line under the label. Must describe what it actually does, not aspiration. */
  blurb: string;
  /** How many images this module consumes. FACE needs two. */
  images: 1 | 2;
  /** Env vars that must be set for this module to do anything. Empty = works offline. */
  requires: readonly string[];
}

export const MODULE_CATALOGUE: readonly ModuleDescriptor[] = [
  {
    id: 'LOCATE',
    label: 'Locate',
    blurb: 'Where an outdoor photo was taken. Ranked regions with cited visual evidence.',
    images: 1,
    requires: ['vision'],
  },
  {
    id: 'INTERIOR',
    label: 'Interior',
    blurb: 'Which building an indoor photo is inside. Country/region from fixtures, plus published-source lookup.',
    images: 1,
    requires: ['vision'],
  },
  {
    id: 'FACE',
    label: 'Face compare',
    blurb: 'Whether two images show the same person. Local model, closed comparison — no internet face index.',
    images: 2,
    requires: [],
  },
  {
    id: 'VEHICLE',
    label: 'Vehicle',
    blurb: 'Make, model, year and colour, validated against the NHTSA vehicle database.',
    images: 1,
    requires: ['vision'],
  },
  {
    id: 'AUTHENTIC',
    label: 'Authenticity',
    blurb: 'Content Credentials, metadata and JPEG forensics. Runs entirely offline.',
    images: 1,
    requires: [],
  },
] as const;

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

export interface LiveAnalyzeRequest {
  module: LiveModule;
  /** Upload ids returned by POST /api/upload. FACE takes two; everything else one. */
  uploadIds: string[];
  /** Optional operator-supplied narrowing. Narrowing the search is legitimate. */
  hints?: {
    /** Constrain to a bbox: [west, south, east, north]. */
    bbox?: [number, number, number, number];
    /** Known or claimed capture time, ISO 8601. Enables the solar constraint. */
    capturedAt?: string;
    /** Free-text context from the operator, e.g. "believed to be Western PA". */
    note?: string;
  };
}

/** What the operator uploaded, as we actually measured it. Nothing here is guessed. */
export interface UploadRecord {
  id: string;
  filename: string;
  bytes: number;
  mime: string;
  width?: number;
  height?: number;
  sha256: string;
  /** Path on local disk. Server-side only; never serialised to the client. */
  path?: string;
  /** URL the browser can use to render it back. */
  previewUrl: string;
  createdAt: string;
}

export interface LiveAnalyzeResponse {
  id: string;
  module: LiveModule;
  uploads: UploadRecord[];
  quality: QualityGate;
  /** Present for LOCATE and INTERIOR. */
  geo?: GeoCandidate[];
  /** Present for VEHICLE. */
  vehicles?: VehicleCandidate[];
  /** Present for AUTHENTIC. */
  authenticity?: AuthenticityResult;
  /** Present for FACE. */
  face?: FaceComparison;
  /** Present for INTERIOR — where else this image appears publicly. */
  provenanceHits?: ProvenanceHit[];
  /** Evidence not attached to a specific candidate — EXIF, C2PA, operator hints. */
  evidence: Evidence[];
  stages: StageTrace[];
  /** Model + data-source versions. Required for reproducibility. */
  provenance: {
    models: Record<string, string>;
    sources: Record<string, string>;
    totalCostUsd: number;
  };
  /** Capabilities that were unavailable, and exactly what to set to enable them. */
  unavailable: CapabilityGap[];
  createdAt: string;
}

/**
 * A missing capability, reported to the operator instead of silently degrading.
 * This is the mechanism that replaces fake data: when we can't do something we
 * say so, name the env var, and return nothing for that section.
 */
export interface CapabilityGap {
  capability: string;
  /** Why it matters, in one line. */
  impact: string;
  /** e.g. 'ANTHROPIC_API_KEY' */
  envVar?: string;
  /** e.g. 'https://console.anthropic.com/settings/keys' */
  howTo?: string;
}

// ---------------------------------------------------------------------------
// FACE
// ---------------------------------------------------------------------------

/**
 * Strictly a 1:1 comparison between two operator-supplied images.
 *
 * There is no gallery and no index. The verdict is a similarity against a
 * threshold, and it is refused outright when either probe fails the quality gate —
 * on CCTV-grade input the published rank-1 rates for the best models fall to
 * 36-72%, and below roughly 24-32px inter-eye distance a ranking is not
 * defensible. Super-resolution does not help: it restores visual detail without
 * restoring biometric information.
 */
export interface FaceComparison {
  verdict: 'same-person' | 'different-person' | 'inconclusive' | 'refused';
  /** Cosine similarity of the two descriptors, 0..1. Absent when refused. */
  similarity?: number;
  /** The threshold applied, and where it came from. */
  threshold?: { value: number; basis: string };
  confidence: Confidence;
  /** Per-image detection + quality detail, so a refusal is explainable. */
  probes: FaceProbe[];
  /** Populated when verdict === 'refused'. */
  refusalReason?: string;
}

export interface FaceProbe {
  uploadId: string;
  facesDetected: number;
  /** The face actually used, if any. Box in pixels. */
  selected?: { x: number; y: number; w: number; h: number };
  interEyeDistancePx?: number;
  /** Detector confidence for the selected face. */
  detectionScore?: number;
  passedGate: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Provenance (where else this image appears)
// ---------------------------------------------------------------------------

/**
 * A published copy of the uploaded image found on the open web.
 *
 * This is the legitimate route to "which home is this": if the interior was ever
 * published — a listing, a rental page, a news story — reverse image search finds
 * the page without us indexing anyone's photos. We store no third-party pixels;
 * only the URL we were given.
 */
export interface ProvenanceHit {
  url: string;
  title?: string;
  /** Which service returned it. Never presented as our own finding. */
  source: string;
  /** Service-reported match score if provided, otherwise absent. Never invented. */
  score?: number;
  /** Address or place text extracted from the page, if the service supplied it. */
  place?: string;
}

// ---------------------------------------------------------------------------
// Vision provider selection
// ---------------------------------------------------------------------------

export type VisionVendor = 'anthropic' | 'openai' | 'gemini';

const VENDOR_KEY_ENV: Record<VisionVendor, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

/**
 * Deliberately looser than `NodeJS.ProcessEnv`, which requires `NODE_ENV` and so
 * cannot be satisfied by a small object literal. `process.env` still assigns to
 * this, and callers (including tests) can pass just the vars they care about.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

function hasKey(vendor: VisionVendor, env: EnvLike): boolean {
  return VENDOR_KEY_ENV[vendor].some((name) => !!env[name]);
}

/**
 * Which vision vendor to use.
 *
 * `LANTAGE_VISION_VENDOR` forces a specific one. Setting it and then not
 * supplying that vendor's key returns null rather than silently falling through
 * to a different vendor — a result attributed to the wrong model is worse than
 * no result, because `ResultProvenance.models` is what makes a finding
 * reproducible.
 *
 * With no override, the first vendor whose key is present wins, in this order.
 */
export function resolveVisionVendor(env: EnvLike = process.env): VisionVendor | null {
  const forced = env.LANTAGE_VISION_VENDOR?.trim().toLowerCase();
  if (forced) {
    if (forced in VENDOR_KEY_ENV) {
      const vendor = forced as VisionVendor;
      return hasKey(vendor, env) ? vendor : null;
    }
    return null;
  }

  const order: readonly VisionVendor[] = ['anthropic', 'openai', 'gemini'];
  return order.find((vendor) => hasKey(vendor, env)) ?? null;
}

export const VISION_GAP: CapabilityGap = {
  capability: 'Vision analysis',
  impact:
    'Locate, Interior and Vehicle cannot run without a vision model. Authenticity and Face compare still work.',
  envVar: 'ANTHROPIC_API_KEY (or OPENAI_API_KEY)',
  howTo: 'Add it to .env.local in the project root, then restart the dev server.',
};
