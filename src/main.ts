import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`Proactive AI demo listening on http://${host}:${port}`);
  // eslint-disable-next-line no-console
  console.log(
    `Decision provider: ${(process.env.DECISION_PROVIDER ?? 'fixture').toUpperCase()}`,
  );
}

bootstrap();
