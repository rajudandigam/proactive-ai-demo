import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DecisionGraphService } from './decision.graph';
import { DemoTraceService, DemoEvent } from './trace-events.service';
import { ApplicationResult, createSessionId } from './schemas';

export type RunRecord = {
  id: string;
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  request: unknown;
  result?: ApplicationResult;
  error?: string;
  createdAt: string;
};

@Injectable()
export class RunsService {
  private runs = new Map<string, RunRecord>();
  private lastBySession = new Map<string, string>();

  constructor(
    @Inject(DecisionGraphService) private readonly graph: DecisionGraphService,
    @Inject(DemoTraceService) private readonly traces: DemoTraceService,
  ) {}

  async start(rawRequest: unknown, sessionId?: string): Promise<RunRecord> {
    const id = randomUUID();
    const sid = sessionId ?? createSessionId();
    const record: RunRecord = {
      id,
      sessionId: sid,
      status: 'running',
      request: rawRequest,
      createdAt: new Date().toISOString(),
    };
    this.runs.set(id, record);
    this.lastBySession.set(sid, id);

    // Fire async
    void this.graph
      .run(rawRequest, { sessionId: sid, runId: id })
      .then((result) => {
        record.result = result;
        record.status =
          result.runStatus === 'failed' ? 'failed' : 'completed';
        this.runs.set(id, record);
      })
      .catch((err) => {
        record.status = 'failed';
        record.error = err instanceof Error ? err.message : String(err);
        this.runs.set(id, record);
        this.traces.finish(id);
      });

    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  getEvents(id: string): DemoEvent[] {
    return this.traces.getEvents(id);
  }

  subscribe(id: string, listener: (e: DemoEvent) => void): () => void {
    return this.traces.subscribe(id, listener);
  }
}
