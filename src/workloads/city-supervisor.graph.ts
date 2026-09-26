import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { inspectRun, step, observeOutcome } from 'agent-inspect';
import { createRequire } from 'node:module';
import { buildProviderBundle } from '../providers';
import type { GeoPlace, IndependentCounters } from '../providers/types';

const requireAdv = createRequire(__filename);
const { getCurrentRunId } = requireAdv('agent-inspect/advanced') as {
  getCurrentRunId: () => string | undefined;
};

type GraphState = {
  city: string;
  date: string;
  place?: GeoPlace;
  weatherSummary?: string;
  restaurantNames?: string[];
  proposal?: string;
  error?: string;
  counters?: IndependentCounters;
};

const State = Annotation.Root({
  city: Annotation<string>,
  date: Annotation<string>,
  place: Annotation<GeoPlace | undefined>,
  weatherSummary: Annotation<string | undefined>,
  restaurantNames: Annotation<string[] | undefined>,
  proposal: Annotation<string | undefined>,
  error: Annotation<string | undefined>,
  counters: Annotation<IndependentCounters | undefined>,
});

/**
 * Explicit LangGraph with conditional edges (not a flat while-loop).
 * Uses installed @langchain/langgraph 0.2.x with manual AgentInspect steps.
 */
export async function runCitySupervisorGraph(
  input: { city: string; date: string },
  opts?: { toolMode?: 'fixture' | 'live'; traceDir?: string; executionId?: string },
) {
  const toolMode = opts?.toolMode ?? 'fixture';
  const bundle = buildProviderBundle(toolMode === 'live' ? 'live' : 'fixture');

  return inspectRun(
    'city-supervisor-graph',
    async () => {
      const graph = new StateGraph(State)
        .addNode('geocode', async (s) =>
          step('geocode_node', async () => {
            const geo = await step.tool('geocode_city', () =>
              bundle.weather.geocodeCity(s.city),
            );
            if (!geo.ok) return { error: geo.message, counters: bundle.counters };
            return { place: geo.data[0], counters: bundle.counters };
          }),
        )
        .addNode('parallel_reads', async (s) =>
          step('parallel_reads', async () => {
            if (!s.place) return { error: 'missing place' };
            const [w, r] = await Promise.all([
              step.tool('weather_worker', () =>
                bundle.weather.forecast(s.place!, s.date),
              ),
              step.tool('places_worker', () =>
                bundle.places.nearby({
                  latitude: s.place!.latitude,
                  longitude: s.place!.longitude,
                  radiusMeters: 800,
                  category: 'restaurant',
                  limit: 3,
                }),
              ),
            ]);
            return {
              weatherSummary: w.ok ? w.data.summary : undefined,
              restaurantNames: r.ok ? r.data.map((x) => x.name) : [],
              error: !w.ok ? w.message : undefined,
              counters: bundle.counters,
            };
          }),
        )
        .addNode('synthesize', async (s) =>
          step('synthesize', async () => {
            const proposal = `Supervisor plan for ${s.city}: ${s.weatherSummary}. Restaurants: ${(s.restaurantNames ?? []).join(', ')}`;
            await observeOutcome('supervisor_plan', {
              expectation: 'weather+places joined before synthesis',
              status: s.error ? 'failed' : 'passed',
              method: 'custom',
              actual: {
                restaurants: s.restaurantNames?.length ?? 0,
                counters: bundle.counters,
              },
            });
            return { proposal, counters: bundle.counters };
          }),
        )
        .addEdge(START, 'geocode')
        .addConditionalEdges('geocode', (s) => (s.error ? 'synthesize' : 'parallel_reads'))
        .addEdge('parallel_reads', 'synthesize')
        .addEdge('synthesize', END)
        .compile();

      const final = await graph.invoke({
        city: input.city,
        date: input.date,
      } as GraphState);

      return {
        ...final,
        agentInspectRunId: getCurrentRunId(),
        toolMode,
      };
    },
    {
      silent: true,
      traceDir: opts?.traceDir ?? '.agent-inspect',
      correlationId: opts?.executionId ?? `supervisor-${Date.now()}`,
      metadata: { workload: 'city-supervisor', toolMode },
    },
  );
}
