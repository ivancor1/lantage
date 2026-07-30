/**
 * Adapters onto narrower provider interfaces.
 *
 * VEHICLE (and anything else that owns its own prompt and does its own
 * validation) declares a provider boundary shaped for itself: an image that is
 * already base64-encoded, no prompt in the request, and raw JSON back to
 * validate locally. That is a reasonable boundary and it should not have to
 * change to gain multi-vendor support.
 *
 * So this adapter is deliberately *structural*: it imports nothing from those
 * modules and names no type of theirs. It returns an object with the shape they
 * declare, which TypeScript matches by structure — meaning neither side can break
 * the other by editing a file it does not own.
 *
 * `schema` defaults to `z.unknown()` because the whole point of the VEHICLE
 * boundary is that the caller validates. Passing a real schema here just moves
 * that validation earlier, and gets the repair retry for free.
 */

import { z } from 'zod';
import { type Result, type StageFailure, err, failure } from '@/lib/cascade/types';
import type { JsonSchemaObject, LiveVisionProvider } from './types';

/** What VEHICLE's `VehicleVisionProvider` asks for, expressed structurally. */
export interface PreEncodedJsonProvider {
  readonly name: string;
  extract(req: {
    image: { base64: string; mediaType: string };
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<
    Result<
      { json: unknown; modelVersion: string; costUsd?: number; attempts: number },
      StageFailure
    >
  >;
}

export interface PreEncodedAdapterOptions {
  provider: LiveVisionProvider;
  /** The caller's own prompt. It must ask for JSON; the adapter enforces that too. */
  prompt: string;
  /** Optional pre-validation. Defaults to passing the parsed JSON through untouched. */
  schema?: z.ZodType<unknown>;
  /** Optional vendor-side schema. Sanitised for you. */
  jsonSchema?: JsonSchemaObject;
  schemaName?: string;
  maxOutputTokens?: number;
  /**
   * Long edge to send. The caller has already encoded the image, so re-encoding
   * costs a decode; leave unset to send what you were given.
   */
  maxLongEdgePx?: number;
}

export function asPreEncodedJsonProvider(opts: PreEncodedAdapterOptions): PreEncodedJsonProvider {
  const { provider } = opts;
  return {
    name: provider.name,
    async extract(req) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(req.image.base64, 'base64'));
      } catch {
        return err(failure('no-input', 'The base64 image payload could not be decoded.'));
      }
      if (bytes.byteLength === 0) {
        return err(failure('no-input', 'The base64 image payload decoded to zero bytes.'));
      }

      const res = await provider.extractStructured({
        image: { imageId: 'pre-encoded', bytes, mimeType: req.image.mediaType },
        prompt: opts.prompt,
        schema: opts.schema ?? z.unknown(),
        ...(opts.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}),
        ...(opts.schemaName ? { schemaName: opts.schemaName } : {}),
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
        ...(opts.maxOutputTokens === undefined ? {} : { maxOutputTokens: opts.maxOutputTokens }),
        ...(opts.maxLongEdgePx === undefined ? {} : { maxLongEdgePx: opts.maxLongEdgePx }),
      });
      if (!res.ok) return res;

      return {
        ok: true,
        value: {
          json: res.value.value,
          modelVersion: `${provider.vendor}:${res.value.modelVersion}`,
          // Absent when the model's price is unknown. The caller's `costUsd?` is
          // optional for exactly this reason, so the two contracts agree.
          ...(res.value.usage.costUsd === undefined ? {} : { costUsd: res.value.usage.costUsd }),
          attempts: res.value.attempts,
        },
      };
    },
  };
}
