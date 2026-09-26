#!/usr/bin/env npx tsx
/**
 * Mark M1 executed evidence on the coverage ledger after a successful travel-core suite.
 * Requires expected case count and verified artifact checksums — refuses green without proof.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyChecksums } from '../../src/playground/artifact-writer';
import { TRAVEL_CORE_EXPECTED_COUNT } from '../../src/playground/scenario-registry';

const ROOT = process.cwd();
const ledgerPath = join(ROOT, 'docs', 'playground', 'coverage-ledger.json');
const summaryGlob = join(ROOT, 'artifacts');

function latestSuiteSummary(): {
  batchId: string;
  failed: number;
  total: number;
  expectedTotal?: number;
  suite?: string;
  results?: Array<{ scenarioId: string; overallVerdict: string; artifactDir: string }>;
} | null {
  if (!existsSync(summaryGlob)) return null;
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const batches = readdirSync(summaryGlob)
    .filter(
      (d) =>
        d.startsWith('batch-') &&
        !d.startsWith('batch-ext-') &&
        !d.startsWith('cli-'),
    )
    .sort()
    .reverse();
  for (const b of batches) {
    const p = join(summaryGlob, b, 'suite-summary.json');
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as {
        batchId: string;
        failed: number;
        total: number;
        expectedTotal?: number;
        suite?: string;
        results?: Array<{
          scenarioId: string;
          overallVerdict: string;
          artifactDir: string;
        }>;
      };
      if (!parsed.suite || parsed.suite === 'travel-core') return parsed;
    }
  }
  return null;
}

const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
  symbols: Array<{
    id: string;
    symbol: string;
    status: string;
    testIds: string[];
    executedEvidence: string[];
  }>;
  packages: Array<{
    name: string;
    status: string;
    testIds: string[];
    executedEvidence: string[];
  }>;
  counts: Record<string, number>;
};

const summary = latestSuiteSummary();
if (!summary || summary.failed !== 0) {
  console.error(
    'No successful travel-core suite-summary.json found under artifacts/. Run: npm run lab:suite -- travel-core',
  );
  process.exit(1);
}

if (summary.total !== TRAVEL_CORE_EXPECTED_COUNT) {
  console.error(
    JSON.stringify({
      error: 'unexpected_case_count',
      expected: TRAVEL_CORE_EXPECTED_COUNT,
      total: summary.total,
    }),
  );
  process.exit(1);
}

const results = summary.results ?? [];
if (results.length !== TRAVEL_CORE_EXPECTED_COUNT) {
  console.error('suite-summary missing per-scenario results');
  process.exit(1);
}

const checksumProblems: string[] = [];
for (const r of results) {
  if (r.overallVerdict !== 'pass') {
    checksumProblems.push(`${r.scenarioId}: overall not pass`);
    continue;
  }
  if (!r.artifactDir || !existsSync(r.artifactDir)) {
    checksumProblems.push(`${r.scenarioId}: missing artifactDir`);
    continue;
  }
  const failed = verifyChecksums(r.artifactDir);
  if (failed.length) {
    checksumProblems.push(`${r.scenarioId}: ${failed.join('; ')}`);
  }
  const resultPath = join(r.artifactDir, 'result.json');
  if (!existsSync(resultPath)) {
    checksumProblems.push(`${r.scenarioId}: missing result.json`);
  }
}

if (checksumProblems.length) {
  console.error(
    JSON.stringify({ error: 'artifact_verification_failed', checksumProblems }, null, 2),
  );
  process.exit(1);
}

const evidence = [`artifacts/${summary.batchId}/suite-summary.json`];
/** Only symbols physically exercised by lab:suite travel-core. */
const m1Runtime = new Set(['inspectRun', 'step', 'observeOutcome']);
const m1Cli = new Set(['check']);

for (const row of ledger.symbols) {
  const sym = (row as { symbol?: string }).symbol;
  if (!sym) continue;
  const isM1 = m1Runtime.has(sym) || m1Cli.has(sym);
  if (!isM1) continue;
  row.status = 'passed';
  row.testIds = Array.from(
    new Set([...(row.testIds ?? []), 'lab:suite:travel-core']),
  );
  row.executedEvidence = Array.from(
    new Set([...(row.executedEvidence ?? []), ...evidence]),
  );
}

const wired = new Set([
  'maybeInspectRun',
  'createInspector',
  'getCurrentCorrelationMetadata',
]);
for (const row of ledger.symbols) {
  const sym = (row as { symbol?: string }).symbol;
  if (!sym || !wired.has(sym)) continue;
  if (row.status === 'passed') continue;
  row.status = 'implemented-unverified';
}

for (const pkg of ledger.packages) {
  if (pkg.name === 'agent-inspect') {
    pkg.status = 'passed';
    pkg.testIds = ['lab:suite:travel-core'];
    pkg.executedEvidence = evidence;
  }
}

ledger.counts.symbolsPassed = ledger.symbols.filter(
  (s) => s.status === 'passed',
).length;
ledger.counts.symbolsImplementedUnverified = ledger.symbols.filter(
  (s) => s.status === 'implemented-unverified',
).length;
ledger.counts.symbolsPlanned = ledger.symbols.filter(
  (s) => s.status === 'planned',
).length;
ledger.counts.executedEvidence = ledger.symbols.reduce(
  (n, s) => n + (s.executedEvidence?.length ?? 0),
  0,
);

writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      ok: true,
      batchId: summary.batchId,
      total: summary.total,
      expected: TRAVEL_CORE_EXPECTED_COUNT,
      checksumsVerified: results.length,
      symbolsPassed: ledger.counts.symbolsPassed,
      evidence,
    },
    null,
    2,
  ),
);
