import { Injectable } from '@nestjs/common';
import { ApplicationResult, DecisionOutcome } from './schemas';

export type OutboxEntry = {
  deliveryKey: string;
  eventId: string;
  sessionId: string;
  purpose: string;
  channel: string;
  templateId: string;
  body: string;
  action?: string;
  factIds: string[];
  createdAt: string;
};

type SessionState = {
  outbox: OutboxEntry[];
  deliveryKeys: Map<string, OutboxEntry>;
  eventResults: Map<string, ApplicationResult>;
  eventPayloadHashes: Map<string, string>;
};

@Injectable()
export class OutboxService {
  private sessions = new Map<string, SessionState>();
  private eventLocks = new Map<string, Promise<void>>();
  private sessionLocks = new Map<string, Promise<void>>();
  private activeRuns = new Set<string>();

  reset(): void {
    if (this.activeRuns.size > 0) {
      throw new Error('RESET_BLOCKED: a run is still active');
    }
    this.sessions.clear();
    this.eventLocks.clear();
    this.sessionLocks.clear();
  }

  markRunActive(runId: string): void {
    this.activeRuns.add(runId);
  }

  markRunInactive(runId: string): void {
    this.activeRuns.delete(runId);
  }

  hasActiveRuns(): boolean {
    return this.activeRuns.size > 0;
  }

  private session(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        outbox: [],
        deliveryKeys: new Map(),
        eventResults: new Map(),
        eventPayloadHashes: new Map(),
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  getOutbox(sessionId?: string): OutboxEntry[] {
    if (sessionId) return [...this.session(sessionId).outbox];
    return [...this.sessions.values()].flatMap((s) => s.outbox);
  }

  getSessionOptionalPreviews(sessionId: string): OutboxEntry[] {
    return this.session(sessionId).outbox.filter(
      (e) =>
        e.purpose === 'trip_preparation' || e.purpose === 'arrival_guidance',
    );
  }

  getEventResult(
    sessionId: string,
    eventId: string,
  ): ApplicationResult | undefined {
    return this.session(sessionId).eventResults.get(eventId);
  }

  rememberEventResult(
    sessionId: string,
    eventId: string,
    result: ApplicationResult,
    payloadHash: string,
  ): void {
    const s = this.session(sessionId);
    s.eventResults.set(eventId, result);
    s.eventPayloadHashes.set(eventId, payloadHash);
  }

  getPayloadHash(sessionId: string, eventId: string): string | undefined {
    return this.session(sessionId).eventPayloadHashes.get(eventId);
  }

  async withEventLock<T>(eventId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.eventLocks.get(eventId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.eventLocks.set(
      eventId,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async withSessionWriteLock<T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionLocks.set(
      sessionId,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  tryWrite(
    outcome: DecisionOutcome,
    eventId: string,
    sessionId: string,
    purpose: string,
    nowIso: string,
  ): { written: boolean; entry?: OutboxEntry; duplicate: boolean } {
    if (outcome.outcome !== 'act_now' || !outcome.notificationPreview) {
      return { written: false, duplicate: false };
    }
    const deliveryKey = outcome.deliveryKey;
    if (!deliveryKey) return { written: false, duplicate: false };
    const s = this.session(sessionId);
    const existing = s.deliveryKeys.get(deliveryKey);
    if (existing) {
      return { written: false, duplicate: true, entry: existing };
    }
    const entry: OutboxEntry = {
      deliveryKey,
      eventId,
      sessionId,
      purpose,
      channel: outcome.notificationPreview.channel,
      templateId: outcome.notificationPreview.templateId,
      body: outcome.notificationPreview.body,
      action: outcome.notificationPreview.action,
      factIds: outcome.notificationPreview.factIds,
      createdAt: nowIso,
    };
    s.deliveryKeys.set(deliveryKey, entry);
    s.outbox.push(entry);
    return { written: true, duplicate: false, entry };
  }
}
