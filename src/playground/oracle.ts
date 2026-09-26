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

export function evaluateCaptureFidelity(opts: {
  scenario: ScenarioFile;
  agentInspectRunId?: string;
  traceText?: string | null;
  independentModelCalls: number;
  independentLiveAttempts: number;
}): {
  verdict: 'pass' | 'fail' | 'insufficient';
  assertions: AssertionResult[];
} {
  const assertions: AssertionResult[] = [];
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

  if (!opts.traceText) {
    assertions.push(
      check('fidelity.traceFile', false, 'trace.jsonl missing from artifacts'),
    );
    return { verdict: 'insufficient', assertions };
  }

  assertions.push(
    check(
      'fidelity.traceFile',
      true,
      'trace.jsonl present',
      opts.traceText.length,
    ),
  );

  const looksLikeTrace =
    opts.traceText.includes('run_started') ||
    opts.traceText.includes('step_started') ||
    opts.traceText.includes('"event"') ||
    opts.traceText.includes('runId');

  assertions.push(
    check(
      'fidelity.traceShape',
      looksLikeTrace,
      looksLikeTrace
        ? 'Trace contains run/step markers'
        : 'Trace shape unexpected',
    ),
  );

  if (opts.scenario._lab?.assertNoLlmSteps) {
    const llmMention =
      /"type"\s*:\s*"llm"|step\.llm|"stepType"\s*:\s*"llm"/i.test(
        opts.traceText,
      );
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
    for (const stepName of opts.scenario._lab.assertTraceHasSteps) {
      assertions.push(
        check(
          `fidelity.step.${stepName}`,
          opts.traceText.includes(stepName),
          opts.traceText.includes(stepName)
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
    : assertions.some((a) => a.id === 'fidelity.traceFile' && !a.passed)
      ? 'insufficient'
      : 'fail';
  return { verdict, assertions };
}
