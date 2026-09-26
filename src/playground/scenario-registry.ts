import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ScenarioDefinition,
  ScenarioDefinitionSchema,
} from './schemas';

export type ScenarioFile = ScenarioDefinition & {
  _lab?: {
    seedPriorEvent?: boolean;
    parallelSibling?: Record<string, unknown>;
    assertTraceHasSteps?: string[];
    assertNoLlmSteps?: boolean;
    workload?: string;
  };
};

const SUITE_DIRS = [
  'travel-core',
  'city-evening',
  'orchestration',
  'contracts',
  'lifecycle',
];

export function loadScenarios(
  dir?: string,
): ScenarioFile[] {
  if (dir) {
    return loadDir(dir);
  }
  const root = join(process.cwd(), 'scenarios');
  return SUITE_DIRS.flatMap((s) => loadDir(join(root, s)));
}

function loadDir(dir: string): ScenarioFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ScenarioFile;
      const parsed = ScenarioDefinitionSchema.parse(raw);
      return { ...parsed, _lab: raw._lab };
    });
}

export function getScenario(id: string): ScenarioFile {
  const found = loadScenarios().find((s) => s.id === id);
  if (!found) throw new Error(`Unknown scenario: ${id}`);
  return found;
}

export function listSuite(suite: string): ScenarioFile[] {
  return loadScenarios().filter((s) => s.suite === suite);
}
