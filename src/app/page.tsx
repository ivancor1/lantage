import { Car, Clock, FileSearch, Globe, Layers, Milestone, ScanFace, Settings2, ShieldCheck } from 'lucide-react';
import {
  assertRefusalIsHonoured,
  assertStreetPrecisionIsEarned,
  type Confidence,
  type Evidence,
  type GeoCandidate,
  type ModuleId,
  type SearchResult,
} from '@/lib/contracts/types';
import { MapCanvas } from '@/components/map/MapCanvas';
import { Button } from '@/components/ui/Button';
import { ConfidenceRing } from '@/components/ui/ConfidenceRing';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { FieldCell } from '@/components/ui/FieldCell';
import { GlassCard } from '@/components/ui/GlassCard';
import { GlassHeader } from '@/components/ui/GlassHeader';
import { LeadDisclaimer } from '@/components/ui/LeadDisclaimer';
import { ReviewSelect } from '@/components/ui/ReviewSelect';
import { StageTrace } from '@/components/ui/StageTrace';

/* ===========================================================================
 * Fixture — a plausible GEO run over a Pittsburgh frame.
 *
 * Hardcoded on purpose: this page is the visual proof that the design system and
 * the domain contracts agree. The invariants are asserted at the bottom of this
 * block, so an illegal fixture fails the build rather than shipping a screenshot
 * of something the product is not allowed to claim.
 * =========================================================================== */

const CALIBRATION = 'gws15k-holdout@2026-06 · eigenplaces-512@1.2';

const candidates: GeoCandidate[] = [
  {
    id: 'geo_01',
    rank: 1,
    center: { lat: 40.47182, lon: -79.96139 },
    radiusM: 65,
    precision: 'street',
    place: { label: 'Butler St at 40th, Lawrenceville', admin1: 'Pennsylvania', country: 'United States' },
    confidence: {
      band: 'high',
      score: 0.88,
      reason: '4 of 5 retrieval matches fall on this block, and the storefront sign geocodes here independently.',
      calibration: CALIBRATION,
    },
    evidence: [
      {
        kind: 'vpr-match',
        claim:
          'Retrieval matched a 2025-09 Mapillary sequence on the north side of Butler St; roofline, cornice spacing and utility-pole offsets align.',
        verifiable:
          'Open the linked Mapillary pano and compare the four-window bay above the awning against the query frame.',
        reference: { label: 'Mapillary 1043…8871', mapillaryId: '1043887719224871' },
        weight: 0.41,
      },
      {
        kind: 'signage-ocr',
        claim:
          'Read "ESPRESSO A MANO" on the awning; the geocoder returns a single Allegheny County result 40m from the retrieval centroid.',
        verifiable: 'Search the business name in any public directory and confirm the street address yourself.',
        weight: 0.29,
      },
      {
        kind: 'vlm-clue',
        claim:
          'PA-pattern street blade, Belgian-block gutter and trolley-era pole brackets — a pre-war Pittsburgh commercial corridor.',
        verifiable: 'Compare the street-blade colour and typeface against the City of Pittsburgh signage standard.',
        weight: 0.11,
      },
      {
        kind: 'ecoregion',
        claim: 'Canopy species and leaf-off state are consistent with the Western Allegheny Plateau in late autumn.',
        verifiable: 'Check the EPA Level III ecoregion layer for the returned coordinate.',
        weight: 0.07,
      },
    ],
    review: 'confirmed',
  },
  {
    id: 'geo_02',
    rank: 2,
    center: { lat: 40.45072, lon: -79.97968 },
    radiusM: 140,
    precision: 'street',
    place: { label: 'Smallman St, Strip District', admin1: 'Pennsylvania', country: 'United States' },
    confidence: {
      band: 'moderate',
      score: 0.57,
      reason:
        'One strong retrieval match, no corroborating signage — the brick warehouse facades here repeat along the corridor.',
      calibration: CALIBRATION,
    },
    evidence: [
      {
        kind: 'vpr-match',
        claim: 'Single retrieval hit on a warehouse elevation with matching window rhythm and loading-dock height.',
        verifiable: 'Open the linked pano; the dock lintel course should sit at the same height as in the query frame.',
        reference: { label: 'Mapillary 5567…2310', mapillaryId: '556710228832310' },
        weight: 0.38,
      },
      {
        kind: 'vlm-clue',
        claim: 'Corbelled brick parapet and steel sash windows typical of 1900–1930 Pittsburgh produce terminals.',
        verifiable: 'Compare against the Strip District historic-district survey photographs.',
        weight: 0.14,
      },
    ],
    review: 'nearby',
  },
  {
    id: 'geo_03',
    rank: 3,
    center: { lat: 40.46107, lon: -79.94896 },
    radiusM: 850,
    precision: 'city',
    place: { label: 'Bloomfield', admin1: 'Pennsylvania', country: 'United States' },
    confidence: {
      band: 'weak',
      score: 0.31,
      reason: 'Embedding prior only. No retrieval match and no readable text — not actionable on its own.',
      calibration: CALIBRATION,
    },
    evidence: [
      {
        kind: 'embedding-prior',
        claim: 'GeoCLIP places the frame in an 850m neighbourhood cluster centred on Liberty Ave.',
        verifiable: 'Re-run the embedding search and confirm the returned cluster centroid and spread.',
        weight: 0.22,
      },
      {
        kind: 'quantization',
        claim:
          'JPEG quantization tables match an iPhone 14-class encoder — consistent with the claimed device, but says nothing about location.',
        verifiable: 'Compare the extracted tables against a reference frame from the same device model.',
        weight: 0.05,
      },
    ],
    review: 'unreviewed',
  },
  {
    id: 'geo_04',
    rank: 4,
    center: { lat: 40.48211, lon: -79.97663 },
    radiusM: 1600,
    precision: 'city',
    place: { label: 'Millvale', admin1: 'Pennsylvania', country: 'United States' },
    confidence: {
      band: 'weak',
      score: 0.18,
      reason: 'Retained only because it fell inside the analyst-supplied bounding box; nothing in the frame points here.',
      calibration: CALIBRATION,
    },
    evidence: [
      {
        kind: 'embedding-prior',
        claim: 'Fifth-ranked embedding neighbour, 1.6km from the query centroid and outside the top-4 cluster.',
        verifiable: 'Inspect the ranked neighbour list; this entry sits below the cluster cutoff.',
        weight: 0.09,
      },
    ],
    review: 'incorrect',
  },
];

const result: SearchResult = {
  id: 'srch_4b81e2',
  module: 'GEO',
  imageId: 'img_3a9f10',
  quality: {
    passed: true,
    degraded: false,
    unifiedScore: 74,
    components: { resolutionPx: { w: 3024, h: 4032 }, blur: 0.11, exposure: 0.58, occlusion: 0.06 },
  },
  geo: candidates,
  stages: [
    { stage: 'preprocess', ranMs: 41 },
    { stage: 'quality-gate', ranMs: 88 },
    { stage: 'embedding-prior', ranMs: 214, costUsd: 0.0009 },
    { stage: 'vlm-clues', ranMs: 1870, costUsd: 0.0284 },
    { stage: 'vpr-retrieval', ranMs: 612, costUsd: 0.0071 },
    { stage: 'rerank', ranMs: 143, costUsd: 0.0034 },
    { stage: 'verify-ocr', ranMs: 305, costUsd: 0.0014 },
    {
      stage: 'verify-solar',
      ranMs: 0,
      skipped: { reason: 'No capture timestamp supplied. The solar constraint needs a time to bound shadow azimuth.' },
    },
    { stage: 'verify-ecoregion', ranMs: 62 },
    { stage: 'provenance', ranMs: 18 },
    { stage: 'detector', ranMs: 0, skipped: { reason: 'AI-generation detection runs in the VERIFY module, not GEO.' } },
    { stage: 'corpus-match', ranMs: 0, skipped: { reason: 'No corpus selected on this case.' } },
  ],
  provenance: {
    models: {
      embedding: 'geoclip@1.0',
      vlm: 'qwen2.5-vl-72b@2026-05',
      vpr: 'eigenplaces-512@1.2',
      rerank: 'lightglue@1.1',
    },
    indexBuild: 'mapillary-allegheny@2026-07-21',
    benchmarkRef: 'bench/geo/2026-07',
    totalCostUsd: 0.0412,
  },
  createdAt: '2026-07-29T15:04:11.000Z',
};

/**
 * The refusal is a separate run, because the contract does not permit a ranked
 * candidate list behind a failed quality gate. This is what an analyst sees when
 * the input simply is not matchable: a refusal, not a low number.
 */
const REFUSAL_REASON =
  'Frame is 288×216 after upstream re-compression and the horizon is fully occluded. Below the resolution floor at which retrieval performs better than chance.';

const refusedResult: SearchResult = {
  id: 'srch_9f2a0c',
  module: 'GEO',
  imageId: 'img_7c1e44',
  quality: {
    passed: false,
    degraded: true,
    unifiedScore: 19,
    components: { resolutionPx: { w: 288, h: 216 }, blur: 0.81, exposure: 0.34 },
    refusalReason: REFUSAL_REASON,
  },
  stages: [
    { stage: 'preprocess', ranMs: 33 },
    { stage: 'quality-gate', ranMs: 71 },
    { stage: 'embedding-prior', ranMs: 0, skipped: { reason: 'Quality gate refused; no matching was attempted.' } },
    { stage: 'vpr-retrieval', ranMs: 0, skipped: { reason: 'Quality gate refused; no matching was attempted.' } },
  ],
  provenance: { models: { preprocess: 'lantage-prep@0.4' }, totalCostUsd: 0.0006 },
  createdAt: '2026-07-29T14:51:02.000Z',
};

const refusedConfidence: Confidence = {
  band: 'refused',
  score: 0,
  reason: REFUSAL_REASON,
  calibration: 'ofiq-29794-5@1.1',
};

/* Import the invariants; do not reimplement them. If this fixture ever claims
   street precision it has not earned, or ranks anything behind a failed gate,
   the build breaks here rather than in front of an analyst. */
candidates.forEach(assertStreetPrecisionIsEarned);
assertRefusalIsHonoured(result);
assertRefusalIsHonoured(refusedResult);

/* =========================================================================== */

const MODULES: ReadonlyArray<{ id: ModuleId; label: string; Icon: typeof Globe }> = [
  { id: 'GEO', label: 'Geolocate a frame', Icon: Globe },
  { id: 'STREET', label: 'Street-level targeting', Icon: Milestone },
  { id: 'VEHICLE', label: 'Vehicle make and model', Icon: Car },
  { id: 'VERIFY', label: 'Authenticity indicators', Icon: ShieldCheck },
  { id: 'CLAIM', label: 'Claim corpus match', Icon: FileSearch },
  { id: 'MATCH', label: 'Face match', Icon: ScanFace },
];

const EVIDENCE_LABEL: Record<Evidence['kind'], string> = {
  exif: 'EXIF',
  'signage-ocr': 'SIGNAGE OCR',
  'vpr-match': 'VPR MATCH',
  'embedding-prior': 'EMBEDDING PRIOR',
  'vlm-clue': 'VLM CLUE',
  solar: 'SOLAR',
  ecoregion: 'ECOREGION',
  c2pa: 'C2PA',
  quantization: 'QUANTIZATION',
  detector: 'DETECTOR',
  localization: 'LOCALIZATION',
  'corpus-match': 'CORPUS MATCH',
};

function formatCoord(value: number): string {
  return value.toFixed(5);
}

function CandidateCard({ candidate }: { candidate: GeoCandidate }) {
  return (
    <article className="rounded-nested border border-border bg-[var(--glass-3)] p-4">
      <header className="flex items-start gap-3">
        <span className="tnum mt-px font-mono text-[11px] text-fg-tertiary">
          {String(candidate.rank).padStart(2, '0')}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm text-fg">{candidate.place.label}</h3>
          <p className="tnum mt-1 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
            {formatCoord(candidate.center.lat)}, {formatCoord(candidate.center.lon)} · ±{candidate.radiusM}m
          </p>
        </div>
        <Eyebrow mono className="mt-px shrink-0 rounded-full border border-border px-2 py-[3px] text-fg-tertiary">
          {candidate.precision}
        </Eyebrow>
      </header>

      <ConfidenceRing confidence={candidate.confidence} size={48} className="mt-4" />

      <section className="mt-4 border-t border-border pt-3">
        <Eyebrow mono className="block">
          Evidence · {candidate.evidence.length} signals
        </Eyebrow>
        <ul className="mt-2.5 flex flex-col gap-3">
          {candidate.evidence.map((evidence, index) => (
            <li key={`${candidate.id}-${evidence.kind}-${index}`} className="flex gap-2.5">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-n-400" />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <Eyebrow mono className="text-fg-secondary">
                    {EVIDENCE_LABEL[evidence.kind]}
                  </Eyebrow>
                  <span className="tnum font-mono text-[10px] text-n-400">w {evidence.weight.toFixed(2)}</span>
                </div>
                <p className="mt-1 text-[13px] leading-snug text-fg-secondary">{evidence.claim}</p>
                {/* Every signal states how a human checks it without trusting us.
                    That is what makes it evidence rather than telemetry. */}
                <p className="mt-1.5 text-[12px] leading-snug text-fg-tertiary">
                  <span className="eyebrow-mono mr-1.5 text-n-400">verify</span>
                  {evidence.verifiable}
                </p>
                {evidence.reference ? (
                  <Eyebrow mono className="mt-1.5 block text-n-400">
                    ref · {evidence.reference.label}
                  </Eyebrow>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
        <Eyebrow mono>Disposition</Eyebrow>
        <ReviewSelect value={candidate.review} aria-label={`Disposition for ${candidate.place.label}`} />
      </footer>
    </article>
  );
}

export default function Page() {
  const quality = result.quality;
  const geo = result.geo ?? [];

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[var(--map-shell)]">
      <MapCanvas className="absolute inset-0" candidates={geo} />

      <GlassHeader
        forceScrim
        left={
          <>
            <span className="text-sm font-medium tracking-[-0.02em] text-fg">Lantage</span>
            <span aria-hidden className="h-4 w-px bg-border" />
            <Eyebrow mono className="whitespace-nowrap">
              § 01 {result.module} · region targeting
            </Eyebrow>
          </>
        }
        center={
          <div className="glass-pill flex items-center gap-1 p-1 max-[1180px]:hidden">
            <FieldCell label="Image" defaultValue="img_3a9f10.heic" readOnly className="w-[176px]" />
            <FieldCell
              label="AOI bbox"
              divider
              defaultValue="-80.09,40.36,-79.86,40.51"
              readOnly
              className="w-[206px]"
            />
            <Button variant="primary" className="ml-1">
              Search
              <span aria-hidden>→</span>
            </Button>
          </div>
        }
        right={
          <div className="glass-pill flex items-center gap-1 p-1">
            <Button variant="icon" aria-label="Search history">
              <Clock aria-hidden className="size-4" />
            </Button>
            <Button variant="icon" aria-label="Basemap layers">
              <Layers aria-hidden className="size-4" />
            </Button>
            <Button variant="icon" aria-label="Settings">
              <Settings2 aria-hidden className="size-4" />
            </Button>
          </div>
        }
      />

      <nav
        aria-label="Modules"
        className="glass-pill fixed left-[max(16px,env(safe-area-inset-left))] top-1/2 z-40 flex -translate-y-1/2 flex-col gap-1 p-1 max-[820px]:hidden"
      >
        {MODULES.map(({ id, label, Icon }) => (
          <Button
            key={id}
            variant="ghost"
            selected={id === result.module}
            aria-label={`${id} — ${label}`}
            title={`${id} — ${label}`}
            className="size-9 p-0"
          >
            <Icon aria-hidden className="size-4" />
          </Button>
        ))}
      </nav>

      <aside className="fixed bottom-4 right-[max(16px,env(safe-area-inset-right))] top-[92px] z-40 w-[390px] max-[1024px]:w-[340px] max-[820px]:hidden">
        <GlassCard className="flex h-full flex-col overflow-hidden">
          <header className="shrink-0 border-b border-border px-5 pb-4 pt-5">
            <div className="flex items-baseline justify-between gap-3">
              <Eyebrow mono>Results</Eyebrow>
              <Eyebrow mono className="tnum text-fg-secondary">
                {geo.length} regions
              </Eyebrow>
            </div>
            <h2 className="mt-2 text-[17px] text-fg">Where was this taken?</h2>
            {/* A region, never a pin. The radius is part of the claim. */}
            <p className="mt-1.5 text-[13px] leading-snug text-fg-secondary">
              Ranked regions with radii, not points. Nothing below is a location — each one is a hypothesis carrying its
              own evidence.
            </p>
          </header>

          <div
            data-lenis-prevent
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-width:thin]"
          >
            {/* Quality gate first: the band ceiling depends on it. */}
            <section className="rounded-nested border border-border bg-[var(--glass-3)] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <Eyebrow mono>Quality gate</Eyebrow>
                <Eyebrow mono style={{ color: 'var(--color-signal)' }}>
                  passed
                </Eyebrow>
              </div>
              <p className="tnum mt-2 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
                OFIQ {quality.unifiedScore} · {quality.components.resolutionPx.w}×{quality.components.resolutionPx.h} ·
                blur {quality.components.blur?.toFixed(2)} · not degraded
              </p>
            </section>

            <ol className="mt-4 flex flex-col gap-3">
              {geo.map((candidate) => (
                <li key={candidate.id}>
                  <CandidateCard candidate={candidate} />
                </li>
              ))}
            </ol>

            {/* The refusal state. A separate run, because a failed gate returns no
                ranking at all — see assertRefusalIsHonoured() above. */}
            <section className="rounded-nested mt-5 border border-[color-mix(in_srgb,var(--color-alert)_30%,transparent)] bg-[var(--alert-dim)] p-4">
              <div className="flex items-baseline justify-between gap-3">
                <Eyebrow mono style={{ color: 'var(--color-alert)' }}>
                  Prior run · refused
                </Eyebrow>
                <Eyebrow mono className="tnum text-fg-tertiary">
                  {refusedResult.id}
                </Eyebrow>
              </div>
              <ConfidenceRing confidence={refusedConfidence} size={48} showCalibration className="mt-3.5" />
              <p className="tnum mt-3.5 border-t border-border pt-3 font-mono text-[10.5px] tracking-[0.04em] text-fg-tertiary">
                {refusedResult.quality.components.resolutionPx.w}×{refusedResult.quality.components.resolutionPx.h} ·
                blur {refusedResult.quality.components.blur?.toFixed(2)} · 0 candidates returned
              </p>
              <StageTrace stages={refusedResult.stages} className="mt-3" />
            </section>

            <section className="mt-5 border-t border-border pt-4">
              <Eyebrow mono className="block">
                Cascade trace
              </Eyebrow>
              <StageTrace stages={result.stages} className="mt-3" />
            </section>

            <section className="mt-5 border-t border-border pt-4">
              <Eyebrow mono className="block">
                Provenance
              </Eyebrow>
              <dl className="mt-2.5 flex flex-col gap-1.5">
                {Object.entries(result.provenance.models).map(([role, version]) => (
                  <div key={role} className="flex items-baseline gap-2">
                    <dt className="eyebrow-mono shrink-0 text-n-400">{role}</dt>
                    <span
                      aria-hidden
                      className="min-w-2 flex-1 translate-y-[-3px] border-b border-dashed border-border"
                    />
                    <dd className="tnum shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-fg-secondary">
                      {version}
                    </dd>
                  </div>
                ))}
                <div className="mt-1 flex items-baseline gap-2">
                  <dt className="eyebrow-mono shrink-0 text-n-400">index</dt>
                  <span aria-hidden className="min-w-2 flex-1 translate-y-[-3px] border-b border-dashed border-border" />
                  <dd className="tnum shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-fg-secondary">
                    {result.provenance.indexBuild}
                  </dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="eyebrow-mono shrink-0 text-n-400">cost</dt>
                  <span aria-hidden className="min-w-2 flex-1 translate-y-[-3px] border-b border-dashed border-border" />
                  <dd className="tnum shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-fg-secondary">
                    ${result.provenance.totalCostUsd.toFixed(4)}
                  </dd>
                </div>
              </dl>
            </section>
          </div>

          <footer className="shrink-0 border-t border-border px-5 py-3.5">
            {/* Permanent furniture. No dismiss affordance, by contract. */}
            <LeadDisclaimer />
          </footer>
        </GlassCard>
      </aside>
    </main>
  );
}
