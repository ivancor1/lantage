/**
 * Hand-written database types.
 *
 * Two naming worlds meet in this file, and the seam is deliberate:
 *
 *   • COLUMNS are snake_case, because that is what Postgres and PostgREST return
 *     and pretending otherwise means a mapping layer nobody maintains.
 *   • JSONB PAYLOADS are the contract types from `src/lib/contracts/types.ts`
 *     verbatim, camelCase and all. `confidence`, `evidence`, `quality`, `stages`,
 *     `provenance`, `place`, `vpic`, `ppv`, `hints`, `corroboration` are typed as
 *     the real domain types rather than as `Json`, so a candidate written without
 *     an evidence chain does not type-check — the same rule the CHECK constraints
 *     enforce at the other end.
 *
 * Use `src/lib/db/mappers.ts` to cross the seam.
 *
 * These are written by hand on purpose: the schema is not deployed anywhere yet
 * (no project chosen), and other agents are already coding against these names.
 * Once a project exists, `npm run db:types` writes the generated equivalent to
 * `types.generated.ts` and this file becomes the diff target — if they disagree,
 * the generated one is right about the database and this one is right about the
 * domain, so reconcile rather than blindly overwrite.
 *
 * Everything below uses `type`, never `interface`. TypeScript only gives implicit
 * index signatures to type aliases, and postgrest-js requires
 * `Row extends Record<string, unknown>`. An interface here breaks the client
 * generics with an error that does not mention the cause.
 */

import type {
  AuthenticityVerdict,
  Confidence,
  EvidenceChain,
  GeoCandidate,
  LedgerEntry,
  ModuleId,
  QualityGate,
  ResultProvenance,
  ReviewState,
  SearchRequest,
  StageTrace,
  SuppressionReason,
  VehicleCandidate,
} from '@/lib/contracts/types';

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** ISO 8601. Postgres `timestamptz` arrives as a string over the wire. */
export type Timestamptz = string;

/**
 * A pgvector column. Reads come back as a bracketed string ("[0.1,-0.2,…]");
 * writes accept either that string or a plain number[]. Never store an
 * unnormalized vector — halfvec is fp16 and cosine only equals inner product on
 * the unit sphere.
 */
export type EmbeddingIn = string | number[];
export type EmbeddingOut = string;

export type UserRole = 'owner' | 'admin' | 'analyst' | 'viewer';
export type CaseStatus = 'open' | 'closed';
export type CorpusKind = 'claim-photos' | 'licensed-stock' | 'reference-gallery' | 'other';
export type CorpusRelation = 'near-duplicate' | 'same-scene' | 'similar';
export type GeoPrecision = GeoCandidate['precision'];

/** Dotted verbs used by writeAudit. Open union: the vocabulary grows with the product. */
export type AuditAction =
  | 'auth.sign-in'
  | 'auth.sign-in-failed'
  | 'case.create'
  | 'case.close'
  | 'image.upload'
  | 'search.create'
  | 'search.complete'
  | 'search.refuse'
  | 'result.review'
  | 'ledger.append'
  | 'export.download'
  | 'corpus.ingest'
  | 'corpus.delete'
  | 'admin.role-change'
  | 'admin.license-verify'
  | (string & {});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type OrgRow = {
  id: string;
  name: string;
  created_at: Timestamptz;
};

export type AppUserRow = {
  /** Same value as auth.users.id — the JWT `sub` claim. */
  id: string;
  org_id: string;
  email: string;
  role: UserRole;
  /** Null means identity is unverified. There is no anonymous tier. */
  verified_at: Timestamptz | null;
  license_number: string | null;
  license_state: string | null;
  license_verified_at: Timestamptz | null;
  created_at: Timestamptz;
};

export type CaseRow = {
  id: string;
  org_id: string;
  title: string;
  reference: string | null;
  status: CaseStatus;
  created_by: string | null;
  created_at: Timestamptz;
};

export type ImageRow = {
  id: string;
  org_id: string;
  case_id: string | null;
  storage_path: string;
  sha256: string;
  width: number | null;
  height: number | null;
  mime: string;
  /** Recorded for the ledger, never trusted. Never contains plate characters. */
  exif: Json;
  uploaded_by: string | null;
  created_at: Timestamptz;
};

export type SearchRow = {
  id: string;
  org_id: string;
  case_id: string | null;
  image_id: string;
  module: ModuleId;
  /** `{}` until the analyst supplies priors. */
  hints: NonNullable<SearchRequest['hints']> | Record<string, never>;
  /** `{}` until the quality gate has run. */
  quality: QualityGate | Record<string, never>;
  stages: StageTrace[];
  /** `{}` until the cascade finishes and stamps model + index versions. */
  provenance: ResultProvenance | Record<string, never>;
  created_by: string | null;
  created_at: Timestamptz;
};

export type GeoCandidateRow = {
  id: string;
  search_id: string;
  rank: number;
  lat: number;
  lon: number;
  /** Metres. Never zero — a point estimate is a claim we do not make. */
  radius_m: number;
  precision: GeoPrecision;
  place: GeoCandidate['place'];
  confidence: Confidence;
  evidence: EvidenceChain;
  review: ReviewState;
  created_at: Timestamptz;
};

export type VehicleCandidateRow = {
  id: string;
  search_id: string;
  rank: number;
  make: string;
  model: string;
  generation: string;
  color: string | null;
  vpic: NonNullable<VehicleCandidate['vpic']> | Record<string, never>;
  similarity: number;
  reference_image_url: string | null;
  review: ReviewState;
  created_at: Timestamptz;
};

export type AuthenticityResultRow = {
  id: string;
  search_id: string;
  /** No 'authentic' member exists, by design. */
  verdict: AuthenticityVerdict;
  confidence: Confidence;
  evidence: EvidenceChain;
  /** Non-empty iff verdict is 'inconclusive'. */
  suppressed_by: SuppressionReason[];
  ppv: { value: number; assumedBaseRate: number };
  provenance: { hasManifest: boolean; issuer?: string; valid?: boolean; generator?: string } | Record<string, never>;
  created_at: Timestamptz;
};

export type CorpusRow = {
  id: string;
  org_id: string;
  name: string;
  kind: CorpusKind;
  record_count: number;
  created_at: Timestamptz;
};

export type CorpusRecordRow = {
  id: string;
  corpus_id: string;
  /** The customer's own identifier — claim number, DMS asset id. */
  external_ref: string;
  thumbnail_url: string | null;
  meta: Json;
  /** DINOv2 ViT-L/14, 1024-d. */
  embedding: EmbeddingOut | null;
  created_at: Timestamptz;
};

export type CorpusMatchRow = {
  id: string;
  search_id: string;
  /** Null once the customer has purged the corpus. The finding outlives the pointer. */
  corpus_id: string | null;
  record_id: string | null;
  rank: number;
  similarity: number;
  relation: CorpusRelation;
  thumbnail_url: string | null;
  review: ReviewState;
  created_at: Timestamptz;
};

export type MapillaryImageRow = {
  mapillary_id: string;
  lat: number;
  lon: number;
  compass_angle: number | null;
  captured_at: Timestamptz | null;
  thumb_url: string;
  sequence_id: string | null;
  is_pano: boolean;
  /** Always true. CHECK-enforced (Mapillary ToS §12). */
  blur_applied: boolean;
  metro: string;
  index_build: string;
  /** EigenPlaces / GeoCLIP, 512-d. */
  embedding: EmbeddingOut | null;
  created_at: Timestamptz;
};

export type LedgerEntryRow = {
  id: string;
  case_id: string;
  search_id: string;
  summary: string;
  corroboration: NonNullable<LedgerEntry['corroboration']> | null;
  written_by: string | null;
  written_at: Timestamptz;
};

export type AuditLogRow = {
  id: string;
  /** Null for pre-authentication events, which have no resolvable org. */
  org_id: string | null;
  actor_id: string | null;
  action: AuditAction;
  subject_type: string | null;
  subject_id: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: Json;
  at: Timestamptz;
};

export type BenchmarkRunRow = {
  id: string;
  name: string;
  model_versions: Record<string, string> | Record<string, never>;
  index_build: string | null;
  dataset: string;
  metrics: Json;
  at: Timestamptz;
};

// ---------------------------------------------------------------------------
// RPC return shapes
// ---------------------------------------------------------------------------

/** One row of `search_geo_candidates`. A retrieval hit, not yet a GeoCandidate. */
export type GeoAnnHit = {
  mapillary_id: string;
  lat: number;
  lon: number;
  compass_angle: number | null;
  captured_at: Timestamptz | null;
  thumb_url: string;
  sequence_id: string | null;
  is_pano: boolean;
  metro: string;
  index_build: string;
  /** Cosine distance, 0..2. Lower is closer. */
  distance: number;
  /** 1 - distance. Convenience only; rank on distance. */
  similarity: number;
};

/** One row of `search_corpus_records`. */
export type CorpusAnnHit = {
  record_id: string;
  corpus_id: string;
  external_ref: string;
  thumbnail_url: string | null;
  meta: Json;
  distance: number;
  similarity: number;
};

// ---------------------------------------------------------------------------
// Insert / Update shapes
// ---------------------------------------------------------------------------

export type CaseInsert = {
  id?: string;
  /** Defaulted from the caller's JWT by the database; pass it explicitly only from the service role. */
  org_id?: string;
  title: string;
  reference?: string | null;
  status?: CaseStatus;
  created_by?: string | null;
  created_at?: Timestamptz;
};

export type ImageInsert = {
  id?: string;
  org_id?: string;
  case_id?: string | null;
  storage_path: string;
  sha256: string;
  width?: number | null;
  height?: number | null;
  mime: string;
  exif?: Json;
  uploaded_by?: string | null;
  created_at?: Timestamptz;
};

export type SearchInsert = {
  id?: string;
  org_id?: string;
  case_id?: string | null;
  image_id: string;
  module: ModuleId;
  hints?: SearchRow['hints'];
  quality?: SearchRow['quality'];
  stages?: StageTrace[];
  provenance?: SearchRow['provenance'];
  created_by?: string | null;
  created_at?: Timestamptz;
};

/** The only three columns an authenticated caller may patch on a search. */
export type SearchUpdate = {
  quality?: SearchRow['quality'];
  stages?: StageTrace[];
  provenance?: SearchRow['provenance'];
};

export type GeoCandidateInsert = {
  id?: string;
  search_id: string;
  rank: number;
  lat: number;
  lon: number;
  radius_m: number;
  precision: GeoPrecision;
  place: GeoCandidate['place'];
  confidence: Confidence;
  evidence: EvidenceChain;
  review?: ReviewState;
  created_at?: Timestamptz;
};

export type VehicleCandidateInsert = {
  id?: string;
  search_id: string;
  rank: number;
  make: string;
  model: string;
  generation: string;
  color?: string | null;
  vpic?: VehicleCandidateRow['vpic'];
  similarity: number;
  reference_image_url?: string | null;
  review?: ReviewState;
  created_at?: Timestamptz;
};

export type AuthenticityResultInsert = {
  id?: string;
  search_id: string;
  verdict: AuthenticityVerdict;
  confidence: Confidence;
  evidence: EvidenceChain;
  suppressed_by?: SuppressionReason[];
  ppv: AuthenticityResultRow['ppv'];
  provenance?: AuthenticityResultRow['provenance'];
  created_at?: Timestamptz;
};

export type CorpusMatchInsert = {
  id?: string;
  search_id: string;
  corpus_id?: string | null;
  record_id?: string | null;
  rank: number;
  similarity: number;
  relation: CorpusRelation;
  thumbnail_url?: string | null;
  review?: ReviewState;
  created_at?: Timestamptz;
};

export type CorpusRecordInsert = {
  id?: string;
  corpus_id: string;
  external_ref: string;
  thumbnail_url?: string | null;
  meta?: Json;
  embedding?: EmbeddingIn | null;
  created_at?: Timestamptz;
};

export type MapillaryImageInsert = {
  mapillary_id: string;
  lat: number;
  lon: number;
  compass_angle?: number | null;
  captured_at?: Timestamptz | null;
  thumb_url: string;
  sequence_id?: string | null;
  is_pano?: boolean;
  /** Must be true. The CHECK constraint rejects anything else. */
  blur_applied?: true;
  metro: string;
  index_build: string;
  embedding?: EmbeddingIn | null;
  created_at?: Timestamptz;
};

export type LedgerEntryInsert = {
  id?: string;
  case_id: string;
  search_id: string;
  summary: string;
  corroboration?: LedgerEntryRow['corroboration'];
  written_by?: string | null;
  written_at?: Timestamptz;
};

export type AuditLogInsert = {
  id?: string;
  org_id?: string | null;
  actor_id?: string | null;
  action: AuditAction;
  subject_type?: string | null;
  subject_id?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  detail?: Json;
  at?: Timestamptz;
};

// ---------------------------------------------------------------------------
// The generated-shape Database type
// ---------------------------------------------------------------------------

/**
 * Matches what `supabase gen types typescript` emits, so `SupabaseClient<Database>`
 * behaves identically before and after the schema is deployed. `Relationships` is
 * filled in accurately — that metadata is what makes PostgREST embedded selects
 * (`.select('*, geo_candidates(*)')`) type-check.
 */
export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '12';
  };
  public: {
    Tables: {
      orgs: {
        Row: OrgRow;
        Insert: { id?: string; name: string; created_at?: Timestamptz };
        Update: { id?: string; name?: string; created_at?: Timestamptz };
        Relationships: [];
      };
      app_users: {
        Row: AppUserRow;
        Insert: {
          id: string;
          org_id: string;
          email: string;
          role?: UserRole;
          verified_at?: Timestamptz | null;
          license_number?: string | null;
          license_state?: string | null;
          license_verified_at?: Timestamptz | null;
          created_at?: Timestamptz;
        };
        Update: { email?: string };
        Relationships: [
          {
            foreignKeyName: 'app_users_org_id_fkey';
            columns: ['org_id'];
            isOneToOne: false;
            referencedRelation: 'orgs';
            referencedColumns: ['id'];
          },
        ];
      };
      cases: {
        Row: CaseRow;
        Insert: CaseInsert;
        Update: { title?: string; reference?: string | null; status?: CaseStatus };
        Relationships: [
          {
            foreignKeyName: 'cases_org_id_fkey';
            columns: ['org_id'];
            isOneToOne: false;
            referencedRelation: 'orgs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cases_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'app_users';
            referencedColumns: ['id'];
          },
        ];
      };
      images: {
        Row: ImageRow;
        Insert: ImageInsert;
        Update: { case_id?: string | null };
        Relationships: [
          {
            foreignKeyName: 'images_org_id_fkey';
            columns: ['org_id'];
            isOneToOne: false;
            referencedRelation: 'orgs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'images_case_id_fkey';
            columns: ['case_id'];
            isOneToOne: false;
            referencedRelation: 'cases';
            referencedColumns: ['id'];
          },
        ];
      };
      searches: {
        Row: SearchRow;
        Insert: SearchInsert;
        Update: SearchUpdate;
        Relationships: [
          {
            foreignKeyName: 'searches_org_id_fkey';
            columns: ['org_id'];
            isOneToOne: false;
            referencedRelation: 'orgs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'searches_case_id_fkey';
            columns: ['case_id'];
            isOneToOne: false;
            referencedRelation: 'cases';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'searches_image_id_fkey';
            columns: ['image_id'];
            isOneToOne: false;
            referencedRelation: 'images';
            referencedColumns: ['id'];
          },
        ];
      };
      geo_candidates: {
        Row: GeoCandidateRow;
        Insert: GeoCandidateInsert;
        Update: { review?: ReviewState };
        Relationships: [
          {
            foreignKeyName: 'geo_candidates_search_id_fkey';
            columns: ['search_id'];
            isOneToOne: false;
            referencedRelation: 'searches';
            referencedColumns: ['id'];
          },
        ];
      };
      vehicle_candidates: {
        Row: VehicleCandidateRow;
        Insert: VehicleCandidateInsert;
        Update: { review?: ReviewState };
        Relationships: [
          {
            foreignKeyName: 'vehicle_candidates_search_id_fkey';
            columns: ['search_id'];
            isOneToOne: false;
            referencedRelation: 'searches';
            referencedColumns: ['id'];
          },
        ];
      };
      authenticity_results: {
        Row: AuthenticityResultRow;
        Insert: AuthenticityResultInsert;
        Update: Record<string, never>;
        Relationships: [
          {
            foreignKeyName: 'authenticity_results_search_id_fkey';
            columns: ['search_id'];
            // UNIQUE(search_id) — this is what makes the embed return an object, not an array.
            isOneToOne: true;
            referencedRelation: 'searches';
            referencedColumns: ['id'];
          },
        ];
      };
      corpora: {
        Row: CorpusRow;
        Insert: {
          id?: string;
          org_id?: string;
          name: string;
          kind: CorpusKind;
          record_count?: number;
          created_at?: Timestamptz;
        };
        Update: { name?: string; kind?: CorpusKind; record_count?: number };
        Relationships: [
          {
            foreignKeyName: 'corpora_org_id_fkey';
            columns: ['org_id'];
            isOneToOne: false;
            referencedRelation: 'orgs';
            referencedColumns: ['id'];
          },
        ];
      };
      corpus_records: {
        Row: CorpusRecordRow;
        Insert: CorpusRecordInsert;
        Update: {
          external_ref?: string;
          thumbnail_url?: string | null;
          meta?: Json;
          embedding?: EmbeddingIn | null;
        };
        Relationships: [
          {
            foreignKeyName: 'corpus_records_corpus_id_fkey';
            columns: ['corpus_id'];
            isOneToOne: false;
            referencedRelation: 'corpora';
            referencedColumns: ['id'];
          },
        ];
      };
      corpus_matches: {
        Row: CorpusMatchRow;
        Insert: CorpusMatchInsert;
        Update: { review?: ReviewState };
        Relationships: [
          {
            foreignKeyName: 'corpus_matches_search_id_fkey';
            columns: ['search_id'];
            isOneToOne: false;
            referencedRelation: 'searches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'corpus_matches_corpus_id_fkey';
            columns: ['corpus_id'];
            isOneToOne: false;
            referencedRelation: 'corpora';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'corpus_matches_record_id_fkey';
            columns: ['record_id'];
            isOneToOne: false;
            referencedRelation: 'corpus_records';
            referencedColumns: ['id'];
          },
        ];
      };
      mapillary_images: {
        Row: MapillaryImageRow;
        Insert: MapillaryImageInsert;
        Update: Partial<MapillaryImageInsert>;
        Relationships: [];
      };
      ledger_entries: {
        Row: LedgerEntryRow;
        Insert: LedgerEntryInsert;
        /** Append-only. UPDATE is refused by trigger, by RLS, and by grant. */
        Update: Record<string, never>;
        Relationships: [
          {
            foreignKeyName: 'ledger_entries_case_id_fkey';
            columns: ['case_id'];
            isOneToOne: false;
            referencedRelation: 'cases';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ledger_entries_search_id_fkey';
            columns: ['search_id'];
            isOneToOne: false;
            referencedRelation: 'searches';
            referencedColumns: ['id'];
          },
        ];
      };
      audit_log: {
        Row: AuditLogRow;
        Insert: AuditLogInsert;
        /** Append-only. UPDATE is refused by trigger, by RLS, and by grant. */
        Update: Record<string, never>;
        Relationships: [
          {
            foreignKeyName: 'audit_log_org_id_fkey';
            columns: ['org_id'];
            isOneToOne: false;
            referencedRelation: 'orgs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'audit_log_actor_id_fkey';
            columns: ['actor_id'];
            isOneToOne: false;
            referencedRelation: 'app_users';
            referencedColumns: ['id'];
          },
        ];
      };
      benchmark_runs: {
        Row: BenchmarkRunRow;
        Insert: {
          id?: string;
          name: string;
          model_versions?: Record<string, string>;
          index_build?: string | null;
          dataset: string;
          metrics?: Json;
          at?: Timestamptz;
        };
        Update: Partial<BenchmarkRunRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      current_org_id: {
        Args: Record<PropertyKey, never>;
        Returns: string | null;
      };
      is_service_role: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      search_geo_candidates: {
        Args: {
          query_embedding: EmbeddingIn;
          p_metro?: string | null;
          p_index_build?: string | null;
          /** [min_lon, min_lat, max_lon, max_lat] */
          p_bbox?: number[] | null;
          p_limit?: number;
          p_ef_search?: number;
        };
        Returns: GeoAnnHit[];
      };
      search_corpus_records: {
        Args: {
          query_embedding: EmbeddingIn;
          p_corpus_id: string;
          p_limit?: number;
          p_max_distance?: number;
          p_ef_search?: number;
        };
        Returns: CorpusAnnHit[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/** Every helper in `queries/` takes one of these as its first argument. */
export type PublicSchema = Database['public'];
export type TableName = keyof PublicSchema['Tables'];
