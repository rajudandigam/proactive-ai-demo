import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  GeoPlace,
  IndependentCounters,
  MappedPlace,
  MediaItem,
  MediaProvider,
  PlacesProvider,
  ProviderMode,
  ProviderResult,
  WeatherForecast,
  WeatherProvider,
  createCounters,
} from './types';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function loadFixture<T>(name: string): T {
  const path = join(process.cwd(), 'fixtures', 'providers', name);
  if (!existsSync(path)) {
    throw new Error(`Missing provider fixture: ${name}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export class FixtureWeatherProvider implements WeatherProvider {
  readonly id = 'fixture-weather';
  constructor(private readonly counters: IndependentCounters) {}

  async geocodeCity(
    query: string,
  ): Promise<ProviderResult<GeoPlace[]>> {
    this.counters.geocodeCalls += 1;
    this.counters.lastArgs.push({ tool: 'geocode', query });
    const q = query.trim().toLowerCase();
    if (!q || q.length < 2) {
      return { ok: false, error: 'INVALID_ARGS', message: 'city query too short' };
    }
    const data = loadFixture<{ places: GeoPlace[] }>('geocode-boston.json');
    if (q.includes('springfield')) {
      return {
        ok: true,
        data: [
          {
            name: 'Springfield',
            country: 'US-IL',
            latitude: 39.7817,
            longitude: -89.6501,
          },
          {
            name: 'Springfield',
            country: 'US-MA',
            latitude: 42.1015,
            longitude: -72.5898,
          },
        ],
        provenance: {
          sourceId: 'fixture-geocode',
          endpointOrigin: 'fixture://geocode',
          attribution: 'Fixture geocode data for offline lab',
          fetchedAt: new Date().toISOString(),
          ttlSeconds: 86400,
          mode: 'fixture',
          responseHash: hash('springfield'),
        },
      };
    }
    const matches = data.places.filter((p) =>
      p.name.toLowerCase().includes(q.split(',')[0]!.trim()),
    );
    return {
      ok: true,
      data: matches.length ? matches : data.places,
      provenance: {
        sourceId: 'fixture-geocode',
        endpointOrigin: 'fixture://geocode',
        attribution: 'Fixture geocode data for offline lab',
        fetchedAt: new Date().toISOString(),
        ttlSeconds: 86400,
        mode: 'fixture',
        responseHash: hash(matches),
      },
    };
  }

  async forecast(
    place: GeoPlace,
    date: string,
  ): Promise<ProviderResult<WeatherForecast>> {
    this.counters.forecastCalls += 1;
    this.counters.lastArgs.push({ tool: 'forecast', place, date });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: 'INVALID_ARGS', message: 'date must be YYYY-MM-DD' };
    }
    const data = loadFixture<WeatherForecast>('weather-boston.json');
    return {
      ok: true,
      data: { ...data, place, date },
      provenance: {
        sourceId: 'fixture-weather',
        endpointOrigin: 'fixture://forecast',
        attribution: 'Fixture weather for offline lab',
        fetchedAt: new Date().toISOString(),
        validAt: date,
        ttlSeconds: 3600,
        mode: 'fixture',
        responseHash: hash({ place, date }),
      },
    };
  }
}

export class FixturePlacesProvider implements PlacesProvider {
  readonly id = 'fixture-places';
  constructor(private readonly counters: IndependentCounters) {}

  async nearby(args: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    category: 'restaurant' | 'hotel';
    limit: number;
  }): Promise<ProviderResult<MappedPlace[]>> {
    this.counters.placesCalls += 1;
    this.counters.lastArgs.push({ tool: 'nearby', ...args });
    if (args.radiusMeters <= 0 || args.radiusMeters > 5000) {
      return {
        ok: false,
        error: 'INVALID_ARGS',
        message: 'radiusMeters must be 1..5000',
      };
    }
    if (args.limit < 1 || args.limit > 10) {
      return {
        ok: false,
        error: 'INVALID_ARGS',
        message: 'limit must be 1..10',
      };
    }
    const data = loadFixture<{ places: MappedPlace[] }>('places-boston.json');
    const filtered = data.places
      .filter((p) => p.category === args.category)
      .slice(0, args.limit);
    return {
      ok: true,
      data: filtered,
      provenance: {
        sourceId: 'fixture-overpass',
        endpointOrigin: 'fixture://overpass',
        attribution: 'Fixture OSM-like places; not live availability',
        fetchedAt: new Date().toISOString(),
        ttlSeconds: 3600,
        mode: 'fixture',
        responseHash: hash(filtered),
      },
    };
  }
}

export class FixtureMediaProvider implements MediaProvider {
  readonly id = 'fixture-media';
  constructor(
    private readonly counters: IndependentCounters,
    private readonly kind: 'movie' | 'tv',
  ) {}

  async search(query: string): Promise<ProviderResult<MediaItem[]>> {
    this.counters.mediaCalls += 1;
    this.counters.lastArgs.push({ tool: 'media', kind: this.kind, query });
    if (!query.trim()) {
      return { ok: false, error: 'INVALID_ARGS', message: 'empty query' };
    }
    const file =
      this.kind === 'movie' ? 'media-movies.json' : 'media-tv.json';
    const data = loadFixture<{ items: MediaItem[] }>(file);
    const items = data.items.filter((i) =>
      i.title.toLowerCase().includes(query.toLowerCase()),
    );
    return {
      ok: true,
      data: items.length ? items : data.items.slice(0, 3),
      provenance: {
        sourceId: this.kind === 'movie' ? 'fixture-tmdb' : 'fixture-tvmaze',
        endpointOrigin: `fixture://${this.kind}`,
        attribution:
          this.kind === 'movie'
            ? 'Fixture TMDB-shaped metadata (not showtimes)'
            : 'Fixture TVmaze-shaped metadata',
        fetchedAt: new Date().toISOString(),
        ttlSeconds: 86400,
        mode: 'fixture',
        responseHash: hash(query),
      },
    };
  }
}

export class LiveWeatherProvider implements WeatherProvider {
  readonly id = 'open-meteo';
  constructor(
    private readonly counters: IndependentCounters,
    private readonly mode: ProviderMode = 'live',
  ) {}

  async geocodeCity(
    query: string,
    opts?: { country?: string; signal?: AbortSignal },
  ): Promise<ProviderResult<GeoPlace[]>> {
    this.counters.geocodeCalls += 1;
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', query);
    url.searchParams.set('count', '5');
    url.searchParams.set('language', 'en');
    url.searchParams.set('format', 'json');
    if (opts?.country) url.searchParams.set('countryCode', opts.country);
    try {
      const res = await fetch(url, { signal: opts?.signal });
      if (res.status === 429) {
        return { ok: false, error: 'RATE_LIMITED', message: 'Open-Meteo 429' };
      }
      if (!res.ok) {
        return {
          ok: false,
          error: 'NETWORK',
          message: `Open-Meteo geocode HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as {
        results?: Array<{
          name: string;
          country_code?: string;
          latitude: number;
          longitude: number;
          timezone?: string;
        }>;
      };
      const places: GeoPlace[] = (body.results ?? []).map((r) => ({
        name: r.name,
        country: r.country_code,
        latitude: r.latitude,
        longitude: r.longitude,
        timezone: r.timezone,
      }));
      return {
        ok: true,
        data: places,
        provenance: {
          sourceId: 'open-meteo-geocoding',
          endpointOrigin: url.origin,
          attribution: 'Weather data by Open-Meteo.com',
          fetchedAt: new Date().toISOString(),
          ttlSeconds: 86400,
          mode: this.mode,
          responseHash: hash(places),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: 'NETWORK',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async forecast(
    place: GeoPlace,
    date: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ProviderResult<WeatherForecast>> {
    this.counters.forecastCalls += 1;
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(place.latitude));
    url.searchParams.set('longitude', String(place.longitude));
    url.searchParams.set('daily', 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('timezone', place.timezone ?? 'auto');
    url.searchParams.set('start_date', date);
    url.searchParams.set('end_date', date);
    try {
      const res = await fetch(url, { signal: opts?.signal });
      if (!res.ok) {
        return {
          ok: false,
          error: 'NETWORK',
          message: `Open-Meteo forecast HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as {
        daily?: {
          weathercode?: number[];
          temperature_2m_max?: number[];
          temperature_2m_min?: number[];
          precipitation_probability_max?: number[];
        };
      };
      const data: WeatherForecast = {
        place,
        date,
        summary: `weathercode=${body.daily?.weathercode?.[0] ?? 'unknown'}`,
        temperatureMaxC: body.daily?.temperature_2m_max?.[0] ?? 'unknown',
        temperatureMinC: body.daily?.temperature_2m_min?.[0] ?? 'unknown',
        precipitationProbability:
          body.daily?.precipitation_probability_max?.[0] ?? 'unknown',
      };
      return {
        ok: true,
        data,
        provenance: {
          sourceId: 'open-meteo-forecast',
          endpointOrigin: url.origin,
          attribution: 'Weather data by Open-Meteo.com',
          fetchedAt: new Date().toISOString(),
          validAt: date,
          ttlSeconds: 3600,
          mode: this.mode,
          responseHash: hash(data),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: 'NETWORK',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export class LivePlacesProvider implements PlacesProvider {
  readonly id = 'overpass';
  constructor(private readonly counters: IndependentCounters) {}

  async nearby(args: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    category: 'restaurant' | 'hotel';
    limit: number;
  }, opts?: { signal?: AbortSignal }): Promise<ProviderResult<MappedPlace[]>> {
    this.counters.placesCalls += 1;
    if (args.radiusMeters > 1500 || args.limit > 5) {
      return {
        ok: false,
        error: 'INVALID_ARGS',
        message: 'live Overpass bound: radius<=1500, limit<=5',
      };
    }
    const amenity = args.category === 'hotel' ? 'hotel' : 'restaurant';
    const query = `
      [out:json][timeout:15];
      (
        node["amenity"="${amenity}"](around:${args.radiusMeters},${args.latitude},${args.longitude});
      );
      out body ${args.limit};
    `;
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'proactive-ai-demo-playground/1.0 (lab; contact: local)',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: opts?.signal,
      });
      if (res.status === 429) {
        return { ok: false, error: 'RATE_LIMITED', message: 'Overpass 429' };
      }
      if (!res.ok) {
        return {
          ok: false,
          error: 'NETWORK',
          message: `Overpass HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as {
        elements?: Array<{
          id: number;
          lat: number;
          lon: number;
          tags?: Record<string, string>;
        }>;
      };
      const places: MappedPlace[] = (body.elements ?? []).slice(0, args.limit).map((e) => ({
        id: String(e.id),
        name: e.tags?.name ?? `unnamed-${e.id}`,
        category: args.category,
        latitude: e.lat,
        longitude: e.lon,
        tags: e.tags ?? {},
        openingHours: e.tags?.opening_hours ?? 'unknown',
        rating: 'unknown',
        priceLevel: 'unknown',
      }));
      return {
        ok: true,
        data: places,
        provenance: {
          sourceId: 'overpass',
          endpointOrigin: 'https://overpass-api.de',
          attribution: '© OpenStreetMap contributors',
          fetchedAt: new Date().toISOString(),
          ttlSeconds: 3600,
          mode: 'live',
          responseHash: hash(places.map((p) => p.id)),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: 'NETWORK',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export class LiveTmdbProvider implements MediaProvider {
  readonly id = 'tmdb';
  constructor(private readonly counters: IndependentCounters) {}

  async search(
    query: string,
    opts?: { signal?: AbortSignal; limit?: number },
  ): Promise<ProviderResult<MediaItem[]>> {
    this.counters.mediaCalls += 1;
    const key = process.env.TMDB_API_KEY;
    if (!key) {
      return {
        ok: false,
        error: 'BLOCKED_NO_CREDENTIALS',
        message: 'TMDB_API_KEY not set',
      };
    }
    const url = new URL('https://api.themoviedb.org/3/search/movie');
    url.searchParams.set('query', query);
    url.searchParams.set('api_key', key);
    try {
      const res = await fetch(url, { signal: opts?.signal });
      if (!res.ok) {
        return {
          ok: false,
          error: 'NETWORK',
          message: `TMDB HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as {
        results?: Array<{
          id: number;
          title: string;
          overview?: string;
          release_date?: string;
        }>;
      };
      const items: MediaItem[] = (body.results ?? [])
        .slice(0, opts?.limit ?? 5)
        .map((r) => ({
          id: String(r.id),
          title: r.title,
          kind: 'movie' as const,
          overview: r.overview,
          year: r.release_date?.slice(0, 4),
          attribution: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
        }));
      return {
        ok: true,
        data: items,
        provenance: {
          sourceId: 'tmdb',
          endpointOrigin: 'https://api.themoviedb.org',
          attribution: 'TMDB API — attribution required',
          fetchedAt: new Date().toISOString(),
          ttlSeconds: 86400,
          mode: 'live',
          responseHash: hash(items.map((i) => i.id)),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: 'NETWORK',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export class LiveTvmazeProvider implements MediaProvider {
  readonly id = 'tvmaze';
  constructor(private readonly counters: IndependentCounters) {}

  async search(
    query: string,
    opts?: { signal?: AbortSignal; limit?: number },
  ): Promise<ProviderResult<MediaItem[]>> {
    this.counters.mediaCalls += 1;
    const url = new URL('https://api.tvmaze.com/search/shows');
    url.searchParams.set('q', query);
    try {
      const res = await fetch(url, { signal: opts?.signal });
      if (res.status === 429) {
        return { ok: false, error: 'RATE_LIMITED', message: 'TVmaze 429' };
      }
      if (!res.ok) {
        return {
          ok: false,
          error: 'NETWORK',
          message: `TVmaze HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as Array<{
        show: { id: number; name: string; summary?: string; premiered?: string };
      }>;
      const items: MediaItem[] = body.slice(0, opts?.limit ?? 5).map((r) => ({
        id: String(r.show.id),
        title: r.show.name,
        kind: 'tv' as const,
        overview: r.show.summary?.replace(/<[^>]+>/g, ''),
        year: r.show.premiered?.slice(0, 4),
        attribution: 'TVmaze.com — ShareAlike attribution applies',
      }));
      return {
        ok: true,
        data: items,
        provenance: {
          sourceId: 'tvmaze',
          endpointOrigin: 'https://api.tvmaze.com',
          attribution: 'TVmaze API',
          fetchedAt: new Date().toISOString(),
          ttlSeconds: 86400,
          mode: 'live',
          responseHash: hash(items.map((i) => i.id)),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: 'NETWORK',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function buildProviderBundle(mode: ProviderMode) {
  const counters = createCounters();
  if (mode === 'live') {
    return {
      mode,
      counters,
      weather: new LiveWeatherProvider(counters),
      places: new LivePlacesProvider(counters),
      movies: new LiveTmdbProvider(counters),
      tv: new LiveTvmazeProvider(counters),
    };
  }
  return {
    mode: 'fixture' as const,
    counters,
    weather: new FixtureWeatherProvider(counters),
    places: new FixturePlacesProvider(counters),
    movies: new FixtureMediaProvider(counters, 'movie'),
    tv: new FixtureMediaProvider(counters, 'tv'),
  };
}
