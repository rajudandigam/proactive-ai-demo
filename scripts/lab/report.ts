#!/usr/bin/env npx tsx
/**
 * P12 — final coverage + closure report from executed evidence.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const outDir = join(ROOT, 'docs', 'playground', 'reports');
mkdirSync(outDir, { recursive: true });

function safe(cmd: string): string {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const ledgerPath = join(ROOT, 'docs', 'playground', 'coverage-ledger.json');
const ledger = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
  : null;

const artifactsRoot = join(ROOT, 'artifacts');
const batches = existsSync(artifactsRoot)
  ? readdirSync(artifactsRoot).filter((d) => d.startsWith('batch'))
  : [];

const report = {
  generatedAt: new Date().toISOString(),
  appGitSha: safe('git rev-parse HEAD'),
  node: safe('node -v'),
  agentInspectInstalled: ledger?.agentInspect?.installedVersion ?? 'unknown',
  coverageCounts: ledger?.counts ?? {},
  packages: {
    installed: (ledger?.packages ?? [])
      .filter((p: { installed: boolean }) => p.installed)
      .map((p: { name: string; status: string }) => ({
        name: p.name,
        status: p.status,
      })),
    blocked: (ledger?.packages ?? [])
      .filter((p: { installed: boolean }) => !p.installed)
      .map((p: { name: string; blockedReason?: string }) => ({
        name: p.name,
        reason: p.blockedReason ?? 'not installed in root app',
      })),
  },
  executedBatches: batches.slice(-20),
  lanes: {
    travelCoreOffline: 'see lab:suite travel-core',
    extendedOffline: 'see lab:extended',
    cli: 'see lab:cli',
    interopDocker: 'blocked until docker compose --profile interop is executed and evidence retained',
    langgraphAdapter: 'blocked — isolated integration-apps/langgraph requires core ^1',
    aiSdkAdapter: 'blocked-until-install',
    openaiAgentsAdapter: 'blocked-until-install',
    mcpPackages: 'blocked — @agent-inspect/mcp not installed in root',
    liveProviders: 'opt-in; record blocked when credentials/network unavailable',
  },
  openDefects: [] as Array<{ id: string; summary: string }>,
  remainingWork: [
    'Install and run integration-apps/* with matching peer locks (P07)',
    'Add @agent-inspect/mcp client/server consumers (P08)',
    'Execute Docker interop profile and retain OTLP loss ledger (P11)',
    'Expand contract rule-family matrix beyond S41/S42 (P05 remainder)',
    'Browser smoke for /playground/ui and TUI PTY tests (P10 remainder)',
  ],
};

writeFileSync(join(outDir, 'coverage.json'), JSON.stringify(report, null, 2) + '\n');

const md = `# AgentInspect Playground closure report

Generated: ${report.generatedAt}

## Versions

| Field | Value |
| --- | --- |
| App SHA | \`${report.appGitSha}\` |
| Node | ${report.node} |
| agent-inspect | ${report.agentInspectInstalled} |

## Coverage counts

\`\`\`json
${JSON.stringify(report.coverageCounts, null, 2)}
\`\`\`

## Blocked packages (not installed in root)

${report.packages.blocked.map((p: { name: string; reason: string }) => `- **${p.name}**: ${p.reason}`).join('\n')}

## Lane status

${Object.entries(report.lanes)
  .map(([k, v]) => `- **${k}**: ${v}`)
  .join('\n')}

## Remaining work

${report.remainingWork.map((w) => `- ${w}`).join('\n')}

## Commands

\`\`\`bash
npm run validate
npm run lab:suite -- travel-core
npm run lab:extended -- --suite all-extended
npm run lab:cli
npm run lab:report
\`\`\`

Demo UI: \`/demo/ui\` · Playground UI: \`/playground/ui\`
`;

writeFileSync(join(outDir, 'CLOSURE.md'), md);
console.log(JSON.stringify({ ok: true, report: join(outDir, 'CLOSURE.md') }, null, 2));
