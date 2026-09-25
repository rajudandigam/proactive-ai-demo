import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { maybeInspectRun, step } from 'agent-inspect';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DemoRunContext,
  ModelDecisionSet,
  ModelDecisionSetSchema,
  ModelAccounting,
  POLICY,
  TEMPLATE_REGISTRY,
  TypedCandidate,
} from './schemas';
import { PolicyEnvelope } from './policy.service';
import { ReadToolsService, ToolResult } from './read-tools.service';
import { DemoTraceService } from './trace-events.service';

export type AgentLoopResult = {
  decisionSet?: ModelDecisionSet;
  toolResults: ToolResult[];
  accounting: ModelAccounting;
  failureReason?: string;
  transcript: OpenAI.Chat.ChatCompletionMessageParam[];
};

function loadSkillText(): { version: string; text: string } {
  const candidates = [
    join(process.cwd(), 'skills', 'trip-preparation.md'),
    join(__dirname, '..', '..', 'skills', 'trip-preparation.md'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      const versionMatch = text.match(/Version:\s*([0-9.]+)/);
      return { version: versionMatch?.[1] ?? '2.0.0', text };
    }
  }
  return {
    version: '2.0.0',
    text: 'Request relevant facts with tools, then decide for every eligible candidate.',
  };
}

@Injectable()
export class TripAttentionAgentService {
  private client: OpenAI | null = null;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ReadToolsService) private readonly tools: ReadToolsService,
    @Inject(DemoTraceService) private readonly traces: DemoTraceService,
  ) {}

  getMode(): 'live' | 'fixture' {
    const mode = (this.config.get<string>('DECISION_PROVIDER') ?? 'fixture').toLowerCase();
    return mode === 'live' ? 'live' : 'fixture';
  }

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = this.config.get<string>('OPENAI_API_KEY');
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is required for live decision provider');
      }
      this.client = new OpenAI({
        apiKey,
        timeout: Number(
          this.config.get('OPENAI_TIMEOUT_MS') ?? POLICY.perCallTimeoutMs,
        ),
        maxRetries: 0,
      });
    }
    return this.client;
  }

  async run(
    ctx: DemoRunContext,
    envelope: PolicyEnvelope,
    eligible: TypedCandidate[],
  ): Promise<AgentLoopResult> {
    const mode = this.getMode();
    if (mode === 'fixture') {
      return this.runFixture(ctx, envelope, eligible);
    }
    const inspectOn = /^(1|true|yes|on|enabled)$/i.test(
      this.config.get<string>('AGENT_INSPECT') ?? '',
    );
    if (inspectOn) {
      return maybeInspectRun(
        'proactive-trip-attention',
        () => this.runLive(ctx, envelope, eligible),
        {
          silent: true,
          traceDir: '.agent-inspect',
          correlationId: ctx.runId,
          requestId: ctx.eventId,
          metadata: { scenarioId: ctx.scenarioId, sessionId: ctx.sessionId },
        },
      );
    }
    return this.runLive(ctx, envelope, eligible);
  }

  private async runFixture(
    ctx: DemoRunContext,
    envelope: PolicyEnvelope,
    eligible: TypedCandidate[],
  ): Promise<AgentLoopResult> {
    const accounting: ModelAccounting = {
      providerMode: 'fixture',
      liveAttempts: 0,
      liveSuccesses: 0,
      liveFailures: 0,
      fixtureInvocations: 1,
      toolExecutions: 0,
      toolCacheHits: 0,
      requestedModelId: 'fixture-agent',
      returnedModelIds: ['fixture-agent'],
      tokenUsage: { known: false },
    };
    const toolResults: ToolResult[] = [];
    const ids = new Set(eligible.map((c) => c.id));

    // Scripted two-round lookup for presentation fidelity
    const t1 = this.tools.execute(
      ctx,
      'read_trip_snapshot',
      {},
      'fixture-tool-1',
      'model',
    );
    toolResults.push(t1);
    accounting.toolExecutions += t1.cached ? 0 : 1;
    if (t1.cached) accounting.toolCacheHits += 1;

    const needsWeather = eligible.some((c) => c.kind === 'weather_update' || c.kind === 'trip_preparation');
    const needsDest = eligible.some((c) => c.kind === 'destination_event');

    if (needsWeather) {
      const t2 = this.tools.execute(
        ctx,
        'read_weather_context',
        {},
        'fixture-tool-2',
        'model',
      );
      toolResults.push(t2);
      accounting.toolExecutions += t2.cached ? 0 : 1;
    }
    if (needsDest) {
      const t3 = this.tools.execute(
        ctx,
        'read_destination_impact',
        {},
        'fixture-tool-3',
        'model',
      );
      toolResults.push(t3);
      accounting.toolExecutions += t3.cached ? 0 : 1;
    }

    this.traces.emit(ctx, {
      stage: 'agent_fixture',
      status: 'ok',
      summary: 'Fixture agent completed scripted tool transcript',
    });

    const decisions = this.buildFixtureDecisions(ctx, eligible, ids);
    return {
      decisionSet: { decisions },
      toolResults,
      accounting,
      transcript: [],
    };
  }

  private buildFixtureDecisions(
    ctx: DemoRunContext,
    eligible: TypedCandidate[],
    ids: Set<string>,
  ) {
    const decisions: ModelDecisionSet['decisions'] = [];
    const prep = eligible.filter(
      (c) => c.kind === 'trip_preparation' || c.kind === 'weather_update',
    );
    const dest = eligible.filter((c) => c.kind === 'destination_event');
    const used = new Set<string>();

    if (prep.length) {
      const weather = ctx.scenario.evidence.find(
        (e) => e.kind === 'weather' || e.source === 'mock-weather-service',
      );
      const flight = ctx.scenario.evidence.find(
        (e) => e.kind === 'flight_status' || e.source === 'mock-flight-service',
      );
      const factIds = [flight?.id, weather?.id].filter(Boolean) as string[];
      decisions.push({
        candidateIds: prep.map((c) => c.id),
        decision: 'act_now',
        reasonCode: 'COMBINED_TRIP_PREPARATION',
        reasonSummary: 'Combine useful preparation details into one message.',
        factIds,
        messagePurpose: 'trip_preparation',
        templateId: 'trip_preparation',
        action: 'view_trip',
        recheckAt: null,
        messageDraft: null,
      });
      prep.forEach((c) => used.add(c.id));
    }

    for (const c of dest) {
      const impact = ctx.scenario.evidence.find(
        (e) =>
          e.kind === 'destination_impact' || e.source === 'mock-city-service',
      ) as
        | {
            id: string;
            affectsHotelRoute?: boolean;
            affectsChosenTransport?: boolean;
          }
        | undefined;
      const affects =
        impact?.affectsChosenTransport === true ||
        (impact?.affectsChosenTransport === undefined &&
          impact?.affectsHotelRoute === true);
      if (affects) {
        decisions.push({
          candidateIds: [c.id],
          decision: 'act_now',
          reasonCode: 'ARRIVAL_GUIDANCE_USEFUL',
          reasonSummary: 'Closure affects the traveler journey now.',
          factIds: impact ? [impact.id] : [],
          messagePurpose: 'arrival_guidance',
          templateId: 'arrival_guidance',
          action: 'view_route',
          recheckAt: null,
          messageDraft: null,
        });
      } else {
        decisions.push({
          candidateIds: [c.id],
          decision: 'silent',
          reasonCode: 'NO_JOURNEY_IMPACT',
          reasonSummary:
            'Event exists but does not affect the traveler’s chosen journey.',
          factIds: impact ? [impact.id] : null,
          messagePurpose: null,
          templateId: null,
          action: null,
          recheckAt: null,
          messageDraft: null,
        });
      }
      used.add(c.id);
    }

    for (const c of eligible) {
      if (used.has(c.id) || !ids.has(c.id)) continue;
      decisions.push({
        candidateIds: [c.id],
        decision: 'silent',
        reasonCode: 'NOTHING_USEFUL',
        reasonSummary: 'Nothing useful remains.',
        factIds: null,
        messagePurpose: null,
        templateId: null,
        action: null,
        recheckAt: null,
        messageDraft: null,
      });
    }

    return decisions;
  }

  private async runLive(
    ctx: DemoRunContext,
    envelope: PolicyEnvelope,
    eligible: TypedCandidate[],
  ): Promise<AgentLoopResult> {
    const model =
      this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-2024-08-06';
    const skill = loadSkillText();
    const client = this.getClient();
    const accounting: ModelAccounting = {
      providerMode: 'live',
      liveAttempts: 0,
      liveSuccesses: 0,
      liveFailures: 0,
      fixtureInvocations: 0,
      toolExecutions: 0,
      toolCacheHits: 0,
      requestedModelId: model,
      returnedModelIds: [],
      tokenUsage: { known: false, prompt: 0, completion: 0, total: 0 },
    };
    const toolResults: ToolResult[] = [];
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `${skill.text}\n\nYou are the trip-attention agent. Use tools to gather facts. Do not invent delivery. Every eligible candidate must appear in exactly one final decision group.`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          demoTime: ctx.nowIso,
          policyVersion: envelope.version,
          eligibleCandidates: eligible,
          policyLimits: {
            quietHoursActive: envelope.quietHoursActive,
            contactLimitExceeded: envelope.contactLimitExceeded,
            allowedChannels: envelope.allowedChannels,
          },
          knownFactsNote:
            'Only use evidence returned by tools or mandatory application reads.',
        }),
      },
    ];

    let investigationCalls = 0;
    const maxInvest = POLICY.maxInvestigationCalls;

    while (investigationCalls < maxInvest) {
      if (Date.now() >= ctx.deadlineMs) {
        accounting.liveFailures += 1;
        return {
          toolResults,
          accounting,
          failureReason: 'OVERALL_DEADLINE',
          transcript: messages,
        };
      }
      // Reserve budget for final call
      const remainingForInvest = maxInvest - investigationCalls;
      void remainingForInvest;

      accounting.liveAttempts += 1;
      this.traces.emit(ctx, {
        stage: 'model_investigate',
        status: 'started',
        summary: `Investigation call ${investigationCalls + 1}`,
        detail: { model },
      });

      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await (async () => {
          const call = async () =>
            client.chat.completions.create({
              model,
              temperature: 0,
              messages,
              tools: this.tools.definitions(),
              tool_choice: 'auto',
            });
          return /^(1|true|yes|on|enabled)$/i.test(
            this.config.get<string>('AGENT_INSPECT') ?? '',
          )
            ? step.llm(model, call)
            : call();
        })();
      } catch (err) {
        accounting.liveFailures += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.traces.emit(ctx, {
          stage: 'model_investigate',
          status: 'failed',
          summary: message,
        });
        return {
          toolResults,
          accounting,
          failureReason: `MODEL_ERROR: ${message}`,
          transcript: messages,
        };
      }

      investigationCalls += 1;
      accounting.liveSuccesses += 1;
      if (completion.model) accounting.returnedModelIds.push(completion.model);
      this.accumulateUsage(accounting, completion.usage);

      const choice = completion.choices[0]?.message;
      if (!choice) {
        accounting.liveFailures += 1;
        return {
          toolResults,
          accounting,
          failureReason: 'MODEL_INCOMPLETE',
          transcript: messages,
        };
      }
      messages.push(choice as OpenAI.Chat.ChatCompletionMessageParam);

      const toolCalls = (choice.tool_calls ?? []).filter(
        (tc): tc is OpenAI.Chat.ChatCompletionMessageToolCall & {
          type: 'function';
          function: { name: string; arguments: string };
        } => tc.type === 'function',
      );
      if (!toolCalls.length) {
        break; // ready to finalize
      }

      const pending = [...toolCalls];
      const remainingTools =
        POLICY.maxToolExecutions - accounting.toolExecutions;

      if (remainingTools <= 0) {
        for (const tc of pending) {
          const limitResult: ToolResult = {
            toolCallId: tc.id,
            name: tc.function.name,
            requestedBy: 'model',
            ok: false,
            error: 'TOOL_BUDGET_EXHAUSTED',
          };
          toolResults.push(limitResult);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(limitResult),
          });
        }
        break;
      }

      const toRun = pending.slice(0, remainingTools);
      const overflow = pending.slice(remainingTools);

      for (const tc of toRun) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = { __parseError: true };
        }
        const toolName = tc.function.name;
        const executed = await (async () => {
          const call = () =>
            this.tools.execute(ctx, toolName, args, tc.id, 'model');
          return /^(1|true|yes|on|enabled)$/i.test(
            this.config.get<string>('AGENT_INSPECT') ?? '',
          )
            ? step.tool(toolName, call)
            : call();
        })();
        toolResults.push(executed);
        if (executed.cached) accounting.toolCacheHits += 1;
        else accounting.toolExecutions += 1;
        this.traces.emit(ctx, {
          stage: 'tool',
          status: executed.ok ? 'ok' : 'failed',
          summary: `${toolName}${executed.cached ? ' (cache)' : ''}`,
          detail: {
            toolCallId: tc.id,
            requestedBy: 'model',
            error: executed.error,
          },
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(executed),
        });
      }

      for (const tc of overflow) {
        const limitResult: ToolResult = {
          toolCallId: tc.id,
          name: tc.function.name,
          requestedBy: 'model',
          ok: false,
          error: 'TOOL_BUDGET_EXHAUSTED',
        };
        toolResults.push(limitResult);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(limitResult),
        });
      }

      if (overflow.length || accounting.toolExecutions >= POLICY.maxToolExecutions) {
        break;
      }
    }

    // Final structured decision
    accounting.liveAttempts += 1;
    this.traces.emit(ctx, {
      stage: 'model_finalize',
      status: 'started',
      summary: 'Final structured decision call',
    });

    try {
      const finalCompletion = await (async () => {
        const call = async () =>
          client.chat.completions.parse({
            model,
            temperature: 0,
            messages: [
              ...messages,
              {
                role: 'user',
                content:
                  'Return a complete decisions array covering every eligible candidate exactly once. Tools are disabled. templateId must be exactly one of: trip_preparation, arrival_guidance (never a path). Use JSON null for unused fields, not empty strings. Allowed actions: view_trip, view_route.',
              },
            ],
            response_format: zodResponseFormat(
              ModelDecisionSetSchema,
              'decision_set',
            ),
          });
        return /^(1|true|yes|on|enabled)$/i.test(
          this.config.get<string>('AGENT_INSPECT') ?? '',
        )
          ? step.llm(model, call)
          : call();
      })();

      accounting.liveSuccesses += 1;
      if (finalCompletion.model) {
        accounting.returnedModelIds.push(finalCompletion.model);
      }
      this.accumulateUsage(accounting, finalCompletion.usage);

      const message = finalCompletion.choices[0]?.message;
      if (message?.refusal) {
        accounting.liveFailures += 1;
        return {
          toolResults,
          accounting,
          failureReason: `MODEL_REFUSAL: ${message.refusal}`,
          transcript: messages,
        };
      }
      const parsed = message?.parsed;
      if (!parsed) {
        accounting.liveFailures += 1;
        return {
          toolResults,
          accounting,
          failureReason: 'MODEL_INCOMPLETE',
          transcript: messages,
        };
      }
      const decisionSet = ModelDecisionSetSchema.parse(parsed);
      this.traces.emit(ctx, {
        stage: 'model_finalize',
        status: 'ok',
        summary: `Decision set with ${decisionSet.decisions.length} groups`,
      });
      return { decisionSet, toolResults, accounting, transcript: messages };
    } catch (err) {
      accounting.liveFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.traces.emit(ctx, {
        stage: 'model_finalize',
        status: 'failed',
        summary: message,
      });
      return {
        toolResults,
        accounting,
        failureReason: `MODEL_ERROR: ${message}`,
        transcript: messages,
      };
    }
  }

  private accumulateUsage(
    accounting: ModelAccounting,
    usage?: OpenAI.Completions.CompletionUsage | null,
  ) {
    if (!usage || !accounting.tokenUsage) return;
    accounting.tokenUsage.known = true;
    accounting.tokenUsage.prompt =
      (accounting.tokenUsage.prompt ?? 0) + (usage.prompt_tokens ?? 0);
    accounting.tokenUsage.completion =
      (accounting.tokenUsage.completion ?? 0) + (usage.completion_tokens ?? 0);
    accounting.tokenUsage.total =
      (accounting.tokenUsage.total ?? 0) + (usage.total_tokens ?? 0);
  }
}
