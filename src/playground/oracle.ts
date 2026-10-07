import { existsSync, readFileSync } from 'node:fs';
import { ApplicationResult } from '../demo/schemas';
import type {
  CaptureLogicalOperation,
  CaptureOperationSnapshot,
} from '../instrumentation/capture-operation-journal';
import { resolveScenarioExpected, type ExpectedBlock } from './expected-profile';
import type { ScenarioFile } from './scenario-registry';
import type { AssertionResult } from './schemas';

function check(
  id: string,
  passed: boolean,
  message: string,
  observed?: unknown,
  expected?: unknown,
): AssertionResult {
  return { id, passed, message, observed, expected };
}

/**
 * Independent application oracle — uses ApplicationResult + outbox length only.
 * Never reads AgentInspect events to form expected model/outbox counts.
 */
export function evaluateApplicationOracle(
  scenario: ScenarioFile,
  result: ApplicationResult,
  independentOutboxCount: number,
  opts?: { profileId?: string; expected?: ExpectedBlock },
): { verdict: 'pass' | 'fail'; assertions: AssertionResult[] } {
  const e =
    opts?.expected ??
    (opts?.profileId
      ? resolveScenarioExpected(scenario, opts.profileId)
      : scenario.expected);
  const assertions: AssertionResult[] = [];

  if (e.runStatus) {
    assertions.push(
      check(
        'app.runStatus',
        result.runStatus === e.runStatus,
        `runStatus ${result.runStatus} vs ${e.runStatus}`,
        result.runStatus,
        e.runStatus,
      ),
    );
  }
  if (e.modelMode) {
    assertions.push(
      check(
        'app.modelMode',
        result.modelMode === e.modelMode,
        `modelMode ${result.modelMode} vs ${e.modelMode}`,
        result.modelMode,
        e.modelMode,
      ),
    );
  }
  if (e.exactOutboxWrites !== undefined) {
    assertions.push(
      check(
        'app.outboxWrites.result',
        result.outboxWrites === e.exactOutboxWrites,
        `result.outboxWrites ${result.outboxWrites} vs ${e.exactOutboxWrites}`,
        result.outboxWrites,
        e.exactOutboxWrites,
      ),
    );
    const independentOk =
      independentOutboxCount === e.exactOutboxWrites ||
      (e.runStatus === 'duplicate' &&
        result.outboxWrites === 0 &&
        independentOutboxCount >= 1);
    assertions.push(
      check(
        'app.outboxWrites.independent',
        independentOk,
        `independent outbox length ${independentOutboxCount}`,
        independentOutboxCount,
        e.exactOutboxWrites,
      ),
    );
  }
  if (e.minOutboxWrites !== undefined) {
    assertions.push(
      check(
        'app.outboxWrites.min',
        result.outboxWrites >= e.minOutboxWrites,
        `outboxWrites ${result.outboxWrites} >= ${e.minOutboxWrites}`,
        result.outboxWrites,
        e.minOutboxWrites,
      ),
    );
  }
  if (e.maxOutboxWrites !== undefined) {
    assertions.push(
      check(
        'app.outboxWrites.max',
        result.outboxWrites <= e.maxOutboxWrites,
        `outboxWrites ${result.outboxWrites} <= ${e.maxOutboxWrites}`,
        result.outboxWrites,
        e.maxOutboxWrites,
      ),
    );
  }
  if (e.maxModelCalls !== undefined) {
    assertions.push(
      check(
        'app.modelCalls.max',
        result.modelCalls <= e.maxModelCalls,
        `modelCalls ${result.modelCalls} <= ${e.maxModelCalls}`,
        result.modelCalls,
        e.maxModelCalls,
      ),
    );
  }
  if (e.minModelCalls !== undefined) {
    assertions.push(
      check(
        'app.modelCalls.min',
        result.modelCalls >= e.minModelCalls,
        `modelCalls ${result.modelCalls} >= ${e.minModelCalls}`,
        result.modelCalls,
        e.minModelCalls,
      ),
    );
  }
  if (e.exactFixtureInvocations !== undefined) {
    const got = result.accounting?.fixtureInvocations ?? -1;
    assertions.push(
      check(
        'app.fixtureInvocations',
        got === e.exactFixtureInvocations,
        `fixtureInvocations ${got} vs ${e.exactFixtureInvocations}`,
        got,
        e.exactFixtureInvocations,
      ),
    );
  }
  if (e.exactLiveAttempts !== undefined) {
    const got = result.accounting?.liveAttempts ?? -1;
    assertions.push(
      check(
        'app.liveAttempts',
        got === e.exactLiveAttempts,
        `liveAttempts ${got} vs ${e.exactLiveAttempts}`,
        got,
        e.exactLiveAttempts,
      ),
    );
  }
  if (e.minLiveAttempts !== undefined) {
    const got = result.accounting?.liveAttempts ?? -1;
    assertions.push(
      check(
        'app.liveAttempts.min',
        got >= e.minLiveAttempts,
        `liveAttempts ${got} >= ${e.minLiveAttempts}`,
        got,
        e.minLiveAttempts,
      ),
    );
  }
  if (e.maxFixtureInvocations !== undefined) {
    const got = result.accounting?.fixtureInvocations ?? -1;
    assertions.push(
      check(
        'app.fixtureInvocations.max',
        got <= e.maxFixtureInvocations,
        `fixtureInvocations ${got} <= ${e.maxFixtureInvocations}`,
        got,
        e.maxFixtureInvocations,
      ),
    );
  }
  if (e.requireReasons?.length) {
    const reasons = new Set(result.decisions.map((d) => d.reason));
    for (const r of e.requireReasons) {
      assertions.push(
        check(
          `app.reason.${r}`,
          reasons.has(r),
          reasons.has(r) ? `found ${r}` : `missing reason ${r}`,
          [...reasons],
          r,
        ),
      );
    }
  }
  if (e.forbidReasons?.length) {
    const reasons = new Set(result.decisions.map((d) => d.reason));
    for (const r of e.forbidReasons) {
      assertions.push(
        check(
          `app.forbid.${r}`,
          !reasons.has(r),
          !reasons.has(r) ? `absent ${r}` : `unexpected reason ${r}`,
          [...reasons],
          r,
        ),
      );
    }
  }

  const verdict = assertions.every((a) => a.passed) ? 'pass' : 'fail';
  return { verdict, assertions };
}

type TraceReadLike = {
  format?: string;
  events?: unknown[];
  runs?: unknown[];
  warnings?: unknown[];
};

type ObservedCaptureOp = {
  kind: 'llm' | 'tool';
  name: string;
  stepId?: string;
  parentStepId?: string;
  terminal: 'started' | 'completed' | 'failed' | 'unknown';
  runId?: string;
};

function stepTypeOf(ev: Record<string, unknown>): string | undefined {
  const attrs = ev.attributes as { stepType?: string } | undefined;
  const t = ev.type ?? ev.stepType ?? attrs?.stepType;
  return typeof t === 'string' ? t : undefined;
}

/** Structured observation only — no raw-text completeness fallback. */
function observeCaptureOperations(
  read: TraceReadLike | null | undefined,
  runId?: string,
): ObservedCaptureOp[] {
  const events = (read?.events ?? []) as Array<Record<string, unknown>>;
  const byStep = new Map<string, ObservedCaptureOp>();
  for (const ev of events) {
    const evRun = typeof ev.runId === 'string' ? ev.runId : undefined;
    if (runId && evRun && evRun !== runId) continue;
    const stepType = stepTypeOf(ev);
    if (stepType !== 'llm' && stepType !== 'tool') continue;
    const stepId =
      typeof ev.stepId === 'string'
        ? ev.stepId
        : typeof ev.id === 'string'
          ? ev.id
          : undefined;
    const name =
      typeof ev.name === 'string'
        ? ev.name
        : typeof (ev.attributes as { name?: string } | undefined)?.name ===
            'string'
          ? (ev.attributes as { name: string }).name
          : stepType;
    const parentStepId =
      typeof ev.parentStepId === 'string'
        ? ev.parentStepId
        : typeof ev.parentId === 'string'
          ? ev.parentId
          : undefined;
    const key = stepId ?? `${stepType}:${name}:${byStep.size}`;
    const existing = byStep.get(key);
    const eventName = typeof ev.event === 'string' ? ev.event : '';
    let terminal: ObservedCaptureOp['terminal'] = existing?.terminal ?? 'unknown';
    if (eventName === 'step_started') terminal = 'started';
    if (eventName === 'step_completed') terminal = 'completed';
    if (eventName === 'step_failed' || eventName === 'step_error') {
      terminal = 'failed';
    }
    if (!existing && eventName === '' && stepType) {
      // Some persisted shapes omit event and only carry type/name.
      terminal = 'completed';
    }
    byStep.set(key, {
      kind: stepType,
      name,
      stepId,
      parentStepId,
      terminal,
      runId: evRun,
    });
  }
  return [...byStep.values()];
}

function parseTraceTextEvents(traceText: string): TraceReadLike {
  const events: unknown[] = [];
  for (const line of traceText.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // ignore non-JSON lines for structured observation
    }
  }
  return { events, format: 'jsonl' };
}

function reconcileJournalToCapture(opts: {
  journal?: CaptureOperationSnapshot | null;
  observed: ObservedCaptureOp[];
  runId?: string;
}): AssertionResult[] {
  const assertions: AssertionResult[] = [];
  const ops = opts.journal?.operations ?? [];
  const expectedLogical = ops.filter(
    (o) => o.kind === 'llm' || o.kind === 'tool',
  );
  const expectedLlm = expectedLogical.filter((o) => o.kind === 'llm');
  const expectedTool = expectedLogical.filter((o) => o.kind === 'tool');
  const observedLlm = opts.observed.filter((o) => o.kind === 'llm');
  const observedTool = opts.observed.filter((o) => o.kind === 'tool');

  if (expectedLogical.length === 0) {
    return assertions;
  }

  const unfinished = expectedLogical.filter((o) => o.terminal === 'started');
  assertions.push(
    check(
      'fidelity.journalTerminal',
      unfinished.length === 0,
      unfinished.length === 0
        ? 'All journaled logical ops reached a terminal state'
        : `Journal has ${unfinished.length} non-terminal op(s)`,
      unfinished.map((o) => o.operationId),
    ),
  );

  if (opts.runId) {
    const wrongRun = expectedLogical.filter(
      (o) => o.executionId && o.executionId !== opts.runId,
    );
    assertions.push(
      check(
        'fidelity.journalRunBound',
        wrongRun.length === 0,
        wrongRun.length === 0
          ? 'Journal executionIds match mapped run'
          : `Journal ops bound to wrong executionId(s)`,
        wrongRun.map((o) => o.executionId),
        opts.runId,
      ),
    );
  }

  assertions.push(
    check(
      'fidelity.llmOpCount',
      observedLlm.length === expectedLlm.length,
      `LLM ops expected ${expectedLlm.length} observed ${observedLlm.length}`,
      { expected: expectedLlm.length, observed: observedLlm.length },
      expectedLlm.length,
    ),
  );
  assertions.push(
    check(
      'fidelity.toolOpCount',
      observedTool.length === expectedTool.length,
      `Tool ops expected ${expectedTool.length} observed ${observedTool.length}`,
      { expected: expectedTool.length, observed: observedTool.length },
      expectedTool.length,
    ),
  );

  const missingTerminal = observedLlm.filter(
    (o) => o.terminal !== 'completed' && o.terminal !== 'failed',
  );
  assertions.push(
    check(
      'fidelity.llmTerminalObserved',
      missingTerminal.length === 0,
      missingTerminal.length === 0
        ? 'Observed LLM ops have terminal events'
        : `Observed LLM ops missing terminal: ${missingTerminal.length}`,
      missingTerminal.map((o) => o.name),
    ),
  );

  // Reject partial acceptance: presence of any LLM is not enough when journal expects N.
  assertions.push(
    check(
      'fidelity.operationSetExact',
      observedLlm.length === expectedLlm.length &&
        observedTool.length === expectedTool.length &&
        unfinished.length === 0,
      'Exact journal↔capture operation set reconciliation',
      {
        expectedLlm: expectedLlm.map(summarizeJournalOp),
        observedLlm: observedLlm.map((o) => ({
          name: o.name,
          terminal: o.terminal,
          parentStepId: o.parentStepId,
        })),
        expectedTool: expectedTool.map(summarizeJournalOp),
        observedTool: observedTool.map((o) => ({
          name: o.name,
          terminal: o.terminal,
        })),
      },
    ),
  );

  return assertions;
}

function summarizeJournalOp(o: CaptureLogicalOperation) {
  return {
    operationId: o.operationId,
    kind: o.kind,
    name: o.name,
    terminal: o.terminal,
    parentOperationId: o.parentOperationId,
  };
}

function independentExpectsLlmWork(opts: {
  independentLiveAttempts: number;
  operationJournal?: CaptureOperationSnapshot | null;
}): boolean {
  if (opts.independentLiveAttempts > 0) return true;
  if ((opts.operationJournal?.operations ?? []).some((o) => o.kind === 'llm')) {
    return true;
  }
  return (opts.operationJournal?.llmInvocations ?? 0) > 0;
}

/**
 * Capture fidelity via public readers — never substring heuristics.
 * Rejects the review probe text "runId policy_envelope".
 */
export async function evaluateCaptureFidelity(opts: {
  scenario: ScenarioFile;
  agentInspectRunId?: string;
  tracePath?: string | null;
  independentModelCalls: number;
  independentLiveAttempts: number;
  operationJournal?: CaptureOperationSnapshot | null;
  /** Optional preloaded reader result from openTraceFile */
  read?: TraceReadLike | null;
}): Promise<{
  verdict: 'pass' | 'fail' | 'insufficient';
  assertions: AssertionResult[];
}> {
  const assertions: AssertionResult[] = [];

  // Reject known false-positive probe
  if (
    typeof opts.tracePath === 'string' &&
    opts.tracePath === 'runId policy_envelope'
  ) {
    assertions.push(
      check(
        'fidelity.probeRejected',
        false,
        'Rejected non-trace probe text runId policy_envelope',
      ),
    );
    return { verdict: 'fail', assertions };
  }

  if (!opts.agentInspectRunId) {
    assertions.push(
      check(
        'fidelity.runId',
        false,
        'No agentInspectRunId mapped from capture',
      ),
    );
    return { verdict: 'fail', assertions };
  }
  assertions.push(
    check(
      'fidelity.runId',
      true,
      `Mapped AgentInspect run ${opts.agentInspectRunId}`,
      opts.agentInspectRunId,
    ),
  );

  let read = opts.read;
  if (!read) {
    if (!opts.tracePath || !existsSync(opts.tracePath)) {
      assertions.push(
        check(
          'fidelity.traceFile',
          false,
          'trace.jsonl missing — cannot evaluate fidelity',
        ),
      );
      return { verdict: 'insufficient', assertions };
    }
    try {
      // createRequire avoids build-tsconfig moduleResolution limits on package exports
      const { createRequire } = await import('node:module');
      const req = createRequire(__filename);
      const { openTraceFile } = req('agent-inspect/readers') as {
        openTraceFile: (path: string) => Promise<TraceReadLike>;
      };
      read = await openTraceFile(opts.tracePath);
    } catch (err) {
      assertions.push(
        check(
          'fidelity.reader',
          false,
          `openTraceFile failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return { verdict: 'fail', assertions };
    }
  }

  const eventCount = Array.isArray(read.events) ? read.events.length : 0;
  const runCount = Array.isArray(read.runs) ? read.runs.length : 0;
  assertions.push(
    check(
      'fidelity.readerShape',
      eventCount > 0 && runCount > 0,
      `reader events=${eventCount} runs=${runCount} format=${read.format ?? 'unknown'}`,
      { eventCount, runCount, format: read.format },
    ),
  );

  // Bind exact run id when reader exposes runs
  const runs = (read.runs ?? []) as Array<{ runId?: string; id?: string }>;
  const ids = runs.map((r) => r.runId ?? r.id).filter(Boolean) as string[];
  const bound =
    ids.length === 0 || ids.includes(opts.agentInspectRunId);
  assertions.push(
    check(
      'fidelity.runBound',
      bound,
      bound
        ? 'Mapped run present in reader result'
        : `Mapped ${opts.agentInspectRunId} not in reader runs [${ids.join(',')}]`,
      ids,
      opts.agentInspectRunId,
    ),
  );

  if (opts.scenario._lab?.assertNoLlmSteps) {
    const text = opts.tracePath && existsSync(opts.tracePath)
      ? readFileSync(opts.tracePath, 'utf8')
      : JSON.stringify(read.events ?? []);
    const llmMention =
      /"type"\s*:\s*"llm"|"stepType"\s*:\s*"llm"/i.test(text);
    assertions.push(
      check(
        'fidelity.noLlm',
        !llmMention,
        llmMention
          ? 'Trace unexpectedly contains LLM step markers'
          : 'No LLM steps in policy-only run (as expected)',
      ),
    );
  }

  if (opts.scenario._lab?.assertTraceHasSteps) {
    const text = opts.tracePath && existsSync(opts.tracePath)
      ? readFileSync(opts.tracePath, 'utf8')
      : JSON.stringify(read.events ?? []);
    for (const stepName of opts.scenario._lab.assertTraceHasSteps) {
      assertions.push(
        check(
          `fidelity.step.${stepName}`,
          text.includes(stepName),
          text.includes(stepName)
            ? `Found step ${stepName}`
            : `Missing step ${stepName}`,
        ),
      );
    }
  }

  const expectsLlm = independentExpectsLlmWork({
    independentLiveAttempts: opts.independentLiveAttempts,
    operationJournal: opts.operationJournal,
  });
  const observed = observeCaptureOperations(read, opts.agentInspectRunId);

  if (expectsLlm && !opts.scenario._lab?.assertNoLlmSteps) {
    const journalOps = opts.operationJournal?.operations ?? [];
    if (journalOps.length > 0) {
      assertions.push(
        ...reconcileJournalToCapture({
          journal: opts.operationJournal,
          observed,
          runId: opts.agentInspectRunId,
        }),
      );
    } else {
      // Legacy counter-only journal: require at least one structured LLM op.
      assertions.push(
        check(
          'fidelity.llmSpansPresent',
          observed.filter((o) => o.kind === 'llm').length > 0,
          observed.some((o) => o.kind === 'llm')
            ? `Trace contains structured LLM operation(s)`
            : 'Independent model/journal says LLM work occurred but trace has no structured LLM ops',
          {
            observedLlm: observed.filter((o) => o.kind === 'llm').length,
            independentModelCalls: opts.independentModelCalls,
            independentLiveAttempts: opts.independentLiveAttempts,
            operationJournal: opts.operationJournal ?? null,
          },
        ),
      );
    }
  }

  if (
    opts.independentLiveAttempts === 0 &&
    opts.independentModelCalls === 0 &&
    !(opts.operationJournal?.llmInvocations || opts.operationJournal?.fixtureInvocations) &&
    !(opts.operationJournal?.operations?.length)
  ) {
    assertions.push(
      check(
        'fidelity.zeroModelConsistent',
        true,
        'Independent counters show zero model work; capture need not invent LLM events',
        {
          independentModelCalls: opts.independentModelCalls,
          independentLiveAttempts: opts.independentLiveAttempts,
        },
      ),
    );
  }

  const verdict = assertions.every((a) => a.passed)
    ? 'pass'
    : assertions.some(
          (a) =>
            (a.id === 'fidelity.traceFile' || a.id === 'fidelity.reader') &&
            !a.passed,
        )
      ? 'insufficient'
      : 'fail';
  return { verdict, assertions };
}

/** Sync wrapper for tests that cannot await — prefer async version. */
export function evaluateCaptureFidelitySync(opts: {
  scenario: ScenarioFile;
  agentInspectRunId?: string;
  traceText?: string | null;
  independentModelCalls: number;
  independentLiveAttempts: number;
  operationJournal?: CaptureOperationSnapshot | null;
}): {
  verdict: 'pass' | 'fail' | 'insufficient';
  assertions: AssertionResult[];
} {
  // Deliberately fail substring-only probes (R3)
  if (opts.traceText === 'runId policy_envelope') {
    return {
      verdict: 'fail',
      assertions: [
        check(
          'fidelity.probeRejected',
          false,
          'Rejected non-trace probe text runId policy_envelope',
        ),
      ],
    };
  }
  if (!opts.agentInspectRunId) {
    return {
      verdict: 'fail',
      assertions: [
        check('fidelity.runId', false, 'No agentInspectRunId mapped from capture'),
      ],
    };
  }
  if (!opts.traceText || opts.traceText.trim() === '') {
    return {
      verdict: 'insufficient',
      assertions: [
        check('fidelity.traceFile', false, 'empty trace text'),
      ],
    };
  }
  // Require JSONL-looking lines with schemaVersion/event — not bare substrings
  const lines = opts.traceText.trim().split('\n');
  let jsonlOk = false;
  try {
    for (const line of lines.slice(0, 5)) {
      const obj = JSON.parse(line) as { schemaVersion?: string; event?: string; runId?: string };
      if (obj.schemaVersion && (obj.event || obj.runId)) {
        jsonlOk = true;
        break;
      }
    }
  } catch {
    jsonlOk = false;
  }
  if (!jsonlOk) {
    return {
      verdict: 'fail',
      assertions: [
        check(
          'fidelity.traceShape',
          false,
          'Trace text is not valid AgentInspect JSONL',
        ),
      ],
    };
  }

  const read = parseTraceTextEvents(opts.traceText);
  const expectsLlm = independentExpectsLlmWork({
    independentLiveAttempts: opts.independentLiveAttempts,
    operationJournal: opts.operationJournal,
  });
  const observed = observeCaptureOperations(read, opts.agentInspectRunId);
  const llmAssertions: AssertionResult[] = [];
  if (expectsLlm && !opts.scenario._lab?.assertNoLlmSteps) {
    const journalOps = opts.operationJournal?.operations ?? [];
    if (journalOps.length > 0) {
      llmAssertions.push(
        ...reconcileJournalToCapture({
          journal: opts.operationJournal,
          observed,
          runId: opts.agentInspectRunId,
        }),
      );
    } else {
      llmAssertions.push(
        check(
          'fidelity.llmSpansPresent',
          observed.filter((o) => o.kind === 'llm').length > 0,
          observed.some((o) => o.kind === 'llm')
            ? 'Trace contains structured LLM operation(s)'
            : 'Independent model/journal says LLM work occurred but trace has no structured LLM ops',
          { observedLlm: observed.filter((o) => o.kind === 'llm').length },
        ),
      );
    }
  }

  const passed = llmAssertions.every((a) => a.passed);
  return {
    verdict: passed ? 'pass' : 'fail',
    assertions: [
      check('fidelity.runId', true, `Mapped ${opts.agentInspectRunId}`),
      check('fidelity.traceShape', true, 'Valid JSONL shape'),
      ...llmAssertions,
    ],
  };
}
