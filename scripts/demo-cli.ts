#!/usr/bin/env npx tsx
/**
 * Presentation CLI for the five-minute demo.
 * Requires the NestJS server: npm run start:dev
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000';

type Json = Record<string, unknown>;

async function request(method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Json;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json, null, 2)}`);
  }
  return json;
}

function loadRequest(name: string): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'fixtures', 'requests', name), 'utf8'),
  );
}

function divider(title: string) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(` ${title}`);
  console.log(line);
}

function printPresentation(result: Json, inputSummary: Json) {
  const mode = String(result.modelMode ?? 'none').toUpperCase();
  console.log(`\nMODE: ${mode === 'NONE' ? 'TEMPLATE/APPLICATION' : mode}`);

  divider('1. INPUT SUMMARY');
  console.log(JSON.stringify(inputSummary, null, 2));

  divider('2. MODEL PROPOSAL');
  const proposals = (result.modelProposals as unknown[]) ?? [];
  if (Array.isArray(proposals) && proposals.length > 0) {
    console.log(JSON.stringify(proposals, null, 2));
    if (result.modelMode === 'none') {
      console.log('\nNote: Template/application proposal — not an optional model call.');
    }
  } else {
    console.log('(No model or template proposal.)');
  }
  if (result.modelMode === 'fixture') {
    console.log('\nNote: FIXTURE mode — deterministic provider, not live model output.');
  }

  divider('3. APPLICATION DECISIONS');
  console.log(
    JSON.stringify(
      {
        runStatus: result.runStatus,
        modelCalls: result.modelCalls,
        outboxWrites: result.outboxWrites,
        decisions: result.decisions,
        failureReason: result.failureReason,
        duplicateOf: result.duplicateOf,
      },
      null,
      2,
    ),
  );

  divider('4. MOCK NOTIFICATION PREVIEW');
  const notifications = (result.decisions as Array<Json> | undefined)
    ?.filter((d) => d.notificationPreview)
    .map((d) => d.notificationPreview);
  if (!notifications?.length) {
    console.log('(No outbox write for this run.)');
  } else {
    console.log(JSON.stringify(notifications, null, 2));
  }

  divider('TRACE');
  const trace = result.trace as Json | undefined;
  if (trace) {
    console.log(
      JSON.stringify(
        {
          modelMode: trace.modelMode,
          modelCalls: trace.modelCalls,
          elapsedMs: trace.elapsedMs,
          policy: trace.policy,
          evidence: trace.evidence,
          validation: trace.validation,
        },
        null,
        2,
      ),
    );
  }
  console.log('');
}

async function main() {
  const cmd = process.argv[2] ?? 'help';

  if (cmd === 'reset') {
    const result = await request('POST', '/demo/reset');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'trip') {
    const body = loadRequest('trip-review.json') as Json;
    const result = await request('POST', '/demo/intake', body);
    printPresentation(result, {
      eventId: body.eventId,
      type: body.type,
      scenarioId: body.scenarioId,
      tripId: body.tripId,
      signals: body.signals,
    });
    return;
  }

  if (cmd === 'flight') {
    const body = loadRequest('flight-change.json') as Json;
    const result = await request('POST', '/demo/intake', body);
    printPresentation(result, {
      eventId: body.eventId,
      type: body.type,
      scenarioId: body.scenarioId,
      tripId: body.tripId,
      signals: body.signals,
    });
    return;
  }

  if (cmd === 'repeat') {
    // Same event ID and source version as demo:flight
    const body = loadRequest('flight-change.json') as Json;
    const result = await request('POST', '/demo/intake', body);
    printPresentation(result, {
      note: 'Replay of flight-change-001 (same eventId + source version)',
      eventId: body.eventId,
      type: body.type,
      scenarioId: body.scenarioId,
    });
    return;
  }

  console.log(`Usage: demo-cli.ts <reset|trip|flight|repeat>`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.error('\nIs the server running? Try: npm run start:dev');
  process.exit(1);
});
