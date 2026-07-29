/**
 * VERIFY — AI-generation and manipulation indicators, provenance first.
 *
 * The order is the product (docs/MASTER_PLAN.md §5). Deterministic checks run
 * first and can settle the question on their own; the statistical detector runs
 * last, contributes a band, and is *suppressed entirely* on the documented
 * false-positive classes.
 *
 *   1. C2PA / Content Credentials manifest       cryptographic, cheap
 *   2. EXIF / XMP + JPEG quantization fingerprint deterministic, cheap
 *   3. Statistical detector                       probabilistic, banded
 *   4. Suppression of known FP classes            -> 'inconclusive'
 *   5. PPV at a stated base rate                  the arithmetic the market hides
 *
 * Four rules that are not negotiable:
 *
 *  - **Absence of a C2PA manifest means nothing.** Platforms strip manifests on
 *    upload ~100% of the time. No code path here produces an indicator from it.
 *  - **Never assert authenticity.** `AuthenticityVerdict` has no 'authentic'
 *    member; the ceiling is 'no-indicators-found'.
 *  - **Bands, never a fused point percentage.**
 *  - **No ELA verdict.** Error-level analysis cannot distinguish an edit from
 *    naturally high-frequency content, so it is not implemented here at all — not
 *    as a signal, not as a tiebreak. If it ever ships it is an unlabelled
 *    visualisation for a trained examiner, which is a UI decision, not this one.
 */

import {
  type AuthenticityResult,
  type AuthenticityVerdict,
  type Evidence,
  type EvidenceChain,
  type StageTrace,
  type SuppressionReason,
} from '@/lib/contracts/types';
import { COSTS, QUALITY, TIMEOUTS_MS } from '@/lib/cascade/config';
import {
  calibrate,
  measuredRatesFor,
  positivePredictiveValue,
} from '@/lib/cascade/confidence';
import type { HeaderInfo } from '@/lib/cascade/imageHeader';
import type { MetadataFacts } from '@/lib/cascade/preprocess';
import type { StageContext } from '@/lib/cascade/types';
import { type C2paManifest, type C2paReader, manifestNamesGenerativeTool } from './c2pa';
import type { AiDetectorProvider, DetectorReading } from './detector';
import { readJpeg } from './jpeg';

/**
 * Assumed prevalence of machine-generated imagery in a real SIU caseload.
 *
 * This number drives the PPV the UI must show. It is deliberately low because it
 * is realistically low, and that is the whole point: at a 5% base rate and an 11%
 * false-positive rate, most positive flags are false positives. Override per
 * deployment when a customer has measured their own prevalence.
 */
export const ASSUMED_BASE_RATE = Number(process.env.LANTAGE_AI_BASE_RATE ?? '0.05');

export interface AuthenticityInput {
  bytes: Uint8Array;
  header: HeaderInfo;
  metadata: MetadataFacts;
}

export interface AuthenticityDeps {
  c2pa: C2paReader | null;
  detector: AiDetectorProvider | null;
}

export interface AuthenticityOutcome {
  result: AuthenticityResult;
  traces: StageTrace[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAuthenticity(
  input: AuthenticityInput,
  deps: AuthenticityDeps,
  ctx: StageContext,
): Promise<AuthenticityOutcome> {
  const traces: StageTrace[] = [];
  const evidence: Evidence[] = [];

  // --- 1. Provenance ------------------------------------------------------
  const provenanceStarted = Date.now();
  let manifest: C2paManifest = { hasManifest: false };
  let provenanceSkipped: string | undefined;
  if (deps.c2pa) {
    const read = await deps.c2pa.read(input.bytes);
    if (read.ok) {
      manifest = read.value;
    } else {
      provenanceSkipped = read.error.reason;
    }
  } else {
    provenanceSkipped = 'No Content Credentials reader is wired.';
  }
  evidence.push(provenanceEvidence(manifest, provenanceSkipped));
  traces.push({
    stage: 'provenance',
    ranMs: Date.now() - provenanceStarted,
    costUsd: 0,
    ...(provenanceSkipped ? { skipped: { reason: provenanceSkipped } } : {}),
  });

  // --- 2. Metadata + quantization ----------------------------------------
  const metadataSignals = analyseMetadata(input);
  evidence.push(...metadataSignals.evidence);

  // --- 3. Statistical detector -------------------------------------------
  const detectorStarted = Date.now();
  let reading: DetectorReading | null = null;
  let detectorSkipped: string | undefined;
  if (deps.detector && ctx.budget.canAfford(TIMEOUTS_MS.detector)) {
    const scored = await deps.detector.score({
      image: ctx.image,
      timeoutMs: ctx.budget.timeoutFor(TIMEOUTS_MS.detector),
      signal: ctx.signal,
    });
    if (scored.ok) reading = scored.value;
    else detectorSkipped = scored.error.reason;
  } else {
    detectorSkipped = deps.detector
      ? 'Not enough time left in the budget to run the statistical detector.'
      : 'No statistical detector is configured.';
  }

  // --- 4. Suppression -----------------------------------------------------
  const suppressedBy = detectSuppressionClasses(input);

  const detectorBand = reading
    ? calibrate({
        set: 'aiDetector',
        raw: reading.rawScore,
        independentSignals: 1,
        facts: { kind: 'detector', suppressed: suppressedBy.length > 0 },
      })
    : null;

  if (reading && detectorBand) {
    evidence.push(detectorEvidence(reading, detectorBand.band, suppressedBy));
  }
  traces.push({
    stage: 'detector',
    ranMs: Date.now() - detectorStarted,
    costUsd: reading ? COSTS.detectorUsdPerImage : 0,
    ...(detectorSkipped ? { skipped: { reason: detectorSkipped } } : {}),
  });

  // --- 5. Verdict + PPV ---------------------------------------------------
  const cryptographic = manifest.valid === true && manifestNamesGenerativeTool(manifest);
  const verdict = decideVerdict({
    cryptographicGenerativeClaim: cryptographic,
    metadataGenerativeClaim: metadataSignals.generativeClaim,
    detectorBand: detectorBand?.band ?? null,
    suppressedBy,
  });

  const bandForPpv =
    verdict === 'strong-indicators'
      ? 'high'
      : verdict === 'moderate-indicators'
        ? 'moderate'
        : verdict === 'weak-indicators'
          ? 'weak'
          : 'refused';
  const rates = measuredRatesFor('aiDetector', bandForPpv);

  const independent = new Set(evidence.filter((e) => e.weight > 0).map((e) => e.kind)).size;
  const confidence = cryptographic
    ? calibrate({
        set: 'aiDetector',
        raw: 0.97,
        independentSignals: Math.max(2, independent),
        facts: { kind: 'provenance-manifest', issuer: manifest.issuer, generator: manifest.generator },
      })
    : verdict === 'inconclusive'
      ? calibrate({
          set: 'aiDetector',
          raw: 0,
          independentSignals: independent,
          facts: { kind: 'detector', suppressed: true },
        })
      : verdict === 'no-indicators-found'
        ? calibrate({
            set: 'aiDetector',
            raw: reading?.rawScore ?? 0,
            independentSignals: independent,
            facts: { kind: 'no-indicators' },
          })
        : calibrate({
            set: 'aiDetector',
            raw: reading?.rawScore ?? (metadataSignals.generativeClaim ? 0.7 : 0.2),
            independentSignals: independent,
            facts: { kind: 'detector', suppressed: false },
          });

  const chain = toChain(evidence);
  const result: AuthenticityResult = {
    verdict,
    confidence,
    evidence: chain,
    ...(verdict === 'inconclusive' && suppressedBy.length > 0 ? { suppressedBy } : {}),
    ppv: {
      value: positivePredictiveValue(rates, ASSUMED_BASE_RATE),
      assumedBaseRate: ASSUMED_BASE_RATE,
    },
    provenance: {
      hasManifest: manifest.hasManifest,
      ...(manifest.issuer ? { issuer: manifest.issuer } : {}),
      ...(manifest.valid === undefined ? {} : { valid: manifest.valid }),
      ...(manifest.generator ? { generator: manifest.generator } : {}),
    },
  };

  return { result, traces };
}

// ---------------------------------------------------------------------------
// Verdict rules
// ---------------------------------------------------------------------------

/**
 * The rule table, written out rather than scored, because "what would have to be
 * true for this verdict" is a question we will be asked in discovery.
 *
 * Note the asymmetries:
 *  - only a *cryptographic* claim reaches 'strong-indicators' on its own; an EXIF
 *    software string is editable, so it earns 'moderate' at most;
 *  - a lone detector reading never reaches 'strong' — the contract reserves that
 *    for multiple independent signals agreeing;
 *  - suppression overrides probabilistic findings but never a cryptographic one.
 */
export function decideVerdict(args: {
  cryptographicGenerativeClaim: boolean;
  metadataGenerativeClaim: boolean;
  detectorBand: 'high' | 'moderate' | 'weak' | 'refused' | null;
  suppressedBy: SuppressionReason[];
}): AuthenticityVerdict {
  if (args.cryptographicGenerativeClaim) return 'strong-indicators';

  const suppressed = args.suppressedBy.length > 0;
  const detectorPositive = args.detectorBand === 'high' || args.detectorBand === 'moderate';

  if (suppressed && (detectorPositive || args.detectorBand === 'weak' || args.detectorBand === null)) {
    // The detector's calibration does not hold on these inputs, so reporting any
    // verdict derived from it — including a negative one — would be misleading.
    return 'inconclusive';
  }

  if (args.metadataGenerativeClaim && args.detectorBand === 'high') return 'strong-indicators';
  if (args.metadataGenerativeClaim) return 'moderate-indicators';
  if (args.detectorBand === 'high') return 'moderate-indicators';
  if (args.detectorBand === 'moderate') return 'weak-indicators';
  return 'no-indicators-found';
}

// ---------------------------------------------------------------------------
// Deterministic signals
// ---------------------------------------------------------------------------

const GENERATIVE_SOFTWARE = [
  'stable diffusion',
  'midjourney',
  'dall',
  'sora',
  'firefly',
  'imagen',
  'gemini',
  'flux',
  'ideogram',
  'automatic1111',
  'comfyui',
  'invokeai',
  'novelai',
  'grok',
];

const UPSCALER_SOFTWARE = [
  'topaz',
  'gigapixel',
  'upscayl',
  'magnific',
  'real-esrgan',
  'esrgan',
  'waifu2x',
  'lets enhance',
  "let's enhance",
];

const RETOUCH_SOFTWARE = ['photoshop', 'lightroom', 'luminar', 'facetune', 'portraitpro', 'capture one'];

const COMPUTATIONAL_PHOTOGRAPHY = [
  'hdr',
  'night mode',
  'deep fusion',
  'photonic engine',
  'scene optimizer',
  'super night',
  'nightsight',
  'night sight',
  'smart hdr',
];

function analyseMetadata(input: AuthenticityInput): {
  evidence: Evidence[];
  generativeClaim: boolean;
} {
  const evidence: Evidence[] = [];
  const software = (input.metadata.software ?? '').toLowerCase();
  const sourceType = (input.metadata.digitalSourceType ?? '').toLowerCase();

  const generativeClaim =
    GENERATIVE_SOFTWARE.some((s) => software.includes(s)) ||
    sourceType.includes('trainedalgorithmicmedia') ||
    sourceType.includes('compositewithtrainedalgorithmicmedia');

  if (generativeClaim) {
    evidence.push({
      kind: 'exif',
      claim: `Metadata names a generative pipeline${input.metadata.software ? ` ("${input.metadata.software}")` : ''}${input.metadata.digitalSourceType ? ` and declares digitalSourceType "${input.metadata.digitalSourceType}"` : ''}.`,
      verifiable:
        'Run `exiftool` on the original file and read the Software and DigitalSourceType tags yourself. Metadata is editable, so this is a lead to confirm, not proof — but a tag naming a generator is rarely there by accident.',
      weight: 0.55,
    });
  }

  if (input.header.format === 'jpeg') {
    const jpeg = readJpeg(input.bytes);
    if (jpeg.quantFingerprint) {
      const parts = [
        jpeg.estimatedQuality !== undefined ? `estimated quality ~${jpeg.estimatedQuality}` : null,
        jpeg.mode ? `${jpeg.mode} encoding` : null,
        jpeg.chromaSubsampling ? `chroma subsampling ${jpeg.chromaSubsampling}` : null,
        jpeg.markers.hasAdobeApp14 ? 'an Adobe APP14 marker' : null,
        jpeg.markers.hasIccProfile ? 'an embedded ICC profile' : null,
        jpeg.markers.hasExifApp1 ? 'an EXIF block' : 'no EXIF block',
      ].filter(Boolean);
      evidence.push({
        kind: 'quantization',
        claim: `JPEG quantization fingerprint ${jpeg.quantFingerprint}: ${parts.join(', ')}. This describes the file's processing history, not whether its content is true.`,
        verifiable:
          'Run `exiftool -htmlDump` or `djpeg -verbose` on the original and compare the quantization tables. Identical fingerprints mean two files came out of the same encoder at the same setting — useful for spotting a re-save or a platform round-trip.',
        weight: 0.1,
      });
    }
  }

  return { evidence, generativeClaim };
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * The documented false-positive classes. Each one is a condition under which the
 * statistical detector's calibration does not hold, so a verdict derived from it
 * would be worse than no verdict.
 */
export function detectSuppressionClasses(input: AuthenticityInput): SuppressionReason[] {
  const out = new Set<SuppressionReason>();
  const software = (input.metadata.software ?? '').toLowerCase();
  const longEdge = Math.max(input.header.width ?? 0, input.header.height ?? 0);

  if (longEdge > 0 && longEdge < QUALITY.refuseLongEdgePx) out.add('resolution-too-low');

  if (COMPUTATIONAL_PHOTOGRAPHY.some((s) => software.includes(s))) {
    out.add('computational-photography');
  }
  if (UPSCALER_SOFTWARE.some((s) => software.includes(s))) out.add('ai-upscaled');
  if (RETOUCH_SOFTWARE.some((s) => software.includes(s))) out.add('heavy-retouching');

  if (input.header.format === 'jpeg') {
    const jpeg = readJpeg(input.bytes);
    if (jpeg.markers.hasAdobeApp14) out.add('heavy-retouching');
    // A stripped EXIF block plus a mid/low quality table is the signature of a
    // platform re-encode, which is most of a real caseload.
    if (
      jpeg.estimatedQuality !== undefined &&
      jpeg.estimatedQuality < 80 &&
      !jpeg.markers.hasExifApp1
    ) {
      out.add('recompressed');
    }
    if (jpeg.estimatedQuality !== undefined && jpeg.estimatedQuality < 60) out.add('recompressed');
  }

  if (isLikelyScreenshot(input)) out.add('screenshot');

  return [...out];
}

/**
 * Screenshot heuristics: no camera metadata plus dimensions that match a common
 * display or device screen. Conservative on purpose — a false 'screenshot' call
 * suppresses a verdict, and suppressing a real finding is its own failure.
 */
function isLikelyScreenshot(input: AuthenticityInput): boolean {
  const w = input.header.width ?? 0;
  const h = input.header.height ?? 0;
  if (w === 0 || h === 0) return false;
  const hasCamera = Boolean(input.metadata.cameraMake || input.metadata.cameraModel);
  if (hasCamera) return false;

  const key = `${Math.max(w, h)}x${Math.min(w, h)}`;
  const SCREEN_SIZES = new Set([
    '2560x1440',
    '3840x2160',
    '1920x1080',
    '1366x768',
    '1440x900',
    '2880x1800',
    '3024x1964',
    '3456x2234',
    '2796x1290', // iPhone 14/15/16 Pro Max
    '2556x1179',
    '2532x1170',
    '2778x1284',
    '2436x1125',
    '2732x2048', // iPad Pro
  ]);
  const softwareSaysScreenshot = (input.metadata.software ?? '').toLowerCase().includes('screenshot');
  return SCREEN_SIZES.has(key) || softwareSaysScreenshot;
}

// ---------------------------------------------------------------------------
// Evidence builders
// ---------------------------------------------------------------------------

function provenanceEvidence(manifest: C2paManifest, skippedReason?: string): Evidence {
  if (manifest.hasManifest && manifest.valid === true) {
    return {
      kind: 'c2pa',
      claim: `A valid Content Credentials manifest is present${manifest.issuer ? `, issued by ${manifest.issuer}` : ''}${manifest.generator ? `, naming ${manifest.generator}` : ''}.`,
      verifiable:
        'Run `c2patool <file>` or open the file at contentcredentials.org/verify. The signature is checkable without trusting us at all, which is what makes this the strongest line in the report.',
      reference: { label: 'Verify at contentcredentials.org', url: 'https://contentcredentials.org/verify' },
      weight: 0.9,
    };
  }
  if (manifest.hasManifest) {
    return {
      kind: 'c2pa',
      claim:
        'A Content Credentials manifest is present in the container but has not been cryptographically verified here, so it carries no weight either way yet.',
      verifiable:
        'Run `c2patool <file>` to validate the signature chain and read the claim. Until that is done, treat the manifest as unread rather than as evidence.',
      reference: { label: 'Verify at contentcredentials.org', url: 'https://contentcredentials.org/verify' },
      weight: 0,
    };
  }
  return {
    kind: 'c2pa',
    claim: `No Content Credentials manifest is present.${skippedReason ? ` (${skippedReason})` : ''} This is the normal case and is NOT evidence of manipulation: platforms strip manifests on upload approximately 100% of the time.`,
    verifiable:
      'Run `c2patool <file>` yourself and you will find nothing either. Absence of a manifest tells you about the delivery path, not about the image.',
    weight: 0,
  };
}

function detectorEvidence(
  reading: DetectorReading,
  band: 'high' | 'moderate' | 'weak' | 'refused',
  suppressedBy: SuppressionReason[],
): Evidence {
  const suppressed = suppressedBy.length > 0;
  return {
    kind: 'detector',
    claim: suppressed
      ? `A statistical detector (${reading.modelVersion}) produced a reading, but this image falls into a known false-positive class (${suppressedBy.join(', ')}) where the detector's calibration does not hold. The reading is not reportable.`
      : `A statistical detector (${reading.modelVersion}) places this image in the '${band}' indicator band. Bands are published with their measured false-positive rate; the underlying score is not a probability and is not shown.`,
    verifiable:
      'Run the same image through an independent detector and compare bands, and read the published error rate for this band on the BENCH page named in the result provenance. On in-the-wild media the best commercial detectors reach about 82% accuracy, so a single reading is a lead, not a finding.',
    weight: suppressed ? 0 : band === 'high' ? 0.5 : band === 'moderate' ? 0.3 : 0.15,
  };
}

/** The contract's evidence chain is non-empty by construction. */
function toChain(evidence: Evidence[]): EvidenceChain {
  if (evidence.length === 0) {
    // Unreachable: the provenance line is always pushed. Kept because the type
    // demands a first element and an empty ledger row must never be shippable.
    return [
      {
        kind: 'c2pa',
        claim: 'No checks completed on this image.',
        verifiable: 'Re-run the verification; no signal was recorded, so nothing here is assertable.',
        weight: 0,
      },
    ];
  }
  return evidence as EvidenceChain;
}
