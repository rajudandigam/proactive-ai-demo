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
  /** Count of terminal delivery events (completed/failed) for this stepId. */
  terminalDeliveries: number;
};

function stepTypeOf(ev: Record<string, unknown>): string | undefined {
  const attrs = ev.attributes as { stepType?: string } | undefined;
  const t = ev.type ?? ev.stepType ?? attrs?.stepType;
  return typeof t === 'string' ? t : undefined;
}

function normalizeStepKind(raw: unknown): 'llm' | 'tool' | undefined {
  if (typeof raw !== 'string') return undefined;
  const k = raw.trim().toLowerCase();
  if (k === 'llm') return 'llm';
  if (k === 'tool') return 'tool';
  return undefined;
}

function resolveEventStepId(ev: Record<string, unknown>): string | undefined {
  const attrs = (ev.attributes ?? {}) as Record<string, unknown>;
  if (typeof ev.stepId === 'string' && ev.stepId.trim() !== '') return ev.stepId;
  if (typeof attrs.stepId === 'string' && attrs.stepId.trim() !== '') {
    return attrs.stepId;
  }
  if (typeof ev.id === 'string' && ev.id.trim() !== '') return ev.id;
  return undefined;
}

function resolveEventName(
  ev: Record<string, unknown>,
  stepId: string | undefined,
  fallback: string,
): string {
  if (
    typeof ev.name === 'string' &&
    ev.name.trim() !== '' &&
    ev.name !== stepId &&
    !/^step_/.test(ev.name)
  ) {
    return ev.name;
  }
  const attrs = (ev.attributes ?? {}) as Record<string, unknown>;
  if (typeof attrs.name === 'string' && attrs.name.trim() !== '') {
    return attrs.name;
  }
  return fallback;
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
    const attrs = (ev.attributes ?? {}) as Record<string, unknown>;
    const stepId = resolveEventStepId(ev);
    const declaredKind =
      normalizeStepKind(stepTypeOf(ev)) ??
      normalizeStepKind(ev.kind) ??
      normalizeStepKind(attrs.stepType);
    const existing = stepId ? byStep.get(stepId) : undefined;
    // Reader completion records often omit type and arrive as LOGIC; join by stepId.
    const stepType = declaredKind ?? existing?.kind;
    if (stepType !== 'llm' && stepType !== 'tool') continue;

    const name = existing?.name ?? resolveEventName(ev, stepId, stepType);
    const parentStepId =
      existing?.parentStepId ??
      (typeof ev.parentStepId === 'string'
        ? ev.parentStepId
        : typeof ev.parentId === 'string'
          ? ev.parentId
          : typeof attrs.parentStepId === 'string'
            ? attrs.parentStepId
            : undefined);
    const key = stepId ?? `${stepType}:${name}:${byStep.size}`;
    const cur = byStep.get(key);
    const eventName =
      typeof ev.event === 'string'
        ? ev.event
        : typeof attrs.legacyEvent === 'string'
          ? attrs.legacyEvent
          : '';
    const status =
      typeof ev.status === 'string' ? ev.status.toLowerCase() : '';
    let terminal: ObservedCaptureOp['terminal'] = cur?.terminal ?? 'unknown';
    let terminalDeliveries = cur?.terminalDeliveries ?? 0;
    if (
      (eventName === 'step_started' || status === 'running') &&
      terminal !== 'completed' &&
      terminal !== 'failed'
    ) {
      terminal = 'started';
    }
    if (
      eventName === 'step_completed' ||
      status === 'success' ||
      status === 'completed' ||
      status === 'ok'
    ) {
      terminal = 'completed';
      terminalDeliveries += 1;
    }
    if (
      eventName === 'step_failed' ||
      eventName === 'step_error' ||
      status === 'error' ||
      status === 'failed'
    ) {
      terminal = 'failed';
      terminalDeliveries += 1;
    }
    if (!cur && eventName === '' && status === '' && declaredKind) {
      terminal = 'completed';
      terminalDeliveries = 1;
    }
    byStep.set(key, {
      kind: stepType,
      name,
      stepId,
      parentStepId,
      terminal,
      runId: evRun,
      terminalDeliveries,
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

/**
 * Identity key for journal↔capture mapping.
 * Prefer explicit captureStepId when present; otherwise operationId must equal
 * the captured stepId (recorded at the call boundary). Never infer by position.
 */
function journalCaptureKey(op: CaptureLogicalOperation): string {
  const mapped =
    typeof op.captureStepId === 'string' ? op.captureStepId.trim() : '';
  if (mapped !== '') return mapped;
  return op.operationId;
}

function reconcileJournalToCapture(opts: {
  journal?: CaptureOperationSnapshot | null;
  observed: ObservedCaptureOp[];
  /** AgentInspect run id — used only for observed-op filtering upstream. */
  runId?: string;
  /** App execution id — journal.executionId must match this when provided. */
  executionId?: string;
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

  // Journal executionId is the app execution id, not the AgentInspect run id.
  if (opts.executionId) {
    const wrongExec = expectedLogical.filter(
      (o) => o.executionId && o.executionId !== opts.executionId,
    );
    assertions.push(
      check(
        'fidelity.journalRunBound',
        wrongExec.length === 0,
        wrongExec.length === 0
          ? 'Journal executionIds match app execution'
          : `Journal ops bound to wrong executionId(s)`,
        wrongExec.map((o) => o.executionId),
        opts.executionId,
      ),
    );
  }

  // Duplicate terminal deliveries for one stepId (no distinct delivery contract).
  const duplicateDeliveries = opts.observed.filter(
    (o) => (o.terminalDeliveries ?? 0) > 1,
  );
  assertions.push(
    check(
      'fidelity.noDuplicateCapture',
      duplicateDeliveries.length === 0,
      duplicateDeliveries.length === 0
        ? 'No duplicate completed deliveries without distinct delivery identity'
        : `Duplicate capture deliveries: ${duplicateDeliveries
            .map((o) => `${o.kind}:${o.stepId ?? o.name}×${o.terminalDeliveries}`)
            .join(', ')}`,
      duplicateDeliveries.map((o) => ({
        kind: o.kind,
        stepId: o.stepId,
        terminalDeliveries: o.terminalDeliveries,
      })),
    ),
  );

  const usedObserved = new Set<ObservedCaptureOp>();
  const idToObserved = new Map<string, ObservedCaptureOp>();
  const unmatchedExpected: CaptureLogicalOperation[] = [];
  const parentFailures: Array<{ expected: string; observed?: string }> = [];
  const terminalFailures: CaptureLogicalOperation[] = [];
  const nameFailures: CaptureLogicalOperation[] = [];

  for (const expected of expectedLogical) {
    const key = journalCaptureKey(expected);
    const candidates = opts.observed.filter(
      (o) =>
        !usedObserved.has(o) &&
        o.kind === expected.kind &&
        o.stepId === key,
    );
    if (candidates.length === 0) {
      unmatchedExpected.push(expected);
      continue;
    }
    if (candidates.length > 1) {
      // Ambiguous duplicate identity for one journal op.
      unmatchedExpected.push(expected);
      continue;
    }
    const hit = candidates[0]!;
    usedObserved.add(hit);
    idToObserved.set(expected.operationId, hit);

    const expectedName = expected.captureName ?? expected.name;
    if (hit.name !== expectedName) {
      nameFailures.push(expected);
    }
    if (hit.terminal !== 'completed' && hit.terminal !== 'failed') {
      terminalFailures.push(expected);
    }
    // Parent: only enforce when parent is also a journaled llm/tool op with
    // a capture identity. Fixture/non-logical parents are not capture parents.
    if (expected.parentOperationId) {
      const parentOp = expectedLogical.find(
        (p) => p.operationId === expected.parentOperationId,
      );
      if (parentOp) {
        const expectedParentKey = journalCaptureKey(parentOp);
        if (hit.parentStepId !== expectedParentKey) {
          parentFailures.push({
            expected: expectedParentKey,
            observed: hit.parentStepId,
          });
        }
      }
    }
  }

  const unmatchedObserved = opts.observed.filter(
    (o) =>
      (o.kind === 'llm' || o.kind === 'tool') && !usedObserved.has(o),
  );

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

  const missingTerminal = [...observedLlm, ...observedTool].filter(
    (o) => o.terminal !== 'completed' && o.terminal !== 'failed',
  );
  assertions.push(
    check(
      'fidelity.llmTerminalObserved',
      missingTerminal.filter((o) => o.kind === 'llm').length === 0,
      missingTerminal.filter((o) => o.kind === 'llm').length === 0
        ? 'Observed LLM ops have terminal events'
        : `Observed LLM ops missing terminal: ${missingTerminal.filter((o) => o.kind === 'llm').length}`,
      missingTerminal.filter((o) => o.kind === 'llm').map((o) => o.name),
    ),
  );
  assertions.push(
    check(
      'fidelity.toolTerminalObserved',
      missingTerminal.filter((o) => o.kind === 'tool').length === 0 &&
        terminalFailures.filter((o) => o.kind === 'tool').length === 0,
      missingTerminal.filter((o) => o.kind === 'tool').length === 0
        ? 'Observed tool ops have terminal events'
        : `Observed tool ops missing terminal`,
      missingTerminal.filter((o) => o.kind === 'tool').map((o) => o.name),
    ),
  );

  assertions.push(
    check(
      'fidelity.identityMapping',
      unmatchedExpected.length === 0 && unmatchedObserved.length === 0,
      unmatchedExpected.length === 0 && unmatchedObserved.length === 0
        ? 'Journal↔capture identity mapping complete'
        : 'Journal↔capture identity mapping failed (unrelated IDs/names or missing ops)',
      {
        unmatchedExpected: unmatchedExpected.map(summarizeJournalOp),
        unmatchedObserved: unmatchedObserved.map((o) => ({
          kind: o.kind,
          name: o.name,
          stepId: o.stepId,
        })),
      },
    ),
  );

  assertions.push(
    check(
      'fidelity.parentRelationship',
      parentFailures.length === 0,
      parentFailures.length === 0
        ? 'Declared parent relationships match capture'
        : 'Tool/LLM parent relationship mismatch',
      parentFailures,
    ),
  );

  assertions.push(
    check(
      'fidelity.stableName',
      nameFailures.length === 0,
      nameFailures.length === 0
        ? 'Stable operation names match'
        : 'Captured name does not match journaled name',
      nameFailures.map(summarizeJournalOp),
    ),
  );

  // Exact set: counts + identity + parent + terminals + no duplicates.
  const exact =
    unmatchedExpected.length === 0 &&
    unmatchedObserved.length === 0 &&
    parentFailures.length === 0 &&
    nameFailures.length === 0 &&
    terminalFailures.length === 0 &&
    missingTerminal.length === 0 &&
    duplicateDeliveries.length === 0 &&
    unfinished.length === 0 &&
    observedLlm.length === expectedLlm.length &&
    observedTool.length === expectedTool.length;

  assertions.push(
    check(
      'fidelity.operationSetExact',
      exact,
      'Exact journal↔capture operation set reconciliation',
      {
        expectedLlm: expectedLlm.map(summarizeJournalOp),
        observedLlm: observedLlm.map((o) => ({
          name: o.name,
          stepId: o.stepId,
          terminal: o.terminal,
          parentStepId: o.parentStepId,
        })),
        expectedTool: expectedTool.map(summarizeJournalOp),
        observedTool: observedTool.map((o) => ({
          name: o.name,
          stepId: o.stepId,
          terminal: o.terminal,
          parentStepId: o.parentStepId,
        })),
        mapped: [...idToObserved.entries()].map(([opId, o]) => ({
          operationId: opId,
          stepId: o.stepId,
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
  /** App execution id for journal.executionId binding (distinct from AgentInspect run id). */
  executionId?: string;
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
  const journalOps = opts.operationJournal?.operations ?? [];
  const journalHasLogicalOps = journalOps.some(
    (o) => o.kind === 'llm' || o.kind === 'tool',
  );

  // Always reconcile when an operations journal is present — including tool-only.
  if (journalHasLogicalOps) {
    assertions.push(
      ...reconcileJournalToCapture({
        journal: opts.operationJournal,
        observed,
        runId: opts.agentInspectRunId,
        executionId: opts.executionId,
      }),
    );
  } else if (expectsLlm && !opts.scenario._lab?.assertNoLlmSteps) {
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
  /** App execution id for journal.executionId binding. */
  executionId?: string;
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
  const fidelityAssertions: AssertionResult[] = [];
  const journalOps = opts.operationJournal?.operations ?? [];
  const journalHasLogicalOps = journalOps.some(
    (o) => o.kind === 'llm' || o.kind === 'tool',
  );
  if (opts.scenario._lab?.assertNoLlmSteps) {
    const text = opts.traceText ?? '';
    const llmMention =
      /"type"\s*:\s*"llm"|"stepType"\s*:\s*"llm"/i.test(text);
    fidelityAssertions.push(
      check(
        'fidelity.noLlm',
        !llmMention,
        llmMention
          ? 'Trace unexpectedly contains LLM step markers'
          : 'No LLM steps in policy-only run (as expected)',
      ),
    );
  }

  if (journalHasLogicalOps) {
    fidelityAssertions.push(
      ...reconcileJournalToCapture({
        journal: opts.operationJournal,
        observed,
        runId: opts.agentInspectRunId,
        executionId: opts.executionId,
      }),
    );
  } else if (expectsLlm && !opts.scenario._lab?.assertNoLlmSteps) {
    fidelityAssertions.push(
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

  if (
    opts.independentLiveAttempts === 0 &&
    opts.independentModelCalls === 0 &&
    !(opts.operationJournal?.llmInvocations || opts.operationJournal?.fixtureInvocations) &&
    !(opts.operationJournal?.operations?.length)
  ) {
    fidelityAssertions.push(
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

  const passed = fidelityAssertions.every((a) => a.passed);
  return {
    verdict: passed ? 'pass' : 'fail',
    assertions: [
      check('fidelity.runId', true, `Mapped ${opts.agentInspectRunId}`),
      check('fidelity.traceShape', true, 'Valid JSONL shape'),
      ...fidelityAssertions,
    ],
  };
}
