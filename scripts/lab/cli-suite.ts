#!/usr/bin/env npx tsx
/**
 * P09 — exercise installed agent-inspect CLI families in a disposable workspace.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectRun, step } from 'agent-inspect';

type CmdResult = {
  cmd: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
};

function run(cmd: string[], cwd: string): CmdResult {
  try {
    const stdout = execFileSync(cmd[0]!, cmd.slice(1), {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { cmd, exitCode: 0, stdout, stderr: '', ok: true };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      cmd,
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      ok: false,
    };
  }
}

async function main() {
  const root = join(process.cwd(), 'artifacts', `cli-${Date.now()}`);
  const traceDir = join(root, 'traces');
  mkdirSync(traceDir, { recursive: true });

  await inspectRun(
    'cli-lab-seed',
    async () => {
      await step.tool('seed', async () => ({ ok: true }));
    },
    { silent: true, traceDir },
  );

  const files = readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
  const runId = files[0]?.replace(/\.jsonl$/, '') ?? '';
  const results: CmdResult[] = [];

  const npx = ['npx', '--no-install', 'agent-inspect'];
  results.push(run([...npx, '--help'], process.cwd()));
  results.push(run([...npx, 'list', '--dir', traceDir], process.cwd()));
  if (runId) {
    results.push(run([...npx, 'view', runId, '--dir', traceDir, '--summary'], process.cwd()));
    results.push(run([...npx, 'what', runId, '--dir', traceDir], process.cwd()));
    results.push(run([...npx, 'check', runId, '--dir', traceDir, '--json', '--require-completed'], process.cwd()));
    results.push(run([...npx, 'explain', runId, '--dir', traceDir], process.cwd()));
    results.push(run([...npx, 'stats', '--dir', traceDir], process.cwd()));
    results.push(
      run(
        [...npx, 'export', runId, '--dir', traceDir, '--format', 'markdown', '--out', join(root, 'export.md')],
        process.cwd(),
      ),
    );
  }
  results.push(run([...npx, 'doctor'], process.cwd()));
  results.push(run([...npx, 'plugins', 'list'], process.cwd()));

  // Invalid config should fail
  const bad = run([...npx, 'check', 'missing-run-id-xyz', '--dir', traceDir, '--json'], process.cwd());
  bad.ok = bad.exitCode !== 0; // expected failure
  results.push({ ...bad, cmd: [...bad.cmd, '#expect-fail'] });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(
    join(root, 'commands.json'),
    JSON.stringify({ passed, failed, results }, null, 2) + '\n',
  );

  console.log(JSON.stringify({ root, passed, failed, runId }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
