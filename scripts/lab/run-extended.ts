#!/usr/bin/env npx tsx
/**
 * Extended offline suites for P03–P06 workloads (city, evening, orchestration, contracts, lifecycle).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectRun, step, observeOutcome } from 'agent-inspect';
import { fileWriter, memoryWriter, nullWriter } from 'agent-inspect/writers';
import { createRequire } from 'node:module';
import { listSuite } from '../../src/playground/scenario-registry';
import {
  createArtifactDir,
  finalizeChecksums,
  writeJson,
} from '../../src/playground/artifact-writer';
import { runCityPlanner } from '../../src/workloads/city-planner';
import { runEveningPlanner } from '../../src/workloads/evening-planner';
import { runCitySupervisorGraph } from '../../src/workloads/city-supervisor.graph';
import { runTravelHelpdesk } from '../../src/workloads/travel-helpdesk';
import {
  ReservationSimulator,
} from '../../src/workloads/reservation-simulator';
import { createCounters } from '../../src/providers/types';
import { defineTraceContract, evaluateTraceContract } from 'agent-inspect/checks';

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
      let detail = result.status;
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
        // Invalid radius should fail places but city planner may still complete with empty restaurants
        ok = (result.restaurants?.length ?? 0) === 0;
        detail = ok ? 'invalid radius yielded no restaurants' : 'expected empty restaurants';
      }
      // Independent oracle: counters not taken from AgentInspect
      if (result.counters.geocodeCalls < 1) {
        ok = false;
        detail = 'geocode counter zero';
      }
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
      const sim = new ReservationSimulator(
        dataDir,
        counters,
        Boolean((s.request as { dropResponse?: boolean }).dropResponse),
      );
      const key = (s.request as { idempotencyKey: string }).idempotencyKey;
      const resource = (s.request as { resource: string }).resource;

      const agentView = await inspectRun(
        'reservation-hold',
        async () => {
          const result = await step.tool('hold_reservation', () =>
            sim.hold({ resource, idempotencyKey: key }),
          );
          await observeOutcome('reservation_effect', {
            expectation: 'receipt store is authority when response uncertain',
            status: 'passed',
            method: 'database',
            actual: {
              agentOk: result.ok,
              receipt: sim.getByIdempotencyKey(key),
              counters,
            },
          });
          return result;
        },
        { silent: true, traceDir, correlationId: executionId },
      );

      const receipt = sim.getByIdempotencyKey(key);
      writeJson(artifactDir, 'output.safe.json', { agentView, receipt, counters });
      writeJson(artifactDir, 'oracle.json', {
        method: 'ReservationSimulator receipt DB',
        receipt,
        counters,
      });
      const ok =
        Boolean(lab?.expectReceiptPresent ? receipt : true) &&
        Boolean(lab?.expectUncertain ? !agentView.ok && 'uncertain' in agentView : true) &&
        counters.reservationCommits >= 1;
      finalizeChecksums(artifactDir);
      rows.push({
        scenarioId: s.id,
        overall: ok ? 'pass' : 'fail',
        detail: receipt
          ? `receipt=${receipt.receiptId}; commits=${counters.reservationCommits}`
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

  await inspectRun(
    'contract-pass-run',
    async () => {
      await step.tool('ping', async () => ({ ok: true }));
      await observeOutcome('ping_ok', {
        expectation: 'tool completed',
        status: 'passed',
        method: 'custom',
      });
    },
    { silent: true, traceDir },
  );

  const files = readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
  const tracePath = join(traceDir, files[0]!);
  const events = readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

  const contract = defineTraceContract({
    id: 'playground-basic',
    version: '1.0.0',
    tools: { required: ['ping'] },
  });

  let checkOk = false;
  let checkDetail = '';
  try {
    const evaluated = evaluateTraceContract(contract, {
      events,
    } as never);
    const ev = await Promise.resolve(evaluated);
    writeJson(artifactDir, 'checks.json', ev);
    checkOk = Boolean(
      (ev as { ok?: boolean }).ok === true ||
        (ev as { status?: string }).status === 'pass' ||
        (ev as { status?: string }).status === 'passed',
    );
    checkDetail = JSON.stringify(ev).slice(0, 400);
  } catch (err) {
    try {
      const out = execFileSync(
        'npx',
        [
          '--no-install',
          'agent-inspect',
          'check',
          tracePath,
          '--json',
          '--require-completed',
          '--required-tool',
          'ping',
        ],
        { encoding: 'utf8' },
      );
      writeFileSync(join(artifactDir, 'checks.stdout.txt'), out);
      const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as {
        ok?: boolean;
        status?: string;
      };
      checkOk =
        parsed.ok === true ||
        parsed.status === 'pass' ||
        parsed.status === 'passed';
      checkDetail = 'cli-fallback';
      writeJson(artifactDir, 'checks.json', parsed);
    } catch (e) {
      checkDetail = e instanceof Error ? e.message : String(e);
    }
  }

  // Negative: mutate by removing tool requirement evidence expectation
  const invalidDir = createArtifactDir(batchId, 'S42', randomUUID());
  const invalidTrace = join(invalidDir, 'trace.jsonl');
  writeFileSync(
    invalidTrace,
    JSON.stringify({
      schemaVersion: '0.1',
      event: 'run_started',
      runId: 'run_mutated',
      name: 'empty',
      startTime: Date.now(),
    }) +
      '\n' +
      JSON.stringify({
        schemaVersion: '0.1',
        event: 'run_completed',
        runId: 'run_mutated',
        status: 'completed',
        endTime: Date.now(),
      }) +
      '\n',
  );
  let negOk = false;
  try {
    execFileSync(
      'npx',
      [
        '--no-install',
        'agent-inspect',
        'check',
        invalidTrace,
        '--json',
        '--required-tool',
        'must-exist-tool',
      ],
      { encoding: 'utf8' },
    );
    negOk = false; // should have failed
  } catch {
    negOk = true;
  }
  writeJson(invalidDir, 'oracle.json', {
    expect: 'required-tool failure',
    observed: negOk,
  });
  finalizeChecksums(artifactDir);
  finalizeChecksums(invalidDir);

  return [
    {
      scenarioId: 'S41',
      overall: checkOk ? 'pass' : 'fail',
      detail: checkDetail.slice(0, 120),
      artifactDir,
    },
    {
      scenarioId: 'S42',
      overall: negOk ? 'pass' : 'fail',
      detail: negOk
        ? 'mutated missing-tool detected'
        : 'expected contract failure not observed',
      artifactDir: invalidDir,
    },
  ];
}

async function runLifecycle(batchId: string): Promise<Row[]> {
  const artifactDir = createArtifactDir(batchId, 'S33-writers', randomUUID());
  const rows: Row[] = [];

  // memory / null / file writers via public API when available
  try {
    const mem = memoryWriter();
    const nul = nullWriter();
    const fdir = join(artifactDir, 'file-writer');
    mkdirSync(fdir, { recursive: true });
    const file = fileWriter({ dir: fdir });
    await inspectRun(
      'writer-smoke',
      async () => {
        await step('noop', async () => 1);
      },
      { silent: true, writer: mem as never },
    );
    await inspectRun(
      'writer-null',
      async () => {
        await step('noop', async () => 1);
      },
      { silent: true, writer: nul as never },
    );
    await inspectRun(
      'writer-file',
      async () => {
        await step('noop', async () => 1);
        await observeOutcome('file_writer_ok', {
          expectation: 'persisted',
          status: 'passed',
          method: 'filesystem',
        });
      },
      { silent: true, writer: file as never, traceDir: fdir },
    );
    writeJson(artifactDir, 'output.safe.json', {
      writers: ['memory', 'null', 'file'],
      fileDir: fdir,
    });
    finalizeChecksums(artifactDir);
    rows.push({
      scenarioId: 'S34',
      overall: 'pass',
      detail: 'memory/null/file writers exercised',
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

  // Redaction canary — ensure secret-looking metadata is not blindly echoed in share checks
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
  const leaked = text.includes('sk-canary-should-redact') || text.includes('hunter2');
  writeJson(canaryDir, 'oracle.json', {
    leaked,
    note: 'share profile should redact credential-like keys',
  });
  finalizeChecksums(canaryDir);
  rows.push({
    scenarioId: 'S46',
    overall: leaked ? 'fail' : 'pass',
    detail: leaked ? 'canary leaked into JSONL' : 'canary redacted or absent',
    artifactDir: canaryDir,
  });

  return rows;
}

async function main() {
  const suiteArg = process.argv.includes('--suite')
    ? process.argv[process.argv.indexOf('--suite') + 1]
    : 'all-extended';
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
