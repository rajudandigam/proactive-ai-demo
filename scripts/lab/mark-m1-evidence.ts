#!/usr/bin/env npx tsx
/**
 * Mark M1 executed evidence on the coverage ledger after a successful travel-core suite.
 * Does not invent passes for unrun symbols.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ledgerPath = join(ROOT, 'docs', 'playground', 'coverage-ledger.json');
const summaryGlob = join(ROOT, 'artifacts');

function latestSuiteSummary(): {
  batchId: string;
  failed: number;
  total: number;
  suite?: string;
} | null {
  if (!existsSync(summaryGlob)) return null;
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const batches = readdirSync(summaryGlob)
    .filter((d) => d.startsWith('batch-') && !d.startsWith('batch-ext-') && !d.startsWith('cli-'))
    .sort()
    .reverse();
  for (const b of batches) {
    const p = join(summaryGlob, b, 'suite-summary.json');
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as {
        batchId: string;
        failed: number;
        total: number;
        suite?: string;
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
  row.testIds = Array.from(new Set([...(row.testIds ?? []), 'lab:suite:travel-core']));
  row.executedEvidence = Array.from(
    new Set([...(row.executedEvidence ?? []), ...evidence]),
  );
}

// Keep other M1 wiring targets as implemented-unverified (present in app, not suite-proven)
const wired = new Set(['maybeInspectRun', 'createInspector', 'getCurrentCorrelationMetadata']);
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

ledger.counts.symbolsPassed = ledger.symbols.filter((s) => s.status === 'passed').length;
ledger.counts.symbolsImplementedUnverified = ledger.symbols.filter(
  (s) => s.status === 'implemented-unverified',
).length;
ledger.counts.symbolsPlanned = ledger.symbols.filter((s) => s.status === 'planned').length;
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
      symbolsPassed: ledger.counts.symbolsPassed,
      evidence,
    },
    null,
    2,
  ),
);
