import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type ArtifactBundle = {
  dir: string;
  files: string[];
  checksums: Record<string, string>;
};

export function createArtifactDir(
  batchId: string,
  scenarioId: string,
  executionId: string,
): string {
  const dir = join(
    process.cwd(),
    'artifacts',
    batchId,
    scenarioId,
    executionId,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}

export function writeText(dir: string, name: string, value: string): string {
  const path = join(dir, name);
  writeFileSync(path, value);
  return path;
}

export function copyTraceIntoArtifacts(
  dir: string,
  traceDir: string,
  runId: string | undefined,
): string | null {
  if (!runId || !existsSync(traceDir)) return null;
  const entries = readdirSync(traceDir);
  const match = entries.find((e) => e.includes(runId) || e.startsWith(runId));
  // AgentInspect typically uses run-id.jsonl or nested folders
  for (const e of entries) {
    const full = join(traceDir, e);
    if (e.includes(runId) || e === `${runId}.jsonl`) {
      const dest = join(dir, 'trace.jsonl');
      if (e.endsWith('.jsonl')) {
        copyFileSync(full, dest);
        return dest;
      }
    }
  }
  // Fallback: find any .jsonl mentioning correlation / list newest
  const jsonl = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonl.length === 1) {
    const dest = join(dir, 'trace.jsonl');
    copyFileSync(join(traceDir, jsonl[0]), dest);
    return dest;
  }
  // Search file contents for run id
  for (const e of jsonl) {
    const full = join(traceDir, e);
    const text = readFileSync(full, 'utf8');
    if (runId && text.includes(runId)) {
      const dest = join(dir, 'trace.jsonl');
      writeFileSync(dest, text);
      return dest;
    }
  }
  void match;
  return null;
}

export function finalizeChecksums(dir: string): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isFile()) continue;
    if (name.name === 'SHA256SUMS.txt') continue;
    const path = join(dir, name.name);
    checksums[name.name] = sha256(readFileSync(path));
  }
  const lines = Object.entries(checksums)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, hash]) => `${hash}  ${file}`)
    .join('\n');
  writeFileSync(join(dir, 'SHA256SUMS.txt'), lines + (lines ? '\n' : ''));
  return checksums;
}
