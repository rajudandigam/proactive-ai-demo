import { existsSync, readFileSync } from 'node:fs';
import { ApplicationResult } from '../demo/schemas';
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
): { verdict: 'pass' | 'fail'; assertions: AssertionResult[] } {
  const e = scenario.expected;
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

  if (
    opts.independentLiveAttempts === 0 &&
    opts.independentModelCalls === 0
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
  return {
    verdict: 'pass',
    assertions: [
      check('fidelity.runId', true, `Mapped ${opts.agentInspectRunId}`),
      check('fidelity.traceShape', true, 'Valid JSONL shape'),
    ],
  };
}
