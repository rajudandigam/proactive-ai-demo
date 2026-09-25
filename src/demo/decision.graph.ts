import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { createHash } from 'node:crypto';
import { DemoClockService } from './demo-clock.service';
import { FixtureToolsService } from './fixture-tools.service';
import { OutboxService } from './outbox.service';
import { PolicyEnvelope, PolicyService } from './policy.service';
import { ReadToolsService } from './read-tools.service';
import { TripAttentionAgentService } from './trip-attention.agent';
import { DemoTraceService } from './trace-events.service';
import { ValidationService } from './validation.service';
import {
  ApplicationResult,
  DecisionOutcome,
  DemoRunContext,
  IntakeRequest,
  IntakeRequestSchema,
  ModelAccounting,
  ModelDecisionSet,
} from './schemas';

const GraphState = Annotation.Root({
  ctx: Annotation<DemoRunContext>,
  envelope: Annotation<PolicyEnvelope | null>,
  appOutcomes: Annotation<DecisionOutcome[]>,
  requiredOutcomes: Annotation<DecisionOutcome[]>,
  agentDecisionSet: Annotation<ModelDecisionSet | null>,
  agentOutcomes: Annotation<DecisionOutcome[]>,
  toolSummaries: Annotation<unknown[]>,
  accounting: Annotation<ModelAccounting>,
  nodeStatuses: Annotation<Record<string, string>>,
  nodeTimings: Annotation<Record<string, number>>,
  runStatus: Annotation<ApplicationResult['runStatus']>,
  failureReason: Annotation<string | undefined>,
  outboxWrites: Annotation<number>,
});

type GraphStateType = typeof GraphState.State;

@Injectable()
export class DecisionGraphService {
  private compiled;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(DemoClockService) private readonly clock: DemoClockService,
    @Inject(FixtureToolsService) private readonly fixtures: FixtureToolsService,
    @Inject(PolicyService) private readonly policyService: PolicyService,
    @Inject(ValidationService) private readonly validation: ValidationService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TripAttentionAgentService)
    private readonly agent: TripAttentionAgentService,
    @Inject(ReadToolsService) private readonly tools: ReadToolsService,
    @Inject(DemoTraceService) private readonly traces: DemoTraceService,
  ) {
    this.compiled = this.buildGraph();
  }

  getProviderMode(): 'live' | 'fixture' {
    return this.agent.getMode();
  }

  async run(
    rawRequest: unknown,
    opts?: { sessionId?: string; runId?: string },
  ): Promise<ApplicationResult> {
    const request = IntakeRequestSchema.parse(rawRequest);
    if (opts?.sessionId) {
      request.sessionId = opts.sessionId;
    }
    const scenario = this.fixtures.getScenario(request.scenarioId);
    const ctx = this.clock.createContext(scenario, request, {
      sessionId: opts?.sessionId ?? request.sessionId,
      runId: opts?.runId,
    });
    this.fixtures.assertOwnership(ctx, request.tripId);
    this.traces.begin(ctx.runId);
    this.outbox.markRunActive(ctx.runId);
    this.tools.clearCache(ctx.runId);

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');

    try {
      return await this.outbox.withEventLock(request.eventId, async () => {
        const existing = this.outbox.getEventResult(
          ctx.sessionId,
          request.eventId,
        );
        if (existing) {
          const priorHash = this.outbox.getPayloadHash(
            ctx.sessionId,
            request.eventId,
          );
          if (priorHash && priorHash !== payloadHash) {
            throw new Error(
              'EVENT_PAYLOAD_MISMATCH: same eventId with different payload in this session',
            );
          }
          this.traces.emit(ctx, {
            stage: 'dedupe',
            status: 'ok',
            summary: 'Repeated eventId — returning prior result',
          });
          return {
            ...existing,
            runStatus: 'duplicate',
            duplicateOf: request.eventId,
            outboxWrites: 0,
            runId: ctx.runId,
            sessionId: ctx.sessionId,
          };
        }

        const initial: GraphStateType = {
          ctx,
          envelope: null,
          appOutcomes: [],
          requiredOutcomes: [],
          agentDecisionSet: null,
          agentOutcomes: [],
          toolSummaries: [],
          accounting: {
            providerMode: this.agent.getMode(),
            liveAttempts: 0,
            liveSuccesses: 0,
            liveFailures: 0,
            fixtureInvocations: 0,
            toolExecutions: 0,
            toolCacheHits: 0,
            requestedModelId: null,
            returnedModelIds: [],
            tokenUsage: { known: false },
          },
          nodeStatuses: {},
          nodeTimings: {},
          runStatus: 'completed',
          failureReason: undefined,
          outboxWrites: 0,
        };

        const finalState = await this.compiled.invoke(initial);
        const decisions = [
          ...finalState.requiredOutcomes,
          ...finalState.appOutcomes,
          ...finalState.agentOutcomes,
        ];
        const modelCalls =
          finalState.accounting.liveAttempts +
          finalState.accounting.fixtureInvocations;

        const result: ApplicationResult = {
          runStatus: finalState.runStatus,
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          eventId: request.eventId,
          modelMode:
            finalState.accounting.providerMode === 'fixture'
              ? finalState.accounting.fixtureInvocations > 0
                ? 'fixture'
                : 'none'
              : finalState.accounting.liveAttempts > 0
                ? 'live'
                : 'none',
          modelCalls,
          accounting: finalState.accounting,
          decisions,
          outboxWrites: finalState.outboxWrites,
          modelDecisionSet: finalState.agentDecisionSet ?? undefined,
          policyRules: finalState.envelope?.rules,
          failureReason: finalState.failureReason,
          trace: {
            nodeStatuses: finalState.nodeStatuses,
            nodeTimings: finalState.nodeTimings,
            toolSummaries: finalState.toolSummaries,
            events: this.traces.getEvents(ctx.runId),
          },
        };

        this.outbox.rememberEventResult(
          ctx.sessionId,
          request.eventId,
          result,
          payloadHash,
        );
        this.traces.emit(ctx, {
          stage: 'complete',
          status: result.runStatus,
          summary: `Run ${result.runStatus}; outboxWrites=${result.outboxWrites}`,
        });
        return result;
      });
    } finally {
      this.outbox.markRunInactive(ctx.runId);
      this.traces.finish(ctx.runId);
    }
  }

  private buildGraph() {
    return new StateGraph(GraphState)
      .addNode('bind_context', async (s) => this.bindContext(s))
      .addNode('policy_envelope', async (s) => this.policyNode(s))
      .addNode('resolve_deterministic', async (s) => this.deterministicNode(s))
      .addNode('required_alerts', async (s) => this.requiredNode(s))
      .addNode('investigate_agent', async (s) => this.agentNode(s))
      .addNode('validate_result', async (s) => this.validateNode(s))
      .addNode('record_result', async (s) => this.recordNode(s))
      .addEdge(START, 'bind_context')
      .addEdge('bind_context', 'policy_envelope')
      .addEdge('policy_envelope', 'resolve_deterministic')
      .addEdge('resolve_deterministic', 'required_alerts')
      .addEdge('required_alerts', 'investigate_agent')
      .addEdge('investigate_agent', 'validate_result')
      .addEdge('validate_result', 'record_result')
      .addEdge('record_result', END)
      .compile();
  }

  private timed(
    state: GraphStateType,
    name: string,
    status: string,
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
      nodeStatuses: {
        ...state.nodeStatuses,
        ...(update.nodeStatuses ?? {}),
        [name]: status,
      },
    };
  }

  private async bindContext(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    this.traces.emit(state.ctx, {
      stage: 'bind_context',
      status: 'ok',
      summary: `Bound scenario ${state.ctx.scenarioId}`,
      detail: {
        sessionId: state.ctx.sessionId,
        demoTime: state.ctx.nowIso,
      },
    });
    return this.timed(state, 'bind_context', 'ok', () => ({}));
  }

  private async policyNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const envelope = this.policyService.evaluate(state.ctx);
    this.traces.emit(state.ctx, {
      stage: 'policy_envelope',
      status: 'ok',
      summary: `Policy v2: ${envelope.optionalEligible.length} optional, ${envelope.requiredEligible.length} required`,
      detail: { rules: envelope.rules.map((r) => ({ id: r.id, result: r.result })) },
    });
    return this.timed(state, 'policy_envelope', 'ok', () => ({ envelope }));
  }

  private async deterministicNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const outcomes: DecisionOutcome[] = (
      state.envelope?.deterministicOutcomes ?? []
    ).map((d) => ({
      candidates: [d.candidateId],
      outcome: d.outcome,
      reason: d.reason,
      recheckAt: d.recheckAt,
      decidedBy: 'application' as const,
      proposedBy: 'application' as const,
      validatedBy: 'application' as const,
      finalizedBy: 'application' as const,
      policyRuleIds: d.policyRuleIds,
    }));
    this.traces.emit(state.ctx, {
      stage: 'resolve_deterministic',
      status: 'ok',
      summary: `${outcomes.length} application-resolved candidates`,
    });
    return this.timed(state, 'resolve_deterministic', 'ok', () => ({
      appOutcomes: outcomes,
    }));
  }

  private async requiredNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const required = state.envelope?.requiredEligible ?? [];
    const outcomes: DecisionOutcome[] = [];
    let outboxWrites = 0;
    let runStatus = state.runStatus;
    let failureReason = state.failureReason;

    for (const candidate of required) {
      const flight = this.fixtures.matchFlightSource(
        state.ctx,
        candidate.claimedSourceVersion,
      ) as
        | { id: string; confirmedChange?: boolean; arrivalAt?: string }
        | undefined;

      if (!flight?.id || !flight.confirmedChange || !flight.arrivalAt) {
        outcomes.push({
          candidates: [candidate.id],
          outcome: 'failure',
          reason: 'MISSING_ESSENTIAL_FLIGHT_EVIDENCE',
          decidedBy: 'application',
          proposedBy: 'template',
          validatedBy: 'application',
          finalizedBy: 'application',
        });
        runStatus = 'failed';
        failureReason = 'MISSING_ESSENTIAL_FLIGHT_EVIDENCE';
        continue;
      }

      const decisionSet: ModelDecisionSet = {
        decisions: [
          {
            candidateIds: [candidate.id],
            decision: 'act_now',
            reasonCode: 'REQUIRED_FLIGHT_ALERT',
            reasonSummary: 'Verified confirmed flight change.',
            factIds: [flight.id],
            messagePurpose: 'flight_change',
            templateId: 'flight_change_confirmed',
            action: 'view_flight',
            recheckAt: null,
            messageDraft: null,
          },
        ],
      };

      const validated = this.validation.validateDecisionSet({
        ctx: state.ctx,
        envelope: state.envelope!,
        decisionSet,
        modelCandidateIds: [candidate.id],
        proposedBy: 'template',
        required: true,
      });
      outcomes.push(...validated.outcomes);
      if (!validated.ok) {
        runStatus = 'failed';
        failureReason = validated.failureReason;
        continue;
      }

      for (const o of validated.outcomes) {
        if (o.outcome === 'act_now') {
          const write = await this.outbox.withSessionWriteLock(
            state.ctx.sessionId,
            async () =>
              this.outbox.tryWrite(
                o,
                state.ctx.eventId,
                state.ctx.sessionId,
                'flight_change',
                state.ctx.nowIso,
              ),
          );
          if (write.written) outboxWrites += 1;
        }
      }
    }

    this.traces.emit(state.ctx, {
      stage: 'required_alerts',
      status: failureReason ? 'failed' : 'ok',
      summary: `${outcomes.length} required outcomes`,
    });

    return this.timed(
      state,
      'required_alerts',
      failureReason ? 'failed' : 'ok',
      () => ({
        requiredOutcomes: outcomes,
        outboxWrites: state.outboxWrites + outboxWrites,
        runStatus,
        failureReason,
      }),
    );
  }

  private async agentNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const eligible = state.envelope?.optionalEligible ?? [];
    if (!eligible.length) {
      this.traces.emit(state.ctx, {
        stage: 'investigate_agent',
        status: 'skipped',
        summary: 'No optional eligible candidates (or policy deferred them)',
      });
      return this.timed(state, 'investigate_agent', 'skipped', () => ({}));
    }

    // Mandatory application read tagged separately
    const mandatory = this.tools.execute(
      state.ctx,
      'read_trip_snapshot',
      {},
      'app-mandatory-1',
      'application',
    );

    const result = await this.agent.run(state.ctx, state.envelope!, eligible);
    const accounting = { ...result.accounting };
    if (!mandatory.cached) {
      // application read not counted as model tool execution
    }

    this.traces.emit(state.ctx, {
      stage: 'investigate_agent',
      status: result.failureReason ? 'failed' : 'ok',
      summary: result.failureReason
        ? result.failureReason
        : `Agent finished; tools=${result.toolResults.length}`,
      detail: {
        accounting,
        toolNames: result.toolResults.map((t) => t.name),
      },
    });

    if (result.failureReason) {
      const failOutcomes: DecisionOutcome[] = eligible.map((c) => ({
        candidates: [c.id],
        outcome: 'failure',
        reason: result.failureReason!,
        decidedBy: 'model',
        proposedBy: 'model',
        validatedBy: 'application',
        finalizedBy: 'application',
      }));
      const runStatus =
        state.requiredOutcomes.length || state.appOutcomes.length
          ? 'partial_failure'
          : 'failed';
      return this.timed(state, 'investigate_agent', 'failed', () => ({
        accounting,
        agentOutcomes: failOutcomes,
        toolSummaries: result.toolResults,
        runStatus,
        failureReason: result.failureReason,
      }));
    }

    return this.timed(state, 'investigate_agent', 'ok', () => ({
      accounting,
      agentDecisionSet: result.decisionSet ?? null,
      toolSummaries: result.toolResults,
    }));
  }

  private async validateNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    if (!state.agentDecisionSet) {
      return this.timed(state, 'validate_result', 'skipped', () => ({}));
    }

    const eligibleIds = (state.envelope?.optionalEligible ?? []).map(
      (c) => c.id,
    );
    const validated = this.validation.validateDecisionSet({
      ctx: state.ctx,
      envelope: state.envelope!,
      decisionSet: state.agentDecisionSet,
      modelCandidateIds: eligibleIds,
      proposedBy: 'model',
      required: false,
    });

    let outboxWrites = 0;
    let runStatus = state.runStatus;
    let failureReason = state.failureReason;

    if (!validated.ok) {
      runStatus =
        state.requiredOutcomes.length || state.appOutcomes.length
          ? 'partial_failure'
          : 'failed';
      failureReason = validated.failureReason;
    } else {
      // Atomic delivery recheck + write for optional acts
      for (const outcome of validated.outcomes) {
        if (outcome.outcome !== 'act_now') continue;
        const write = await this.outbox.withSessionWriteLock(
          state.ctx.sessionId,
          async () => {
            if (this.policyService.optionalContactLimitExceeded(state.ctx)) {
              return { written: false, duplicate: false, blocked: true as const };
            }
            return {
              ...this.outbox.tryWrite(
                outcome,
                state.ctx.eventId,
                state.ctx.sessionId,
                outcome.notificationPreview?.templateId === 'arrival_guidance'
                  ? 'arrival_guidance'
                  : 'trip_preparation',
                state.ctx.nowIso,
              ),
              blocked: false as const,
            };
          },
        );
        if ('blocked' in write && write.blocked) {
          // convert to wait/silent handled by mutating — record failure to write
          failureReason = 'CONTACT_LIMIT_DELIVERY';
          runStatus = 'partial_failure';
        } else if (write.written) {
          outboxWrites += 1;
        }
      }
    }

    this.traces.emit(state.ctx, {
      stage: 'validate_result',
      status: validated.ok ? 'ok' : 'failed',
      summary: validated.ok
        ? `Validated ${validated.outcomes.length} groups`
        : validated.failureReason ?? 'validation failed',
    });

    return this.timed(
      state,
      'validate_result',
      validated.ok ? 'ok' : 'failed',
      () => ({
        agentOutcomes: validated.outcomes,
        outboxWrites: state.outboxWrites + outboxWrites,
        runStatus,
        failureReason,
      }),
    );
  }

  private async recordNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    this.traces.emit(state.ctx, {
      stage: 'record_result',
      status: state.runStatus,
      summary: 'Recorded application outcomes',
    });
    return this.timed(state, 'record_result', state.runStatus, () => ({}));
  }
}
