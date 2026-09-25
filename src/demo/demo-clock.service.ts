import { Injectable } from '@nestjs/common';
import {
  DemoRunContext,
  ScenarioFixture,
  createRunId,
  createSessionId,
  IntakeRequest,
  POLICY,
} from './schemas';

/**
 * Owns only the factory for immutable per-run clocks.
 * Never stores a process-wide "now" — each DemoRunContext carries its own.
 */
@Injectable()
export class DemoClockService {
  createContext(
    scenario: ScenarioFixture,
    request: IntakeRequest,
    opts?: { sessionId?: string; runId?: string },
  ): DemoRunContext {
    const startedAtMs = Date.now();
    return {
      runId: opts?.runId ?? createRunId(),
      sessionId: opts?.sessionId ?? request.sessionId ?? createSessionId(),
      eventId: request.eventId,
      scenarioId: scenario.scenarioId,
      actorId: scenario.actor.id,
      nowIso: scenario.now,
      deadlineMs: startedAtMs + POLICY.overallDeadlineMs,
      startedAtMs,
      scenario: structuredClone(scenario),
      request: structuredClone(request),
    };
  }

  now(ctx: DemoRunContext): Date {
    return new Date(ctx.nowIso);
  }

  remainingMs(ctx: DemoRunContext): number {
    return Math.max(0, ctx.deadlineMs - Date.now());
  }

  isExpired(ctx: DemoRunContext): boolean {
    return Date.now() >= ctx.deadlineMs;
  }
}
