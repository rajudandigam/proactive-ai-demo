import { ModelProposal, ModelProposalSchema } from './schemas';

export type DecisionContext = {
  scenarioId: string;
  tripId: string;
  eligibleCandidateIds: string[];
  evidenceIds: string[];
  skillVersion: string;
  skillText: string;
  summary: string;
};

export interface DecisionProvider {
  readonly mode: 'live' | 'fixture';
  propose(context: DecisionContext): Promise<ModelProposal>;
}

export { ModelProposalSchema, ModelProposal };
