import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DecisionGraphService } from './decision.graph';
import { DemoClockService } from './demo-clock.service';
import { DemoController } from './demo.controller';
import { FixtureToolsService } from './fixture-tools.service';
import { OutboxService } from './outbox.service';
import { PolicyService } from './policy.service';
import { ReadToolsService } from './read-tools.service';
import { RunsService } from './runs.service';
import { DemoTraceService } from './trace-events.service';
import { TripAttentionAgentService } from './trip-attention.agent';
import { ValidationService } from './validation.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
  ],
  controllers: [DemoController],
  providers: [
    DemoClockService,
    FixtureToolsService,
    PolicyService,
    ValidationService,
    OutboxService,
    ReadToolsService,
    DemoTraceService,
    TripAttentionAgentService,
    DecisionGraphService,
    RunsService,
  ],
  exports: [
    DecisionGraphService,
    FixtureToolsService,
    OutboxService,
    DemoClockService,
    PolicyService,
    ValidationService,
    DemoTraceService,
    RunsService,
  ],
})
export class DemoModule {}
