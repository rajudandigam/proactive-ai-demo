import { Injectable } from '@nestjs/common';
import {
  DecisionContext,
  DecisionProvider,
  ModelProposal,
} from './decision-provider';

/**
 * Deterministic development provider. Clearly labelled as fixture mode —
 * never present these responses as live model output.
 */
@Injectable()
export class FixtureDecisionProvider implements DecisionProvider {
  readonly mode = 'fixture' as const;

  async propose(context: DecisionContext): Promise<ModelProposal> {
    const ids = new Set(context.eligibleCandidateIds);

    // Default trip-review proposal: combine preparation + weather.
    if (ids.has('preparation-1') || ids.has('weather-1')) {
      const candidateIds = ['preparation-1', 'weather-1'].filter((id) =>
        ids.has(id),
      );
      const factIds = ['flight-status-v1', 'weather-v1'].filter((id) =>
        context.evidenceIds.includes(id),
      );
      return {
        decision: 'act_now',
        candidateIds,
        factIds: factIds.length ? factIds : null,
        templateId: 'trip_preparation',
        action: 'view_trip',
        recheckAt: null,
        reasonSummary:
          'Combine the useful preparation details into one message.',
      };
    }

    if (ids.has('route-1')) {
      return {
        decision: 'wait',
        candidateIds: ['route-1'],
        factIds: ['road-closure-v1'],
        templateId: null,
        action: null,
        recheckAt: null,
        reasonSummary: 'Arrival guidance is useful later, not now.',
      };
    }

    return {
      decision: 'silent',
      candidateIds: context.eligibleCandidateIds,
      factIds: null,
      templateId: null,
      action: null,
      recheckAt: null,
      reasonSummary: 'Nothing useful remains after policy and evidence checks.',
    };
  }
}
