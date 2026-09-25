#!/usr/bin/env npx tsx
/**
 * Presentation CLI for the demo (v2). Requires: npm run start:dev
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
  console.log(`\n${'─'.repeat(60)}\n ${title}\n${'─'.repeat(60)}`);
}

function printPresentation(result: Json, inputSummary: Json) {
  const mode = String(result.modelMode ?? 'none').toUpperCase();
  console.log(`\nMODE: ${mode}`);
  divider('1. INPUT SUMMARY');
  console.log(JSON.stringify(inputSummary, null, 2));
  divider('2. MODEL / AGENT PROPOSAL');
  console.log(JSON.stringify(result.modelDecisionSet ?? result.modelProposals ?? null, null, 2));
  if (mode === 'FIXTURE') {
    console.log('\nNote: FIXTURE mode — not live model output.');
  }
  divider('3. APPLICATION DECISIONS');
  console.log(
    JSON.stringify(
      {
        runStatus: result.runStatus,
        modelCalls: result.modelCalls,
        accounting: result.accounting,
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
  console.log(
    notifications?.length
      ? JSON.stringify(notifications, null, 2)
      : '(No outbox write for this run.)',
  );
  divider('POLICY + TRACE');
  console.log(
    JSON.stringify(
      {
        policyRules: result.policyRules,
        accounting: result.accounting,
        nodeStatuses: (result.trace as Json | undefined)?.nodeStatuses,
      },
      null,
      2,
    ),
  );
}

async function intake(body: unknown) {
  return request('POST', '/demo/intake', body);
}

async function main() {
  const cmd = process.argv[2] ?? 'help';
  if (cmd === 'reset') {
    console.log(JSON.stringify(await request('POST', '/demo/reset'), null, 2));
    return;
  }
  if (cmd === 'trip') {
    const body = loadRequest('trip-review.json') as Json;
    printPresentation(await intake(body), body);
    return;
  }
  if (cmd === 'flight') {
    const body = loadRequest('flight-change.json') as Json;
    printPresentation(await intake(body), body);
    return;
  }
  if (cmd === 'repeat') {
    const body = loadRequest('flight-change.json') as Json;
    printPresentation(await intake(body), {
      note: 'Replay flight-change-001',
      ...body,
    });
    return;
  }
  if (cmd === 'arrival') {
    const body = loadRequest('arrival-affected.json') as Json;
    printPresentation(await intake(body), body);
    return;
  }
  if (cmd === 'noimpact') {
    const body = loadRequest('arrival-unaffected.json') as Json;
    printPresentation(await intake(body), body);
    return;
  }
  console.log('Usage: demo-cli.ts <reset|trip|flight|repeat|arrival|noimpact>');
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.error('\nIs the server running? Try: npm run start:dev');
  process.exit(1);
});
