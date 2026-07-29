/**
 * Stage 1 — the quality gate.
 *
 * "A tool that refuses unmatchable input is the tool you can trust when it does
 * return something" (docs/MASTER_PLAN.md §1). A failed gate short-circuits the
 * entire cascade: no embedding, no VLM spend, no ranking. The orchestrator
 * enforces that with `assertRefusalIsHonoured()`.
 *
 * What is measured here is what can be measured honestly without a decode:
 * true pixel dimensions from the container header, and — for JPEG — the
 * recompression level implied by the quantization tables. Blur and exposure need
 * pixel access; rather than inventing a proxy and calling it `blur`, those fields
 * stay undefined until a real measurement is wired (see `PixelStatsProvider`).
 * An unset field is honest; a fabricated one poisons the ledger.
 */

import type { QualityGate, StageTrace } from '@/lib/contracts/types';
import { QUALITY } from './config';
import type { PreprocessOutput } from './preprocess';
import { readJpeg } from '@/lib/verify/jpeg';
import { type Stage, type StageOutput } from './types';

/**
 * Real blur / exposure / occlusion measurement.
 *
 * TODO(B1): Modal already decodes every frame it embeds, so the cheapest correct
 * place for a Laplacian-variance blur score and a luminance histogram is a
 * `/quality` field on the `/embed` response. Implement this interface against
 * that endpoint when it exists. For MATCH (v2) this is where OFIQ — the BSI
 * reference implementation of ISO/IEC 29794-5, liberally licensed — plugs in,
 * along with the inter-eye pixel measurement the face floors depend on.
 */
export interface PixelStatsProvider {
  measure(input: PreprocessOutput): Promise<{
    blur?: number;
    exposure?: number;
    occlusion?: number;
    unifiedScore?: number;
  }>;
}

export const noPixelStats: PixelStatsProvider = {
  async measure() {
    return {};
  },
};

export function createQualityGateStage(
  pixelStats: PixelStatsProvider = noPixelStats,
): Stage<PreprocessOutput, QualityGate> {
  return {
    stage: 'quality-gate',
    // No StageContext parameter: the gate makes no external calls, so it has
    // nothing to time out and nothing to spend.
    async run(input: PreprocessOutput): Promise<StageOutput<QualityGate>> {
      const started = Date.now();
      const stats = await pixelStats.measure(input);
      const gate = evaluateQualityGate(input, stats);
      const trace: StageTrace = {
        stage: 'quality-gate',
        ranMs: Date.now() - started,
        costUsd: 0,
        ...(gate.passed ? {} : { skipped: { reason: gate.refusalReason ?? 'refused' } }),
      };
      // The gate always produces output — a refusal IS the output.
      return { evidence: [], trace, output: gate };
    },
  };
}

export function evaluateQualityGate(
  input: PreprocessOutput,
  stats: { blur?: number; exposure?: number; occlusion?: number; unifiedScore?: number } = {},
): QualityGate {
  const w = input.header.width ?? 0;
  const h = input.header.height ?? 0;
  const longEdge = Math.max(w, h);
  const refusals: string[] = [];
  const degradations: string[] = [];

  if (input.header.byteLength < QUALITY.refuseBytes) {
    refusals.push(
      `The file is only ${input.header.byteLength} bytes — that is a thumbnail or a truncated upload, not a frame we can match.`,
    );
  }

  if (longEdge === 0) {
    refusals.push(
      `Could not read pixel dimensions from the ${input.header.format} container. Re-export the original file; a container we cannot parse is one we cannot vouch for.`,
    );
  } else if (longEdge < QUALITY.refuseLongEdgePx) {
    refusals.push(
      `Resolution is ${w}x${h}. Below ${QUALITY.refuseLongEdgePx}px on the long edge there is not enough facade detail for place recognition, and upscaling does not recover information it only makes it look recoverable. No ranking returned.`,
    );
  } else if (longEdge < QUALITY.degradedLongEdgePx) {
    degradations.push(
      `Resolution is ${w}x${h}, under the ${QUALITY.degradedLongEdgePx}px long edge where retrieval is reliable. Confidence is capped at 'weak'.`,
    );
  }

  let jpegQuality: number | undefined;
  if (input.header.format === 'jpeg' && input.bytes) {
    jpegQuality = readJpeg(input.bytes).estimatedQuality;
    if (jpegQuality !== undefined && jpegQuality < QUALITY.degradedJpegQuality) {
      degradations.push(
        `JPEG quantization tables imply quality ~${jpegQuality}. Recompression at that level removes the high-frequency detail retrieval keys on. Confidence is capped at 'weak'.`,
      );
    }
  }

  const passed = refusals.length === 0;
  const gate: QualityGate = {
    passed,
    components: {
      resolutionPx: { w, h },
      ...(stats.blur !== undefined ? { blur: stats.blur } : {}),
      ...(stats.exposure !== undefined ? { exposure: stats.exposure } : {}),
      ...(stats.occlusion !== undefined ? { occlusion: stats.occlusion } : {}),
    },
    degraded: passed && degradations.length > 0,
    ...(stats.unifiedScore !== undefined ? { unifiedScore: stats.unifiedScore } : {}),
  };

  if (!passed) {
    gate.refusalReason = refusals.join(' ');
  } else if (gate.degraded) {
    // Not a refusal — but `refusalReason` is the contract's only analyst-facing
    // string on the gate, so the degradation sentence rides here with an
    // unambiguous prefix. The UI keys off `passed`/`degraded`, never off this text.
    gate.refusalReason = `Degraded: ${degradations.join(' ')}`;
  }
  return gate;
}
