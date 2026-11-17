import type {
  AttemptEventCommitResponse,
  AttemptEventType,
  AttemptPolicyActorRole,
  AttemptStatus,
  OperatorAttemptActionType,
} from "@harbor/attempt-protocol";

export const ATTEMPT_RUNTIME_METRICS_DATASET = "ATTEMPT_RUNTIME_METRICS";
export const ATTEMPT_RUNTIME_METRIC_INDEX_LABELS = ["attemptId"] as const;
export const ATTEMPT_RUNTIME_METRIC_BLOB_LABELS = [
  "route",
  "family",
  "eventType",
  "outcome",
  "attemptStatus",
  "graceWindow",
  "actorRole",
] as const;
export const ATTEMPT_RUNTIME_METRIC_DOUBLE_LABELS = [
  "latencyMs",
  "sequenceNumber",
  "highestCommittedSequence",
] as const;

export type AttemptRuntimeMetricRoute = "attempt-events" | "operator-actions" | "submit-queue";

export type AttemptRuntimeMetricFamily = "commit" | "submit" | "override" | "submit_finalization";

export type AttemptRuntimeGraceWindow = "standard" | "within_grace" | "not_applicable";

export type AttemptRuntimeActorRole = "candidate" | AttemptPolicyActorRole | "none";

export interface AttemptRuntimeMetric {
  attemptId: string;
  route: AttemptRuntimeMetricRoute;
  family: AttemptRuntimeMetricFamily;
  eventType: string;
  outcome: string;
  attemptStatus: AttemptStatus;
  graceWindow: AttemptRuntimeGraceWindow;
  actorRole: AttemptRuntimeActorRole;
  latencyMs: number;
  sequenceNumber: number;
  highestCommittedSequence: number;
}

interface AttemptRuntimeMetricsEnv {
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
}

export function buildAttemptEventMetric(input: {
  attemptId: string;
  eventType: AttemptEventType;
  latencyMs: number;
  response: AttemptEventCommitResponse;
}): AttemptRuntimeMetric {
  return {
    attemptId: input.attemptId,
    route: "attempt-events",
    family: input.eventType === "submit.requested" ? "submit" : "commit",
    eventType: input.eventType,
    outcome: input.response.outcome,
    attemptStatus: input.response.attemptStatus,
    graceWindow: resolveGraceWindow(input.response.attemptStatus),
    actorRole: "candidate",
    latencyMs: input.latencyMs,
    sequenceNumber:
      input.response.outcome === "accepted"
        ? input.response.acceptedSequenceNumber
        : input.response.requestedSequenceNumber,
    highestCommittedSequence: input.response.highestCommittedSequence,
  };
}

export function buildOverrideMetric(input: {
  attemptId: string;
  actionType: OperatorAttemptActionType;
  actorRole: AttemptPolicyActorRole;
  attemptStatus: AttemptStatus;
  latencyMs: number;
  overlayRevision: number;
}): AttemptRuntimeMetric {
  return {
    attemptId: input.attemptId,
    route: "operator-actions",
    family: "override",
    eventType: input.actionType,
    outcome: "applied",
    attemptStatus: input.attemptStatus,
    graceWindow: "not_applicable",
    actorRole: input.actorRole,
    latencyMs: input.latencyMs,
    sequenceNumber: input.overlayRevision,
    highestCommittedSequence: input.overlayRevision,
  };
}

export function buildSubmitFinalizationMetric(input: {
  attemptId: string;
  outcome: "queued" | "consumed" | "failed";
  latencyMs: number;
  acceptedSequenceNumber: number;
}): AttemptRuntimeMetric {
  return {
    attemptId: input.attemptId,
    route: "submit-queue",
    family: "submit_finalization",
    eventType: "submit.finalization",
    outcome: input.outcome,
    attemptStatus: "submitted",
    graceWindow: "not_applicable",
    actorRole: "system",
    latencyMs: input.latencyMs,
    sequenceNumber: input.acceptedSequenceNumber,
    highestCommittedSequence: input.acceptedSequenceNumber,
  };
}

export function toAnalyticsEnginePoint(metric: AttemptRuntimeMetric): AnalyticsEngineDataPoint {
  return {
    indexes: [metric.attemptId],
    blobs: [
      metric.route,
      metric.family,
      metric.eventType,
      metric.outcome,
      metric.attemptStatus,
      metric.graceWindow,
      metric.actorRole,
    ],
    doubles: [metric.latencyMs, metric.sequenceNumber, metric.highestCommittedSequence],
  };
}

export function createAttemptRuntimeLog(metric: AttemptRuntimeMetric): Record<string, unknown> {
  return {
    dataset: ATTEMPT_RUNTIME_METRICS_DATASET,
    ...metric,
  };
}

export function recordAttemptRuntimeMetric(
  env: AttemptRuntimeMetricsEnv,
  metric: AttemptRuntimeMetric,
): void {
  env.ATTEMPT_RUNTIME_METRICS.writeDataPoint(toAnalyticsEnginePoint(metric));
  console.log(JSON.stringify(createAttemptRuntimeLog(metric)));
}

function resolveGraceWindow(attemptStatus: AttemptStatus): AttemptRuntimeGraceWindow {
  if (attemptStatus === "accepting_late_within_grace") {
    return "within_grace";
  }

  if (attemptStatus === "active" || attemptStatus === "soft_closed") {
    return "standard";
  }

  return "not_applicable";
}
