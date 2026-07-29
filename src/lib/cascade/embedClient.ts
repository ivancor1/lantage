/**
 * Client for B1's Modal inference service (`/embed`).
 *
 * The request/response contract is `EmbedRequestSchema` / `EmbedResponseSchema`
 * in `@/lib/contracts/schemas` — owned by B1, consumed here, validated on the
 * way in. A signed URL is preferred over base64: it keeps a multi-megabyte
 * payload out of our request logs and Modal fetches the object directly.
 */

import { EmbedResponseSchema, type EmbedRequest, type EmbedResponse } from '@/lib/contracts/schemas';
import { ENDPOINTS } from './config';
import { callJson } from './net';
import { type ImageRef, type Result, type StageFailure, err, failure } from './types';

export type EmbedModel = EmbedRequest['models'][number];

export interface EmbedArgs {
  image: ImageRef;
  models: EmbedModel[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface EmbedClient {
  embed(args: EmbedArgs): Promise<Result<EmbedResponse, StageFailure>>;
}

export class ModalEmbedClient implements EmbedClient {
  private readonly baseUrl: string | undefined;
  private readonly token: string | undefined;

  constructor(
    baseUrl: string | undefined = ENDPOINTS.embed,
    token: string | undefined = process.env.MODAL_EMBED_TOKEN,
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async embed(args: EmbedArgs): Promise<Result<EmbedResponse, StageFailure>> {
    if (!this.baseUrl) {
      return err(
        failure(
          'not-configured',
          'Inference service not configured (MODAL_EMBED_URL unset), so no embedding could be computed.',
        ),
      );
    }
    const body = toRequestBody(args);
    if (!body) {
      return err(failure('no-input', 'No image URL or bytes available to embed.'));
    }
    return callJson({
      url: `${this.baseUrl.replace(/\/$/, '')}/embed`,
      method: 'POST',
      headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
      body,
      timeoutMs: args.timeoutMs,
      schema: EmbedResponseSchema,
      signal: args.signal,
      label: 'embedding service',
    });
  }
}

function toRequestBody(args: EmbedArgs): EmbedRequest | null {
  if (args.image.url) {
    return { imageUrl: args.image.url, models: args.models };
  }
  if (args.image.bytes) {
    return {
      imageBase64: Buffer.from(args.image.bytes).toString('base64'),
      models: args.models,
    };
  }
  return null;
}

/** Version string for `ResultProvenance.models`, preferring what the service reports. */
export function reportedVersion(
  response: EmbedResponse | null,
  model: EmbedModel,
  fallback: string,
): string {
  const entry = response?.embeddings?.[model];
  if (entry?.version) return `${model}@${entry.version}`;
  return fallback;
}
