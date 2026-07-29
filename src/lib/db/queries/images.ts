import type { LantageClient } from '../client';
import { DbError, unwrap, unwrapMaybe } from '../errors';
import type { ImageRow, Json } from '../types';

export type InsertImageInput = {
  storagePath: string;
  /** Lowercase hex SHA-256 of the original bytes. The dedup key within an org. */
  sha256: string;
  mime: string;
  width?: number;
  height?: number;
  /**
   * EXIF/XMP verbatim. Recorded for the ledger and NEVER trusted as a location
   * claim. Must not contain plate characters — strip OCR output before it reaches
   * here (Mapillary ToS §12; we ship no ALPR).
   */
  exif?: Json;
  caseId?: string | null;
  orgId?: string;
  uploadedBy?: string;
};

export async function insertImage(
  client: LantageClient,
  input: InsertImageInput,
): Promise<ImageRow> {
  const sha256 = input.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`insertImage: sha256 must be 64 lowercase hex characters, got "${input.sha256}"`);
  }

  return unwrap(
    'insertImage',
    await client
      .from('images')
      .insert({
        storage_path: input.storagePath,
        sha256,
        mime: input.mime,
        width: input.width ?? null,
        height: input.height ?? null,
        exif: input.exif ?? {},
        case_id: input.caseId ?? null,
        ...(input.orgId ? { org_id: input.orgId } : {}),
        ...(input.uploadedBy ? { uploaded_by: input.uploadedBy } : {}),
      })
      .select('*')
      .single(),
  );
}

/**
 * Insert, or return the row that already holds this hash.
 *
 * Re-uploading the same frame is normal — the same photo arrives attached to three
 * claims, which is the whole premise of CLAIM. The unique index on (org_id, sha256)
 * makes that a 23505, and this turns it into the existing row rather than an error
 * the UI has to explain.
 */
export async function insertImageDedup(
  client: LantageClient,
  input: InsertImageInput,
): Promise<{ image: ImageRow; deduplicated: boolean }> {
  try {
    return { image: await insertImage(client, input), deduplicated: false };
  } catch (error) {
    if (error instanceof DbError && error.pgError.code === '23505') {
      const existing = await getImageBySha256(client, input.sha256.toLowerCase());
      if (existing) return { image: existing, deduplicated: true };
    }
    throw error;
  }
}

export async function getImage(client: LantageClient, imageId: string): Promise<ImageRow | null> {
  return unwrapMaybe(
    'getImage',
    await client.from('images').select('*').eq('id', imageId).maybeSingle(),
  );
}

export async function getImageBySha256(
  client: LantageClient,
  sha256: string,
): Promise<ImageRow | null> {
  return unwrapMaybe(
    'getImageBySha256',
    await client.from('images').select('*').eq('sha256', sha256.toLowerCase()).maybeSingle(),
  );
}
