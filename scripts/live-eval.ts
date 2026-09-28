#!/usr/bin/env npx tsx
/**
 * Opt-in live evaluation. Loads .env before checking DECISION_PROVIDER.
 *
 * Live model output varies even at temperature 0. Invariants check
 * application guarantees and acceptable judgment shape, not exact wording.
 */
import 'reflect-metadata';
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DecisionGraphService } from '../src/demo/decision.graph';
import { OutboxService } from '../src/demo/outbox.service';
import { FixtureToolsService } from '../src/demo/fixture-tools.service';
import { ApplicationResult, createSessionId } from '../src/demo/schemas';
import { InspectCaptureService } from '../src/instrumentation/inspect-capture.service';
import {
  allowlistModelDecisions,
  extractUnsupportedAction,
  type LiveEvalFailurePacket,
} from './live-eval-packet';

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

type CaseResult = {
  case: string;
  ok: boolean;
  category?: 'pass' | 'provider_error' | 'validation_reject' | 'invariant_miss';
  detail?: string;
  elapsedMs?: number;
  runStatus?: string;
  modelCalls?: number;
  outboxWrites?: number;
  accounting?: ApplicationResult['accounting'];
  decisions?: Array<{ outcome: string; reason: string }>;
  agentInspectRunId?: string;
  failurePacketPath?: string;
  error?: string;
};

function hasReason(r: ApplicationResult, reason: string) {
  return r.decisions.some((d) => d.reason === reason);
}

function beforeDepartureInvariant(r: ApplicationResult): {
  ok: boolean;
  category: CaseResult['category'];
  detail: string;
} {
  if (!hasReason(r, 'ARRIVAL_GUIDANCE_NOT_DUE')) {
    return {
      ok: false,
      category: 'invariant_miss',
      detail: 'Expected application wait for arrival guidance',
    };
  }
  if (!hasReason(r, 'HOTEL_ALREADY_BOOKED')) {
    return {
      ok: false,
      category: 'invariant_miss',
      detail: 'Expected application silence for booked hotel',
    };
  }
  if (r.modelCalls < 1) {
    return {
      ok: false,
      category: 'invariant_miss',
      detail: 'Expected at least one live model call for optional candidates',
    };
  }

  const validationFail = r.decisions.find((d) => d.outcome === 'failure');
  if (validationFail) {
    return {
      ok: false,
      category: 'validation_reject',
      detail: `Model proposal rejected: ${validationFail.reason}`,
    };
  }

  const coveredOptional = r.decisions.some(
    (d) =>
      (d.outcome === 'act_now' || d.outcome === 'silent') &&
      d.decidedBy === 'model',
  );
  if (!coveredOptional) {
    return {
      ok: false,
      category: 'invariant_miss',
      detail: 'Expected model-resolved optional decisions',
    };
  }

  return {
    ok: true,
    category: 'pass',
    detail:
      r.outboxWrites >= 1
        ? 'App waits/silence + optional act preview'
        : 'App waits/silence + model resolved optional candidates (no preview this run)',
  };
}

function quietHoursInvariant(r: ApplicationResult): {
  ok: boolean;
  category: CaseResult['category'];
  detail: string;
} {
  if (r.modelCalls !== 0 || (r.accounting?.liveAttempts ?? 0) !== 0) {
    return {
      ok: false,
      category: 'invariant_miss',
      detail: 'Quiet hours must make zero live model calls',
    };
  }
  if (!r.decisions.every((d) => d.reason === 'QUIET_HOURS')) {
    return {
      ok: false,
      category: 'invariant_miss',
      detail: 'Expected QUIET_HOURS defer for optional candidates',
    };
  }
  return { ok: true, category: 'pass', detail: 'Zero model calls; deferred wait' };
}

function findTraceForRun(traceDir: string, runId?: string): string | null {
  if (!runId || !existsSync(traceDir)) return null;
  for (const name of readdirSync(traceDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(traceDir, name);
    const text = readFileSync(full, 'utf8');
    if (text.includes(runId) || name.includes(runId)) return full;
  }
  return null;
}

function runContractSummary(tracePath: string | null): unknown {
  if (!tracePath || !existsSync(tracePath)) {
    return { status: 'skipped', reason: 'no trace file' };
  }
  try {
    const stdout = execFileSync(
      'npx',
      ['--no-install', 'agent-inspect', 'check', tracePath, '--json', '--require-completed'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    try {
      return JSON.parse(stdout);
    } catch {
      const m = stdout.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : { raw: stdout.slice(0, 2000) };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stdout =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout)
        : '';
    try {
      const m = `${stdout}\n${message}`.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch {
      /* fall through */
    }
    return { status: 'error', message };
  }
}

function writeFailurePacket(
  recordingsDir: string,
  packet: LiveEvalFailurePacket,
): string {
  const path = join(
    recordingsDir,
    `live-eval-failure-${packet.case}-${Date.now()}.json`,
  );
  writeFileSync(path, JSON.stringify(packet, null, 2) + '\n');
  return path;
}

async function main() {
  loadEnvFile();
  if ((process.env.DECISION_PROVIDER ?? '').toLowerCase() !== 'live') {
    console.error('Set DECISION_PROVIDER=live in .env to run live eval.');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is required for live eval.');
    process.exit(1);
  }

  const repeat = process.argv.includes('--repeat') ? 2 : 1;
  const recordingsDir = join(process.cwd(), 'recordings');
  const traceDir = join(recordingsDir, `live-traces-${Date.now()}`);
  mkdirSync(traceDir, { recursive: true });
  process.env.AGENT_INSPECT = '1';
  process.env.AGENT_INSPECT_TRACE_DIR = traceDir;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const graph = app.get(DecisionGraphService);
  const outbox = app.get(OutboxService);
  const fixtures = app.get(FixtureToolsService);
  const inspect = app.get(InspectCaptureService);

  const cases = [
    {
      name: 'before-departure',
      file: 'trip-review.json',
      check: beforeDepartureInvariant,
    },
    {
      name: 'quiet-hours',
      request: {
        eventId: `live-quiet-${Date.now()}`,
        tripId: 'trip-jordan',
        type: 'TRIP_REVIEW',
        scenarioId: 'jordan-quiet-hours',
        signals: [
          { id: 'preparation-1', type: 'TRIP_PREPARATION' },
          { id: 'weather-1', type: 'WEATHER_UPDATE' },
        ],
      },
      check: quietHoursInvariant,
    },
  ];

  const results: CaseResult[] = [];
  let failed = 0;

  for (let i = 0; i < repeat; i++) {
    for (const c of cases) {
      outbox.reset();
      fixtures.reset();
      const body = c.file
        ? JSON.parse(
            readFileSync(
              join(process.cwd(), 'fixtures', 'requests', c.file),
              'utf8',
            ),
          )
        : structuredClone(c.request);
      body.eventId = `${body.eventId}-live-${i}-${Date.now()}`;
      const started = Date.now();
      try {
        const result = await graph.run(body, {
          sessionId: createSessionId(),
          forceInspect: true,
          traceDir,
        });
        const checked = c.check(result);
        const agentInspectRunId =
          result.agentInspectTraceId ??
          inspect.getMappedRunId(result.runId ?? '');
        const tracePath = findTraceForRun(traceDir, agentInspectRunId);

        let failurePacketPath: string | undefined;
        if (!checked.ok) {
          const packet: LiveEvalFailurePacket = {
            schemaVersion: 'proactive-ai-demo/live-eval-failure/1',
            recordedAt: new Date().toISOString(),
            case: c.name,
            ok: false,
            category: checked.category ?? 'invariant_miss',
            detail: checked.detail,
            agentInspectRunId,
            tracePath: tracePath ?? undefined,
            application: {
              runStatus: result.runStatus,
              modelMode: result.modelMode,
              modelCalls: result.modelCalls,
              outboxWrites: result.outboxWrites,
              failureReason: result.failureReason,
              accounting: result.accounting,
              decisions: result.decisions.map((d) => ({
                outcome: d.outcome,
                reason: d.reason,
              })),
              allowlistedProposals: allowlistModelDecisions(result),
            },
            unsupportedAction: extractUnsupportedAction(result),
            contractSummary: runContractSummary(tracePath),
          };
          failurePacketPath = writeFailurePacket(recordingsDir, packet);
        }

        if (!checked.ok) failed += 1;
        results.push({
          case: c.name,
          ok: checked.ok,
          category: checked.category,
          detail: checked.detail,
          elapsedMs: Date.now() - started,
          runStatus: result.runStatus,
          modelCalls: result.modelCalls,
          outboxWrites: result.outboxWrites,
          accounting: result.accounting,
          decisions: result.decisions.map((d) => ({
            outcome: d.outcome,
            reason: d.reason,
          })),
          agentInspectRunId,
          failurePacketPath,
        });
      } catch (err) {
        failed += 1;
        const packet: LiveEvalFailurePacket = {
          schemaVersion: 'proactive-ai-demo/live-eval-failure/1',
          recordedAt: new Date().toISOString(),
          case: c.name,
          ok: false,
          category: 'provider_error',
          error: err instanceof Error ? err.message : String(err),
          application: {},
        };
        const failurePacketPath = writeFailurePacket(recordingsDir, packet);
        results.push({
          case: c.name,
          ok: false,
          category: 'provider_error',
          error: err instanceof Error ? err.message : String(err),
          failurePacketPath,
        });
      }
    }
  }

  mkdirSync(recordingsDir, { recursive: true });
  const outPath = join(recordingsDir, `live-eval-${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        failed,
        traceDir,
        results,
        saved: outPath,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ failed, results, saved: outPath, traceDir }, null, 2));
  await app.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
