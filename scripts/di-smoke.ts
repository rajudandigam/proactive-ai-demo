import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DecisionGraphService } from '../src/demo/decision.graph';
import { createSessionId } from '../src/demo/schemas';

async function main() {
  process.env.DECISION_PROVIDER = 'fixture';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const graph = app.get(DecisionGraphService);
  const r = await graph.run(
    {
      eventId: 'di-smoke-1',
      tripId: 'trip-jordan',
      type: 'TRIP_REVIEW',
      scenarioId: 'jordan-before-departure',
      signals: [
        { id: 'preparation-1', type: 'TRIP_PREPARATION' },
        { id: 'weather-1', type: 'WEATHER_UPDATE' },
      ],
    },
    { sessionId: createSessionId() },
  );
  console.log(
    JSON.stringify({
      ok: true,
      runStatus: r.runStatus,
      outboxWrites: r.outboxWrites,
      mode: r.modelMode,
    }),
  );
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
