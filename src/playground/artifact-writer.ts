import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

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

/** Recursively list files under dir as posix-relative paths. */
export function listFilesRecursive(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else if (st.isFile()) {
      out.push(relative(base, full).split('\\').join('/'));
    }
  }
  return out.sort();
}

/**
 * Hash all nested files except SHA256SUMS.txt itself.
 * Paths are relative to the artifact directory.
 */
export function finalizeChecksums(dir: string): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const rel of listFilesRecursive(dir)) {
    if (rel === 'SHA256SUMS.txt') continue;
    checksums[rel] = sha256(readFileSync(join(dir, rel)));
  }
  const lines = Object.entries(checksums)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, hash]) => `${hash}  ${file}`)
    .join('\n');
  writeFileSync(join(dir, 'SHA256SUMS.txt'), lines + (lines ? '\n' : ''));
  return checksums;
}

/** Verify checksums; returns failed relative paths. */
export function verifyChecksums(dir: string): string[] {
  const sumPath = join(dir, 'SHA256SUMS.txt');
  if (!existsSync(sumPath)) return ['SHA256SUMS.txt missing'];
  const failed: string[] = [];
  for (const line of readFileSync(sumPath, 'utf8').split('\n')) {
    const m = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
    if (!m) continue;
    const [, expect, rel] = m;
    const full = join(dir, rel!);
    if (!existsSync(full)) {
      failed.push(`${rel} missing`);
      continue;
    }
    const got = sha256(readFileSync(full));
    if (got !== expect) failed.push(`${rel} mismatch`);
  }
  return failed;
}

export function copyTraceIntoArtifacts(
  dir: string,
  tracePath: string,
): string | null {
  if (!existsSync(tracePath)) return null;
  const dest = join(dir, 'trace.jsonl');
  copyFileSync(tracePath, dest);
  return dest;
}
