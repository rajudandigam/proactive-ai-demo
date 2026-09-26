#!/usr/bin/env npx tsx
/**
 * Extended offline suites for P03–P06 workloads (city, evening, orchestration, contracts, lifecycle).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInspector, inspectRun, step, observeOutcome } from 'agent-inspect';
import { fileWriter, memoryWriter, nullWriter } from 'agent-inspect/writers';
import { openTraceFile } from 'agent-inspect/readers';
import { defineTraceContract, evaluateTraceContract } from 'agent-inspect/checks';
import { createRequire } from 'node:module';
import { listSuite, KNOWN_SUITES } from '../../src/playground/scenario-registry';
import {
  createArtifactDir,
  finalizeChecksums,
  writeJson,
} from '../../src/playground/artifact-writer';
import { runCityPlanner } from '../../src/workloads/city-planner';
import { runEveningPlanner } from '../../src/workloads/evening-planner';
import { runCitySupervisorGraph } from '../../src/workloads/city-supervisor.graph';
import { runTravelHelpdesk } from '../../src/workloads/travel-helpdesk';
import { ReservationSimulator } from '../../src/workloads/reservation-simulator';
import { createCounters } from '../../src/providers/types';

const requireAdv = createRequire(__filename);
const { getCurrentRunId } = requireAdv('agent-inspect/advanced') as {
  getCurrentRunId: () => string | undefined;
};

type Row = {
  scenarioId: string;
  overall: 'pass' | 'fail' | 'blocked';
  detail: string;
  artifactDir?: string;
};

async function runCityEvening(batchId: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const s of listSuite('city-evening')) {
    const executionId = randomUUID();
    const artifactDir = createArtifactDir(batchId, s.id, executionId);
    const traceDir = join(artifactDir, 'inspect-traces');
    mkdirSync(traceDir, { recursive: true });
    const lab = s._lab as Record<string, unknown> | undefined;

    if (s.workload === 'city') {
      const result = await runCityPlanner(
        s.request as {
          city: string;
          country?: string;
          date: string;
          radiusMeters?: number;
          limit?: number;
        },
        { toolMode: 'fixture', traceDir, executionId },
      );
      writeJson(artifactDir, 'output.safe.json', result);
      writeJson(artifactDir, 'oracle.json', {
        counters: result.counters,
        method: 'IndependentCounters on fixture providers',
      });
      let ok = true;
      let detail: string = result.status;
      if (lab?.expectStatus && result.status !== lab.expectStatus) {
        ok = false;
        detail = `status ${result.status} != ${lab.expectStatus}`;
      }
      if (
        typeof lab?.minRestaurants === 'number' &&
        (result.restaurants?.length ?? 0) < lab.minRestaurants
      ) {
        ok = false;
        detail = 'too few restaurants';
      }
      if (lab?.expectPlacesInvalid) {
        ok = (result.restaurants?.length ?? 0) === 0;
        detail = ok
          ? 'invalid radius yielded no restaurants'
          : 'expected empty restaurants';
      }
      if (result.counters.geocodeCalls < 1) {
        ok = false;
        detail = 'geocode counter zero';
      }
      writeJson(artifactDir, 'result.json', {
        scenarioId: s.id,
        overallVerdict: ok ? 'pass' : 'fail',
        applicationVerdict: ok ? 'pass' : 'fail',
        captureFidelityVerdict: 'insufficient',
        contractVerdict: 'insufficient',
      });
      finalizeChecksums(artifactDir);
      rows.push({
        scenarioId: s.id,
        overall: ok ? 'pass' : 'fail',
        detail,
        artifactDir,
      });
      continue;
    }

    if (s.workload === 'evening') {
      const result = await runEveningPlanner(
        s.request as { query: string; kind: 'movie' | 'tv' },
        { toolMode: 'fixture', traceDir, executionId },
      );
      writeJson(artifactDir, 'output.safe.json', result);
      writeJson(artifactDir, 'oracle.json', { counters: result.counters });
      let ok = result.status === (lab?.expectStatus ?? 'completed');
      if (
        typeof lab?.minItems === 'number' &&
        (result.items?.length ?? 0) < lab.minItems
      ) {
        ok = false;
      }
      writeJson(artifactDir, 'result.json', {
        scenarioId: s.id,
        overallVerdict: ok ? 'pass' : 'fail',
      });
      finalizeChecksums(artifactDir);
      rows.push({
        scenarioId: s.id,
        overall: ok ? 'pass' : 'fail',
        detail: result.status,
        artifactDir,
      });
    }
  }
  return rows;
}

async function runOrchestration(batchId: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const s of listSuite('orchestration')) {
    const executionId = randomUUID();
    const artifactDir = createArtifactDir(batchId, s.id, executionId);
    const traceDir = join(artifactDir, 'inspect-traces');
    mkdirSync(traceDir, { recursive: true });
    const lab = s._lab as Record<string, unknown> | undefined;

    if (s.workload === 'supervisor') {
      const result = await runCitySupervisorGraph(
        s.request as { city: string; date: string },
        { toolMode: 'fixture', traceDir, executionId },
      );
      writeJson(artifactDir, 'output.safe.json', result);
      const ok = Boolean(result.proposal) && !result.error;
      finalizeChecksums(artifactDir);
      rows.push({
        scenarioId: s.id,
        overall: ok ? 'pass' : 'fail',
        detail: result.proposal ?? result.error ?? 'no proposal',
        artifactDir,
      });
      continue;
    }

    if (s.workload === 'reservation') {
      const counters = createCounters();
      const dataDir = join(artifactDir, 'receipts-db');
      const dropResponse = Boolean(
        (s.request as { dropResponse?: boolean }).dropResponse,
      );
      const sim = new ReservationSimulator(dataDir, counters, dropResponse);
      const key = (s.request as { idempotencyKey: string }).idempotencyKey;
      const resource = (s.request as { resource: string }).resource;

      // Use HTTP path so drop-after-commit is independently observed
      const http = await sim.startHttp(0);
      let agentView:
        | { ok: true; receipt: unknown }
        | { ok: false; uncertain: true; message: string }
        | { ok: false; error: string };
      try {
        agentView = await inspectRun(
          'reservation-hold',
          async () => {
            const result = await step.tool('hold_reservation', async () => {
              try {
                const res = await fetch(`http://127.0.0.1:${http.port}/holds`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ resource, idempotencyKey: key }),
                });
                if (!res.ok && res.status === 0) {
                  return {
                    ok: false as const,
                    uncertain: true as const,
                    message: 'response lost',
                  };
                }
                if (!res.ok) {
                  // network destroy after commit surfaces as fetch failure
                  throw new Error(`HTTP ${res.status}`);
                }
                const receipt = await res.json();
                return { ok: true as const, receipt };
              } catch (err) {
                return {
                  ok: false as const,
                  uncertain: true as const,
                  message:
                    err instanceof Error ? err.message : String(err),
                };
              }
            });
            // Reconcile via receipt store (independent of agent response)
            const receipt = sim.getByIdempotencyKey(key);
            await observeOutcome('reservation_effect', {
              expectation: 'exactly one commit; receipt is authority',
              status: receipt ? 'passed' : 'failed',
              method: 'database',
              actual: {
                agentOk: result.ok,
                receipt,
                commits: counters.reservationCommits,
                writes: counters.reservationWrites,
                drops: counters.reservationResponseDrops,
              },
            });
            return result;
          },
          { silent: true, traceDir, correlationId: executionId },
        );

        // Retry same idempotency key — must not double-commit
        await fetch(`http://127.0.0.1:${http.port}/holds`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resource, idempotencyKey: key }),
        }).catch(() => undefined);
      } finally {
        await http.close();
      }

      const receipt = sim.getByIdempotencyKey(key);
      writeJson(artifactDir, 'output.safe.json', {
        agentView,
        receipt,
        counters,
        runId: getCurrentRunId?.(),
      });
      writeJson(artifactDir, 'oracle.json', {
        method: 'HTTP hold + ReservationSimulator receipt DB',
        receipt,
        counters,
        expectExactCommits: 1,
      });

      const expectUncertain = Boolean(lab?.expectUncertain);
      const uncertainOk = expectUncertain
        ? !agentView.ok && 'uncertain' in agentView
        : true;
      const receiptOk = Boolean(lab?.expectReceiptPresent ? receipt : true);
      const exactCommit = counters.reservationCommits === 1;
      const ok = receiptOk && uncertainOk && exactCommit && Boolean(receipt);

      finalizeChecksums(artifactDir);
      rows.push({
        scenarioId: s.id,
        overall: ok ? 'pass' : 'fail',
        detail: receipt
          ? `receipt=${receipt.receiptId}; commits=${counters.reservationCommits}; writes=${counters.reservationWrites}; drops=${counters.reservationResponseDrops}; uncertain=${expectUncertain ? uncertainOk : 'n/a'}`
          : 'missing receipt',
        artifactDir,
      });
      continue;
    }

    if (s.workload === 'helpdesk') {
      const result = await runTravelHelpdesk(
        (s.request as { question: string }).question,
        { traceDir, executionId },
      );
      writeJson(artifactDir, 'output.safe.json', result);
      const ok = result.status === lab?.expectStatus;
      finalizeChecksums(artifactDir);
      rows.push({
        scenarioId: s.id,
        overall: ok ? 'pass' : 'fail',
        detail: `${result.status}; citations=${result.citations.length}`,
        artifactDir,
      });
    }
  }
  return rows;
}

async function runContracts(batchId: string): Promise<Row[]> {
  const artifactDir = createArtifactDir(batchId, 'S41', randomUUID());
  const traceDir = join(artifactDir, 'inspect-traces');
  mkdirSync(traceDir, { recursive: true });

  const fileW = fileWriter({ dir: traceDir });
  const inspector = createInspector({ writer: fileW, silent: true });
  await inspector.run('contract-pass-run', () =>
    inspector.tool('ping', async () => ({ ok: true })),
  );
  await inspector.flush();
  await inspector.close();

  const files = readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    return [
      {
        scenarioId: 'S41',
        overall: 'fail',
        detail: 'no trace file written',
        artifactDir,
      },
    ];
  }
  const tracePath = join(traceDir, files[0]!);
  writeFileSync(join(artifactDir, 'trace.jsonl'), readFileSync(tracePath));

  const read = await openTraceFile(tracePath);
  const contract = defineTraceContract({
    tools: { required: ['ping'] },
  });
  const evaluated = evaluateTraceContract({ read }, contract);
  writeJson(artifactDir, 'checks.json', evaluated);

  const rulesEvaluated =
    (evaluated as { summary?: { rulesEvaluated?: number } }).summary
      ?.rulesEvaluated ?? 0;
  const checkOk =
    (evaluated as { ok?: boolean }).ok === true &&
    rulesEvaluated > 0 &&
    ((evaluated as { status?: string }).status === 'pass' ||
      (evaluated as { status?: string }).status === 'passed');

  finalizeChecksums(artifactDir);

  // S42: readable completed run with a different tool; require missing tool
  const invalidDir = createArtifactDir(batchId, 'S42', randomUUID());
  const negTraceDir = join(invalidDir, 'inspect-traces');
  mkdirSync(negTraceDir, { recursive: true });
  const negWriter = fileWriter({ dir: negTraceDir });
  const negInspector = createInspector({ writer: negWriter, silent: true });
  await negInspector.run('contract-neg-run', () =>
    negInspector.tool('ping', async () => ({ ok: true })),
  );
  await negInspector.flush();
  await negInspector.close();

  const negFiles = readdirSync(negTraceDir).filter((f) => f.endsWith('.jsonl'));
  const negPath = join(negTraceDir, negFiles[0]!);
  writeFileSync(join(invalidDir, 'trace.jsonl'), readFileSync(negPath));
  const negRead = await openTraceFile(negPath);
  const negContract = defineTraceContract({
    tools: { required: ['must-exist-tool'] },
  });
  const negResult = evaluateTraceContract({ read: negRead }, negContract);
  writeJson(invalidDir, 'checks.json', negResult);

  const findings = (
    negResult as {
      findings?: Array<{
        ruleId?: string;
        message?: string;
        expected?: string;
        status?: string;
      }>;
      summary?: { rulesEvaluated?: number; failed?: number };
      ok?: boolean;
      status?: string;
    }
  ).findings ?? [];
  const negRules =
    (negResult as { summary?: { rulesEvaluated?: number } }).summary
      ?.rulesEvaluated ?? 0;
  const missingToolFinding = findings.find(
    (f) =>
      f.ruleId === 'tool.usage' &&
      (f.expected === 'must-exist-tool' ||
        (f.message ?? '').includes('must-exist-tool')),
  );
  const negOk =
    (negResult as { ok?: boolean }).ok === false &&
    negRules > 0 &&
    Boolean(missingToolFinding);

  writeJson(invalidDir, 'oracle.json', {
    expect: 'tool.usage finding for must-exist-tool with rulesEvaluated > 0',
    observed: {
      ok: (negResult as { ok?: boolean }).ok,
      status: (negResult as { status?: string }).status,
      rulesEvaluated: negRules,
      finding: missingToolFinding ?? null,
    },
  });
  finalizeChecksums(invalidDir);

  return [
    {
      scenarioId: 'S41',
      overall: checkOk ? 'pass' : 'fail',
      detail: checkOk
        ? `programmatic contract pass; rulesEvaluated=${rulesEvaluated}`
        : `contract fail: ${JSON.stringify(evaluated).slice(0, 160)}`,
      artifactDir,
    },
    {
      scenarioId: 'S42',
      overall: negOk ? 'pass' : 'fail',
      detail: negOk
        ? `missing-tool finding: ${missingToolFinding?.message ?? 'ok'}; rulesEvaluated=${negRules}`
        : `expected tool.usage finding not observed (rulesEvaluated=${negRules})`,
      artifactDir: invalidDir,
    },
  ];
}

async function runLifecycle(batchId: string): Promise<Row[]> {
  const artifactDir = createArtifactDir(batchId, 'S34-writers', randomUUID());
  const rows: Row[] = [];

  try {
    // Memory writer — assert events actually received
    const mem = memoryWriter();
    const memInspector = createInspector({ writer: mem, silent: true });
    await memInspector.run('writer-mem', () =>
      memInspector.tool('ping', async () => ({ ok: true })),
    );
    await memInspector.flush();
    const memEvents = mem.getEvents();
    await memInspector.close();
    const memOk = memEvents.length >= 2;

    // Null writer — events counted, no disk files in a dedicated dir
    const nullProbeDir = join(artifactDir, 'null-probe');
    mkdirSync(nullProbeDir, { recursive: true });
    const beforeNull = readdirSync(nullProbeDir);
    const nul = nullWriter();
    const nullInspector = createInspector({ writer: nul, silent: true });
    await nullInspector.run('writer-null', () =>
      nullInspector.tool('ping', async () => ({ ok: true })),
    );
    await nullInspector.flush();
    await nullInspector.close();
    const afterNull = readdirSync(nullProbeDir);
    const nullStats = typeof nul.getStats === 'function' ? nul.getStats() : {
      writtenEvents: 0,
      droppedEvents: 0,
      flushCount: 0,
      lastFlushAt: null as string | null,
    };
    const nullOk =
      nullStats.writtenEvents >= 2 &&
      afterNull.length === beforeNull.length;

    // File writer — persist and reopen
    const fdir = join(artifactDir, 'file-writer');
    mkdirSync(fdir, { recursive: true });
    const file = fileWriter({ dir: fdir });
    const fileInspector = createInspector({ writer: file, silent: true });
    await fileInspector.run('writer-file', () =>
      fileInspector.tool('ping', async () => ({ ok: true })),
    );
    await fileInspector.flush();
    await fileInspector.close();
    const fileTraces = readdirSync(fdir).filter((f) => f.endsWith('.jsonl'));
    let fileOk = fileTraces.length === 1;
    if (fileOk) {
      const read = await openTraceFile(join(fdir, fileTraces[0]!));
      fileOk = (read.events?.length ?? 0) > 0 && (read.runs?.length ?? 0) > 0;
    }

    const ok = memOk && nullOk && fileOk;
    writeJson(artifactDir, 'output.safe.json', {
      memoryEventCount: memEvents.length,
      nullStats,
      nullDirUnchanged: afterNull.length === beforeNull.length,
      fileTraces,
    });
    writeJson(artifactDir, 'oracle.json', {
      method: 'createInspector({ writer }) + getEvents/getStats/openTraceFile',
      memOk,
      nullOk,
      fileOk,
    });
    finalizeChecksums(artifactDir);
    rows.push({
      scenarioId: 'S34',
      overall: ok ? 'pass' : 'fail',
      detail: ok
        ? `mem=${memEvents.length}; nullWritten=${nullStats.writtenEvents}; files=${fileTraces.length}`
        : `memOk=${memOk} nullOk=${nullOk} fileOk=${fileOk}`,
      artifactDir,
    });
  } catch (err) {
    rows.push({
      scenarioId: 'S34',
      overall: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      artifactDir,
    });
  }

  // Redaction canary — require trace + metadata event + redacted secrets + preserved safe field
  const canaryDir = createArtifactDir(batchId, 'S46', randomUUID());
  const canaryTrace = join(canaryDir, 'inspect-traces');
  mkdirSync(canaryTrace, { recursive: true });
  await inspectRun(
    'redaction-canary',
    async () => {
      await step('with_meta', async () => 'ok', {
        metadata: {
          apiKey: 'sk-canary-should-redact',
          password: 'hunter2',
          safeTokenCount: 3,
        },
      } as never);
    },
    { silent: true, traceDir: canaryTrace, redactionProfile: 'share' },
  );
  const files = existsSync(canaryTrace)
    ? readdirSync(canaryTrace).filter((f) => f.endsWith('.jsonl'))
    : [];
  const text = files.length
    ? readFileSync(join(canaryTrace, files[0]!), 'utf8')
    : '';
  if (files[0]) {
    writeFileSync(join(canaryDir, 'trace.jsonl'), text);
  }
  const hasTrace = text.trim().length > 0 && files.length === 1;
  const leaked =
    text.includes('sk-canary-should-redact') || text.includes('hunter2');
  const hasRedacted = text.includes('[REDACTED]');
  const preservedSafe = text.includes('safeTokenCount');
  const redactionOk = hasTrace && !leaked && hasRedacted && preservedSafe;
  writeJson(canaryDir, 'oracle.json', {
    hasTrace,
    leaked,
    hasRedacted,
    preservedSafe,
    note: 'share profile must redact credential-like keys and keep safeTokenCount',
  });
  finalizeChecksums(canaryDir);
  rows.push({
    scenarioId: 'S46',
    overall: redactionOk ? 'pass' : 'fail',
    detail: redactionOk
      ? 'canary redacted; safeTokenCount preserved'
      : `hasTrace=${hasTrace} leaked=${leaked} redacted=${hasRedacted} safe=${preservedSafe}`,
    artifactDir: canaryDir,
  });

  return rows;
}

async function main() {
  const suiteArg = process.argv.includes('--suite')
    ? process.argv[process.argv.indexOf('--suite') + 1]
    : 'all-extended';

  const allowed = new Set([
    'all-extended',
    'city-evening',
    'orchestration',
    'contracts',
    'lifecycle',
    ...KNOWN_SUITES,
  ]);
  if (!suiteArg || !allowed.has(suiteArg)) {
    console.error(
      JSON.stringify({
        error: 'unknown_or_empty_suite',
        suite: suiteArg,
        allowed: [...allowed],
      }),
    );
    process.exit(2);
  }

  const batchId = `batch-ext-${Date.now()}`;
  const all: Row[] = [];

  if (suiteArg === 'city-evening' || suiteArg === 'all-extended') {
    all.push(...(await runCityEvening(batchId)));
  }
  if (suiteArg === 'orchestration' || suiteArg === 'all-extended') {
    all.push(...(await runOrchestration(batchId)));
  }
  if (suiteArg === 'contracts' || suiteArg === 'all-extended') {
    all.push(...(await runContracts(batchId)));
  }
  if (suiteArg === 'lifecycle' || suiteArg === 'all-extended') {
    all.push(...(await runLifecycle(batchId)));
  }

  if (all.length === 0) {
    console.error(
      JSON.stringify({
        error: 'empty_suite',
        suite: suiteArg,
        message: 'No cases executed — refusing green exit',
      }),
    );
    process.exit(2);
  }

  const failed = all.filter((r) => r.overall !== 'pass').length;
  const summaryDir = join(process.cwd(), 'artifacts', batchId);
  mkdirSync(summaryDir, { recursive: true });
  writeJson(summaryDir, 'suite-summary.json', {
    suite: suiteArg,
    batchId,
    failed,
    total: all.length,
    results: all,
  });
  for (const r of all) {
    console.log(JSON.stringify(r));
  }
  console.log(JSON.stringify({ batchId, failed, total: all.length }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
