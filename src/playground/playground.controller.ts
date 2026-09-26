import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listSuite, getScenario } from '../playground/scenario-registry';

@Controller('playground')
export class PlaygroundController {
  private uiPath(file: string): string {
    const candidates = [
      join(process.cwd(), 'public', 'playground-ui', file),
      join(__dirname, '..', '..', 'public', 'playground-ui', file),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return candidates[0]!;
  }

  @Get('ui')
  @Header('Content-Type', 'text/html; charset=utf-8')
  ui(@Res() res: Response) {
    res.send(readFileSync(this.uiPath('index.html'), 'utf8'));
  }

  @Get('ui/app.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  appJs(@Res() res: Response) {
    res.send(readFileSync(this.uiPath('app.js'), 'utf8'));
  }

  @Get('ui/styles.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  css(@Res() res: Response) {
    res.send(readFileSync(this.uiPath('styles.css'), 'utf8'));
  }

  @Get('coverage')
  coverage() {
    const path = join(process.cwd(), 'docs', 'playground', 'coverage-ledger.json');
    if (!existsSync(path)) {
      return { error: 'missing coverage ledger — run npm run lab:inventory' };
    }
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as {
      counts: Record<string, number>;
      agentInspect: { installedVersion: string };
      generatedAt: string;
    };
    return {
      generatedAt: ledger.generatedAt,
      agentInspect: ledger.agentInspect.installedVersion,
      counts: ledger.counts,
      note: 'Denominator includes planned/blocked; passed requires executedEvidence',
    };
  }

  @Get('scenarios')
  scenarios(@Query('suite') suite = 'travel-core') {
    return listSuite(suite).map((s) => ({
      id: s.id,
      name: s.name,
      suite: s.suite,
      workload: s.workload,
      variant: s.variant,
    }));
  }

  @Post('run')
  async run(
    @Body()
    body: { scenarioId?: string; suite?: string; profile?: string },
  ) {
    const scenarioId = body.scenarioId;
    if (!scenarioId) {
      return { overall: 'fail', blockedReason: 'scenarioId required' };
    }
    try {
      const scenario = getScenario(scenarioId);
      if (scenario.suite !== 'travel-core') {
        return {
          overallVerdict: 'blocked',
          blockedReason: `Suite ${scenario.suite} — run via npm run lab:extended -- --suite ${scenario.suite}`,
          scenarioId,
          profile: body.profile ?? 'offline',
        };
      }
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(
        'npx',
        ['tsx', 'scripts/lab/run.ts', '--scenario', scenarioId],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 },
      );
      const jsonStart = out.lastIndexOf('{');
      const parsed = JSON.parse(out.slice(jsonStart)) as Record<string, unknown>;
      return parsed;
    } catch (err) {
      return {
        overallVerdict: 'fail',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
