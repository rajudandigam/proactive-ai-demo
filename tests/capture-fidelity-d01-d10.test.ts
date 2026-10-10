import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateCaptureFidelity,
  evaluateCaptureFidelitySync,
} from '../src/playground/oracle';
import type {
  CaptureLogicalOperation,
  CaptureOperationSnapshot,
} from '../src/instrumentation/capture-operation-journal';
import { describeThrown } from '../src/playground/native-bundle';
import {
  writeLiveFailureBundle,
  type LiveEvalFailurePacket,
} from '../scripts/live-eval-packet';

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

function op(
  kind: 'llm' | 'tool',
  name: string,
  id: string,
  extra: Partial<CaptureLogicalOperation> = {},
): CaptureLogicalOperation {
  return {
    operationId: id,
    kind,
    name,
    executionId: 'run_test',
    terminal: 'completed',
    transportAttempts: 1,
    ...extra,
  };
}

const goodJournal: CaptureOperationSnapshot = {
  llmInvocations: 1,
  fixtureInvocations: 0,
  toolInvocations: 1,
  operations: [
    op('llm', 'generate', 'op_llm'),
    { ...op('tool', 'lookup', 'op_tool'), parentOperationId: 'op_llm' },
  ],
};

function event(
  type: string,
  name: string,
  stepId: string,
  eventName = 'step_completed',
  parentStepId?: string,
) {
  return {
    schemaVersion: '1.0',
    event: eventName,
    runId: 'run_test',
    type,
    name,
    stepId,
    ...(parentStepId !== undefined ? { parentStepId } : stepId === 'op_tool' ? { parentStepId: 'op_llm' } : {}),
  };
}

const goodEvents = [
  event('llm', 'generate', 'op_llm'),
  event('tool', 'lookup', 'op_tool'),
];

function traceText(events: object[]): string {
  return [
    { schemaVersion: '1.0', event: 'run_started', runId: 'run_test' },
    ...events,
  ]
    .map((x) => JSON.stringify(x))
    .join('\n');
}

function failedIds(assertions: Array<{ id: string; passed: boolean }>): string[] {
  return assertions.filter((a) => !a.passed).map((a) => a.id);
}

function runSync(
  events: object[],
  journal: CaptureOperationSnapshot,
  overrides: Partial<Parameters<typeof evaluateCaptureFidelitySync>[0]> = {},
) {
  return evaluateCaptureFidelitySync({
    scenario,
    agentInspectRunId: 'run_test',
    traceText: traceText(events),
    independentModelCalls: journal.llmInvocations,
    independentLiveAttempts: journal.llmInvocations,
    operationJournal: journal,
    ...overrides,
  });
}

async function runAsync(
  events: object[],
  journal: CaptureOperationSnapshot,
  overrides: Partial<Parameters<typeof evaluateCaptureFidelity>[0]> = {},
) {
  const eventsWithRun = [
    { schemaVersion: '1.0', event: 'run_started', runId: 'run_test' },
    ...events,
  ];
  return evaluateCaptureFidelity({
    scenario,
    agentInspectRunId: 'run_test',
    independentModelCalls: journal.llmInvocations,
    independentLiveAttempts: journal.llmInvocations,
    operationJournal: journal,
    read: {
      events: eventsWithRun,
      runs: [{ runId: 'run_test' }],
      format: 'jsonl',
    },
    ...overrides,
  });
}

describe('capture fidelity D01–D10 (sync + async)', () => {
  it('D01 one complete model call plus child tool with correct identities → pass', async () => {
    const sync = runSync(goodEvents, goodJournal);
    const asyncR = await runAsync(goodEvents, goodJournal);
    expect(sync.verdict).toBe('pass');
    expect(asyncR.verdict).toBe('pass');
    expect(sync.assertions.some((a) => a.id === 'fidelity.operationSetExact' && a.passed)).toBe(
      true,
    );
    expect(asyncR.assertions.some((a) => a.id === 'fidelity.operationSetExact' && a.passed)).toBe(
      true,
    );
  });

  it('D02 only one of multiple expected model calls survives → fail completeness', async () => {
    const journal: CaptureOperationSnapshot = {
      llmInvocations: 3,
      fixtureInvocations: 0,
      operations: [
        op('llm', 'investigate:a', 'op1'),
        op('llm', 'investigate:b', 'op2'),
        op('llm', 'finalize:c', 'op3'),
      ],
    };
    const events = [event('llm', 'investigate:a', 'op1')];
    const sync = runSync(events, journal);
    const asyncR = await runAsync(events, journal);
    expect(sync.verdict).toBe('fail');
    expect(asyncR.verdict).toBe('fail');
    expect(failedIds(sync.assertions)).toEqual(
      expect.arrayContaining(['fidelity.llmOpCount', 'fidelity.identityMapping']),
    );
    expect(failedIds(asyncR.assertions)).toEqual(
      expect.arrayContaining(['fidelity.llmOpCount', 'fidelity.identityMapping']),
    );
  });

  it('D03 same counts but unrelated IDs/names → fail identity reconciliation', async () => {
    const events = [
      event('llm', 'UNRELATED', 'other_llm'),
      event('tool', 'WRONG_TOOL', 'other_tool'),
    ];
    const sync = runSync(events, goodJournal);
    const asyncR = await runAsync(events, goodJournal);
    expect(sync.verdict).toBe('fail');
    expect(asyncR.verdict).toBe('fail');
    expect(failedIds(sync.assertions)).toEqual(
      expect.arrayContaining(['fidelity.identityMapping', 'fidelity.operationSetExact']),
    );
    expect(failedIds(asyncR.assertions)).toEqual(
      expect.arrayContaining(['fidelity.identityMapping', 'fidelity.operationSetExact']),
    );
  });

  it('D04 right tool but wrong parent → fail parent relationship', async () => {
    const events = [
      goodEvents[0]!,
      { ...goodEvents[1]!, parentStepId: 'unrelated' },
    ];
    const sync = runSync(events, goodJournal);
    const asyncR = await runAsync(events, goodJournal);
    expect(sync.verdict).toBe('fail');
    expect(asyncR.verdict).toBe('fail');
    expect(failedIds(sync.assertions)).toContain('fidelity.parentRelationship');
    expect(failedIds(asyncR.assertions)).toContain('fidelity.parentRelationship');
  });

  it('D05 tool started with no terminal event → fail terminal completeness', async () => {
    const events = [
      goodEvents[0]!,
      { ...goodEvents[1]!, event: 'step_started' },
    ];
    const sync = runSync(events, goodJournal);
    const asyncR = await runAsync(events, goodJournal);
    expect(sync.verdict).toBe('fail');
    expect(asyncR.verdict).toBe('fail');
    expect(failedIds(sync.assertions)).toContain('fidelity.toolTerminalObserved');
    expect(failedIds(asyncR.assertions)).toContain('fidelity.toolTerminalObserved');
  });

  it('D06 duplicate completed delivery → fail/diagnose duplicate capture', async () => {
    const events = [...goodEvents, goodEvents[0]!];
    const sync = runSync(events, goodJournal);
    const asyncR = await runAsync(events, goodJournal);
    expect(sync.verdict).toBe('fail');
    expect(asyncR.verdict).toBe('fail');
    expect(failedIds(sync.assertions)).toContain('fidelity.noDuplicateCapture');
    expect(failedIds(asyncR.assertions)).toContain('fidelity.noDuplicateCapture');
  });

  it('D07 tool-only journal, zero captured tools → fail', async () => {
    const journal: CaptureOperationSnapshot = {
      llmInvocations: 0,
      fixtureInvocations: 0,
      toolInvocations: 1,
      operations: [op('tool', 'lookup', 'op_tool')],
    };
    const sync = runSync([], journal);
    const asyncR = await runAsync([], journal);
    expect(sync.verdict).toBe('fail');
    expect(asyncR.verdict).toBe('fail');
    expect(failedIds(sync.assertions)).toEqual(
      expect.arrayContaining(['fidelity.toolOpCount', 'fidelity.identityMapping']),
    );
    expect(failedIds(asyncR.assertions)).toEqual(
      expect.arrayContaining(['fidelity.toolOpCount', 'fidelity.identityMapping']),
    );
  });

  it('D08 wrong physical run, missing all events, conflicting duplicate status → fail', async () => {
    const wrongRunJournal: CaptureOperationSnapshot = {
      ...goodJournal,
      operations: goodJournal.operations!.map((o) => ({
        ...o,
        executionId: 'run_other',
      })),
    };
    const wrongRun = runSync(goodEvents, wrongRunJournal, {
      executionId: 'run_test',
    });
    expect(wrongRun.verdict).toBe('fail');
    expect(failedIds(wrongRun.assertions)).toContain('fidelity.journalRunBound');

    const missing = runSync([], goodJournal);
    expect(missing.verdict).toBe('fail');
    expect(failedIds(missing.assertions)).toContain('fidelity.identityMapping');

    const dupStatus = [
      event('llm', 'generate', 'op_llm', 'step_completed'),
      event('llm', 'generate', 'op_llm', 'step_failed'),
      event('tool', 'lookup', 'op_tool'),
    ];
    const conflict = runSync(dupStatus, goodJournal);
    const conflictAsync = await runAsync(dupStatus, goodJournal);
    expect(conflict.verdict).toBe('fail');
    expect(conflictAsync.verdict).toBe('fail');
    expect(failedIds(conflict.assertions)).toContain('fidelity.noDuplicateCapture');
    expect(failedIds(conflictAsync.assertions)).toContain('fidelity.noDuplicateCapture');
  });

  it('D09 valid start/end, failed journal match, and policy-only zero-call → non-loss', async () => {
    const startEnd = [
      event('llm', 'generate', 'op_llm', 'step_started'),
      event('llm', 'generate', 'op_llm', 'step_completed'),
      event('tool', 'lookup', 'op_tool', 'step_started'),
      event('tool', 'lookup', 'op_tool', 'step_completed'),
    ];
    const ok = runSync(startEnd, goodJournal);
    expect(ok.verdict).toBe('pass');

    const failedJournal: CaptureOperationSnapshot = {
      llmInvocations: 1,
      fixtureInvocations: 0,
      toolInvocations: 0,
      operations: [op('llm', 'generate', 'op_llm', { terminal: 'failed' })],
    };
    const failedEvents = [event('llm', 'generate', 'op_llm', 'step_failed')];
    const failedMatch = runSync(failedEvents, failedJournal);
    const failedAsync = await runAsync(failedEvents, failedJournal);
    expect(failedMatch.verdict).toBe('pass');
    expect(failedAsync.verdict).toBe('pass');

    const policyScenario = {
      ...scenario,
      expected: { minModelCalls: 0 },
      _lab: { assertNoLlmSteps: true },
    };
    const emptyJournal: CaptureOperationSnapshot = {
      llmInvocations: 0,
      fixtureInvocations: 0,
      toolInvocations: 0,
      operations: [],
    };
    const policy = evaluateCaptureFidelitySync({
      scenario: policyScenario,
      agentInspectRunId: 'run_test',
      traceText: traceText([
        { schemaVersion: '1.0', event: 'step_started', runId: 'run_test', type: 'logic', name: 'policy', stepId: 'pol1' },
        { schemaVersion: '1.0', event: 'step_completed', runId: 'run_test', type: 'logic', name: 'policy', stepId: 'pol1' },
      ]),
      independentModelCalls: 0,
      independentLiveAttempts: 0,
      operationJournal: emptyJournal,
    });
    expect(policy.verdict).toBe('pass');
    expect(
      policy.assertions.some((a) => a.id === 'fidelity.zeroModelConsistent' && a.passed),
    ).toBe(true);

    const policyAsync = await evaluateCaptureFidelity({
      scenario: policyScenario,
      agentInspectRunId: 'run_test',
      independentModelCalls: 0,
      independentLiveAttempts: 0,
      operationJournal: emptyJournal,
      read: {
        events: [
          { schemaVersion: '1.0', event: 'run_started', runId: 'run_test' },
          {
            schemaVersion: '1.0',
            event: 'step_started',
            runId: 'run_test',
            type: 'logic',
            name: 'policy',
            stepId: 'pol1',
          },
          {
            schemaVersion: '1.0',
            event: 'step_completed',
            runId: 'run_test',
            type: 'logic',
            name: 'policy',
            stepId: 'pol1',
          },
        ],
        runs: [{ runId: 'run_test' }],
        format: 'jsonl',
      },
    });
    expect(policyAsync.verdict).toBe('pass');
  });

  it('D10 injected exception / returned validation failure preserves original error in reviewable packet', () => {
    const original = new Error('validation rejected: booking_window_closed');
    (original as { code?: string }).code = 'APP_VALIDATION';
    const before = original.message;
    const thrown = describeThrown(original);
    expect(original.message).toBe(before);
    expect(thrown.message).toContain('booking_window_closed');
    expect(thrown.code).toBe('APP_VALIDATION');

    const dir = join(tmpdir(), `d10-fail-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const executionId = 'exec_d10';
    const runId = 'run_d10';
    const tracePath = join(dir, 'trace.jsonl');
    writeFileSync(
      tracePath,
      `{"schemaVersion":"1.0","event":"run_started","runId":"${runId}"}\n` +
        `{"schemaVersion":"1.0","event":"run_completed","runId":"${runId}"}\n`,
    );
    const packet: LiveEvalFailurePacket = {
      schemaVersion: 'proactive-ai-demo/live-eval-failure/1',
      recordedAt: new Date().toISOString(),
      case: 'd10-validation',
      ok: false,
      category: 'invariant_miss',
      detail: thrown.message,
      agentInspectRunId: runId,
      error: `${thrown.name}: ${thrown.message}`,
      application: { runStatus: 'failed', modelCalls: 0 },
    };
    const { bundleDir, gate } = writeLiveFailureBundle({
      recordingsDir: join(dir, 'recordings'),
      executionId,
      request: { eventId: 'd10' },
      tracePath,
      packet,
    });
    expect(gate.ok).toBe(true);
    expect(gate.verify.issues).toEqual([]);
    expect(existsSync(join(bundleDir, 'failure-packet.json'))).toBe(true);
    const stored = JSON.parse(
      readFileSync(join(bundleDir, 'failure-packet.json'), 'utf8'),
    ) as LiveEvalFailurePacket;
    expect(stored.error).toContain('booking_window_closed');
    expect(stored.detail).toContain('booking_window_closed');
    rmSync(dir, { recursive: true, force: true });
  });
});
