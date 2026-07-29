/**
 * Jurisdiction gating — types.
 *
 * MASTER_PLAN §7: "Jurisdiction gating: disable modules per-customer by
 * city/state." The legal landscape for image intelligence is a patchwork of
 * municipal ordinances, state statutes, and one private right of action, and it
 * does not resolve to a single national rule. So the gate is a declarative table
 * plus a resolver, not a scattering of `if (state === 'IL')`.
 *
 * ⚠️ THIS TABLE CHURNS CONSTANTLY AND IS NOT LEGAL ADVICE. It is a starting
 * point that must be verified against the actual ordinance text for every target
 * city at sale time. Cities amend CCOPS ordinances, states pass and sunset FR
 * statutes, and a "ban" is frequently a moratorium with an expiry or a carve-out
 * for a specific unit. Treat a `deny` here as reliable (fail-closed) and an
 * `allow` here as unverified.
 */

import type { ModuleId } from '@/lib/contracts/types';
import type { CustomerType, OrgJurisdiction } from '@/lib/auth/types';

/**
 * What the gate can be asked about.
 *
 * `ModuleId` is the shipped surface. The two extras are capabilities Lantage
 * deliberately does not build (AGENTS.md "Boundaries"):
 *
 * - `ALPR`       — licence-plate recognition. Not shipped, at all.
 * - `FACE_INDEX` — an internet-scraped face index. Not shipped, at all.
 *
 * They are in the union, and in the policy table, as defence in depth. If a
 * future contributor adds either capability, the gate already denies it in every
 * jurisdiction that restricts it, and the denial cites the statute. The primary
 * control is that the code does not exist; this is the second layer.
 */
export type GatedCapability = ModuleId | 'ALPR' | 'FACE_INDEX';

/** Capabilities that are refused everywhere, regardless of jurisdiction. */
export const PERMANENTLY_UNAVAILABLE: readonly GatedCapability[] = ['ALPR', 'FACE_INDEX'];

/**
 * Capabilities that stay off until a contract explicitly turns them on, even
 * where no law restricts them.
 *
 * MATCH is here because MASTER_PLAN §1/§7 make closed-gallery 1:N "v2 and gated",
 * and because the gating reason is not primarily jurisdictional — it is the CJIS
 * fork. The moment a gallery is sourced from a state ID bureau or the FBI it is
 * Criminal Justice Information, which puts the vendor in CJIS scope and off
 * Supabase and Vercel entirely. No amount of city-ordinance checking catches that,
 * so a denylist (`Org.disabledModules`) is the wrong shape: MATCH must be *opted
 * into* per contract, after the scoping analysis is blessed in writing by the
 * state CSA.
 */
export const REQUIRES_EXPLICIT_ENABLEMENT: readonly GatedCapability[] = ['MATCH'];

/**
 * What kind of technology the capability is, for the purpose of matching a rule.
 * A rule targets a class, not a product name — that is what makes the table
 * survive a module rename.
 */
export type CapabilityClass =
  /** Determines where an image was taken. CCOPS "surveillance technology" when an agency acquires it. */
  | 'geolocation'
  /** Face recognition / biometric identification. The heavily regulated one. */
  | 'biometric-face'
  /** Vehicle make/model/colour. NOT plate reading — see the note on VEHICLE. */
  | 'vehicle-attribute'
  /** Reads plate characters. Not shipped. */
  | 'alpr'
  /** Image authenticity / provenance. Not surveillance under any statute reviewed. */
  | 'authenticity'
  /** Retrieval against imagery the customer already owns and has rights to. */
  | 'own-corpus-retrieval';

/** Which class each module belongs to. The one place this mapping exists. */
export const CAPABILITY_CLASS: Record<GatedCapability, CapabilityClass> = {
  GEO: 'geolocation',
  STREET: 'geolocation',
  VEHICLE: 'vehicle-attribute',
  VERIFY: 'authenticity',
  CLAIM: 'own-corpus-retrieval',
  MATCH: 'biometric-face',
  ALPR: 'alpr',
  FACE_INDEX: 'biometric-face',
};

/** The authority a decision rests on. A block with no citation is not shippable. */
export interface LegalCitation {
  readonly kind: LegalBasisKind;
  /** Short label for the UI, e.g. "Pittsburgh CCOPS ordinance". */
  readonly authority: string;
  /** What it actually requires or forbids, in one sentence an analyst can act on. */
  readonly summary: string;
  /** Where to read it. Often absent for municipal code — that is expected. */
  readonly reference?: string;
  /**
   * When this entry was last checked against the source text. Stale entries are
   * the failure mode of a table like this, so the date is not optional.
   */
  readonly verifiedOn: string;
}

export type LegalBasisKind =
  /** Council approval + published Surveillance Impact Report before acquisition. */
  | 'ccops-ordinance'
  /** Municipal prohibition on government/police face recognition. */
  | 'city-fr-ban'
  /** State statute requiring a warrant before an FR search. */
  | 'state-fr-warrant'
  /** State statute requiring probable cause or a court order. */
  | 'state-fr-probable-cause'
  /** "May not be the sole basis for an arrest." The Detroit standard, in statute. */
  | 'state-fr-not-sole-basis'
  /** Biometric privacy act with a private right of action. Illinois BIPA. */
  | 'biometric-private-right-of-action'
  /** Private-party ALPR prohibited outright. */
  | 'alpr-prohibited'
  /** Private-party ALPR restricted (retention limits, purpose limits, registration). */
  | 'alpr-restricted'
  /** Our own product boundary, not someone else's law. */
  | 'product-boundary'
  /** The customer's contract, not a statute. */
  | 'contract';

/**
 * What a matched rule does.
 *
 * `require-approval` is the interesting one: it is not a denial. A CCOPS city can
 * absolutely buy the tool — it just has to publish a Surveillance Impact Report
 * and hold a council vote first. Modelling that as `deny` would be wrong and
 * would cost real deals; modelling it as `allow` would walk a customer into an
 * ordinance violation. So it denies *until the approval is recorded on the org*,
 * and the refusal says which approval is missing.
 */
export type PolicyEffect =
  | { readonly kind: 'deny' }
  | { readonly kind: 'require-approval'; readonly approval: ApprovalKind }
  | { readonly kind: 'constrain'; readonly constraint: OperatingConstraint };

export type ApprovalKind =
  /** Council-approved Surveillance Impact Report on file. */
  | 'ccops-sir'
  | 'warrant'
  | 'court-order'
  | 'probable-cause';

/**
 * A condition on use rather than a bar to it. Surfaced in the UI next to the
 * result and recorded on the audit row, because "we told them" is the whole
 * point of the Detroit consent decree.
 */
export type OperatingConstraint =
  | 'not-sole-basis-for-arrest'
  | 'no-photo-lineup-from-match'
  | 'serious-crimes-only'
  | 'documented-corroboration-required';

/** One row of the policy table. */
export interface JurisdictionRule {
  /** Two-letter USPS state code. `'*'` matches every state. */
  readonly state: string | '*';
  /** Municipality, matched case-insensitively. Absent = the whole state. */
  readonly city?: string;
  /** County, for county-level ordinances (King County WA, Santa Clara County CA). */
  readonly county?: string;
  /** Capability classes this rule reaches. */
  readonly classes: readonly CapabilityClass[];
  /**
   * Customer types this rule binds. CCOPS and municipal FR bans reach government
   * agencies only; BIPA reaches private parties too.
   */
  readonly appliesTo: readonly CustomerType[];
  readonly effect: PolicyEffect;
  readonly citation: LegalCitation;
}

/** Every customer type. Used by rules that bind regardless of who is asking. */
export const ALL_CUSTOMERS: readonly CustomerType[] = [
  'insurance-siu',
  'private-professional',
  'government-agency',
  'nonprofit',
];

export const AGENCIES_ONLY: readonly CustomerType[] = ['government-agency'];

/** Everyone who is not the government. BIPA's defendants. */
export const PRIVATE_PARTIES: readonly CustomerType[] = [
  'insurance-siu',
  'private-professional',
  'nonprofit',
];

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type Jurisdiction = OrgJurisdiction;

/**
 * Approvals an org has actually obtained, so a `require-approval` rule can be
 * satisfied. Recorded per org at contract time — a claimed warrant is not an
 * approval, a recorded one is.
 */
export interface JurisdictionApprovals {
  readonly ccopsSir?: { readonly approvedOn: string; readonly reference: string };
  /** Per-search authority. Recorded on the search, not the org — hence optional. */
  readonly warrant?: { readonly reference: string };
  readonly courtOrder?: { readonly reference: string };
  readonly probableCause?: { readonly note: string };
}

/**
 * UI-consumable block result. Shaped for the design system: `headline` goes in an
 * `.eyebrow-mono` label, `reasons` render as a cited list inside a `.glass-card`.
 */
export interface ModuleBlocked {
  readonly allowed: false;
  readonly capability: GatedCapability;
  readonly jurisdiction: Jurisdiction;
  /** Short, e.g. "MATCH BLOCKED — PITTSBURGH, PA". */
  readonly headline: string;
  /** Plain-English summary of the single most restrictive reason. */
  readonly summary: string;
  /** Every rule that fired. Never empty — a block always cites its authority. */
  readonly reasons: readonly LegalCitation[];
  /** What would unblock it, if anything. Absent when nothing would. */
  readonly remedy?: string;
}

export interface ModuleAllowed {
  readonly allowed: true;
  readonly capability: GatedCapability;
  readonly jurisdiction: Jurisdiction;
  /**
   * Conditions on use. An empty array is normal; a non-empty one MUST be shown
   * to the analyst and is written onto the audit row.
   */
  readonly constraints: readonly OperatingConstraint[];
  /** Citations behind those constraints, plus anything advisory. */
  readonly notices: readonly LegalCitation[];
}

export type ModuleDecision = ModuleAllowed | ModuleBlocked;

export function isBlocked(d: ModuleDecision): d is ModuleBlocked {
  return !d.allowed;
}
