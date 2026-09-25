import { Injectable } from '@nestjs/common';
import { DemoClockService } from './demo-clock.service';
import { FixtureToolsService } from './fixture-tools.service';
import { IntakeRequest, POLICY, Signal } from './schemas';

export type PolicySignalResult = {
  signalId: string;
  signalType: string;
  eligible: boolean;
  category: 'optional' | 'required' | 'deterministic_silent' | 'deterministic_wait';
  reason: string;
  recheckAt?: string;
};

export type PolicyEvaluation = {
  allowed: boolean;
  quietHoursActive: boolean;
  optionalConsent: boolean;
  channelAllowed: boolean;
  contactLimitExceeded: boolean;
  signals: PolicySignalResult[];
  blockModelCall: boolean;
  blockReason?: string;
};

@Injectable()
export class PolicyService {
  constructor(
    private readonly clock: DemoClockService,
    private readonly fixtures: FixtureToolsService,
  ) {}

  evaluate(request: IntakeRequest): PolicyEvaluation {
    const traveler = this.fixtures.readTraveler();
    const trip = this.fixtures.readTrip(request.tripId);
    const now = this.clock.now();
    const prefs = traveler.preferences;

    const quietHoursActive = this.isQuietHours(
      now,
      traveler.timeZone,
      prefs.quietHours.start,
      prefs.quietHours.end,
    );
    const optionalConsent = prefs.optionalTripMessages === true;
    const channelAllowed = prefs.allowedChannels.includes('push');
    const contactLimitExceeded = this.optionalContactLimitExceeded();

    const signals: PolicySignalResult[] = request.signals.map((signal) =>
      this.evaluateSignal(signal, request, now, trip.departureAt, trip.arrivalAt),
    );

    const hasOptionalCandidates = signals.some(
      (s) => s.eligible && s.category === 'optional',
    );

    let blockModelCall = false;
    let blockReason: string | undefined;

    if (hasOptionalCandidates) {
      if (!optionalConsent) {
        blockModelCall = true;
        blockReason = 'OPTIONAL_CONSENT_DISABLED';
      } else if (quietHoursActive) {
        blockModelCall = true;
        blockReason = 'QUIET_HOURS';
      } else if (!channelAllowed) {
        blockModelCall = true;
        blockReason = 'CHANNEL_NOT_ALLOWED';
      } else if (contactLimitExceeded) {
        blockModelCall = true;
        blockReason = 'CONTACT_LIMIT';
      }
    }

    return {
      allowed: true,
      quietHoursActive,
      optionalConsent,
      channelAllowed,
      contactLimitExceeded,
      signals,
      blockModelCall,
      blockReason,
    };
  }

  private evaluateSignal(
    signal: Signal,
    request: IntakeRequest,
    now: Date,
    departureAt: string,
    arrivalAt: string,
  ): PolicySignalResult {
    if (signal.type === 'HOTEL_SEARCH_ABANDONED') {
      if (this.fixtures.hotelIsBooked()) {
        return {
          signalId: signal.id,
          signalType: signal.type,
          eligible: false,
          category: 'deterministic_silent',
          reason: 'HOTEL_ALREADY_BOOKED',
        };
      }
      return {
        signalId: signal.id,
        signalType: signal.type,
        eligible: true,
        category: 'optional',
        reason: 'HOTEL_SEARCH_ELIGIBLE',
      };
    }

    if (signal.type === 'DESTINATION_EVENT') {
      const recheckAt = this.arrivalGuidanceWindowStart(arrivalAt);
      if (now.getTime() < recheckAt.getTime()) {
        return {
          signalId: signal.id,
          signalType: signal.type,
          eligible: false,
          category: 'deterministic_wait',
          reason: 'ARRIVAL_GUIDANCE_NOT_DUE',
          recheckAt: this.formatWithOffset(recheckAt, 'America/New_York'),
        };
      }
      return {
        signalId: signal.id,
        signalType: signal.type,
        eligible: true,
        category: 'optional',
        reason: 'ARRIVAL_GUIDANCE_DUE',
      };
    }

    if (
      signal.type === 'TRIP_PREPARATION' ||
      signal.type === 'WEATHER_UPDATE'
    ) {
      const windowStart = new Date(
        new Date(departureAt).getTime() -
          POLICY.preparationWindowHours * 60 * 60 * 1000,
      );
      if (now.getTime() < windowStart.getTime()) {
        return {
          signalId: signal.id,
          signalType: signal.type,
          eligible: false,
          category: 'deterministic_wait',
          reason: 'PREPARATION_NOT_DUE',
          recheckAt: windowStart.toISOString(),
        };
      }
      return {
        signalId: signal.id,
        signalType: signal.type,
        eligible: true,
        category: 'optional',
        reason: 'PREPARATION_ELIGIBLE',
      };
    }

    if (
      signal.type === 'FLIGHT_CHANGE_CONFIRMED' ||
      request.type === 'FLIGHT_CHANGE_CONFIRMED'
    ) {
      return {
        signalId: signal.id,
        signalType: signal.type,
        eligible: true,
        category: 'required',
        reason: 'REQUIRED_FLIGHT_ALERT',
      };
    }

    return {
      signalId: signal.id,
      signalType: signal.type,
      eligible: false,
      category: 'deterministic_silent',
      reason: 'UNKNOWN_SIGNAL',
    };
  }

  arrivalGuidanceWindowStart(arrivalAt: string): Date {
    return new Date(
      new Date(arrivalAt).getTime() -
        POLICY.arrivalGuidanceWindowHours * 60 * 60 * 1000,
    );
  }

  private optionalContactLimitExceeded(): boolean {
    const messages = this.fixtures.readRecentMessages();
    const now = this.clock.now().getTime();
    const windowMs = POLICY.optionalPushLimitHours * 60 * 60 * 1000;
    const recentOptional = messages.filter((m) => {
      const at = new Date(m.at).getTime();
      return (
        m.purpose === 'trip_preparation' &&
        m.channel === 'push' &&
        now - at <= windowMs
      );
    });
    return recentOptional.length >= POLICY.maxOptionalPushesInWindow;
  }

  isQuietHours(
    now: Date,
    timeZone: string,
    start: string,
    end: string,
  ): boolean {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const minutes = hour * 60 + minute;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin === endMin) return false;
    if (startMin > endMin) {
      // overnight window e.g. 22:00–08:00
      return minutes >= startMin || minutes < endMin;
    }
    return minutes >= startMin && minutes < endMin;
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
