#!/usr/bin/env npx tsx
/**
 * P00: Generate public-surface inventory and coverage ledger from installed packages.
 * Seed JSON is a planning map only; this script is authoritative for installed tarballs.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  computeInputRevision,
  countStatuses,
  isSafeEvidenceLink,
  mergeCoverageLedger,
  revisionIdFromLedger,
  type CoverageStatus,
} from '../../src/playground/coverage-merge';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'docs', 'playground');

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function listExportKeys(pkgJson: Record<string, unknown> | null): string[] {
  const exports = pkgJson?.exports;
  if (!exports || typeof exports !== 'object') return ['.'];
  return Object.keys(exports as Record<string, unknown>).sort();
}

async function listRuntimeExports(specifier: string): Promise<string[]> {
  try {
    const mod = await import(specifier);
    return Object.keys(mod)
      .filter((k) => k !== 'default' && k !== 'module.exports')
      .sort();
  } catch (err) {
    return [`__import_error__: ${err instanceof Error ? err.message : String(err)}`];
  }
}

type PreviousLedger = Parameters<typeof mergeCoverageLedger>[0]['previous'] &
  Parameters<typeof revisionIdFromLedger>[0];

/** A corrupt ledger must fail loudly: silently regenerating would erase executed evidence. */
function loadPreviousLedger(path: string): PreviousLedger | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `Refusing to overwrite unreadable coverage ledger ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const obj = parsed as { schemaVersion?: unknown; symbols?: unknown; packages?: unknown };
  if (
    !obj ||
    typeof obj !== 'object' ||
    obj.schemaVersion !== 'playground-coverage/1' ||
    !Array.isArray(obj.symbols) ||
    !Array.isArray(obj.packages)
  ) {
    throw new Error(
      `Refusing to overwrite coverage ledger ${path}: unexpected schema (expected playground-coverage/1)`,
    );
  }
  return parsed as PreviousLedger;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const appPkg = readJson(join(ROOT, 'package.json'))!;
  const lock = readJson(join(ROOT, 'package-lock.json'));
  const lockPkg =
    (lock?.packages as
      | Record<string, { version?: string; integrity?: string }>
      | undefined)?.['node_modules/agent-inspect'] ?? null;

  const aiPkgPath = join(ROOT, 'node_modules', 'agent-inspect', 'package.json');
  const aiPkg = readJson(aiPkgPath);
  const installedVersion = (aiPkg?.version as string) ?? 'missing';

  const seed = readJson(join(OUT_DIR, 'AgentInspect_Coverage_Seed.json'));
  const seedPackages =
    (seed?.publicPackages as Array<{ name: string; reviewedVersion?: string; exports?: string[] }>) ??
    [];

  const gitSha = safeExec('git rev-parse HEAD');
  const nodeV = safeExec('node -v');
  const npmV = safeExec('npm -v');

  // Root + subpaths that are installed with agent-inspect
  const coreSubpaths = listExportKeys(aiPkg);
  const rootExports = await listRuntimeExports('agent-inspect');
  const advancedExports = await listRuntimeExports('agent-inspect/advanced');
  const checksExports = await listRuntimeExports('agent-inspect/checks');
  const readersExports = await listRuntimeExports('agent-inspect/readers');
  const writersExports = await listRuntimeExports('agent-inspect/writers');

  let cliHelp = '';
  try {
    cliHelp = execSync('npx --no-install agent-inspect --help', {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    cliHelp = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
  const cliCommands = [
    ...cliHelp.matchAll(/^\s{2}([a-z][\w-]*)\b/gm),
  ].map((m) => m[1]);

  // Scoped packages: mark installed vs planned/blocked
  const packageRows = seedPackages.map((p) => {
    const localPath = p.name.startsWith('@')
      ? join(ROOT, 'node_modules', ...p.name.split('/'), 'package.json')
      : join(ROOT, 'node_modules', p.name, 'package.json');
    const installed = existsSync(localPath);
    const local = installed ? readJson(localPath) : null;
    return {
      id: `pkg:${p.name}`,
      name: p.name,
      kind: 'package' as const,
      reviewedVersion: p.reviewedVersion ?? null,
      installedVersion: installed ? (local?.version as string) : null,
      installed,
      exports: installed ? listExportKeys(local) : (p.exports ?? []),
      status: (installed
        ? p.name === 'agent-inspect'
          ? 'implemented-unverified'
          : 'planned'
        : 'blocked') as CoverageStatus,
      blockedReason: installed
        ? undefined
        : 'Not installed in this app; deferred to isolated consumer or later phase',
      testIds: [] as string[],
      executedEvidence: [] as string[],
    };
  });

  // Discovery only assigns planned/implemented-unverified/unsupported/blocked;
  // passed/failed/stale come exclusively from merged executed evidence.
  type SymbolStatus = CoverageStatus;

  // Core runtime symbols from installed root
  const symbolRows: Array<{
    id: string;
    package: string;
    subpath: string;
    symbol: string;
    kind: 'runtime-export' | 'subpath' | 'cli-command';
    status: SymbolStatus;
    testIds: string[];
    executedEvidence: string[];
  }> = [
    ...rootExports.map((name) => ({
      id: `export:agent-inspect:${name}`,
      package: 'agent-inspect',
      subpath: '.',
      symbol: name,
      kind: 'runtime-export' as const,
      status: (name.startsWith('__import_error__')
        ? 'unsupported'
        : 'planned') as SymbolStatus,
      testIds: [] as string[],
      executedEvidence: [] as string[],
    })),
    ...coreSubpaths
      .filter((s) => s !== '.')
      .map((sub) => ({
        id: `subpath:agent-inspect:${sub}`,
        package: 'agent-inspect',
        subpath: sub,
        symbol: sub,
        kind: 'subpath' as const,
        status: 'planned' as SymbolStatus,
        testIds: [] as string[],
        executedEvidence: [] as string[],
      })),
    ...cliCommands.map((cmd) => ({
      id: `cli:agent-inspect:${cmd}`,
      package: 'agent-inspect',
      subpath: 'cli',
      symbol: cmd,
      kind: 'cli-command' as const,
      status: 'planned' as SymbolStatus,
      testIds: [] as string[],
      executedEvidence: [] as string[],
    })),
  ];

  // Mark root APIs we intentionally exercise in M1
  const m1Symbols = new Set([
    'inspectRun',
    'maybeInspectRun',
    'step',
    'observeOutcome',
    'createInspector',
    'getCurrentCorrelationMetadata',
  ]);
  for (const row of symbolRows) {
    if (row.kind === 'runtime-export' && m1Symbols.has(row.symbol)) {
      row.status = 'implemented-unverified';
    }
  }

  const ledgerPath = join(OUT_DIR, 'coverage-ledger.json');
  const previousLedger = loadPreviousLedger(ledgerPath);
  const revision = computeInputRevision({
    agentInspectVersion: installedVersion,
    packageLockIntegrity: lockPkg?.integrity ?? null,
    packageJsonSha256: sha256File(aiPkgPath),
  });
  const merged = mergeCoverageLedger({
    symbols: symbolRows,
    packages: packageRows,
    previous: previousLedger,
    ctx: {
      revision,
      previousLedgerRevisionId: previousLedger ? revisionIdFromLedger(previousLedger) : null,
      artifactExists: (link) => isSafeEvidenceLink(link) && existsSync(join(ROOT, link)),
    },
  });
  const mergedSymbols = merged.symbols;
  const mergedPackages = merged.packages;
  const retiredSymbols = merged.retiredSymbols;
  const allRows = [...mergedSymbols, ...retiredSymbols];
  const freshEvidenceLinks = mergedSymbols
    .filter((s) => s.status === 'passed' || s.status === 'failed')
    .reduce((n, s) => n + s.executedEvidence.length, 0);
  const staleEvidenceLinks = allRows
    .filter((s) => s.status === 'stale')
    .reduce((n, s) => n + s.executedEvidence.length, 0);

  const ledger = {
    schemaVersion: 'playground-coverage/1',
    generatedAt: new Date().toISOString(),
    sourceKind: 'installed-tarball-inventory',
    app: {
      name: appPkg.name,
      version: appPkg.version,
      gitSha,
      packageLockAgentInspect: lockPkg?.version ?? null,
      packageLockHash: sha256File(join(ROOT, 'package-lock.json')),
    },
    environment: {
      node: nodeV,
      npm: npmV,
      platform: process.platform,
      arch: process.arch,
    },
    agentInspect: {
      installedVersion,
      packageIntegrityHint: null as string | null,
      reviewedPlanBaseline: installedVersion === 'missing' ? '6.31.15' : installedVersion,
      packageLockIntegrity: lockPkg?.integrity ?? null,
      coreSubpaths,
      rootRuntimeExports: rootExports,
      advancedExportCount: advancedExports.length,
      checksExportCount: checksExports.length,
      readersExportCount: readersExports.length,
      writersExportCount: writersExports.length,
      cliCommands,
      tarballSha256OfPackageJson: sha256File(aiPkgPath),
    },
    inputRevision: revision,
    packages: mergedPackages,
    symbols: mergedSymbols,
    retiredSymbols,
    counts: {
      packagesTotal: mergedPackages.length,
      packagesInstalled: mergedPackages.filter((p) => p.installed).length,
      packagesBlocked: mergedPackages.filter((p) => p.status === 'blocked').length,
      symbolsTotal: mergedSymbols.length,
      symbolsPlanned: mergedSymbols.filter((s) => s.status === 'planned').length,
      symbolsImplementedUnverified: mergedSymbols.filter(
        (s) => s.status === 'implemented-unverified',
      ).length,
      symbolsPassed: mergedSymbols.filter((s) => s.status === 'passed').length,
      symbolsFailed: mergedSymbols.filter((s) => s.status === 'failed').length,
      symbolsUnsupported: mergedSymbols.filter((s) => s.status === 'unsupported').length,
      symbolsStale: mergedSymbols.filter((s) => s.status === 'stale').length,
      symbolsRetired: retiredSymbols.length,
      symbolsByStatus: countStatuses(mergedSymbols),
      executedEvidence: freshEvidenceLinks,
      staleEvidenceLinks,
    },
    limitations: [
      'Scoped @agent-inspect/* packages are not installed in this app (blocked until P07+).',
      'Type-only exports and instance methods need deeper .d.ts parsing in a later inventory pass.',
      'Coverage statuses other than planned/blocked/unsupported/implemented-unverified require executed evidence.',
      'Executed evidence is bound to the agent-inspect version, lockfile integrity and package.json hash; any change marks it stale (history is kept, not erased) until re-executed.',
      'Evidence is verified by artifact path existence only; artifact contents are not re-hashed during inventory regeneration (see lab:mark-m1-evidence for checksum verification).',
    ],
  };

  ledger.agentInspect.packageIntegrityHint = lockPkg?.integrity ?? null;
  if (!ledger.agentInspect.packageIntegrityHint && installedVersion !== 'missing') {
    try {
      const view = execSync(
        `npm view agent-inspect@${installedVersion} dist.integrity --json`,
        {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
      ledger.agentInspect.packageIntegrityHint = JSON.parse(view) as string;
    } catch {
      /* offline — lockfile integrity is authoritative when present */
    }
  }

  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');

  const baseline = `# AgentInspect Playground baseline (P00)

Generated: ${ledger.generatedAt}

## Application

| Field | Value |
| --- | --- |
| Package | ${appPkg.name}@${appPkg.version} |
| Git SHA | \`${gitSha}\` |
| package-lock agent-inspect | ${lockPkg?.version ?? 'n/a'} |
| package-lock SHA-256 | \`${ledger.app.packageLockHash ?? 'n/a'}\` |

## Environment

| Field | Value |
| --- | --- |
| Node | ${nodeV} |
| npm | ${npmV} |
| OS | ${process.platform}/${process.arch} |

## AgentInspect pin

| Field | Value |
| --- | --- |
| Pin (package.json) | ${(appPkg.dependencies as Record<string, string>)['agent-inspect'] ?? 'n/a'} |
| Installed | **${installedVersion}** |
| package-lock integrity | ${lockPkg?.integrity ?? 'n/a'} |
| npm dist.integrity (fallback) | ${ledger.agentInspect.packageIntegrityHint ?? 'unavailable offline'} |
| Core export subpaths | ${coreSubpaths.join(', ')} |
| Root runtime exports | ${rootExports.length} |
| CLI commands discovered | ${cliCommands.length} |

## Inventory summary

| Metric | Count |
| --- | --- |
| Public packages (seed) | ${packageRows.length} |
| Installed in this app | ${ledger.counts.packagesInstalled} |
| Blocked (not installed) | ${ledger.counts.packagesBlocked} |
| Symbol/subpath/CLI rows | ${ledger.counts.symbolsTotal} |
| Implemented-unverified (M1 targets) | ${ledger.counts.symbolsImplementedUnverified} |
| Passed (executed evidence, current revision) | ${ledger.counts.symbolsPassed} |
| Failed (executed evidence, current revision) | ${ledger.counts.symbolsFailed} |
| Stale (evidence kept, needs re-execution) | ${ledger.counts.symbolsStale} |
| Retired symbols (removed, evidence kept) | ${ledger.counts.symbolsRetired} |

## Notes

- Regeneration preserves executed evidence only for the same input revision (\`${revision.id.slice(0, 12)}\`); other evidence is marked stale and kept.
- Seed file \`AgentInspect_Coverage_Seed.json\` remains planning data; this baseline and \`coverage-ledger.json\` are generated from the installed tarball.
- \`@agent-inspect/langchain\` peer requires \`@langchain/core ^1.0.0\`; this app stays on 0.3.x with **manual** instrumentation until an isolated P07 consumer.
- Existing offline validation: run \`npm run validate\` separately and record results in evidence manifests.

## Artifacts

- Coverage ledger: \`docs/playground/coverage-ledger.json\`
- Scenario catalog (planned): \`docs/playground/AgentInspect_Scenario_Catalog.json\`
`;

  writeFileSync(join(OUT_DIR, 'baseline.md'), baseline);

  // Compatibility manifest
  writeFileSync(
    join(OUT_DIR, 'compatibility-manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 'playground-compat/1',
        generatedAt: ledger.generatedAt,
        appGitSha: gitSha,
        agentInspect: {
          requested: (appPkg.dependencies as Record<string, string>)['agent-inspect'],
          installed: installedVersion,
          planBaseline: installedVersion,
          lockIntegrity: lockPkg?.integrity ?? null,
          integrity: ledger.agentInspect.packageIntegrityHint,
        },
        langchain: {
          core: (lock?.packages as Record<string, { version?: string }>)?.[
            'node_modules/@langchain/core'
          ]?.version,
          langgraph: (lock?.packages as Record<string, { version?: string }>)?.[
            'node_modules/@langchain/langgraph'
          ]?.version,
          note: 'Manual AgentInspect instrumentation; official langchain adapter deferred (peer core ^1)',
        },
        openai: (lock?.packages as Record<string, { version?: string }>)?.[
          'node_modules/openai'
        ]?.version,
        vitest: (lock?.packages as Record<string, { version?: string }>)?.[
          'node_modules/vitest'
        ]?.version,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        ledger: ledgerPath,
        baseline: join(OUT_DIR, 'baseline.md'),
        counts: ledger.counts,
        agentInspect: installedVersion,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
