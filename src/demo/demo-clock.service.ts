import { Injectable } from '@nestjs/common';

@Injectable()
export class DemoClockService {
  private nowIso: string | null = null;

  setNow(iso: string): void {
    this.nowIso = iso;
  }

  clear(): void {
    this.nowIso = null;
  }

  now(): Date {
    if (!this.nowIso) {
      throw new Error('Demo clock is not set. Load a scenario before evaluating.');
    }
    return new Date(this.nowIso);
  }

  nowIsoString(): string {
    return this.now().toISOString();
  }

  getConfiguredIso(): string | null {
    return this.nowIso;
  }
}
