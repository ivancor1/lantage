/**
 * C2PA / Content Credentials — the first check and the only cryptographic one.
 *
 * Deterministic, cheap, high precision, and asymmetric in a way that must never
 * be flattened:
 *
 *  - A **valid** manifest is strong evidence. Leica, Sony, Nikon and Canon sign
 *    in-camera; OpenAI signs DALL·E/Sora output. A signed claim naming a
 *    generative tool is the single most reliable finding this product can make.
 *  - **Absence of a manifest means nothing.** Platforms strip manifests on upload
 *    approximately 100% of the time, so most real case imagery has none. Absence
 *    must never be presented as evidence of fakery, and no code path here is
 *    allowed to produce a positive indicator from it.
 *
 * What is implemented without a dependency: *presence* detection, by looking for
 * the JUMBF box that carries the manifest (JPEG APP11, PNG `caBX`, ISOBMFF `jumb`).
 * Presence is a fact about the bytes. Validity is not — it needs certificate-chain
 * verification against the C2PA trust list, which is what `C2paReader` is for.
 */

import { type Result, type StageFailure, err, failure, ok } from '@/lib/cascade/types';

export interface C2paManifest {
  hasManifest: boolean;
  /**
   * Undefined means "not verified", which is different from `false` ("verified
   * and the signature does not check out"). Do not collapse the two.
   */
  valid?: boolean;
  issuer?: string;
  /** `claim_generator`, e.g. "Adobe Firefly", "OpenAI DALL·E 3", "Leica M11-P". */
  generator?: string;
  /** IPTC digitalSourceType from the manifest's assertions, if parsed. */
  digitalSourceType?: string;
}

export interface C2paReader {
  readonly name: string;
  read(bytes: Uint8Array): Promise<Result<C2paManifest, StageFailure>>;
}

/**
 * Presence-only probe. Correct as far as it goes, and it goes far enough to be
 * useful: "a manifest is present but we have not verified it" is a true statement
 * that tells the analyst to run c2patool.
 *
 * TODO: swap in a validating reader (`c2pa-node`, or shelling to `c2patool`) to
 * populate `valid`, `issuer`, and `generator`. Until then a present-but-unverified
 * manifest is treated as *no cryptographic evidence either way* — it never
 * produces an indicator of generation, and its absence never does either.
 */
export class ContainerC2paProbe implements C2paReader {
  readonly name = 'c2pa-presence-probe@0.1';

  async read(bytes: Uint8Array): Promise<Result<C2paManifest, StageFailure>> {
    if (bytes.length < 8) {
      return err(failure('no-input', 'No bytes to check for Content Credentials.'));
    }
    return ok({ hasManifest: hasJumbfBox(bytes) });
  }
}

/** JPEG APP11 with a JUMBF payload, PNG `caBX` chunk, or an ISOBMFF `jumb` box. */
export function hasJumbfBox(bytes: Uint8Array): boolean {
  // The manifest sits near the front of every container that carries one; a
  // bounded scan keeps this O(1) on multi-megabyte files.
  const limit = Math.min(bytes.length, 512 * 1024);
  const needles = ['jumb', 'caBX', 'c2pa'];
  for (const needle of needles) {
    if (indexOfAscii(bytes, needle, limit) >= 0) return true;
  }
  return false;
}

function indexOfAscii(b: Uint8Array, needle: string, limit: number): number {
  const end = Math.min(b.length - needle.length, limit);
  for (let i = 0; i <= end; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (b[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Generators whose signed presence in a manifest is a direct statement that the
 * asset was machine-generated. Matched case-insensitively as substrings.
 */
const GENERATIVE_GENERATORS = [
  'dall',
  'sora',
  'firefly',
  'midjourney',
  'stable diffusion',
  'stability',
  'imagen',
  'gemini',
  'flux',
  'ideogram',
  'runway',
  'pika',
  'luma',
  'grok',
  'nano banana',
];

export function manifestNamesGenerativeTool(manifest: C2paManifest): boolean {
  const haystack = `${manifest.generator ?? ''} ${manifest.digitalSourceType ?? ''}`.toLowerCase();
  if (haystack.includes('trainedalgorithmicmedia') || haystack.includes('compositewithtrainedalgorithmicmedia')) {
    return true;
  }
  return GENERATIVE_GENERATORS.some((g) => haystack.includes(g));
}
