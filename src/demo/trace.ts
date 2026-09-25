import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type TraceNode = {
  name: string;
  status: string;
  durationMs: number;
  detail?: Record<string, unknown>;
};

export type DemoTrace = {
  modelMode: string;
  modelCalls: number;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  policy: Record<string, unknown>;
  evidence: Record<string, unknown>;
  validation: Record<string, unknown>;
  nodes: TraceNode[];
  versions: {
    skill: string;
    policy: string;
  };
};

export function loadSkillText(): { version: string; text: string } {
  const candidates = [
    join(process.cwd(), 'skills', 'trip-preparation.md'),
    join(__dirname, '..', '..', 'skills', 'trip-preparation.md'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      const versionMatch = text.match(/Version:\s*([0-9.]+)/);
      return { version: versionMatch?.[1] ?? '1.0.0', text };
    }
  }
  return { version: '1.0.0', text: 'Combine useful preparation facts.' };
}

export function serializeTrace(trace: DemoTrace): DemoTrace {
  return structuredClone(trace);
}
