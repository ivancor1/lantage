/**
 * Where an org's jurisdiction and customer type come from.
 *
 * TODO(A2): these belong on the `orgs` table —
 * `customer_type`, `jurisdiction_state`, `jurisdiction_city`,
 * `jurisdiction_county`, `disabled_modules`, and a `ccops_sir_reference`. The
 * table currently carries only `id`, `name`, `created_at`, so until those columns
 * exist the classification comes from deployment config and this module is the
 * single place that reads it. `orgFromRow` in `src/lib/auth/types.ts` takes the
 * classification as an argument specifically so that swapping config for columns
 * touches one call site.
 *
 * Config, not inference. Never derive a customer type from an email domain: a
 * detective with a gmail address is still a government agency, and a claims
 * adjuster at a city-owned insurer is not.
 */

import { z } from 'zod';

import { CUSTOMER_TYPES, type CustomerType, type OrgJurisdiction } from '@/lib/auth/types';
import type { JurisdictionApprovals } from './types';

export interface OrgClassification {
  readonly customerType: CustomerType;
  readonly jurisdiction: OrgJurisdiction;
  readonly disabledModules: readonly string[];
  /** Opt-in modules — currently only MATCH. See `REQUIRES_EXPLICIT_ENABLEMENT`. */
  readonly enabledModules: readonly string[];
  readonly approvals: JurisdictionApprovals;
}

const ClassificationSchema = z.object({
  customerType: z.enum(CUSTOMER_TYPES),
  state: z.string().length(2),
  city: z.string().min(1).optional(),
  county: z.string().min(1).optional(),
  disabledModules: z.array(z.string()).optional(),
  enabledModules: z.array(z.string()).optional(),
  ccopsSirReference: z.string().min(1).optional(),
  ccopsSirApprovedOn: z.string().min(1).optional(),
});

const ConfigSchema = z.record(z.string(), ClassificationSchema);

/**
 * `LANTAGE_ORG_JURISDICTIONS` — JSON keyed by org id. Server-only.
 *
 *   {"<org-uuid>":{"customerType":"insurance-siu","state":"PA","city":"Pittsburgh"}}
 *
 * Parsed once. A malformed value throws at first use rather than silently
 * degrading to the fail-closed default, because a typo that quietly blocks every
 * module for a paying customer is worse than a loud startup error.
 */
let cache: z.infer<typeof ConfigSchema> | null = null;
let cacheSource: string | undefined;

function config(): z.infer<typeof ConfigSchema> {
  const raw = process.env.LANTAGE_ORG_JURISDICTIONS;
  if (cache && cacheSource === raw) return cache;
  if (!raw) {
    cache = {};
    cacheSource = raw;
    return cache;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error(
      'LANTAGE_ORG_JURISDICTIONS is not valid JSON. Expected an object keyed by org id, ' +
        'e.g. {"<org-uuid>":{"customerType":"insurance-siu","state":"PA","city":"Pittsburgh"}}',
    );
  }

  const result = ConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(
      `LANTAGE_ORG_JURISDICTIONS failed validation: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }

  cache = result.data;
  cacheSource = raw;
  return cache;
}

/**
 * Classification for one org.
 *
 * An unconfigured org gets `government-agency` with no jurisdiction, which
 * `isModuleAllowed` denies for everything. That is the intended default: a new
 * org has no modules until someone records who they are and where they operate.
 */
export function jurisdictionForOrg(orgId: string | null | undefined): OrgClassification {
  const entry = orgId ? config()[orgId] : undefined;

  if (!entry) {
    return {
      customerType: 'government-agency',
      jurisdiction: { state: '' },
      disabledModules: [],
      enabledModules: [],
      approvals: {},
    };
  }

  const approvals: JurisdictionApprovals = entry.ccopsSirReference
    ? {
        ccopsSir: {
          reference: entry.ccopsSirReference,
          approvedOn: entry.ccopsSirApprovedOn ?? 'unrecorded',
        },
      }
    : {};

  return {
    customerType: entry.customerType,
    jurisdiction: {
      state: entry.state.toUpperCase(),
      city: entry.city,
      county: entry.county,
    },
    disabledModules: entry.disabledModules ?? [],
    enabledModules: entry.enabledModules ?? [],
    approvals,
  };
}

// ---------------------------------------------------------------------------
// String form — for interfaces that pass jurisdiction as an opaque string
// ---------------------------------------------------------------------------

/**
 * Canonical string form: `"PA"`, `"PA/Pittsburgh"`, `"WA//King"` (county only).
 *
 * B2's `SearchPrincipal.jurisdiction` is a `string | undefined`, so the value has
 * to survive a round trip through a plain string without losing the city — a
 * state-only jurisdiction would silently unblock every CCOPS city, which is the
 * exact failure this module exists to prevent.
 */
export function formatJurisdiction(j: OrgJurisdiction | undefined): string | undefined {
  if (!j || j.state.length === 0) return undefined;
  const state = j.state.toUpperCase();
  if (!j.city && !j.county) return state;
  return `${state}/${j.city ?? ''}${j.county ? `/${j.county}` : ''}`;
}

/**
 * Parses the canonical form, and tolerates the shapes a human would type:
 * `"PA"`, `"US-PA"`, `"PA/Pittsburgh"`, `"Pittsburgh, PA"`.
 *
 * Returns `undefined` rather than a partial guess when the state cannot be
 * identified — `isModuleAllowed` denies on `undefined`, which is the safe end.
 */
export function parseJurisdiction(value: string | undefined | null): OrgJurisdiction | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  // "Pittsburgh, PA"
  const comma = /^(.+),\s*(?:US-)?([A-Za-z]{2})$/.exec(trimmed);
  if (comma) return { state: comma[2]!.toUpperCase(), city: comma[1]!.trim() };

  const parts = trimmed.replace(/^US-/i, '').split('/');
  const state = parts[0]?.trim();
  if (!state || state.length !== 2) return undefined;

  const city = parts[1]?.trim();
  const county = parts[2]?.trim();
  return {
    state: state.toUpperCase(),
    city: city && city.length > 0 ? city : undefined,
    county: county && county.length > 0 ? county : undefined,
  };
}
