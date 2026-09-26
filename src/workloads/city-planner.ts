import { inspectRun, step, observeOutcome } from 'agent-inspect';
import { createRequire } from 'node:module';
import { buildProviderBundle } from '../providers';
import type { IndependentCounters } from '../providers/types';

const requireAdv = createRequire(__filename);
const { getCurrentRunId } = requireAdv('agent-inspect/advanced') as {
  getCurrentRunId: () => string | undefined;
};

export type CityPlanRequest = {
  city: string;
  country?: string;
  date: string;
  radiusMeters?: number;
  diet?: string;
  limit?: number;
};

export type CityPlanResult = {
  status: 'completed' | 'failed' | 'needs_disambiguation';
  places?: Array<{ name: string; country?: string }>;
  weatherSummary?: string;
  restaurants?: Array<{ id: string; name: string; openingHours: string | 'unknown' }>;
  hotels?: Array<{ id: string; name: string }>;
  proposal?: string;
  error?: string;
  counters: IndependentCounters;
  agentInspectRunId?: string;
  attributions: string[];
};

export async function runCityPlanner(
  request: CityPlanRequest,
  opts?: {
    toolMode?: 'fixture' | 'live';
    traceDir?: string;
    executionId?: string;
  },
): Promise<CityPlanResult> {
  const toolMode = opts?.toolMode ?? 'fixture';
  const bundle = buildProviderBundle(toolMode === 'live' ? 'live' : 'fixture');
  const executionId = opts?.executionId ?? `city-${Date.now()}`;
  const traceDir = opts?.traceDir ?? '.agent-inspect';

  return inspectRun(
    'city-day-planner',
    async () => {
      const attributions: string[] = [];
      const radius = request.radiusMeters ?? 800;
      const limit = request.limit ?? 3;

      const geo = await step.tool('geocode_city', () =>
        bundle.weather.geocodeCity(request.city, {
          country: request.country,
        }),
      );
      if (!geo.ok) {
        return {
          status: 'failed' as const,
          error: `${geo.error}: ${geo.message}`,
          counters: bundle.counters,
          agentInspectRunId: getCurrentRunId(),
          attributions,
        };
      }
      if (geo.provenance) attributions.push(geo.provenance.attribution);
      if (geo.data.length > 1 && !request.country) {
        return {
          status: 'needs_disambiguation' as const,
          places: geo.data.map((p) => ({ name: p.name, country: p.country })),
          counters: bundle.counters,
          agentInspectRunId: getCurrentRunId(),
          attributions,
        };
      }
      const place = geo.data[0]!;

      const [weather, restaurants, hotels] = await Promise.all([
        step.tool('read_weather', () =>
          bundle.weather.forecast(place, request.date),
        ),
        step.tool('read_restaurants', () =>
          bundle.places.nearby({
            latitude: place.latitude,
            longitude: place.longitude,
            radiusMeters: radius,
            category: 'restaurant',
            limit,
          }),
        ),
        step.tool('read_hotels', () =>
          bundle.places.nearby({
            latitude: place.latitude,
            longitude: place.longitude,
            radiusMeters: radius,
            category: 'hotel',
            limit,
          }),
        ),
      ]);

      if (weather.ok && weather.provenance) {
        attributions.push(weather.provenance.attribution);
      }
      if (restaurants.ok && restaurants.provenance) {
        attributions.push(restaurants.provenance.attribution);
      }

      if (!weather.ok) {
        return {
          status: 'failed' as const,
          error: `${weather.error}: ${weather.message}`,
          counters: bundle.counters,
          agentInspectRunId: getCurrentRunId(),
          attributions,
        };
      }

      const rest = restaurants.ok ? restaurants.data : [];
      const hotel = hotels.ok ? hotels.data : [];
      const diet = request.diet ? ` (diet: ${request.diet})` : '';
      const proposal = `In ${place.name} on ${request.date}: ${weather.data.summary}. Consider ${rest.map((r) => r.name).join(', ') || 'no mapped restaurants'}${diet}. Mapped hotels: ${hotel.map((h) => h.name).join(', ') || 'none'}. Opening hours/ratings remain unknown unless tagged.`;

      await observeOutcome('city_plan_ready', {
        expectation: 'bounded city plan with attributions',
        status: 'passed',
        method: 'custom',
        actual: {
          restaurantCount: rest.length,
          hotelCount: hotel.length,
          toolMode,
        },
      });

      return {
        status: 'completed' as const,
        places: [{ name: place.name, country: place.country }],
        weatherSummary: weather.data.summary,
        restaurants: rest.map((r) => ({
          id: r.id,
          name: r.name,
          openingHours: r.openingHours,
        })),
        hotels: hotel.map((h) => ({ id: h.id, name: h.name })),
        proposal,
        counters: bundle.counters,
        agentInspectRunId: getCurrentRunId(),
        attributions: [...new Set(attributions)],
      };
    },
    {
      silent: true,
      traceDir,
      correlationId: executionId,
      metadata: { workload: 'city', city: request.city, toolMode },
    },
  );
}
