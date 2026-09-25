import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export const SignalSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  claimedSourceVersion: z.string().optional(),
});

export const IntakeRequestSchema = z.object({
  eventId: z.string().min(1),
  tripId: z.string().min(1),
  type: z.enum(['TRIP_REVIEW', 'FLIGHT_CHANGE_CONFIRMED']).or(z.string()),
  scenarioId: z.string().min(1),
  sessionId: z.string().optional(),
  signals: z.array(SignalSchema).min(1),
});

export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;
export type Signal = z.infer<typeof SignalSchema>;

export const QuietHoursSchema = z.object({
  start: z.string(),
  end: z.string(),
});

export const TravelerPreferencesSchema = z.object({
  optionalTripMessages: z.boolean(),
  allowedChannels: z.array(z.enum(['push', 'email', 'sms'])),
  quietHours: QuietHoursSchema,
});

export const TravelerSchema = z.object({
  id: z.string(),
  name: z.string(),
  timeZone: z.string(),
  preferences: TravelerPreferencesSchema,
});

export const TripSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  status: z.string(),
  origin: z.string(),
  destination: z.string(),
  destinationName: z.string().optional(),
  destinationTimeZone: z.string(),
  departureAt: z.string(),
  arrivalAt: z.string(),
  transportToHotel: z.string().optional(),
  hotel: z.object({
    status: z.string(),
    area: z.string().optional(),
  }),
});

export const EvidenceItemSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    checkedAt: z.string(),
    kind: z.string().optional(),
  })
  .passthrough();

export const ScenarioFixtureSchema = z.object({
  scenarioId: z.string(),
  preset: z.string().optional(),
  label: z.string().optional(),
  now: z.string(),
  actor: z.object({ id: z.string() }),
  traveler: TravelerSchema,
  trip: TripSchema,
  evidence: z.array(EvidenceItemSchema),
  recentActivity: z.array(
    z.object({
      type: z.string(),
      at: z.string(),
    }),
  ),
  recentMessages: z.array(
    z.object({
      purpose: z.string(),
      channel: z.string(),
      at: z.string(),
      deliveryKey: z.string().optional(),
    }),
  ),
});

export type ScenarioFixture = z.infer<typeof ScenarioFixtureSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const DecisionItemSchema = z.object({
  candidateIds: z.array(z.string()).min(1),
  decision: z.enum(['act_now', 'wait', 'silent']),
  reasonCode: z.string(),
  reasonSummary: z.string(),
  factIds: z.array(z.string()).nullable(),
  messagePurpose: z.string().nullable(),
  templateId: z.string().nullable(),
  action: z
    .enum(['view_trip', 'view_flight', 'view_route'])
    .nullable(),
  recheckAt: z.string().nullable(),
  messageDraft: z.string().nullable().optional(),
});

export type DecisionItem = z.infer<typeof DecisionItemSchema>;

export const ModelDecisionSetSchema = z.object({
  decisions: z.array(DecisionItemSchema).min(1),
});

export type ModelDecisionSet = z.infer<typeof ModelDecisionSetSchema>;

/** @deprecated v1 single proposal — kept for fixture adapter compatibility */
export const ModelProposalSchema = z.object({
  decision: z.enum(['act_now', 'wait', 'silent']),
  candidateIds: z.array(z.string()),
  factIds: z.array(z.string()).nullable(),
  templateId: z.string().nullable(),
  action: z.enum(['view_trip', 'view_flight', 'view_route']).nullable(),
  recheckAt: z.string().nullable(),
  reasonSummary: z.string(),
});

export type ModelProposal = z.infer<typeof ModelProposalSchema>;

export const DecisionOutcomeSchema = z.object({
  candidates: z.array(z.string()),
  outcome: z.enum(['act_now', 'wait', 'silent', 'failure']),
  reason: z.string(),
  recheckAt: z.string().optional(),
  proposedBy: z.enum(['application', 'model', 'template']).optional(),
  validatedBy: z.enum(['application']).optional(),
  finalizedBy: z.enum(['application']).optional(),
  policyRuleIds: z.array(z.string()).optional(),
  decidedBy: z.enum(['application', 'model', 'template']),
  deliveryKey: z.string().optional(),
  messageDraft: z.string().optional(),
  notificationPreview: z
    .object({
      channel: z.string(),
      templateId: z.string(),
      body: z.string(),
      action: z.string().optional(),
      factIds: z.array(z.string()),
    })
    .optional(),
});

export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

export const ModelAccountingSchema = z.object({
  providerMode: z.enum(['live', 'fixture', 'replay', 'none']),
  liveAttempts: z.number().int().nonnegative(),
  liveSuccesses: z.number().int().nonnegative(),
  liveFailures: z.number().int().nonnegative(),
  fixtureInvocations: z.number().int().nonnegative(),
  toolExecutions: z.number().int().nonnegative(),
  toolCacheHits: z.number().int().nonnegative(),
  requestedModelId: z.string().nullable(),
  returnedModelIds: z.array(z.string()),
  tokenUsage: z
    .object({
      prompt: z.number().optional(),
      completion: z.number().optional(),
      total: z.number().optional(),
      known: z.boolean(),
    })
    .optional(),
});

export type ModelAccounting = z.infer<typeof ModelAccountingSchema>;

export const ApplicationResultSchema = z.object({
  runStatus: z.enum(['completed', 'partial_failure', 'failed', 'duplicate']),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  eventId: z.string(),
  modelMode: z.enum(['live', 'fixture', 'replay', 'none']),
  modelCalls: z.number().int().nonnegative(),
  accounting: ModelAccountingSchema.optional(),
  decisions: z.array(DecisionOutcomeSchema),
  outboxWrites: z.number().int().nonnegative(),
  modelProposals: z.array(ModelProposalSchema).optional(),
  modelDecisionSet: ModelDecisionSetSchema.optional(),
  policyRules: z.array(z.record(z.unknown())).optional(),
  failureReason: z.string().optional(),
  duplicateOf: z.string().optional(),
  agentInspectTraceId: z.string().optional(),
  trace: z.record(z.unknown()).optional(),
});

export type ApplicationResult = z.infer<typeof ApplicationResultSchema>;

export type PolicyRuleResult = {
  id: string;
  version: string;
  scope: string;
  observed: string;
  constraint: string;
  result: 'pass' | 'block' | 'defer' | 'not_applicable';
  explanation: string;
  recheckAt?: string;
  stage: 'permission' | 'deterministic' | 'delivery';
};

export type TypedCandidate = {
  id: string;
  type: string;
  kind:
    | 'trip_preparation'
    | 'weather_update'
    | 'destination_event'
    | 'hotel_search_abandoned'
    | 'flight_change_confirmed'
    | 'other';
  category: 'optional' | 'required';
  claimedSourceVersion?: string;
  allowedActions: string[];
  messagePurposes: string[];
  allowedOutcomes: Array<'act_now' | 'wait' | 'silent'>;
  requiredEvidenceKinds: string[];
};

export type DemoRunContext = {
  runId: string;
  sessionId: string;
  eventId: string;
  scenarioId: string;
  actorId: string;
  nowIso: string;
  deadlineMs: number;
  startedAtMs: number;
  scenario: ScenarioFixture;
  request: IntakeRequest;
};

export function createRunId(): string {
  return randomUUID();
}

export function createSessionId(): string {
  return `session-${randomUUID()}`;
}

export const POLICY = {
  version: 'demo-v2',
  preparationWindowHours: 24,
  arrivalGuidanceWindowHours: 2,
  optionalPushLimitHours: 6,
  maxOptionalPushesInWindow: 1,
  maxInvestigationCalls: 2,
  maxToolExecutions: 4,
  maxFinalCalls: 1,
  perCallTimeoutMs: 15000,
  overallDeadlineMs: 45000,
  allowedOptionalActions: ['view_trip', 'view_route'] as const,
  allowedRequiredActions: ['view_flight'] as const,
  requiredAlertChannel: 'push' as const,
} as const;

export const TEMPLATE_REGISTRY: Record<
  string,
  { purpose: string; actions: string[]; required: boolean }
> = {
  trip_preparation: {
    purpose: 'trip_preparation',
    actions: ['view_trip'],
    required: false,
  },
  arrival_guidance: {
    purpose: 'arrival_guidance',
    actions: ['view_route'],
    required: false,
  },
  flight_change_confirmed: {
    purpose: 'flight_change',
    actions: ['view_flight'],
    required: true,
  },
};
