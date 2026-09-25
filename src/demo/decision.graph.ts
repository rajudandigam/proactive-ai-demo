import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { DemoClockService } from './demo-clock.service';
import {
  DecisionProvider,
  ModelProposal,
} from './decision-provider';
import { FixtureDecisionProvider } from './fixture-decision.provider';
import { OpenAiDecisionProvider } from './openai-decision.provider';
import { FixtureToolsService } from './fixture-tools.service';
import { OutboxService } from './outbox.service';
import { PolicyEvaluation, PolicyService } from './policy.service';
import {
  ApplicationResult,
  DecisionOutcome,
  IntakeRequest,
  IntakeRequestSchema,
} from './schemas';
import { DemoTrace, loadSkillText, serializeTrace } from './trace';
import { ValidationService } from './validation.service';

export const DECISION_PROVIDER = 'DECISION_PROVIDER_TOKEN';

const GraphState = Annotation.Root({
  request: Annotation<IntakeRequest>,
  policyEval: Annotation<PolicyEvaluation | null>,
  evidenceIds: Annotation<string[]>,
  evidenceStatus: Annotation<string>,
  modelProposals: Annotation<ModelProposal[]>,
  decisions: Annotation<DecisionOutcome[]>,
  modelCalls: Annotation<number>,
  modelMode: Annotation<'live' | 'fixture' | 'none'>,
  runStatus: Annotation<ApplicationResult['runStatus']>,
  failureReason: Annotation<string | undefined>,
  outboxWrites: Annotation<number>,
  nodeTimings: Annotation<Record<string, number>>,
  skipModel: Annotation<boolean>,
  requiredPath: Annotation<boolean>,
});

type GraphStateType = typeof GraphState.State;

@Injectable()
export class DecisionGraphService {
  private compiled;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    private readonly clock: DemoClockService,
    private readonly fixtures: FixtureToolsService,
    private readonly policyService: PolicyService,
    private readonly validation: ValidationService,
    private readonly outbox: OutboxService,
    private readonly fixtureProvider: FixtureDecisionProvider,
    private readonly openAiProvider: OpenAiDecisionProvider,
    @Optional()
    @Inject(DECISION_PROVIDER)
    private readonly overrideProvider: DecisionProvider | null = null,
  ) {
    this.compiled = this.buildGraph();
  }

  getProvider(): DecisionProvider {
    if (this.overrideProvider) {
      return this.overrideProvider;
    }
    const mode = (this.config.get<string>('DECISION_PROVIDER') ?? 'fixture').toLowerCase();
    return mode === 'live' ? this.openAiProvider : this.fixtureProvider;
  }

  async run(rawRequest: unknown): Promise<ApplicationResult> {
    const request = IntakeRequestSchema.parse(rawRequest);
    const started = Date.now();
    const startedAt = new Date().toISOString();

    return this.outbox.withEventLock(request.eventId, async () => {
      const existing = this.outbox.getEventResult(request.eventId);
      if (existing) {
        return {
          ...existing,
          runStatus: 'duplicate',
          duplicateOf: request.eventId,
          outboxWrites: 0,
          trace: {
            ...(existing.trace ?? {}),
            duplicate: true,
            note: 'Repeated eventId returned prior application result; no new logical notification.',
          },
        };
      }

      this.fixtures.activateScenario(request.scenarioId);
      this.fixtures.assertOwnership(
        this.fixtures.getActiveScenario().actor.id,
        request.tripId,
      );

      const initial: GraphStateType = {
        request,
        policyEval: null,
        evidenceIds: [],
        evidenceStatus: 'pending',
        modelProposals: [],
        decisions: [],
        modelCalls: 0,
        modelMode: 'none',
        runStatus: 'completed',
        failureReason: undefined,
        outboxWrites: 0,
        nodeTimings: {},
        skipModel: false,
        requiredPath: request.type === 'FLIGHT_CHANGE_CONFIRMED',
      };

      const finalState = await this.compiled.invoke(initial);
      const finishedAt = new Date().toISOString();
      const elapsedMs = Date.now() - started;

      const trace: DemoTrace = {
        modelMode: finalState.modelMode,
        modelCalls: finalState.modelCalls,
        startedAt,
        finishedAt,
        elapsedMs,
        policy: {
          result: finalState.policyEval
            ? {
                blockModelCall: finalState.policyEval.blockModelCall,
                blockReason: finalState.policyEval.blockReason,
                quietHoursActive: finalState.policyEval.quietHoursActive,
                optionalConsent: finalState.policyEval.optionalConsent,
                signalCount: finalState.policyEval.signals.length,
              }
            : null,
        },
        evidence: {
          status: finalState.evidenceStatus,
          ids: finalState.evidenceIds,
        },
        validation: {
          decisions: finalState.decisions.map((d) => ({
            outcome: d.outcome,
            reason: d.reason,
          })),
        },
        nodes: Object.entries(finalState.nodeTimings).map(([name, durationMs]) => ({
          name,
          status: 'ok',
          durationMs,
        })),
        versions: {
          skill: loadSkillText().version,
          policy: 'demo-v1',
        },
      };

      const result: ApplicationResult = {
        runStatus: finalState.runStatus,
        eventId: request.eventId,
        modelMode: finalState.modelMode,
        modelCalls: finalState.modelCalls,
        decisions: finalState.decisions,
        outboxWrites: finalState.outboxWrites,
        modelProposals: finalState.modelProposals,
        failureReason: finalState.failureReason,
        trace: serializeTrace(trace),
      };

      this.outbox.rememberEventResult(request.eventId, result);
      return result;
    });
  }

  private buildGraph() {
    const graph = new StateGraph(GraphState)
      .addNode('policy_check', async (state) => this.policyNode(state))
      .addNode('gather_evidence', async (state) => this.evidenceNode(state))
      .addNode('judge', async (state) => this.judgeNode(state))
      .addNode('validate_result', async (state) => this.validateNode(state))
      .addNode('record_result', async (state) => this.recordNode(state))
      .addEdge(START, 'policy_check')
      .addConditionalEdges('policy_check', (state) => {
        if (state.runStatus === 'failed') return 'record_result';
        return 'gather_evidence';
      })
      .addConditionalEdges('gather_evidence', (state) => {
        if (state.runStatus === 'failed') return 'record_result';
        return 'judge';
      })
      .addEdge('judge', 'validate_result')
      .addEdge('validate_result', 'record_result')
      .addEdge('record_result', END);

    return graph.compile();
  }

  private timed(
    state: GraphStateType,
    name: string,
    fn: () => Partial<GraphStateType>,
  ): Partial<GraphStateType> {
    const t0 = Date.now();
    const update = fn();
    return {
      ...update,
      nodeTimings: {
        ...state.nodeTimings,
        ...(update.nodeTimings ?? {}),
        [name]: Date.now() - t0,
      },
    };
  }

  private async policyNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    return this.timed(state, 'policy_check', () => {
      const policyEval = this.policyService.evaluate(state.request);
      return { policyEval };
    });
  }

  private async evidenceNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    return this.timed(state, 'gather_evidence', () => {
      const evidence = this.fixtures.readEvidence();
      const evidenceIds = evidence.map((e) => e.id);

      if (state.requiredPath) {
        const flight = this.fixtures.getFlightEvidence() as
          | { id?: string; confirmedChange?: boolean; arrivalAt?: string }
          | undefined;
        if (!flight?.id || !flight.confirmedChange || !flight.arrivalAt) {
          return {
            evidenceIds,
            evidenceStatus: 'missing_essential',
            runStatus: 'failed',
            failureReason: 'MISSING_ESSENTIAL_FLIGHT_EVIDENCE',
            decisions: [
              {
                candidates: state.request.signals.map((s) => s.id),
                outcome: 'failure',
                reason: 'MISSING_ESSENTIAL_FLIGHT_EVIDENCE',
                decidedBy: 'application',
              },
            ],
          };
        }
        // Read updated source rather than trusting event claim
        return {
          evidenceIds,
          evidenceStatus: 'ok',
          requiredPath: true,
        };
      }

      return {
        evidenceIds,
        evidenceStatus: evidenceIds.length ? 'ok' : 'empty',
      };
    });
  }

  private async judgeNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const t0 = Date.now();
    const policy = state.policyEval!;
    const decisions: DecisionOutcome[] = [...state.decisions];
    const modelProposals: ModelProposal[] = [];
    let modelCalls = 0;
    let modelMode: ApplicationResult['modelMode'] = 'none';
    let runStatus = state.runStatus;
    let failureReason = state.failureReason;

    // Deterministic application outcomes first
    for (const signal of policy.signals) {
      if (signal.category === 'deterministic_silent') {
        decisions.push({
          candidates: [signal.signalId],
          outcome: 'silent',
          reason: signal.reason,
          decidedBy: 'application',
        });
      } else if (signal.category === 'deterministic_wait') {
        decisions.push({
          candidates: [signal.signalId],
          outcome: 'wait',
          reason: signal.reason,
          recheckAt: signal.recheckAt,
          decidedBy: 'application',
        });
      }
    }

    if (state.requiredPath) {
      const flight = this.fixtures.getFlightEvidence()!;
      const signalIds = state.request.signals.map((s) => s.id);
      const proposal: ModelProposal = {
        decision: 'act_now',
        candidateIds: signalIds,
        factIds: [flight.id],
        templateId: 'flight_change_confirmed',
        action: 'view_flight',
        recheckAt: null,
        reasonSummary: 'Required confirmed flight change uses approved template.',
      };
      modelProposals.push(proposal);
      // Update arrival-guidance recheck note for presentation (16:10 ET)
      const arrival = (flight as unknown as { arrivalAt: string }).arrivalAt;
      const recheck = this.policyService.arrivalGuidanceWindowStart(arrival);
      void recheck; // available for later wait simulation fixtures
    } else {
      const optionalEligible = policy.signals.filter(
        (s) => s.eligible && s.category === 'optional',
      );

      if (optionalEligible.length > 0) {
        if (policy.blockModelCall) {
          for (const s of optionalEligible) {
            decisions.push({
              candidates: [s.signalId],
              outcome: 'silent',
              reason: policy.blockReason ?? 'POLICY_BLOCKED',
              decidedBy: 'application',
            });
          }
        } else {
          const provider = this.getProvider();
          modelMode = provider.mode;
          const skill = loadSkillText();
          try {
            const proposal = await provider.propose({
              scenarioId: state.request.scenarioId,
              tripId: state.request.tripId,
              eligibleCandidateIds: optionalEligible.map((s) => s.signalId),
              evidenceIds: state.evidenceIds,
              skillVersion: skill.version,
              skillText: skill.text,
              summary: JSON.stringify({
                trip: this.fixtures.readTrip(state.request.tripId),
                evidence: this.fixtures.readEvidence(),
                recentActivity: this.fixtures.readRecentActivity(),
              }),
            });
            modelCalls = 1;
            modelProposals.push(proposal);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            runStatus = decisions.length ? 'partial_failure' : 'failed';
            failureReason = message.startsWith('MODEL_')
              ? message
              : `MODEL_ERROR: ${message}`;
            decisions.push({
              candidates: optionalEligible.map((s) => s.signalId),
              outcome: 'failure',
              reason: failureReason,
              decidedBy: 'model',
            });
          }
        }
      }
    }

    return {
      decisions,
      modelProposals,
      modelCalls,
      modelMode: state.requiredPath ? 'none' : modelMode,
      runStatus,
      failureReason,
      nodeTimings: { ...state.nodeTimings, judge: Date.now() - t0 },
    };
  }

  private async validateNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    return this.timed(state, 'validate_result', () => {
      const decisions = [...state.decisions];
      let runStatus = state.runStatus;
      let failureReason = state.failureReason;
      let outboxWrites = 0;

      if (state.requiredPath && state.modelProposals[0]) {
        const proposal = state.modelProposals[0];
        const result = this.validation.validate({
          proposal,
          allowedCandidateIds: state.request.signals.map((s) => s.id),
          decidedBy: 'template',
          purpose: 'flight_change',
          required: true,
        });
        if (!result.ok) {
          runStatus = 'failed';
          failureReason = result.reason;
        }
        decisions.push(result.outcome);
        if (result.ok && result.outcome.outcome === 'act_now') {
          const write = this.outbox.tryWrite(
            result.outcome,
            state.request.eventId,
            this.clock.now().toISOString(),
          );
          if (write.written) outboxWrites += 1;
          if (write.duplicate) {
            // delivery key already present — still act_now but no new write
          }
        }
        return { decisions, runStatus, failureReason, outboxWrites };
      }

      for (const proposal of state.modelProposals) {
        const result = this.validation.validate({
          proposal,
          allowedCandidateIds: state.request.signals
            .filter((s) => {
              const pol = state.policyEval?.signals.find(
                (ps) => ps.signalId === s.id,
              );
              return pol?.eligible && pol.category === 'optional';
            })
            .map((s) => s.id),
          decidedBy: 'model',
          purpose: 'trip_preparation',
          required: false,
        });
        if (!result.ok) {
          runStatus =
            decisions.some((d) => d.outcome !== 'failure')
              ? 'partial_failure'
              : 'failed';
          failureReason = result.reason;
        }
        decisions.push(result.outcome);
        if (result.ok && result.outcome.outcome === 'act_now') {
          const write = this.outbox.tryWrite(
            result.outcome,
            state.request.eventId,
            this.clock.now().toISOString(),
          );
          if (write.written) outboxWrites += 1;
        }
      }

      return { decisions, runStatus, failureReason, outboxWrites };
    });
  }

  private async recordNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    return this.timed(state, 'record_result', () => {
      // Outcomes already accumulated; ensure failure never looks like successful silence
      if (
        state.failureReason &&
        state.runStatus === 'completed' &&
        state.decisions.some((d) => d.outcome === 'failure')
      ) {
        return {
          runStatus: state.decisions.every((d) => d.outcome === 'failure')
            ? 'failed'
            : 'partial_failure',
        };
      }
      return {};
    });
  }
}
