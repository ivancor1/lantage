/**
 * POST /api/upload — store one or more images on local disk for the LIVE path.
 *
 * THIS ROUTE IS INTENTIONALLY UNAUTHENTICATED. It is for local single-operator
 * use only: no session, no org scoping, no audit row, and it writes to
 * `.lantage-uploads/` on the machine running the dev server. The authenticated,
 * audited, org-scoped production path is `/api/search` — deploy that one
 * publicly, never this one.
 *
 * What the client says about a file is not trusted: the MIME type is sniffed from
 * the magic bytes, the filename is recorded but never used to build a path, and
 * the id is the sha256 of the stored bytes. See `src/lib/live/uploads.ts`.
 */

import { MAX_UPLOAD_BYTES, oversizeReason, storeUpload, toClientRecord } from '@/lib/live/uploads';
import type { UploadRecord } from '@/lib/live/contract';

/** Node runtime: this route hashes buffers and writes to the filesystem. */
export const runtime = 'nodejs';

interface RejectedUpload {
  filename: string;
  reason: string;
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return json(
      {
        error: 'bad-request',
        message:
          'Send the images as multipart/form-data. Any field name is accepted; one file per field, or several under the same name.',
      },
      415,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    // A truncated or malformed multipart body, or a body over the platform's own
    // request limit. The parser's message is more specific than anything invented.
    return json(
      {
        error: 'bad-request',
        message: `The multipart body could not be read: ${e instanceof Error ? e.message : String(e)}`,
      },
      400,
    );
  }

  const files: File[] = [];
  for (const value of form.values()) {
    if (typeof value === 'object' && value !== null && value instanceof File) files.push(value);
  }

  if (files.length === 0) {
    return json(
      {
        error: 'bad-request',
        message: 'No file part was present in the multipart body.',
      },
      400,
    );
  }

  const uploads: UploadRecord[] = [];
  const rejected: RejectedUpload[] = [];
  let deduplicated = 0;

  for (const file of files) {
    // Guard on the declared size before buffering, so an oversize file is refused
    // without being read into memory first.
    if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({ filename: file.name, reason: oversizeReason(file.size) });
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      rejected.push({
        filename: file.name,
        reason: `The bytes could not be read from the request: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    try {
      const outcome = await storeUpload({ filename: file.name, bytes });
      if (outcome.ok) {
        uploads.push(toClientRecord(outcome.record));
        if (outcome.deduplicated) deduplicated += 1;
      } else {
        rejected.push({ filename: outcome.filename, reason: outcome.reason });
      }
    } catch (e) {
      // Disk full, permissions, read-only filesystem. Say which one.
      return json(
        {
          error: 'storage-unavailable',
          message: `The upload directory could not be written: ${e instanceof Error ? e.message : String(e)}`,
        },
        500,
      );
    }
  }

  if (uploads.length === 0) {
    // Every file was refused. The reason is the operator's only instruction, so it
    // is the message rather than a generic one.
    return json(
      {
        error: 'unsupported-media-type',
        message: rejected[0]?.reason ?? 'No file could be stored.',
        rejected,
      },
      415,
    );
  }

  return json(
    {
      uploads,
      rejected,
      /** How many of the returned records were already on disk under the same sha256. */
      deduplicated,
    },
    201,
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
