import { z } from 'zod';

export const RunProfileSchema = z.object({
  id: z.string(),
  modelMode: z.enum(['scripted', 'live', 'none']),
  toolMode: z.enum(['fixture', 'live', 'recorded']),
  agentInspect: z.boolean().default(true),
});

export type RunProfile = z.infer<typeof RunProfileSchema>;

export const ExpectedDecisionSchema = z.object({
  reason: z.string().optional(),
  outcome: z.enum(['act_now', 'wait', 'silent', 'failure']).optional(),
  decidedBy: z.enum(['application', 'model', 'template']).optional(),
});

export const ScenarioDefinitionSchema = z.object({
  id: z.string(),
  version: z.string().default('1.0.0'),
  name: z.string(),
  suite: z.string().default('travel-core'),
  workload: z.string().default('trip'),
  variant: z.enum(['valid', 'invalid', 'insufficient-evidence']).default('valid'),
  /** When true, overall test passes only if contract/fidelity detects expected defect. */
  expectFailure: z.boolean().default(false),
  expectedFailureCode: z.string().optional(),
  request: z.record(z.unknown()),
  expected: z.object({
    runStatus: z
      .enum(['completed', 'partial_failure', 'failed', 'duplicate'])
      .optional(),
    modelMode: z.enum(['live', 'fixture', 'replay', 'none']).optional(),
    minOutboxWrites: z.number().int().nonnegative().optional(),
    maxOutboxWrites: z.number().int().nonnegative().optional(),
    exactOutboxWrites: z.number().int().nonnegative().optional(),
    maxModelCalls: z.number().int().nonnegative().optional(),
    minModelCalls: z.number().int().nonnegative().optional(),
    exactFixtureInvocations: z.number().int().nonnegative().optional(),
    exactLiveAttempts: z.number().int().nonnegative().optional(),
    decisions: z.array(ExpectedDecisionSchema).optional(),
    requireReasons: z.array(z.string()).optional(),
    forbidReasons: z.array(z.string()).optional(),
  }),
  contract: z
    .object({
      requireCompleted: z.boolean().optional(),
      forbiddenTools: z.array(z.string()).optional(),
      requiredTools: z.array(z.string()).optional(),
      expectCheckPass: z.boolean().optional(),
    })
    .optional(),
});

export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;

export const AssertionResultSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  message: z.string(),
  observed: z.unknown().optional(),
  expected: z.unknown().optional(),
});

export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const VerdictSchema = z.enum(['pass', 'fail', 'blocked', 'insufficient']);

export const ScenarioResultSchema = z.object({
  batchId: z.string(),
  scenarioId: z.string(),
  scenarioVersion: z.string(),
  executionId: z.string(),
  profileId: z.string(),
  agentInspectRunId: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  sourceKind: z.enum([
    'physical-execution',
    'recorded-tool-execution',
    'synthetic-trace',
    'mutated-trace',
  ]),
  applicationVerdict: VerdictSchema,
  captureFidelityVerdict: VerdictSchema,
  contractVerdict: VerdictSchema,
  overallVerdict: VerdictSchema,
  assertions: z.array(AssertionResultSchema),
  artifactDir: z.string(),
  blockedReason: z.string().optional(),
});

export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;

export const OFFLINE_PROFILE: RunProfile = {
  id: 'offline',
  modelMode: 'scripted',
  toolMode: 'fixture',
  agentInspect: true,
};

export const LIVE_MODEL_PROFILE: RunProfile = {
  id: 'live-model',
  modelMode: 'live',
  toolMode: 'fixture',
  agentInspect: true,
};

export const LIVE_TOOLS_PROFILE: RunProfile = {
  id: 'live-tools',
  modelMode: 'scripted',
  toolMode: 'live',
  agentInspect: true,
};

export const LIVE_FULL_PROFILE: RunProfile = {
  id: 'live-full',
  modelMode: 'live',
  toolMode: 'live',
  agentInspect: true,
};

export const PROFILES: Record<string, RunProfile> = {
  offline: OFFLINE_PROFILE,
  'live-model': LIVE_MODEL_PROFILE,
  'live-tools': LIVE_TOOLS_PROFILE,
  'live-full': LIVE_FULL_PROFILE,
};

export function resolveProfile(id: string): RunProfile {
  const profile = PROFILES[id];
  if (!profile) {
    throw new Error(
      `Unknown profile: ${id}. Known: ${Object.keys(PROFILES).join(', ')}`,
    );
  }
  return profile;
}
