/**
 * FACE — strictly 1:1 comparison of two operator-supplied images.
 *
 * SCOPE, NON-NEGOTIABLE. There is no gallery, no enrolment, and no internet face
 * index in this module, and one must never be added. That architecture is what
 * got Clearview permanently barred from selling face-database access to any US
 * private entity, barred from Illinois government customers until 2027-05-11,
 * and fined across five jurisdictions (€20M Italy, €20M Greece, €20M+€5.2M
 * France, €30.5M Netherlands, £7.55M UK) — plus a US class settlement valued at
 * ~$51.75M. EU AI Act Art. 5(1)(e) makes untargeted scraping of facial images a
 * *prohibited* practice with no law-enforcement exception. See
 * docs/MASTER_PLAN.md §1 and §7. Two images in, one similarity out.
 *
 * BIOMETRICS NEVER LEAVE THE MACHINE. Both models run locally through
 * onnxruntime-node. No API key, no third-party upload of a face. The only
 * network access this module can ever make is a one-time fetch of the model
 * weights themselves from the OpenCV Zoo, and that can be turned off entirely
 * (LANTAGE_FACE_MODEL_FETCH=0).
 *
 * THE QUALITY GATE IS THE FEATURE. Published numbers this module is built
 * around: the practical recognition floor is ~21px inter-eye with 40px
 * recommended and ISO/IEC 39794-5 asking 90px for enrolment; on IJB-S
 * surveillance→surveillance the best models reach 36.7% rank-1 and on TinyFace
 * (~20×16px faces) 72–75% rank-1 in a *closed* set. Below
 * GATE.refuseInterEyePx we refuse to return a verdict at all.
 *
 * SUPER-RESOLUTION CANNOT BUY ITS WAY PAST THE GATE. IEEE 2025 found that
 * upscaling preserves visual detail without recovering biometric information, so
 * two defences apply. First, inter-eye distance is measured in the supplied
 * file's own pixels, never in the detector's resized 640px frame. Second — and
 * this is the one that matters — the face region is tested for an interpolation
 * signature (`estimateResampleFactor`), and the gate runs on the EFFECTIVE
 * inter-eye distance, apparent divided by the detected upscale factor. A 130px
 * thumbnail enlarged to 1300px presents a 160px inter-eye distance and would
 * otherwise sail through; measured against its ~16px of real captured detail, it
 * does not.
 *
 * NO FABRICATED VALUES. If a descriptor cannot be computed, `similarity` is
 * absent and the reason is stated. If the model cannot be loaded, the verdict is
 * 'refused' with a CapabilityGap — never a vision-model opinion dressed up as a
 * biometric match.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InferenceSession } from 'onnxruntime-node';
import {
  bandCeiling,
  type Confidence,
  type ConfidenceBand,
  type QualityGate,
  type StageTrace,
} from '@/lib/contracts/types';
import type { CapabilityGap, FaceComparison, FaceProbe } from '@/lib/live/contract';
import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';

// ---------------------------------------------------------------------------
// Public input / output
// ---------------------------------------------------------------------------

/** One of the two operator-supplied images. Bytes preferred; path is read if absent. */
export interface FaceImage {
  uploadId: string;
  bytes?: Uint8Array;
  /** Absolute path on local disk (uploads live under .lantage-uploads). */
  path?: string;
}

export interface FaceCompareOptions {
  /** Wall-clock ceiling for the whole comparison, excluding a cold model fetch. */
  timeoutMs?: number;
  /** Override the weights directory. Defaults to LANTAGE_FACE_MODEL_DIR or ./.lantage-models/face. */
  modelDir?: string;
  signal?: AbortSignal;
}

/**
 * Everything the LIVE response needs. `compareFaces` is the narrow contract the
 * product spec asks for; this is what the route wants, so the quality gate,
 * stage timings and capability gaps are not thrown away.
 */
export interface FaceCompareRun {
  face: FaceComparison;
  quality: QualityGate;
  stages: StageTrace[];
  gaps: CapabilityGap[];
  models: Record<string, string>;
  /** Always 0: both models run locally on the operator's CPU. Nothing is billed per call. */
  costUsd: number;
}

// ---------------------------------------------------------------------------
// The models, and why these two
// ---------------------------------------------------------------------------

/**
 * Weights licence is the deciding factor here, and it eliminated the obvious
 * candidates:
 *
 *  - `@vladmandic/face-api`: archived 2025-02-05 and its own README states
 *    "NodeJS version 23 and higher are not supported due to incompatibility with
 *    TensorFlow/JS". We run Node 26. Dead on arrival.
 *  - `@vladmandic/human`: same TFJS constraint ("NodeJS version 23.x is not
 *    supported due to breaking changes and issues with @tensorflow/tfjs").
 *  - InsightFace (SCRFD + ArcFace/buffalo_l): the strongest open models, but the
 *    pretrained weights are released for non-commercial research use only. Not
 *    shippable in a product we intend to sell.
 *
 * What is left is an ONNX Runtime pipeline over the OpenCV Zoo, where the
 * *weights themselves* carry permissive licences, stated per-directory in the
 * upstream repo:
 *
 *  - Detection: YuNet (`face_detection_yunet_2023mar.onnx`) — "All files in this
 *    directory are licensed under MIT License". 232KB, 5 landmarks
 *    (right eye, left eye, nose tip, right/left mouth corner) which is exactly
 *    what the inter-eye gate and the ArcFace-template alignment need.
 *  - Recognition: SFace (`face_recognition_sface_2021dec.onnx`) — "All files in
 *    this directory are licensed under Apache 2.0 License". MobileFaceNet
 *    trained with the SFace loss (arXiv:2205.12010); 128-d descriptor.
 *
 * Both are the models behind OpenCV's own `FaceDetectorYN` / `FaceRecognizerSF`,
 * so the pre/post-processing below is a port of OpenCV's C++ implementation
 * rather than a guess, and the operating point is OpenCV's published one.
 */
export const FACE_MODEL = {
  detector: {
    file: 'face_detection_yunet_2023mar.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    version: 'yunet@2023mar',
    licence: 'MIT (code + weights, opencv/opencv_zoo)',
  },
  recogniser: {
    file: 'face_recognition_sface_2021dec.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    version: 'sface@2021dec',
    licence: 'Apache-2.0 (code + weights, opencv/opencv_zoo)',
  },
} as const;

/**
 * The decision threshold, and where the number comes from.
 *
 * 0.363 is OpenCV Zoo's published cosine operating point for this exact
 * checkpoint (`models/face_recognition_sface/sface.py`:
 * `self._threshold_cosine = 0.363`, matched by `self._threshold_norml2 = 1.128`).
 * It is the reference threshold for `face_recognition_sface_2021dec`, reported
 * alongside 0.9932–0.9942 verification accuracy on the zoo's evaluation set.
 *
 * It is NOT a Lantage-calibrated FAR operating point. We have not measured this
 * model's false-match rate on our own held-out set, and until BENCH does, the
 * band is capped accordingly (see `confidenceFor`). NISTIR 8280 is the reason
 * that matters: 1:1 false-match rates were elevated 10–100× for West/East
 * African and East Asian faces in many algorithms, so an uncalibrated threshold
 * is a per-demographic unknown, not a global constant.
 */
export const FACE_THRESHOLD = {
  value: 0.363,
  basis:
    "OpenCV Zoo reference cosine threshold for face_recognition_sface_2021dec (sface.py: _threshold_cosine = 0.363; L2 equivalent 1.128). Vendor/model-card operating point, NOT a Lantage-calibrated FAR point — no held-out calibration set has been fitted for this model, and NISTIR 8280 found 1:1 false-match rates elevated 10-100x for some demographic groups, so treat it as a single global approximation.",
} as const;

/**
 * Half-width of the band around the threshold in which we return
 * 'inconclusive' rather than forcing a binary call.
 *
 * This is a Lantage product choice, not a published number, and it is named so
 * that it is obviously ours: cosine scores within ±0.05 of an uncalibrated
 * threshold are inside the noise we cannot currently quantify, and a coin-flip
 * dressed as a verdict is the failure mode this whole product exists to avoid.
 */
export const FACE_INCONCLUSIVE_MARGIN = 0.05;

/**
 * Inter-eye distance ladder, in ORIGINAL-image pixels.
 *
 * refuse:      below this we return no verdict. 32px is the conservative end of
 *              the 24-32px band in docs/MASTER_PLAN.md §1 — the point below
 *              which a ranking stops being defensible.
 * recommended: 40px, the published "recommended" figure. Between refuse and
 *              recommended we proceed with the band capped at 'weak'.
 * enrolment:   90px, what ISO/IEC 39794-5 asks for enrolment-grade capture.
 *              Reported for context; nothing is gated on it.
 */
export const FACE_GATE = {
  refuseInterEyePx: 32,
  recommendedInterEyePx: 40,
  enrolmentInterEyePx: 90,
  /** Detector confidence floor for a usable face. YuNet score = sqrt(cls * obj). */
  minDetectionScore: 0.6,
} as const;

/**
 * Interpolation-signature detection, so an upscaled probe is gated on the
 * detail it actually contains rather than the pixel count it advertises.
 *
 * Method: box-downsample the greyscale face crop by k, bilinearly restore it to
 * the original size, and measure the reconstruction error normalised by the
 * crop's own standard deviation. If the octave we threw away carried no energy —
 * because those pixels were interpolated rather than captured — the round trip
 * is nearly lossless. The largest k that round-trips within tolerance is the
 * estimated upscale factor.
 *
 * `tolerance` is measured, not chosen. On the public-domain portraits used to
 * validate this module, at k=2: native face crops scored 0.117-0.459 (a
 * JPEG-quality-40 recompression of a native crop still scored 0.117, so ordinary
 * compression does not trip it), while the same crop upscaled 2x scored 0.046,
 * upscaled 4x scored 0.018, and a 130px frame upscaled 10x scored 0.047. 0.08
 * sits with ~1.5x margin on the captured side and ~1.7x on the interpolated one.
 *
 * Nearest-neighbour enlargement is handled separately by
 * `blockReplicationFactor`, because block replication is invisible to this
 * statistic: box-down plus bilinear-up smooths across block edges the original
 * never had, so the round trip looks lossy even though no information was
 * captured.
 *
 * MEASURED COVERAGE, so nobody over-trusts this. Enlarging a 90px photographic
 * face crop and re-measuring gave, consistently across two portraits and the
 * lanczos3 / cubic / nearest kernels:
 *
 *   native 654px crop      -> 1  (no false positive)
 *   native 90px crop       -> 1  (no false positive)
 *   2x enlargement         -> 1  MISSED
 *   4x enlargement         -> 2  detected, factor under-reported
 *   8x enlargement         -> 4  detected, factor under-reported
 *
 * So: no false positives on native captures, reliable detection from ~4x, and a
 * factor that is always an under-estimate. The 2x miss is tolerable because a
 * probe small enough to matter is still refused on its apparent distance — 2x of
 * a 90px crop is a ~25px inter-eye, under the floor either way. The case this
 * exists to catch is the thumbnail blown up many times to look like a portrait,
 * and that is caught.
 *
 * Because the factor is a LOWER BOUND, everything downstream treats it as "at
 * least this much": a detected resample marks the input degraded (capping the
 * band) and raises the floor the effective distance has to clear.
 *
 * Known blind spot, stated rather than papered over: a learned super-resolution
 * model that hallucinates plausible high-frequency detail need not leave a band
 * limit to find. That is a detection gap, not a licence to trust the probe —
 * which is exactly why a detected upscale is held to the enrolment threshold
 * rather than the ordinary floor.
 */
export const FACE_RESAMPLE = {
  tolerance: 0.08,
  /** Largest first: we want the largest factor that round-trips losslessly. */
  factors: [4, 3, 2] as const,
  /** Below this the crop is too small for the statistic to mean anything. */
  minSidePx: 24,
} as const;

const FACE_TIMEOUTS_MS = {
  /** Whole comparison once the weights are on disk. CPU inference, two images. */
  compare: 30_000,
  /** One-time weights fetch. 38MB for SFace, so this is generous on purpose. */
  download: 180_000,
} as const;

/**
 * Reported when the weights cannot be loaded. There is deliberately no fallback
 * path: a face match is a biometric claim, and a vision model's opinion is not
 * one.
 */
export const FACE_MODEL_GAP: CapabilityGap = {
  capability: 'Local face recognition model',
  impact:
    'Face compare returns no verdict. The comparison is refused rather than substituted with a vision-model opinion, because a similarity score is a biometric measurement and a language model cannot produce one.',
  envVar: 'LANTAGE_FACE_MODEL_DIR',
  howTo: `Place the two ONNX files in .lantage-models/face (or set LANTAGE_FACE_MODEL_DIR):\n  curl -sSL -o .lantage-models/face/${FACE_MODEL.detector.file} ${FACE_MODEL.detector.url}\n  curl -sSL -o .lantage-models/face/${FACE_MODEL.recogniser.file} ${FACE_MODEL.recogniser.url}\nSet LANTAGE_FACE_MODEL_FETCH=0 to stop Lantage fetching them itself.`,
};

/**
 * We do not run OFIQ. Stated as a gap rather than filled in with numbers whose
 * scale we would be inventing.
 */
export const OFIQ_GAP: CapabilityGap = {
  capability: 'OFIQ / ISO-IEC 29794-5 face image quality',
  impact:
    'QualityGate.unifiedScore and the blur / exposure / occlusion components are absent. The gate runs on measured inter-eye distance and detector confidence only, which is the strongest single predictor but not the full standard.',
  howTo:
    'Wire the BSI OFIQ reference implementation (liberally licensed for commercial use) and populate QualityGate.components. Until then those fields stay absent rather than guessed.',
};

// ---------------------------------------------------------------------------
// Detector geometry — ported from OpenCV modules/objdetect/src/face_detect.cpp
// ---------------------------------------------------------------------------

/**
 * The published `face_detection_yunet_2023mar.onnx` has a fixed 1x3x640x640
 * input (verified against the graph's own input metadata), so unlike OpenCV —
 * which reshapes the net per frame — we letterbox into 640x640 and map
 * coordinates back. Padding goes bottom/right only, exactly as OpenCV's
 * `copyMakeBorder(..., 0, bottom, 0, right, ...)` does, which keeps the origin
 * at the top-left and makes the inverse map a single divide by the scale.
 */
const DET_SIZE = 640;
const DET_STRIDES = [8, 16, 32] as const;
const DET_NMS_IOU = 0.3;
const DET_MAX_FACES = 64;

/**
 * ArcFace 112x112 five-point template, verbatim from OpenCV
 * `face_recognize.cpp`. Order matches YuNet's landmark order (subject's right
 * eye first, which is the LEFT side of the frame — hence x=38.29 before 73.53).
 */
const SFACE_TEMPLATE: readonly (readonly [number, number])[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
] as const;

const SFACE_SIZE = 112;

// ---------------------------------------------------------------------------
// Pure geometry / decision helpers — exported so the gate is unit-testable
// without needing a face image on disk
// ---------------------------------------------------------------------------

export interface DetectedFace {
  /** Box in original-image pixels. */
  box: { x: number; y: number; w: number; h: number };
  /** Five landmarks in original-image pixels, YuNet order. */
  landmarks: readonly (readonly [number, number])[];
  /** sqrt(cls * obj), 0..1. */
  score: number;
}

export function interEyeDistancePx(face: DetectedFace): number {
  const [rx, ry] = face.landmarks[0];
  const [lx, ly] = face.landmarks[1];
  return Math.hypot(lx - rx, ly - ry);
}

/** Verdict from a cosine similarity, with an explicit inconclusive band. */
export function verdictFromSimilarity(
  similarity: number,
  threshold: number = FACE_THRESHOLD.value,
  margin: number = FACE_INCONCLUSIVE_MARGIN,
): 'same-person' | 'different-person' | 'inconclusive' {
  if (similarity >= threshold + margin) return 'same-person';
  if (similarity <= threshold - margin) return 'different-person';
  return 'inconclusive';
}

/**
 * Estimated upscale factor of an image region, as a LOWER BOUND. 1 means no
 * interpolation signature was found. See FACE_RESAMPLE for the method and for
 * why the estimate saturates around 4.
 *
 * `gray` is row-major single-channel, `w * h` samples in 0..255.
 */
export function estimateResampleFactor(gray: Float64Array, w: number, h: number): number {
  if (w < FACE_RESAMPLE.minSidePx || h < FACE_RESAMPLE.minSidePx) return 1;

  let mean = 0;
  for (let i = 0; i < gray.length; i += 1) mean += gray[i];
  mean /= gray.length;
  let variance = 0;
  for (let i = 0; i < gray.length; i += 1) variance += (gray[i] - mean) ** 2;
  const sd = Math.sqrt(variance / gray.length);
  // A flat region has no signal to reason about; claiming it is upscaled would
  // be an assertion about nothing.
  if (sd < 1) return 1;

  // Nearest-neighbour / block-replicated enlargement first. It is the crudest
  // way to inflate a thumbnail and it is invisible to the band-limit test below,
  // because box-down plus bilinear-up smooths across block boundaries the
  // original never had. Here the test is direct: are k x k blocks constant?
  const replicated = blockReplicationFactor(gray, w, h, sd);
  if (replicated > 1) return replicated;

  for (const k of FACE_RESAMPLE.factors) {
    const dw = Math.floor(w / k);
    const dh = Math.floor(h / k);
    if (dw < FACE_RESAMPLE.minSidePx / 2 || dh < FACE_RESAMPLE.minSidePx / 2) continue;

    const down = new Float64Array(dw * dh);
    for (let y = 0; y < dh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        let sum = 0;
        for (let j = 0; j < k; j += 1) {
          for (let i = 0; i < k; i += 1) sum += gray[(y * k + j) * w + (x * k + i)];
        }
        down[y * dw + x] = sum / (k * k);
      }
    }

    const sx = dw / w;
    const sy = dh / h;
    let squared = 0;
    for (let y = 0; y < h; y += 1) {
      const fy = (y + 0.5) * sy - 0.5;
      const y0 = Math.max(0, Math.min(dh - 1, Math.floor(fy)));
      const y1 = Math.min(dh - 1, y0 + 1);
      const ay = Math.max(0, Math.min(1, fy - y0));
      for (let x = 0; x < w; x += 1) {
        const fx = (x + 0.5) * sx - 0.5;
        const x0 = Math.max(0, Math.min(dw - 1, Math.floor(fx)));
        const x1 = Math.min(dw - 1, x0 + 1);
        const ax = Math.max(0, Math.min(1, fx - x0));
        const restored =
          down[y0 * dw + x0] * (1 - ax) * (1 - ay) +
          down[y0 * dw + x1] * ax * (1 - ay) +
          down[y1 * dw + x0] * (1 - ax) * ay +
          down[y1 * dw + x1] * ax * ay;
        squared += (gray[y * w + x] - restored) ** 2;
      }
    }
    const normalised = Math.sqrt(squared / (w * h)) / sd;
    if (normalised < FACE_RESAMPLE.tolerance) return k;
  }
  return 1;
}

/**
 * Largest k for which the region is constant within every k x k block, i.e. it
 * was enlarged by pixel replication. Returns 1 when no such structure exists.
 *
 * The tolerance is deliberately near-exact rather than fitted: replication
 * produces literally identical neighbours, so within-block deviation is zero up
 * to the rounding of whatever codec touched it afterwards. Anything larger than
 * that is real captured variation.
 */
function blockReplicationFactor(
  gray: Float64Array,
  w: number,
  h: number,
  sd: number,
): number {
  for (const k of FACE_RESAMPLE.factors) {
    const bw = Math.floor(w / k);
    const bh = Math.floor(h / k);
    if (bw < 4 || bh < 4) continue;
    let deviation = 0;
    let counted = 0;
    for (let by = 0; by < bh; by += 1) {
      for (let bx = 0; bx < bw; bx += 1) {
        const anchor = gray[by * k * w + bx * k];
        for (let j = 0; j < k; j += 1) {
          for (let i = 0; i < k; i += 1) {
            if (i === 0 && j === 0) continue;
            deviation += Math.abs(gray[(by * k + j) * w + bx * k + i] - anchor);
            counted += 1;
          }
        }
      }
    }
    if (counted === 0) continue;
    if (deviation / counted / sd < 0.02) return k;
  }
  return 1;
}

/** Greyscale copy of a box out of an RGB image, clamped to the frame. */
function greyCrop(
  img: RawImage,
  box: { x: number; y: number; w: number; h: number },
): { gray: Float64Array; w: number; h: number } {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(box.x)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(box.y)));
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil(box.x + box.w)));
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil(box.y + box.h)));
  const w = x1 - x0;
  const h = y1 - y0;
  const gray = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = ((y0 + y) * img.width + (x0 + x)) * 3;
      // Rec. 601 luma, the same weighting OpenCV's COLOR_RGB2GRAY uses.
      gray[y * w + x] = 0.299 * img.rgb[o] + 0.587 * img.rgb[o + 1] + 0.114 * img.rgb[o + 2];
    }
  }
  return { gray, w, h };
}

/**
 * Per-image gate outcome. Kept separate from `FaceProbe` so the decision is a
 * pure function of measurements and can be tested directly.
 */
export interface ProbeGate {
  passed: boolean;
  degraded: boolean;
  /** Apparent inter-eye distance divided by the detected upscale factor. */
  effectiveInterEyePx?: number;
  reason?: string;
}

export function gateForProbe(input: {
  facesDetected: number;
  /** As measured in the supplied file's pixels. */
  interEyeDistancePx?: number;
  /** Lower bound from `estimateResampleFactor`. Defaults to 1 (no upscale found). */
  resampleFactor?: number;
  detectionScore?: number;
}): ProbeGate {
  if (input.facesDetected === 0) {
    return {
      passed: false,
      degraded: false,
      reason: 'No face was detected in this image, so there is nothing to compare.',
    };
  }
  const apparent = input.interEyeDistancePx;
  if (apparent === undefined || !Number.isFinite(apparent)) {
    return {
      passed: false,
      degraded: false,
      reason: 'Eye landmarks could not be located, so inter-eye distance is unmeasurable.',
    };
  }

  const factor = Math.max(1, input.resampleFactor ?? 1);
  const effective = apparent / factor;
  const upscaled = factor > 1;
  const upscaleNote = upscaled
    ? ` The face region carries an interpolation signature of at least ${factor}x, so its apparent ` +
      `${apparent.toFixed(1)}px inter-eye distance corresponds to at most ~${effective.toFixed(1)}px of ` +
      'genuinely captured detail. Upscaling restores visual detail without restoring biometric information.'
    : '';

  /*
   * An upscaled probe has to clear a wider margin, and the reason is the
   * estimator's own limitation. The detected factor is a LOWER bound — a 130px
   * frame enlarged 10x reads as 4x — so dividing by it leaves an unknown
   * residual, and applying the ordinary 32px floor to a figure we know is
   * inflated by an unknown amount would let exactly the laundered probe through
   * that this gate exists to stop. When interpolation is detected we therefore
   * require the effective distance to clear the ISO/IEC 39794-5 enrolment figure
   * instead. A genuine 2x enlargement of a portrait still passes comfortably; a
   * thumbnail blown up to look like one does not.
   */
  const floorPx = upscaled ? FACE_GATE.enrolmentInterEyePx : FACE_GATE.refuseInterEyePx;
  if (effective < floorPx) {
    return {
      passed: false,
      degraded: false,
      effectiveInterEyePx: effective,
      reason:
        `Effective inter-eye distance is ${effective.toFixed(1)}px, below the ${floorPx}px ` +
        (upscaled
          ? 'floor this probe has to clear. The detected upscale factor is only a lower bound, so an ' +
            `upscaled probe is held to the ISO/IEC 39794-5 enrolment figure (${FACE_GATE.enrolmentInterEyePx}px) ` +
            `rather than the ${FACE_GATE.refuseInterEyePx}px floor used for natively captured input.`
          : `floor (published recognition floor ~21px, ${FACE_GATE.recommendedInterEyePx}px recommended, ` +
            `ISO/IEC 39794-5 asks ${FACE_GATE.enrolmentInterEyePx}px for enrolment).`) +
        upscaleNote,
    };
  }
  const score = input.detectionScore;
  if (score !== undefined && score < FACE_GATE.minDetectionScore) {
    return {
      passed: false,
      degraded: false,
      effectiveInterEyePx: effective,
      reason:
        `Detector confidence for the selected face is ${score.toFixed(2)}, below the ` +
        `${FACE_GATE.minDetectionScore} floor. The region may not be a face.`,
    };
  }
  return {
    passed: true,
    // Any detected resampling caps the band, because the estimate is only a
    // lower bound: we know detail was interpolated, not how much.
    degraded: upscaled || effective < FACE_GATE.recommendedInterEyePx,
    effectiveInterEyePx: effective,
  };
}

/** Cosine similarity of two descriptors. Both are L2-normalised on extraction. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return Number.NaN;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

/**
 * Least-squares similarity transform (scale + rotation + translation) mapping
 * `src` onto `dst`. Returns [a, b, tx, c, d, ty] for
 * `x' = a*x + b*y + tx ; y' = c*x + d*y + ty`.
 *
 * OpenCV's `getSimilarityTransformMatrix` reaches this via SVD so it can correct
 * a reflection; the closed form below is the same estimator for the
 * orientation-preserving case, which is the only case five face landmarks
 * produce. Written out rather than pulled in as a dependency because it is
 * twelve lines of arithmetic that must be auditable.
 */
export function similarityTransform(
  src: readonly (readonly [number, number])[],
  dst: readonly (readonly [number, number])[],
): [number, number, number, number, number, number] {
  const n = Math.min(src.length, dst.length);
  let mx = 0;
  let my = 0;
  let mu = 0;
  let mv = 0;
  for (let i = 0; i < n; i += 1) {
    mx += src[i][0];
    my += src[i][1];
    mu += dst[i][0];
    mv += dst[i][1];
  }
  mx /= n;
  my /= n;
  mu /= n;
  mv /= n;

  let numA = 0;
  let numB = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const x = src[i][0] - mx;
    const y = src[i][1] - my;
    const u = dst[i][0] - mu;
    const v = dst[i][1] - mv;
    numA += x * u + y * v;
    numB += x * v - y * u;
    den += x * x + y * y;
  }
  if (den === 0) return [1, 0, 0, 0, 1, 0];
  const a = numA / den;
  const b = numB / den;
  return [a, -b, mu - (a * mx - b * my), b, a, mv - (b * mx + a * my)];
}

function invertAffine(
  m: readonly [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  if (det === 0) return [1, 0, 0, 0, 1, 0];
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}

// ---------------------------------------------------------------------------
// Weights: resolve, verify, optionally fetch — once per process
// ---------------------------------------------------------------------------

interface LoadedModels {
  detector: InferenceSession;
  recogniser: InferenceSession;
  /** Measured digests, so provenance is real even if a file was swapped. */
  digests: { detector: string; recogniser: string };
  /** True when a measured digest differs from the pinned reference. */
  digestMismatch: boolean;
  modelDir: string;
}

let modelCache: LoadedModels | null = null;
let modelLoading: Promise<Result<LoadedModels, StageFailure>> | null = null;

function defaultModelDir(): string {
  return process.env.LANTAGE_FACE_MODEL_DIR ?? path.join(process.cwd(), '.lantage-models', 'face');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readOrFetch(
  dir: string,
  spec: { file: string; url: string; sha256: string },
  signal?: AbortSignal,
): Promise<Result<{ bytes: Uint8Array; digest: string }, StageFailure>> {
  const target = path.join(dir, spec.file);
  try {
    const bytes = new Uint8Array(await readFile(target));
    return ok({ bytes, digest: sha256(bytes) });
  } catch {
    // Not on disk. Fall through to the fetch.
  }

  if (process.env.LANTAGE_FACE_MODEL_FETCH === '0') {
    return err(
      failure(
        'not-configured',
        `${spec.file} is not in ${dir} and automatic fetching is disabled (LANTAGE_FACE_MODEL_FETCH=0).`,
      ),
    );
  }

  const timeout = AbortSignal.timeout(FACE_TIMEOUTS_MS.download);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let bytes: Uint8Array;
  try {
    const res = await fetch(spec.url, { signal: combined, cache: 'no-store' });
    if (!res.ok) {
      return err(failure('unavailable', `fetching ${spec.file} returned HTTP ${res.status}`));
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (timeout.aborted) {
      return err(
        failure('timeout', `fetching ${spec.file} exceeded ${FACE_TIMEOUTS_MS.download}ms`),
      );
    }
    return err(failure('unavailable', `fetching ${spec.file} failed: ${describe(e)}`));
  }

  const digest = sha256(bytes);
  if (digest !== spec.sha256) {
    // A downloaded artefact whose digest we cannot vouch for does not get
    // written to disk. Refusing here is cheaper than an unreproducible result.
    return err(
      failure(
        'invalid-response',
        `${spec.file} downloaded with sha256 ${digest}, expected ${spec.sha256}. Not written to disk.`,
      ),
    );
  }

  try {
    await mkdir(dir, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (e) {
    // A cache-write failure is not a correctness failure: we already have
    // verified bytes in memory and can proceed this once.
    void unlink(`${target}.tmp-${process.pid}`).catch(() => undefined);
    void e;
  }
  return ok({ bytes, digest });
}

async function loadModels(
  modelDir: string,
  signal?: AbortSignal,
): Promise<Result<LoadedModels, StageFailure>> {
  if (modelCache && modelCache.modelDir === modelDir) return ok(modelCache);
  if (modelLoading) return modelLoading;

  modelLoading = (async (): Promise<Result<LoadedModels, StageFailure>> => {
    try {
      const ort = await import('onnxruntime-node');
      const det = await readOrFetch(modelDir, FACE_MODEL.detector, signal);
      if (!det.ok) return det;
      const rec = await readOrFetch(modelDir, FACE_MODEL.recogniser, signal);
      if (!rec.ok) return rec;

      // logSeverityLevel 3 = ERROR. The SFace graph lists its batch-norm
      // initialisers as graph inputs, which makes ORT emit a warning per tensor
      // at load; that is upstream noise, not a problem with our pipeline.
      const options = { logSeverityLevel: 3 as const, graphOptimizationLevel: 'all' as const };
      const detector = await ort.InferenceSession.create(det.value.bytes, options);
      const recogniser = await ort.InferenceSession.create(rec.value.bytes, options);

      const loaded: LoadedModels = {
        detector,
        recogniser,
        digests: { detector: det.value.digest, recogniser: rec.value.digest },
        digestMismatch:
          det.value.digest !== FACE_MODEL.detector.sha256 ||
          rec.value.digest !== FACE_MODEL.recogniser.sha256,
        modelDir,
      };
      modelCache = loaded;
      return ok(loaded);
    } catch (e) {
      return err(
        failure(
          'not-configured',
          `the local face model could not be loaded: ${describe(e)}. onnxruntime-node needs a native ` +
            'binary for this platform, and Next.js needs onnxruntime-node in serverExternalPackages.',
        ),
      );
    } finally {
      modelLoading = null;
    }
  })();

  return modelLoading;
}

/** Test / ops hook: drop the cached sessions so the next call reloads. */
export function resetFaceModelCache(): void {
  modelCache = null;
  modelLoading = null;
}

// ---------------------------------------------------------------------------
// Decode + detect + describe
// ---------------------------------------------------------------------------

interface RawImage {
  rgb: Uint8Array;
  width: number;
  height: number;
}

async function decodeImage(image: FaceImage): Promise<Result<RawImage, StageFailure>> {
  let buffer: Buffer;
  if (image.bytes) {
    buffer = Buffer.from(image.bytes);
  } else if (image.path) {
    try {
      buffer = await readFile(image.path);
    } catch (e) {
      return err(failure('no-input', `upload ${image.uploadId} could not be read: ${describe(e)}`));
    }
  } else {
    return err(failure('no-input', `upload ${image.uploadId} carried neither bytes nor a path`));
  }

  try {
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(buffer, { failOn: 'none' })
      // EXIF auto-orient before anything measures pixels: a sideways JPEG would
      // otherwise produce a rotated inter-eye distance.
      .rotate()
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) {
      return err(
        failure('invalid-response', `decoded ${image.uploadId} with ${info.channels} channels, expected 3`),
      );
    }
    return ok({ rgb: new Uint8Array(data), width: info.width, height: info.height });
  } catch (e) {
    return err(failure('no-input', `upload ${image.uploadId} could not be decoded: ${describe(e)}`));
  }
}

/** Letterbox to 640x640 preserving aspect, padding bottom/right with black. */
async function letterbox(img: RawImage): Promise<Result<{ bgr: Float32Array; scale: number }, StageFailure>> {
  const scale = Math.min(DET_SIZE / img.width, DET_SIZE / img.height);
  const w = Math.max(1, Math.min(DET_SIZE, Math.round(img.width * scale)));
  const h = Math.max(1, Math.min(DET_SIZE, Math.round(img.height * scale)));
  try {
    const sharp = (await import('sharp')).default;
    const data = await sharp(Buffer.from(img.rgb), {
      raw: { width: img.width, height: img.height, channels: 3 },
    })
      .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
      .extend({
        top: 0,
        left: 0,
        bottom: DET_SIZE - h,
        right: DET_SIZE - w,
        background: { r: 0, g: 0, b: 0 },
      })
      .raw()
      .toBuffer();

    // YuNet is fed by OpenCV's `blobFromImage(pad_image)` with default arguments
    // — scale 1.0, no mean subtraction, swapRB=false — and OpenCV images are
    // BGR. So the net expects raw BGR 0..255 in NCHW.
    const n = DET_SIZE * DET_SIZE;
    const out = new Float32Array(3 * n);
    for (let i = 0; i < n; i += 1) {
      out[i] = data[i * 3 + 2];
      out[n + i] = data[i * 3 + 1];
      out[2 * n + i] = data[i * 3];
    }
    return ok({ bgr: out, scale });
  } catch (e) {
    return err(failure('invalid-response', `letterbox failed: ${describe(e)}`));
  }
}

function f32(map: InferenceSession.OnnxValueMapType, key: string): Float32Array {
  const tensor = map[key];
  const data = tensor === undefined ? undefined : (tensor as { data?: unknown }).data;
  if (!(data instanceof Float32Array)) {
    throw new Error(`detector output "${key}" was not a float32 tensor`);
  }
  return data;
}

async function detectFaces(
  models: LoadedModels,
  img: RawImage,
): Promise<Result<DetectedFace[], StageFailure>> {
  const lb = await letterbox(img);
  if (!lb.ok) return lb;

  let outputs: InferenceSession.OnnxValueMapType;
  try {
    const ort = await import('onnxruntime-node');
    outputs = await models.detector.run({
      input: new ort.Tensor('float32', lb.value.bgr, [1, 3, DET_SIZE, DET_SIZE]),
    });
  } catch (e) {
    return err(failure('unavailable', `face detection failed: ${describe(e)}`));
  }

  const found: DetectedFace[] = [];
  try {
    for (const stride of DET_STRIDES) {
      const cols = DET_SIZE / stride;
      const rows = DET_SIZE / stride;
      const cls = f32(outputs, `cls_${stride}`);
      const obj = f32(outputs, `obj_${stride}`);
      const bbox = f32(outputs, `bbox_${stride}`);
      const kps = f32(outputs, `kps_${stride}`);

      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const idx = r * cols + c;
          const clsScore = clamp01(cls[idx]);
          const objScore = clamp01(obj[idx]);
          const score = Math.sqrt(clsScore * objScore);
          if (score < FACE_GATE.minDetectionScore) continue;

          const cx = (c + bbox[idx * 4]) * stride;
          const cy = (r + bbox[idx * 4 + 1]) * stride;
          const bw = Math.exp(bbox[idx * 4 + 2]) * stride;
          const bh = Math.exp(bbox[idx * 4 + 3]) * stride;
          const landmarks: [number, number][] = [];
          for (let k = 0; k < 5; k += 1) {
            landmarks.push([(kps[idx * 10 + 2 * k] + c) * stride, (kps[idx * 10 + 2 * k + 1] + r) * stride]);
          }
          found.push({
            box: { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh },
            landmarks,
            score,
          });
        }
      }
    }
  } catch (e) {
    return err(failure('invalid-response', `decoding detector output failed: ${describe(e)}`));
  }

  found.sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];
  for (const face of found) {
    if (kept.some((k) => iou(face.box, k.box) > DET_NMS_IOU)) continue;
    kept.push(face);
    if (kept.length >= DET_MAX_FACES) break;
  }

  // Map back into original-image pixels. This divide is the whole reason the
  // gate cannot be gamed by upscaling: the measurement always lands in the
  // coordinate system of the pixels the operator actually supplied.
  const s = lb.value.scale;
  return ok(
    kept.map((f) => ({
      score: f.score,
      box: { x: f.box.x / s, y: f.box.y / s, w: f.box.w / s, h: f.box.h / s },
      landmarks: f.landmarks.map(([x, y]) => [x / s, y / s] as [number, number]),
    })),
  );
}

/**
 * Similarity-warp the face to the 112x112 ArcFace template and extract the
 * 128-d descriptor.
 *
 * SFace is fed by OpenCV's `blobFromImage(_aligned_img, 1, Size(112,112),
 * Scalar(0,0,0), true, false)` — swapRB=true applied to a BGR OpenCV image,
 * i.e. the net receives RGB 0..255 NCHW. We already hold RGB, so no swap here.
 */
async function describeFace(
  models: LoadedModels,
  img: RawImage,
  face: DetectedFace,
): Promise<Result<Float32Array, StageFailure>> {
  const forward = similarityTransform(face.landmarks, SFACE_TEMPLATE);
  const inverse = invertAffine(forward);
  const plane = SFACE_SIZE * SFACE_SIZE;
  const blob = new Float32Array(3 * plane);

  for (let v = 0; v < SFACE_SIZE; v += 1) {
    for (let u = 0; u < SFACE_SIZE; u += 1) {
      // Pixel-centre convention, matching OpenCV's warpAffine sampling.
      const sx = inverse[0] * (u + 0.5) + inverse[1] * (v + 0.5) + inverse[2] - 0.5;
      const sy = inverse[3] * (u + 0.5) + inverse[4] * (v + 0.5) + inverse[5] - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < 4; k += 1) {
        const xi = Math.min(img.width - 1, Math.max(0, x0 + (k & 1)));
        const yi = Math.min(img.height - 1, Math.max(0, y0 + (k >> 1)));
        const weight = ((k & 1) === 1 ? fx : 1 - fx) * ((k >> 1) === 1 ? fy : 1 - fy);
        const o = (yi * img.width + xi) * 3;
        r += weight * img.rgb[o];
        g += weight * img.rgb[o + 1];
        b += weight * img.rgb[o + 2];
      }
      const i = v * SFACE_SIZE + u;
      blob[i] = r;
      blob[plane + i] = g;
      blob[2 * plane + i] = b;
    }
  }

  try {
    const ort = await import('onnxruntime-node');
    const outputs = await models.recogniser.run({
      data: new ort.Tensor('float32', blob, [1, 3, SFACE_SIZE, SFACE_SIZE]),
    });
    const name = models.recogniser.outputNames[0];
    const raw = f32(outputs, name);
    let norm = 0;
    for (let i = 0; i < raw.length; i += 1) norm += raw[i] * raw[i];
    norm = Math.sqrt(norm);
    if (!(norm > 0)) {
      return err(failure('invalid-response', 'the recognition model returned a zero descriptor'));
    }
    const unit = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) unit[i] = raw[i] / norm;
    return ok(unit);
  } catch (e) {
    return err(failure('unavailable', `descriptor extraction failed: ${describe(e)}`));
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface ProbeWork {
  probe: FaceProbe;
  gate: ProbeGate;
  image?: RawImage;
  face?: DetectedFace;
}

/** The narrow contract: two images in, one comparison out. Never throws. */
export async function compareFaces(
  imageA: FaceImage,
  imageB: FaceImage,
  options: FaceCompareOptions = {},
): Promise<FaceComparison> {
  return (await runFaceCompare(imageA, imageB, options)).face;
}

/** The same comparison plus everything the LIVE response needs. Never throws. */
export async function runFaceCompare(
  imageA: FaceImage,
  imageB: FaceImage,
  options: FaceCompareOptions = {},
): Promise<FaceCompareRun> {
  const stages: StageTrace[] = [];
  const gaps: CapabilityGap[] = [OFIQ_GAP];
  const modelDir = options.modelDir ?? defaultModelDir();
  const deadline = Date.now() + (options.timeoutMs ?? FACE_TIMEOUTS_MS.compare);
  const models: Record<string, string> = {};

  try {
    // --- preprocess: weights + decode -------------------------------------
    const preprocessStart = Date.now();
    const loaded = await loadModels(modelDir, options.signal);
    if (!loaded.ok) {
      stages.push({
        stage: 'preprocess',
        ranMs: Date.now() - preprocessStart,
        skipped: { reason: loaded.error.reason },
        costUsd: 0,
      });
      gaps.push(FACE_MODEL_GAP);
      return refusedRun(
        [emptyProbe(imageA.uploadId), emptyProbe(imageB.uploadId)],
        loaded.error.reason,
        stages,
        gaps,
        models,
        { w: 0, h: 0 },
      );
    }

    models['face-detector'] =
      `${FACE_MODEL.detector.version} sha256:${loaded.value.digests.detector.slice(0, 16)}`;
    models['face-recogniser'] =
      `${FACE_MODEL.recogniser.version} sha256:${loaded.value.digests.recogniser.slice(0, 16)}`;
    models['onnxruntime-node'] = (await import('onnxruntime-node')).env.versions.node ?? 'unknown';

    if (loaded.value.digestMismatch) {
      gaps.push({
        capability: 'Reproducible face model weights',
        impact:
          'The weights on disk do not match the digests this build was pinned against, so the result cannot be reproduced against the published model card. The measured digests are recorded in provenance and the confidence band is capped.',
        envVar: 'LANTAGE_FACE_MODEL_DIR',
        howTo: `Delete the files in ${modelDir} and let Lantage re-fetch them, or restore the pinned versions.`,
      });
    }

    const decoded = await Promise.all([decodeImage(imageA), decodeImage(imageB)]);
    stages.push({ stage: 'preprocess', ranMs: Date.now() - preprocessStart, costUsd: 0 });

    const inputs = [imageA, imageB];
    const work: ProbeWork[] = [];

    // --- detector ---------------------------------------------------------
    const detectStart = Date.now();
    for (let i = 0; i < 2; i += 1) {
      const dec = decoded[i];
      if (!dec.ok) {
        work.push({
          probe: { ...emptyProbe(inputs[i].uploadId), note: dec.error.reason },
          gate: { passed: false, degraded: false, reason: dec.error.reason },
        });
        continue;
      }
      const found = await detectFaces(loaded.value, dec.value);
      if (!found.ok) {
        work.push({
          probe: { ...emptyProbe(inputs[i].uploadId), note: found.error.reason },
          gate: { passed: false, degraded: false, reason: found.error.reason },
          image: dec.value,
        });
        continue;
      }
      work.push(buildProbe(inputs[i].uploadId, dec.value, found.value));
    }
    stages.push({ stage: 'detector', ranMs: Date.now() - detectStart, costUsd: 0 });

    // --- quality gate -----------------------------------------------------
    const gateStart = Date.now();
    const probes = work.map((w) => w.probe);
    const quality = pairQualityGate(work, decoded);
    stages.push({ stage: 'quality-gate', ranMs: Date.now() - gateStart, costUsd: 0 });

    if (!quality.passed) {
      const reason = quality.refusalReason ?? 'One or both probes failed the quality gate.';
      stages.push({
        stage: 'embedding-prior',
        ranMs: 0,
        skipped: { reason: 'Quality gate refused; no descriptor was extracted.' },
        costUsd: 0,
      });
      stages.push({
        stage: 'rerank',
        ranMs: 0,
        skipped: { reason: 'Quality gate refused; no similarity was computed.' },
        costUsd: 0,
      });
      return {
        face: {
          verdict: 'refused',
          confidence: refusedConfidence(reason, loaded.value),
          probes,
          refusalReason: reason,
        },
        quality,
        stages,
        gaps,
        models,
        costUsd: 0,
      };
    }

    // --- descriptors ------------------------------------------------------
    const embedStart = Date.now();
    if (Date.now() > deadline) {
      const reason = `The comparison exceeded its ${options.timeoutMs ?? FACE_TIMEOUTS_MS.compare}ms budget before descriptors could be extracted.`;
      stages.push({ stage: 'embedding-prior', ranMs: 0, skipped: { reason }, costUsd: 0 });
      return refusedRun(probes, reason, stages, gaps, models, quality.components.resolutionPx);
    }
    const descriptors: Float32Array[] = [];
    for (const w of work) {
      if (!w.image || !w.face) {
        const reason = 'A gated-through probe had no usable face, which is a bug in the gate.';
        stages.push({ stage: 'embedding-prior', ranMs: Date.now() - embedStart, skipped: { reason }, costUsd: 0 });
        return refusedRun(probes, reason, stages, gaps, models, quality.components.resolutionPx);
      }
      const descriptor = await describeFace(loaded.value, w.image, w.face);
      if (!descriptor.ok) {
        stages.push({
          stage: 'embedding-prior',
          ranMs: Date.now() - embedStart,
          skipped: { reason: descriptor.error.reason },
          costUsd: 0,
        });
        return refusedRun(
          probes,
          descriptor.error.reason,
          stages,
          gaps,
          models,
          quality.components.resolutionPx,
        );
      }
      descriptors.push(descriptor.value);
    }
    stages.push({ stage: 'embedding-prior', ranMs: Date.now() - embedStart, costUsd: 0 });

    // --- compare ----------------------------------------------------------
    const compareStart = Date.now();
    const similarity = cosineSimilarity(descriptors[0], descriptors[1]);
    if (!Number.isFinite(similarity)) {
      const reason = 'The two descriptors were not comparable, so no similarity was produced.';
      stages.push({ stage: 'rerank', ranMs: Date.now() - compareStart, skipped: { reason }, costUsd: 0 });
      return refusedRun(probes, reason, stages, gaps, models, quality.components.resolutionPx);
    }
    const verdict = verdictFromSimilarity(similarity);
    stages.push({ stage: 'rerank', ranMs: Date.now() - compareStart, costUsd: 0 });

    return {
      face: {
        verdict,
        similarity,
        threshold: { value: FACE_THRESHOLD.value, basis: FACE_THRESHOLD.basis },
        confidence: confidenceFor(similarity, verdict, quality, work, loaded.value),
        probes,
      },
      quality,
      stages,
      gaps,
      models,
      costUsd: 0,
    };
  } catch (e) {
    // Nothing in this module is allowed to throw across the module boundary. An
    // unexpected failure is a refusal with the reason attached, not a 500.
    const reason = `Face compare failed unexpectedly: ${describe(e)}`;
    return refusedRun(
      [emptyProbe(imageA.uploadId), emptyProbe(imageB.uploadId)],
      reason,
      stages,
      gaps,
      models,
      { w: 0, h: 0 },
    );
  }
}

function buildProbe(uploadId: string, image: RawImage, faces: DetectedFace[]): ProbeWork {
  if (faces.length === 0) {
    const gate = gateForProbe({ facesDetected: 0 });
    return {
      image,
      gate,
      probe: {
        uploadId,
        facesDetected: 0,
        passedGate: false,
        note: `No face detected in the ${image.width}x${image.height} frame at a detector confidence of ${FACE_GATE.minDetectionScore} or above.`,
      },
    };
  }

  // Largest by box area, which is the closest available proxy for "the subject".
  const byArea = [...faces].sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  const selected = byArea[0];
  const eye = interEyeDistancePx(selected);

  // Tested on the face region specifically rather than the whole frame: a
  // composited or partly-enlarged image can be sharp everywhere except the face.
  const crop = greyCrop(image, selected.box);
  const resampleFactor = estimateResampleFactor(crop.gray, crop.w, crop.h);

  const gate = gateForProbe({
    facesDetected: faces.length,
    interEyeDistancePx: eye,
    resampleFactor,
    detectionScore: selected.score,
  });

  const notes: string[] = [];
  if (faces.length > 1) {
    notes.push(
      `${faces.length} faces detected; the largest (${Math.round(selected.box.w)}x${Math.round(selected.box.h)}px at ${Math.round(selected.box.x)},${Math.round(selected.box.y)}) was selected and the other ${faces.length - 1} ignored.`,
    );
  }
  if (resampleFactor > 1) {
    notes.push(
      `The face region carries an interpolation signature of at least ${resampleFactor}x: apparent inter-eye distance is ${eye.toFixed(1)}px but at most ~${(eye / resampleFactor).toFixed(1)}px of that is genuinely captured detail. The gate and the confidence band both use the effective figure.`,
    );
  }
  if (gate.passed && gate.degraded && resampleFactor === 1) {
    notes.push(
      `Inter-eye distance ${eye.toFixed(1)}px is above the ${FACE_GATE.refuseInterEyePx}px floor but below the ${FACE_GATE.recommendedInterEyePx}px recommended minimum, so confidence is capped at 'weak'.`,
    );
  }
  if (!gate.passed && gate.reason) notes.push(gate.reason);

  return {
    image,
    face: selected,
    gate,
    probe: {
      uploadId,
      facesDetected: faces.length,
      selected: {
        x: Math.round(selected.box.x),
        y: Math.round(selected.box.y),
        w: Math.round(selected.box.w),
        h: Math.round(selected.box.h),
      },
      interEyeDistancePx: Number(eye.toFixed(2)),
      detectionScore: Number(selected.score.toFixed(4)),
      passedGate: gate.passed,
      note: notes.length > 0 ? notes.join(' ') : undefined,
    },
  };
}

/**
 * The pair gate. Both probes must pass; the reported components describe the
 * limiting probe, because that is the one that determines what the comparison
 * can support.
 */
export function pairQualityGate(
  work: ProbeWork[],
  decoded: Result<RawImage, StageFailure>[],
): QualityGate {
  const eyes = work.map((w) => w.probe.interEyeDistancePx);
  const finite = eyes.filter((e): e is number => typeof e === 'number' && Number.isFinite(e));
  const limitingIndex = finite.length === eyes.length && eyes.length > 0
    ? eyes.indexOf(Math.min(...finite))
    : work.findIndex((w) => !w.gate.passed);
  const index = limitingIndex >= 0 ? limitingIndex : 0;

  const dims = ((): { w: number; h: number } => {
    const dec = decoded[index];
    if (dec && dec.ok) return { w: dec.value.width, h: dec.value.height };
    const first = decoded.find((d) => d.ok);
    if (first && first.ok) return { w: first.value.width, h: first.value.height };
    return { w: 0, h: 0 };
  })();

  const failures = work.filter((w) => !w.gate.passed);
  const passed = failures.length === 0 && work.length === 2;
  const degraded = passed && work.some((w) => w.gate.degraded);

  const refusalReason = passed
    ? undefined
    : work.length !== 2
      ? 'Face compare needs exactly two images.'
      : failures
          .map((w) => `${w.probe.uploadId}: ${w.gate.reason ?? 'failed the quality gate.'}`)
          .join(' ');

  const minEye = finite.length > 0 ? Math.min(...finite) : undefined;

  return {
    passed,
    // unifiedScore is deliberately absent: we do not run OFIQ, and a number on
    // its 0-100 scale that we invented would be worse than no number. See OFIQ_GAP.
    components: {
      resolutionPx: dims,
      ...(minEye === undefined ? {} : { interEyeDistancePx: Number(minEye.toFixed(2)) }),
    },
    refusalReason,
    degraded,
  };
}

function confidenceFor(
  similarity: number,
  verdict: 'same-person' | 'different-person' | 'inconclusive',
  quality: QualityGate,
  work: ProbeWork[],
  models: LoadedModels,
): Confidence {
  const margin = Math.abs(similarity - FACE_THRESHOLD.value);
  // Effective, not apparent: an upscaled probe must not be able to talk its way
  // into a higher band with interpolated pixels.
  const eyes = work
    .map((w) => w.gate.effectiveInterEyePx ?? w.probe.interEyeDistancePx)
    .filter((e): e is number => typeof e === 'number');
  const minEye = eyes.length > 0 ? Math.min(...eyes) : 0;
  const upscaled = work.some(
    (w) =>
      w.gate.effectiveInterEyePx !== undefined &&
      w.probe.interEyeDistancePx !== undefined &&
      w.gate.effectiveInterEyePx < w.probe.interEyeDistancePx - 0.01,
  );

  /*
   * Ceiling of 'moderate', permanently. `ConfidenceBand` defines 'high' as
   * "calibrated, corroborated by >1 independent signal". A 1:1 face comparison
   * is exactly one signal from one uncalibrated model, so 'high' is not
   * available to this module by the contract's own definition. Raising it would
   * need a second independent signal and a fitted calibration set.
   */
  let band: ConfidenceBand;
  if (verdict === 'inconclusive') {
    band = 'weak';
  } else if (margin >= 0.15 && minEye >= FACE_GATE.enrolmentInterEyePx) {
    band = 'moderate';
  } else if (margin >= 0.15) {
    band = 'moderate';
  } else {
    band = 'weak';
  }
  if (models.digestMismatch && band === 'moderate') band = 'weak';
  band = bandCeiling(quality, band);

  const direction =
    verdict === 'same-person'
      ? `${margin.toFixed(3)} above`
      : verdict === 'different-person'
        ? `${margin.toFixed(3)} below`
        : `within ${FACE_INCONCLUSIVE_MARGIN} of`;

  const reason =
    `Cosine similarity of the two 128-d descriptors is ${similarity.toFixed(3)}, ${direction} the ` +
    `${FACE_THRESHOLD.value} threshold. Smallest ${upscaled ? 'effective ' : ''}inter-eye distance ` +
    `across the two probes is ${minEye.toFixed(1)}px (${FACE_GATE.recommendedInterEyePx}px recommended, ` +
    `${FACE_GATE.enrolmentInterEyePx}px is ISO/IEC 39794-5 enrolment grade)` +
    (upscaled
      ? '. At least one probe was upscaled, so the effective figure is used and the band is capped'
      : '') +
    (verdict === 'inconclusive'
      ? '. The score falls inside the inconclusive band, so no verdict is asserted.'
      : quality.degraded
        ? '. Input is below the recommended capture standard, so the band is capped at weak.'
        : '.');

  return {
    band,
    // Raw cosine, clamped into 0..1 for the contract's range. Explicitly NOT a
    // calibrated probability — `calibration` says so.
    score: Math.min(1, Math.max(0, similarity)),
    reason,
    calibration: `${FACE_MODEL.recogniser.version} (SFace/MobileFaceNet, 128-d, ${FACE_MODEL.recogniser.licence}) + ${FACE_MODEL.detector.version} (${FACE_MODEL.detector.licence}); threshold ${FACE_THRESHOLD.value} from ${FACE_THRESHOLD.basis} Score is the raw cosine similarity, not a calibrated probability: no Lantage held-out calibration set has been fitted for this model, so the band ceiling is 'moderate'.`,
  };
}

function refusedConfidence(reason: string, models?: LoadedModels): Confidence {
  return {
    band: 'refused',
    score: 0,
    reason,
    calibration: models
      ? `${FACE_MODEL.recogniser.version} loaded (sha256:${models.digests.recogniser.slice(0, 16)}); no similarity was computed, so nothing was scored.`
      : 'No model was loaded, so no similarity was computed and nothing was scored.',
  };
}

function refusedRun(
  probes: FaceProbe[],
  reason: string,
  stages: StageTrace[],
  gaps: CapabilityGap[],
  models: Record<string, string>,
  resolutionPx: { w: number; h: number },
): FaceCompareRun {
  const eyes = probes
    .map((p) => p.interEyeDistancePx)
    .filter((e): e is number => typeof e === 'number');
  return {
    face: {
      verdict: 'refused',
      confidence: refusedConfidence(reason),
      probes,
      refusalReason: reason,
    },
    quality: {
      passed: false,
      components: {
        resolutionPx,
        ...(eyes.length > 0 ? { interEyeDistancePx: Math.min(...eyes) } : {}),
      },
      refusalReason: reason,
      degraded: false,
    },
    stages,
    gaps,
    models,
    costUsd: 0,
  };
}

function emptyProbe(uploadId: string): FaceProbe {
  return { uploadId, facesDetected: 0, passedGate: false };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function iou(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
