import { Injectable } from '@nestjs/common';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ScenarioFixture,
  ScenarioFixtureSchema,
  EvidenceItem,
} from './schemas';
import { DemoClockService } from './demo-clock.service';

@Injectable()
export class FixtureToolsService {
  private fixtures = new Map<string, ScenarioFixture>();
  private activeScenarioId: string | null = null;

  constructor(private readonly clock: DemoClockService) {
    this.loadAllFromDisk();
  }

  reset(): void {
    this.fixtures.clear();
    this.activeScenarioId = null;
    this.clock.clear();
    this.loadAllFromDisk();
  }

  private fixtureDirs(): string[] {
    const candidates = [
      join(process.cwd(), 'fixtures', 'scenarios'),
      join(__dirname, '..', '..', 'fixtures', 'scenarios'),
      join(__dirname, '..', 'fixtures', 'scenarios'),
    ];
    return candidates.filter((dir) => existsSync(dir));
  }

  private loadAllFromDisk(): void {
    const dir = this.fixtureDirs()[0];
    if (!dir) {
      throw new Error('fixtures/scenarios directory not found');
    }
    for (const name of [
      'jordan-before-departure.json',
      'jordan-flight-change.json',
    ]) {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const parsed = ScenarioFixtureSchema.parse(raw);
      this.fixtures.set(parsed.scenarioId, parsed);
    }
  }

  listScenarioIds(): string[] {
    return [...this.fixtures.keys()];
  }

  activateScenario(scenarioId: string): ScenarioFixture {
    const fixture = this.fixtures.get(scenarioId);
    if (!fixture) {
      throw new Error(`Unknown scenarioId: ${scenarioId}`);
    }
    this.activeScenarioId = scenarioId;
    this.clock.setNow(fixture.now);
    return structuredClone(fixture);
  }

  getActiveScenario(): ScenarioFixture {
    if (!this.activeScenarioId) {
      throw new Error('No active scenario');
    }
    const fixture = this.fixtures.get(this.activeScenarioId);
    if (!fixture) {
      throw new Error(`Active scenario missing: ${this.activeScenarioId}`);
    }
    return structuredClone(fixture);
  }

  /** Test/helper override: mutate an already-loaded scenario in memory. */
  replaceScenario(fixture: ScenarioFixture): void {
    this.fixtures.set(fixture.scenarioId, fixture);
  }

  assertOwnership(actorId: string, tripId: string): ScenarioFixture {
    const fixture = this.getActiveScenario();
    if (fixture.actor.id !== actorId) {
      throw new Error(`Actor mismatch: expected ${fixture.actor.id}, got ${actorId}`);
    }
    if (fixture.trip.id !== tripId) {
      throw new Error(`Trip mismatch: expected ${fixture.trip.id}, got ${tripId}`);
    }
    if (fixture.trip.ownerId !== actorId) {
      throw new Error(`Ownership check failed for trip ${tripId}`);
    }
    return fixture;
  }

  readTrip(tripId: string) {
    const fixture = this.getActiveScenario();
    if (fixture.trip.id !== tripId) {
      throw new Error(`Trip ${tripId} not in active scenario`);
    }
    return fixture.trip;
  }

  readTraveler() {
    return this.getActiveScenario().traveler;
  }

  readEvidence(): EvidenceItem[] {
    return this.getActiveScenario().evidence;
  }

  readEvidenceById(id: string): EvidenceItem | undefined {
    return this.readEvidence().find((e) => e.id === id);
  }

  readRecentActivity() {
    return this.getActiveScenario().recentActivity;
  }

  readRecentMessages() {
    return this.getActiveScenario().recentMessages;
  }

  hotelIsBooked(): boolean {
    const fixture = this.getActiveScenario();
    if (fixture.trip.hotel.status === 'confirmed') {
      return true;
    }
    return fixture.evidence.some(
      (e) =>
        e.id.startsWith('hotel-booking') &&
        (e as { status?: string }).status === 'confirmed',
    );
  }

  getFlightEvidence(): EvidenceItem | undefined {
    return this.readEvidence()
      .filter((e) => e.source === 'mock-flight-service')
      .sort((a, b) => b.id.localeCompare(a.id))[0];
  }
}
