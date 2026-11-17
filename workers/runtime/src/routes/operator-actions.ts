import { parseCandidateResponseCheckpoint } from "@harbor/attempt-protocol";
import type {
  ActivateAssessmentVersionRequest,
  AssessmentVersionActivationRecord,
  AttemptAccommodationSnapshotEvidence,
  AttemptAccommodationTimingEvidence,
  AttemptPolicyActorRole,
  AttemptPolicyReadResponse,
  AttemptTimelineActorSnapshot,
  AttemptTimelineEntry,
  AttemptTimelineEventType,
  AttemptTimelineResponse,
  BatchOperatorAttemptActionRequest,
  OperatorAttemptActionType,
  OperatorAttemptActionRequest,
} from "@harbor/attempt-protocol";
import {
  buildAttemptAccommodationEvidenceSummary,
  createDefaultAccommodationTimingEvidence,
} from "@harbor/attempt-protocol";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import {
  readAssignmentActor,
  readJsonObject,
  readOptionalString,
  readRequiredString,
} from "./route-request-utils";
import type { AppContext } from "./hono-utils";
import { readAssessmentIdParam, readAttemptIdParam } from "./route-params";
import {
  buildOverrideMetric,
  recordAttemptRuntimeMetric,
} from "../observability/attempt-runtime-metrics";

const ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER = "x-harbor-attempt-id";

interface OperatorActionsEnv {
  HARBOR_DB: D1Database;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
}

export async function handlePostOperatorAttemptActionRequest(c: AppContext): Promise<Response> {
  return postOperatorAttemptAction({
    env: c.env,
    attemptId: readAttemptIdParam(c),
    request: c.req.raw,
  });
}

export async function postOperatorAttemptAction(input: {
  env: OperatorActionsEnv;
  attemptId: string;
  request: Request;
}): Promise<Response> {
  const applied = await postOperatorAttemptActionToAttempt(
    input.env,
    input.attemptId,
    input.request,
  );
  return Response.json(applied, { status: 200 });
}

export async function handlePostOperatorAttemptActionBatchRequest(
  c: AppContext,
): Promise<Response> {
  return postOperatorAttemptActionBatch({
    env: c.env,
    request: c.req.raw,
  });
}

export async function postOperatorAttemptActionBatch(input: {
  env: OperatorActionsEnv;
  request: Request;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const batch = readBatchOperatorAttemptActionRequest(body);
  const results: AttemptPolicyReadResponse[] = [];

  for (const attemptId of batch.attemptIds) {
    const startedAt = performance.now();
    const applied = await applyOperatorActionToAttempt({
      env: input.env,
      attemptId,
      action: batch.action,
    });
    recordOverrideTelemetry({
      env: input.env,
      attemptId,
      actionType: batch.action.type,
      actorRole: batch.action.actor.role,
      attemptStatus: applied.attemptStatus,
      overlayRevision: applied.policy.overlayRevision,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    results.push(applied);
  }

  return Response.json({ results }, { status: 200 });
}

export async function handleGetOperatorAttemptTimelineRequest(c: AppContext): Promise<Response> {
  return getOperatorAttemptTimeline({
    env: c.env,
    attemptId: readAttemptIdParam(c),
  });
}

export async function getOperatorAttemptTimeline(input: {
  env: OperatorActionsEnv;
  attemptId: string;
}): Promise<Response> {
  const stub = input.env.ATTEMPT_COORDINATOR.get(
    input.env.ATTEMPT_COORDINATOR.idFromName(input.attemptId),
  );
  const response = await stub.fetch("https://harbor-attempt.local/session", {
    headers: { [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: input.attemptId },
  });
  if (!response.ok) throw new LaunchRequestError(response.status, "Unable to read recovery status");
  const session: unknown = await response.json();
  if (!session || typeof session !== "object")
    throw new LaunchRequestError(502, "Invalid recovery status");
  const checkpoint = parseCandidateResponseCheckpoint(
    "responseCheckpoint" in session ? session.responseCheckpoint : undefined,
  );
  return Response.json(
    {
      ...(await readAttemptTimeline(input.env.HARBOR_DB, input.attemptId)),
      recovery: {
        lastConfirmedSaveAt: checkpoint?.serverTimestamp ?? null,
        acceptedResponseSequence: checkpoint?.acceptedSequenceNumber ?? null,
      },
    },
    { status: 200 },
  );
}

export async function handlePostActivateAssessmentVersionRequest(c: AppContext): Promise<Response> {
  return postActivateAssessmentVersion({
    env: c.env,
    assessmentId: readAssessmentIdParam(c),
    request: c.req.raw,
  });
}

export async function postActivateAssessmentVersion(input: {
  env: OperatorActionsEnv;
  assessmentId: string;
  request: Request;
}): Promise<Response> {
  const activation = await activateAssessmentVersion({
    db: input.env.HARBOR_DB,
    assessmentId: input.assessmentId,
    request: await readActivateAssessmentVersionRequest(input.request, input.assessmentId),
  });
  return Response.json(activation, { status: 200 });
}

async function postOperatorAttemptActionToAttempt(
  env: OperatorActionsEnv,
  attemptId: string,
  request: Request,
): Promise<AttemptPolicyReadResponse> {
  const action = await readOperatorAttemptActionRequest(request);
  const startedAt = performance.now();
  const applied = await applyOperatorActionToAttempt({
    env,
    attemptId,
    action,
  });
  recordOverrideTelemetry({
    env,
    attemptId,
    actionType: action.type,
    actorRole: action.actor.role,
    attemptStatus: applied.attemptStatus,
    overlayRevision: applied.policy.overlayRevision,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
  });
  return applied;
}

export async function appendAttemptTimelineEvent(input: {
  db: D1Database;
  id?: string;
  attemptId: string;
  eventType: AttemptTimelineEventType;
  summary: Record<string, unknown>;
  sequenceNumber?: number | null;
  actor?: AttemptTimelineActorSnapshot | null;
  reason?: string | null;
  createdAt?: string;
}): Promise<AttemptTimelineEntry> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const entry: AttemptTimelineEntry = {
    id: input.id ?? createId("atline"),
    attemptId: input.attemptId,
    eventType: input.eventType,
    sequenceNumber: input.sequenceNumber ?? null,
    actor: input.actor ?? null,
    reason: input.reason ?? null,
    summary: input.summary,
    createdAt,
  };

  await input.db
    .prepare(
      "INSERT INTO attempt_timeline_events (id, attempt_id, event_type, sequence_number, actor_role, actor_id, actor_display_name, reason, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(
      entry.id,
      entry.attemptId,
      entry.eventType,
      entry.sequenceNumber,
      entry.actor?.role ?? null,
      entry.actor?.actorId ?? null,
      entry.actor?.displayName ?? null,
      entry.reason,
      JSON.stringify(entry.summary),
      entry.createdAt,
    )
    .run();

  return entry;
}

export async function readAttemptTimeline(
  db: D1Database,
  attemptId: string,
): Promise<AttemptTimelineResponse> {
  const result = await db
    .prepare(
      "SELECT id, attempt_id, event_type, sequence_number, actor_role, actor_id, actor_display_name, reason, summary_json, created_at FROM attempt_timeline_events WHERE attempt_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(attemptId)
    .all<{
      id: string;
      attempt_id: string;
      event_type: AttemptTimelineEventType;
      sequence_number: number | null;
      actor_role: AttemptTimelineActorSnapshot["role"] | null;
      actor_id: string | null;
      actor_display_name: string | null;
      reason: string | null;
      summary_json: string;
      created_at: string;
    }>();

  const accommodationSnapshot = await db
    .prepare(
      "SELECT profile_ids_json, learner_assignment_ids_json, assignment_override_id, accommodations_json, shell_tools_json, timing_json, created_at FROM attempt_accommodation_snapshots WHERE attempt_id = ?",
    )
    .bind(attemptId)
    .first<{
      profile_ids_json: string;
      learner_assignment_ids_json: string;
      assignment_override_id: string | null;
      accommodations_json: string;
      shell_tools_json: string;
      timing_json: string;
      created_at: string;
    }>();

  return {
    attemptId,
    entries: result.results.map((row) => ({
      id: row.id,
      attemptId: row.attempt_id,
      eventType: row.event_type,
      sequenceNumber: row.sequence_number,
      actor:
        row.actor_role && row.actor_id
          ? {
              role: row.actor_role,
              actorId: row.actor_id,
              displayName: row.actor_display_name,
            }
          : null,
      reason: row.reason,
      summary: parseSummary(row.summary_json),
      createdAt: row.created_at,
    })),
    accommodationSnapshot: accommodationSnapshot
      ? mapAccommodationSnapshotEvidence(accommodationSnapshot)
      : null,
  };
}

function mapAccommodationSnapshotEvidence(row: {
  profile_ids_json: string;
  learner_assignment_ids_json: string;
  assignment_override_id: string | null;
  accommodations_json: string;
  shell_tools_json: string;
  timing_json: string;
  created_at: string;
}): AttemptAccommodationSnapshotEvidence {
  const profileIds = parseJsonArray(row.profile_ids_json);
  const learnerProfileAssignmentIds = parseJsonArray(row.learner_assignment_ids_json);
  const accommodations = parseJsonRecord(
    row.accommodations_json,
  ) as unknown as AttemptAccommodationSnapshotEvidence["accommodations"];
  const shellTools = parseJsonRecord(
    row.shell_tools_json,
  ) as AttemptAccommodationSnapshotEvidence["shellTools"];
  const timing = parseAccommodationTiming(row.timing_json);
  return {
    profileIds,
    learnerProfileAssignmentIds,
    assignmentOverrideId: row.assignment_override_id,
    accommodations,
    shellTools,
    timing,
    summary: buildAttemptAccommodationEvidenceSummary({
      profileIds,
      learnerProfileAssignmentIds,
      assignmentOverrideId: row.assignment_override_id,
      accommodations,
      shellTools,
      timing,
    }),
    createdAt: row.created_at,
  } as AttemptAccommodationSnapshotEvidence;
}

export async function applyOperatorActionToAttempt(input: {
  env: OperatorActionsEnv;
  attemptId: string;
  action: OperatorAttemptActionRequest;
}): Promise<AttemptPolicyReadResponse> {
  const stub = input.env.ATTEMPT_COORDINATOR.get(
    input.env.ATTEMPT_COORDINATOR.idFromName(input.attemptId),
  );
  const { actionId, ...action } = input.action;
  const command = {
    ...action,
    commandId: `${actionId}:${input.attemptId}`,
    issuedAt: input.action.effectiveAt,
  };

  const response = await stub.fetch("https://harbor-attempt.local/policy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: input.attemptId,
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const payload = await response.json<{ error?: string }>().catch(() => ({ error: undefined }));
    throw new LaunchRequestError(
      response.status,
      payload.error ?? "Unable to apply operator action",
    );
  }

  const applied = await response.json<AttemptPolicyReadResponse>();
  await appendAttemptTimelineEvent({
    db: input.env.HARBOR_DB,
    attemptId: input.attemptId,
    eventType: "override",
    actor: {
      role: input.action.actor.role,
      actorId: input.action.actor.actorId,
      displayName: input.action.actor.displayName,
    },
    reason: input.action.reason,
    summary: {
      actionType: input.action.type,
      overlayRevision: applied.policy.overlayRevision,
    },
    createdAt: input.action.effectiveAt,
  });

  return applied;
}

async function activateAssessmentVersion(input: {
  db: D1Database;
  assessmentId: string;
  request: ActivateAssessmentVersionRequest;
}): Promise<AssessmentVersionActivationRecord> {
  const version = await input.db
    .prepare("SELECT id FROM assessment_versions WHERE id = ? AND assessment_id = ?")
    .bind(input.request.assessmentVersionId, input.assessmentId)
    .first<{ id: string }>();

  if (!version) {
    throw new LaunchRequestError(
      404,
      "Assessment version was not found for the requested assessment",
    );
  }

  const createdAt = new Date().toISOString();
  await input.db
    .prepare(
      "INSERT INTO assessment_version_activations (id, assessment_id, assessment_version_id, actor_role, actor_id, actor_display_name, reason, activated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      input.request.activationId,
      input.assessmentId,
      input.request.assessmentVersionId,
      input.request.actor.role,
      input.request.actor.actorId,
      input.request.actor.displayName,
      input.request.reason,
      input.request.activatedAt,
      createdAt,
    )
    .run();

  return {
    activationId: input.request.activationId,
    assessmentId: input.assessmentId,
    assessmentVersionId: input.request.assessmentVersionId,
    actor: input.request.actor,
    reason: input.request.reason,
    activatedAt: input.request.activatedAt,
    createdAt,
  };
}

async function readActivateAssessmentVersionRequest(
  request: Request,
  assessmentId: string,
): Promise<ActivateAssessmentVersionRequest> {
  const body = await readJsonObject(request);
  return {
    activationId: readRequiredString(body.activationId, "activationId is required"),
    assessmentId,
    assessmentVersionId: readRequiredString(
      body.assessmentVersionId,
      "assessmentVersionId is required",
    ),
    actor: readActor(body.actor),
    reason: readRequiredString(body.reason, "reason is required"),
    activatedAt: readRequiredString(body.activatedAt, "activatedAt is required"),
  };
}

function readBatchOperatorAttemptActionRequest(
  body: Record<string, unknown>,
): BatchOperatorAttemptActionRequest {
  const attemptIdsValue = body.attemptIds;
  if (!Array.isArray(attemptIdsValue) || attemptIdsValue.length === 0) {
    throw new LaunchRequestError(400, "attemptIds must be a non-empty array");
  }

  const attemptIds = attemptIdsValue.map((value) =>
    readRequiredString(value, "attemptIds must contain non-empty strings"),
  );

  return {
    attemptIds,
    action: readOperatorAttemptActionRequestFromObject(
      readRecord(body.action, "action is required"),
    ),
  };
}

async function readOperatorAttemptActionRequest(
  request: Request,
): Promise<OperatorAttemptActionRequest> {
  return readOperatorAttemptActionRequestFromObject(await readJsonObject(request));
}

function readOperatorAttemptActionRequestFromObject(
  body: Record<string, unknown>,
): OperatorAttemptActionRequest {
  const type = readRequiredString(body.type, "type is required");
  const base = {
    actionId: readRequiredString(body.actionId, "actionId is required"),
    type,
    actor: readActor(body.actor),
    reason: readRequiredString(body.reason, "reason is required"),
    effectiveAt: readRequiredString(body.effectiveAt, "effectiveAt is required"),
  };

  if (type === "transfer-workstation") {
    if (
      Object.keys(body).some(
        (key) =>
          !["actionId", "type", "actor", "reason", "effectiveAt", "clientSessionId"].includes(key),
      )
    )
      throw new LaunchRequestError(400, "Unknown workstation transfer field");
    return {
      ...base,
      type,
      clientSessionId: readRequiredString(
        body.clientSessionId,
        "Replacement workstation code is required",
      ),
    };
  }

  if (type === "extend-time") {
    return {
      ...base,
      type,
      additionalTimeSeconds: readNonNegativeInteger(
        body.additionalTimeSeconds,
        "additionalTimeSeconds must be a non-negative integer",
      ),
    };
  }

  if (type === "reopen-attempt") {
    return {
      ...base,
      type,
      reopenUntil: readOptionalString(body.reopenUntil),
    };
  }

  if (type === "post-operator-message") {
    const message = readRecord(body.message, "message is required");
    return {
      ...base,
      type,
      message: {
        level: readRequiredString(message.level, "message.level is required") as
          | "info"
          | "warning"
          | "critical",
        title: readRequiredString(message.title, "message.title is required"),
        body: readRequiredString(message.body, "message.body is required"),
        effectiveUntil: readOptionalString(message.effectiveUntil),
      },
    };
  }

  throw new LaunchRequestError(400, "Operator action type is not supported");
}

function readNonNegativeInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new LaunchRequestError(400, message);
  }

  return value as number;
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(400, message);
  }

  return value as Record<string, unknown>;
}

function readActor(value: unknown): ActivateAssessmentVersionRequest["actor"] {
  const actor = readAssignmentActor(value);
  if (actor.role === "qflow")
    throw new LaunchRequestError(400, "QFlow cannot issue an operator action");
  return { role: actor.role, actorId: actor.actorId, displayName: actor.displayName };
}

function parseSummary(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseAccommodationTiming(value: string): AttemptAccommodationTimingEvidence {
  const fallback = createDefaultAccommodationTimingEvidence();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }
    const record = parsed as Record<string, unknown>;
    return {
      additionalTimeSeconds:
        typeof record.additionalTimeSeconds === "number" &&
        Number.isFinite(record.additionalTimeSeconds)
          ? Math.max(0, Math.round(record.additionalTimeSeconds))
          : fallback.additionalTimeSeconds,
      effectiveTimeLimitSeconds:
        typeof record.effectiveTimeLimitSeconds === "number" &&
        Number.isFinite(record.effectiveTimeLimitSeconds)
          ? Math.max(0, Math.round(record.effectiveTimeLimitSeconds))
          : null,
      unlimited: typeof record.unlimited === "boolean" ? record.unlimited : fallback.unlimited,
      additionalTestingTime:
        record.additionalTestingTime &&
        typeof record.additionalTestingTime === "object" &&
        !Array.isArray(record.additionalTestingTime)
          ? (record.additionalTestingTime as AttemptAccommodationTimingEvidence["additionalTestingTime"])
          : fallback.additionalTestingTime,
      allocationPolicy:
        record.allocationPolicy === "whole-assessment" ||
        record.allocationPolicy === "even-split" ||
        record.allocationPolicy === "proportional-split"
          ? record.allocationPolicy
          : fallback.allocationPolicy,
    };
  } catch {
    return fallback;
  }
}

function recordOverrideTelemetry(input: {
  env: Pick<OperatorActionsEnv, "ATTEMPT_RUNTIME_METRICS">;
  attemptId: string;
  actionType: OperatorAttemptActionType;
  actorRole: AttemptPolicyActorRole;
  attemptStatus: AttemptPolicyReadResponse["attemptStatus"];
  overlayRevision: number;
  latencyMs: number;
}): void {
  recordAttemptRuntimeMetric(
    input.env,
    buildOverrideMetric({
      attemptId: input.attemptId,
      actionType: input.actionType,
      actorRole: input.actorRole,
      attemptStatus: input.attemptStatus,
      latencyMs: input.latencyMs,
      overlayRevision: input.overlayRevision,
    }),
  );
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
