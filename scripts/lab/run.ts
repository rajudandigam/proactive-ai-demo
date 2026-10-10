import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
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
import { CaptureOperationJournal } from '../../src/instrumentation/capture-operation-journal';
import { InspectCaptureService } from '../../src/instrumentation/inspect-capture.service';
import { createSessionId, type ApplicationResult } from '../../src/demo/schemas';
import {
  createArtifactDir,
  writeJson,
  writeText,
} from '../../src/playground/artifact-writer';
import {
  collectProvenance,
  describeThrown,
  finalizeNativeBundle,
  type BundleProvenance,
  type NativeBundleGate,
  type ThrownErrorInfo,
} from '../../src/playground/native-bundle';
import { resolveScenarioExpected } from '../../src/playground/expected-profile';
import {
  evaluateApplicationOracle,
  evaluateCaptureFidelity,
} from '../../src/playground/oracle';
import {
  getScenario,
  listSuite,
  ScenarioFile,
  TRAVEL_CORE_EXPECTED_COUNT,
  KNOWN_SUITES,
} from '../../src/playground/scenario-registry';
import {
  OFFLINE_PROFILE,
  PROFILES,
  resolveProfile,
  ScenarioResult,
  VerdictSchema,
  type RunProfile,
} from '../../src/playground/schemas';
import type { z } from 'zod';

type Verdict = z.infer<typeof VerdictSchema>;

/** Load .env without overriding already-set process.env (for live profiles). */
function loadEnvFile() {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile();

function installedAgentInspectVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(process.cwd(), 'node_modules', 'agent-inspect', 'package.json'),
        'utf8',
      ),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function createLabModule(traceDir: string, profile: RunProfile) {
  const decisionProvider =
    profile.modelMode === 'live' ? 'live' : 'fixture';
  process.env.AGENT_INSPECT = '1';
  process.env.AGENT_INSPECT_TRACE_DIR = traceDir;
  process.env.DECISION_PROVIDER = decisionProvider;

  const module: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [
          () => ({
            DECISION_PROVIDER: decisionProvider,
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
      CaptureOperationJournal,
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
  expectedFailureCode: string | undefined,
  assertions: ScenarioResult['assertions'],
): Verdict {
  if (app === 'blocked' || fidelity === 'blocked' || contract === 'blocked') {
    return 'blocked';
  }
  if (expectFailure) {
    if (expectedFailureCode) {
      const matched = assertions.some(
        (a) =>
          !a.passed &&
          (a.id === expectedFailureCode ||
            a.id.includes(expectedFailureCode) ||
            a.message.includes(expectedFailureCode) ||
            JSON.stringify(a.observed ?? {}).includes(expectedFailureCode)),
      );
      return matched ? 'pass' : 'fail';
    }
    const detected =
      app === 'fail' || fidelity === 'fail' || contract === 'fail';
    return detected ? 'pass' : 'fail';
  }
  if (
    app === 'pass' &&
    (fidelity === 'pass' || fidelity === 'insufficient') &&
    contract !== 'fail'
  ) {
    if (fidelity === 'insufficient') return 'fail';
    return contract === 'pass' || contract === 'insufficient' ? 'pass' : 'fail';
  }
  return 'fail';
}

/** Locate a JSONL whose contents bind the mapped run id — no arbitrary fallback. */
function findTraceFile(
  traceDir: string,
  runId: string | undefined,
): string | null {
  if (!runId || !existsSync(traceDir)) return null;
  const matches: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const text = readFileSync(full, 'utf8');
      if (text.includes(runId) || e.name.includes(runId)) {
        matches.push(full);
      }
    }
  };
  walk(traceDir);
  return matches[0] ?? null;
}

function listTraceFiles(traceDir: string): string[] {
  if (!existsSync(traceDir)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(traceDir);
  return out;
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
    let parsed: {
      status?: string;
      ok?: boolean;
      summary?: { rulesEvaluated?: number };
    } = {};
    try {
      parsed = JSON.parse(stdout) as typeof parsed;
    } catch {
      const m = stdout.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]) as typeof parsed;
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
    const stdout =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout)
        : '';
    writeText(artifactDir, 'checks.stderr.txt', stderr || message);
    if (stdout) writeText(artifactDir, 'checks.stdout.txt', stdout);
    const combined = `${stdout}\n${stderr}\n${message}`;
    try {
      const m = combined.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]) as {
          status?: string;
          ok?: boolean;
          code?: string;
          summary?: { rulesEvaluated?: number };
        };
        writeJson(artifactDir, 'checks.json', parsed);
        // Unreadable traces with zero rules must not satisfy expectCheckPass=false
        const rules = parsed.summary?.rulesEvaluated ?? 0;
        if (parsed.code === 'AI_CHECK_TRACE_UNREADABLE' || rules === 0) {
          assertions.push({
            id: 'contract.requireCompleted',
            passed: false,
            message:
              'CLI reported unreadable/zero-rules failure — not a semantic contract rejection',
            observed: parsed,
          });
          return { verdict: 'fail', assertions, raw: parsed };
        }
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
    assertions.push({
      id: 'contract.requireCompleted',
      passed: false,
      message: `check CLI error: ${message}`,
    });
    return { verdict: 'fail', assertions };
  }
}

/** Default native bundle verification is a harness gate, not advisory. */
export function applyBundleGate(
  result: ScenarioResult,
  gate: NativeBundleGate,
): ScenarioResult {
  const issueCodes = [
    ...gate.verify.issues.map((i) => i.code),
    ...gate.provenanceIssues.map((i) => i.code),
    ...gate.checksumProblems.map(() => 'checksum_problem'),
  ];
  const bundleGate: NonNullable<ScenarioResult['bundleGate']> = {
    ok: gate.ok,
    identityRunId: gate.identityRunId,
    verifyStatus: gate.verify.status,
    issueCodes,
    reportPath: gate.reportPath,
  };
  const assertion = {
    id: 'bundle.verify',
    passed: gate.ok,
    message: gate.ok
      ? 'default native bundle verification passed'
      : 'default native bundle verification failed',
    observed: {
      verify: gate.verify,
      checksumProblems: gate.checksumProblems,
      provenanceIssues: gate.provenanceIssues,
    },
  };
  return {
    ...result,
    overallVerdict:
      gate.ok || result.overallVerdict === 'blocked'
        ? result.overallVerdict
        : 'fail',
    assertions: [...result.assertions, assertion],
    bundleGate,
  };
}

export async function runScenario(
  scenarioId: string,
  opts?: { batchId?: string; profileId?: string },
): Promise<ScenarioResult> {
  const scenario = getScenario(scenarioId);
  const profile = resolveProfile(opts?.profileId ?? OFFLINE_PROFILE.id);
  const batchId = opts?.batchId ?? `batch-${Date.now()}`;
  // Identity is allocated before any provider/tool work so every path
  // (success, returned failure, thrown, blocked) is bound to it.
  const executionId = randomUUID();
  const startedAt = new Date().toISOString();
  const artifactDir = createArtifactDir(batchId, scenario.id, executionId);
  const traceDir = join(artifactDir, 'inspect-traces');
  mkdirSync(traceDir, { recursive: true });
  const resolvedExpected = resolveScenarioExpected(scenario, profile.id);
  const provenanceBase = {
    executionId,
    scenarioPayload: scenario,
    oracleExpected: resolvedExpected,
    config: profile,
  };

  if (profile.modelMode === 'live' && !process.env.OPENAI_API_KEY) {
    const blocked: ScenarioResult = {
      batchId,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      executionId,
      profileId: profile.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceKind: 'physical-execution',
      applicationVerdict: 'blocked',
      captureFidelityVerdict: 'blocked',
      contractVerdict: 'blocked',
      overallVerdict: 'blocked',
      assertions: [],
      artifactDir,
      blockedReason: 'OPENAI_API_KEY missing for live-model profile',
    };
    writeJson(artifactDir, 'result.json', blocked);
    const gate = finalizeNativeBundle({
      bundleDir: artifactDir,
      scenarioId: scenario.id,
      profileId: profile.id,
      provenance: collectProvenance(provenanceBase),
      note: 'Playground lab pack (blocked) — local-only; not share-checked.',
    });
    return applyBundleGate(blocked, gate);
  }

  const module = await createLabModule(traceDir, profile);
  const graph = module.get(DecisionGraphService);
  const outbox = module.get(OutboxService);
  const inspect = module.get(InspectCaptureService);
  const captureJournal = module.get(CaptureOperationJournal);
  outbox.reset();

  const sessionId = createSessionId();

  let result: ApplicationResult | undefined;
  let siblingResult: ApplicationResult | undefined;
  let thrown: ThrownErrorInfo | undefined;
  try {
    if (scenario._lab?.seedPriorEvent) {
      await graph.run(scenario.request, {
        sessionId,
        forceInspect: true,
        traceDir,
      });
    }

    if (scenario._lab?.parallelSibling) {
      const [a, b] = await Promise.all([
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
      siblingResult = b;
    } else {
      result = await graph.run(scenario.request, {
        sessionId,
        runId: executionId,
        forceInspect: true,
        traceDir,
      });
    }
  } catch (err) {
    // The application error is recorded (bounded, redacted), never swallowed:
    // the pack is finalized with failure identity and the verdict is fail.
    thrown = describeThrown(err);
  }

  const independentOutbox = outbox.getOutbox(result?.sessionId ?? sessionId)
    .length;
  const app: { verdict: Verdict; assertions: ScenarioResult['assertions'] } =
    result
      ? evaluateApplicationOracle(scenario, result, independentOutbox, {
          profileId: profile.id,
          expected: resolvedExpected,
        })
      : {
          verdict: 'fail',
          assertions: [
            {
              id: 'application.thrown',
              passed: false,
              message: `Application threw ${thrown?.name}: ${thrown?.message}`,
              observed: thrown,
            },
          ],
        };
  const operationJournal = captureJournal.snapshot(executionId);

  const agentInspectRunId =
    result?.agentInspectTraceId ??
    inspect.getMappedRunId(executionId) ??
    (thrown ? inspect.resolveRunIdFromTraceDir(traceDir, executionId) : undefined);
  const tracePath = findTraceFile(traceDir, agentInspectRunId);
  if (tracePath) {
    copyFileSync(tracePath, join(artifactDir, 'trace.jsonl'));
  }

  const fidelity: { verdict: Verdict; assertions: ScenarioResult['assertions'] } =
    result
      ? await evaluateCaptureFidelity({
          scenario,
          agentInspectRunId,
          executionId,
          tracePath,
          independentModelCalls: result.modelCalls,
          independentLiveAttempts: result.accounting?.liveAttempts ?? 0,
          operationJournal,
        })
      : { verdict: 'insufficient', assertions: [] };

  // S08: both concurrent sessions must produce distinct traces
  if (siblingResult && result) {
    const allTraces = listTraceFiles(traceDir);
    const siblingRunId = siblingResult.agentInspectTraceId;
    const siblingTrace = findTraceFile(traceDir, siblingRunId);
    const distinct =
      allTraces.length >= 2 &&
      Boolean(siblingTrace) &&
      siblingTrace !== tracePath &&
      result.sessionId !== siblingResult.sessionId;
    fidelity.assertions.push({
      id: 'fidelity.concurrentSessions',
      passed: distinct,
      message: distinct
        ? `Two distinct traces/sessions (${allTraces.length} files)`
        : `Expected two distinct session traces; got ${allTraces.length} files`,
      observed: {
        primaryRunId: agentInspectRunId,
        siblingRunId,
        sessionA: result.sessionId,
        sessionB: siblingResult.sessionId,
        traceCount: allTraces.length,
      },
    });
    if (!distinct) {
      fidelity.verdict = 'fail';
    }
  }

  const contract = runContractCheck(artifactDir, tracePath, scenario);

  const allAssertions = [
    ...app.assertions,
    ...fidelity.assertions,
    ...contract.assertions,
  ];

  // A thrown application error is never an acceptable (even expected-failure)
  // pass: the pack is preserved for review but the verdict stays fail.
  const overall = thrown
    ? 'fail'
    : combineVerdict(
        app.verdict,
        fidelity.verdict,
        contract.verdict,
        scenario.expectFailure,
        scenario.expectedFailureCode,
        allAssertions,
      );

  const finishedAt = new Date().toISOString();
  const provenance: BundleProvenance = collectProvenance({
    ...provenanceBase,
    agentInspectRunId,
  });

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
    ...(thrown ? { thrownError: thrown } : {}),
  };

  writeJson(artifactDir, 'manifest.json', {
    ...scenarioResult,
    appGitSha: provenance.app.gitSha,
    appDirty: provenance.app.dirty,
    agentInspectVersion: provenance.agentInspect.installedVersion,
    lockfileSha256: provenance.lockfileSha256,
    decisionProvider: profile.modelMode === 'live' ? 'live' : 'fixture',
    modelMode: profile.modelMode,
    toolMode: profile.toolMode,
    profileId: profile.id,
    sourceKind: 'physical-execution',
  });
  writeJson(artifactDir, 'input.safe.json', {
    scenarioId: scenario.id,
    request: scenario.request,
  });
  writeJson(
    artifactDir,
    'output.safe.json',
    result
      ? {
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
          sibling:
            siblingResult == null
              ? undefined
              : {
                  sessionId: siblingResult.sessionId,
                  agentInspectTraceId: siblingResult.agentInspectTraceId,
                  outboxWrites: siblingResult.outboxWrites,
                },
        }
      : {
          runStatus: 'failed',
          thrown: true,
          error: thrown,
          agentInspectRunId,
        },
  );
  if (thrown) {
    writeJson(artifactDir, 'error.json', {
      executionId,
      agentInspectRunId,
      error: thrown,
    });
  }
  writeJson(artifactDir, 'capture-journal.json', operationJournal ?? {
    llmInvocations: 0,
    fixtureInvocations: 0,
  });
  writeJson(artifactDir, 'oracle.json', {
    independentOutboxCount: independentOutbox,
    profileId: profile.id,
    resolvedExpected,
    application: app,
    method: 'Nest OutboxService.getOutbox + ApplicationResult counters',
  });
  writeJson(artifactDir, 'diagnostics.json', {
    agentInspectRunId,
    tracePath: tracePath ? relative(process.cwd(), tracePath) : null,
    assertionFailures: allAssertions.filter((a) => !a.passed),
  });
  writeJson(artifactDir, 'result.json', scenarioResult);

  // evidence.json is the last file written into the bundle; checksums and the
  // verification report go to the ancillary dir next to it.
  const gate = finalizeNativeBundle({
    bundleDir: artifactDir,
    scenarioId: scenario.id,
    profileId: profile.id,
    provenance,
  });

  await module.close();
  return applyBundleGate(scenarioResult, gate);
}

export async function runSuite(
  suite: string,
  opts?: { profileId?: string },
): Promise<{
  batchId: string;
  results: ScenarioResult[];
  failed: number;
}> {
  if (!(KNOWN_SUITES as readonly string[]).includes(suite)) {
    throw new Error(
      `Unknown suite: ${suite}. Known: ${KNOWN_SUITES.join(', ')}`,
    );
  }
  const scenarios = listSuite(suite);
  if (suite === 'travel-core' && scenarios.length !== TRAVEL_CORE_EXPECTED_COUNT) {
    throw new Error(
      `travel-core expected ${TRAVEL_CORE_EXPECTED_COUNT} cases, found ${scenarios.length}`,
    );
  }
  const batchId = `batch-${Date.now()}`;
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    const r = await runScenario(s.id, {
      batchId,
      profileId: opts?.profileId,
    });
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
  if (results.length === 0) {
    throw new Error(`Suite ${suite} produced zero results`);
  }
  const failed = results.filter((r) => r.overallVerdict !== 'pass').length;
  const summaryDir = join(process.cwd(), 'artifacts', batchId);
  mkdirSync(summaryDir, { recursive: true });
  writeJson(summaryDir, 'suite-summary.json', {
    suite,
    batchId,
    failed,
    total: results.length,
    expectedTotal:
      suite === 'travel-core' ? TRAVEL_CORE_EXPECTED_COUNT : results.length,
    profileId: opts?.profileId ?? OFFLINE_PROFILE.id,
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

function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const resultFile = flagValue('--result-file');
  const profileId = flagValue('--profile') ?? OFFLINE_PROFILE.id;

  if (args[0] === '--scenario') {
    const id = args[1];
    if (!id) throw new Error('--scenario <id> required');
    const r = await runScenario(id, { profileId });
    const text = JSON.stringify(r, null, 2);
    if (resultFile) {
      mkdirSync(dirname(resultFile), { recursive: true });
      writeFileSync(resultFile, text + '\n');
    }
    console.log(text);
    process.exit(r.overallVerdict === 'pass' ? 0 : 1);
  }
  if (args[0] === '--suite') {
    const suite = args[1] ?? 'travel-core';
    try {
      const { failed, results, batchId } = await runSuite(suite, { profileId });
      const summary = { batchId, failed, total: results.length, profileId };
      if (resultFile) {
        writeFileSync(resultFile, JSON.stringify(summary, null, 2) + '\n');
      }
      console.log(JSON.stringify(summary, null, 2));
      process.exit(failed === 0 ? 0 : 1);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  }
  console.error(
    `Usage: lab:run -- --scenario S01 [--profile offline] [--result-file path]\n` +
      `Profiles: ${Object.keys(PROFILES).join(', ')}`,
  );
  process.exit(2);
}

if (require.main === module || process.argv[1]?.includes('lab/run')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
