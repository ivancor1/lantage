/**
 * Mapillary attribution — the licence condition attached to every pixel we ship.
 *
 * Owned by B3 (harvest); CONSUMED BY A1 (UI). A1 should re-export or copy these
 * helpers into `src/lib/` and render `MAPILLARY_ATTRIBUTION_SPEC` wherever harvested
 * imagery is visible. This file lives under services/harvest/ because the obligation
 * originates with the harvest, not the UI — the UI is just where it becomes visible.
 *
 * WHY THIS IS NOT OPTIONAL POLISH
 * -------------------------------
 * Mapillary is the only street-imagery source whose licence affirmatively permits
 * what Lantage does (Terms §12 names "datasets" and "algorithms" as permitted
 * commercial purposes). Google's Street View terms forbid it outright, which is why
 * every canonical VPR dataset is evaluation-only forever — see docs/MASTER_PLAN.md
 * §3, decision 2. The permission is conditional. Terms §11, verified 2026-07-29:
 *
 *   For images served from our own servers:
 *     "you must attribute the image(s) by visibly displaying the Mapillary logo and
 *      linking back to the Mapillary homepage or corresponding Mapillary image page"
 *
 *   For data integrated via the API or vector tiles:
 *     "you must attribute the source of the data by visibly displaying the Mapillary
 *      logo and linking back to the Mapillary homepage"
 *
 * Both clauses require the LOGO, not a text credit. Shipping "Imagery: Mapillary" as
 * plain text does not satisfy §11. Dropping attribution does not merely look bad; it
 * removes the basis on which the entire index is licensed.
 */

/** Terms §11 permits linking to either target. Both are compliant. */
export const MAPILLARY_HOMEPAGE_URL = 'https://www.mapillary.com' as const;

/**
 * Per-image page. `pKey` is the image id — the same value as
 * `MapillaryRecord.mapillaryId`.
 *
 *   https://www.mapillary.com/app/?pKey=<imageId>&focus=photo
 *
 * NOTE ON CONFIDENCE: the API reference does not document a canonical deep-link
 * format; this is the viewer route Mapillary's own web app uses. §11 accepts the
 * homepage as an alternative target, so `attributionFor()` degrades to the homepage
 * rather than risking a dead link — compliance never depends on the deep link
 * resolving. Confirm the format against a live id on the first real harvest and
 * flip `MAPILLARY_IMAGE_PAGE_VERIFIED` when you have.
 */
export const MAPILLARY_IMAGE_PAGE_VERIFIED = false as const;

export function mapillaryImagePageUrl(imageId: string): string {
  if (!imageId) throw new Error('mapillaryImagePageUrl: imageId is required');
  return `${MAPILLARY_HOMEPAGE_URL}/app/?pKey=${encodeURIComponent(imageId)}&focus=photo`;
}

/**
 * The logo must be the official asset from Mapillary's press kit, self-hosted.
 * Do not redraw it, recolour it, or substitute a text wordmark: an approximated mark
 * is a trademark problem on top of a licence problem.
 *
 * Fetch it from https://www.mapillary.com/press-kit and commit it here. A1 owns
 * `public/`, so this path is a request, not a file this module creates.
 */
export const MAPILLARY_LOGO_ASSET = '/vendor/mapillary/mapillary-logo.svg' as const;
export const MAPILLARY_LOGO_ALT = 'Mapillary' as const;

/** Minimum legible size for the mark. Smaller reads as decoration, not attribution. */
export const MAPILLARY_LOGO_MIN_HEIGHT_PX = 14 as const;

export type MapillaryAttributionSurface =
  /** Full-bleed or hero display of a single harvested frame. */
  | 'image-detail'
  /** Thumbnail grids: candidate lists, evidence strips, comparison rails. */
  | 'thumbnail-grid'
  /** MapLibre canvas showing harvested coverage or match markers. */
  | 'map'
  /** Anything leaving the app: PDF export, printed report, shared link preview. */
  | 'export';

export interface MapillaryAttribution {
  /** Rendered as an image, never as text. See MAPILLARY_LOGO_ASSET. */
  readonly logoSrc: string;
  readonly logoAlt: string;
  readonly logoMinHeightPx: number;
  /** Where the logo links. Always a real, resolving URL. */
  readonly href: string;
  /** Supplementary credit line. Never a substitute for the logo. */
  readonly creditText: string;
  /** True when `href` is the specific image page rather than the homepage. */
  readonly linksToImagePage: boolean;
}

/**
 * Build the attribution for one harvested image.
 *
 * Pass the `mapillaryId` from a `MapillaryRecord`. Omit it — for a map layer or a
 * grid crediting many images at once — and this returns homepage attribution, which
 * §11 explicitly allows.
 */
export function attributionFor(mapillaryId?: string | null): MapillaryAttribution {
  const useImagePage = Boolean(mapillaryId) && MAPILLARY_IMAGE_PAGE_VERIFIED;
  return {
    logoSrc: MAPILLARY_LOGO_ASSET,
    logoAlt: MAPILLARY_LOGO_ALT,
    logoMinHeightPx: MAPILLARY_LOGO_MIN_HEIGHT_PX,
    href: useImagePage ? mapillaryImagePageUrl(mapillaryId as string) : MAPILLARY_HOMEPAGE_URL,
    creditText: mapillaryId ? `Imagery © Mapillary contributors · ${mapillaryId}` : 'Imagery © Mapillary contributors',
    linksToImagePage: useImagePage,
  };
}

/**
 * Component spec for A1. This is the contract; the implementation is A1's.
 *
 * Render as a `<MapillaryCredit surface={...} mapillaryId={...} />` in
 * `src/components/`, styled with the existing `.glass-pill` primitive (see
 * docs/DESIGN_SYSTEM.md) — do not invent a new surface treatment for it.
 *
 * Placement rules, per surface:
 *
 *   image-detail    Overlay bottom-left of the frame, inside the image bounds so it
 *                   travels with any screenshot. Link to the image page.
 *   thumbnail-grid  ONE credit per grid, not per tile — 40 logos is noise, and §11
 *                   asks for visible attribution of the imagery, not per-instance
 *                   stamping. Anchor it to the grid container. Individual tiles link
 *                   to their own image page on click-through.
 *   map             Bottom-right of the MapLibre canvas, in the same attribution row
 *                   as the Protomaps/OpenStreetMap credit. Mapillary sits alongside
 *                   them, not instead of them.
 *   export          Rasterise the logo into the artifact. An exported PDF that
 *                   depends on a live CDN request loses its attribution the moment
 *                   it is opened offline, which is exactly when it matters.
 *
 * Non-negotiables, whatever the surface:
 *   1. The logo is always visible without interaction. Not behind a tooltip, an
 *      "info" affordance, a hover state, or a collapsed panel.
 *   2. It is never dismissible. Same standing as LEAD_DISCLAIMER — permanent UI
 *      furniture, not a toast.
 *   3. `href` opens in a new tab (`target="_blank" rel="noopener noreferrer"`); the
 *      link must actually resolve.
 *   4. Contrast ratio >= 3:1 against whatever is behind it. On dark imagery that
 *      means a scrim; `.glass-pill` already provides one.
 *   5. No zoom, enhance, sharpen, upscale, or deblur control anywhere on a surface
 *      showing harvested imagery. Mapillary Terms §12 requires technical safeguards
 *      that "prohibit reidentification or unblurring of any Content, including any
 *      individual or license plate" — a client-side enhance control is precisely the
 *      process that clause forbids, and it would undo the `blurApplied` assertion the
 *      harvest makes at ingest. Pan and fit-to-window only.
 */
export const MAPILLARY_ATTRIBUTION_SPEC = {
  requiredOnSurfaces: ['image-detail', 'thumbnail-grid', 'map', 'export'] as const,
  logoRequired: true,
  textCreditSufficientAlone: false,
  dismissible: false,
  linkTargets: [MAPILLARY_HOMEPAGE_URL, 'https://www.mapillary.com/app/?pKey=<imageId>&focus=photo'] as const,
  termsSection: '§11 (attribution) · §12 (commercial use, anti-unblurring safeguards)',
  termsVerifiedOn: '2026-07-29',
  prohibitedControls: ['zoom-beyond-native', 'enhance', 'sharpen', 'upscale', 'deblur'] as const,
} as const;

/**
 * Dev-time guard, mirroring the `assert*` invariants in src/lib/contracts/types.ts.
 * Call it in the component that renders harvested imagery so a missing credit fails
 * in review rather than in production.
 */
export function assertMapillaryAttributionRendered(
  surface: MapillaryAttributionSurface,
  rendered: { logoVisible: boolean; href: string | null },
): void {
  if (!rendered.logoVisible) {
    throw new Error(
      `Mapillary attribution missing on "${surface}": Terms §11 requires visibly ` +
        `displaying the Mapillary logo wherever harvested imagery appears. A text ` +
        `credit alone is not sufficient.`,
    );
  }
  if (!rendered.href || !rendered.href.startsWith(MAPILLARY_HOMEPAGE_URL)) {
    throw new Error(
      `Mapillary attribution on "${surface}" must link back to ${MAPILLARY_HOMEPAGE_URL} ` +
        `or the corresponding image page. Got: ${String(rendered.href)}`,
    );
  }
}
