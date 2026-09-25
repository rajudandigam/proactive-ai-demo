#!/usr/bin/env npx tsx
/**
 * Opt-in live evaluation. Ordinary tests never call this.
 * Requires DECISION_PROVIDER=live and OPENAI_API_KEY.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DecisionGraphService } from '../src/demo/decision.graph';
import { OutboxService } from '../src/demo/outbox.service';
import { FixtureToolsService } from '../src/demo/fixture-tools.service';

async function main() {
  if ((process.env.DECISION_PROVIDER ?? '').toLowerCase() !== 'live') {
    console.error('Set DECISION_PROVIDER=live and OPENAI_API_KEY to run live eval.');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is required for live eval.');
    process.exit(1);
  }

  const tripReview = JSON.parse(
    readFileSync(
      join(process.cwd(), 'fixtures', 'requests', 'trip-review.json'),
      'utf8',
    ),
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const graph = app.get(DecisionGraphService);
  const outbox = app.get(OutboxService);
  const fixtures = app.get(FixtureToolsService);
  outbox.reset();
  fixtures.reset();

  console.log('Running live trip-review evaluation...');
  const result = await graph.run(tripReview);
  console.log(
    JSON.stringify(
      {
        runStatus: result.runStatus,
        modelMode: result.modelMode,
        modelCalls: result.modelCalls,
        decisions: result.decisions.map((d) => ({
          outcome: d.outcome,
          reason: d.reason,
          action: d.notificationPreview?.action,
          factIds: d.notificationPreview?.factIds,
        })),
        outboxWrites: result.outboxWrites,
      },
      null,
      2,
    ),
  );

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
