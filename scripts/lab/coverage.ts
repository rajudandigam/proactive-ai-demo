#!/usr/bin/env npx tsx
/**
 * Print coverage summary from docs/playground/coverage-ledger.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ledgerPath = join(process.cwd(), 'docs', 'playground', 'coverage-ledger.json');

if (!existsSync(ledgerPath)) {
  console.error('Missing coverage ledger. Run: npm run lab:inventory');
  process.exit(1);
}

const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
  generatedAt: string;
  counts: Record<string, number>;
  packages: Array<{ name: string; status: string; installed: boolean }>;
  symbols: Array<{ id: string; status: string }>;
  retiredSymbols?: Array<{ id: string; status: string }>;
  inputRevision?: { id: string };
  agentInspect: { installedVersion: string };
};

const byStatus = (rows: Array<{ status: string }>) => {
  const m: Record<string, number> = {};
  for (const r of rows) m[r.status] = (m[r.status] ?? 0) + 1;
  return m;
};

console.log(
  JSON.stringify(
    {
      generatedAt: ledger.generatedAt,
      agentInspect: ledger.agentInspect.installedVersion,
      counts: ledger.counts,
      packagesByStatus: byStatus(ledger.packages),
      symbolsByStatus: byStatus(ledger.symbols),
      retiredSymbolsByStatus: byStatus(ledger.retiredSymbols ?? []),
      inputRevision: ledger.inputRevision?.id ?? null,
      installedPackages: ledger.packages.filter((p) => p.installed).map((p) => p.name),
      blockedPackages: ledger.packages
        .filter((p) => !p.installed)
        .map((p) => p.name),
      denominatorNote:
        'Passed/failed require executedEvidence bound to the current input revision. Stale rows keep prior evidence but do not count as passed. Planned/blocked/unsupported/implemented-unverified are never inflated into passed.',
    },
    null,
    2,
  ),
);
