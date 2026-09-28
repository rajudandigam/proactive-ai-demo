import type { ApplicationResult } from '../src/demo/schemas';

const ALLOWED_DECISION_FIELDS = [
  'candidateIds',
  'decision',
  'reasonCode',
  'reasonSummary',
  'action',
  'templateId',
  'factIds',
  'messagePurpose',
  'recheckAt',
] as const;

export function allowlistModelDecisions(
  result: ApplicationResult,
): unknown[] | undefined {
  const decisions = result.modelDecisionSet?.decisions;
  if (!decisions?.length) return undefined;
  return decisions.map((d) => {
    const row: Record<string, unknown> = {};
    for (const key of ALLOWED_DECISION_FIELDS) {
      if (key in d) row[key] = d[key as keyof typeof d];
    }
    return row;
  });
}

export function extractUnsupportedAction(
  result: ApplicationResult,
): Record<string, unknown> | undefined {
  const failure = result.decisions.find(
    (d) => d.outcome === 'failure' && d.reason === 'UNSUPPORTED_ACTION',
  );
  if (!failure) return undefined;
  return {
    reason: failure.reason,
    outcome: failure.outcome,
    candidates: failure.candidates,
    allowlistedProposals: allowlistModelDecisions(result),
  };
}

export type LiveEvalFailurePacket = {
  schemaVersion: 'proactive-ai-demo/live-eval-failure/1';
  recordedAt: string;
  case: string;
  ok: false;
  category: string;
  detail?: string;
  error?: string;
  agentInspectRunId?: string;
  tracePath?: string;
  application: {
    runStatus?: string;
    modelMode?: string;
    modelCalls?: number;
    outboxWrites?: number;
    failureReason?: string;
    accounting?: ApplicationResult['accounting'];
    decisions?: Array<{ outcome: string; reason: string }>;
    allowlistedProposals?: unknown[];
  };
  unsupportedAction?: Record<string, unknown>;
  contractSummary?: unknown;
};
