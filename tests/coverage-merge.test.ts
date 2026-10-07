import { describe, expect, it } from 'vitest';
import {
  computeInputRevision,
  isSafeEvidenceLink,
  mergeCoverageLedger,
  mergeCoverageRow,
  recordExecutedEvidence,
  revisionIdFromLedger,
  type CoverageRowBase,
  type MergeContext,
} from '../src/playground/coverage-merge';

const REV_A = computeInputRevision({
  agentInspectVersion: '6.31.16',
  packageLockIntegrity: 'sha512-aaa',
  packageJsonSha256: 'a'.repeat(64),
});
const REV_B = computeInputRevision({
  agentInspectVersion: '6.31.17',
  packageLockIntegrity: 'sha512-bbb',
  packageJsonSha256: 'b'.repeat(64),
});
const LINK = 'artifacts/batch-1/suite-summary.json';

function ctx(
  revision = REV_A,
  existing: string[] = [LINK],
  previousLedgerRevisionId: string | null = REV_A.id,
): MergeContext {
  return {
    revision,
    previousLedgerRevisionId,
    artifactExists: (l) => existing.includes(l),
  };
}

function discovered(id: string, status: CoverageRowBase['status'] = 'implemented-unverified') {
  return { id, status, testIds: [] as string[], executedEvidence: [] as string[] };
}

function passedRow(id: string, extra: Partial<CoverageRowBase> = {}): CoverageRowBase {
  return {
    id,
    status: 'passed',
    testIds: ['lab:suite:travel-core'],
    executedEvidence: [LINK],
    evidenceRevision: REV_A.id,
    ...extra,
  };
}

describe('coverage merge (version-bound executed evidence)', () => {
  it('preserves a passed row with links across same-revision regeneration', () => {
    const merged = mergeCoverageRow(
      discovered('export:agent-inspect:step'),
      passedRow('export:agent-inspect:step'),
      ctx(),
    );
    expect(merged.status).toBe('passed');
    expect(merged.executedEvidence).toEqual([LINK]);
    expect(merged.testIds).toEqual(['lab:suite:travel-core']);
    expect(merged.evidenceRevision).toBe(REV_A.id);
  });

  it('is idempotent across repeated regeneration', () => {
    const first = mergeCoverageLedger({
      symbols: [discovered('s1')],
      packages: [],
      previous: { symbols: [passedRow('s1')] },
      ctx: ctx(),
    });
    const second = mergeCoverageLedger({
      symbols: [discovered('s1')],
      packages: [],
      previous: first,
      ctx: ctx(),
    });
    expect(second).toEqual(first);
  });

  it('treats legacy rows without evidenceRevision as bound to the previous ledger revision', () => {
    const legacy = passedRow('s1');
    delete legacy.evidenceRevision;
    expect(mergeCoverageRow(discovered('s1'), legacy, ctx()).status).toBe('passed');
    const changed = mergeCoverageRow(
      discovered('s1'),
      legacy,
      ctx(REV_B, [LINK], REV_A.id),
    );
    expect(changed.status).toBe('stale');
  });

  it('marks changed-revision evidence stale without erasing links or outcome', () => {
    const prev = passedRow('s1', {
      evidenceHistory: [
        {
          status: 'passed',
          revision: 'older',
          testIds: ['t'],
          executedEvidence: ['artifacts/old.json'],
          reason: 'superseded-by-new-revision',
        },
      ],
    });
    const merged = mergeCoverageRow(discovered('s1'), prev, ctx(REV_B));
    expect(merged.status).toBe('stale');
    expect(merged.lastExecutedStatus).toBe('passed');
    expect(merged.executedEvidence).toEqual([LINK]);
    expect(merged.testIds).toEqual(['lab:suite:travel-core']);
    expect(merged.evidenceRevision).toBe(REV_A.id);
    expect(merged.statusReason).toMatch(/^revision-changed:/);
    expect(merged.evidenceHistory).toHaveLength(1);
  });

  it('keeps stale rows stale across regenerations and restores when the revision returns', () => {
    const stale = mergeCoverageRow(discovered('s1'), passedRow('s1'), ctx(REV_B));
    const again = mergeCoverageRow(discovered('s1'), stale, ctx(REV_B));
    expect(again.status).toBe('stale');
    expect(again.executedEvidence).toEqual([LINK]);
    const restored = mergeCoverageRow(discovered('s1'), stale, ctx(REV_A));
    expect(restored.status).toBe('passed');
    expect(restored.statusReason).toBeNull();
  });

  it('marks evidence stale (kept) when the artifact is missing', () => {
    const merged = mergeCoverageRow(discovered('s1'), passedRow('s1'), ctx(REV_A, []));
    expect(merged.status).toBe('stale');
    expect(merged.executedEvidence).toEqual([LINK]);
    expect(merged.statusReason).toBe(`artifact-missing:${LINK}`);
  });

  it('rejects traversal / absolute evidence links as missing', () => {
    expect(isSafeEvidenceLink('artifacts/x.json')).toBe(true);
    expect(isSafeEvidenceLink('../secret')).toBe(false);
    expect(isSafeEvidenceLink('/etc/passwd')).toBe(false);
    expect(isSafeEvidenceLink('')).toBe(false);
    const prev = passedRow('s1', { executedEvidence: ['../outside.json'] });
    const merged = mergeCoverageRow(discovered('s1'), prev, {
      ...ctx(),
      artifactExists: () => true,
    });
    expect(merged.status).toBe('stale');
  });

  it('never passes on export presence alone', () => {
    const noLinks = passedRow('s1', { executedEvidence: [] });
    const merged = mergeCoverageRow(discovered('s1'), noLinks, ctx());
    expect(merged.status).toBe('implemented-unverified');
    expect(merged.executedEvidence).toEqual([]);
    expect(merged.statusReason).toBe('rejected-passed-without-evidence');
    expect(merged.evidenceHistory).toHaveLength(1);

    const forged = mergeCoverageRow(
      { ...discovered('s2'), status: 'passed' as const },
      undefined,
      ctx(),
    );
    expect(forged.status).toBe('implemented-unverified');
    const planned = mergeCoverageRow(discovered('s3', 'planned'), undefined, ctx());
    expect(planned.status).toBe('planned');
  });

  it('preserves failed outcomes and never upgrades them', () => {
    const failed = passedRow('s1', { status: 'failed' });
    expect(mergeCoverageRow(discovered('s1'), failed, ctx()).status).toBe('failed');
    const stale = mergeCoverageRow(discovered('s1'), failed, ctx(REV_B));
    expect(stale.status).toBe('stale');
    expect(stale.lastExecutedStatus).toBe('failed');
  });

  it('marks evidence stale when a package becomes uninstalled or unsupported', () => {
    const blocked = mergeCoverageRow(
      { ...discovered('pkg:agent-inspect', 'blocked') },
      passedRow('pkg:agent-inspect'),
      ctx(),
    );
    expect(blocked.status).toBe('stale');
    expect(blocked.statusReason).toBe('package-not-installed');
    const unsupported = mergeCoverageRow(
      discovered('s1', 'unsupported'),
      passedRow('s1'),
      ctx(),
    );
    expect(unsupported.status).toBe('stale');
  });

  it('retires removed symbols with their evidence instead of dropping them', () => {
    const result = mergeCoverageLedger({
      symbols: [discovered('keep')],
      packages: [],
      previous: {
        symbols: [
          passedRow('keep'),
          passedRow('gone'),
          { id: 'gone-unexecuted', status: 'planned', testIds: [], executedEvidence: [] },
        ],
      },
      ctx: ctx(),
    });
    expect(result.symbols.map((s) => s.id)).toEqual(['keep']);
    expect(result.retiredSymbols.map((s) => s.id)).toEqual(['gone']);
    expect(result.retiredSymbols[0]).toMatchObject({
      status: 'stale',
      statusReason: 'symbol-removed',
      lastExecutedStatus: 'passed',
      executedEvidence: [LINK],
    });

    const next = mergeCoverageLedger({
      symbols: [discovered('keep')],
      packages: [],
      previous: result,
      ctx: ctx(),
    });
    expect(next.retiredSymbols).toEqual(result.retiredSymbols);

    const back = mergeCoverageLedger({
      symbols: [discovered('keep'), discovered('gone')],
      packages: [],
      previous: result,
      ctx: ctx(),
    });
    expect(back.retiredSymbols).toEqual([]);
    expect(back.symbols.find((s) => s.id === 'gone')?.status).toBe('passed');
  });

  it('keeps output deterministic regardless of previous row ordering', () => {
    const prev = [passedRow('b'), passedRow('a')];
    const out = mergeCoverageLedger({
      symbols: [],
      packages: [],
      previous: { symbols: prev },
      ctx: ctx(),
    });
    expect(out.retiredSymbols.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('moves old-revision evidence to history when new evidence is recorded', () => {
    const stale = mergeCoverageRow(discovered('s1'), passedRow('s1'), ctx(REV_B));
    const recorded = recordExecutedEvidence(stale, {
      status: 'passed',
      revisionId: REV_B.id,
      testIds: ['lab:suite:travel-core'],
      executedEvidence: ['artifacts/batch-2/suite-summary.json'],
    });
    expect(recorded.status).toBe('passed');
    expect(recorded.executedEvidence).toEqual(['artifacts/batch-2/suite-summary.json']);
    expect(recorded.evidenceHistory).toEqual([
      expect.objectContaining({
        status: 'passed',
        revision: REV_A.id,
        executedEvidence: [LINK],
        reason: 'superseded-by-new-revision',
      }),
    ]);
    const same = recordExecutedEvidence(passedRow('s1'), {
      status: 'passed',
      revisionId: REV_A.id,
      testIds: ['lab:suite:travel-core'],
      executedEvidence: ['artifacts/batch-2/suite-summary.json'],
    });
    expect(same.executedEvidence).toEqual([LINK, 'artifacts/batch-2/suite-summary.json']);
    expect(same.evidenceHistory).toEqual([]);
  });

  it('derives the legacy ledger revision from its agentInspect block', () => {
    expect(
      revisionIdFromLedger({
        agentInspect: {
          installedVersion: '6.31.16',
          packageLockIntegrity: 'sha512-aaa',
          tarballSha256OfPackageJson: 'a'.repeat(64),
        },
      }),
    ).toBe(REV_A.id);
    expect(revisionIdFromLedger({ inputRevision: { id: 'x' } })).toBe('x');
    expect(revisionIdFromLedger({})).toBeNull();
  });
});
