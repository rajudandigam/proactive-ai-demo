import { Injectable } from '@nestjs/common';
import { ApplicationResult, DecisionOutcome } from './schemas';

export type OutboxEntry = {
  deliveryKey: string;
  eventId: string;
  channel: string;
  templateId: string;
  body: string;
  action?: string;
  factIds: string[];
  createdAt: string;
};

@Injectable()
export class OutboxService {
  private outbox: OutboxEntry[] = [];
  private deliveryKeys = new Map<string, OutboxEntry>();
  private eventResults = new Map<string, ApplicationResult>();
  private eventLocks = new Map<string, Promise<void>>();

  reset(): void {
    this.outbox = [];
    this.deliveryKeys.clear();
    this.eventResults.clear();
    this.eventLocks.clear();
  }

  getOutbox(): OutboxEntry[] {
    return [...this.outbox];
  }

  getEventResult(eventId: string): ApplicationResult | undefined {
    return this.eventResults.get(eventId);
  }

  rememberEventResult(eventId: string, result: ApplicationResult): void {
    this.eventResults.set(eventId, result);
  }

  /**
   * Serialize concurrent intakes for the same eventId within this process.
   */
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

  tryWrite(
    outcome: DecisionOutcome,
    eventId: string,
    nowIso: string,
  ): { written: boolean; entry?: OutboxEntry; duplicate: boolean } {
    if (outcome.outcome !== 'act_now' || !outcome.notificationPreview) {
      return { written: false, duplicate: false };
    }
    const deliveryKey = outcome.deliveryKey;
    if (!deliveryKey) {
      return { written: false, duplicate: false };
    }
    const existing = this.deliveryKeys.get(deliveryKey);
    if (existing) {
      return { written: false, duplicate: true, entry: existing };
    }
    const entry: OutboxEntry = {
      deliveryKey,
      eventId,
      channel: outcome.notificationPreview.channel,
      templateId: outcome.notificationPreview.templateId,
      body: outcome.notificationPreview.body,
      action: outcome.notificationPreview.action,
      factIds: outcome.notificationPreview.factIds,
      createdAt: nowIso,
    };
    this.deliveryKeys.set(deliveryKey, entry);
    this.outbox.push(entry);
    return { written: true, duplicate: false, entry };
  }
}
