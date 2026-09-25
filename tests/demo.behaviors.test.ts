import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DecisionGraphService } from '../src/demo/decision.graph';
import { DemoClockService } from '../src/demo/demo-clock.service';
import { FixtureToolsService } from '../src/demo/fixture-tools.service';
import { OutboxService } from '../src/demo/outbox.service';
import { PolicyService } from '../src/demo/policy.service';
import { ReadToolsService } from '../src/demo/read-tools.service';
import { DemoTraceService } from '../src/demo/trace-events.service';
import { TripAttentionAgentService } from '../src/demo/trip-attention.agent';
import { ValidationService } from '../src/demo/validation.service';
import { RunsService } from '../src/demo/runs.service';
import tripReview from '../fixtures/requests/trip-review.json';
import flightChange from '../fixtures/requests/flight-change.json';
import arrivalAffected from '../fixtures/requests/arrival-affected.json';
import arrivalUnaffected from '../fixtures/requests/arrival-unaffected.json';
import { createSessionId } from '../src/demo/schemas';

async function createApp() {
  const module: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [
          () => ({
            DECISION_PROVIDER: 'fixture',
            OPENAI_TIMEOUT_MS: '15000',
            AGENT_INSPECT: '0',
          }),
        ],
      }),
    ],
    providers: [
      DemoClockService,
      FixtureToolsService,
      PolicyService,
      ValidationService,
      OutboxService,
      ReadToolsService,
      DemoTraceService,
      TripAttentionAgentService,
      DecisionGraphService,
      RunsService,
    ],
  }).compile();

  const graph = module.get(DecisionGraphService);
  const outbox = module.get(OutboxService);
  const fixtures = module.get(FixtureToolsService);
  const traces = module.get(DemoTraceService);
  outbox.reset();
  fixtures.reset();
  return { module, graph, outbox, fixtures, traces };
}

describe('proactive AI demo v2', () => {
  it('before-departure: combine prep+weather, wait route, silent hotel', async () => {
    const { graph, outbox } = await createApp();
    const sessionId = createSessionId();
    const result = await graph.run(tripReview, { sessionId });

    expect(result.modelMode).toBe('fixture');
    expect(result.accounting?.fixtureInvocations).toBeGreaterThanOrEqual(1);
    expect(result.outboxWrites).toBe(1);

    const byReason = Object.fromEntries(
      result.decisions.map((d) => [d.reason, d]),
    );
    expect(byReason.COMBINED_TRIP_PREPARATION?.outcome).toBe('act_now');
    expect(byReason.ARRIVAL_GUIDANCE_NOT_DUE?.outcome).toBe('wait');
    expect(byReason.HOTEL_ALREADY_BOOKED?.outcome).toBe('silent');
    expect(outbox.getOutbox(sessionId)).toHaveLength(1);
  });

  it('quiet hours defer without model invocation', async () => {
    const { graph } = await createApp();
    const result = await graph.run({
      eventId: 'quiet-test-1',
      tripId: 'trip-jordan',
      type: 'TRIP_REVIEW',
      scenarioId: 'jordan-quiet-hours',
      signals: [
        { id: 'preparation-1', type: 'TRIP_PREPARATION' },
        { id: 'weather-1', type: 'WEATHER_UPDATE' },
      ],
    });
    expect(result.modelCalls).toBe(0);
    expect(result.accounting?.liveAttempts).toBe(0);
    expect(result.accounting?.fixtureInvocations).toBe(0);
    expect(
      result.decisions.every(
        (d) => d.outcome === 'wait' && d.reason === 'QUIET_HOURS',
      ),
    ).toBe(true);
  });

  it('consent disabled suppresses optional without model call', async () => {
    const { graph } = await createApp();
    const result = await graph.run({
      eventId: 'consent-test-1',
      tripId: 'trip-jordan',
      type: 'TRIP_REVIEW',
      scenarioId: 'jordan-consent-disabled',
      signals: [
        { id: 'preparation-1', type: 'TRIP_PREPARATION' },
        { id: 'weather-1', type: 'WEATHER_UPDATE' },
      ],
    });
    expect(result.modelCalls).toBe(0);
    expect(
      result.decisions.every((d) => d.reason === 'OPTIONAL_CONSENT_DISABLED'),
    ).toBe(true);
  });

  it('arrival affected vs unaffected exercise different fixture judgments', async () => {
    const { graph } = await createApp();
    const a = await graph.run(arrivalAffected, {
      sessionId: createSessionId(),
    });
    const b = await graph.run(arrivalUnaffected, {
      sessionId: createSessionId(),
    });
    expect(a.decisions.some((d) => d.outcome === 'act_now')).toBe(true);
    expect(b.decisions.some((d) => d.reason === 'NO_JOURNEY_IMPACT')).toBe(
      true,
    );
  });

  it('required flight alert works without optional model', async () => {
    const { graph, outbox } = await createApp();
    const sessionId = createSessionId();
    const result = await graph.run(flightChange, { sessionId });
    expect(result.modelMode).toBe('none');
    expect(result.outboxWrites).toBe(1);
    expect(outbox.getOutbox(sessionId)[0]?.templateId).toBe(
      'flight_change_confirmed',
    );
  });

  it('missing essential flight evidence fails with no alert', async () => {
    const { graph, fixtures, outbox } = await createApp();
    const scenario = fixtures.getScenario('jordan-flight-change');
    const mutated = structuredClone(scenario);
    mutated.evidence = mutated.evidence.filter(
      (e) => e.source !== 'mock-flight-service',
    );
    fixtures.replaceScenario(mutated);
    const sessionId = createSessionId();
    const result = await graph.run(
      { ...flightChange, eventId: 'missing-flight-1' },
      { sessionId },
    );
    expect(result.runStatus).toBe('failed');
    expect(result.failureReason).toBe('MISSING_ESSENTIAL_FLIGHT_EVIDENCE');
    expect(outbox.getOutbox(sessionId)).toHaveLength(0);
  });

  it('repeated event IDs return prior result', async () => {
    const { graph, outbox } = await createApp();
    const sessionId = createSessionId();
    const first = await graph.run(flightChange, { sessionId });
    expect(first.outboxWrites).toBe(1);
    const second = await graph.run(flightChange, { sessionId });
    expect(second.runStatus).toBe('duplicate');
    expect(second.outboxWrites).toBe(0);
    expect(outbox.getOutbox(sessionId)).toHaveLength(1);
  });

  it('rejects same eventId with different payload', async () => {
    const { graph } = await createApp();
    const sessionId = createSessionId();
    await graph.run(flightChange, { sessionId });
    await expect(
      graph.run(
        { ...flightChange, signals: [{ id: 'other', type: 'FLIGHT_CHANGE_CONFIRMED' }] },
        { sessionId },
      ),
    ).rejects.toThrow(/EVENT_PAYLOAD_MISMATCH/);
  });

  it('concurrent different event IDs keep isolated contexts', async () => {
    const { graph } = await createApp();
    const [trip, flight] = await Promise.all([
      graph.run(
        { ...tripReview, eventId: 'concurrent-trip' },
        { sessionId: createSessionId() },
      ),
      graph.run(
        { ...flightChange, eventId: 'concurrent-flight' },
        { sessionId: createSessionId() },
      ),
    ]);
    expect(trip.decisions.some((d) => d.reason === 'COMBINED_TRIP_PREPARATION')).toBe(
      true,
    );
    expect(flight.decisions.some((d) => d.reason === 'REQUIRED_FLIGHT_ALERT')).toBe(
      true,
    );
  });

  it('seeded plus session outbox count toward contact limit', async () => {
    const { graph, outbox } = await createApp();
    const sessionId = createSessionId();
    // First trip review spends the optional budget
    await graph.run({ ...tripReview, eventId: 'budget-1' }, { sessionId });
    expect(outbox.getSessionOptionalPreviews(sessionId).length).toBe(1);
    // Same session, new event — optional prep should defer/block via contact limit
    const second = await graph.run(
      {
        eventId: 'budget-2',
        tripId: 'trip-jordan',
        type: 'TRIP_REVIEW',
        scenarioId: 'jordan-before-departure',
        signals: [
          { id: 'preparation-2', type: 'TRIP_PREPARATION' },
          { id: 'weather-2', type: 'WEATHER_UPDATE' },
        ],
      },
      { sessionId },
    );
    expect(second.modelCalls).toBe(0);
    expect(
      second.decisions.some(
        (d) => d.reason === 'CONTACT_LIMIT' || d.reason === 'CONTACT_LIMIT_EXPIRED',
      ),
    ).toBe(true);
  });

  it('future-dated history does not count toward contact limit', async () => {
    const { graph, fixtures } = await createApp();
    const scenario = fixtures.getScenario('jordan-before-departure');
    const mutated = structuredClone(scenario);
    mutated.recentMessages = [
      {
        purpose: 'trip_preparation',
        channel: 'push',
        at: '2026-10-07T09:00:00-07:00', // after demo now
      },
    ];
    fixtures.replaceScenario(mutated);
    const result = await graph.run(
      { ...tripReview, eventId: 'future-hist-1' },
      { sessionId: createSessionId() },
    );
    expect(result.outboxWrites).toBe(1);
  });

  it('runs SSE buffer includes early events', async () => {
    const { module, traces } = await createApp();
    const runs = module.get(RunsService);
    const started = await runs.start(
      { ...tripReview, eventId: 'sse-1' },
      createSessionId(),
    );
    // wait briefly for completion
    for (let i = 0; i < 50; i++) {
      const r = runs.get(started.id);
      if (r?.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const events = traces.getEvents(started.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].sequence).toBe(1);
  });

  it('reset blocked while run active', async () => {
    const { outbox } = await createApp();
    outbox.markRunActive('fake-run');
    expect(() => outbox.reset()).toThrow(/RESET_BLOCKED/);
    outbox.markRunInactive('fake-run');
    expect(() => outbox.reset()).not.toThrow();
  });

  it('policy rules expose observed values', async () => {
    const { graph } = await createApp();
    const result = await graph.run(tripReview, {
      sessionId: createSessionId(),
    });
    expect(result.policyRules?.length).toBeGreaterThan(0);
    expect(result.policyRules?.some((r) => r.id === 'optional_consent')).toBe(
      true,
    );
  });

  it('normalizes path-like template ids from model proposals', async () => {
    const { module } = await createApp();
    const validation = module.get(ValidationService);
    const normalized = validation.normalizeDecisionSet({
      decisions: [
        {
          candidateIds: ['route-1'],
          decision: 'act_now',
          reasonCode: 'ARRIVAL_GUIDANCE_USEFUL',
          reasonSummary: 'Affects journey',
          factIds: ['road-closure-v2'],
          messagePurpose: 'arrival_guidance',
          templateId: '/templates/arrival_guidance',
          action: 'view_route',
          recheckAt: '',
          messageDraft: '',
        },
      ],
    });
    expect(normalized.decisions[0].templateId).toBe('arrival_guidance');
    expect(normalized.decisions[0].recheckAt).toBeNull();
    expect(normalized.decisions[0].messageDraft).toBeNull();

    const aliases = validation.normalizeDecisionSet({
      decisions: [
        {
          candidateIds: ['preparation-1'],
          decision: 'act_now',
          reasonCode: 'COMBINED',
          reasonSummary: 'ok',
          factIds: ['flight-status-v1'],
          messagePurpose: 'trip_preparation',
          templateId: 'trip_preparation',
          action: 'view_itinerary' as 'view_trip',
          recheckAt: null,
          messageDraft: 'null',
        },
      ],
    });
    expect(aliases.decisions[0].action).toBe('view_trip');
    expect(aliases.decisions[0].messageDraft).toBeNull();
  });
});
