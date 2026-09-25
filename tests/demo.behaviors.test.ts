import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DecisionGraphService, DECISION_PROVIDER } from '../src/demo/decision.graph';
import { DemoClockService } from '../src/demo/demo-clock.service';
import { FixtureDecisionProvider } from '../src/demo/fixture-decision.provider';
import { FixtureToolsService } from '../src/demo/fixture-tools.service';
import { OpenAiDecisionProvider } from '../src/demo/openai-decision.provider';
import { OutboxService } from '../src/demo/outbox.service';
import { PolicyService } from '../src/demo/policy.service';
import { ValidationService } from '../src/demo/validation.service';
import {
  DecisionProvider,
  ModelProposal,
} from '../src/demo/decision-provider';
import tripReview from '../fixtures/requests/trip-review.json';
import flightChange from '../fixtures/requests/flight-change.json';
import { ScenarioFixture } from '../src/demo/schemas';

async function createApp(provider?: DecisionProvider) {
  const builders = [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        () => ({
          DECISION_PROVIDER: 'fixture',
          OPENAI_TIMEOUT_MS: '15000',
        }),
      ],
    }),
  ];

  const moduleBuilder = Test.createTestingModule({
    imports: builders,
    providers: [
      DemoClockService,
      FixtureToolsService,
      PolicyService,
      ValidationService,
      OutboxService,
      FixtureDecisionProvider,
      OpenAiDecisionProvider,
      DecisionGraphService,
      {
        provide: DECISION_PROVIDER,
        useValue: provider ?? null,
      },
    ],
  });

  const module: TestingModule = await moduleBuilder.compile();
  const graph = module.get(DecisionGraphService);
  const outbox = module.get(OutboxService);
  const fixtures = module.get(FixtureToolsService);
  const policy = module.get(PolicyService);
  const validation = module.get(ValidationService);
  const clock = module.get(DemoClockService);
  outbox.reset();
  fixtures.reset();
  return { module, graph, outbox, fixtures, policy, validation, clock };
}

describe('proactive AI demo behaviors', () => {
  it('trip review: combine prep+weather, wait route, silent hotel search', async () => {
    const { graph, outbox } = await createApp();
    const result = await graph.run(tripReview);

    expect(result.modelMode).toBe('fixture');
    expect(result.modelCalls).toBe(1);
    expect(result.outboxWrites).toBe(1);

    const byReason = Object.fromEntries(
      result.decisions.map((d) => [d.reason, d]),
    );
    expect(byReason.COMBINED_TRIP_PREPARATION?.outcome).toBe('act_now');
    expect(byReason.ARRIVAL_GUIDANCE_NOT_DUE?.outcome).toBe('wait');
    expect(byReason.ARRIVAL_GUIDANCE_NOT_DUE?.recheckAt).toContain('2026-10-06');
    expect(byReason.HOTEL_ALREADY_BOOKED?.outcome).toBe('silent');

    const preview = byReason.COMBINED_TRIP_PREPARATION?.notificationPreview;
    expect(preview?.action).toBe('view_trip');
    expect(preview?.factIds).toEqual(
      expect.arrayContaining(['flight-status-v1', 'weather-v1']),
    );
    expect(preview?.body).toMatch(/Check-in is open/i);
    expect(preview?.body).toMatch(/rain/i);
    expect(outbox.getOutbox()).toHaveLength(1);
  });

  it('optional consent disabled stops a model call', async () => {
    const spyProvider: DecisionProvider = {
      mode: 'fixture',
      propose: async () => {
        throw new Error('should not be called');
      },
    };
    const { graph, fixtures } = await createApp(spyProvider);
    const scenario = fixtures.activateScenario('jordan-before-departure');
    const mutated: ScenarioFixture = structuredClone(scenario);
    mutated.traveler.preferences.optionalTripMessages = false;
    fixtures.replaceScenario(mutated);

    const result = await graph.run(tripReview);
    expect(result.modelCalls).toBe(0);
    expect(result.modelMode).toBe('none');
    expect(
      result.decisions.some(
        (d) =>
          d.reason === 'OPTIONAL_CONSENT_DISABLED' && d.outcome === 'silent',
      ),
    ).toBe(true);
  });

  it('quiet hours stop a model call', async () => {
    const spyProvider: DecisionProvider = {
      mode: 'fixture',
      propose: async () => {
        throw new Error('should not be called');
      },
    };
    const { graph, fixtures, clock } = await createApp(spyProvider);
    const scenario = fixtures.activateScenario('jordan-before-departure');
    const mutated = structuredClone(scenario);
    // 23:00 PT is inside 22:00–08:00 quiet hours
    mutated.now = '2026-10-05T23:00:00-07:00';
    fixtures.replaceScenario(mutated);
    fixtures.activateScenario('jordan-before-departure');
    expect(clock.getConfiguredIso()).toBe('2026-10-05T23:00:00-07:00');

    const result = await graph.run(tripReview);
    expect(result.modelCalls).toBe(0);
    expect(
      result.decisions.some(
        (d) => d.reason === 'QUIET_HOURS' && d.outcome === 'silent',
      ),
    ).toBe(true);
  });

  it('hotel booking suppresses abandoned search', async () => {
    const { graph } = await createApp();
    const result = await graph.run(tripReview);
    const silent = result.decisions.find((d) =>
      d.candidates.includes('search-1'),
    );
    expect(silent?.outcome).toBe('silent');
    expect(silent?.reason).toBe('HOTEL_ALREADY_BOOKED');
    expect(silent?.decidedBy).toBe('application');
  });

  it('route guidance cannot send before allowed window; wait is future', async () => {
    const { graph, clock } = await createApp();
    const result = await graph.run(tripReview);
    const wait = result.decisions.find((d) => d.candidates.includes('route-1'));
    expect(wait?.outcome).toBe('wait');
    expect(wait?.recheckAt).toBeTruthy();
    const when = Date.parse(wait!.recheckAt!);
    expect(when).toBeGreaterThan(clock.now().getTime());
  });

  it('rejects unknown evidence IDs and unsupported actions', async () => {
    const badEvidence: DecisionProvider = {
      mode: 'fixture',
      propose: async (): Promise<ModelProposal> => ({
        decision: 'act_now',
        candidateIds: ['preparation-1'],
        factIds: ['not-a-real-fact'],
        templateId: 'trip_preparation',
        action: 'view_trip',
        recheckAt: null,
        reasonSummary: 'bad facts',
      }),
    };
    const { graph: g1, outbox: o1 } = await createApp(badEvidence);
    const r1 = await g1.run({ ...tripReview, eventId: 'bad-evidence-1' });
    expect(r1.decisions.some((d) => d.reason === 'UNKNOWN_EVIDENCE_ID')).toBe(
      true,
    );
    expect(o1.getOutbox()).toHaveLength(0);

    const badAction: DecisionProvider = {
      mode: 'fixture',
      propose: async (): Promise<ModelProposal> => ({
        decision: 'act_now',
        candidateIds: ['preparation-1'],
        factIds: ['flight-status-v1'],
        templateId: 'trip_preparation',
        action: 'launch_nukes' as unknown as 'view_trip',
        recheckAt: null,
        reasonSummary: 'bad action',
      }),
    };
    const { graph: g2, outbox: o2 } = await createApp(badAction);
    const r2 = await g2.run({ ...tripReview, eventId: 'bad-action-1' });
    expect(r2.decisions.some((d) => d.reason === 'UNSUPPORTED_ACTION')).toBe(
      true,
    );
    expect(o2.getOutbox()).toHaveLength(0);
  });

  it('changing a valid proposal changes the application result', async () => {
    const silentProvider: DecisionProvider = {
      mode: 'fixture',
      propose: async (): Promise<ModelProposal> => ({
        decision: 'silent',
        candidateIds: ['preparation-1', 'weather-1'],
        factIds: null,
        templateId: null,
        action: null,
        recheckAt: null,
        reasonSummary: 'Nothing useful.',
      }),
    };
    const { graph } = await createApp(silentProvider);
    const result = await graph.run({ ...tripReview, eventId: 'silent-prop-1' });
    expect(result.outboxWrites).toBe(0);
    expect(
      result.decisions.some(
        (d) =>
          d.outcome === 'silent' &&
          d.candidates.includes('preparation-1') &&
          d.decidedBy === 'model',
      ),
    ).toBe(true);
  });

  it('missing essential flight evidence fails with no alert', async () => {
    const { graph, fixtures, outbox } = await createApp();
    const scenario = fixtures.activateScenario('jordan-flight-change');
    const mutated = structuredClone(scenario);
    mutated.evidence = mutated.evidence.filter(
      (e) => e.source !== 'mock-flight-service',
    );
    fixtures.replaceScenario(mutated);

    const result = await graph.run({
      ...flightChange,
      eventId: 'missing-flight-1',
    });
    expect(result.runStatus).toBe('failed');
    expect(result.failureReason).toBe('MISSING_ESSENTIAL_FLIGHT_EVIDENCE');
    expect(outbox.getOutbox()).toHaveLength(0);
  });

  it('missing optional weather does not block required flight alert', async () => {
    const { graph, fixtures, outbox } = await createApp();
    // Flight scenario has no weather evidence by default
    fixtures.activateScenario('jordan-flight-change');
    const result = await graph.run(flightChange);
    expect(result.runStatus).toBe('completed');
    expect(result.modelMode).toBe('none');
    expect(result.modelCalls).toBe(0);
    expect(result.outboxWrites).toBe(1);
    expect(outbox.getOutbox()[0]?.templateId).toBe('flight_change_confirmed');
    expect(outbox.getOutbox()[0]?.body).toMatch(/arrives/i);
  });

  it('repeated event IDs return prior result without new outbox writes', async () => {
    const { graph, outbox } = await createApp();
    const first = await graph.run(flightChange);
    expect(first.outboxWrites).toBe(1);
    const second = await graph.run(flightChange);
    expect(second.runStatus).toBe('duplicate');
    expect(second.outboxWrites).toBe(0);
    expect(outbox.getOutbox()).toHaveLength(1);
  });

  it('repeated logical delivery keys do not add outbox entries', async () => {
    const { graph, outbox } = await createApp();
    await graph.run(flightChange);
    // Different eventId, same purpose + source version
    const again = await graph.run({
      ...flightChange,
      eventId: 'flight-change-002',
    });
    expect(again.decisions.some((d) => d.outcome === 'act_now')).toBe(true);
    expect(outbox.getOutbox()).toHaveLength(1);
  });

  it('concurrent duplicate event submissions share one logical result', async () => {
    const { graph, outbox } = await createApp();
    const [a, b] = await Promise.all([
      graph.run({ ...flightChange, eventId: 'concurrent-1' }),
      graph.run({ ...flightChange, eventId: 'concurrent-1' }),
    ]);
    const writes = [a, b].filter((r) => r.outboxWrites === 1).length;
    const duplicates = [a, b].filter((r) => r.runStatus === 'duplicate').length;
    expect(writes).toBe(1);
    expect(duplicates).toBe(1);
    expect(outbox.getOutbox()).toHaveLength(1);
  });

  it('model timeout/refusal becomes failure, not successful silence', async () => {
    const failing: DecisionProvider = {
      mode: 'live',
      propose: async () => {
        throw new Error('MODEL_REFUSAL: cannot help');
      },
    };
    const { graph, outbox } = await createApp(failing);
    const result = await graph.run({ ...tripReview, eventId: 'refusal-1' });
    expect(result.modelMode).toBe('live');
    expect(
      result.decisions.some(
        (d) => d.outcome === 'failure' && /MODEL_REFUSAL/.test(d.reason),
      ),
    ).toBe(true);
    expect(result.runStatus === 'failed' || result.runStatus === 'partial_failure').toBe(
      true,
    );
    // Hotel silent and route wait from application should still be present
    expect(result.decisions.some((d) => d.reason === 'HOTEL_ALREADY_BOOKED')).toBe(
      true,
    );
    expect(outbox.getOutbox()).toHaveLength(0);
  });

  it('live and fixture modes are clearly labelled', async () => {
    const { graph: fixtureGraph } = await createApp();
    const fixtureResult = await fixtureGraph.run({
      ...tripReview,
      eventId: 'label-fixture',
    });
    expect(fixtureResult.modelMode).toBe('fixture');

    const liveLike: DecisionProvider = {
      mode: 'live',
      propose: async () =>
        new FixtureDecisionProvider().propose({
          scenarioId: 'jordan-before-departure',
          tripId: 'trip-jordan',
          eligibleCandidateIds: ['preparation-1', 'weather-1'],
          evidenceIds: ['flight-status-v1', 'weather-v1'],
          skillVersion: '1.0.0',
          skillText: '',
          summary: '',
        }),
    };
    const { graph: liveGraph } = await createApp(liveLike);
    const liveResult = await liveGraph.run({
      ...tripReview,
      eventId: 'label-live',
    });
    expect(liveResult.modelMode).toBe('live');
  });

  it('invalid wait recheckAt is rejected', async () => {
    const badWait: DecisionProvider = {
      mode: 'fixture',
      propose: async (): Promise<ModelProposal> => ({
        decision: 'wait',
        candidateIds: ['preparation-1'],
        factIds: null,
        templateId: null,
        action: null,
        recheckAt: '2020-01-01T00:00:00Z',
        reasonSummary: 'past wait',
      }),
    };
    const { graph } = await createApp(badWait);
    // Make preparation eligible only (override trip review signals)
    const result = await graph.run({
      eventId: 'bad-wait-1',
      tripId: 'trip-jordan',
      type: 'TRIP_REVIEW',
      scenarioId: 'jordan-before-departure',
      signals: [{ id: 'preparation-1', type: 'TRIP_PREPARATION' }],
    });
    expect(result.decisions.some((d) => d.reason === 'WAIT_NOT_IN_FUTURE')).toBe(
      true,
    );
  });
});
