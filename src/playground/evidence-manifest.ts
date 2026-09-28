import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

const MANIFEST_NAME = 'evidence.json';

export function writeLabEvidenceManifest(opts: {
  artifactDir: string;
  agentInspectRunId: string;
  scenarioId: string;
  profileId: string;
  agentInspectVersion: string;
  appGitSha: string;
}): string | null {
  if (!opts.agentInspectRunId) return null;

  const tracePath = join(opts.artifactDir, 'trace.jsonl');
  const traceContent = existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8')
    : '';

  const packaged: Array<{ path: string; content: string }> = [];
  for (const rel of listFilesRecursive(opts.artifactDir)) {
    if (rel === MANIFEST_NAME || rel === 'SHA256SUMS.txt') continue;
    packaged.push({
      path: rel,
      content: readFileSync(join(opts.artifactDir, rel), 'utf8'),
    });
  }

  const sourceHash = createHash('sha256')
    .update(traceContent || opts.agentInspectRunId)
    .digest('hex');

  const manifest = buildEvidenceManifest({
    generatorVersion: opts.agentInspectVersion,
    generatorName: 'proactive-ai-demo-lab',
    runIds: [opts.agentInspectRunId],
    traceSchemaVersions: traceContent
      ? collectTraceSchemaVersions(traceContent)
      : ['unknown'],
    sourceHashes: [
      {
        runId: opts.agentInspectRunId,
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
      labArtifactDir: opts.artifactDir,
    },
    note: 'Playground lab pack — local-only; not share-checked.',
  });

  const outPath = join(opts.artifactDir, MANIFEST_NAME);
  writeFileSync(outPath, serializeEvidenceManifest(manifest));
  return outPath;
}
