/**
 * Normalized provider fact envelope — unknown fields stay unknown.
 */
export type Provenance = {
  sourceId: string;
  sourceItemId?: string;
  endpointOrigin: string;
  attribution: string;
  responseHash?: string;
  fetchedAt: string;
  validAt?: string;
  ttlSeconds: number;
  mode: 'fixture' | 'live' | 'recorded';
};

export type ProviderErrorCode =
  | 'EMPTY'
  | 'STALE'
  | 'PARTIAL'
  | 'INVALID_ARGS'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'BLOCKED_NO_CREDENTIALS'
  | 'NETWORK'
  | 'UNKNOWN';

export type ProviderResult<T> =
  | { ok: true; data: T; provenance: Provenance }
  | {
      ok: false;
      error: ProviderErrorCode;
      message: string;
      provenance?: Partial<Provenance>;
    };

export type GeoPlace = {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
};

export type WeatherForecast = {
  place: GeoPlace;
  date: string;
  summary: string;
  precipitationProbability?: number | 'unknown';
  temperatureMaxC?: number | 'unknown';
  temperatureMinC?: number | 'unknown';
};

export type MappedPlace = {
  id: string;
  name: string;
  category: 'restaurant' | 'hotel' | 'other';
  latitude: number;
  longitude: number;
  tags: Record<string, string | undefined>;
  /** Never invent opening hours / prices / ratings. */
  openingHours: string | 'unknown';
  rating: number | 'unknown';
  priceLevel: string | 'unknown';
};

export type MediaItem = {
  id: string;
  title: string;
  kind: 'movie' | 'tv';
  overview?: string;
  year?: string;
  attribution: string;
};

export type ProviderMode = 'fixture' | 'live' | 'recorded';

export interface WeatherProvider {
  readonly id: string;
  geocodeCity(
    query: string,
    opts?: { country?: string; signal?: AbortSignal },
  ): Promise<ProviderResult<GeoPlace[]>>;
  forecast(
    place: GeoPlace,
    date: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ProviderResult<WeatherForecast>>;
}

export interface PlacesProvider {
  readonly id: string;
  nearby(
    args: {
      latitude: number;
      longitude: number;
      radiusMeters: number;
      category: 'restaurant' | 'hotel';
      limit: number;
    },
    opts?: { signal?: AbortSignal },
  ): Promise<ProviderResult<MappedPlace[]>>;
}

export interface MediaProvider {
  readonly id: string;
  search(
    query: string,
    opts?: { signal?: AbortSignal; limit?: number },
  ): Promise<ProviderResult<MediaItem[]>>;
}

export type IndependentCounters = {
  geocodeCalls: number;
  forecastCalls: number;
  placesCalls: number;
  mediaCalls: number;
  reservationWrites: number;
  reservationCommits: number;
  reservationResponseDrops: number;
  lastArgs: unknown[];
};

export function createCounters(): IndependentCounters {
  return {
    geocodeCalls: 0,
    forecastCalls: 0,
    placesCalls: 0,
    mediaCalls: 0,
    reservationWrites: 0,
    reservationCommits: 0,
    reservationResponseDrops: 0,
    lastArgs: [],
  };
}
