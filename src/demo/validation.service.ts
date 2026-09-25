import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DemoClockService } from './demo-clock.service';
import { FixtureToolsService } from './fixture-tools.service';
import { PolicyService, PolicyEnvelope } from './policy.service';
import {
  DecisionItem,
  DecisionOutcome,
  DemoRunContext,
  ModelDecisionSet,
  POLICY,
  TEMPLATE_REGISTRY,
} from './schemas';

@Injectable()
export class ValidationService {
  constructor(
    @Inject(DemoClockService) private readonly clock: DemoClockService,
    @Inject(FixtureToolsService) private readonly fixtures: FixtureToolsService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  /** Normalize common model quirks before domain checks. */
  normalizeDecisionSet(raw: ModelDecisionSet): ModelDecisionSet {
    return {
      decisions: raw.decisions.map((item) => ({
        ...item,
        templateId: this.normalizeTemplateId(item.templateId),
        messagePurpose: this.emptyToNull(item.messagePurpose),
        action: this.normalizeAction(item.action),
        recheckAt: this.emptyToNull(item.recheckAt),
        messageDraft: this.emptyToNull(item.messageDraft ?? null),
        factIds:
          item.factIds && item.factIds.length === 0 ? null : item.factIds,
      })),
    };
  }

  private emptyToNull<T extends string | null | undefined>(
    value: T,
  ): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    if (trimmed === '') return null;
    const lower = trimmed.toLowerCase();
    if (lower === 'null' || lower === 'undefined') return null;
    return trimmed;
  }

  private normalizeTemplateId(raw: string | null): string | null {
    const value = this.emptyToNull(raw);
    if (!value) return null;
    if (value.toLowerCase() === 'null' || value.toLowerCase() === 'undefined') {
      return null;
    }
    const stripped = value
      .replace(/^\/+/, '')
      .replace(/^templates\//, '')
      .replace(/\.json$/i, '');
    if (TEMPLATE_REGISTRY[stripped]) return stripped;
    const segment = stripped.split('/').filter(Boolean).pop() ?? stripped;
    return TEMPLATE_REGISTRY[segment] ? segment : stripped;
  }

  private normalizeAction(
    raw: string | null,
  ): DecisionItem['action'] {
    const value = this.emptyToNull(raw);
    if (!value) return null;
    const key = value.toLowerCase().replace(/[\s-]+/g, '_');
    const aliases: Record<string, DecisionItem['action']> = {
      view_trip: 'view_trip',
      view_itinerary: 'view_trip',
      open_trip: 'view_trip',
      see_trip: 'view_trip',
      trip_details: 'view_trip',
      view_flight: 'view_flight',
      open_flight: 'view_flight',
      flight_details: 'view_flight',
      view_route: 'view_route',
      open_route: 'view_route',
      see_route: 'view_route',
      route_details: 'view_route',
    };
    return aliases[key] ?? (value as DecisionItem['action']);
  }

  validateDecisionSet(input: {
    ctx: DemoRunContext;
    envelope: PolicyEnvelope;
    decisionSet: ModelDecisionSet;
    modelCandidateIds: string[];
    proposedBy: 'model' | 'template' | 'application';
    required?: boolean;
  }): {
    outcomes: DecisionOutcome[];
    ok: boolean;
    failureReason?: string;
  } {
    const {
      ctx,
      envelope,
      decisionSet: rawSet,
      modelCandidateIds,
      proposedBy,
      required,
    } = input;
    const decisionSet = this.normalizeDecisionSet(rawSet);
    const outcomes: DecisionOutcome[] = [];
    const covered = new Set<string>();

    for (const item of decisionSet.decisions) {
      if (!item.candidateIds.length) {
        return {
          outcomes: [],
          ok: false,
          failureReason: 'EMPTY_CANDIDATE_GROUP',
        };
      }
      for (const id of item.candidateIds) {
        if (!modelCandidateIds.includes(id)) {
          return {
            outcomes: [],
            ok: false,
            failureReason: 'UNKNOWN_OR_DISALLOWED_CANDIDATE',
          };
        }
        if (covered.has(id)) {
          return {
            outcomes: [],
            ok: false,
            failureReason: 'OVERLAPPING_CANDIDATE_GROUPS',
          };
        }
        covered.add(id);
      }

      const result = this.validateItem(ctx, envelope, item, proposedBy, !!required);
      if (!result.ok) {
        outcomes.push(result.outcome);
        return {
          outcomes,
          ok: false,
          failureReason: result.outcome.reason,
        };
      }
      outcomes.push(result.outcome);
    }

    for (const id of modelCandidateIds) {
      if (!covered.has(id)) {
        return {
          outcomes: [
            ...outcomes,
            {
              candidates: [id],
              outcome: 'failure',
              reason: 'MISSING_CANDIDATE_COVERAGE',
              decidedBy: proposedBy,
              proposedBy,
              validatedBy: 'application',
              finalizedBy: 'application',
            },
          ],
          ok: false,
          failureReason: 'MISSING_CANDIDATE_COVERAGE',
        };
      }
    }

    return { outcomes, ok: true };
  }

  private validateItem(
    ctx: DemoRunContext,
    envelope: PolicyEnvelope,
    item: DecisionItem,
    proposedBy: 'model' | 'template' | 'application',
    required: boolean,
  ): { ok: true; outcome: DecisionOutcome } | { ok: false; outcome: DecisionOutcome } {
    if (item.factIds) {
      for (const factId of item.factIds) {
        if (!this.fixtures.readEvidenceById(ctx, factId)) {
          return this.fail(item, proposedBy, 'UNKNOWN_EVIDENCE_ID');
        }
      }
    }

    if (item.decision === 'act_now') {
      if (!item.templateId || !item.action || !item.factIds?.length || !item.messagePurpose) {
        return this.fail(item, proposedBy, 'ACT_MISSING_REQUIRED_FIELDS');
      }
      const registry = TEMPLATE_REGISTRY[item.templateId];
      if (!registry) {
        return this.fail(item, proposedBy, 'UNKNOWN_TEMPLATE');
      }
      if (registry.purpose !== item.messagePurpose) {
        return this.fail(item, proposedBy, 'TEMPLATE_PURPOSE_MISMATCH');
      }
      if (!registry.actions.includes(item.action)) {
        return this.fail(item, proposedBy, 'UNSUPPORTED_ACTION');
      }
      if (registry.required !== required && required) {
        // required path must use required templates
        if (!registry.required) {
          return this.fail(item, proposedBy, 'TEMPLATE_NOT_REQUIRED');
        }
      }

      const traveler = this.fixtures.readTraveler(ctx);
      if (!traveler.preferences.allowedChannels.includes('push')) {
        return this.fail(item, proposedBy, 'CHANNEL_NOT_ALLOWED');
      }
      if (
        !required &&
        this.policy.isQuietHours(
          this.clock.now(ctx),
          traveler.timeZone,
          traveler.preferences.quietHours.start,
          traveler.preferences.quietHours.end,
        )
      ) {
        return this.fail(item, proposedBy, 'QUIET_HOURS');
      }

      // Hotel search silence if booked (by candidate kind, not hardcoded id)
      const kinds = item.candidateIds.map(
        (id) => envelope.candidates.find((c) => c.id === id)?.kind,
      );
      if (
        kinds.includes('hotel_search_abandoned') &&
        this.fixtures.hotelIsBooked(ctx)
      ) {
        return {
          ok: true,
          outcome: {
            candidates: item.candidateIds,
            outcome: 'silent',
            reason: 'HOTEL_ALREADY_BOOKED',
            decidedBy: 'application',
            proposedBy,
            validatedBy: 'application',
            finalizedBy: 'application',
          },
        };
      }

      const body = this.renderNotification(ctx, item);
      const sourceVersion = [...item.factIds].sort().join('+');
      const deliveryKey = `${ctx.scenario.trip.id}:${item.messagePurpose}:${sourceVersion}`;

      return {
        ok: true,
        outcome: {
          candidates: item.candidateIds,
          outcome: 'act_now',
          reason: item.reasonCode,
          decidedBy: proposedBy,
          proposedBy,
          validatedBy: 'application',
          finalizedBy: 'application',
          deliveryKey,
          messageDraft: item.messageDraft ?? undefined,
          notificationPreview: {
            channel: 'push',
            templateId: item.templateId,
            body,
            action: item.action,
            factIds: item.factIds,
          },
        },
      };
    }

    if (item.decision === 'wait') {
      let recheckAt = item.recheckAt;
      const trip = this.fixtures.readTrip(ctx);
      const hasDestination = item.candidateIds.some(
        (id) =>
          envelope.candidates.find((c) => c.id === id)?.kind ===
          'destination_event',
      );
      if (!recheckAt && hasDestination) {
        recheckAt = this.policy.formatWithOffset(
          this.policy.arrivalGuidanceWindowStart(trip.arrivalAt),
          trip.destinationTimeZone,
        );
      }
      if (!recheckAt) {
        return this.fail(item, proposedBy, 'WAIT_MISSING_RECHECK_AT');
      }
      const when = Date.parse(recheckAt);
      const now = this.clock.now(ctx).getTime();
      const deadline = Date.parse(trip.departureAt);
      if (Number.isNaN(when) || when <= now) {
        return this.fail(item, proposedBy, 'WAIT_NOT_IN_FUTURE');
      }
      if (when >= deadline && !hasDestination) {
        return this.fail(item, proposedBy, 'WAIT_NOT_USEFUL');
      }
      if (hasDestination && when >= Date.parse(trip.arrivalAt)) {
        return this.fail(item, proposedBy, 'WAIT_NOT_USEFUL_BEFORE_ARRIVAL');
      }
      return {
        ok: true,
        outcome: {
          candidates: item.candidateIds,
          outcome: 'wait',
          reason: item.reasonCode || 'WAIT',
          recheckAt,
          decidedBy: 'application',
          proposedBy,
          validatedBy: 'application',
          finalizedBy: 'application',
        },
      };
    }

    return {
      ok: true,
      outcome: {
        candidates: item.candidateIds,
        outcome: 'silent',
        reason: item.reasonCode || 'NOTHING_USEFUL',
        decidedBy: proposedBy,
        proposedBy,
        validatedBy: 'application',
        finalizedBy: 'application',
      },
    };
  }

  renderNotification(ctx: DemoRunContext, item: DecisionItem): string {
    const trip = this.fixtures.readTrip(ctx);
    const dest =
      trip.destinationName ??
      (trip.destination === 'BOS' ? 'Boston' : trip.destination);

    if (item.templateId === 'flight_change_confirmed') {
      const flight = this.fixtures.getFlightEvidence(ctx) as
        | { arrivalAt?: string }
        | undefined;
      const arrival = flight?.arrivalAt ?? trip.arrivalAt;
      return `Your flight to ${trip.destination} now arrives at ${this.shortTime(arrival, trip.destinationTimeZone)}. View flight details.`;
    }

    if (item.templateId === 'arrival_guidance') {
      return `A verified route update may affect your trip to ${dest}. View your route.`;
    }

    const facts = new Set(item.factIds ?? []);
    const evidence = this.fixtures.readEvidence(ctx);
    let checkIn = false;
    let rain = false;
    for (const e of evidence) {
      if (!facts.has(e.id)) continue;
      if ((e as { checkInOpen?: boolean }).checkInOpen) checkIn = true;
      if ((e as { forecast?: string }).forecast === 'rain') rain = true;
    }

    const whenLabel = this.relativeDayLabel(ctx, trip.departureAt);
    if (checkIn && rain) {
      return `Your ${dest} trip is ${whenLabel}. Check-in is open, and rain is expected. View your trip plan.`;
    }
    if (checkIn) {
      return `Your ${dest} trip is ${whenLabel}. Check-in is open. View your trip plan.`;
    }
    if (rain) {
      return `Your ${dest} trip is ${whenLabel}. Rain is expected. View your trip plan.`;
    }
    return `Your ${dest} trip is ${whenLabel}. View your trip plan.`;
  }

  private relativeDayLabel(ctx: DemoRunContext, departureAt: string): string {
    const now = this.clock.now(ctx);
    const dep = new Date(departureAt);
    const diffDays = Math.round(
      (Date.UTC(dep.getFullYear(), dep.getMonth(), dep.getDate()) -
        Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
        86400000,
    );
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'tomorrow';
    return `on ${dep.toISOString().slice(0, 10)}`;
  }

  private shortTime(iso: string, timeZone: string): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(iso));
  }

  private fail(
    item: DecisionItem,
    proposedBy: 'model' | 'template' | 'application',
    reason: string,
  ) {
    return {
      ok: false as const,
      outcome: {
        candidates: item.candidateIds,
        outcome: 'failure' as const,
        reason,
        decidedBy: proposedBy,
        proposedBy,
        validatedBy: 'application' as const,
        finalizedBy: 'application' as const,
      },
    };
  }

  hashPayload(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
