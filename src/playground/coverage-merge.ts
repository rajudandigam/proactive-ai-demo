/**
 * Version-bound coverage merge.
 *
 * Inventory generation discovers symbols/packages; it never produces executed
 * coverage. Executed evidence (passed/failed) lives on a ledger row together with
 * the input revision it was recorded under. Regeneration merges the previous
 * ledger onto the freshly discovered rows:
 *
 * - same revision + artifacts present  -> evidence preserved verbatim
 * - changed/unknown revision           -> row marked `stale`, evidence kept
 * - artifact missing                   -> row marked `stale`, evidence kept
 * - symbol/package gone                -> retired (`stale`), evidence kept
 * - passed/failed without links        -> rejected, never trusted
 *
 * Discovery alone can never yield `passed` or `failed`.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, normalize, sep } from 'node:path';

export type CoverageStatus =
  | 'planned'
  | 'implemented-unverified'
  | 'passed'
  | 'failed'
  | 'unsupported'
  | 'stale'
  | 'blocked';

export type ExecutedStatus = 'passed' | 'failed';

export interface EvidenceRecord {
  status: ExecutedStatus;
  revision: string | null;
  testIds: string[];
  executedEvidence: string[];
  /** Why this record left the active row (e.g. superseded, rejected). */
  reason: string;
}

export interface CoverageRowBase {
  id: string;
  status: CoverageStatus;
  testIds: string[];
  executedEvidence: string[];
  /** Input revision id the executed evidence was recorded under. */
  evidenceRevision?: string | null;
  /** Executed outcome retained while a row is stale. */
  lastExecutedStatus?: ExecutedStatus | null;
  statusReason?: string | null;
  evidenceHistory?: EvidenceRecord[];
}

export interface InputRevision {
  id: string;
  agentInspectVersion: string;
  packageLockIntegrity: string | null;
  packageJsonSha256: string | null;
}

export interface MergeContext {
  revision: InputRevision;
  /** Revision id of the previous ledger; fallback for rows lacking evidenceRevision. */
  previousLedgerRevisionId: string | null;
  /** Returns true when the evidence link resolves to an existing artifact. */
  artifactExists: (link: string) => boolean;
}

export function computeInputRevision(input: {
  agentInspectVersion: string;
  packageLockIntegrity: string | null;
  packageJsonSha256: string | null;
}): InputRevision {
  const canonical = JSON.stringify([
    input.agentInspectVersion,
    input.packageLockIntegrity,
    input.packageJsonSha256,
  ]);
  return {
    id: createHash('sha256').update(canonical).digest('hex'),
    agentInspectVersion: input.agentInspectVersion,
    packageLockIntegrity: input.packageLockIntegrity,
    packageJsonSha256: input.packageJsonSha256,
  };
}

/** Derive the revision a legacy ledger was generated under from its agentInspect block. */
export function revisionIdFromLedger(ledger: {
  inputRevision?: { id?: string } | null;
  agentInspect?: {
    installedVersion?: string;
    packageLockIntegrity?: string | null;
    tarballSha256OfPackageJson?: string | null;
  };
}): string | null {
  if (ledger.inputRevision?.id) return ledger.inputRevision.id;
  const ai = ledger.agentInspect;
  if (!ai?.installedVersion) return null;
  return computeInputRevision({
    agentInspectVersion: ai.installedVersion,
    packageLockIntegrity: ai.packageLockIntegrity ?? null,
    packageJsonSha256: ai.tarballSha256OfPackageJson ?? null,
  }).id;
}

/** Evidence links must be repo-relative and must not traverse outside the root. */
export function isSafeEvidenceLink(link: string): boolean {
  if (!link || isAbsolute(link) || link.includes('\0')) return false;
  const norm = normalize(link);
  return norm !== '..' && !norm.startsWith(`..${sep}`);
}

function executedClaim(row: CoverageRowBase): ExecutedStatus | null {
  if (row.status === 'passed' || row.status === 'failed') return row.status;
  if (
    row.status === 'stale' &&
    (row.lastExecutedStatus === 'passed' || row.lastExecutedStatus === 'failed')
  ) {
    return row.lastExecutedStatus;
  }
  return null;
}

function hasProof(row: CoverageRowBase): boolean {
  return (
    Array.isArray(row.executedEvidence) &&
    row.executedEvidence.length > 0 &&
    row.executedEvidence.every((l) => typeof l === 'string')
  );
}

function staleRow<T extends CoverageRowBase>(
  discovered: T,
  prev: CoverageRowBase,
  claim: ExecutedStatus,
  reason: string,
): T {
  return {
    ...discovered,
    status: 'stale',
    testIds: [...prev.testIds],
    executedEvidence: [...prev.executedEvidence],
    evidenceRevision: prev.evidenceRevision ?? null,
    lastExecutedStatus: claim,
    statusReason: reason,
    evidenceHistory: [...(prev.evidenceHistory ?? [])],
  };
}

/**
 * Merge one freshly discovered row with its previous ledger row.
 * `discovered.status` is only ever a discovery status (never passed/failed).
 */
export function mergeCoverageRow<T extends CoverageRowBase>(
  discovered: T,
  prev: CoverageRowBase | undefined,
  ctx: MergeContext,
): T {
  const base: T = {
    ...discovered,
    testIds: [...(discovered.testIds ?? [])],
    executedEvidence: [...(discovered.executedEvidence ?? [])],
    evidenceRevision: null,
    lastExecutedStatus: null,
    statusReason: discovered.statusReason ?? null,
    evidenceHistory: [...(prev?.evidenceHistory ?? [])],
  };
  if (base.status === 'passed' || base.status === 'failed') {
    base.status = 'implemented-unverified';
  }
  if (!prev) return base;

  const claim = executedClaim(prev);
  if (!claim) return base;

  if (!hasProof(prev)) {
    base.statusReason = `rejected-${claim}-without-evidence`;
    base.evidenceHistory!.push({
      status: claim,
      revision: prev.evidenceRevision ?? null,
      testIds: [...(prev.testIds ?? [])],
      executedEvidence: [],
      reason: base.statusReason,
    });
    return base;
  }

  if (discovered.status === 'blocked') {
    return staleRow(base, prev, claim, 'package-not-installed');
  }
  if (discovered.status === 'unsupported') {
    return staleRow(base, prev, claim, 'discovery-unsupported');
  }

  const prevRevision = prev.evidenceRevision ?? ctx.previousLedgerRevisionId;
  if (prevRevision !== ctx.revision.id) {
    return staleRow(
      base,
      prev,
      claim,
      prevRevision
        ? `revision-changed:${prevRevision.slice(0, 12)}->${ctx.revision.id.slice(0, 12)}`
        : 'revision-unrecorded',
    );
  }

  const missing = prev.executedEvidence.filter(
    (l) => !isSafeEvidenceLink(l) || !ctx.artifactExists(l),
  );
  if (missing.length) {
    return staleRow(base, prev, claim, `artifact-missing:${missing.join(',')}`);
  }

  return {
    ...base,
    status: claim,
    testIds: [...prev.testIds],
    executedEvidence: [...prev.executedEvidence],
    evidenceRevision: prevRevision,
    lastExecutedStatus: claim,
    statusReason: null,
  };
}

export interface MergeInput<S extends CoverageRowBase, P extends CoverageRowBase> {
  symbols: S[];
  packages: P[];
  previous: {
    symbols?: CoverageRowBase[];
    packages?: CoverageRowBase[];
    retiredSymbols?: CoverageRowBase[];
  } | null;
  ctx: MergeContext;
}

export interface MergeResult<S extends CoverageRowBase, P extends CoverageRowBase> {
  symbols: S[];
  packages: P[];
  retiredSymbols: CoverageRowBase[];
}

export function mergeCoverageLedger<S extends CoverageRowBase, P extends CoverageRowBase>(
  input: MergeInput<S, P>,
): MergeResult<S, P> {
  const { ctx } = input;
  const prevSymbols = new Map<string, CoverageRowBase>();
  for (const r of input.previous?.retiredSymbols ?? []) prevSymbols.set(r.id, r);
  for (const r of input.previous?.symbols ?? []) prevSymbols.set(r.id, r);
  const prevPackages = new Map(
    (input.previous?.packages ?? []).map((r) => [r.id, r] as const),
  );

  const symbols = input.symbols.map((r) => mergeCoverageRow(r, prevSymbols.get(r.id), ctx));
  const packages = input.packages.map((r) => mergeCoverageRow(r, prevPackages.get(r.id), ctx));

  const discoveredIds = new Set(input.symbols.map((s) => s.id));
  const retiredSymbols: CoverageRowBase[] = [];
  for (const prev of prevSymbols.values()) {
    if (discoveredIds.has(prev.id)) continue;
    const claim = executedClaim(prev);
    if (!claim) continue; // nothing executed -> nothing to preserve
    if (!hasProof(prev)) continue;
    retiredSymbols.push(
      staleRow({ ...prev, status: 'stale' } as CoverageRowBase, prev, claim, 'symbol-removed'),
    );
  }
  retiredSymbols.sort((a, b) => a.id.localeCompare(b.id));
  return { symbols, packages, retiredSymbols };
}

export function countStatuses(rows: Array<{ status: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

/**
 * Record a fresh executed result on a row (used by evidence marking).
 * Same-revision evidence is merged; evidence from another revision is moved to
 * history instead of being unioned into the new result.
 */
export function recordExecutedEvidence<T extends CoverageRowBase>(
  row: T,
  result: {
    status: ExecutedStatus;
    revisionId: string;
    testIds: string[];
    executedEvidence: string[];
  },
): T {
  const history = [...(row.evidenceHistory ?? [])];
  const priorClaim = executedClaim(row);
  const sameRevision = priorClaim !== null && row.evidenceRevision === result.revisionId;
  if (priorClaim && hasProof(row) && !sameRevision) {
    history.push({
      status: priorClaim,
      revision: row.evidenceRevision ?? null,
      testIds: [...row.testIds],
      executedEvidence: [...row.executedEvidence],
      reason: 'superseded-by-new-revision',
    });
  }
  const union = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));
  return {
    ...row,
    status: result.status,
    testIds: sameRevision ? union(row.testIds, result.testIds) : [...result.testIds],
    executedEvidence: sameRevision
      ? union(row.executedEvidence, result.executedEvidence)
      : [...result.executedEvidence],
    evidenceRevision: result.revisionId,
    lastExecutedStatus: result.status,
    statusReason: null,
    evidenceHistory: history,
  };
}
