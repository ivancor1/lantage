/**
 * INTERIOR — "which building is this photo inside?"
 *
 * Read this before changing anything here, because the honest answer to that
 * question is usually **we cannot tell you**, and the module is built around
 * saying so.
 *
 * What an interior frame can actually support:
 *
 *  - COUNTRY, sometimes REGION, from fixtures and construction convention. The
 *    electrical outlet is the single strongest cue in the room (there are only
 *    ~15 plug standards worldwide and they partition the map), followed by switch
 *    plates, door hardware, window mechanism, heating type, and the vocabulary of
 *    the construction itself.
 *  - A specific BUILDING only from one of two things: a published copy of the
 *    image on a page that names the address (see `./provenance.ts`), or legible
 *    address text in the frame itself. Fixtures cannot do it. Neither can a
 *    vision model's recognition of "a nice mid-century living room".
 *
 * So: nothing this module produces may claim `precision: 'street'`, and when
 * there is no provenance hit and no legible address the response says in words
 * that the image is not resolvable to a building and names what would make it
 * resolvable. A confident-sounding region list with no such statement would be
 * the exact unverifiable claim this product exists not to make.
 *
 * LEGAL BOUNDARY: we do not index MLS/Zillow/Redfin/Realtor listing photos and
 * must not start. See the header of `./provenance.ts` for the case law and the
 * legitimate alternative.
 */

import {
  type Evidence,
  type GeoCandidate,
  type LatLon,
  type QualityGate,
  type StageTrace,
  assertStreetPrecisionIsEarned,
} from '@/lib/contracts/types';
import type { VlmClues } from '@/lib/contracts/schemas';
import { type WorkingCandidate, finaliseCandidates } from '@/lib/cascade/candidate';
import { COSTS, MODEL_VERSIONS, RETRIEVAL } from '@/lib/cascade/config';
import { bboxCenter, bboxIntersection, bboxRadiusM, precisionForRadius } from '@/lib/cascade/geo';
import { readImageHeader } from '@/lib/cascade/imageHeader';
import { type MetadataFacts, extractMetadata } from '@/lib/cascade/preprocess';
import { evaluateQualityGate } from '@/lib/cascade/qualityGate';
import { Budget, type Bbox, type ImageRef, type Result, type StageFailure } from '@/lib/cascade/types';
import type { VlmRequest, VlmResult } from '@/lib/cascade/vlmProvider';
import { cropUrl } from '@/lib/verify/ocrGeocode';
// Owned by L1. Returns a provider for whichever vision key is set, or null.
import { selectProvider } from '@/lib/live/vision';
import type { CapabilityGap, LiveAnalyzeRequest, ProvenanceHit } from './contract';
import {
  type AnalysableImage,
  ensureAnalysable,
  formatLabel,
  undecodableGap,
  undecodableRefusal,
} from './imageDecode';
import {
  PROVENANCE_TIMEOUTS_MS,
  type EnvLike,
  type ProvenanceProvider,
  configuredProviders,
  extractAddressLike,
  findPublishedCopies,
  isPubliclyFetchableUrl,
  provenanceGaps,
} from './provenance';

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * The interior clue prompt.
 *
 * Two things about its shape. First, like the outdoor prompt in
 * `@/lib/cascade/vlmProvider`, it never asks "where is this?" — it asks for
 * discrete observations, because the documented failure mode of frontier VLMs on
 * this task is recognising a place and then fabricating the evidence for it (ACL
 * 2026 GeoRC: experts found "many suspicious or hallucinated attributes").
 *
 * Second, it emits `VlmCluesSchema`, the same contract LOCATE uses, so a single
 * validator, scrubber and calibration set covers both. That schema's `kind`
 * enums are outdoor-shaped, so the prompt states explicitly which bucket each
 * indoor signal goes in. Nothing is lost: the signal itself lives in `observed`
 * and its geography in `impliesRegions`; `kind` is only a coarse bucket.
 */
export const INTERIOR_CLUE_EXTRACTION_PROMPT = `You are a forensic image analyst examining an INDOOR photograph. You are producing an evidence list for a human investigator who will independently verify every line you write.

Your job is to ENUMERATE WHAT IS VISIBLE, not to identify the place. A named country or city with no visible support is worse than no answer, because the investigator will waste hours on it.

WORK THROUGH THIS CHECKLIST IN ORDER. It is ordered by how strongly each signal actually discriminates between countries indoors.

1. ELECTRICAL OUTLETS AND SWITCHES — the strongest indoor cue there is. For every socket or switch you can see, describe the SHAPE you observe: number of holes/pins, whether they are round or rectangular or angled, earth pin or side earth clips, recessed or flush, integral on/off switch, plate shape and screw positions. Then name the plug standard(s) that shape is consistent with, using the standard letter types: Type A/B (North America, Japan), Type C (Europe, two round pins), Type D (India), Type E (France, Belgium, Poland, Czechia — round socket with a protruding earth pin), Type F/Schuko (Germany and most of continental Europe — round recess with side earth clips), Type G (UK, Ireland, Malta, Cyprus, Malaysia, Singapore, Gulf states — three large rectangular pins, usually a switched socket), Type H (Israel), Type I (Australia, New Zealand, China, Argentina — angled flat pins), Type J (Switzerland), Type K (Denmark), Type L (Italy, Chile), Type M (South Africa, large round pins), Type N (Brazil, South Africa). Also describe the SWITCH style: small US toggle or flat decora paddle; large UK rocker on a square plate; European square plate with a wide rocker; pull cord.
2. LIGHT-SWITCH HEIGHT AND PLATE SHAPE, and DOOR HARDWARE — lever handle vs round knob, escutcheon shape, hinge type, whether the door is hollow flush, panelled, or glazed.
3. WINDOW MECHANISM — vertically sliding sash, side-hinged casement, inward-opening tilt-turn with a single long handle, awning, jalousie, sliding. Also frame material and whether there are internal or external shutters, roller blinds in a head box, or trickle vents.
4. HEATING AND VENTILATION — wall radiator (panel, column, towel), underfloor, forced-air supply register or return grille, ductless mini-split head, window unit, wood stove, fireplace type, thermostat style.
5. CEILING AND WALLS — flat painted plasterboard/drywall, textured, popcorn, artex swirl, exposed beams, coving/cornice profile, plaster vs board joints, tile. Skirting/baseboard height and profile. Wall thickness at reveals.
6. SMOKE / HEAT DETECTOR AND OTHER SAFETY FITTINGS — shape and mounting; also sprinkler heads, alarm panels, extinguisher style, emergency signage.
7. FLOORING — board width and direction, engineered vs solid, laminate, tile format, carpet, screed, floor vents.
8. APPLIANCES, FIXTURES, BRANDS AND ANY TEXT — brand names and model numbers on appliances, sockets, thermostats, radiators, taps, toilets, packaging. Measurement units and formats on any packaging or label (metric vs imperial, date order, currency symbols, barcode prefix digits). Language and script of every piece of text. Book spines. Mail and envelopes. Newspapers. Wall calendars. Plug adapters. TV channel logos or on-screen text.
9. ANY VIEW THROUGH A WINDOW OR OPEN DOOR — TREAT THIS AS THE HIGHEST-VALUE CUE IN THE FRAME. If you can see outside at all, say so explicitly and describe it in its own observations: skyline and building shapes opposite, roof forms, terrain and horizon, vegetation species and season, snow, road markings, kerb, utility poles and wiring, vehicles, signage, sun direction. An exterior view reduces this task to ordinary outdoor geolocation, which is far more tractable, so do not summarise it — enumerate it.
10. ROOM TYPE AND CONSTRUCTION VERNACULAR — what room this is, ceiling height, whether storage is a built-in closet (North American) or a free-standing wardrobe (European), socket count and placement, whether there is a bathroom socket at all, radiator under the window vs vent in the floor, kitchen layout and cabinet/worktop conventions.

RULES
1. "observed" is only what is literally visible: the shape of a thing, a colour, verbatim text. No inference, no place names, no interpretation in that field.
2. "legibility" is how clearly you SEE the thing, not how sure you are what it means: "clear" = unambiguous, "partial" = occluded or blurred but readable, "guessed" = you are reconstructing it.
3. "bbox" is [x0, y0, x1, y1] normalised 0..1 with the origin at the TOP-LEFT. Include it whenever you can localise the observation so the investigator can look at the same pixels you did.
4. "impliesRegions" lists the countries or regions a convention is consistent with. It is allowed to be wrong — that is why it is recorded separately from the observation. Where a fitting is consistent with several countries, list all of them; do not narrow to one to look decisive.
5. Read every piece of text you can, even partial words. Any legible address, street name, postal code, phone number or letterhead is the highest-value observation available and belongs in "text".
6. NEVER transcribe or guess licence-plate characters if a vehicle is visible outside. Describe plate style only.
7. If the frame does not contain enough signal to constrain a country, set "insufficientSignal": true. "I cannot tell" is a correct and useful answer. A generic hotel room with no visible socket genuinely cannot be placed, and saying so is the right output.
8. "regionPrior" comes last, is at most 5 entries, and every entry's "supportedBy" must QUOTE observations you actually listed above. An entry that cites nothing will be discarded. Prefer the widest region your observations genuinely support — a plug standard supports a bloc of countries, not one country.

WHICH BUCKET EACH OBSERVATION GOES IN (the JSON schema below is shared with outdoor analysis, so use these mappings):
- outlets, switches, switch plates, door hardware, heating, ceilings, walls, coving, skirting, flooring, detectors, sanitaryware, cabinetry, construction vernacular -> "architecture", kind "building-material"
- windows and their mechanism, glazing, shutters, blinds -> "architecture", kind "window-style"
- styling of any label, badge or branded plate -> "architecture", kind "signage-style"
- all readable text, brands, packaging, mail, book spines -> "text" (kind "business-name" for a brand, "address-number" for a street number, "street-sign" for a street name, "phone-number", else "other"), and set "script"
- anything you can see OUTSIDE through a window or door: vegetation, terrain, sky, snow, water -> "environment"; road markings, kerbs, poles, traffic lights, bollards, hydrants, manholes -> "infrastructure"; buildings opposite -> "architecture" with the appropriate kind
- direction and quality of daylight through windows, and any shadow geometry -> "solar"

Return ONLY JSON matching this shape:
{
  "text": [{ "observed": string, "legibility": "clear"|"partial"|"guessed", "bbox"?: [number,number,number,number], "kind": "business-name"|"street-sign"|"address-number"|"transit-sign"|"phone-number"|"license-plate-region"|"other", "script"?: string }],
  "infrastructure": [{ "observed": string, "legibility": ..., "bbox"?: ..., "kind": "driving-side"|"road-marking"|"utility-pole"|"bollard"|"traffic-light"|"curb-style"|"guardrail"|"fire-hydrant"|"manhole", "impliesRegions": string[] }],
  "environment": [{ "observed": string, "legibility": ..., "bbox"?: ..., "kind": "vegetation"|"soil"|"terrain"|"sky"|"snow"|"water", "impliesRegions": string[] }],
  "architecture": [{ "observed": string, "legibility": ..., "bbox"?: ..., "kind": "building-material"|"roof-style"|"window-style"|"row-house"|"bridge"|"stair-street"|"signage-style", "impliesRegions": string[] }],
  "solar": { "shadowsVisible": boolean, "shadowAzimuthDeg"?: number, "shadowToHeightRatio"?: number, "estimatedTimeOfDay": "dawn"|"morning"|"midday"|"afternoon"|"dusk"|"night"|"unknown" },
  "regionPrior": [{ "label": string, "country"?: string, "admin1"?: string, "rawConfidence": number, "supportedBy": string[] }],
  "insufficientSignal": boolean
}`;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * The LIVE path is single-operator and has no SLA, and two of its three stages
 * are third-party crawler-index lookups. The 10s cascade ceiling exists to
 * protect a per-search SLA that does not apply here, so this is deliberately
 * looser — but it is still a hard ceiling, and every call is clamped to what is
 * left of it.
 */
export const INTERIOR_BUDGET_MS = 25_000;

/**
 * Per-call ceiling for the vision request.
 *
 * `TIMEOUTS_MS.vlm` is 6 s and its comment says why: it is sized for "Gemini 3
 * Flash structured extraction, measured 2-4s" inside the cascade's 10 s
 * six-stage budget. INTERIOR already opted out of that budget above and then
 * kept its per-call timeout, which made the two disagree.
 *
 * That disagreement is not theoretical. Measured 2026-08-01 against the
 * configured vendor (OpenAI) on a real 3024x4032 iPhone frame: the call was cut
 * off at exactly 6,000 ms having produced nothing, and LOCATE's own bench note a
 * few files over records 6.8-9.3 s for the same class of request. So on this
 * vendor the old ceiling did not merely risk a timeout, it guaranteed one — every
 * INTERIOR run would return zero candidates no matter what was in the frame.
 *
 * 30 s matches `LOCATE_TIMEOUTS_MS.vision`, which was set from that bench, and
 * still leaves room inside the 25 s budget clamp for the reverse-image lookup
 * running alongside it.
 */
export const INTERIOR_TIMEOUTS_MS = {
  vlm: 30_000,
} as const;

/**
 * Radius floors, which are how precision is capped.
 *
 * `precisionForRadius` cannot return 'street' by construction, so the only thing
 * left to prevent is an interior inference reading like a city-level fix. Without
 * a provenance hit or legible address text, floor at the region radius: an outlet
 * type is evidence about a country, not a neighbourhood. With one, allow city.
 */
const PRECISION_FLOOR_M = {
  withoutLocator: RETRIEVAL.regionRadiusM,
  withLocator: RETRIEVAL.cityRadiusM,
} as const;

/**
 * Weight on a provenance-hit evidence line.
 *
 * It has no effect on any ranking: provenance evidence is attached to the
 * response, not to a candidate, precisely because a page hit for a Tulsa listing
 * says nothing about the strength of a "United Kingdom" fixture inference. The
 * weight communicates to the reader how much attention the line deserves.
 */
const PROVENANCE_EVIDENCE_WEIGHT = 0.7;

const LEGIBILITY_WEIGHT = { clear: 0.45, partial: 0.25, guessed: 0.08 } as const;

/** Version string for `ResultProvenance.sources`. Bump when the boxes change. */
export const BUILTIN_GAZETTEER_ID = 'lantage-coarse-region-boxes@2026-07';

/** Major version of the metadata reader, for reproducibility bookkeeping. */
const EXIF_LIBRARY = 'exifr@7';

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * `VlmRequest` plus a prompt override.
 *
 * The shared `VlmProvider` bakes the outdoor prompt in. Any provider satisfies
 * this interface structurally, and one that ignores `prompt` still returns valid
 * `VlmClues` — the interior pipeline reads nothing outside the schema — it just
 * will not have been asked the indoor questions. `INTERIOR_CLUE_EXTRACTION_PROMPT`
 * is exported so a provider can honour it.
 */
export interface InteriorVlmRequest extends VlmRequest {
  prompt?: string;
}

export interface InteriorVlmProvider {
  readonly name: string;
  extractClues(req: InteriorVlmRequest): Promise<Result<VlmResult, StageFailure>>;
}

// ---------------------------------------------------------------------------
// Coarse region gazetteer
// ---------------------------------------------------------------------------

export interface RegionQuery {
  label: string;
  admin1?: string;
  country?: string;
}

export interface ResolvedRegion {
  label: string;
  bbox: Bbox;
  center: LatLon;
  radiusM: number;
  country?: string;
  /** Where the geometry came from. Quoted in the evidence line. */
  basis: string;
  /** Set when the resolver could only answer more coarsely than it was asked. */
  coarserThanAsked?: string;
}

export interface RegionResolver {
  readonly name: string;
  resolve(query: RegionQuery): Promise<ResolvedRegion | null>;
}

interface GazetteerEntry {
  label: string;
  /** [west, south, east, north]. */
  bbox: Bbox;
  aliases?: readonly string[];
  country?: string;
  note?: string;
}

/**
 * Coarse reference geometry, to ~1 degree.
 *
 * This is a gazetteer, not a finding: every box is a published national or
 * continental extent rounded down to something a reader can check in any atlas,
 * and every candidate built from one carries a radius that covers the whole box.
 * It exists because the LIVE path has no Nominatim instance, and a country-level
 * answer with no geometry cannot be drawn on a map at all.
 *
 * Do not add city boxes here. A city-level claim from interior fixtures is not
 * supportable, and `PRECISION_FLOOR_M` would flatten it anyway.
 */
const GAZETTEER: readonly GazetteerEntry[] = [
  // --- Multi-country blocs, which is what a plug standard actually implies -----
  {
    label: 'North America (Type A/B sockets, 120 V)',
    bbox: [-168, 7, -52, 72],
    aliases: ['north america', 'north american', 'type a', 'type b', 'usa or canada', 'canada or usa'],
  },
  {
    label: 'United Kingdom or Ireland (Type G sockets)',
    bbox: [-11, 49.8, 2, 61],
    aliases: ['british isles', 'united kingdom or ireland', 'uk or ireland', 'ireland or uk', 'type g'],
  },
  {
    label: 'Continental Europe (Type C/E/F sockets)',
    bbox: [-10, 35, 32, 71],
    aliases: [
      'continental europe',
      'mainland europe',
      'europe',
      'western europe',
      'central europe',
      'european union',
      'schuko',
      'type f',
      'type c',
      'type e',
    ],
  },
  {
    label: 'Northern Europe',
    bbox: [4, 54, 32, 71],
    aliases: ['nordic countries', 'nordics', 'scandinavia', 'northern europe'],
  },
  { label: 'Southern Europe', bbox: [-10, 34, 29, 47], aliases: ['southern europe', 'mediterranean europe'] },
  { label: 'Eastern Europe', bbox: [14, 40, 45, 60], aliases: ['eastern europe'] },
  {
    label: 'Middle East',
    bbox: [25, 12, 63, 42],
    aliases: ['middle east', 'gulf states', 'arabian peninsula', 'gcc'],
  },
  {
    label: 'South Asia (Type D/M sockets)',
    bbox: [60, 5, 92, 37],
    aliases: ['south asia', 'indian subcontinent', 'type d'],
  },
  { label: 'East Asia', bbox: [100, 18, 146, 54], aliases: ['east asia'] },
  { label: 'Southeast Asia', bbox: [92, -11, 141, 23], aliases: ['southeast asia', 'south east asia'] },
  {
    label: 'Australia or New Zealand (Type I sockets)',
    bbox: [110, -48, 180, -8],
    aliases: ['oceania', 'australasia', 'australia or new zealand', 'new zealand or australia'],
  },
  { label: 'South America', bbox: [-82, -56, -34, 13], aliases: ['south america', 'latin america'] },
  { label: 'Central America', bbox: [-93, 7, -77, 19], aliases: ['central america'] },
  { label: 'Africa', bbox: [-18, -35, 52, 37], aliases: ['africa', 'sub saharan africa'] },
  { label: 'Asia', bbox: [26, -11, 180, 78], aliases: ['asia'] },

  // --- Countries -------------------------------------------------------------
  {
    label: 'United States',
    bbox: [-125, 24.5, -66.9, 49.4],
    country: 'United States',
    aliases: ['usa', 'us', 'u s a', 'united states of america', 'america'],
    note: 'contiguous 48 only; Alaska, Hawaii and the territories fall outside this box',
  },
  { label: 'Canada', bbox: [-141, 41.7, -52.6, 73], country: 'Canada', aliases: ['canada'] },
  { label: 'Mexico', bbox: [-118, 14.5, -86.7, 32.7], country: 'Mexico', aliases: ['mexico'] },
  {
    label: 'United Kingdom',
    bbox: [-8.6, 49.9, 1.8, 60.9],
    country: 'United Kingdom',
    aliases: ['uk', 'u k', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
    note: 'England, Scotland, Wales and Northern Ireland all resolve to the UK box at this resolution',
  },
  { label: 'Ireland', bbox: [-10.5, 51.4, -6, 55.4], country: 'Ireland', aliases: ['ireland', 'eire', 'republic of ireland'] },
  { label: 'France', bbox: [-5.1, 42.3, 8.2, 51.1], country: 'France', aliases: ['france'], note: 'metropolitan France only' },
  { label: 'Belgium', bbox: [2.5, 49.5, 6.4, 51.5], country: 'Belgium', aliases: ['belgium'] },
  { label: 'Netherlands', bbox: [3.4, 50.75, 7.2, 53.6], country: 'Netherlands', aliases: ['netherlands', 'holland'] },
  { label: 'Germany', bbox: [5.9, 47.3, 15, 55.1], country: 'Germany', aliases: ['germany', 'deutschland'] },
  { label: 'Austria', bbox: [9.5, 46.4, 17.2, 49], country: 'Austria', aliases: ['austria'] },
  { label: 'Switzerland', bbox: [5.96, 45.8, 10.5, 47.8], country: 'Switzerland', aliases: ['switzerland', 'type j'] },
  { label: 'Italy', bbox: [6.6, 36.6, 18.5, 47.1], country: 'Italy', aliases: ['italy', 'type l'] },
  { label: 'Spain', bbox: [-9.3, 36, 3.3, 43.8], country: 'Spain', aliases: ['spain'] },
  { label: 'Portugal', bbox: [-9.5, 36.9, -6.2, 42.2], country: 'Portugal', aliases: ['portugal'] },
  { label: 'Denmark', bbox: [8.1, 54.6, 15.2, 57.8], country: 'Denmark', aliases: ['denmark', 'type k'] },
  { label: 'Norway', bbox: [4.6, 58, 31.1, 71.2], country: 'Norway', aliases: ['norway'] },
  { label: 'Sweden', bbox: [11.1, 55.3, 24.2, 69.1], country: 'Sweden', aliases: ['sweden'] },
  { label: 'Finland', bbox: [20.6, 59.8, 31.6, 70.1], country: 'Finland', aliases: ['finland'] },
  { label: 'Poland', bbox: [14.1, 49, 24.2, 54.9], country: 'Poland', aliases: ['poland'] },
  { label: 'Czechia', bbox: [12.1, 48.5, 18.9, 51.1], country: 'Czechia', aliases: ['czechia', 'czech republic'] },
  { label: 'Slovakia', bbox: [16.8, 47.7, 22.6, 49.6], country: 'Slovakia', aliases: ['slovakia'] },
  { label: 'Hungary', bbox: [16.1, 45.7, 22.9, 48.6], country: 'Hungary', aliases: ['hungary'] },
  { label: 'Romania', bbox: [20.2, 43.6, 29.7, 48.3], country: 'Romania', aliases: ['romania'] },
  { label: 'Greece', bbox: [19.3, 34.8, 28.3, 41.8], country: 'Greece', aliases: ['greece'] },
  { label: 'Turkey', bbox: [26, 35.8, 44.8, 42.1], country: 'Turkey', aliases: ['turkey', 'turkiye'] },
  { label: 'Ukraine', bbox: [22.1, 44.4, 40.2, 52.4], country: 'Ukraine', aliases: ['ukraine'] },
  { label: 'Russia', bbox: [19.6, 41.2, 180, 81.9], country: 'Russia', aliases: ['russia', 'russian federation'] },
  { label: 'Iceland', bbox: [-24.5, 63.4, -13.5, 66.6], country: 'Iceland', aliases: ['iceland'] },
  { label: 'India', bbox: [68.1, 6.7, 97.4, 35.5], country: 'India', aliases: ['india'] },
  { label: 'Pakistan', bbox: [60.9, 23.7, 77.8, 37.1], country: 'Pakistan', aliases: ['pakistan'] },
  { label: 'Bangladesh', bbox: [88, 20.7, 92.7, 26.6], country: 'Bangladesh', aliases: ['bangladesh'] },
  { label: 'China', bbox: [73.5, 18.2, 134.8, 53.6], country: 'China', aliases: ['china', 'prc', 'mainland china'] },
  { label: 'Japan', bbox: [129.4, 31, 145.8, 45.5], country: 'Japan', aliases: ['japan'] },
  { label: 'South Korea', bbox: [126, 33.1, 129.6, 38.6], country: 'South Korea', aliases: ['south korea', 'republic of korea', 'korea'] },
  { label: 'Taiwan', bbox: [120, 21.9, 122, 25.3], country: 'Taiwan', aliases: ['taiwan'] },
  { label: 'Hong Kong', bbox: [113.8, 22.15, 114.4, 22.6], country: 'Hong Kong', aliases: ['hong kong'] },
  { label: 'Singapore', bbox: [103.6, 1.2, 104.1, 1.5], country: 'Singapore', aliases: ['singapore'] },
  { label: 'Thailand', bbox: [97.3, 5.6, 105.6, 20.5], country: 'Thailand', aliases: ['thailand'] },
  { label: 'Vietnam', bbox: [102.1, 8.6, 109.5, 23.4], country: 'Vietnam', aliases: ['vietnam', 'viet nam'] },
  { label: 'Philippines', bbox: [116.9, 4.6, 126.6, 21.1], country: 'Philippines', aliases: ['philippines'] },
  { label: 'Indonesia', bbox: [95, -11, 141, 6], country: 'Indonesia', aliases: ['indonesia'] },
  { label: 'Malaysia', bbox: [99.6, 0.85, 119.3, 7.4], country: 'Malaysia', aliases: ['malaysia'] },
  { label: 'Australia', bbox: [112.9, -43.7, 153.6, -10], country: 'Australia', aliases: ['australia'] },
  { label: 'New Zealand', bbox: [166.4, -47.3, 178.6, -34.4], country: 'New Zealand', aliases: ['new zealand'] },
  { label: 'Brazil', bbox: [-74, -33.8, -34.8, 5.3], country: 'Brazil', aliases: ['brazil', 'brasil', 'type n'] },
  { label: 'Argentina', bbox: [-73.6, -55.1, -53.6, -21.8], country: 'Argentina', aliases: ['argentina'] },
  { label: 'Chile', bbox: [-75.7, -55.9, -66.4, -17.5], country: 'Chile', aliases: ['chile'] },
  { label: 'Colombia', bbox: [-79, -4.2, -66.9, 12.5], country: 'Colombia', aliases: ['colombia'] },
  { label: 'Peru', bbox: [-81.3, -18.4, -68.7, 0], country: 'Peru', aliases: ['peru'] },
  { label: 'South Africa', bbox: [16.4, -34.8, 32.9, -22.1], country: 'South Africa', aliases: ['south africa', 'type m'] },
  { label: 'Nigeria', bbox: [2.7, 4.3, 14.7, 13.9], country: 'Nigeria', aliases: ['nigeria'] },
  { label: 'Kenya', bbox: [33.9, -4.7, 41.9, 5.5], country: 'Kenya', aliases: ['kenya'] },
  { label: 'Egypt', bbox: [24.7, 22, 36.9, 31.7], country: 'Egypt', aliases: ['egypt'] },
  { label: 'Morocco', bbox: [-13.2, 27.7, -1, 35.9], country: 'Morocco', aliases: ['morocco'] },
  { label: 'Israel', bbox: [34.3, 29.5, 35.9, 33.3], country: 'Israel', aliases: ['israel', 'type h'] },
  {
    label: 'United Arab Emirates',
    bbox: [51.6, 22.6, 56.4, 26.1],
    country: 'United Arab Emirates',
    aliases: ['united arab emirates', 'uae', 'dubai', 'abu dhabi'],
  },
  { label: 'Saudi Arabia', bbox: [34.5, 16.4, 55.7, 32.2], country: 'Saudi Arabia', aliases: ['saudi arabia'] },
];

/**
 * Name -> coarse box. Never returns street or city geometry, and says when it
 * answered more coarsely than it was asked.
 */
export const builtinRegionResolver: RegionResolver = {
  name: BUILTIN_GAZETTEER_ID,
  async resolve(query: RegionQuery): Promise<ResolvedRegion | null> {
    for (const candidate of [query.label, query.country, query.admin1]) {
      if (!candidate) continue;
      const entry = matchGazetteer(candidate);
      if (!entry) continue;
      const center = bboxCenter(entry.bbox);
      const asked = candidate.trim();
      const coarser = normalise(asked) === normalise(entry.label) ? undefined : asked;
      return {
        label: entry.label,
        bbox: entry.bbox,
        center,
        radiusM: bboxRadiusM(entry.bbox),
        country: entry.country,
        basis: entry.note
          ? `coarse reference box from the built-in gazetteer ${BUILTIN_GAZETTEER_ID} (${entry.note})`
          : `coarse reference box from the built-in gazetteer ${BUILTIN_GAZETTEER_ID}`,
        ...(coarser === undefined ? {} : { coarserThanAsked: coarser }),
      };
    }
    return null;
  },
};

/** Longest contiguous token match wins, so "united states" beats "us". */
function matchGazetteer(raw: string): GazetteerEntry | null {
  const tokens = normalise(raw).split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  let best: { entry: GazetteerEntry; length: number } | null = null;
  for (const entry of GAZETTEER) {
    const keys = [entry.label, ...(entry.aliases ?? [])];
    for (const key of keys) {
      const keyTokens = normalise(key).split(' ').filter(Boolean);
      if (keyTokens.length === 0) continue;
      if (!containsSequence(tokens, keyTokens)) continue;
      if (!best || keyTokens.length > best.length) best = { entry, length: keyTokens.length };
    }
  }
  return best?.entry ?? null;
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface InteriorInput {
  image: ImageRef;
  /** Supplied by the caller's quality stage. Measured locally when absent. */
  quality?: QualityGate;
  hints?: LiveAnalyzeRequest['hints'];
  /** Injected in tests. Defaults to L1's `selectProvider()`. */
  provider?: InteriorVlmProvider | null;
  /** Injected in tests. Defaults to whichever reverse-image keys are set. */
  provenanceProviders?: readonly ProvenanceProvider[];
  /** Injected in tests. Defaults to the built-in coarse gazetteer. */
  resolver?: RegionResolver;
  budgetMs?: number;
  signal?: AbortSignal;
  env?: EnvLike;
}

/**
 * The INTERIOR result: the same shape LOCATE returns, plus `provenanceHits`.
 * Composes directly into `LiveAnalyzeResponse` — `models`/`sources`/`costUsd`
 * become its `provenance` block.
 */
export interface InteriorAnalysis {
  geo: GeoCandidate[];
  provenanceHits: ProvenanceHit[];
  evidence: Evidence[];
  stages: StageTrace[];
  unavailable: CapabilityGap[];
  models: Record<string, string>;
  sources: Record<string, string>;
  costUsd: number;
  /**
   * The gate this run actually applied — the caller's when it supplied one, and
   * INTERIOR's own otherwise. Returned (as LOCATE returns it) so a refusal
   * decided in here reaches the response instead of being silently outvoted by
   * the orchestrator's earlier verdict. That is what makes an undecodable image
   * a visible refusal rather than an empty ranking.
   */
  quality: QualityGate;
  /**
   * True only when a published copy was found or address text is legible in the
   * frame. False means: the regions below are the whole answer, and no method in
   * this module gets from here to a building.
   */
  resolvableToBuilding: boolean;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Never throws. Every stage degrades into a `StageTrace.skipped.reason` plus, if
 * a key is missing, a `CapabilityGap` — and the sections that could not be
 * computed are absent rather than filled in.
 */
export async function analyzeInterior(input: InteriorInput): Promise<InteriorAnalysis> {
  const env = input.env ?? process.env;
  const budget = new Budget(input.budgetMs ?? INTERIOR_BUDGET_MS);
  const resolver = input.resolver ?? builtinRegionResolver;

  const evidence: Evidence[] = [];
  const stages: StageTrace[] = [];
  const unavailable: CapabilityGap[] = [];
  const models: Record<string, string> = {};
  const sources: Record<string, string> = { gazetteer: resolver.name };

  // --- 1. EXIF / XMP + decode + quality ------------------------------------
  //
  // The caller (the LIVE orchestrator) runs preprocess and the quality gate
  // before dispatching and passes the verdict in. When it has, this module does
  // not emit its own `preprocess` row: two rows with the same `stage` are two
  // rows keyed identically in the readout, which is where the browser's
  // "Encountered two children with the same key, 'preprocess'" came from. LOCATE
  // already worked this way; INTERIOR did not.
  const callerAlreadyMeasured = input.quality !== undefined;
  const metaStarted = Date.now();
  const bytes = input.image.bytes;
  let metadata: MetadataFacts | null = null;
  let quality: QualityGate;
  let prepared: AnalysableImage = { image: input.image };

  if (bytes && bytes.byteLength > 0) {
    metadata = await extractMetadata(bytes);
    sources.exif = EXIF_LIBRARY;
    const header = readImageHeader(bytes);
    // EXIF is read from the file the operator uploaded; pixels come from whatever
    // can actually decode it. Both are facts about the same upload, and keeping
    // them separate is why a HEIC still yields camera make, model and capture
    // time even when the decode is the thing that failed.
    prepared = await ensureAnalysable(input.image, header);
    if (prepared.decoded) {
      sources.decoder = `${prepared.decoded.decoder}; decoded ${formatLabel(header.format)} to ${prepared.decoded.width}x${prepared.decoded.height} in ${prepared.decoded.ranMs} ms`;
    }
    quality =
      input.quality ??
      evaluateQualityGate({ image: input.image, header, metadata, bytes });
    if (prepared.failure) {
      // An undecodable image is exactly the "we cannot analyse this" case the
      // gate exists for, so it fails the gate outright rather than being noted
      // beside a passing one. That also buys the contract invariant for free:
      // `assertRefusalIsHonoured` forbids a ranking on a failed gate, so there
      // is no path from here to a candidate list.
      quality = {
        ...quality,
        passed: false,
        components: {
          ...quality.components,
          resolutionPx: {
            w: header.width ?? quality.components.resolutionPx.w,
            h: header.height ?? quality.components.resolutionPx.h,
          },
        },
        degraded: true,
        refusalReason: undecodableRefusal(prepared.failure),
      };
      unavailable.push(undecodableGap(prepared.failure));
    }
    evidence.push(...interiorMetadataEvidence(metadata));
    if (!callerAlreadyMeasured) {
      stages.push({ stage: 'preprocess', ranMs: Date.now() - metaStarted, costUsd: 0 });
    }
  } else {
    quality =
      input.quality ?? {
        passed: false,
        components: { resolutionPx: { w: 0, h: 0 } },
        refusalReason:
          'The image bytes were not available to this module, so nothing could be measured and no ranking is returned.',
        degraded: true,
      };
    if (!callerAlreadyMeasured) {
      stages.push({
        stage: 'preprocess',
        ranMs: Date.now() - metaStarted,
        costUsd: 0,
        skipped: {
          reason:
            'No image bytes were supplied, so EXIF/XMP could not be read. Metadata is the only local signal available for an indoor frame and it was skipped.',
        },
      });
    }
  }

  // --- 2 + 4. Vision and reverse image search, concurrently ----------------
  // They are independent: neither needs the other's output, and both are
  // network-bound, so running them together roughly halves wall-clock time.
  const provider = input.provider === undefined ? await resolveVisionProvider() : input.provider;

  const [clueOutcome, provenanceOutcome] = await Promise.all([
    runClueExtraction(provider, prepared, input, budget),
    runProvenance(input, budget, env),
  ]);

  stages.push(clueOutcome.trace);
  if (clueOutcome.gap) unavailable.push(clueOutcome.gap);
  if (clueOutcome.modelVersion) models.vlm = clueOutcome.modelVersion;

  stages.push(provenanceOutcome.trace);
  unavailable.push(...provenanceOutcome.gaps);
  if (provenanceOutcome.consulted.length > 0) {
    sources['reverse-image'] = provenanceOutcome.consulted.join(' + ');
  }

  const clues = clueOutcome.clues;
  const hits = provenanceOutcome.hits;

  // --- 3. Candidates -------------------------------------------------------
  const legibleAddress = clues ? findLegibleAddress(clues) : undefined;
  const hasLocator = hits.length > 0 || legibleAddress !== undefined;

  const clueRecords = clues ? clueRecordsFor(clues, input.image.imageId) : [];
  evidence.push(...clueRecords.map((r) => r.evidence));

  let geo: GeoCandidate[] = [];
  if (!quality.passed) {
    // A failed gate returns no ranking at all — not a weaker one.
    evidence.push({
      kind: 'vlm-clue',
      claim: `No regions are ranked: the input failed the quality gate. ${quality.refusalReason ?? ''}`.trim(),
      verifiable:
        'Re-upload the original file rather than a screenshot or a messaging-app copy. Resolution and recompression are measurable from the file itself, so this refusal is reproducible.',
      weight: 0,
    });
  } else if (clues) {
    const built = await buildCandidates({
      clues,
      records: clueRecords,
      resolver,
      hints: input.hints,
      hasLocator,
      quality,
    });
    geo = built.candidates;
    evidence.push(...built.notes);
  }

  // Belt and braces. `precisionForRadius` cannot return 'street', so this can
  // only fire if a future edit hand-sets precision — which it must not.
  for (const candidate of geo) assertStreetPrecisionIsEarned(candidate);

  // --- 4b. Provenance evidence --------------------------------------------
  evidence.push(...provenanceEvidence(hits, provenanceOutcome, legibleAddress));

  // --- 5. The honest summary ----------------------------------------------
  evidence.push(
    resolvabilitySummary({
      hits,
      clues,
      legibleAddress,
      provenance: provenanceOutcome,
      visionRan: clues !== null,
      candidateCount: geo.length,
    }),
  );

  const costUsd = stages.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);

  return {
    geo,
    provenanceHits: hits,
    evidence,
    stages,
    unavailable,
    models,
    sources,
    costUsd,
    quality,
    resolvableToBuilding: hasLocator,
  };
}

// ---------------------------------------------------------------------------
// Stage: vision
// ---------------------------------------------------------------------------

interface ClueOutcome {
  clues: VlmClues | null;
  modelVersion?: string;
  trace: StageTrace;
  gap?: CapabilityGap;
}

async function runClueExtraction(
  provider: InteriorVlmProvider | null,
  prepared: AnalysableImage,
  input: InteriorInput,
  budget: Budget,
): Promise<ClueOutcome> {
  const started = Date.now();

  if (prepared.failure) {
    // The gap and the refusal are already stated by the caller. What belongs
    // here is the reason this specific stage did not run and did not spend.
    return {
      clues: null,
      trace: {
        stage: 'vlm-clues',
        ranMs: Date.now() - started,
        costUsd: 0,
        skipped: {
          reason: `The ${formatLabel(prepared.failure.format)} file could not be decoded to pixels, so there was nothing to send to the vision model and nothing was spent. ${prepared.failure.reason}`,
        },
      },
    };
  }

  if (!provider) {
    return {
      clues: null,
      trace: {
        stage: 'vlm-clues',
        ranMs: Date.now() - started,
        skipped: {
          reason:
            'No vision model is configured, so no fixture, socket, or text observations were extracted. INTERIOR has almost nothing to work with without it.',
        },
      },
      gap: {
        capability: 'Interior fixture analysis',
        impact:
          'Outlet type, switch style, window mechanism and any readable text are the country-level signal in an indoor frame. Without a vision model only EXIF and reverse image search run.',
        envVar: 'ANTHROPIC_API_KEY (or OPENAI_API_KEY, or GEMINI_API_KEY)',
        howTo: 'Add it to .env.local in the project root, then restart the dev server.',
      },
    };
  }

  if (!prepared.image.bytes && !prepared.image.url) {
    return {
      clues: null,
      trace: {
        stage: 'vlm-clues',
        ranMs: Date.now() - started,
        skipped: { reason: 'Neither image bytes nor a URL were available to send to the vision model.' },
      },
    };
  }

  let res: Result<VlmResult, StageFailure>;
  try {
    res = await provider.extractClues({
      image: prepared.image,
      timeoutMs: budget.timeoutFor(INTERIOR_TIMEOUTS_MS.vlm),
      signal: input.signal,
      prompt: INTERIOR_CLUE_EXTRACTION_PROMPT,
    });
  } catch (e) {
    res = {
      ok: false,
      error: {
        kind: 'unavailable',
        reason: `The vision provider threw: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  const ranMs = Date.now() - started;

  if (!res.ok) {
    return { clues: null, trace: { stage: 'vlm-clues', ranMs, skipped: { reason: res.error.reason } } };
  }

  const cost = vlmCostUsdFor(provider.name, res.value.attempts);
  const trace: StageTrace = {
    stage: 'vlm-clues',
    ranMs,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(res.value.clues.insufficientSignal
      ? {
          skipped: {
            reason:
              'The vision model reported insufficient signal to constrain a country. Its individual observations are still in the ledger; no regions were ranked from them.',
          },
        }
      : {}),
  };

  return { clues: res.value.clues, modelVersion: res.value.modelVersion || MODEL_VERSIONS.vlm, trace };
}

/**
 * `COSTS.vlmUsdPerCall` is the price of the sanctioned Gemini-Flash-class slot.
 * For any other vendor we do not know the price, so `costUsd` is left **unset**
 * rather than filled with a number that happens to be wrong — an unset field is
 * honest, a fabricated one poisons the ledger.
 */
function vlmCostUsdFor(providerName: string, attempts: number): number | undefined {
  if (/gemini/i.test(providerName)) return COSTS.vlmUsdPerCall * Math.max(1, attempts);
  return undefined;
}

/**
 * L1 owns provider selection. Wrapped so a missing or half-built vision module
 * degrades INTERIOR to EXIF + provenance instead of throwing at request time.
 */
async function resolveVisionProvider(): Promise<InteriorVlmProvider | null> {
  try {
    return (await selectProvider()) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage: provenance
// ---------------------------------------------------------------------------

interface ProvenanceOutcome {
  hits: ProvenanceHit[];
  trace: StageTrace;
  gaps: CapabilityGap[];
  /** Services that actually answered, for `ResultProvenance.sources`. */
  consulted: string[];
  /** How many services were wired at all. 0 means "not configured", not "no hits". */
  configuredCount: number;
  /** Why nothing was consulted, when nothing was. */
  skipReason?: string;
}

async function runProvenance(
  input: InteriorInput,
  budget: Budget,
  env: EnvLike,
): Promise<ProvenanceOutcome> {
  const started = Date.now();

  const configuredCount = (input.provenanceProviders ?? configuredProviders(env)).length;
  const publicUrl = input.image.url && isPubliclyFetchableUrl(input.image.url) ? input.image.url : undefined;
  const res = await findPublishedCopies(
    {
      ...(input.image.bytes === undefined ? {} : { bytes: input.image.bytes }),
      ...(input.image.mimeType === undefined ? {} : { mimeType: input.image.mimeType }),
      ...(publicUrl === undefined ? {} : { publicUrl }),
      filename: `${input.image.imageId}.jpg`,
    },
    {
      env,
      timeoutMs: budget.timeoutFor(PROVENANCE_TIMEOUTS_MS.tineye),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.provenanceProviders === undefined ? {} : { providers: input.provenanceProviders }),
    },
  );

  if (!res.ok) {
    return {
      hits: [],
      trace: { stage: 'provenance', ranMs: Date.now() - started, skipped: { reason: res.error.reason } },
      gaps: provenanceGaps(env),
      consulted: [],
      configuredCount,
      skipReason: res.error.reason,
    };
  }

  const findings = res.value;
  const consulted = findings.attempts.filter((a) => a.ok).map((a) => a.provider);
  const refused = findings.attempts.filter((a) => !a.ok);
  const skipReason =
    consulted.length > 0
      ? undefined
      : refused.length > 0
        ? refused.map((a) => `${a.provider}: ${a.failure?.reason ?? 'no reason given'}`).join(' | ')
        : 'No reverse-image service is configured, so the only route from an interior photo to an address was not attempted.';

  const trace: StageTrace = {
    stage: 'provenance',
    ranMs: findings.ranMs,
    costUsd: findings.costUsd,
    ...(skipReason === undefined ? {} : { skipped: { reason: skipReason } }),
  };

  return {
    hits: findings.hits,
    trace,
    gaps: findings.unavailable,
    consulted,
    configuredCount,
    ...(skipReason === undefined ? {} : { skipReason }),
  };
}

// ---------------------------------------------------------------------------
// Clues -> evidence
// ---------------------------------------------------------------------------

export interface ClueRecord {
  observed: string;
  implies: readonly string[];
  evidence: Evidence;
}

/**
 * One evidence line per observation, labelled for an indoor reader.
 *
 * The bucket names in `VlmCluesSchema` are outdoor-shaped (see the prompt), so
 * they are translated here: an interior investigator reading "Fixture or
 * construction detail" understands the line; "Architecture (building-material)"
 * misleads them about what was observed.
 */
export function clueRecordsFor(clues: VlmClues, imageId: string): ClueRecord[] {
  const records: ClueRecord[] = [];

  const push = (
    observed: string,
    label: string,
    legibility: keyof typeof LEGIBILITY_WEIGHT,
    bbox: readonly number[] | undefined,
    implies: readonly string[] | undefined,
  ): void => {
    records.push({
      observed,
      implies: implies ?? [],
      evidence: {
        kind: 'vlm-clue',
        claim: implies?.length
          ? `${label}: "${observed}" (${legibility}). Consistent with ${implies.slice(0, 5).join(', ')}.`
          : `${label}: "${observed}" (${legibility}).`,
        verifiable: bbox
          ? 'Open the linked crop and decide for yourself whether the frame shows what this line says it shows. Socket and switch geometry is the one indoor cue you can check in seconds against any plug-type reference.'
          : 'Look at the frame and decide for yourself whether it shows what this line says it shows. The model localised nothing for this observation, which is itself a reason to weight it lightly.',
        ...(bbox ? { cropUrl: cropUrl(imageId, bbox) } : {}),
        ...(bbox ? { reference: { label: `crop [${bbox.map((n) => n.toFixed(2)).join(', ')}]` } } : {}),
        weight: LEGIBILITY_WEIGHT[legibility],
      },
    });
  };

  for (const t of clues.text) {
    push(t.observed, `Text in frame (${t.kind}${t.script ? `, ${t.script}` : ''})`, t.legibility, t.bbox, undefined);
  }
  for (const a of clues.architecture) {
    const label =
      a.kind === 'window-style'
        ? 'Window or glazing'
        : a.kind === 'signage-style'
          ? 'Label or badge styling'
          : 'Fixture or construction detail';
    push(a.observed, label, a.legibility, a.bbox, a.impliesRegions);
  }
  for (const e of clues.environment) {
    push(e.observed, 'Visible outside the window (environment)', e.legibility, e.bbox, e.impliesRegions);
  }
  for (const i of clues.infrastructure) {
    push(i.observed, `Visible outside the window (${i.kind})`, i.legibility, i.bbox, i.impliesRegions);
  }

  return records;
}

/** An address in the frame is one of only two things that can reach a building. */
function findLegibleAddress(clues: VlmClues): string | undefined {
  for (const t of clues.text) {
    if (t.legibility === 'guessed') continue;
    const matched = extractAddressLike(t.observed);
    if (matched) return matched;
    if (t.kind === 'address-number' && t.observed.trim().length > 0) return t.observed.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

async function buildCandidates(args: {
  clues: VlmClues;
  records: readonly ClueRecord[];
  resolver: RegionResolver;
  hints: LiveAnalyzeRequest['hints'];
  hasLocator: boolean;
  quality: QualityGate;
}): Promise<{ candidates: GeoCandidate[]; notes: Evidence[] }> {
  const { clues, records, resolver, hasLocator, quality } = args;
  const notes: Evidence[] = [];

  if (clues.insufficientSignal) {
    notes.push({
      kind: 'vlm-clue',
      claim:
        'No regions are ranked: the vision model reported that the frame does not contain enough signal to constrain a country. The observations it did make are listed above.',
      verifiable:
        'Look for a socket, a switch plate, a window, a radiator or a vent, or any readable text or packaging. If none of those is in frame, no method places this room, and a ranked list here would be invented.',
      weight: 0,
    });
    return { candidates: [], notes };
  }

  const clueCount = clues.text.length + clues.architecture.length + clues.environment.length + clues.infrastructure.length;
  const categories = [clues.text, clues.architecture, clues.environment, clues.infrastructure].filter((g) =>
    g.some((c) => c.legibility !== 'guessed'),
  ).length;

  const priors = [...clues.regionPrior].sort((a, b) => b.rawConfidence - a.rawConfidence);
  const working: WorkingCandidate[] = [];
  const unresolved: string[] = [];
  const uncited: string[] = [];

  for (const [index, prior] of priors.entries()) {
    const citations = citationsFor(prior, records);
    if (citations.length === 0) {
      // The model named a region it did not support from its own observation
      // list. That is the documented hallucination mode, so it is dropped, not
      // softened.
      uncited.push(prior.label);
      continue;
    }

    const resolved = await resolver.resolve({
      label: prior.label,
      ...(prior.admin1 === undefined ? {} : { admin1: prior.admin1 }),
      ...(prior.country === undefined ? {} : { country: prior.country }),
    });
    if (!resolved) {
      unresolved.push(prior.label);
      continue;
    }

    let bbox = resolved.bbox;
    let conflictNote: string | undefined;
    let narrowNote: string | undefined;
    if (args.hints?.bbox) {
      const hintBbox = args.hints.bbox as Bbox;
      const overlap = bboxIntersection(bbox, hintBbox);
      if (overlap) {
        bbox = overlap;
        narrowNote = "narrowed to the operator-supplied search area";
      } else {
        conflictNote =
          "this region does not overlap the operator-supplied search area, so either the search area or these observations is wrong";
      }
    }

    const floorM = hasLocator ? PRECISION_FLOOR_M.withLocator : PRECISION_FLOOR_M.withoutLocator;
    const radiusM = Math.max(bboxRadiusM(bbox), floorM);
    const center = bboxCenter(bbox);

    const gazetteerEvidence: Evidence = {
      kind: 'vlm-clue',
      claim: [
        `${citations.length} observation${citations.length === 1 ? '' : 's'} above are cited as supporting ${resolved.label}`,
        resolved.coarserThanAsked ? ` (the model named "${resolved.coarserThanAsked}"; the gazetteer resolves no finer than ${resolved.label})` : '',
        `. Geometry is a ${resolved.basis}, so the circle covers the whole region and is not a location estimate`,
        narrowNote ? `, ${narrowNote}` : '',
        conflictNote ? `, but ${conflictNote}` : '',
        '.',
      ].join(''),
      verifiable: `Check the cited observations one by one in the frame. Then look up ${resolved.label} in any atlas: the circle shown is the extent of the region, not a claim about where in it the room is.`,
      reference: { label: `${resolved.label} — ${resolver.name}` },
      // Circular with the clue lines it summarises; carries no independent weight.
      weight: 0,
    };

    working.push({
      id: `interior-region-${index + 1}`,
      center,
      radiusM,
      // Derived, never hand-set: this function's return type cannot be 'street'.
      precision: precisionForRadius(radiusM),
      place: {
        label: resolved.label,
        ...(prior.admin1 === undefined ? {} : { admin1: prior.admin1 }),
        ...((resolved.country ?? prior.country) === undefined
          ? {}
          : { country: resolved.country ?? prior.country }),
      },
      rawScore: prior.rawConfidence,
      evidence: [gazetteerEvidence, ...citations],
      calibrationSet: 'vlmClues',
      facts: { kind: 'vlm-clues', clueCount, categories, label: resolved.label },
    });
  }

  if (uncited.length > 0) {
    notes.push({
      kind: 'vlm-clue',
      claim: `Discarded ${uncited.length} proposed region${uncited.length === 1 ? '' : 's'} (${uncited.join(', ')}): the model cited no observation from its own list to support ${uncited.length === 1 ? 'it' : 'them'}.`,
      verifiable:
        'Compare the observation lines above with the regions ranked below. A region with no observation behind it is the documented failure mode for this task — the model recognises a place and then invents the reason — and it is dropped here rather than shown weakly.',
      weight: 0,
    });
  }
  if (unresolved.length > 0) {
    notes.push({
      kind: 'vlm-clue',
      claim: `Could not place ${unresolved.length} proposed region${unresolved.length === 1 ? '' : 's'} (${unresolved.join(', ')}) on a map: no entry in ${resolver.name}.`,
      verifiable:
        'The coarse gazetteer holds country and bloc extents only. A region it cannot resolve is reported here rather than approximated, because an approximated centre would be a coordinate we made up.',
      weight: 0,
    });
  }

  return { candidates: finaliseCandidates(working, quality), notes };
}

/**
 * The observations a region prior actually rests on.
 *
 * Primary test is textual: `supportedBy` is required to quote observations, so
 * each entry is matched against the observation list in both directions
 * (paraphrase shortens, quoting lengthens). Fallback is the clue's own
 * `impliesRegions`. If neither hits, the prior has no citation and is discarded
 * by the caller.
 */
function citationsFor(
  prior: VlmClues['regionPrior'][number],
  records: readonly ClueRecord[],
): Evidence[] {
  const wanted = prior.supportedBy.map(normalise).filter((s) => s.length >= 4);
  const out: Evidence[] = [];
  const seen = new Set<Evidence>();

  for (const record of records) {
    const observed = normalise(record.observed);
    if (observed.length === 0) continue;
    const quoted = wanted.some((w) => w.includes(observed) || observed.includes(w));
    if (!quoted) continue;
    if (seen.has(record.evidence)) continue;
    seen.add(record.evidence);
    out.push(record.evidence);
  }

  if (out.length === 0) {
    const labels = [prior.label, prior.country, prior.admin1].filter(Boolean).map((s) => normalise(String(s)));
    for (const record of records) {
      const implied = record.implies.map(normalise);
      const hit = implied.some((i) => labels.some((l) => l.length >= 3 && (i.includes(l) || l.includes(i))));
      if (!hit || seen.has(record.evidence)) continue;
      seen.add(record.evidence);
      out.push(record.evidence);
    }
  }

  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Evidence: metadata, provenance, summary
// ---------------------------------------------------------------------------

function interiorMetadataEvidence(m: MetadataFacts): Evidence[] {
  const out: Evidence[] = [];

  if (m.gps) {
    out.push({
      kind: 'exif',
      claim: `The file's metadata claims ${m.gps.lat.toFixed(5)}, ${m.gps.lon.toFixed(5)}. Recorded as a claim by the file, not verified by us. An indoor frame that still carries GPS is unusual and, if genuine, is the strongest lead in this response — check it first.`,
      verifiable:
        'Run `exiftool` on the original file to confirm the tag is really there, then open the coordinate in a mapping tool and ask whether that building could contain this room. EXIF GPS is trivially editable, survives copying, and is often the phone\'s last outdoor fix rather than the room itself.',
      reference: {
        label: 'EXIF GPS claim',
        url: `https://www.openstreetmap.org/?mlat=${m.gps.lat}&mlon=${m.gps.lon}#map=18/${m.gps.lat}/${m.gps.lon}`,
      },
      // Zero weight is deliberate: metadata never moves a ranking here.
      weight: 0,
    });
  }

  if (m.capturedAt || m.cameraMake || m.software) {
    const parts = [
      m.cameraMake && m.cameraModel ? `${m.cameraMake} ${m.cameraModel}` : m.cameraMake,
      m.software ? `software "${m.software}"` : undefined,
      m.capturedAt ? `capture time ${m.capturedAt}` : undefined,
    ].filter(Boolean);
    out.push({
      kind: 'exif',
      claim: `Metadata present: ${parts.join(', ')}.`,
      verifiable:
        'Run `exiftool` on the original file and compare. Recorded for the chain of custody; it is never used to place the image.',
      weight: 0,
    });
  }

  if (m.stripped) {
    out.push({
      kind: 'exif',
      claim:
        'No metadata at all in the container. Normal for anything that has been through a messaging app or a platform upload, and not a finding about the image.',
      verifiable:
        'Run `exiftool` on the original file. If the operator has the camera original, re-uploading it may restore GPS and capture time — which is the single cheapest way to improve this result.',
      weight: 0,
    });
  }

  return out;
}

function provenanceEvidence(
  hits: readonly ProvenanceHit[],
  outcome: ProvenanceOutcome,
  legibleAddress: string | undefined,
): Evidence[] {
  const out: Evidence[] = [];

  for (const hit of hits.slice(0, 10)) {
    const bits = [`${hit.source} reports a matching copy of this image at ${hit.url}`];
    if (hit.title) bits.push(`Page title, as returned by the service: "${hit.title}"`);
    if (hit.place) {
      bits.push(
        `That title contains what looks like an address — "${hit.place}" — which is the source page's own claim about itself, not our determination`,
      );
    }
    if (hit.score !== undefined) bits.push(`Service-reported match score ${hit.score}, on ${hit.source}'s own scale`);
    out.push({
      // The contract's evidence kinds have no reverse-image member; 'corpus-match'
      // is the near-duplicate kind and is the honest fit. It deliberately does NOT
      // earn street precision — only a vpr-match or a signage-ocr can.
      kind: 'corpus-match',
      claim: `${bits.join('. ')}.`,
      verifiable:
        'Open the URL and look at it. If the page shows this room, whatever address or listing reference it carries is a lead you can check against public records. If it does not show this room, the match is wrong and this line should be discarded.',
      reference: { label: hostOf(hit.url) ?? hit.source, url: hit.url },
      weight: PROVENANCE_EVIDENCE_WEIGHT,
    });
  }

  if (hits.length === 0 && outcome.consulted.length > 0) {
    out.push({
      kind: 'corpus-match',
      claim: `${outcome.consulted.join(' and ')} ${outcome.consulted.length === 1 ? 'was' : 'were'} queried and returned no copy of this image. That is a real negative result: it means the frame is not on any page ${outcome.consulted.length === 1 ? 'that service has' : 'those services have'} crawled.`,
      verifiable:
        'Re-run the same image at tineye.com or images.google.com and compare. A negative is weaker than it looks — neither index covers everything, and both index far less short-let and rental content than they do news and stock imagery.',
      weight: 0,
    });
  }

  if (hits.length > 0 && legibleAddress === undefined) {
    out.push({
      kind: 'corpus-match',
      claim:
        'Any address on the pages above belongs to the page, not to this analysis. We did not fetch or parse those pages; only the URL and any title the service itself returned are recorded here.',
      verifiable:
        'Open each page and read it yourself, then corroborate the address against a source independent of the page — assessor records, a utility, or a site visit.',
      weight: 0,
    });
  }

  return out;
}

function resolvabilitySummary(args: {
  hits: readonly ProvenanceHit[];
  clues: VlmClues | null;
  legibleAddress: string | undefined;
  provenance: ProvenanceOutcome;
  visionRan: boolean;
  candidateCount: number;
}): Evidence {
  const { hits, clues, legibleAddress, provenance, visionRan, candidateCount } = args;
  const windowView =
    clues !== null &&
    [...clues.environment, ...clues.infrastructure].some((c) => c.legibility !== 'guessed');

  if (hits.length > 0 || legibleAddress !== undefined) {
    const carriers = [
      hits.length > 0 ? `${hits.length} published cop${hits.length === 1 ? 'y' : 'ies'} of this image` : undefined,
      legibleAddress !== undefined ? `address-looking text in the frame ("${legibleAddress}")` : undefined,
    ].filter(Boolean);
    return {
      kind: 'corpus-match',
      claim: `A building-level lead exists here, and it comes from ${carriers.join(' and ')} — not from the fixtures. The regions ranked below remain region-level inferences and do not narrow to an address.`,
      verifiable:
        'Follow the lead to its source and corroborate it independently: open the page, or read the text in the frame yourself, then check the address against assessor or utility records. Nothing in this response is a verified address.',
      weight: 0,
    };
  }

  const missing: string[] = [];
  if (provenance.consulted.length > 0) {
    missing.push(`${provenance.consulted.join(' and ')} found no published copy of this image`);
  } else if (provenance.configuredCount === 0) {
    missing.push(
      'no reverse-image service was consulted (set TINEYE_API_KEY or GOOGLE_CLOUD_VISION_API_KEY — this is the only route from an interior to an address)',
    );
  } else {
    missing.push(`reverse image search could not run (${provenance.skipReason ?? 'no reason recorded'})`);
  }
  if (!visionRan) {
    missing.push('no vision model ran, so no fixture or text observations exist');
  } else {
    missing.push('no address text is legible in the frame');
    missing.push(
      windowView
        ? 'an exterior view IS visible through a window, which reduces this to ordinary outdoor geolocation — run the same frame through LOCATE, which is built for that'
        : 'no exterior view is visible through a window',
    );
  }

  return {
    kind: 'vlm-clue',
    claim: `This image is NOT resolvable to a specific building: ${missing.join('; ')}. ${
      candidateCount > 0
        ? `The ${candidateCount} region${candidateCount === 1 ? '' : 's'} ranked here ${candidateCount === 1 ? 'is' : 'are'} country- or region-level inference from fixtures and construction convention, nothing narrower.`
        : 'No regions are ranked either.'
    }`,
    verifiable:
      'Three things would change this, in order of strength: a published copy of the image (reverse image search), legible address text or mail in the frame, or a view through a window that can be geolocated outdoors. Check whether any is available before treating the regions below as a lead.',
    weight: 0,
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
