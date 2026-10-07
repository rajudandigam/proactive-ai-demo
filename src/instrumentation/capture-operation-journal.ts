import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/** Logical call kinds — independent of AgentInspect span taxonomy. */
export type CaptureOperationKind = 'llm' | 'tool' | 'fixture';

export type CaptureOperationTerminal =
  | 'started'
  | 'completed'
  | 'failed';

/**
 * One logical model/tool/fixture operation journaled in app code before capture.
 * Never derived from AgentInspect JSONL.
 */
export type CaptureLogicalOperation = {
  operationId: string;
  kind: CaptureOperationKind;
  name: string;
  executionId: string;
  parentOperationId?: string;
  terminal: CaptureOperationTerminal;
  /** Transport attempts under this logical call (live LLM retries, etc.). */
  transportAttempts: number;
};

export type CaptureOperationSnapshot = {
  llmInvocations: number;
  fixtureInvocations: number;
  toolInvocations?: number;
  /** Present for exact-set reconciliation; omitted on legacy counter-only snapshots. */
  operations?: CaptureLogicalOperation[];
};

type MutableSnapshot = {
  llmInvocations: number;
  fixtureInvocations: number;
  toolInvocations: number;
  operations: CaptureLogicalOperation[];
};

function emptySnapshot(): MutableSnapshot {
  return {
    llmInvocations: 0,
    fixtureInvocations: 0,
    toolInvocations: 0,
    operations: [],
  };
}

/**
 * Independent capture journal — records model/tool work observed in app code,
 * not derived from AgentInspect trace events (fidelity cross-check).
 */
@Injectable()
export class CaptureOperationJournal {
  private readonly byExecution = new Map<string, MutableSnapshot>();

  begin(executionId: string): void {
    this.byExecution.set(executionId, emptySnapshot());
  }

  /**
   * Journal a logical operation before the capture wrapper runs.
   * Returns the operationId for terminal updates.
   */
  beginOperation(
    executionId: string,
    kind: CaptureOperationKind,
    name: string,
    opts?: { parentOperationId?: string; operationId?: string },
  ): string {
    const cur = this.ensure(executionId);
    const operationId =
      opts?.operationId ?? `op_${kind}_${randomBytes(4).toString('hex')}`;
    const op: CaptureLogicalOperation = {
      operationId,
      kind,
      name,
      executionId,
      parentOperationId: opts?.parentOperationId,
      terminal: 'started',
      transportAttempts: kind === 'llm' ? 1 : 0,
    };
    cur.operations.push(op);
    if (kind === 'llm') cur.llmInvocations += 1;
    if (kind === 'fixture') cur.fixtureInvocations += 1;
    if (kind === 'tool') cur.toolInvocations += 1;
    return operationId;
  }

  completeOperation(
    executionId: string,
    operationId: string,
    terminal: 'completed' | 'failed',
  ): void {
    const cur = this.byExecution.get(executionId);
    if (!cur?.operations) return;
    const op = cur.operations.find((o) => o.operationId === operationId);
    if (op) op.terminal = terminal;
  }

  private ensure(executionId: string): MutableSnapshot {
    const existing = this.byExecution.get(executionId);
    if (existing) return existing;
    const fresh = emptySnapshot();
    this.byExecution.set(executionId, fresh);
    return fresh;
  }

  /** @deprecated Prefer beginOperation — retained for callers that only bump counts. */
  recordLlm(executionId: string, count = 1): void {
    for (let i = 0; i < count; i += 1) {
      this.beginOperation(executionId, 'llm', `llm_legacy_${i}`);
    }
  }

  /** @deprecated Prefer beginOperation */
  recordFixture(executionId: string, count = 1): void {
    for (let i = 0; i < count; i += 1) {
      this.beginOperation(executionId, 'fixture', `fixture_legacy_${i}`);
    }
  }

  snapshot(executionId: string): CaptureOperationSnapshot | undefined {
    const cur = this.byExecution.get(executionId);
    if (!cur) return undefined;
    return {
      llmInvocations: cur.llmInvocations,
      fixtureInvocations: cur.fixtureInvocations,
      toolInvocations: cur.toolInvocations ?? 0,
      operations: (cur.operations ?? []).map((o) => ({ ...o })),
    };
  }

  clear(executionId: string): void {
    this.byExecution.delete(executionId);
  }
}
