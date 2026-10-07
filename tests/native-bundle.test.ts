import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ancillaryDirFor,
  listFilesRecursive,
  verifyChecksums,
  writeJson,
} from '../src/playground/artifact-writer';
import {
  boundedRedact,
  checkBundleProvenance,
  collectProvenance,
  describeThrown,
  finalizeNativeBundle,
  runNativeBundleVerify,
} from '../src/playground/native-bundle';
import { DecisionGraphService } from '../src/demo/decision.graph';
import { applyBundleGate, runScenario } from '../scripts/lab/run';
import {
  writeLiveFailureBundle,
  type LiveEvalFailurePacket,
} from '../scripts/live-eval-packet';

// Each gate run shells out to the agent-inspect CLI (~1s each).
vi.setConfig({ testTimeout: 60_000 });

const HEX64 = /^[a-f0-9]{64}$/;
const TEST_ROOT = join(process.cwd(), 'artifacts', `test-native-bundle-${Date.now()}`);
const RUN_ID = 'run_bundletest01';
const TRACE =
  `{"schemaVersion":"1.0","event":"run_started","runId":"${RUN_ID}"}\n` +
  `{"schemaVersion":"1.0","event":"run_completed","runId":"${RUN_ID}"}\n`;

function freshBundle(
  name: string,
  opts: { trace?: boolean; failure?: boolean } = {},
): { dir: string; executionId: string } {
  const executionId = randomUUID();
  const dir = join(TEST_ROOT, `${name}-${executionId}`);
  mkdirSync(dir, { recursive: true });
  const withTrace = opts.trace !== false;
  if (withTrace) writeFileSync(join(dir, 'trace.jsonl'), TRACE);
  writeJson(dir, 'result.json', {
    executionId,
    overallVerdict: opts.failure ? 'fail' : 'pass',
  });
  writeJson(dir, 'oracle.json', { ok: !opts.failure });
  mkdirSync(join(dir, 'inspect-traces'), { recursive: true });
  if (withTrace) {
    writeFileSync(join(dir, 'inspect-traces', `${RUN_ID}.jsonl`), TRACE);
  }
  return { dir, executionId };
}

function seal(dir: string, executionId: string, withTrace = true) {
  return finalizeNativeBundle({
    bundleDir: dir,
    scenarioId: 'T01',
    profileId: 'offline',
    provenance: collectProvenance({
      executionId,
      agentInspectRunId: withTrace ? RUN_ID : null,
      scenarioPayload: { id: 'T01' },
      oracleExpected: { minModelCalls: 0 },
      config: { id: 'offline' },
    }),
  });
}

beforeAll(() => mkdirSync(TEST_ROOT, { recursive: true }));
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('native bundle: closed file set + default verify gate', () => {
  it('success pack passes default verify; checksums live outside the bundle', () => {
    const { dir, executionId } = freshBundle('success');
    const gate = seal(dir, executionId);

    expect(gate.verify.issues).toEqual([]);
    expect(gate.verify.ok).toBe(true);
    expect(gate.ok).toBe(true);
    expect(gate.identityRunId).toBe(RUN_ID);

    const files = listFilesRecursive(dir);
    expect(files).not.toContain('SHA256SUMS.txt');
    expect(files).not.toContain('bundle-verify.json');
    expect(files).toContain('evidence.json');
    expect(files).toContain('provenance.json');

    const ancillary = ancillaryDirFor(dir);
    expect(existsSync(join(ancillary, 'SHA256SUMS.txt'))).toBe(true);
    expect(existsSync(join(ancillary, 'bundle-verify.json'))).toBe(true);
    // Ancillary sums close over every bundle file including evidence.json.
    const sums = readFileSync(join(ancillary, 'SHA256SUMS.txt'), 'utf8');
    expect(sums).toContain('  evidence.json');
    expect(verifyChecksums(dir)).toEqual([]);

    // Default verify (no --unexpected override) from a fresh invocation.
    expect(runNativeBundleVerify(dir).ok).toBe(true);
  });

  it('reproduces the original bug: SHA256SUMS.txt inside the bundle fails default verify', () => {
    const { dir, executionId } = freshBundle('legacy-sums');
    expect(seal(dir, executionId).ok).toBe(true);
    writeFileSync(join(dir, 'SHA256SUMS.txt'), 'deadbeef\n');
    const verify = runNativeBundleVerify(dir);
    expect(verify.ok).toBe(false);
    expect(verify.issues.map((i) => i.code)).toContain('file_unexpected');
  });

  it('fails default verify for a missing, tampered, or extra file', () => {
    const missing = freshBundle('missing');
    seal(missing.dir, missing.executionId);
    unlinkSync(join(missing.dir, 'oracle.json'));
    expect(runNativeBundleVerify(missing.dir).ok).toBe(false);
    expect(verifyChecksums(missing.dir).join(';')).toContain('oracle.json missing');

    const tampered = freshBundle('tampered');
    seal(tampered.dir, tampered.executionId);
    writeFileSync(join(tampered.dir, 'oracle.json'), '{"ok":"mutated"}\n');
    expect(runNativeBundleVerify(tampered.dir).ok).toBe(false);
    expect(verifyChecksums(tampered.dir).join(';')).toContain('oracle.json mismatch');

    const extra = freshBundle('extra');
    seal(extra.dir, extra.executionId);
    writeFileSync(join(extra.dir, 'late-report.json'), '{}\n');
    const verify = runNativeBundleVerify(extra.dir);
    expect(verify.ok).toBe(false);
    expect(verify.issues.some((i) => i.path === 'late-report.json')).toBe(true);
    expect(verifyChecksums(extra.dir).join(';')).toContain('late-report.json unexpected');
  });

  it('detects provenance mismatch even when bundle hashes still close', () => {
    const { dir, executionId } = freshBundle('prov');
    expect(seal(dir, executionId).ok).toBe(true);
    expect(checkBundleProvenance(dir)).toEqual([]);

    // evidence.json is the manifest itself, so verify cannot catch edits to
    // its inputs; the provenance gate must.
    const evidencePath = join(dir, 'evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.inputs.lockfileSha256 = 'f'.repeat(64);
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    const issues = checkBundleProvenance(dir);
    expect(issues.map((i) => i.code)).toContain('provenance_mismatch');
    expect(issues.some((i) => i.message.includes('lockfileSha256'))).toBe(true);

    // Caller-expected values must also match.
    const second = freshBundle('prov-expected');
    seal(second.dir, second.executionId);
    expect(
      checkBundleProvenance(second.dir, { lockfileSha256: '0'.repeat(64) }).map(
        (i) => i.code,
      ),
    ).toContain('provenance_mismatch');
    expect(
      checkBundleProvenance(second.dir, { appGitSha: '0'.repeat(40) }).map(
        (i) => i.code,
      ),
    ).toContain('provenance_mismatch');
  });

  it('rejects a trace whose bytes no longer match the bound source hash', () => {
    const { dir, executionId } = freshBundle('trace-bound');
    expect(seal(dir, executionId).ok).toBe(true);
    writeFileSync(join(dir, 'trace.jsonl'), TRACE + '{"extra":true}\n');
    expect(
      checkBundleProvenance(dir).some((i) => i.path === 'trace.jsonl'),
    ).toBe(true);
  });

  it('binds full-length digests, never truncated ones', () => {
    const { dir, executionId } = freshBundle('digests');
    seal(dir, executionId);
    const prov = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
    expect(prov.lockfileSha256).toMatch(HEX64);
    expect(prov.scenarioSha256).toMatch(HEX64);
    expect(prov.oracleSha256).toMatch(HEX64);
    expect(prov.configSha256).toMatch(HEX64);
    expect(prov.agentInspect.lockedIntegrity).toMatch(/^sha\d+-/);
    expect(prov.app.gitSha).toMatch(/^[a-f0-9]{40,64}$/);
    if (prov.app.dirty) expect(prov.app.dirtyPatchSha256).toMatch(HEX64);
    const evidence = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'));
    expect(evidence.inputs.lockfileSha256).toBe(prov.lockfileSha256);
    // No absolute private path in the manifest.
    expect(evidence.inputs.labArtifactDir.startsWith('/')).toBe(false);
  });

  it('failure pack without a trace is bound to the preallocated execution id', () => {
    const { dir, executionId } = freshBundle('no-trace', {
      trace: false,
      failure: true,
    });
    const gate = seal(dir, executionId, false);
    expect(gate.verify.issues).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(gate.identityRunId).toBe(executionId);
    const evidence = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'));
    expect(evidence.source.runIds).toEqual([executionId]);
    expect(evidence.assessment.status).toBe('UNSAFE');
  });

  it('bounds and redacts thrown error text without mutating the error', () => {
    const err = new Error(`provider failed key=sk-live1234567890abcdef ${'x'.repeat(5000)}`);
    const before = err.message;
    const info = describeThrown(err);
    expect(info.message).not.toContain('sk-live1234567890abcdef');
    expect(info.message.length).toBeLessThan(2100);
    expect(err.message).toBe(before);
    expect(boundedRedact('Authorization: Bearer abcdef123456')).not.toContain(
      'abcdef123456',
    );
  });
});

describe('live-eval failure bundles', () => {
  const packet = (over: Partial<LiveEvalFailurePacket>): LiveEvalFailurePacket => ({
    schemaVersion: 'proactive-ai-demo/live-eval-failure/1',
    recordedAt: new Date().toISOString(),
    case: 'before-departure',
    ok: false,
    category: 'invariant_miss',
    application: {},
    ...over,
  });

  it('returned failure finalizes a verified, self-contained bundle', () => {
    const executionId = randomUUID();
    const tracePath = join(TEST_ROOT, 'live-trace.jsonl');
    writeFileSync(tracePath, TRACE);
    const { bundleDir, gate } = writeLiveFailureBundle({
      recordingsDir: join(TEST_ROOT, 'recordings'),
      executionId,
      request: { eventId: 'e1' },
      tracePath,
      packet: packet({
        detail: 'Expected application wait',
        agentInspectRunId: RUN_ID,
        application: { runStatus: 'completed', modelCalls: 1 },
      }),
    });
    expect(gate.verify.issues).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(gate.identityRunId).toBe(RUN_ID);
    const files = listFilesRecursive(bundleDir);
    expect(files).toEqual(
      expect.arrayContaining([
        'evidence.json',
        'failure-packet.json',
        'oracle.json',
        'provenance.json',
        'trace.jsonl',
      ]),
    );
    expect(files).not.toContain('SHA256SUMS.txt');
  });

  it('thrown failure without a trace still carries run identity and verifies', () => {
    const executionId = randomUUID();
    const { bundleDir, gate } = writeLiveFailureBundle({
      recordingsDir: join(TEST_ROOT, 'recordings'),
      executionId,
      request: { eventId: 'e2' },
      tracePath: null,
      packet: packet({
        category: 'provider_error',
        error: 'Error: upstream 500 Bearer abcdef1234567890',
      }),
    });
    expect(gate.ok).toBe(true);
    expect(gate.identityRunId).toBe(executionId);
    const saved = JSON.parse(
      readFileSync(join(bundleDir, 'failure-packet.json'), 'utf8'),
    );
    expect(saved.executionId).toBe(executionId);
    expect(saved.error).not.toContain('abcdef1234567890');
  });
});

describe('lab runner: default bundle verify is a harness gate', () => {
  const batchId = `test-bundle-${Date.now()}`;
  const batchDir = join(process.cwd(), 'artifacts', batchId);
  afterAll(() => {
    rmSync(batchDir, { recursive: true, force: true });
  });

  it('success pack (travel-core S01) passes default verify', async () => {
    const r = await runScenario('S01', { batchId });
    expect(r.overallVerdict).toBe('pass');
    expect(r.bundleGate?.ok).toBe(true);
    expect(r.bundleGate?.issueCodes).toEqual([]);
    expect(r.agentInspectRunId).toBeTruthy();
    expect(r.bundleGate?.identityRunId).toBe(r.agentInspectRunId);
    expect(runNativeBundleVerify(r.artifactDir).ok).toBe(true);
    expect(listFilesRecursive(r.artifactDir)).not.toContain('SHA256SUMS.txt');
    expect(verifyChecksums(r.artifactDir)).toEqual([]);
  }, 60_000);

  it('returned failure pack stays reviewable and passes default verify', async () => {
    const original = DecisionGraphService.prototype.run;
    const spy = vi
      .spyOn(DecisionGraphService.prototype, 'run')
      .mockImplementation(async function (this: DecisionGraphService, ...args) {
        const res = await original.apply(this, args);
        return { ...res, runStatus: 'failed', failureReason: 'INJECTED_FAILURE' };
      });
    try {
      const r = await runScenario('S01', { batchId });
      expect(r.overallVerdict).toBe('fail');
      expect(r.thrownError).toBeUndefined();
      expect(r.bundleGate?.ok).toBe(true);
      expect(runNativeBundleVerify(r.artifactDir).ok).toBe(true);
      expect(r.agentInspectRunId).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('thrown failure after trace start finalizes a bundle with trace identity', async () => {
    const original = DecisionGraphService.prototype.run;
    const spy = vi
      .spyOn(DecisionGraphService.prototype, 'run')
      .mockImplementation(async function (this: DecisionGraphService, ...args) {
        await original.apply(this, args);
        throw new Error('post-run boom sk-thrown1234567890');
      });
    try {
      const r = await runScenario('S01', { batchId });
      expect(r.overallVerdict).toBe('fail');
      expect(r.thrownError?.message).toContain('post-run boom');
      expect(r.thrownError?.message).not.toContain('sk-thrown1234567890');
      expect(r.agentInspectRunId).toBeTruthy();
      expect(r.bundleGate?.ok).toBe(true);
      expect(r.bundleGate?.identityRunId).toBe(r.agentInspectRunId);
      expect(runNativeBundleVerify(r.artifactDir).ok).toBe(true);
      const files = listFilesRecursive(r.artifactDir);
      expect(files).toContain('error.json');
      expect(files).toContain('trace.jsonl');
      const err = readFileSync(join(r.artifactDir, 'error.json'), 'utf8');
      expect(err).not.toContain('sk-thrown1234567890');
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('thrown failure before any trace is bound to the preallocated execution id', async () => {
    const spy = vi
      .spyOn(DecisionGraphService.prototype, 'run')
      .mockRejectedValue(new Error('provider unreachable'));
    try {
      const r = await runScenario('S01', { batchId });
      expect(r.overallVerdict).toBe('fail');
      expect(r.thrownError?.message).toBe('provider unreachable');
      expect(r.agentInspectRunId).toBeUndefined();
      expect(r.bundleGate?.ok).toBe(true);
      expect(r.bundleGate?.identityRunId).toBe(r.executionId);
      expect(runNativeBundleVerify(r.artifactDir).ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('a failing gate downgrades a passing scenario but never un-blocks one', async () => {
    const r = await runScenario('S01', { batchId });
    expect(r.overallVerdict).toBe('pass');
    const failing = {
      ok: false,
      bundleDir: r.artifactDir,
      identityRunId: 'run_x',
      verify: {
        ok: false,
        exitCode: 1,
        status: 'fail',
        issues: [{ code: 'file_unexpected', message: 'late file' }],
      },
      checksumProblems: [],
      provenanceIssues: [],
      reportPath: 'report.json',
    };
    const downgraded = applyBundleGate(r, failing);
    expect(downgraded.overallVerdict).toBe('fail');
    expect(downgraded.bundleGate?.issueCodes).toContain('file_unexpected');
    expect(
      downgraded.assertions.some((a) => a.id === 'bundle.verify' && !a.passed),
    ).toBe(true);
    const blocked = applyBundleGate({ ...r, overallVerdict: 'blocked' }, failing);
    expect(blocked.overallVerdict).toBe('blocked');
  }, 60_000);
});
