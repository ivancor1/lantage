/**
 * GET /api/uploads/[id] — serve a stored upload back for preview.
 *
 * THIS ROUTE IS INTENTIONALLY UNAUTHENTICATED. It is for local single-operator
 * use only and it will serve any bytes under `.lantage-uploads/` to anyone who
 * can reach the port. The authenticated, org-scoped production path is
 * `/api/search`; deploy that one publicly, never this one.
 *
 * Two behaviours worth knowing:
 *
 *  - HEIC and TIFF do not render in most browsers, so for those the downscaled
 *    JPEG derivative generated at upload time is served instead of the original.
 *    Which one you got is stated in `x-lantage-variant`, because a preview is not
 *    the file that was hashed and must never be mistaken for it. `?original=1`
 *    forces the stored bytes; `?preview=1` forces the derivative.
 *  - The id is a sha256 and is validated against `/^[0-9a-f]{64}$/` before it
 *    touches the filesystem. That is the whole path-traversal defence: no client
 *    string is ever joined onto the upload directory.
 */

import { isUploadId, readUploadForServing } from '@/lib/live/uploads';

/** Node runtime: this route reads from the local filesystem. */
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  // Generated type helper, not a hand-written prop type (AGENTS.md §3).
  context: RouteContext<'/api/uploads/[id]'>,
): Promise<Response> {
  // Next 16: `params` is a Promise. Synchronous access was removed outright.
  const { id } = await context.params;

  if (!isUploadId(id)) {
    return json(
      {
        error: 'bad-request',
        message: 'An upload id is the sha256 of the stored bytes: 64 lowercase hex characters.',
      },
      400,
    );
  }

  const url = new URL(request.url);
  const forceOriginal = url.searchParams.get('original') === '1';
  const forcePreview = url.searchParams.get('preview') === '1';

  const served = await readUploadForServing(id, { forceOriginal, forcePreview });
  if (!served) {
    return json(
      {
        error: 'not-found',
        message: forcePreview
          ? `No preview was generated for upload ${id}. Request it without ?preview=1 to get the stored bytes.`
          : `No upload ${id} is stored under .lantage-uploads.`,
      },
      404,
    );
  }

  // Content-addressed: the bytes under an id can never change, so the strongest
  // available cache directive is also the correct one. `private` rather than
  // `public` on purpose — case imagery must not sit in a shared proxy cache.
  const etag = `"${id}-${served.variant}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-lantage-variant': served.variant,
      },
    });
  }

  return new Response(toBody(served.bytes), {
    status: 200,
    headers: {
      'content-type': served.mime,
      'content-length': String(served.bytes.byteLength),
      'cache-control': 'private, max-age=31536000, immutable',
      etag,
      'x-lantage-variant': served.variant,
      // These bytes are operator-supplied and are served verbatim. Sniffing them
      // as anything other than the declared image type is not wanted.
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * `Buffer` is a `Uint8Array`, but @types/node types its backing store as
 * `ArrayBufferLike`, which `BodyInit` does not accept. Casting avoids copying up
 * to 25 MB per request to satisfy the type checker.
 */
function toBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
