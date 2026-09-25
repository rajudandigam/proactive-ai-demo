import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import {
  DecisionContext,
  DecisionProvider,
  ModelProposal,
  ModelProposalSchema,
} from './decision-provider';

const ProposalResponseSchema = z.object({
  decision: z.enum(['act_now', 'wait', 'silent']),
  candidateIds: z.array(z.string()),
  factIds: z.array(z.string()).nullable(),
  templateId: z.string().nullable(),
  action: z.enum(['view_trip', 'view_flight']).nullable(),
  recheckAt: z.string().nullable(),
  reasonSummary: z.string(),
});

@Injectable()
export class OpenAiDecisionProvider implements DecisionProvider {
  readonly mode = 'live' as const;
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = this.config.get<string>('OPENAI_API_KEY');
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is required for live decision provider');
      }
      this.client = new OpenAI({
        apiKey,
        timeout: Number(this.config.get('OPENAI_TIMEOUT_MS') ?? 15000),
        maxRetries: 0,
      });
    }
    return this.client;
  }

  async propose(context: DecisionContext): Promise<ModelProposal> {
    const model =
      this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-2024-08-06';
    const client = this.getClient();

    const completion = await client.chat.completions.parse({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You propose proactive trip notification decisions. Follow the skill. Only use provided candidate and fact IDs. Never invent channels or delivery. ${context.skillText}`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            scenarioId: context.scenarioId,
            tripId: context.tripId,
            eligibleCandidateIds: context.eligibleCandidateIds,
            evidenceIds: context.evidenceIds,
            summary: context.summary,
            skillVersion: context.skillVersion,
          }),
        },
      ],
      response_format: zodResponseFormat(
        ProposalResponseSchema,
        'model_proposal',
      ),
    });

    const message = completion.choices[0]?.message;
    if (message?.refusal) {
      throw new Error(`MODEL_REFUSAL: ${message.refusal}`);
    }
    const parsed = message?.parsed;
    if (!parsed) {
      throw new Error('MODEL_INCOMPLETE: empty structured output');
    }
    return ModelProposalSchema.parse(parsed);
  }
}
