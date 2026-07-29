/**
 * Public surface of the audit trail.
 *
 * The physical INSERT lives in A2's `writeAudit` (`src/lib/db/queries/audit.ts`).
 * This module owns the vocabulary, the wrapper that makes skipping the write hard,
 * the corroboration workflow, and the discovery read path.
 *
 * Start here:
 *   withAudit          — wrap an action so it is recorded before it runs
 *   auditRefusal       — record a denial (a refusal is a row too)
 *   canConfirm         — the Detroit corroboration gate
 *   recordCorroboration
 *   discoveryBundleForImage — "every search that touched this image"
 */

export * from './types';
export * from './log';
export * from './with-audit';
export * from './corroboration';
export * from './discovery';
export { cascadeAuditWriter } from './cascade';
