/**
 * Jurisdiction gating — the resolver.
 *
 * `isModuleAllowed(capability, jurisdiction, opts)` is the only entry point.
 * It returns allow-or-deny **with the cited reason**, because a block that
 * cannot tell the analyst which ordinance blocked it is indistinguishable from a
 * bug, and because the person who has to answer for it in a deposition is the
 * customer, not us.
 *
 * See `policies.ts` for the table and the standing warning that it goes stale.
 */

import type { ModuleId } from '@/lib/contracts/types';
import type { CustomerType } from '@/lib/auth/types';
import { JURISDICTION_RULES, NEEDS_LEGAL_REVIEW_BEFORE_SALE } from './policies';
import {
  CAPABILITY_CLASS,
  PERMANENTLY_UNAVAILABLE,
  REQUIRES_EXPLICIT_ENABLEMENT,
  type ApprovalKind,
  type GatedCapability,
  type Jurisdiction,
  type JurisdictionApprovals,
  type JurisdictionRule,
  type LegalCitation,
  type ModuleBlocked,
  type ModuleDecision,
  type OperatingConstraint,
} from './types';

export * from './types';
export { JURISDICTION_RULES, NEEDS_LEGAL_REVIEW_BEFORE_SALE } from './policies';
export { jurisdictionForOrg, parseJurisdiction, formatJurisdiction } from './assignment';

export interface ModuleGateOptions {
  /** Defaults to `'government-agency'` — the most restricted reading. See below. */
  readonly customerType?: CustomerType;
  /** Approvals the org has actually obtained. A claim is not an approval. */
  readonly approvals?: JurisdictionApprovals;
  /** Contractually disabled modules, from `Org.disabledModules`. */
  readonly disabledModules?: readonly string[];
  /**
   * Modules the contract explicitly turns on. Only consulted for capabilities in
   * `REQUIRES_EXPLICIT_ENABLEMENT` — everything else is governed by law and the
   * denylist above.
   */
  readonly enabledModules?: readonly string[];
}

/**
 * Is this capability permitted for this org, here?
 *
 * Fails closed in three places, all deliberate:
 *
 * 1. **Unknown jurisdiction** (no state) denies. We cannot evaluate a patchwork
 *    of municipal ordinances against `undefined`.
 * 2. **Unknown customer type** is treated as `government-agency`, the most
 *    restricted reading. Guessing "probably a private company" here is how an
 *    agency gets handed a module its council banned.
 * 3. **`require-approval` with no recorded approval** denies, and the refusal
 *    names the missing approval. A CCOPS city is a winnable deal, not a blocked
 *    one — it just needs the Surveillance Impact Report on file first.
 */
export function isModuleAllowed(
  capability: GatedCapability,
  jurisdiction: Jurisdiction | undefined,
  opts: ModuleGateOptions = {},
): ModuleDecision {
  const customerType: CustomerType = opts.customerType ?? 'government-agency';

  // --- capabilities that do not exist and never will ------------------------
  if (PERMANENTLY_UNAVAILABLE.includes(capability)) {
    return {
      allowed: false,
      capability,
      jurisdiction: jurisdiction ?? { state: '' },
      headline: `${capability} NOT AVAILABLE`,
      summary: 'This capability is outside Lantage’s product boundary and is not built.',
      reasons: [
        {
          kind: 'product-boundary',
          authority: 'Lantage product boundary (MASTER_PLAN §7)',
          summary:
            capability === 'ALPR'
              ? 'Lantage performs no licence-plate recognition, anywhere, for anyone.'
              : 'Lantage maintains no internet-scraped face index, ever. MATCH is closed-gallery only.',
          verifiedOn: '2026-07-29',
        },
      ],
    };
  }

  // --- contract, before law ------------------------------------------------
  if (opts.disabledModules?.includes(capability)) {
    return {
      allowed: false,
      capability,
      jurisdiction: jurisdiction ?? { state: '' },
      headline: `${capability} DISABLED FOR THIS ACCOUNT`,
      summary: 'This module is not enabled on your contract.',
      reasons: [
        {
          kind: 'contract',
          authority: 'Customer agreement',
          summary: `${capability} is not among the modules enabled for this organisation.`,
          verifiedOn: '2026-07-29',
        },
      ],
      remedy: 'Contact your Lantage account contact to add this module to the agreement.',
    };
  }

  // --- unknown jurisdiction fails closed ------------------------------------
  if (!jurisdiction || jurisdiction.state.trim().length === 0) {
    return {
      allowed: false,
      capability,
      jurisdiction: jurisdiction ?? { state: '' },
      headline: `${capability} BLOCKED — JURISDICTION NOT SET`,
      summary:
        'No operating jurisdiction is recorded for this organisation, so the applicable ' +
        'municipal and state restrictions cannot be evaluated.',
      reasons: [
        {
          kind: 'contract',
          authority: 'Lantage jurisdiction gating',
          summary:
            'Module availability depends on the customer’s city and state. With neither ' +
            'recorded, the gate denies rather than guessing.',
          verifiedOn: '2026-07-29',
        },
      ],
      remedy: 'An administrator must record the operating city and state for this organisation.',
    };
  }

  const capabilityClass = CAPABILITY_CLASS[capability];
  const matched = JURISDICTION_RULES.filter(
    (rule) =>
      rule.classes.includes(capabilityClass) &&
      rule.appliesTo.includes(customerType) &&
      matchesJurisdiction(rule, jurisdiction),
  );

  const denials = matched.filter((r) => r.effect.kind === 'deny');
  const approvalsNeeded = matched.filter(
    (r): r is JurisdictionRule & { effect: { kind: 'require-approval'; approval: ApprovalKind } } =>
      r.effect.kind === 'require-approval',
  );
  const constraintRules = matched.filter((r) => r.effect.kind === 'constrain');

  // --- outright denials win ------------------------------------------------
  if (denials.length > 0) {
    return {
      allowed: false,
      capability,
      jurisdiction,
      headline: `${capability} BLOCKED — ${formatPlace(jurisdiction)}`,
      summary: denials[0]!.citation.summary,
      reasons: denials.map((r) => r.citation),
      // No remedy. A municipal ban and a private right of action are not
      // paperwork problems, and offering a workaround here would be misleading.
    };
  }

  // --- opt-in modules stay off until the contract says otherwise ------------
  //
  // Checked AFTER the legal denials on purpose. If MATCH is unlawful here, the
  // analyst — and whoever is reading over their shoulder — should be told that,
  // not handed a contract flag that invites someone to go and flip it.
  if (
    REQUIRES_EXPLICIT_ENABLEMENT.includes(capability) &&
    !opts.enabledModules?.includes(capability)
  ) {
    return {
      allowed: false,
      capability,
      jurisdiction,
      headline: `${capability} NOT ENABLED`,
      summary: `${capability} is gated and is not enabled for this organisation.`,
      reasons: [
        {
          kind: 'contract',
          authority: 'Lantage gating policy (MASTER_PLAN §1, §7 — the CJIS fork)',
          summary:
            'Closed-gallery 1:N matching is enabled per contract only, after the CJIS scoping ' +
            'analysis is confirmed in writing by the state CSA. A gallery sourced from a state ' +
            'ID bureau or the FBI is Criminal Justice Information, which this stack cannot host.',
          verifiedOn: '2026-07-29',
        },
      ],
      remedy:
        'Requires a signed module addendum and a written CJIS scoping determination for the ' +
        'gallery in question.',
    };
  }

  // --- approvals: denied only until the approval is on file ------------------
  const unsatisfied = approvalsNeeded.filter(
    (r) => !approvalSatisfied(r.effect.approval, opts.approvals),
  );
  if (unsatisfied.length > 0) {
    return {
      allowed: false,
      capability,
      jurisdiction,
      headline: `${capability} REQUIRES APPROVAL — ${formatPlace(jurisdiction)}`,
      summary: unsatisfied[0]!.citation.summary,
      reasons: unsatisfied.map((r) => r.citation),
      remedy: remedyFor(unsatisfied.map((r) => r.effect.approval)),
    };
  }

  // --- allowed, possibly with conditions -----------------------------------
  const constraints: OperatingConstraint[] = [];
  const notices: LegalCitation[] = [];

  for (const rule of constraintRules) {
    if (rule.effect.kind !== 'constrain') continue;
    if (!constraints.includes(rule.effect.constraint)) constraints.push(rule.effect.constraint);
    notices.push(rule.citation);
  }

  // Approvals that WERE satisfied still get cited — the analyst should see the
  // authority they are operating under, and a defence expert will ask for it.
  for (const rule of approvalsNeeded) notices.push(rule.citation);

  // The Detroit standard applies product-wide, not only where a statute codifies
  // it. `canConfirm()` in src/lib/audit/corroboration.ts is what enforces it.
  if (!constraints.includes('documented-corroboration-required')) {
    constraints.push('documented-corroboration-required');
  }

  return { allowed: true, capability, jurisdiction, constraints, notices };
}

/**
 * Boolean form, for B2's `AuthGate.isModuleAllowed(module, jurisdiction)`.
 *
 * Use the rich form everywhere you can render the reason. This exists because the
 * cascade's dependency interface is a predicate, and losing the citation at that
 * boundary is acceptable only because `/api/search` refuses before the cascade
 * runs — the analyst sees the cited refusal from `canSearch`, not from here.
 */
export function isModulePermitted(
  capability: GatedCapability,
  jurisdiction: Jurisdiction | undefined,
  opts: ModuleGateOptions = {},
): boolean {
  return isModuleAllowed(capability, jurisdiction, opts).allowed;
}

/** Every module the org may use here. Drives which tiles the workbench renders. */
export function allowedModules(
  jurisdiction: Jurisdiction | undefined,
  opts: ModuleGateOptions = {},
): ModuleId[] {
  const all: ModuleId[] = ['GEO', 'STREET', 'VEHICLE', 'VERIFY', 'CLAIM', 'MATCH'];
  return all.filter((m) => isModuleAllowed(m, jurisdiction, opts).allowed);
}

/**
 * True when this state has law we know about but have not encoded. Not a block —
 * a prompt to get counsel before the contract is signed.
 */
export function unverifiedJurisdictionWarning(jurisdiction: Jurisdiction | undefined): string | null {
  if (!jurisdiction) return null;
  if (!NEEDS_LEGAL_REVIEW_BEFORE_SALE.includes(jurisdiction.state.toUpperCase())) return null;
  return (
    `${jurisdiction.state.toUpperCase()} has biometric or surveillance law that the ` +
    `jurisdiction table does not yet encode. Get counsel before selling a biometric ` +
    `module into this state.`
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function matchesJurisdiction(rule: JurisdictionRule, j: Jurisdiction): boolean {
  if (rule.state !== '*' && rule.state.toUpperCase() !== j.state.toUpperCase()) return false;
  if (rule.city && !eqLoose(rule.city, j.city)) return false;
  if (rule.county && !eqLoose(rule.county, j.county)) return false;
  return true;
}

/**
 * Case- and suffix-insensitive place comparison. "Santa Clara County" in the org
 * record must match a rule keyed "Santa Clara", and "St. Louis" must match
 * "St Louis" — municipal names are entered by humans at contract time.
 */
function eqLoose(a: string, b: string | undefined): boolean {
  if (!b) return false;
  return normalisePlace(a) === normalisePlace(b);
}

function normalisePlace(v: string): string {
  return v
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\b(county|city|township|borough|town of|city of)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function approvalSatisfied(kind: ApprovalKind, approvals: JurisdictionApprovals | undefined): boolean {
  if (!approvals) return false;
  switch (kind) {
    case 'ccops-sir':
      return Boolean(approvals.ccopsSir?.reference);
    case 'warrant':
      return Boolean(approvals.warrant?.reference);
    case 'court-order':
      return Boolean(approvals.courtOrder?.reference);
    case 'probable-cause':
      return Boolean(approvals.probableCause?.note);
  }
}

function remedyFor(kinds: readonly ApprovalKind[]): string {
  const parts: string[] = [];
  if (kinds.includes('ccops-sir')) {
    parts.push(
      'a council-approved Surveillance Impact Report on file for this jurisdiction (Lantage ' +
        'co-authors these)',
    );
  }
  if (kinds.includes('warrant')) parts.push('a recorded warrant reference for this search');
  if (kinds.includes('court-order')) parts.push('a recorded court-order reference');
  if (kinds.includes('probable-cause')) parts.push('a recorded probable-cause basis');
  return `This module unlocks with ${parts.join(', and ')}.`;
}

function formatPlace(j: Jurisdiction): string {
  // The county field is entered by a human at contract time and may or may not
  // already carry the word "County", so it is stripped before being re-added.
  const county = j.county ? `${j.county.replace(/\s+county\s*$/i, '')} County` : null;
  const where = j.city ?? county;
  return (where ? `${where}, ${j.state}` : j.state).toUpperCase();
}

/** Narrowing helper for callers that only handle the block case. */
export function blockedOrNull(d: ModuleDecision): ModuleBlocked | null {
  return d.allowed ? null : d;
}
