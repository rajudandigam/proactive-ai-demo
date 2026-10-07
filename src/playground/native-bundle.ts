import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  finalizeChecksums,
  verifyChecksums,
  writeAncillaryJson,
  writeJson,
} from './artifact-writer';
import { MANIFEST_NAME, writeLabEvidenceManifest } from './evidence-manifest';

/**
 * Native AgentInspect evidence bundle finalization for lab/live packs.
 *
 * Contract:
 * - The bundle directory is a CLOSED file set: evidence.json lists every
 *   other file in it and nothing is written into it after the manifest.
 * - SHA256SUMS.txt and verification reports are ancillary and live in
 *   `<bundleDir>.ancillary/`.
 * - The harness gate is the DEFAULT `agent-inspect bundle verify --json`
 *   (unexpected files fail) plus a provenance consistency check.
 * - Packs stay local/UNSAFE; nothing here claims share-check approval.
 */

const HEX64 = /^[a-f0-9]{64}$/;
const HEX_GIT = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
const MAX_ERROR_CHARS = 2000;

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]'],
  [
    /\b(api[_-]?key|token|secret|password|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1$2[REDACTED]',
  ],
];

/** Redact obvious credentials and bound length before anything hits disk. */
export function boundedRedact(text: string, max = MAX_ERROR_CHARS): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out.length > max ? `${out.slice(0, max)}…[truncated]` : out;
}

export type ThrownErrorInfo = {
  name: string;
  message: string;
  code?: string;
};

/** Describe (never mutate) a thrown value for the evidence pack. */
export function describeThrown(err: unknown): ThrownErrorInfo {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: boundedRedact(err.name, 200),
      message: boundedRedact(err.message),
      ...(typeof code === 'string' ? { code: boundedRedact(code, 200) } : {}),
    };
  }
  return { name: 'NonError', message: boundedRedact(String(err)) };
}

export type BundleIdentity = {
  executionId: string;
  agentInspectRunId: string | null;
  kind: 'agent-inspect-run' | 'execution-id-only';
};

export type BundleProvenance = {
  schema: 'proactive-ai-demo/bundle-provenance/1';
  identity: BundleIdentity;
  app: {
    gitSha: string;
    dirty: boolean;
    dirtyPatchSha256: string | null;
  };
  lockfileSha256: string | null;
  agentInspect: {
    installedVersion: string;
    lockedVersion: string | null;
    lockedIntegrity: string | null;
  };
  scenarioSha256: string;
  oracleSha256: string;
  configSha256: string;
};

function tryGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function gitProvenance(cwd: string): BundleProvenance['app'] {
  const sha = tryGit(['rev-parse', 'HEAD'], cwd)?.trim() ?? 'unknown';
  const status = tryGit(['status', '--porcelain'], cwd);
  const dirty = status !== null && status.trim().length > 0;
  if (!dirty) return { gitSha: sha, dirty: false, dirtyPatchSha256: null };

  const diff = tryGit(['diff', 'HEAD', '--binary'], cwd) ?? '';
  const untracked = (
    tryGit(['ls-files', '--others', '--exclude-standard'], cwd) ?? ''
  )
    .split('\n')
    .filter(Boolean)
    .sort();
  const untrackedLines = untracked.map((rel) => {
    try {
      const full = join(cwd, rel);
      const st = statSync(full);
      return st.size > 10 * 1024 * 1024
        ? `${rel}:size:${st.size}`
        : `${rel}:${sha256Hex(readFileSync(full))}`;
    } catch {
      return `${rel}:unreadable`;
    }
  });
  return {
    gitSha: sha,
    dirty: true,
    dirtyPatchSha256: sha256Hex(`${diff}\n--untracked--\n${untrackedLines.join('\n')}`),
  };
}

function lockfileProvenance(cwd: string): {
  sha: string | null;
  lockedVersion: string | null;
  lockedIntegrity: string | null;
} {
  const path = join(cwd, 'package-lock.json');
  if (!existsSync(path)) {
    return { sha: null, lockedVersion: null, lockedIntegrity: null };
  }
  const raw = readFileSync(path);
  let lockedVersion: string | null = null;
  let lockedIntegrity: string | null = null;
  try {
    const lock = JSON.parse(raw.toString('utf8')) as {
      packages?: Record<string, { version?: string; integrity?: string }>;
    };
    const entry = lock.packages?.['node_modules/agent-inspect'];
    lockedVersion = entry?.version ?? null;
    lockedIntegrity = entry?.integrity ?? null;
  } catch {
    /* leave null; gate reports incomplete provenance */
  }
  return { sha: sha256Hex(raw), lockedVersion, lockedIntegrity };
}

function installedAgentInspectVersion(cwd: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(cwd, 'node_modules', 'agent-inspect', 'package.json'),
        'utf8',
      ),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function oracleSourceSha256(): string {
  for (const name of ['oracle.ts', 'oracle.js']) {
    const path = join(__dirname, name);
    if (existsSync(path)) return sha256Hex(readFileSync(path));
  }
  return sha256Hex('oracle-source-unavailable');
}

/**
 * Collect full-length (never truncated) provenance digests for a pack.
 * `scenarioPayload`, `oracleExpected` and `config` are hashed canonically.
 */
export function collectProvenance(opts: {
  cwd?: string;
  executionId: string;
  agentInspectRunId?: string | null;
  scenarioPayload: unknown;
  oracleExpected: unknown;
  config: unknown;
}): BundleProvenance {
  const cwd = opts.cwd ?? process.cwd();
  const lock = lockfileProvenance(cwd);
  const runId = opts.agentInspectRunId ?? null;
  return {
    schema: 'proactive-ai-demo/bundle-provenance/1',
    identity: {
      executionId: opts.executionId,
      agentInspectRunId: runId,
      kind: runId ? 'agent-inspect-run' : 'execution-id-only',
    },
    app: gitProvenance(cwd),
    lockfileSha256: lock.sha,
    agentInspect: {
      installedVersion: installedAgentInspectVersion(cwd),
      lockedVersion: lock.lockedVersion,
      lockedIntegrity: lock.lockedIntegrity,
    },
    scenarioSha256: sha256Hex(stableStringify(opts.scenarioPayload)),
    oracleSha256: sha256Hex(
      `${oracleSourceSha256()}\n${stableStringify(opts.oracleExpected)}`,
    ),
    configSha256: sha256Hex(stableStringify(opts.config)),
  };
}

/** Flat string inputs mirrored into evidence.json `inputs`. */
export function provenanceInputs(p: BundleProvenance): Record<string, string> {
  return {
    executionId: p.identity.executionId,
    identityKind: p.identity.kind,
    appDirty: String(p.app.dirty),
    appDirtyPatchSha256: p.app.dirtyPatchSha256 ?? 'none',
    lockfileSha256: p.lockfileSha256 ?? 'missing',
    agentInspectInstalledVersion: p.agentInspect.installedVersion,
    agentInspectLockedVersion: p.agentInspect.lockedVersion ?? 'missing',
    agentInspectLockedIntegrity: p.agentInspect.lockedIntegrity ?? 'missing',
    scenarioSha256: p.scenarioSha256,
    oracleSha256: p.oracleSha256,
    configSha256: p.configSha256,
  };
}

export type BundleIssue = {
  code: string;
  message: string;
  path?: string;
};

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Cross-check evidence.json against the in-bundle provenance.json, the
 * trace and (optionally) values the caller expects right now.
 */
export function checkBundleProvenance(
  bundleDir: string,
  expected?: Partial<{
    lockfileSha256: string;
    appGitSha: string;
    scenarioSha256: string;
    configSha256: string;
  }>,
): BundleIssue[] {
  const issues: BundleIssue[] = [];
  const add = (code: string, message: string, path?: string) =>
    issues.push({ code, message, ...(path ? { path } : {}) });

  const prov = readJson<BundleProvenance>(join(bundleDir, 'provenance.json'));
  if (!prov) {
    add('provenance_missing', 'provenance.json missing or unreadable', 'provenance.json');
    return issues;
  }
  const evidence = readJson<{
    source?: {
      runIds?: string[];
      sourceHashes?: Array<{ runId?: string; hash?: string }>;
    };
    inputs?: Record<string, unknown>;
  }>(join(bundleDir, MANIFEST_NAME));
  if (!evidence) {
    add('provenance_missing', 'evidence.json missing or unreadable', MANIFEST_NAME);
    return issues;
  }

  const identityRunId = prov.identity?.agentInspectRunId ?? prov.identity?.executionId;
  if (!identityRunId) {
    add('provenance_incomplete', 'bundle has no run/execution identity');
  } else if (evidence.source?.runIds?.[0] !== identityRunId) {
    add(
      'provenance_mismatch',
      `evidence runIds[0] (${evidence.source?.runIds?.[0] ?? 'none'}) != bundle identity (${identityRunId})`,
    );
  }

  const tracePath = join(bundleDir, 'trace.jsonl');
  if (prov.identity?.kind === 'agent-inspect-run') {
    if (!existsSync(tracePath)) {
      add('provenance_incomplete', 'agent-inspect-run identity requires trace.jsonl', 'trace.jsonl');
    } else {
      const traceText = readFileSync(tracePath, 'utf8');
      if (!traceText.includes(prov.identity.agentInspectRunId ?? '\0')) {
        add('provenance_mismatch', 'trace.jsonl does not bind the declared run id', 'trace.jsonl');
      }
      const recorded = evidence.source?.sourceHashes?.[0]?.hash;
      if (recorded !== sha256Hex(traceText)) {
        add('provenance_mismatch', 'evidence source hash does not match trace.jsonl', 'trace.jsonl');
      }
    }
  }

  if (!prov.lockfileSha256 || !HEX64.test(prov.lockfileSha256)) {
    add('provenance_incomplete', 'full lockfile sha256 missing');
  }
  if (!HEX_GIT.test(prov.app?.gitSha ?? '')) {
    add('provenance_incomplete', 'app git revision unavailable');
  }
  if (prov.app?.dirty && !HEX64.test(prov.app.dirtyPatchSha256 ?? '')) {
    add('provenance_incomplete', 'dirty app state requires a full patch sha256');
  }
  if (!prov.agentInspect?.lockedIntegrity) {
    add('provenance_incomplete', 'agent-inspect package integrity missing from lockfile');
  }
  for (const key of ['scenarioSha256', 'oracleSha256', 'configSha256'] as const) {
    if (!HEX64.test(prov[key] ?? '')) {
      add('provenance_incomplete', `${key} must be a full sha256`);
    }
  }

  for (const [k, v] of Object.entries(provenanceInputs(prov))) {
    if (evidence.inputs?.[k] !== v) {
      add('provenance_mismatch', `evidence inputs.${k} does not match provenance.json`);
    }
  }

  if (expected?.lockfileSha256 && expected.lockfileSha256 !== prov.lockfileSha256) {
    add('provenance_mismatch', 'lockfile sha256 differs from the expected lockfile');
  }
  if (expected?.appGitSha && expected.appGitSha !== prov.app?.gitSha) {
    add('provenance_mismatch', 'app git revision differs from the expected revision');
  }
  if (expected?.scenarioSha256 && expected.scenarioSha256 !== prov.scenarioSha256) {
    add('provenance_mismatch', 'scenario hash differs from the expected scenario');
  }
  if (expected?.configSha256 && expected.configSha256 !== prov.configSha256) {
    add('provenance_mismatch', 'config hash differs from the expected config');
  }
  return issues;
}

export type NativeVerifyResult = {
  ok: boolean;
  exitCode: number;
  status?: string;
  checkedFiles?: number;
  issues: BundleIssue[];
};

/**
 * Run the DEFAULT `agent-inspect bundle verify --json` (no --unexpected
 * override). This is the harness gate; do not relax it.
 */
export function runNativeBundleVerify(
  bundleDir: string,
  cwd = process.cwd(),
): NativeVerifyResult {
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(
      'npx',
      ['--no-install', 'agent-inspect', 'bundle', 'verify', bundleDir, '--json'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    exitCode =
      err && typeof err === 'object' && 'status' in err
        ? Number((err as { status: unknown }).status) || 1
        : 1;
    stdout =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout)
        : '';
  }
  let parsed: {
    ok?: boolean;
    status?: string;
    checkedFiles?: number;
    issues?: Array<{ code?: string; message?: string; path?: string }>;
  } | null = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      ok: false,
      exitCode: exitCode || 1,
      issues: [
        {
          code: 'verify_unparseable',
          message: 'agent-inspect bundle verify --json produced no parseable result',
        },
      ],
    };
  }
  const issues: BundleIssue[] = (parsed.issues ?? []).map((i) => ({
    code: i.code ?? 'unknown',
    message: boundedRedact(i.message ?? ''),
    ...(i.path ? { path: i.path } : {}),
  }));
  return {
    ok: exitCode === 0 && parsed.ok === true,
    exitCode,
    status: parsed.status,
    checkedFiles: parsed.checkedFiles,
    issues,
  };
}

export type NativeBundleGate = {
  ok: boolean;
  bundleDir: string;
  identityRunId: string;
  verify: NativeVerifyResult;
  checksumProblems: string[];
  provenanceIssues: BundleIssue[];
  reportPath: string;
};

/**
 * Finalize a native bundle: write provenance.json, evidence.json (last file
 * in the bundle), ancillary SHA256SUMS.txt, then run the default verify gate.
 *
 * Callers MUST have written all other bundle content already.
 */
export function finalizeNativeBundle(opts: {
  bundleDir: string;
  scenarioId: string;
  profileId: string;
  provenance: BundleProvenance;
  note?: string;
  expected?: Parameters<typeof checkBundleProvenance>[1];
}): NativeBundleGate {
  const { provenance } = opts;
  const identityRunId =
    provenance.identity.agentInspectRunId ?? provenance.identity.executionId;

  writeJson(opts.bundleDir, 'provenance.json', provenance);
  writeLabEvidenceManifest({
    artifactDir: opts.bundleDir,
    identityRunId,
    scenarioId: opts.scenarioId,
    profileId: opts.profileId,
    agentInspectVersion: provenance.agentInspect.installedVersion,
    appGitSha: provenance.app.gitSha,
    provenanceInputs: provenanceInputs(provenance),
    note: opts.note,
  });
  finalizeChecksums(opts.bundleDir);

  const checksumProblems = verifyChecksums(opts.bundleDir);
  const verify = runNativeBundleVerify(opts.bundleDir);
  const provenanceIssues = checkBundleProvenance(opts.bundleDir, opts.expected);
  const ok =
    verify.ok && checksumProblems.length === 0 && provenanceIssues.length === 0;

  const reportPath = writeAncillaryJson(opts.bundleDir, 'bundle-verify.json', {
    gate: 'agent-inspect bundle verify --json (default --unexpected=fail)',
    ok,
    verify,
    checksumProblems,
    provenanceIssues,
    assessment: 'local/UNSAFE — not share-checked',
  });

  return {
    ok,
    bundleDir: opts.bundleDir,
    identityRunId,
    verify,
    checksumProblems,
    provenanceIssues,
    reportPath,
  };
}
