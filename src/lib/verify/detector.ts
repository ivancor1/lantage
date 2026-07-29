/**
 * Statistical AI-generation detector — last, behind an interface, and reported
 * only as a calibrated band.
 *
 * The market numbers this module is built against (docs/MASTER_PLAN.md §5):
 * vendors advertise 98%+; the best commercial detector on Deepfake-Eval-2024
 * (in-the-wild media) is **82%**; on Chameleon — AI images that passed a human
 * Turing test — nearly all detectors including AIDE classify most AI images as
 * real, near chance. A 2026 NewsGuard audit found 3 of 5 leading detectors
 * misclassified authentic news photos and the worst flagged **40% of real photos
 * as AI**. Consumer detectors run 5-15% FPR on real photographs.
 *
 * Therefore: this provider returns a raw score, and the *only* consumer is the
 * calibration layer, which turns it into a band. A fused point percentage — the
 * "Likely AI-generated: 92%" panel the incumbents ship — is not producible from
 * this interface by design.
 */

import { z } from 'zod';
import { ENDPOINTS, MODEL_VERSIONS } from '@/lib/cascade/config';
import { callJson } from '@/lib/cascade/net';
import { type ImageRef, type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';

export interface DetectorReading {
  /** Raw provider score 0..1. Not a probability. Never rendered. */
  rawScore: number;
  modelVersion: string;
  /** Provider's own class label, kept for the audit trail. */
  label?: string;
}

export interface AiDetectorProvider {
  readonly name: string;
  score(args: {
    image: ImageRef;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Result<DetectorReading, StageFailure>>;
}

/**
 * Hive-class classifier client (~$0.003/img — the best-tested commercial option).
 *
 * The response shape is tolerant on purpose: we look for the highest score among
 * classes whose name indicates machine generation, so a provider adding a class
 * does not break the parse. If the shape changes structurally, `callJson` returns
 * `invalid-response` and VERIFY reports the detector as unavailable rather than
 * guessing.
 */
const HiveResponseSchema = z.object({
  status: z
    .array(
      z.object({
        response: z
          .object({
            output: z
              .array(
                z.object({
                  classes: z
                    .array(z.object({ class: z.string(), score: z.number() }))
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

const GENERATED_CLASS_HINTS = ['ai_generated', 'ai-generated', 'not_authentic', 'deepfake', 'synthetic'];

export class HiveAiDetector implements AiDetectorProvider {
  readonly name = MODEL_VERSIONS.detector;
  private readonly apiKey: string | undefined;
  private readonly url: string | undefined;

  constructor(
    apiKey: string | undefined = process.env.HIVE_API_KEY,
    url: string | undefined = ENDPOINTS.detector,
  ) {
    this.apiKey = apiKey;
    this.url = url;
  }

  async score(args: {
    image: ImageRef;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Result<DetectorReading, StageFailure>> {
    if (!this.apiKey || !this.url) {
      return err(
        failure(
          'not-configured',
          'No statistical detector is configured. Provenance and metadata checks still ran; the statistical stage was not reached.',
        ),
      );
    }
    if (!args.image.url && !args.image.bytes) {
      return err(failure('no-input', 'No image available to score.'));
    }

    const res = await callJson({
      url: this.url,
      method: 'POST',
      headers: { authorization: `Token ${this.apiKey}` },
      body: args.image.url
        ? { url: args.image.url }
        : { image_base64: Buffer.from(args.image.bytes as Uint8Array).toString('base64') },
      timeoutMs: args.timeoutMs,
      schema: HiveResponseSchema,
      signal: args.signal,
      label: 'AI-generation detector',
    });
    if (!res.ok) return res;

    let best: { class: string; score: number } | null = null;
    for (const status of res.value.status ?? []) {
      for (const output of status.response?.output ?? []) {
        for (const cls of output.classes ?? []) {
          const name = cls.class.toLowerCase();
          if (!GENERATED_CLASS_HINTS.some((hint) => name.includes(hint))) continue;
          if (!best || cls.score > best.score) best = cls;
        }
      }
    }
    if (!best) {
      return err(
        failure(
          'invalid-response',
          'The detector returned no recognisable generation class, so no statistical reading was recorded.',
        ),
      );
    }
    return ok({
      rawScore: Math.max(0, Math.min(1, best.score)),
      modelVersion: this.name,
      label: best.class,
    });
  }
}
