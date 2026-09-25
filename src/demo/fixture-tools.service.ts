import { Injectable } from '@nestjs/common';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ScenarioFixture,
  ScenarioFixtureSchema,
  EvidenceItem,
  DemoRunContext,
} from './schemas';

@Injectable()
export class FixtureToolsService {
  private fixtures = new Map<string, ScenarioFixture>();

  constructor() {
    this.loadAllFromDisk();
  }

  reset(): void {
    this.fixtures.clear();
    this.loadAllFromDisk();
  }

  private fixtureDirs(): string[] {
    const candidates = [
      join(process.cwd(), 'fixtures', 'scenarios'),
      join(__dirname, '..', '..', 'fixtures', 'scenarios'),
    ];
    return candidates.filter((dir) => existsSync(dir));
  }

  private loadAllFromDisk(): void {
    const dir = this.fixtureDirs()[0];
    if (!dir) {
      throw new Error('fixtures/scenarios directory not found');
    }
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const parsed = ScenarioFixtureSchema.parse(raw);
      this.fixtures.set(parsed.scenarioId, parsed);
    }
  }

  listScenarioIds(): string[] {
    return [...this.fixtures.keys()].sort();
  }

  listPresets(): Array<{
    scenarioId: string;
    preset?: string;
    label?: string;
  }> {
    return [...this.fixtures.values()].map((f) => ({
      scenarioId: f.scenarioId,
      preset: f.preset,
      label: f.label ?? f.scenarioId,
    }));
  }

  getScenario(scenarioId: string): ScenarioFixture {
    const fixture = this.fixtures.get(scenarioId);
    if (!fixture) {
      throw new Error(`Unknown scenarioId: ${scenarioId}`);
    }
    return structuredClone(fixture);
  }

  /** Test helper: mutate an already-loaded scenario in memory. */
  replaceScenario(fixture: ScenarioFixture): void {
    this.fixtures.set(fixture.scenarioId, fixture);
  }

  assertOwnership(ctx: DemoRunContext, tripId: string): void {
    if (ctx.scenario.trip.id !== tripId) {
      throw new Error(`Trip mismatch: expected ${ctx.scenario.trip.id}, got ${tripId}`);
    }
    if (ctx.scenario.trip.ownerId !== ctx.actorId) {
      throw new Error(`Ownership check failed for trip ${tripId}`);
    }
  }

  readTrip(ctx: DemoRunContext) {
    return ctx.scenario.trip;
  }

  readTraveler(ctx: DemoRunContext) {
    return ctx.scenario.traveler;
  }

  readEvidence(ctx: DemoRunContext): EvidenceItem[] {
    return ctx.scenario.evidence;
  }

  readEvidenceById(ctx: DemoRunContext, id: string): EvidenceItem | undefined {
    return ctx.scenario.evidence.find((e) => e.id === id);
  }

  readRecentActivity(ctx: DemoRunContext) {
    return ctx.scenario.recentActivity;
  }

  readSeededMessages(ctx: DemoRunContext) {
    return ctx.scenario.recentMessages;
  }

  hotelIsBooked(ctx: DemoRunContext): boolean {
    if (ctx.scenario.trip.hotel.status === 'confirmed') return true;
    return ctx.scenario.evidence.some(
      (e) =>
        (e.kind === 'hotel_booking' || e.id.startsWith('hotel-booking')) &&
        (e as { status?: string }).status === 'confirmed',
    );
  }

  getFlightEvidence(ctx: DemoRunContext): EvidenceItem | undefined {
    const flights = ctx.scenario.evidence.filter(
      (e) =>
        e.kind === 'flight_status' || e.source === 'mock-flight-service',
    );
    return flights.sort((a, b) => {
      const at = Date.parse(String(a.checkedAt));
      const bt = Date.parse(String(b.checkedAt));
      return bt - at;
    })[0];
  }

  matchFlightSource(
    ctx: DemoRunContext,
    claimedVersion?: string,
  ): EvidenceItem | undefined {
    const flight = this.getFlightEvidence(ctx);
    if (!flight) return undefined;
    if (claimedVersion && flight.id !== claimedVersion) {
      return undefined;
    }
    return flight;
  }
}
