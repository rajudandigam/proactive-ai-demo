import { z } from 'zod';

export const SignalSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  claimedSourceVersion: z.string().optional(),
});

export const IntakeRequestSchema = z.object({
  eventId: z.string().min(1),
  tripId: z.string().min(1),
  type: z.enum(['TRIP_REVIEW', 'FLIGHT_CHANGE_CONFIRMED']),
  scenarioId: z.string().min(1),
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
  destinationTimeZone: z.string(),
  departureAt: z.string(),
  arrivalAt: z.string(),
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
  })
  .passthrough();

export const ScenarioFixtureSchema = z.object({
  scenarioId: z.string(),
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

export const ModelProposalSchema = z.object({
  decision: z.enum(['act_now', 'wait', 'silent']),
  candidateIds: z.array(z.string()),
  factIds: z.array(z.string()).nullable(),
  templateId: z.string().nullable(),
  action: z.enum(['view_trip', 'view_flight']).nullable(),
  recheckAt: z.string().nullable(),
  reasonSummary: z.string(),
});

export type ModelProposal = z.infer<typeof ModelProposalSchema>;

export const DecisionOutcomeSchema = z.object({
  candidates: z.array(z.string()),
  outcome: z.enum(['act_now', 'wait', 'silent', 'failure']),
  reason: z.string(),
  recheckAt: z.string().optional(),
  decidedBy: z.enum(['application', 'model', 'template']),
  deliveryKey: z.string().optional(),
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

export const ApplicationResultSchema = z.object({
  runStatus: z.enum(['completed', 'partial_failure', 'failed', 'duplicate']),
  eventId: z.string(),
  modelMode: z.enum(['live', 'fixture', 'none']),
  modelCalls: z.number().int().nonnegative(),
  decisions: z.array(DecisionOutcomeSchema),
  outboxWrites: z.number().int().nonnegative(),
  modelProposals: z.array(ModelProposalSchema).optional(),
  failureReason: z.string().optional(),
  duplicateOf: z.string().optional(),
  trace: z.record(z.unknown()).optional(),
});

export type ApplicationResult = z.infer<typeof ApplicationResultSchema>;

export const POLICY = {
  preparationWindowHours: 24,
  arrivalGuidanceWindowHours: 2,
  optionalPushLimitHours: 6,
  maxOptionalPushesInWindow: 1,
  allowedOptionalActions: ['view_trip'] as const,
  allowedRequiredActions: ['view_flight'] as const,
  requiredAlertChannel: 'push' as const,
} as const;
