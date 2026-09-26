import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DecisionGraphService } from '../../src/demo/decision.graph';
import { DemoClockService } from '../../src/demo/demo-clock.service';
import { FixtureToolsService } from '../../src/demo/fixture-tools.service';
import { OutboxService } from '../../src/demo/outbox.service';
import { PolicyService } from '../../src/demo/policy.service';
import { ReadToolsService } from '../../src/demo/read-tools.service';
import { DemoTraceService } from '../../src/demo/trace-events.service';
import { TripAttentionAgentService } from '../../src/demo/trip-attention.agent';
import { ValidationService } from '../../src/demo/validation.service';
import { InspectCaptureService } from '../../src/instrumentation/inspect-capture.service';
import { createSessionId } from '../../src/demo/schemas';
import {
  createArtifactDir,
  finalizeChecksums,
  writeJson,
  writeText,
} from '../../src/playground/artifact-writer';
import {
  evaluateApplicationOracle,
  evaluateCaptureFidelity,
} from '../../src/playground/oracle';
import { getScenario, listSuite, ScenarioFile } from '../../src/playground/scenario-registry';
import { OFFLINE_PROFILE, ScenarioResult, VerdictSchema } from '../../src/playground/schemas';
import type { z } from 'zod';

type Verdict = z.infer<typeof VerdictSchema>;

async function createLabModule(traceDir: string) {
  process.env.AGENT_INSPECT = '1';
  process.env.AGENT_INSPECT_TRACE_DIR = traceDir;
  process.env.DECISION_PROVIDER = 'fixture';

  const module: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [
          () => ({
            DECISION_PROVIDER: 'fixture',
            OPENAI_TIMEOUT_MS: '15000',
            AGENT_INSPECT: '1',
            AGENT_INSPECT_TRACE_DIR: traceDir,
          }),
        ],
      }),
    ],
    providers: [
      DemoClockService,
      FixtureToolsService,
      PolicyService,
      ValidationService,
      OutboxService,
      ReadToolsService,
      DemoTraceService,
      InspectCaptureService,
      TripAttentionAgentService,
      DecisionGraphService,
    ],
  }).compile();

  return module;
}

function combineVerdict(
  app: Verdict,
  fidelity: Verdict,
  contract: Verdict,
  expectFailure: boolean,
): Verdict {
  if (app === 'blocked' || fidelity === 'blocked' || contract === 'blocked') {
    return 'blocked';
  }
  if (expectFailure) {
    // Deliberately invalid scenario: overall pass only when a failure was detected
    const detected =
      app === 'fail' || fidelity === 'fail' || contract === 'fail';
    return detected ? 'pass' : 'fail';
  }
  if (app === 'pass' && (fidelity === 'pass' || fidelity === 'insufficient') && contract !== 'fail') {
    // insufficient fidelity is not a green pass for M1 when we expect a trace
    if (fidelity === 'insufficient') return 'fail';
    return contract === 'pass' || contract === 'insufficient' ? 'pass' : 'fail';
  }
  return 'fail';
}

function findTraceFile(traceDir: string, runId: string | undefined): string | null {
  if (!existsSync(traceDir)) return null;
  const entries = readdirSync(traceDir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(traceDir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      const text = readFileSync(full, 'utf8');
      if (!runId || text.includes(runId) || e.name.includes(runId)) return full;
    }
    if (e.isDirectory()) {
      const nested = findTraceFile(full, runId);
      if (nested) return nested;
    }
  }
  // newest jsonl fallback
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => join(traceDir, e.name));
  return files[0] ?? null;
}

function runContractCheck(
  artifactDir: string,
  tracePath: string | null,
  scenario: ScenarioFile,
): { verdict: Verdict; assertions: ScenarioResult['assertions']; raw?: unknown } {
  const assertions: ScenarioResult['assertions'] = [];
  if (!tracePath || !existsSync(tracePath)) {
    assertions.push({
      id: 'contract.trace',
      passed: false,
      message: 'No trace for contract check',
    });
    return { verdict: 'insufficient', assertions };
  }

  try {
    const args = [
      '--no-install',
      'agent-inspect',
      'check',
      tracePath,
      '--json',
      '--require-completed',
    ];
    if (scenario.contract?.forbiddenTools) {
      for (const t of scenario.contract.forbiddenTools) {
        args.push('--forbidden-tool', t);
      }
    }
    if (scenario.contract?.requiredTools) {
      for (const t of scenario.contract.requiredTools) {
        args.push('--required-tool', t);
      }
    }
    const stdout = execFileSync('npx', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeText(artifactDir, 'checks.stdout.txt', stdout);
    let parsed: { status?: string; ok?: boolean } = {};
    try {
      parsed = JSON.parse(stdout) as { status?: string; ok?: boolean };
    } catch {
      // some CLI versions wrap JSON
      const m = stdout.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]) as { status?: string; ok?: boolean };
    }
    writeJson(artifactDir, 'checks.json', parsed);
    const ok =
      parsed.ok === true ||
      parsed.status === 'passed' ||
      parsed.status === 'pass';
    const expectPass = scenario.contract?.expectCheckPass !== false;
    assertions.push({
      id: 'contract.requireCompleted',
      passed: expectPass ? ok : !ok,
      message: expectPass
        ? ok
          ? 'check passed'
          : 'check failed unexpectedly'
        : !ok
          ? 'expected check failure observed'
          : 'check passed but failure was expected',
      observed: parsed,
    });
    return {
      verdict: assertions.every((a) => a.passed) ? 'pass' : 'fail',
      assertions,
      raw: parsed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : '';
    writeText(artifactDir, 'checks.stderr.txt', stderr || message);
    // CLI non-zero often means check failed — parse if possible
    if (stderr || message) {
      try {
        const m = (stderr || message).match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]) as { status?: string; ok?: boolean };
          writeJson(artifactDir, 'checks.json', parsed);
          const ok = parsed.ok === true || parsed.status === 'passed';
          const expectPass = scenario.contract?.expectCheckPass !== false;
          assertions.push({
            id: 'contract.requireCompleted',
            passed: expectPass ? ok : !ok,
            message: 'check CLI exited non-zero',
            observed: parsed,
          });
          return {
            verdict: assertions.every((a) => a.passed) ? 'pass' : 'fail',
            assertions,
            raw: parsed,
          };
        }
      } catch {
        /* fall through */
      }
    }
    assertions.push({
      id: 'contract.requireCompleted',
      passed: false,
      message: `check CLI error: ${message}`,
    });
    return { verdict: 'fail', assertions };
  }
}

export async function runScenario(
  scenarioId: string,
  opts?: { batchId?: string; profileId?: string },
): Promise<ScenarioResult> {
  const scenario = getScenario(scenarioId);
  const profile = OFFLINE_PROFILE;
  const batchId = opts?.batchId ?? `batch-${Date.now()}`;
  const executionId = randomUUID();
  const startedAt = new Date().toISOString();
  const artifactDir = createArtifactDir(batchId, scenario.id, executionId);
  const traceDir = join(artifactDir, 'inspect-traces');
  mkdirSync(traceDir, { recursive: true });

  const module = await createLabModule(traceDir);
  const graph = module.get(DecisionGraphService);
  const outbox = module.get(OutboxService);
  const inspect = module.get(InspectCaptureService);
  outbox.reset();

  const sessionId = createSessionId();

  // S07: seed prior event in same session
  if (scenario._lab?.seedPriorEvent) {
    await graph.run(scenario.request, {
      sessionId,
      forceInspect: true,
      traceDir,
    });
  }

  let result;
  if (scenario._lab?.parallelSibling) {
    const [a] = await Promise.all([
      graph.run(scenario.request, {
        sessionId: createSessionId(),
        runId: executionId,
        forceInspect: true,
        traceDir,
      }),
      graph.run(scenario._lab.parallelSibling, {
        sessionId: createSessionId(),
        forceInspect: true,
        traceDir,
      }),
    ]);
    result = a;
  } else {
    result = await graph.run(scenario.request, {
      sessionId,
      runId: executionId,
      forceInspect: true,
      traceDir,
    });
  }

  const independentOutbox = outbox.getOutbox(result.sessionId ?? sessionId).length;
  const app = evaluateApplicationOracle(scenario, result, independentOutbox);

  const agentInspectRunId =
    result.agentInspectTraceId ?? inspect.getMappedRunId(executionId);
  const tracePath = findTraceFile(traceDir, agentInspectRunId);
  let traceText: string | null = null;
  if (tracePath) {
    traceText = readFileSync(tracePath, 'utf8');
    copyFileSync(tracePath, join(artifactDir, 'trace.jsonl'));
  }

  const fidelity = evaluateCaptureFidelity({
    scenario,
    agentInspectRunId,
    traceText,
    independentModelCalls: result.modelCalls,
    independentLiveAttempts: result.accounting?.liveAttempts ?? 0,
  });

  const contract = runContractCheck(artifactDir, tracePath, scenario);

  const overall = combineVerdict(
    app.verdict,
    fidelity.verdict,
    contract.verdict,
    scenario.expectFailure,
  );

  const finishedAt = new Date().toISOString();
  const allAssertions = [
    ...app.assertions,
    ...fidelity.assertions,
    ...contract.assertions,
  ];

  const scenarioResult: ScenarioResult = {
    batchId,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    executionId,
    profileId: profile.id,
    agentInspectRunId,
    startedAt,
    finishedAt,
    sourceKind: 'physical-execution',
    applicationVerdict: app.verdict,
    captureFidelityVerdict: fidelity.verdict,
    contractVerdict: contract.verdict,
    overallVerdict: overall,
    assertions: allAssertions,
    artifactDir,
  };

  writeJson(artifactDir, 'manifest.json', {
    ...scenarioResult,
    appGitSha: execSafe('git rev-parse HEAD'),
    agentInspectVersion: '6.31.7',
    decisionProvider: 'fixture',
    modelMode: profile.modelMode,
    toolMode: profile.toolMode,
    sourceKind: 'physical-execution',
  });
  writeJson(artifactDir, 'input.safe.json', {
    scenarioId: scenario.id,
    request: scenario.request,
  });
  writeJson(artifactDir, 'output.safe.json', {
    runStatus: result.runStatus,
    modelMode: result.modelMode,
    modelCalls: result.modelCalls,
    outboxWrites: result.outboxWrites,
    accounting: result.accounting,
    decisions: result.decisions.map((d) => ({
      outcome: d.outcome,
      reason: d.reason,
      decidedBy: d.decidedBy,
    })),
    agentInspectTraceId: result.agentInspectTraceId,
  });
  writeJson(artifactDir, 'oracle.json', {
    independentOutboxCount: independentOutbox,
    application: app,
    method: 'Nest OutboxService.getOutbox + ApplicationResult counters',
  });
  writeJson(artifactDir, 'diagnostics.json', {
    agentInspectRunId,
    tracePath,
    assertionFailures: allAssertions.filter((a) => !a.passed),
  });
  writeJson(artifactDir, 'result.json', scenarioResult);
  finalizeChecksums(artifactDir);

  await module.close();
  return scenarioResult;
}

function execSafe(cmd: string): string {
  try {
    return execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export async function runSuite(suite: string): Promise<{
  batchId: string;
  results: ScenarioResult[];
  failed: number;
}> {
  const batchId = `batch-${Date.now()}`;
  const scenarios = listSuite(suite);
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    const r = await runScenario(s.id, { batchId });
    results.push(r);
    console.log(
      JSON.stringify({
        scenario: r.scenarioId,
        overall: r.overallVerdict,
        application: r.applicationVerdict,
        fidelity: r.captureFidelityVerdict,
        contract: r.contractVerdict,
        artifactDir: r.artifactDir,
      }),
    );
  }
  const failed = results.filter((r) => r.overallVerdict !== 'pass').length;
  const summaryDir = join(process.cwd(), 'artifacts', batchId);
  mkdirSync(summaryDir, { recursive: true });
  writeJson(summaryDir, 'suite-summary.json', {
    suite,
    batchId,
    failed,
    total: results.length,
    results: results.map((r) => ({
      scenarioId: r.scenarioId,
      overallVerdict: r.overallVerdict,
      artifactDir: r.artifactDir,
    })),
  });
  return { batchId, results, failed };
}

// CLI
const args = process.argv.slice(2);
async function main() {
  if (args[0] === '--scenario') {
    const id = args[1];
    if (!id) throw new Error('--scenario <id> required');
    const r = await runScenario(id);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.overallVerdict === 'pass' ? 0 : 1);
  }
  if (args[0] === '--suite') {
    const suite = args[1] ?? 'travel-core';
    const { failed, results, batchId } = await runSuite(suite);
    console.log(JSON.stringify({ batchId, failed, total: results.length }, null, 2));
    process.exit(failed === 0 ? 0 : 1);
  }
  console.error('Usage: lab:run -- --scenario S01 | lab:suite -- --suite travel-core');
  process.exit(2);
}

if (require.main === module || process.argv[1]?.includes('lab/run')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
