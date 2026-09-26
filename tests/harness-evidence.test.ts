import { describe, expect, it } from 'vitest';
import { evaluateCaptureFidelitySync } from '../src/playground/oracle';
import {
  finalizeChecksums,
  listFilesRecursive,
  verifyChecksums,
} from '../src/playground/artifact-writer';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('harness evidence integrity (R3/R5)', () => {
  it('rejects runId policy_envelope probe text as invalid fidelity', () => {
    const result = evaluateCaptureFidelitySync({
      scenario: {
        id: 'probe',
        version: '1',
        name: 'probe',
        suite: 'travel-core',
        workload: 'trip',
        variant: 'valid',
        expectFailure: false,
        request: {},
        expected: {},
      },
      agentInspectRunId: 'run_fake',
      traceText: 'runId policy_envelope',
      independentModelCalls: 0,
      independentLiveAttempts: 0,
    });
    expect(result.verdict).toBe('fail');
    expect(result.assertions.some((a) => a.id === 'fidelity.probeRejected')).toBe(
      true,
    );
  });

  it('hashes nested inspect-traces files', () => {
    const dir = join(tmpdir(), `ai-checksum-${Date.now()}`);
    mkdirSync(join(dir, 'inspect-traces'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"ok":true}\n');
    writeFileSync(join(dir, 'inspect-traces', 'run.jsonl'), '{"event":"x"}\n');
    const checksums = finalizeChecksums(dir);
    expect(checksums['inspect-traces/run.jsonl']).toBeTruthy();
    expect(checksums['manifest.json']).toBeTruthy();
    expect(listFilesRecursive(dir)).toContain('inspect-traces/run.jsonl');
    expect(verifyChecksums(dir)).toEqual([]);
    // Mutate nested file — verify must fail
    writeFileSync(join(dir, 'inspect-traces', 'run.jsonl'), '{"event":"mutated"}\n');
    expect(verifyChecksums(dir).length).toBeGreaterThan(0);
    // SHA256SUMS itself lists nested path
    const sums = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8');
    expect(sums).toContain('inspect-traces/run.jsonl');
    rmSync(dir, { recursive: true, force: true });
  });
});
