import {
  Body,
  Controller,
  Get,
  Header,
  MessageEvent,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  Sse,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Observable } from 'rxjs';
import { DecisionGraphService } from './decision.graph';
import { FixtureToolsService } from './fixture-tools.service';
import { OutboxService } from './outbox.service';
import { RunsService } from './runs.service';
import { createSessionId } from './schemas';

@Controller('demo')
export class DemoController {
  constructor(
    private readonly graph: DecisionGraphService,
    private readonly fixtures: FixtureToolsService,
    private readonly outbox: OutboxService,
    private readonly runs: RunsService,
    private readonly config: ConfigService,
  ) {}

  @Post('intake')
  async intake(
    @Body() body: unknown,
    @Query('sessionId') sessionId?: string,
  ) {
    return this.graph.run(body, { sessionId });
  }

  @Post('runs')
  async createRun(
    @Body() body: { request: unknown; sessionId?: string },
  ) {
    const record = await this.runs.start(body.request, body.sessionId);
    return {
      runId: record.id,
      sessionId: record.sessionId,
      status: record.status,
    };
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string) {
    const record = this.runs.get(id);
    if (!record) throw new NotFoundException('run not found');
    return record;
  }

  @Sse('runs/:id/events')
  events(@Param('id') id: string): Observable<MessageEvent> {
    const record = this.runs.get(id);
    if (!record) {
      throw new NotFoundException('run not found');
    }
    return new Observable((subscriber) => {
      for (const e of this.runs.getEvents(id)) {
        subscriber.next({ data: e });
      }
      const unsub = this.runs.subscribe(id, (e) => {
        subscriber.next({ data: e });
      });
      const poll = setInterval(() => {
        const r = this.runs.get(id);
        if (r && r.status !== 'running') {
          subscriber.next({
            data: { type: 'run_complete', status: r.status },
          });
          subscriber.complete();
          clearInterval(poll);
          unsub();
        }
      }, 200);
      return () => {
        clearInterval(poll);
        unsub();
      };
    });
  }

  @Get('outbox')
  getOutbox(@Query('sessionId') sessionId?: string) {
    return {
      modelMode: this.graph.getProviderMode(),
      entries: this.outbox.getOutbox(sessionId),
    };
  }

  @Post('reset')
  reset() {
    if (this.outbox.hasActiveRuns()) {
      return {
        ok: false,
        message: 'RESET_BLOCKED: a run is still active',
      };
    }
    this.outbox.reset();
    this.fixtures.reset();
    return {
      ok: true,
      message:
        'Ledger and fixture state cleared. Process restart also clears in-memory state; no durable delivery guarantee.',
    };
  }

  @Get('health')
  health() {
    return {
      ok: true,
      modelMode: this.graph.getProviderMode(),
      scenarios: this.fixtures.listScenarioIds(),
      presets: this.fixtures.listPresets(),
    };
  }

  @Get('config')
  publicConfig() {
    const mode = this.graph.getProviderMode();
    return {
      decisionProvider: mode,
      model:
        mode === 'live'
          ? this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-2024-08-06'
          : 'fixture-agent',
      agentInspect:
        /^(1|true|yes|on|enabled)$/i.test(
          this.config.get<string>('AGENT_INSPECT') ?? '',
        ),
      labels: {
        modeLabel:
          mode === 'live' ? 'LIVE OPENAI' : 'FIXTURE',
        dataLabel: 'Mock travel facts',
        deliveryLabel: 'Preview delivery',
      },
      newSessionId: createSessionId(),
    };
  }

  @Get('scenarios')
  scenarios() {
    return this.fixtures.listPresets();
  }

  @Get('ui')
  @Header('Content-Type', 'text/html; charset=utf-8')
  ui(@Res() res: Response) {
    const path = this.uiPath('index.html');
    res.send(readFileSync(path, 'utf8'));
  }

  @Get('ui/app.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  uiJs(@Res() res: Response) {
    res.send(readFileSync(this.uiPath('app.js'), 'utf8'));
  }

  @Get('ui/styles.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  uiCss(@Res() res: Response) {
    res.send(readFileSync(this.uiPath('styles.css'), 'utf8'));
  }

  @Get('architecture/:file')
  architecture(@Param('file') file: string, @Res() res: Response) {
    const safe = file.replace(/[^a-zA-Z0-9._-]/g, '');
    const path = join(process.cwd(), 'docs', 'architecture', safe);
    if (!existsSync(path)) throw new NotFoundException();
    if (safe.endsWith('.png')) res.type('image/png');
    else if (safe.endsWith('.svg')) res.type('image/svg+xml');
    else res.type('text/plain');
    res.send(readFileSync(path));
  }

  private uiPath(file: string): string {
    const candidates = [
      join(process.cwd(), 'public', 'demo-ui', file),
      join(__dirname, '..', '..', 'public', 'demo-ui', file),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    throw new NotFoundException(`UI asset missing: ${file}`);
  }
}
