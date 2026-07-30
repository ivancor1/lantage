/**
 * AUTHENTIC — the module that needs no keys, wired to the LIVE path.
 *
 * This is the one product here that is fully useful offline, and that is the
 * selling point rather than a fallback: Content Credentials, EXIF/XMP and the
 * JPEG quantization fingerprint are deterministic, free, and checkable by the
 * operator with `c2patool` and `exiftool` on the same file. The statistical
 * detector is the only stage that costs anything, it runs last, and its absence
 * is reported as a capability gap rather than silently changing the answer.
 *
 * Nothing in this file re-implements `src/lib/verify/authenticity.ts`. That module
 * owns the rule table, the suppression classes and the PPV arithmetic; this one
 * supplies it with measured inputs, wires the readers it takes as dependencies,
 * and translates its output into the LIVE envelope.
 *
 * The two rules most easily broken by a wrapper like this, restated:
 *
 *  - **Absence of a C2PA manifest means nothing.** Platforms strip manifests on
 *    upload essentially always. No code path here turns absence into an indicator,
 *    and the evidence line says so in as many words.
 *  - **Never assert authenticity.** The verdict vocabulary has no `authentic`
 *    member on purpose. The best available answer is `no-indicators-found`.
 */

import { MODEL_VERSIONS, TIMEOUTS_MS } from '@/lib/cascade/config';
import type { HeaderInfo } from '@/lib/cascade/imageHeader';
import type { MetadataFacts } from '@/lib/cascade/preprocess';
import { Budget, type ImageRef } from '@/lib/cascade/types';
import type { AuthenticityResult, Evidence, StageTrace } from '@/lib/contracts/types';
import { runAuthenticity } from '@/lib/verify/authenticity';
import { ContainerC2paProbe } from '@/lib/verify/c2pa';
import { HiveAiDetector } from '@/lib/verify/detector';
import type { CapabilityGap, UploadRecord } from './contract';

// ---------------------------------------------------------------------------
// Capability gaps
// ---------------------------------------------------------------------------

/**
 * The detector is genuinely optional, and the honest framing matters: the stage
 * that is missing is also the least reliable one. Best commercial accuracy on
 * in-the-wild media is 82%, and a 2026 NewsGuard audit found the worst detector
 * flagged 40% of real photographs as AI. The deterministic checks that did run
 * are worth more per unit of confidence than the one that did not.
 */
export const DETECTOR_GAP: CapabilityGap = {
  capability: 'Statistical AI-generation detector',
  impact:
    'The deterministic checks ran and are reported below. The statistical stage did not, so no probabilistic band contributed to the verdict — which also means no false positive from it. It is the only stage here that needs a key, and the least reliable one.',
  envVar: 'HIVE_API_KEY + HIVE_API_URL',
  howTo:
    'Add both to .env.local and restart the dev server. Read the measured false-positive rate for each band before trusting a flag.',
};

/**
 * Presence of a manifest is a fact about the bytes; validity is not. Until a
 * validating reader is wired, a present-but-unverified manifest is treated as no
 * evidence either way — so this gap is reported only when there is actually a
 * manifest sitting there unread.
 */
export const C2PA_VALIDATION_GAP: CapabilityGap = {
  capability: 'Content Credentials signature validation',
  impact:
    'A Content Credentials manifest is present in this file but its signature chain was not verified here, so it contributes nothing to the verdict. A valid manifest naming a generative tool is the strongest finding this product can make — it is worth checking by hand.',
  howTo:
    'Run `c2patool <file>` locally, or upload the file at contentcredentials.org/verify, and read the claim yourself.',
};

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

/**
 * Structurally satisfied by the orchestrator's `ResolvedImage`. Declared narrowly
 * so a test can construct one without touching the upload store.
 */
export interface AuthenticImage {
  record: UploadRecord;
  bytes: Uint8Array;
  header: HeaderInfo;
  metadata: MetadataFacts;
}

export interface AuthenticInput {
  image: AuthenticImage;
  signal?: AbortSignal;
  /** Read for the detector's credentials. Defaults to the process environment. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The LIVE envelope for this module. */
export interface AuthenticOutput {
  authenticity: AuthenticityResult;
  /** Metadata facts, recorded and never relied on. The verdict chain lives on `authenticity`. */
  evidence: Evidence[];
  stages: StageTrace[];
  gaps: CapabilityGap[];
  models: Record<string, string>;
  sources: Record<string, string>;
  costUsd: number;
}

/**
 * Wall-clock ceiling. Everything except the detector is local and sub-millisecond;
 * the budget exists so the detector call cannot hang the request, and it must be
 * larger than that call's own timeout or the stage would skip as unaffordable.
 */
export const AUTHENTIC_BUDGET_MS = TIMEOUTS_MS.detector + TIMEOUTS_MS.c2pa + 2_000;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Never throws. A stage that cannot run degrades into a trace plus a gap. */
export async function analyzeAuthenticity(input: AuthenticInput): Promise<AuthenticOutput> {
  const env = input.env ?? process.env;
  const gaps: CapabilityGap[] = [];
  const models: Record<string, string> = {};

  const c2pa = new ContainerC2paProbe();
  models.c2pa = c2pa.name;

  // The detector is constructed only when both halves of its configuration are
  // present. Handing `runAuthenticity` a provider that will immediately return
  // `not-configured` would report the same thing twice and cost a stage.
  const detectorKey = env.HIVE_API_KEY;
  const detectorUrl = env.HIVE_API_URL;
  const detector = detectorKey && detectorUrl ? new HiveAiDetector(detectorKey, detectorUrl) : null;
  if (!detector) gaps.push(DETECTOR_GAP);

  const image: ImageRef = {
    imageId: input.image.record.id,
    bytes: input.image.bytes,
    mimeType: input.image.record.mime,
  };

  // `runAuthenticity` requires a StageContext. There is no streaming consumer for
  // this module's internals, so `emit` is a sink and the abort signal is the
  // request's when it has one.
  const controller = new AbortController();
  const outcome = await runAuthenticity(
    { bytes: input.image.bytes, header: input.image.header, metadata: input.image.metadata },
    { c2pa, detector },
    {
      searchId: input.image.record.id,
      image,
      budget: new Budget(AUTHENTIC_BUDGET_MS),
      signal: input.signal ?? controller.signal,
      emit: (): void => undefined,
    },
  );

  const detectorRan = outcome.traces.some((t) => t.stage === 'detector' && !t.skipped);
  if (detectorRan) models.detector = MODEL_VERSIONS.detector;

  if (outcome.result.provenance.hasManifest && outcome.result.provenance.valid === undefined) {
    gaps.push(C2PA_VALIDATION_GAP);
  }

  return {
    authenticity: outcome.result,
    evidence: metadataEvidence(input.image),
    stages: outcome.traces,
    gaps,
    models,
    // Nothing external was consulted: every check above reads the operator's own
    // bytes. An empty map is the true statement here.
    sources: {},
    costUsd: outcome.traces.reduce((sum, t) => sum + (t.costUsd ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Metadata evidence — recorded, never trusted
// ---------------------------------------------------------------------------

/**
 * EXIF/XMP facts as evidence with **weight 0**.
 *
 * Zero is not a placeholder. Metadata is trivially editable, so it never moves a
 * verdict; it is in the ledger because the chain of custody needs it and because
 * an analyst comparing our report against their own `exiftool` output must find
 * the same values. The generative-software and DigitalSourceType readings are the
 * one exception, and they are made by `verify/authenticity.ts` with a real weight.
 */
function metadataEvidence(image: AuthenticImage): Evidence[] {
  const m = image.metadata;
  const evidence: Evidence[] = [];

  if (m.gps) {
    evidence.push({
      kind: 'exif',
      claim: `The file's EXIF block claims ${m.gps.lat.toFixed(5)}, ${m.gps.lon.toFixed(5)}. Recorded, not relied on.`,
      verifiable:
        'Run `exiftool` on the original file to confirm the tag exists, then check whether anything visible in the frame agrees with that coordinate. EXIF GPS is trivially editable and is treated here as a claim to test, not a location.',
      reference: {
        label: 'EXIF GPS claim',
        url: `https://www.openstreetmap.org/?mlat=${m.gps.lat}&mlon=${m.gps.lon}#map=17/${m.gps.lat}/${m.gps.lon}`,
      },
      weight: 0,
    });
  }

  if (m.cameraMake || m.cameraModel || m.software || m.capturedAt || m.lensModel) {
    const parts = [
      m.cameraMake && m.cameraModel ? `${m.cameraMake} ${m.cameraModel}` : (m.cameraMake ?? m.cameraModel),
      m.lensModel ? `lens "${m.lensModel}"` : undefined,
      m.software ? `software "${m.software}"` : undefined,
      m.capturedAt ? `capture time ${m.capturedAt}` : undefined,
    ].filter((p): p is string => Boolean(p));
    evidence.push({
      kind: 'exif',
      claim: `Metadata present (${m.tagCount} tags): ${parts.join(', ')}.`,
      verifiable:
        'Run `exiftool` on the original file and compare every value. A camera make and model consistent with the rest of the file is weak corroboration at best — the tags can be written by hand.',
      weight: 0,
    });
  }

  if (m.stripped) {
    evidence.push({
      kind: 'exif',
      claim: `No metadata at all in this ${image.header.format.toUpperCase()} container. This is the normal case for anything that has been through a platform, and it is not a finding.`,
      verifiable:
        'Run `exiftool` on the original file and you will find nothing either. Absence of metadata tells you about the delivery path, not about the image.',
      weight: 0,
    });
  }

  const px =
    image.header.width && image.header.height
      ? `${image.header.width}x${image.header.height}`
      : null;
  if (px) {
    evidence.push({
      kind: 'exif',
      claim: `Container reports ${px} px (${image.header.format.toUpperCase()}, ${image.bytes.byteLength} bytes${image.header.bitsPerPixel ? `, ${image.header.bitsPerPixel.toFixed(2)} bits per pixel` : ''}). Read from the container header, not from EXIF.`,
      verifiable:
        'Run `exiftool -ImageWidth -ImageHeight` or `identify` on the original. A file whose EXIF dimensions disagree with its container header has been edited by something that did not update both.',
      weight: 0,
    });
  }

  return evidence;
}
