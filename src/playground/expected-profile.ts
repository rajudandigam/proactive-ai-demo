import type { ScenarioDefinition } from './schemas';
import type { ScenarioFile } from './scenario-registry';

export type ExpectedBlock = ScenarioDefinition['expected'];

export function resolveScenarioExpected(
  scenario: ScenarioFile,
  profileId: string,
): ExpectedBlock {
  const base = scenario.expected;
  const override = scenario.expectedByProfile?.[profileId];
  if (override) {
    const merged: ExpectedBlock = { ...base, ...override };
    if (
      profileId === 'live-model' &&
      override.exactFixtureInvocations === undefined
    ) {
      delete merged.exactFixtureInvocations;
    }
    if (
      profileId === 'live-model' &&
      override.exactLiveAttempts === undefined &&
      override.minLiveAttempts !== undefined
    ) {
      delete merged.exactLiveAttempts;
    }
    return merged;
  }
  if (profileId === 'live-model') {
    const {
      exactFixtureInvocations: _fixtureExact,
      modelMode: _modelMode,
      exactLiveAttempts: _liveExact,
      ...rest
    } = base;
    const needsModel =
      (base.minModelCalls ?? 0) > 0 ||
      (base.exactFixtureInvocations ?? 0) > 0;
    return {
      ...rest,
      modelMode: 'live',
      ...(needsModel ? { minLiveAttempts: 1, maxFixtureInvocations: 0 } : {}),
    };
  }
  return base;
}
