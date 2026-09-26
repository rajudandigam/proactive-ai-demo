import { inspectRun, step, observeOutcome } from 'agent-inspect';
import { createRequire } from 'node:module';
import { buildProviderBundle } from '../providers';
import type { IndependentCounters } from '../providers/types';

const requireAdv = createRequire(__filename);
const { getCurrentRunId } = requireAdv('agent-inspect/advanced') as {
  getCurrentRunId: () => string | undefined;
};

export type EveningRequest = {
  query: string;
  kind: 'movie' | 'tv';
};

export type EveningResult = {
  status: 'completed' | 'failed' | 'blocked';
  items?: Array<{ id: string; title: string; year?: string }>;
  proposal?: string;
  error?: string;
  counters: IndependentCounters;
  agentInspectRunId?: string;
  attributions: string[];
};

export async function runEveningPlanner(
  request: EveningRequest,
  opts?: {
    toolMode?: 'fixture' | 'live';
    traceDir?: string;
    executionId?: string;
  },
): Promise<EveningResult> {
  const toolMode = opts?.toolMode ?? 'fixture';
  const bundle = buildProviderBundle(toolMode === 'live' ? 'live' : 'fixture');
  const media = request.kind === 'movie' ? bundle.movies : bundle.tv;
  const executionId = opts?.executionId ?? `evening-${Date.now()}`;

  return inspectRun(
    'evening-planner',
    async () => {
      const result = await step.tool(`search_${request.kind}`, () =>
        media.search(request.query, { limit: 5 }),
      );
      if (!result.ok) {
        return {
          status:
            result.error === 'BLOCKED_NO_CREDENTIALS'
              ? ('blocked' as const)
              : ('failed' as const),
          error: `${result.error}: ${result.message}`,
          counters: bundle.counters,
          agentInspectRunId: getCurrentRunId(),
          attributions: [],
        };
      }
      const attributions = [result.provenance.attribution];
      const proposal = `Recommend: ${result.data
        .slice(0, 3)
        .map((i) => `${i.title}${i.year ? ` (${i.year})` : ''}`)
        .join('; ')}. Metadata only — not showtimes or tickets.`;

      await observeOutcome('evening_recommendation', {
        expectation: 'sourced media recommendations',
        status: 'passed',
        method: 'custom',
        actual: { count: result.data.length, kind: request.kind },
      });

      return {
        status: 'completed' as const,
        items: result.data.map((i) => ({
          id: i.id,
          title: i.title,
          year: i.year,
        })),
        proposal,
        counters: bundle.counters,
        agentInspectRunId: getCurrentRunId(),
        attributions,
      };
    },
    {
      silent: true,
      traceDir: opts?.traceDir ?? '.agent-inspect',
      correlationId: executionId,
      metadata: { workload: 'evening', kind: request.kind, toolMode },
    },
  );
}
