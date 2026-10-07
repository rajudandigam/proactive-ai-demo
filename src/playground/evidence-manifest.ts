import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { listFilesRecursive } from './artifact-writer';

const requireAdv = createRequire(__filename);
const {
  buildEvidenceManifest,
  collectTraceSchemaVersions,
  serializeEvidenceManifest,
} = requireAdv('agent-inspect/advanced') as {
  buildEvidenceManifest: (parts: Record<string, unknown>) => unknown;
  collectTraceSchemaVersions: (content: string) => string[];
  serializeEvidenceManifest: (manifest: unknown) => string;
};

export const MANIFEST_NAME = 'evidence.json';

/**
 * Write evidence.json for a closed native bundle.
 *
 * Every other file under `artifactDir` is listed in the manifest, so callers
 * must finish writing bundle content first. Ancillary checksums and
 * verification reports belong outside the bundle (see `ancillaryDirFor`).
 *
 * `identityRunId` is the AgentInspect run id when a trace exists, otherwise
 * the preallocated execution id, so failure/thrown packs are still bound to
 * a stable run identity.
 */
export function writeLabEvidenceManifest(opts: {
  artifactDir: string;
  identityRunId: string;
  scenarioId: string;
  profileId: string;
  agentInspectVersion: string;
  appGitSha: string;
  /** Flat string inputs bound into the manifest (full digests only). */
  provenanceInputs?: Record<string, string>;
  note?: string;
}): string | null {
  if (!opts.identityRunId) return null;

  const tracePath = join(opts.artifactDir, 'trace.jsonl');
  const traceContent = existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8')
    : '';

  const packaged: Array<{ path: string; content: string }> = [];
  for (const rel of listFilesRecursive(opts.artifactDir)) {
    if (rel === MANIFEST_NAME) continue;
    packaged.push({
      path: rel,
      content: readFileSync(join(opts.artifactDir, rel), 'utf8'),
    });
  }

  const sourceHash = createHash('sha256')
    .update(traceContent || opts.identityRunId)
    .digest('hex');

  const manifest = buildEvidenceManifest({
    generatorVersion: opts.agentInspectVersion,
    generatorName: 'proactive-ai-demo-lab',
    runIds: [opts.identityRunId],
    traceSchemaVersions: traceContent
      ? collectTraceSchemaVersions(traceContent)
      : ['unknown'],
    sourceHashes: [
      {
        runId: opts.identityRunId,
        algorithm: 'sha256',
        hash: sourceHash,
      },
    ],
    redactionProfile: 'local',
    assessmentStatus: 'UNSAFE',
    sourceStatus: 'UNSAFE',
    files: packaged,
    inputs: {
      scenarioId: opts.scenarioId,
      profileId: opts.profileId,
      appGitSha: opts.appGitSha,
      labArtifactDir:
        relative(process.cwd(), opts.artifactDir).split('\\').join('/') || '.',
      ...(opts.provenanceInputs ?? {}),
    },
    note:
      opts.note ?? 'Playground lab pack — local-only; not share-checked.',
  });

  const outPath = join(opts.artifactDir, MANIFEST_NAME);
  writeFileSync(outPath, serializeEvidenceManifest(manifest));
  return outPath;
}
