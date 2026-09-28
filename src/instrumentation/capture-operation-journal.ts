import { Injectable } from '@nestjs/common';

export type CaptureOperationSnapshot = {
  llmInvocations: number;
  fixtureInvocations: number;
};

/**
 * Independent capture journal — records model work observed in app code,
 * not derived from AgentInspect trace events (fidelity cross-check).
 */
@Injectable()
export class CaptureOperationJournal {
  private readonly byExecution = new Map<string, CaptureOperationSnapshot>();

  begin(executionId: string): void {
    this.byExecution.set(executionId, {
      llmInvocations: 0,
      fixtureInvocations: 0,
    });
  }

  recordLlm(executionId: string, count = 1): void {
    const cur = this.byExecution.get(executionId) ?? {
      llmInvocations: 0,
      fixtureInvocations: 0,
    };
    cur.llmInvocations += count;
    this.byExecution.set(executionId, cur);
  }

  recordFixture(executionId: string, count = 1): void {
    const cur = this.byExecution.get(executionId) ?? {
      llmInvocations: 0,
      fixtureInvocations: 0,
    };
    cur.fixtureInvocations += count;
    this.byExecution.set(executionId, cur);
  }

  snapshot(executionId: string): CaptureOperationSnapshot | undefined {
    const cur = this.byExecution.get(executionId);
    return cur ? { ...cur } : undefined;
  }

  clear(executionId: string): void {
    this.byExecution.delete(executionId);
  }
}
