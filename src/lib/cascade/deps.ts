/**
 * Dependency boundary between B2's cascade and everything owned by another agent.
 *
 * Two kinds of dependency live here:
 *
 *  - **Ours** (embedding client, VLM provider, geocoder, detector, C2PA reader,
 *    ecoregion mask). Real defaults, constructed from env. If the env is unset the
 *    provider returns `not-configured` and the cascade degrades — it never throws.
 *
 *  - **Someone else's** (`src/lib/db` = A2, `src/lib/auth` = A3; the audit writer
 *    lives with the data layer as `writeAudit`). Each is declared here as the
 *    narrowest interface B2 actually needs and left null until registered, so no
 *    stage ever depends on another agent's file being finished. Search fails
 *    **closed** on a missing security dependency (auth, audit) and **degrades** on
 *    a missing capability dependency (index, storage).
 *
 * Wiring is one function call, in one file, with no dynamic-import magic:
 * `registerCascadeRuntime({ ... })` from `src/lib/cascade/wiring.ts`.
 */

import type { ModuleId, SearchRequest, SearchResult } from '@/lib/contracts/types';
import { type EmbedClient, ModalEmbedClient } from './embedClient';
import type { GeoVectorSearch } from './vprRetrieval';
import type { RerankVectorStore } from './rerank';
import { type ImageRef, type Result, type StageFailure } from './types';
import { GeminiFlashVlmProvider, type VlmProvider } from './vlmProvider';
import { type Geocoder, NominatimGeocoder } from '@/lib/verify/ocrGeocode';
import { type EcoregionMask, unconfiguredEcoregionMask } from '@/lib/verify/ecoregion';
import { type C2paReader, ContainerC2paProbe } from '@/lib/verify/c2pa';
import { type AiDetectorProvider, HiveAiDetector } from '@/lib/verify/detector';

// ---------------------------------------------------------------------------
// A2 — src/lib/db
// ---------------------------------------------------------------------------

/**
 * TODO(A2): resolve an image id to something the cascade can send to Modal and
 * the VLM. A signed URL is strongly preferred; bytes are the fallback.
 * `orgId` is not decoration — it is the tenant scope the RLS policy enforces.
 */
export interface ImageStore {
  resolve(args: { imageId: string; orgId: string }): Promise<Result<ImageRef, StageFailure>>;
}

/**
 * TODO(A2): persistence for results. Note `save` takes the whole `SearchResult`
 * including its stage traces and provenance — a result without its trace is not
 * reproducible, and reproducibility is the product.
 */
export interface SearchResultStore {
  save(args: {
    result: SearchResult;
    orgId: string;
    userId: string;
    caseId?: string;
  }): Promise<Result<{ id: string }, StageFailure>>;
  get(args: { id: string; orgId: string }): Promise<Result<SearchResult | null, StageFailure>>;
}

// ---------------------------------------------------------------------------
// A3 — src/lib/auth (audit writer: src/lib/db/queries/audit.ts)
// ---------------------------------------------------------------------------

export interface SearchPrincipal {
  userId: string;
  orgId: string;
  email?: string;
  /** Verified users only. An unverified account cannot run a search. */
  verified: boolean;
  /** Drives `isModuleAllowed` — e.g. a CCOPS jurisdiction restricting a module. */
  jurisdiction?: string;
}

/**
 * Implemented by `src/lib/auth/guard.ts` as `cascadeAuthGate`.
 *
 * `canSearch` must never throw — it returns a decision. `503` is part of that
 * decision space because "the auth backend is unreachable or unconfigured" is a
 * different fact from "you are not allowed", and collapsing it into 403 would tell
 * an operator their credentials are wrong when the database is simply not wired.
 */
export interface AuthGate {
  canSearch(request: Request): Promise<{
    allowed: boolean;
    principal?: SearchPrincipal;
    reason?: string;
    status?: 401 | 403 | 503;
  }>;
  isModuleAllowed(module: ModuleId, jurisdiction: string | undefined): boolean;
}

/**
 * TODO(A2/A3): implemented by `writeAudit` in `src/lib/db/queries/audit.ts`.
 *
 * Append-only, always. Two rows per search — one when it is requested and one
 * when it resolves — because AGENTS.md forbids `UPDATE`/`DELETE` on audit rows.
 * Never "update the record with the outcome": write a second row.
 */
export interface SearchAuditRecord {
  searchId: string;
  phase: 'requested' | 'completed' | 'refused' | 'error';
  module: ModuleId;
  imageId: string;
  caseId?: string;
  userId: string;
  orgId: string;
  at: string;
  ip?: string;
  userAgent?: string;
  hints?: SearchRequest['hints'];
  /** Analyst-facing outcome note. Never contains plate characters — see vlmProvider. */
  note?: string;
}

export interface AuditWriter {
  writeSearchAudit(record: SearchAuditRecord): Promise<Result<void, StageFailure>>;
}

// ---------------------------------------------------------------------------
// Runtime registry
// ---------------------------------------------------------------------------

export interface CascadeRuntime {
  embed: EmbedClient;
  vlm: VlmProvider | null;
  vectorSearch: GeoVectorSearch | null;
  rerankStore: RerankVectorStore | null;
  geocoder: Geocoder | null;
  ecoregion: EcoregionMask;
  c2pa: C2paReader | null;
  detector: AiDetectorProvider | null;
  imageStore: ImageStore | null;
  resultStore: SearchResultStore | null;
  auth: AuthGate | null;
  audit: AuditWriter | null;
}

function defaults(): CascadeRuntime {
  return {
    embed: new ModalEmbedClient(),
    vlm: new GeminiFlashVlmProvider(),
    vectorSearch: null,
    rerankStore: null,
    geocoder: new NominatimGeocoder(),
    ecoregion: unconfiguredEcoregionMask,
    c2pa: new ContainerC2paProbe(),
    detector: new HiveAiDetector(),
    imageStore: null,
    resultStore: null,
    auth: null,
    audit: null,
  };
}

let runtime: CascadeRuntime | null = null;
const overrides: Partial<CascadeRuntime> = {};

/** Register cross-agent implementations. Call from `wiring.ts` only. */
export function registerCascadeRuntime(partial: Partial<CascadeRuntime>): void {
  Object.assign(overrides, partial);
  runtime = null;
}

export function getCascadeRuntime(): CascadeRuntime {
  if (!runtime) runtime = { ...defaults(), ...overrides };
  return runtime;
}

/** Test seam: drop registrations between cases. */
export function resetCascadeRuntime(): void {
  for (const key of Object.keys(overrides)) {
    delete overrides[key as keyof CascadeRuntime];
  }
  runtime = null;
}

/**
 * Dependencies whose absence must fail the request closed rather than degrade it.
 *
 * Auth and audit are security controls: "every search writes an immutable audit
 * record" is not a best-effort property, and a search that cannot be attributed
 * is a search we do not run. The panorama index and the geocoder are capability
 * dependencies — missing them produces a weaker answer, which is a legitimate
 * answer as long as the trace says so.
 */
export function missingRequiredDependencies(runtimeToCheck = getCascadeRuntime()): string[] {
  const missing: string[] = [];
  if (!runtimeToCheck.auth) missing.push('auth (src/lib/auth — A3)');
  if (!runtimeToCheck.audit) missing.push('audit (writeAudit in src/lib/db/queries/audit.ts — A2)');
  if (!runtimeToCheck.imageStore) missing.push('image store (src/lib/db — A2)');
  return missing;
}
