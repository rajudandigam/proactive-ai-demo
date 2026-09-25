import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { DemoRunContext } from './schemas';

export type DemoEvent = {
  sequence: number;
  runId: string;
  eventId: string;
  sessionId: string;
  stepId: string;
  parentStepId?: string;
  realTimestamp: string;
  demoTime: string;
  stage: string;
  status: string;
  durationMs?: number;
  summary: string;
  detail?: Record<string, unknown>;
};

@Injectable()
export class DemoTraceService {
  private sequences = new Map<string, number>();
  private buffers = new Map<string, DemoEvent[]>();
  private emitters = new Map<string, EventEmitter>();
  private readonly maxBuffer = 500;

  private emitter(runId: string): EventEmitter {
    let e = this.emitters.get(runId);
    if (!e) {
      e = new EventEmitter();
      e.setMaxListeners(50);
      this.emitters.set(runId, e);
    }
    return e;
  }

  begin(runId: string): void {
    this.sequences.set(runId, 0);
    this.buffers.set(runId, []);
    this.emitter(runId);
  }

  emit(
    ctx: Pick<DemoRunContext, 'runId' | 'eventId' | 'sessionId' | 'nowIso'>,
    partial: {
      stage: string;
      status: string;
      summary: string;
      detail?: Record<string, unknown>;
      durationMs?: number;
      parentStepId?: string;
      stepId?: string;
    },
  ): DemoEvent {
    const seq = (this.sequences.get(ctx.runId) ?? 0) + 1;
    this.sequences.set(ctx.runId, seq);
    const event: DemoEvent = {
      sequence: seq,
      runId: ctx.runId,
      eventId: ctx.eventId,
      sessionId: ctx.sessionId,
      stepId: partial.stepId ?? `${partial.stage}-${seq}`,
      parentStepId: partial.parentStepId,
      realTimestamp: new Date().toISOString(),
      demoTime: ctx.nowIso,
      stage: partial.stage,
      status: partial.status,
      durationMs: partial.durationMs,
      summary: partial.summary,
      detail: partial.detail,
    };
    const buf = this.buffers.get(ctx.runId) ?? [];
    buf.push(event);
    if (buf.length > this.maxBuffer) buf.shift();
    this.buffers.set(ctx.runId, buf);
    this.emitter(ctx.runId).emit('event', event);
    return event;
  }

  getEvents(runId: string): DemoEvent[] {
    return [...(this.buffers.get(runId) ?? [])];
  }

  subscribe(
    runId: string,
    listener: (event: DemoEvent) => void,
  ): () => void {
    const em = this.emitter(runId);
    em.on('event', listener);
    return () => em.off('event', listener);
  }

  finish(runId: string): void {
    this.emitter(runId).emit('end');
  }
}
