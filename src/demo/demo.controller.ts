import { Body, Controller, Get, Post } from '@nestjs/common';
import { DecisionGraphService } from './decision.graph';
import { FixtureToolsService } from './fixture-tools.service';
import { OutboxService } from './outbox.service';
import { DemoClockService } from './demo-clock.service';

@Controller('demo')
export class DemoController {
  constructor(
    private readonly graph: DecisionGraphService,
    private readonly fixtures: FixtureToolsService,
    private readonly outbox: OutboxService,
    private readonly clock: DemoClockService,
  ) {}

  @Post('intake')
  async intake(@Body() body: unknown) {
    return this.graph.run(body);
  }

  @Get('outbox')
  getOutbox() {
    return {
      modelMode: this.graph.getProvider().mode,
      clock: this.clock.getConfiguredIso(),
      entries: this.outbox.getOutbox(),
    };
  }

  @Post('reset')
  reset() {
    this.outbox.reset();
    this.fixtures.reset();
    return {
      ok: true,
      message:
        'Ledger and fixture state cleared. Process restart also clears the in-memory ledger; no durable delivery guarantee.',
    };
  }

  @Get('health')
  health() {
    return {
      ok: true,
      modelMode: this.graph.getProvider().mode,
      scenarios: this.fixtures.listScenarioIds(),
    };
  }
}
