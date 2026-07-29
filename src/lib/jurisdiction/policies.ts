/**
 * The jurisdiction policy table.
 *
 * ⚠️ NOT LEGAL ADVICE, AND IT GOES STALE. Every entry carries `verifiedOn`.
 * This list churns constantly — cities amend CCOPS ordinances, "bans" are often
 * moratoria with expiry dates or carve-outs for a named unit, and states pass
 * FR statutes every session. **Verify the ordinance text for each target city at
 * sale time.** A `deny` here is safe to rely on (it fails closed). An absence of
 * a rule here is NOT evidence that a jurisdiction is permissive.
 *
 * Scope note that keeps this table small: Lantage ships **no ALPR and no scraped
 * face index at all** (AGENTS.md "Boundaries"). The `alpr` and `FACE_INDEX`
 * entries below are therefore defence in depth, not the primary control — the
 * primary control is that the code does not exist. They are here so that if
 * someone ever adds the capability, the gate already denies it with a citation.
 *
 * Likewise, MATCH (closed-gallery 1:N) is v2 and gated. The face-recognition
 * rules are written now, before the module exists, because writing them
 * afterwards is how a company ends up shipping into a city that banned it.
 */

import type { JurisdictionRule } from './types';
import { AGENCIES_ONLY, ALL_CUSTOMERS, PRIVATE_PARTIES } from './types';

/** Single review date for the whole table. Bump it when the table is re-checked. */
const VERIFIED = '2026-07-29';

// ---------------------------------------------------------------------------
// Rule constructors — keep the data below readable
// ---------------------------------------------------------------------------

/**
 * CCOPS: a Community Control Over Police Surveillance ordinance. ~24 US cities.
 *
 * The mechanic is procurement, not prohibition: before an agency acquires or uses
 * new surveillance technology, it must submit a Surveillance Impact Report and
 * get council approval. So this is `require-approval`, and a CCOPS city is a
 * winnable deal with a longer cycle — MASTER_PLAN §9 says plan for the hearing,
 * don't be surprised by it.
 */
function ccops(state: string, city: string, authority: string, county?: string): JurisdictionRule {
  return {
    state,
    city,
    county,
    // Geolocation and vehicle-attribute recognition are both plausibly
    // "surveillance technology" under a typical CCOPS definition, which is
    // usually broad enough to cover any tech that collects or analyses data
    // about individuals or groups. Biometrics obviously so. Authenticity
    // analysis of an image the agency already holds is not.
    classes: ['geolocation', 'vehicle-attribute', 'biometric-face', 'alpr'],
    appliesTo: AGENCIES_ONLY,
    effect: { kind: 'require-approval', approval: 'ccops-sir' },
    citation: {
      kind: 'ccops-ordinance',
      authority,
      summary:
        'Council approval and a published Surveillance Impact Report are required before ' +
        'the agency acquires or uses new surveillance technology.',
      verifiedOn: VERIFIED,
    },
  };
}

/** Municipal prohibition on government/police face recognition. */
function cityFaceBan(
  state: string,
  city: string,
  authority: string,
  county?: string,
): JurisdictionRule {
  return {
    state,
    city,
    county,
    classes: ['biometric-face'],
    appliesTo: AGENCIES_ONLY,
    effect: { kind: 'deny' },
    citation: {
      kind: 'city-fr-ban',
      authority,
      summary: 'Municipal ordinance prohibits government use of face-recognition technology.',
      verifiedOn: VERIFIED,
    },
  };
}

function stateFrApproval(
  state: string,
  approval: 'warrant' | 'court-order' | 'probable-cause',
  authority: string,
  summary: string,
): JurisdictionRule {
  return {
    state,
    classes: ['biometric-face'],
    appliesTo: AGENCIES_ONLY,
    effect: { kind: 'require-approval', approval },
    citation: {
      kind: approval === 'warrant' ? 'state-fr-warrant' : 'state-fr-probable-cause',
      authority,
      summary,
      verifiedOn: VERIFIED,
    },
  };
}

/**
 * "An FR match may not be the sole basis for an arrest." The Robert Williams
 * settlement standard, now in statute in 8+ states.
 *
 * A constraint, not a denial — and the constraint is already how the product
 * behaves for every module in every state: `LEAD_DISCLAIMER` is permanent UI
 * furniture and `canConfirm()` refuses without recorded corroboration. Encoding
 * it per-state anyway means the analyst sees the specific statute they are
 * operating under, which is what a defence expert will ask about.
 */
function notSoleBasis(state: string, authority: string): JurisdictionRule {
  return {
    state,
    classes: ['biometric-face'],
    appliesTo: AGENCIES_ONLY,
    effect: { kind: 'constrain', constraint: 'not-sole-basis-for-arrest' },
    citation: {
      kind: 'state-fr-not-sole-basis',
      authority,
      summary:
        'A face-recognition match may not be the sole basis for an arrest; independent ' +
        'corroborating evidence is required.',
      verifiedOn: VERIFIED,
    },
  };
}

function alpr(state: string, prohibited: boolean, authority: string): JurisdictionRule {
  return {
    state,
    classes: ['alpr'],
    appliesTo: prohibited ? ALL_CUSTOMERS : PRIVATE_PARTIES,
    effect: { kind: 'deny' },
    citation: {
      kind: prohibited ? 'alpr-prohibited' : 'alpr-restricted',
      authority,
      summary: prohibited
        ? 'Private-party automatic licence-plate recognition is prohibited.'
        : 'Private-party ALPR is restricted (purpose, retention, and registration limits). ' +
          'Denied rather than conditioned because Lantage ships no ALPR in any case.',
      verifiedOn: VERIFIED,
    },
  };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const JURISDICTION_RULES: readonly JurisdictionRule[] = [
  // -- Product boundaries. These bind everywhere and cannot be contracted around.
  {
    state: '*',
    classes: ['alpr'],
    appliesTo: ALL_CUSTOMERS,
    effect: { kind: 'deny' },
    citation: {
      kind: 'product-boundary',
      authority: 'Lantage product boundary (MASTER_PLAN §7, hard line 2)',
      summary:
        'Lantage does not perform licence-plate recognition anywhere, for anyone. Mapillary ' +
        'ToS §12 also requires technical safeguards against undoing upstream plate blur.',
      verifiedOn: VERIFIED,
    },
  },

  // ---------------------------------------------------------------------------
  // CCOPS cities — council approval + published Surveillance Impact Report
  //
  // ~24 nationally. These are the ones confirmed for this table; the count is
  // approximate BECAUSE the list moves. Absence below is not permission.
  // ---------------------------------------------------------------------------
  ccops('WA', 'Seattle', 'Seattle Surveillance Ordinance (SMC 14.18)'),
  ccops('MA', 'Boston', 'Boston surveillance oversight ordinance'),
  ccops('MA', 'Cambridge', 'Cambridge Surveillance Technology Ordinance'),
  ccops('MA', 'Somerville', 'Somerville surveillance technology ordinance'),
  ccops('MA', 'Lawrence', 'Lawrence surveillance technology ordinance'),
  ccops('MA', 'Medford', 'Medford surveillance technology ordinance'),
  ccops('CA', 'Oakland', 'Oakland Surveillance and Community Safety Ordinance'),
  ccops('CA', 'Berkeley', 'Berkeley Surveillance Technology Use and Community Safety Ordinance'),
  ccops('CA', 'Davis', 'Davis surveillance technology ordinance'),
  ccops('CA', 'Palo Alto', 'Palo Alto surveillance technology ordinance'),
  ccops('CA', 'San Francisco', 'San Francisco Stop Secret Surveillance Ordinance'),
  // County-level, so the org's `county` field is what matches.
  {
    ...ccops('CA', '', 'Santa Clara County surveillance-technology ordinance', 'Santa Clara'),
    city: undefined,
  },
  // BART is a multi-county transit district with its own police department, so it
  // cannot be keyed by city. An org whose jurisdiction city is set to 'BART'
  // (the BART PD) matches. Any transit-agency deal needs this checked by hand.
  ccops('CA', 'BART', 'BART surveillance technology ordinance (transit district)'),
  ccops('TN', 'Nashville', 'Nashville/Davidson County surveillance ordinance'),
  ccops('MI', 'Grand Rapids', 'Grand Rapids surveillance technology ordinance'),
  ccops('WI', 'Madison', 'Madison surveillance technology ordinance'),
  // The one that matters for the first PD pilots — MASTER_PLAN §9 targets
  // Pittsburgh, which means a published SIR and a council hearing.
  ccops('PA', 'Pittsburgh', 'Pittsburgh surveillance technology ordinance'),

  // ---------------------------------------------------------------------------
  // Municipal face-recognition bans
  // ---------------------------------------------------------------------------
  cityFaceBan('CA', 'San Francisco', 'San Francisco Stop Secret Surveillance Ordinance (FR ban)'),
  cityFaceBan('CA', 'Oakland', 'Oakland face-recognition prohibition'),
  cityFaceBan('CA', 'Berkeley', 'Berkeley face-recognition prohibition'),
  cityFaceBan('CA', 'Alameda', 'Alameda face-recognition prohibition'),
  cityFaceBan('MA', 'Boston', 'Boston face-surveillance ban'),
  cityFaceBan('MA', 'Cambridge', 'Cambridge face-recognition ban'),
  cityFaceBan('MA', 'Somerville', 'Somerville Face Surveillance Full Ban Ordinance'),
  cityFaceBan('MA', 'Northampton', 'Northampton face-surveillance ban'),
  cityFaceBan('MA', 'Springfield', 'Springfield face-surveillance ban'),
  cityFaceBan('MA', 'Easthampton', 'Easthampton face-surveillance ban'),
  cityFaceBan('OR', 'Portland', 'Portland OR face-recognition ban'),
  cityFaceBan('ME', 'Portland', 'Portland ME face-surveillance ban'),
  cityFaceBan('MN', 'Minneapolis', 'Minneapolis face-recognition ban'),
  cityFaceBan('WI', 'Madison', 'Madison face-recognition restriction'),
  cityFaceBan('MS', 'Jackson', 'Jackson MS face-recognition ban'),
  { ...cityFaceBan('WA', '', 'King County face-recognition ban', 'King'), city: undefined },

  // ---------------------------------------------------------------------------
  // State face-recognition statutes
  // ---------------------------------------------------------------------------
  stateFrApproval(
    'MT',
    'warrant',
    'Montana face-recognition statute',
    'A warrant is required before a government entity may run a face-recognition search.',
  ),
  stateFrApproval(
    'UT',
    'warrant',
    'Utah face-recognition statute',
    'A warrant is required before a government entity may run a face-recognition search.',
  ),
  stateFrApproval(
    'ME',
    'probable-cause',
    'Maine face-surveillance statute',
    'Probable cause and a documented serious-offence basis are required before an FR search.',
  ),
  stateFrApproval(
    'MA',
    'court-order',
    'Massachusetts face-recognition statute',
    'A court order is required before a law-enforcement FR search, with a written request trail.',
  ),

  notSoleBasis('AL', 'Alabama face-recognition statute'),
  notSoleBasis('CO', 'Colorado face-recognition statute'),
  notSoleBasis('ME', 'Maine face-surveillance statute'),
  notSoleBasis('MT', 'Montana face-recognition statute'),
  notSoleBasis('UT', 'Utah face-recognition statute'),
  notSoleBasis('VA', 'Virginia face-recognition statute'),
  notSoleBasis('WA', 'Washington face-recognition statute'),
  notSoleBasis('MD', 'Maryland face-recognition statute'),

  // ---------------------------------------------------------------------------
  // Illinois BIPA — the only entry with a private right of action
  //
  // This is why it denies for private parties and not just agencies. BIPA lets
  // an individual sue directly, statutory damages per violation, and collecting a
  // face template without written informed consent is the violation. There is no
  // version of MATCH that is safe to offer an Illinois customer, and no contract
  // clause that fixes it, because the plaintiff is not our counterparty.
  //
  // Geo-gate anything biometric out of Illinois. Full stop.
  // ---------------------------------------------------------------------------
  {
    state: 'IL',
    classes: ['biometric-face'],
    appliesTo: ALL_CUSTOMERS,
    effect: { kind: 'deny' },
    citation: {
      kind: 'biometric-private-right-of-action',
      authority: 'Illinois Biometric Information Privacy Act (740 ILCS 14)',
      summary:
        'BIPA carries a private right of action with per-violation statutory damages. Collecting ' +
        'or storing a face template without written informed consent is actionable by the ' +
        'individual, who is not a party to any contract we can write.',
      verifiedOn: VERIFIED,
    },
  },

  // ---------------------------------------------------------------------------
  // Private ALPR — defence in depth only; Lantage ships no ALPR (see the
  // product-boundary rule at the top, which already denies this everywhere).
  // ---------------------------------------------------------------------------
  alpr('NH', true, 'New Hampshire ALPR statute'),
  alpr('ME', true, 'Maine ALPR statute'),
  alpr('VT', false, 'Vermont ALPR statute'),
  alpr('AR', false, 'Arkansas ALPR statute'),
  alpr('UT', false, 'Utah ALPR statute'),
  alpr('MN', false, 'Minnesota ALPR statute'),
  alpr('CA', false, 'California ALPR statute (Civil Code §1798.90.5 et seq.)'),
];

/**
 * Jurisdictions known to have relevant law that this table does NOT yet encode.
 * Surfaced by `unverifiedJurisdictionWarning()` so a sale into one of these is a
 * conscious decision rather than a silent gap.
 *
 * Texas CUBI and Washington's biometric statute are the notable ones: both
 * regulate biometric identifiers commercially but are attorney-general enforced
 * rather than carrying a private right of action, so their effect on MATCH is a
 * legal question rather than a lookup. Do not guess it in code — get counsel.
 */
export const NEEDS_LEGAL_REVIEW_BEFORE_SALE: readonly string[] = [
  'TX', // Capture or Use of Biometric Identifier Act
  'WA', // RCW 19.375 biometric identifiers, plus My Health My Data
  'CO', // biometric amendments to the Colorado Privacy Act
  'OR', // consumer privacy act biometric provisions
  'NY', // New York City biometric identifier ordinance (commercial establishments)
];
