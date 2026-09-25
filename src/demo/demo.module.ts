import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DECISION_PROVIDER, DecisionGraphService } from './decision.graph';
import { DemoClockService } from './demo-clock.service';
import { DemoController } from './demo.controller';
import { FixtureDecisionProvider } from './fixture-decision.provider';
import { FixtureToolsService } from './fixture-tools.service';
import { OpenAiDecisionProvider } from './openai-decision.provider';
import { OutboxService } from './outbox.service';
import { PolicyService } from './policy.service';
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
    FixtureDecisionProvider,
    OpenAiDecisionProvider,
    DecisionGraphService,
    { provide: DECISION_PROVIDER, useValue: null },
  ],
  exports: [
    DecisionGraphService,
    FixtureToolsService,
    OutboxService,
    DemoClockService,
    PolicyService,
    ValidationService,
    FixtureDecisionProvider,
  ],
})
export class DemoModule {}
