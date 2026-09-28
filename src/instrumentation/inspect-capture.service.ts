import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  inspectRun,
  maybeInspectRun,
  observeOutcome,
  step,
} from 'agent-inspect';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CaptureOperationJournal } from './capture-operation-journal';

const requireAdv = createRequire(__filename);
const {
  getCurrentRunId,
  hasActiveContext,
} = requireAdv('agent-inspect/advanced') as {
  getCurrentRunId: () => string | undefined;
  hasActiveContext: () => boolean;
};

export type InspectRunOptions = {
  executionId: string;
  eventId: string;
  sessionId: string;
  scenarioId?: string;
  metadata?: Record<string, unknown>;
  /** Force enable regardless of AGENT_INSPECT (lab offline suite). */
  force?: boolean;
  /** Override trace directory (lab artifacts). */
  traceDir?: string;
};

@Injectable()
export class InspectCaptureService implements OnModuleDestroy {
  private readonly runMap = new Map<string, string>();
  private closed = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(CaptureOperationJournal)
    private readonly operationJournal: CaptureOperationJournal,
  ) {}

  isEnabled(force?: boolean): boolean {
    if (force) return true;
    return /^(1|true|yes|on|enabled)$/i.test(
      this.config.get<string>('AGENT_INSPECT') ?? process.env.AGENT_INSPECT ?? '',
    );
  }

  /** True when an inspectRun context is active or AGENT_INSPECT is on. */
  isTracing(): boolean {
    return this.isEnabled() || hasActiveContext();
  }

  getMappedRunId(executionId: string): string | undefined {
    return this.runMap.get(executionId);
  }

  rememberMapping(executionId: string, agentInspectRunId: string): void {
    this.runMap.set(executionId, agentInspectRunId);
  }

  defaultTraceDir(): string {
    return (
      this.config.get<string>('AGENT_INSPECT_TRACE_DIR') ??
      process.env.AGENT_INSPECT_TRACE_DIR ??
      '.agent-inspect'
    );
  }

  async tracedStep<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.isTracing()) return step(name, fn);
    return fn();
  }

  async tracedTool<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
    if (this.isTracing()) return step.tool(toolName, fn);
    return fn();
  }

  /**
   * Wrap a full Nest graph execution. When disabled, runs fn unchanged.
   * Uses inspectRun when forced/enabled so fixture + policy-only paths also produce JSONL.
   */
  async withRun<T>(
    name: string,
    opts: InspectRunOptions,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.isEnabled(opts.force)) {
      return fn();
    }
    this.operationJournal.begin(opts.executionId);
    const traceDir = opts.traceDir ?? this.defaultTraceDir();
    const runOpts = {
      silent: true,
      traceDir,
      correlationId: opts.executionId,
      requestId: opts.eventId,
      metadata: {
        sessionId: opts.sessionId,
        scenarioId: opts.scenarioId,
        executionId: opts.executionId,
        ...(opts.metadata ?? {}),
      },
    };

    const result = await inspectRun(
      name,
      async () => {
        const id = getCurrentRunId();
        if (id) this.rememberMapping(opts.executionId, id);
        return fn();
      },
      runOpts,
    );

    if (!this.runMap.has(opts.executionId)) {
      const id =
        getCurrentRunId() ??
        this.resolveRunIdFromTraceDir(traceDir, opts.executionId);
      if (id) this.rememberMapping(opts.executionId, id);
    }

    return result;
  }

  /** Resolve run id from JSONL when ALS mapping was lost across Nest/LangGraph boundaries. */
  resolveRunIdFromTraceDir(
    traceDir: string,
    executionId: string,
  ): string | undefined {
    try {
      if (!existsSync(traceDir)) return undefined;
      for (const name of readdirSync(traceDir)) {
        if (!name.endsWith('.jsonl')) continue;
        const text = readFileSync(join(traceDir, name), 'utf8');
        if (text.includes(executionId)) {
          const m =
            name.match(/^(run_[^.]+)/) ??
            text.match(/"runId"\s*:\s*"(run_[^"]+)"/);
          if (m?.[1]) return m[1];
        }
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  /** Optional maybeInspectRun lane for legacy/helper consumers. */
  async withMaybeRun<T>(
    name: string,
    opts: InspectRunOptions,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.isEnabled(opts.force)) return fn();
    process.env.AGENT_INSPECT = '1';
    return maybeInspectRun(name, fn, {
      silent: true,
      enabled: true,
      traceDir: opts.traceDir ?? this.defaultTraceDir(),
      correlationId: opts.executionId,
      requestId: opts.eventId,
      metadata: {
        sessionId: opts.sessionId,
        scenarioId: opts.scenarioId,
        ...(opts.metadata ?? {}),
      },
    });
  }

  async observeOutbox(opts: {
    name: string;
    written: boolean;
    outboxWrites: number;
    details?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.isTracing()) return;
    await observeOutcome(opts.name, {
      expectation: 'mock outbox preview write when act_now validated',
      status: opts.written ? 'passed' : 'skipped',
      method: 'custom',
      actual: {
        outboxWrites: opts.outboxWrites,
        ...(opts.details ?? {}),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.runMap.clear();
  }
}
