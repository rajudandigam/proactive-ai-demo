import { Injectable } from '@nestjs/common';
import { DemoClockService } from './demo-clock.service';
import { FixtureToolsService } from './fixture-tools.service';
import { PolicyService } from './policy.service';
import { DecisionOutcome, ModelProposal, POLICY } from './schemas';

export type ValidationInput = {
  proposal: ModelProposal;
  allowedCandidateIds: string[];
  decidedBy: 'model' | 'template' | 'application';
  purpose: string;
  required?: boolean;
};

export type ValidationResult =
  | { ok: true; outcome: DecisionOutcome }
  | { ok: false; reason: string; outcome: DecisionOutcome };

@Injectable()
export class ValidationService {
  constructor(
    private readonly clock: DemoClockService,
    private readonly fixtures: FixtureToolsService,
    private readonly policy: PolicyService,
  ) {}

  validate(input: ValidationInput): ValidationResult {
    const { proposal, allowedCandidateIds, decidedBy, purpose, required } =
      input;

    for (const id of proposal.candidateIds) {
      if (!allowedCandidateIds.includes(id)) {
        return this.fail(
          proposal,
          decidedBy,
          'UNKNOWN_OR_DISALLOWED_CANDIDATE',
        );
      }
    }

    if (proposal.factIds) {
      for (const factId of proposal.factIds) {
        if (!this.fixtures.readEvidenceById(factId)) {
          return this.fail(proposal, decidedBy, 'UNKNOWN_EVIDENCE_ID');
        }
      }
    }

    if (proposal.decision === 'act_now') {
      if (
        !proposal.templateId ||
        !proposal.action ||
        !proposal.factIds?.length
      ) {
        return this.fail(proposal, decidedBy, 'ACT_MISSING_REQUIRED_FIELDS');
      }
      const allowedActions = required
        ? POLICY.allowedRequiredActions
        : POLICY.allowedOptionalActions;
      if (!(allowedActions as readonly string[]).includes(proposal.action)) {
        return this.fail(proposal, decidedBy, 'UNSUPPORTED_ACTION');
      }

      const traveler = this.fixtures.readTraveler();
      if (!traveler.preferences.allowedChannels.includes('push')) {
        return this.fail(proposal, decidedBy, 'CHANNEL_NOT_ALLOWED');
      }
      if (
        !required &&
        this.policy.isQuietHours(
          this.clock.now(),
          traveler.timeZone,
          traveler.preferences.quietHours.start,
          traveler.preferences.quietHours.end,
        )
      ) {
        return this.fail(proposal, decidedBy, 'QUIET_HOURS');
      }

      if (
        proposal.candidateIds.some((id) => id === 'search-1') &&
        this.fixtures.hotelIsBooked()
      ) {
        return {
          ok: true,
          outcome: {
            candidates: proposal.candidateIds,
            outcome: 'silent',
            reason: 'HOTEL_ALREADY_BOOKED',
            decidedBy: 'application',
          },
        };
      }

      const body = this.renderNotification(proposal);
      const sourceVersion = (proposal.factIds ?? []).slice().sort().join('+');
      const deliveryKey = `${this.fixtures.getActiveScenario().trip.id}:${purpose}:${sourceVersion}`;

      return {
        ok: true,
        outcome: {
          candidates: proposal.candidateIds,
          outcome: 'act_now',
          reason:
            purpose === 'flight_change'
              ? 'REQUIRED_FLIGHT_ALERT'
              : 'COMBINED_TRIP_PREPARATION',
          decidedBy,
          deliveryKey,
          notificationPreview: {
            channel: 'push',
            templateId: proposal.templateId,
            body,
            action: proposal.action,
            factIds: proposal.factIds ?? [],
          },
        },
      };
    }

    if (proposal.decision === 'wait') {
      const trip = this.fixtures.readTrip(
        this.fixtures.getActiveScenario().trip.id,
      );
      let recheckAt = proposal.recheckAt;
      if (!recheckAt && proposal.candidateIds.includes('route-1')) {
        recheckAt = this.policy.formatWithOffset(
          this.policy.arrivalGuidanceWindowStart(trip.arrivalAt),
          trip.destinationTimeZone,
        );
      }
      if (!recheckAt) {
        return this.fail(proposal, decidedBy, 'WAIT_MISSING_RECHECK_AT');
      }
      const when = Date.parse(recheckAt);
      const now = this.clock.now().getTime();
      const arrival = Date.parse(trip.arrivalAt);
      if (Number.isNaN(when) || when <= now) {
        return this.fail(proposal, decidedBy, 'WAIT_NOT_IN_FUTURE');
      }
      if (when >= arrival) {
        return this.fail(proposal, decidedBy, 'WAIT_NOT_USEFUL_BEFORE_ARRIVAL');
      }
      return {
        ok: true,
        outcome: {
          candidates: proposal.candidateIds,
          outcome: 'wait',
          reason: 'ARRIVAL_GUIDANCE_NOT_DUE',
          recheckAt,
          decidedBy: 'application',
        },
      };
    }

    return {
      ok: true,
      outcome: {
        candidates: proposal.candidateIds,
        outcome: 'silent',
        reason: 'NOTHING_USEFUL',
        decidedBy,
      },
    };
  }

  renderNotification(proposal: ModelProposal): string {
    const trip = this.fixtures.readTrip(
      this.fixtures.getActiveScenario().trip.id,
    );
    if (proposal.templateId === 'flight_change_confirmed') {
      const flight = this.fixtures.getFlightEvidence() as
        | { arrivalAt?: string }
        | undefined;
      const arrival = flight?.arrivalAt ?? trip.arrivalAt;
      return `Your flight to ${trip.destination} now arrives at ${this.shortTime(arrival)}. View flight details.`;
    }

    const facts = new Set(proposal.factIds ?? []);
    const chunks: string[] = [];
    if (facts.has('flight-status-v1') || facts.has('flight-status-v2')) {
      const flight = this.fixtures.readEvidenceById(
        facts.has('flight-status-v2') ? 'flight-status-v2' : 'flight-status-v1',
      ) as { checkInOpen?: boolean } | undefined;
      if (flight?.checkInOpen) {
        chunks.push('Check-in is open');
      }
    }
    if (facts.has('weather-v1')) {
      chunks.push('rain is expected');
    }

    let middle = '';
    if (chunks.length === 1) {
      middle = ` ${chunks[0]}, and`;
      // Prefer brief wording from the brief when both facts present
    }
    if (chunks.length >= 2) {
      return `Your Boston trip is tomorrow. Check-in is open, and rain is expected. View your trip plan.`;
    }
    if (chunks.length === 1) {
      return `Your Boston trip is tomorrow. ${chunks[0]}. View your trip plan.`;
    }
    return `Your Boston trip is tomorrow. View your trip plan.${middle}`;
  }

  private shortTime(iso: string): string {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d);
  }

  private fail(
    proposal: ModelProposal,
    decidedBy: ValidationInput['decidedBy'],
    reason: string,
  ): ValidationResult {
    return {
      ok: false,
      reason,
      outcome: {
        candidates: proposal.candidateIds,
        outcome: 'failure',
        reason,
        decidedBy,
      },
    };
  }
}
