import { describe, expect, it } from 'vitest';
import {
  evaluateCaptureFidelitySync,
  evaluateApplicationOracle,
} from '../src/playground/oracle';
import { resolveScenarioExpected } from '../src/playground/expected-profile';
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

  it('fails fidelity when LLM spans stripped but model calls were non-zero', () => {
    const scenario = {
      id: 'probe',
      version: '1',
      name: 'probe',
      suite: 'travel-core',
      workload: 'trip',
      variant: 'valid' as const,
      expectFailure: false,
      request: {},
      expected: { minModelCalls: 1 },
    };
    const jsonl =
      '{"schemaVersion":"1.0","event":"run_started","runId":"run_test"}\n' +
      '{"schemaVersion":"1.0","event":"step_started","runId":"run_test","type":"logic","name":"only-logic"}\n';
    const result = evaluateCaptureFidelitySync({
      scenario,
      agentInspectRunId: 'run_test',
      traceText: jsonl,
      independentModelCalls: 1,
      independentLiveAttempts: 1,
      operationJournal: { llmInvocations: 1, fixtureInvocations: 0 },
    });
    expect(result.verdict).toBe('fail');
    expect(result.assertions.some((a) => a.id === 'fidelity.llmSpansPresent')).toBe(
      true,
    );
  });

  it('rejects partial LLM capture when journal expects three completed ops', () => {
    const scenario = {
      id: 'probe',
      version: '1',
      name: 'probe',
      suite: 'travel-core',
      workload: 'trip',
      variant: 'valid' as const,
      expectFailure: false,
      request: {},
      expected: { minModelCalls: 3 },
    };
    const journal = {
      llmInvocations: 3,
      fixtureInvocations: 0,
      operations: [
        {
          operationId: 'op1',
          kind: 'llm' as const,
          name: 'investigate:a',
          executionId: 'run_test',
          terminal: 'completed' as const,
          transportAttempts: 1,
        },
        {
          operationId: 'op2',
          kind: 'llm' as const,
          name: 'investigate:b',
          executionId: 'run_test',
          terminal: 'completed' as const,
          transportAttempts: 1,
        },
        {
          operationId: 'op3',
          kind: 'llm' as const,
          name: 'finalize:c',
          executionId: 'run_test',
          terminal: 'completed' as const,
          transportAttempts: 1,
        },
      ],
    };
    const oneOfThree =
      '{"schemaVersion":"1.0","event":"run_started","runId":"run_test"}\n' +
      '{"schemaVersion":"1.0","event":"step_started","runId":"run_test","stepId":"s1","type":"llm","name":"investigate:a"}\n' +
      '{"schemaVersion":"1.0","event":"step_completed","runId":"run_test","stepId":"s1","type":"llm","name":"investigate:a"}\n';
    const partial = evaluateCaptureFidelitySync({
      scenario,
      agentInspectRunId: 'run_test',
      traceText: oneOfThree,
      independentModelCalls: 3,
      independentLiveAttempts: 3,
      operationJournal: journal,
    });
    expect(partial.verdict).toBe('fail');
    expect(partial.assertions.some((a) => a.id === 'fidelity.llmOpCount' && !a.passed)).toBe(
      true,
    );

    const missingTerminal =
      '{"schemaVersion":"1.0","event":"run_started","runId":"run_test"}\n' +
      '{"schemaVersion":"1.0","event":"step_started","runId":"run_test","stepId":"s1","type":"llm","name":"investigate:a"}\n' +
      '{"schemaVersion":"1.0","event":"step_started","runId":"run_test","stepId":"s2","type":"llm","name":"investigate:b"}\n' +
      '{"schemaVersion":"1.0","event":"step_completed","runId":"run_test","stepId":"s2","type":"llm","name":"investigate:b"}\n' +
      '{"schemaVersion":"1.0","event":"step_started","runId":"run_test","stepId":"s3","type":"llm","name":"finalize:c"}\n' +
      '{"schemaVersion":"1.0","event":"step_completed","runId":"run_test","stepId":"s3","type":"llm","name":"finalize:c"}\n';
    const incomplete = evaluateCaptureFidelitySync({
      scenario,
      agentInspectRunId: 'run_test',
      traceText: missingTerminal,
      independentModelCalls: 3,
      independentLiveAttempts: 3,
      operationJournal: journal,
    });
    expect(incomplete.verdict).toBe('fail');
    expect(
      incomplete.assertions.some(
        (a) => a.id === 'fidelity.llmTerminalObserved' && !a.passed,
      ),
    ).toBe(true);

    const empty =
      '{"schemaVersion":"1.0","event":"run_started","runId":"run_test"}\n' +
      '{"schemaVersion":"1.0","event":"step_started","runId":"run_test","type":"logic","name":"only-logic"}\n';
    const none = evaluateCaptureFidelitySync({
      scenario,
      agentInspectRunId: 'run_test',
      traceText: empty,
      independentModelCalls: 3,
      independentLiveAttempts: 3,
      operationJournal: journal,
    });
    expect(none.verdict).toBe('fail');
  });

  it('resolves live-model expectations without fixture invocation exactness', () => {
    const scenario = {
      id: 'S01',
      version: '1',
      name: 'x',
      suite: 'travel-core',
      workload: 'trip',
      variant: 'valid' as const,
      expectFailure: false,
      request: {},
      expected: {
        exactFixtureInvocations: 1,
        modelMode: 'fixture' as const,
        minModelCalls: 1,
      },
      expectedByProfile: {
        'live-model': {
          modelMode: 'live' as const,
          minLiveAttempts: 1,
          maxFixtureInvocations: 0,
        },
      },
    };
    const resolved = resolveScenarioExpected(scenario, 'live-model');
    expect(resolved.exactFixtureInvocations).toBeUndefined();
    expect(resolved.modelMode).toBe('live');
    expect(resolved.minLiveAttempts).toBe(1);
    const app = evaluateApplicationOracle(
      scenario,
      {
        runStatus: 'completed',
        eventId: 'e',
        modelMode: 'live',
        modelCalls: 2,
        outboxWrites: 0,
        decisions: [],
        accounting: {
          providerMode: 'live',
          liveAttempts: 2,
          liveSuccesses: 2,
          liveFailures: 0,
          fixtureInvocations: 0,
          toolExecutions: 1,
          toolCacheHits: 0,
          requestedModelId: 'gpt-test',
          returnedModelIds: ['gpt-test'],
        },
      },
      0,
      { profileId: 'live-model', expected: resolved },
    );
    expect(app.verdict).toBe('pass');
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
