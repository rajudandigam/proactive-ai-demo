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
import { CaptureOperationJournal } from '../instrumentation/capture-operation-journal';
import { InspectCaptureService } from '../instrumentation/inspect-capture.service';
import { PlaygroundController } from '../playground/playground.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
  ],
  controllers: [DemoController, PlaygroundController],
  providers: [
    DemoClockService,
    FixtureToolsService,
    PolicyService,
    ValidationService,
    OutboxService,
    ReadToolsService,
    DemoTraceService,
    CaptureOperationJournal,
    InspectCaptureService,
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
    InspectCaptureService,
    CaptureOperationJournal,
  ],
})
export class DemoModule {}
