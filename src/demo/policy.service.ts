import { Inject, Injectable } from '@nestjs/common';
import { DemoClockService } from './demo-clock.service';
import { FixtureToolsService } from './fixture-tools.service';
import { OutboxService } from './outbox.service';
import {
  DemoRunContext,
  POLICY,
  PolicyRuleResult,
  TypedCandidate,
  Signal,
} from './schemas';

export type PolicyEnvelope = {
  version: string;
  rules: PolicyRuleResult[];
  candidates: TypedCandidate[];
  optionalEligible: TypedCandidate[];
  requiredEligible: TypedCandidate[];
  deterministicOutcomes: Array<{
    candidateId: string;
    outcome: 'wait' | 'silent';
    reason: string;
    recheckAt?: string;
    policyRuleIds: string[];
  }>;
  blockOptionalModel: boolean;
  blockReason?: string;
  quietHoursActive: boolean;
  optionalConsent: boolean;
  channelAllowed: boolean;
  contactLimitExceeded: boolean;
  allowedTools: string[];
  allowedChannels: string[];
};

const SIGNAL_KIND: Record<
  string,
  TypedCandidate['kind']
> = {
  TRIP_PREPARATION: 'trip_preparation',
  WEATHER_UPDATE: 'weather_update',
  DESTINATION_EVENT: 'destination_event',
  HOTEL_SEARCH_ABANDONED: 'hotel_search_abandoned',
  FLIGHT_CHANGE_CONFIRMED: 'flight_change_confirmed',
};

@Injectable()
export class PolicyService {
  constructor(
    @Inject(DemoClockService) private readonly clock: DemoClockService,
    @Inject(FixtureToolsService) private readonly fixtures: FixtureToolsService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  evaluate(ctx: DemoRunContext): PolicyEnvelope {
    const traveler = this.fixtures.readTraveler(ctx);
    const trip = this.fixtures.readTrip(ctx);
    const now = this.clock.now(ctx);
    const prefs = traveler.preferences;
    const rules: PolicyRuleResult[] = [];

    const quietHoursActive = this.isQuietHours(
      now,
      traveler.timeZone,
      prefs.quietHours.start,
      prefs.quietHours.end,
    );
    const optionalConsent = prefs.optionalTripMessages === true;
    const channelAllowed = prefs.allowedChannels.includes('push');
    const contactLimitExceeded = this.optionalContactLimitExceeded(ctx);

    rules.push({
      id: 'optional_consent',
      version: POLICY.version,
      scope: 'traveler',
      observed: optionalConsent ? 'Enabled' : 'Disabled',
      constraint: 'Optional trip messages allowed',
      result: optionalConsent ? 'pass' : 'block',
      explanation: optionalConsent
        ? 'Traveler opted into optional trip messages.'
        : 'Optional trip messages are disabled.',
      stage: 'permission',
    });

    const quietRecheck = this.nextQuietHoursEnd(
      now,
      traveler.timeZone,
      prefs.quietHours.end,
    );
    rules.push({
      id: 'quiet_hours',
      version: POLICY.version,
      scope: 'traveler',
      observed: this.formatLocalTime(now, traveler.timeZone),
      constraint: `${prefs.quietHours.start}–${prefs.quietHours.end} ${traveler.timeZone}`,
      result: quietHoursActive ? 'defer' : 'pass',
      explanation: quietHoursActive
        ? 'Inside quiet hours; defer optional contact until the window ends if still useful.'
        : 'Outside quiet hours.',
      recheckAt: quietHoursActive ? quietRecheck : undefined,
      stage: 'permission',
    });

    rules.push({
      id: 'channel_push',
      version: POLICY.version,
      scope: 'traveler',
      observed: prefs.allowedChannels.join(','),
      constraint: 'push permitted',
      result: channelAllowed ? 'pass' : 'block',
      explanation: channelAllowed
        ? 'Push channel is allowed.'
        : 'Push channel is not allowed.',
      stage: 'permission',
    });

    rules.push({
      id: 'contact_limit',
      version: POLICY.version,
      scope: 'session',
      observed: contactLimitExceeded
        ? `>=${POLICY.maxOptionalPushesInWindow} optional push in ${POLICY.optionalPushLimitHours}h`
        : `Under ${POLICY.maxOptionalPushesInWindow} optional push in ${POLICY.optionalPushLimitHours}h`,
      constraint: `Max ${POLICY.maxOptionalPushesInWindow} optional push / ${POLICY.optionalPushLimitHours}h`,
      result: contactLimitExceeded ? 'defer' : 'pass',
      explanation: contactLimitExceeded
        ? 'Optional contact budget already used; defer if still useful later.'
        : 'Optional contact budget available.',
      stage: 'permission',
    });

    const candidates = ctx.request.signals.map((s) => this.toCandidate(s));
    const deterministicOutcomes: PolicyEnvelope['deterministicOutcomes'] = [];
    const optionalEligible: TypedCandidate[] = [];
    const requiredEligible: TypedCandidate[] = [];

    for (const candidate of candidates) {
      if (candidate.kind === 'hotel_search_abandoned') {
        if (this.fixtures.hotelIsBooked(ctx)) {
          rules.push({
            id: `completed_booking:${candidate.id}`,
            version: POLICY.version,
            scope: 'candidate',
            observed: 'Hotel confirmed',
            constraint: 'Suppress abandoned hotel-search reminder',
            result: 'block',
            explanation: 'Hotel is already booked; reminder is unnecessary.',
            stage: 'deterministic',
          });
          deterministicOutcomes.push({
            candidateId: candidate.id,
            outcome: 'silent',
            reason: 'HOTEL_ALREADY_BOOKED',
            policyRuleIds: [`completed_booking:${candidate.id}`],
          });
          continue;
        }
      }

      if (candidate.kind === 'flight_change_confirmed') {
        requiredEligible.push(candidate);
        rules.push({
          id: `required_flight:${candidate.id}`,
          version: POLICY.version,
          scope: 'candidate',
          observed: 'Confirmed flight change signal',
          constraint: 'Separate explicit category policy',
          result: 'pass',
          explanation: 'Required alert path; optional AI is not required.',
          stage: 'permission',
        });
        continue;
      }

      if (
        candidate.kind === 'trip_preparation' ||
        candidate.kind === 'weather_update'
      ) {
        const windowStart = new Date(
          new Date(trip.departureAt).getTime() -
            POLICY.preparationWindowHours * 60 * 60 * 1000,
        );
        const expiresAt = new Date(trip.departureAt);
        if (now.getTime() < windowStart.getTime()) {
          const recheckAt = windowStart.toISOString();
          rules.push({
            id: `preparation_timing:${candidate.id}`,
            version: POLICY.version,
            scope: 'candidate',
            observed: `${POLICY.preparationWindowHours}h window not open`,
            constraint: `Eligible within ${POLICY.preparationWindowHours}h of departure; expires at departure`,
            result: 'defer',
            explanation: 'Preparation is not due yet.',
            recheckAt,
            stage: 'deterministic',
          });
          deterministicOutcomes.push({
            candidateId: candidate.id,
            outcome: 'wait',
            reason: 'PREPARATION_NOT_DUE',
            recheckAt,
            policyRuleIds: [`preparation_timing:${candidate.id}`],
          });
          continue;
        }
        if (now.getTime() >= expiresAt.getTime()) {
          rules.push({
            id: `preparation_timing:${candidate.id}`,
            version: POLICY.version,
            scope: 'candidate',
            observed: 'Past departure',
            constraint: 'Expires at departure',
            result: 'block',
            explanation: 'Preparation opportunity has expired.',
            stage: 'deterministic',
          });
          deterministicOutcomes.push({
            candidateId: candidate.id,
            outcome: 'silent',
            reason: 'PREPARATION_EXPIRED',
            policyRuleIds: [`preparation_timing:${candidate.id}`],
          });
          continue;
        }
        rules.push({
          id: `preparation_timing:${candidate.id}`,
          version: POLICY.version,
          scope: 'candidate',
          observed: 'Within preparation window',
          constraint: `Eligible within ${POLICY.preparationWindowHours}h of departure`,
          result: 'pass',
          explanation: 'Preparation messaging is eligible.',
          stage: 'permission',
        });
        optionalEligible.push(candidate);
        continue;
      }

      if (candidate.kind === 'destination_event') {
        const recheckAtDate = this.arrivalGuidanceWindowStart(trip.arrivalAt);
        if (now.getTime() < recheckAtDate.getTime()) {
          const recheckAt = this.formatWithOffset(
            recheckAtDate,
            trip.destinationTimeZone,
          );
          rules.push({
            id: `arrival_guidance:${candidate.id}`,
            version: POLICY.version,
            scope: 'candidate',
            observed: 'Arrival guidance not yet due',
            constraint: `Eligible within ${POLICY.arrivalGuidanceWindowHours}h of arrival`,
            result: 'defer',
            explanation: 'Arrival guidance should wait until closer to arrival.',
            recheckAt,
            stage: 'deterministic',
          });
          deterministicOutcomes.push({
            candidateId: candidate.id,
            outcome: 'wait',
            reason: 'ARRIVAL_GUIDANCE_NOT_DUE',
            recheckAt,
            policyRuleIds: [`arrival_guidance:${candidate.id}`],
          });
          continue;
        }
        rules.push({
          id: `arrival_guidance:${candidate.id}`,
          version: POLICY.version,
          scope: 'candidate',
          observed: 'Within arrival guidance window',
          constraint: `Eligible within ${POLICY.arrivalGuidanceWindowHours}h of arrival`,
          result: 'pass',
          explanation: 'Arrival guidance is eligible now.',
          stage: 'permission',
        });
        optionalEligible.push(candidate);
        continue;
      }

      optionalEligible.push(candidate);
    }

    let blockOptionalModel = false;
    let blockReason: string | undefined;
    if (optionalEligible.length > 0) {
      if (!optionalConsent) {
        blockOptionalModel = true;
        blockReason = 'OPTIONAL_CONSENT_DISABLED';
      } else if (!channelAllowed) {
        blockOptionalModel = true;
        blockReason = 'CHANNEL_NOT_ALLOWED';
      } else if (quietHoursActive) {
        blockOptionalModel = true;
        blockReason = 'QUIET_HOURS';
      } else if (contactLimitExceeded) {
        blockOptionalModel = true;
        blockReason = 'CONTACT_LIMIT';
      }
    }

    if (blockOptionalModel && optionalEligible.length) {
      for (const c of optionalEligible) {
        if (
          blockReason === 'QUIET_HOURS' ||
          blockReason === 'CONTACT_LIMIT'
        ) {
          const recheckAt =
            blockReason === 'QUIET_HOURS'
              ? quietRecheck
              : new Date(
                  now.getTime() + POLICY.optionalPushLimitHours * 3600 * 1000,
                ).toISOString();
          // Still useful before departure?
          const useful =
            Date.parse(recheckAt) < Date.parse(trip.departureAt);
          deterministicOutcomes.push({
            candidateId: c.id,
            outcome: useful ? 'wait' : 'silent',
            reason: useful ? blockReason : `${blockReason}_EXPIRED`,
            recheckAt: useful ? recheckAt : undefined,
            policyRuleIds: [blockReason.toLowerCase()],
          });
        } else {
          deterministicOutcomes.push({
            candidateId: c.id,
            outcome: 'silent',
            reason: blockReason!,
            policyRuleIds: [blockReason!.toLowerCase()],
          });
        }
      }
    }

    return {
      version: POLICY.version,
      rules,
      candidates,
      optionalEligible: blockOptionalModel ? [] : optionalEligible,
      requiredEligible,
      deterministicOutcomes,
      blockOptionalModel,
      blockReason,
      quietHoursActive,
      optionalConsent,
      channelAllowed,
      contactLimitExceeded,
      allowedTools: [
        'read_trip_snapshot',
        'read_weather_context',
        'read_destination_impact',
        'read_contact_history',
      ],
      allowedChannels: prefs.allowedChannels,
    };
  }

  toCandidate(signal: Signal): TypedCandidate {
    const kind = SIGNAL_KIND[signal.type] ?? 'other';
    const category =
      kind === 'flight_change_confirmed' ? 'required' : 'optional';
    const allowedActions =
      category === 'required'
        ? [...POLICY.allowedRequiredActions]
        : [...POLICY.allowedOptionalActions];
    return {
      id: signal.id,
      type: signal.type,
      kind,
      category,
      claimedSourceVersion: signal.claimedSourceVersion,
      allowedActions,
      messagePurposes:
        kind === 'destination_event'
          ? ['arrival_guidance']
          : kind === 'flight_change_confirmed'
            ? ['flight_change']
            : ['trip_preparation'],
      allowedOutcomes: ['act_now', 'wait', 'silent'],
      requiredEvidenceKinds:
        kind === 'weather_update'
          ? ['weather']
          : kind === 'destination_event'
            ? ['destination_impact']
            : kind === 'flight_change_confirmed'
              ? ['flight_status']
              : ['flight_status'],
    };
  }

  arrivalGuidanceWindowStart(arrivalAt: string): Date {
    return new Date(
      new Date(arrivalAt).getTime() -
        POLICY.arrivalGuidanceWindowHours * 60 * 60 * 1000,
    );
  }

  optionalContactLimitExceeded(ctx: DemoRunContext): boolean {
    const now = this.clock.now(ctx).getTime();
    const windowMs = POLICY.optionalPushLimitHours * 60 * 60 * 1000;
    const seeded = this.fixtures.readSeededMessages(ctx);
    const session = this.outbox.getSessionOptionalPreviews(ctx.sessionId);
    const all = [
      ...seeded.map((m) => ({ purpose: m.purpose, channel: m.channel, at: m.at })),
      ...session.map((e) => ({
        purpose: e.purpose,
        channel: e.channel,
        at: e.createdAt,
      })),
    ];
    const recent = all.filter((m) => {
      const at = Date.parse(m.at);
      if (Number.isNaN(at)) return false;
      const age = now - at;
      return (
        m.purpose === 'trip_preparation' ||
        m.purpose === 'arrival_guidance'
      ) && m.channel === 'push' && age >= 0 && age < windowMs;
    });
    return recent.length >= POLICY.maxOptionalPushesInWindow;
  }

  isQuietHours(
    now: Date,
    timeZone: string,
    start: string,
    end: string,
  ): boolean {
    const minutes = this.localMinutes(now, timeZone);
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin === endMin) return false;
    if (startMin > endMin) {
      return minutes >= startMin || minutes < endMin;
    }
    return minutes >= startMin && minutes < endMin;
  }

  nextQuietHoursEnd(now: Date, timeZone: string, end: string): string {
    const [eh, em] = end.split(':').map(Number);
    // Approximate: advance calendar day in local zone via iterative hour steps
    let probe = new Date(now.getTime());
    for (let i = 0; i < 48 * 60; i++) {
      probe = new Date(probe.getTime() + 60_000);
      const mins = this.localMinutes(probe, timeZone);
      if (mins === eh * 60 + em) {
        return probe.toISOString();
      }
    }
    return new Date(now.getTime() + 8 * 3600 * 1000).toISOString();
  }

  localMinutes(now: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return (hour % 24) * 60 + minute;
  }

  formatLocalTime(now: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(now);
  }

  formatWithOffset(date: Date, timeZone: string): string {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'longOffset',
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(date).map((p) => [p.type, p.value]),
    );
    const offsetRaw = (parts.timeZoneName || 'GMT-00:00').replace('GMT', '');
    const offset = offsetRaw === '' ? '+00:00' : offsetRaw;
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  }
}
