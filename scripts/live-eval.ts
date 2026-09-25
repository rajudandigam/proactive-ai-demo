#!/usr/bin/env npx tsx
/**
 * Opt-in live evaluation. Loads .env before checking DECISION_PROVIDER.
 *
 * Live model output varies even at temperature 0. Invariants check
 * application guarantees and acceptable judgment shape, not exact wording.
 */
import 'reflect-metadata';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DecisionGraphService } from '../src/demo/decision.graph';
import { OutboxService } from '../src/demo/outbox.service';
import { FixtureToolsService } from '../src/demo/fixture-tools.service';
import { ApplicationResult, createSessionId } from '../src/demo/schemas';

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
  // Application guarantees that must always hold
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

  // Acceptable live judgments: combined act_now, or split act/silent covering prep/weather
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
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const graph = app.get(DecisionGraphService);
  const outbox = app.get(OutboxService);
  const fixtures = app.get(FixtureToolsService);

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
        const result = await graph.run(body, { sessionId: createSessionId() });
        const checked = c.check(result);
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
        });
      } catch (err) {
        failed += 1;
        results.push({
          case: c.name,
          ok: false,
          category: 'provider_error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  mkdirSync(join(process.cwd(), 'recordings'), { recursive: true });
  const outPath = join(
    process.cwd(),
    'recordings',
    `live-eval-${Date.now()}.json`,
  );
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ failed, results, saved: outPath }, null, 2));
  await app.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
