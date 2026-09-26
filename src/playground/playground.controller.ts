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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSuite, getScenario, KNOWN_SUITES } from '../playground/scenario-registry';
import { PROFILES } from '../playground/schemas';

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

  @Get('profiles')
  profiles() {
    return Object.values(PROFILES);
  }

  @Get('scenarios')
  scenarios(@Query('suite') suite = 'travel-core') {
    if (!(KNOWN_SUITES as readonly string[]).includes(suite)) {
      return { error: `Unknown suite: ${suite}`, known: KNOWN_SUITES };
    }
    try {
      return listSuite(suite).map((s) => ({
        id: s.id,
        name: s.name,
        suite: s.suite,
        workload: s.workload,
        variant: s.variant,
      }));
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        known: KNOWN_SUITES,
      };
    }
  }

  @Post('run')
  async run(
    @Body()
    body: { scenarioId?: string; suite?: string; profile?: string },
  ) {
    const scenarioId = body.scenarioId;
    if (!scenarioId) {
      return { overallVerdict: 'fail', blockedReason: 'scenarioId required' };
    }
    const profile = body.profile ?? 'offline';
    if (!PROFILES[profile]) {
      return {
        overallVerdict: 'blocked',
        blockedReason: `Unknown profile: ${profile}`,
        knownProfiles: Object.keys(PROFILES),
      };
    }
    let tmp: string | undefined;
    try {
      const scenario = getScenario(scenarioId);
      if (scenario.suite !== 'travel-core') {
        return {
          overallVerdict: 'blocked',
          blockedReason: `Suite ${scenario.suite} — run via npm run lab:extended -- --suite ${scenario.suite}`,
          scenarioId,
          profile,
        };
      }
      tmp = mkdtempSync(join(tmpdir(), 'playground-run-'));
      const resultFile = join(tmp, 'result.json');
      const { execFileSync } = await import('node:child_process');
      // Logs go to stdout/stderr; machine-readable result is only in resultFile.
      execFileSync(
        'npx',
        [
          'tsx',
          'scripts/lab/run.ts',
          '--scenario',
          scenarioId,
          '--profile',
          profile,
          '--result-file',
          resultFile,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 120_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      if (!existsSync(resultFile)) {
        return {
          overallVerdict: 'fail',
          error: 'Lab runner did not write result file',
          scenarioId,
          profile,
        };
      }
      return JSON.parse(readFileSync(resultFile, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch (err) {
      const stdout =
        err && typeof err === 'object' && 'stdout' in err
          ? String((err as { stdout: unknown }).stdout)
          : '';
      const stderr =
        err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr: unknown }).stderr)
          : '';
      // Prefer dedicated result file even on non-zero exit
      if (tmp) {
        const resultFile = join(tmp, 'result.json');
        if (existsSync(resultFile)) {
          try {
            return JSON.parse(readFileSync(resultFile, 'utf8')) as Record<
              string,
              unknown
            >;
          } catch {
            /* fall through */
          }
        }
      }
      return {
        overallVerdict: 'fail',
        error: err instanceof Error ? err.message : String(err),
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
      };
    } finally {
      if (tmp) {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
}
