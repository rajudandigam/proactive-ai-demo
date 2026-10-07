import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ApplicationResult } from '../src/demo/schemas';
import { writeJson } from '../src/playground/artifact-writer';
import {
  boundedRedact,
  collectProvenance,
  finalizeNativeBundle,
  type NativeBundleGate,
} from '../src/playground/native-bundle';

const ALLOWED_DECISION_FIELDS = [
  'candidateIds',
  'decision',
  'reasonCode',
  'reasonSummary',
  'action',
  'templateId',
  'factIds',
  'messagePurpose',
  'recheckAt',
] as const;

export function allowlistModelDecisions(
  result: ApplicationResult,
): unknown[] | undefined {
  const decisions = result.modelDecisionSet?.decisions;
  if (!decisions?.length) return undefined;
  return decisions.map((d) => {
    const row: Record<string, unknown> = {};
    for (const key of ALLOWED_DECISION_FIELDS) {
      if (key in d) row[key] = d[key as keyof typeof d];
    }
    return row;
  });
}

export function extractUnsupportedAction(
  result: ApplicationResult,
): Record<string, unknown> | undefined {
  const failure = result.decisions.find(
    (d) => d.outcome === 'failure' && d.reason === 'UNSUPPORTED_ACTION',
  );
  if (!failure) return undefined;
  return {
    reason: failure.reason,
    outcome: failure.outcome,
    candidates: failure.candidates,
    allowlistedProposals: allowlistModelDecisions(result),
  };
}

export type LiveEvalFailurePacket = {
  schemaVersion: 'proactive-ai-demo/live-eval-failure/1';
  recordedAt: string;
  case: string;
  ok: false;
  category: string;
  detail?: string;
  error?: string;
  /** Preallocated before provider work; present on every failure path. */
  executionId?: string;
  agentInspectRunId?: string;
  tracePath?: string;
  application: {
    runStatus?: string;
    modelMode?: string;
    modelCalls?: number;
    outboxWrites?: number;
    failureReason?: string;
    accounting?: ApplicationResult['accounting'];
    decisions?: Array<{ outcome: string; reason: string }>;
    allowlistedProposals?: unknown[];
  };
  unsupportedAction?: Record<string, unknown>;
  contractSummary?: unknown;
};

/**
 * Finalize a self-contained, locally reviewable native bundle for a live-eval
 * failure (returned failure or thrown exception). The bundle is a closed file
 * set; checksums and the verification report are written outside it.
 *
 * Live/provider evidence stays separate from offline fixture results and the
 * pack is local/UNSAFE until sharing checks actually pass.
 */
export function writeLiveFailureBundle(opts: {
  recordingsDir: string;
  packet: LiveEvalFailurePacket;
  executionId: string;
  request: unknown;
  tracePath?: string | null;
  profileId?: string;
}): { bundleDir: string; gate: NativeBundleGate } {
  const profileId = opts.profileId ?? 'live-model';
  const bundleDir = join(
    opts.recordingsDir,
    'live-eval-bundles',
    `${opts.packet.case}-${opts.executionId}`,
  );
  mkdirSync(bundleDir, { recursive: true });

  const packet: LiveEvalFailurePacket = {
    ...opts.packet,
    executionId: opts.executionId,
    detail:
      opts.packet.detail === undefined
        ? undefined
        : boundedRedact(opts.packet.detail),
    error:
      opts.packet.error === undefined
        ? undefined
        : boundedRedact(opts.packet.error),
    tracePath: undefined,
  };

  let hasTrace = false;
  if (opts.tracePath && existsSync(opts.tracePath)) {
    copyFileSync(opts.tracePath, join(bundleDir, 'trace.jsonl'));
    hasTrace = true;
  }

  writeJson(bundleDir, 'failure-packet.json', packet);
  writeJson(bundleDir, 'input.safe.json', { case: packet.case, request: opts.request });
  writeJson(bundleDir, 'output.safe.json', {
    runStatus: packet.application.runStatus ?? 'failed',
    thrown: packet.error !== undefined && packet.application.runStatus === undefined,
    application: packet.application,
    unsupportedAction: packet.unsupportedAction,
  });
  writeJson(bundleDir, 'oracle.json', {
    case: packet.case,
    ok: false,
    category: packet.category,
    detail: packet.detail,
    proposalSummary: packet.application.allowlistedProposals ?? null,
    method: 'live-eval invariant check',
  });
  writeJson(bundleDir, 'contract-summary.json', packet.contractSummary ?? {
    status: 'skipped',
    reason: hasTrace ? 'not evaluated' : 'no trace file',
  });
  writeJson(bundleDir, 'result.json', {
    executionId: opts.executionId,
    agentInspectRunId: packet.agentInspectRunId ?? null,
    case: packet.case,
    overallVerdict: 'fail',
    category: packet.category,
    sourceKind: 'live-model-execution',
  });

  const gate = finalizeNativeBundle({
    bundleDir,
    scenarioId: packet.case,
    profileId,
    provenance: collectProvenance({
      executionId: opts.executionId,
      agentInspectRunId: hasTrace ? packet.agentInspectRunId ?? null : null,
      scenarioPayload: { case: packet.case, request: opts.request },
      oracleExpected: { case: packet.case, check: 'live-eval-invariant' },
      config: { profileId, mode: 'live' },
    }),
    note: 'Live-eval failure pack — local-only; not share-checked.',
  });
  return { bundleDir, gate };
}
