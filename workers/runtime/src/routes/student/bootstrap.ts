import { parseCandidateResponseCheckpoint } from "@harbor/attempt-protocol";
import { recordSecureBrowserEvidence } from "../../security/secure-browser-evidence";
import type {
  AttemptPolicyState,
  AttemptPolicyReadResponse,
  AttemptStatus,
  AttemptTimingState,
  AuthoritativeAttemptSessionState,
  BootstrapSequenceState,
  BootstrapPayload,
  CurrentItemRef,
  DeliveryPolicySnapshot,
  DeliveryContextEvaluation,
  LaunchActor,
  LaunchMode,
} from "@harbor/attempt-protocol";

import { createEmptyAttemptPolicyState } from "@harbor/attempt-protocol";
import {
  ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER,
  ATTEMPT_COORDINATOR_CLIENT_SESSION_ID_HEADER,
} from "../../attempts/attempt-durable-object";
import {
  deliveryPoliciesEqual,
  parseStoredDeliveryPolicy,
  fingerprintDeliveryPolicy,
} from "../../delivery/delivery-policy";
import { projectCandidateDeliveryPolicy } from "../../delivery/candidate-delivery-policy";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { verifyBootstrapToken } from "../../launch/sign-bootstrap";
import { isUnsafeSafeExamBrowserUserAgentFallbackEnabled } from "../../security/safe-exam-browser";
import { isDeliveryContextError, requireAllowedDeliveryContext } from "../delivery-context";
import { readAttemptAccommodations } from "../instructor/services/json-parsers";
import { appendAttemptTimelineEvent } from "../operator-actions";
import {
  readJsonObject,
  readOptionalString,
  readRequiredStringField,
} from "../route-request-utils";
import type { AppContext } from "../hono-utils";

interface BootstrapEnv {
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET: string;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
}

export async function handleBootstrapRequest(c: AppContext): Promise<Response> {
  return bootstrapStudentAttempt({
    request: c.req.raw,
    env: c.env,
  });
}

export async function bootstrapStudentAttempt(input: {
  request: Request;
  env: BootstrapEnv;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const bootstrapToken = readRequiredStringField(
    body,
    "bootstrapToken",
    "bootstrapToken is required",
  );
  const clientSessionId = readOptionalString(body.clientSessionId, "clientSessionId") ?? undefined;
  const claims = await verifyBootstrapToken({
    secret: input.env.BOOTSTRAP_SIGNING_SECRET,
    token: bootstrapToken,
  });

  const attempt = await input.env.HARBOR_DB.prepare(
    "SELECT id, assessment_version_id, launch_mode, actor_kind, actor_id, actor_display_name, launch_snapshot_json, delivery_policy_snapshot, manifest_object_key, current_item_id, current_item_href FROM attempt_entries WHERE id = ?",
  )
    .bind(claims.attemptId)
    .first<{
      id: string;
      assessment_version_id: string;
      launch_mode: LaunchMode;
      actor_kind: LaunchActor["kind"];
      actor_id: string | null;
      actor_display_name: string | null;
      launch_snapshot_json: string | null;
      delivery_policy_snapshot: string;
      manifest_object_key: string;
      current_item_id: string;
      current_item_href: string;
    }>();

  if (!attempt) {
    throw new LaunchRequestError(404, "Bootstrap token does not reference a launchable attempt");
  }

  const deliveryPolicy = parseStoredDeliveryPolicy(attempt.delivery_policy_snapshot);
  if (
    claims.assessmentVersionId !== attempt.assessment_version_id ||
    claims.manifest.manifestObjectKey !== attempt.manifest_object_key ||
    claims.currentItemRef.itemId !== attempt.current_item_id ||
    claims.currentItemRef.itemHref !== attempt.current_item_href ||
    !deliveryPoliciesEqual(claims.deliveryPolicy, projectCandidateDeliveryPolicy(deliveryPolicy)) ||
    claims.deliveryPolicyFingerprint !== (await fingerprintDeliveryPolicy(deliveryPolicy))
  ) {
    throw new LaunchRequestError(403, "Bootstrap token does not match the pinned attempt context");
  }

  let deliveryContext: DeliveryContextEvaluation;
  try {
    deliveryContext = await requireAllowedDeliveryContext({
      request: input.request,
      deliveryPolicy,
      allowUnsafeSafeExamBrowserUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
        input.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
      ),
    });
  } catch (error: unknown) {
    if (isDeliveryContextError(error))
      await recordSecureBrowserEvidence({
        db: input.env.HARBOR_DB,
        attemptId: attempt.id,
        phase: "bootstrap",
        policy: deliveryPolicy,
        context: error.deliveryContext,
      });
    throw error;
  }
  await recordSecureBrowserEvidence({
    db: input.env.HARBOR_DB,
    attemptId: attempt.id,
    phase: "bootstrap",
    policy: deliveryPolicy,
    context: deliveryContext,
  });
  const session = await readAuthoritativeSession(input.env, attempt.id, clientSessionId);
  const policy = await readAuthoritativePolicy(input.env, attempt.id);
  const payload: BootstrapPayload = {
    attemptId: attempt.id,
    assessmentVersionId: attempt.assessment_version_id,
    deliveryPolicy: projectCandidateDeliveryPolicy(deliveryPolicy),
    deliveryContext,
    policy: policy.policy,
    manifest: {
      manifestObjectKey: attempt.manifest_object_key,
    },
    launch: {
      mode: attempt.launch_mode,
      actor: buildLaunchActor(attempt),
    },
    session: {
      ...(session.responseCheckpoint ? { responseCheckpoint: session.responseCheckpoint } : {}),
      currentItemRef: session.currentItemRef,
      sequence: session.sequence,
      timing: session.timing,
      attemptStatus: session.attemptStatus,
      deliveryPreferences: session.deliveryPreferences,
    },
  };

  if (clientSessionId) {
    await appendAttemptTimelineEvent({
      db: input.env.HARBOR_DB,
      attemptId: attempt.id,
      eventType: "reconnect",
      summary: {
        clientSessionId,
      },
    });
  }

  return Response.json(payload, { status: 200 });
}

async function readAuthoritativeSession(
  env: BootstrapEnv,
  attemptId: string,
  clientSessionId: string | undefined,
): Promise<AuthoritativeAttemptSessionState> {
  const stub = env.ATTEMPT_COORDINATOR.get(env.ATTEMPT_COORDINATOR.idFromName(attemptId));
  const headers: Record<string, string> = {
    [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: attemptId,
  };
  if (clientSessionId) {
    headers[ATTEMPT_COORDINATOR_CLIENT_SESSION_ID_HEADER] = clientSessionId;
  }

  const response = await stub.fetch("https://harbor-attempt.local/session", {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new LaunchRequestError(
      response.status,
      payload.error ?? "Unable to load authoritative attempt session state",
    );
  }

  return parseAuthoritativeSession(await response.json());
}

async function readAuthoritativePolicy(
  env: BootstrapEnv,
  attemptId: string,
): Promise<AttemptPolicyReadResponse> {
  const stub = env.ATTEMPT_COORDINATOR.get(env.ATTEMPT_COORDINATOR.idFromName(attemptId));
  const response = await stub.fetch("https://harbor-attempt.local/policy", {
    method: "GET",
    headers: {
      [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: attemptId,
    },
  });

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new LaunchRequestError(
      response.status,
      payload.error ?? "Unable to load authoritative attempt policy state",
    );
  }

  return parseAttemptPolicyReadResponse(await response.json());
}

async function readErrorPayload(response: Response): Promise<{ error?: string }> {
  try {
    const payload = await response.json();
    const record = readOptionalRecord(payload);
    const error = record ? readOptionalPayloadString(record, "error") : undefined;
    return error ? { error } : {};
  } catch {
    return {};
  }
}

function parseAuthoritativeSession(value: unknown): AuthoritativeAttemptSessionState {
  const record = readRecord(value, "Attempt session response must be a JSON object");
  const checkpoint = parseCandidateResponseCheckpoint(record.responseCheckpoint);
  if (record.responseCheckpoint !== undefined && !checkpoint)
    throw new LaunchRequestError(502, "Invalid response checkpoint");
  return {
    ...(checkpoint ? { responseCheckpoint: checkpoint } : {}),
    currentItemRef: parseCurrentItemRef(record.currentItemRef),
    sequence: parseSequence(record.sequence),
    timing: parseTiming(record.timing),
    attemptStatus: parseAttemptStatus(record.attemptStatus),
    deliveryPreferences: parseDeliveryPreferences(record.deliveryPreferences),
  };
}

function parseDeliveryPreferences(value: unknown) {
  if (value === undefined || value === null) {
    return { keywordTranslationLanguage: null };
  }
  const record = readRecord(value, "deliveryPreferences must be a JSON object");
  return {
    keywordTranslationLanguage: readNullableString(
      record.keywordTranslationLanguage,
      "deliveryPreferences.keywordTranslationLanguage",
    ),
  };
}

function parseAttemptPolicyReadResponse(value: unknown): AttemptPolicyReadResponse {
  const record = readRecord(value, "Attempt policy response must be a JSON object");
  return {
    attemptId: readRequiredPayloadString(record, "attemptId"),
    attemptStatus: parseAttemptStatus(record.attemptStatus),
    timing: parseTiming(record.timing),
    policy: parseAttemptPolicy(record.policy),
  };
}

function parseCurrentItemRef(value: unknown): CurrentItemRef {
  const record = readRecord(value, "currentItemRef must be a JSON object");
  return {
    itemId: readRequiredPayloadString(record, "itemId"),
    itemHref: readRequiredPayloadString(record, "itemHref"),
  };
}

function parseSequence(value: unknown): BootstrapSequenceState {
  const record = readRecord(value, "sequence must be a JSON object");
  return {
    lastAcceptedSequence: readNullableInteger(record.lastAcceptedSequence, "lastAcceptedSequence"),
    nextSequence: readNullableInteger(record.nextSequence, "nextSequence"),
  };
}

function parseTiming(value: unknown): AttemptTimingState {
  const record = readRecord(value, "timing must be a JSON object");
  const timing: AttemptTimingState = {
    startedAt: readNullableString(record.startedAt, "timing.startedAt"),
    expiresAt: readNullableString(record.expiresAt, "timing.expiresAt"),
    remainingTimeSeconds: readNullableNumber(
      record.remainingTimeSeconds,
      "timing.remainingTimeSeconds",
    ),
  };

  const softCloseAt = readNullableOptionalString(record.softCloseAt, "timing.softCloseAt");
  if (softCloseAt !== undefined) {
    timing.softCloseAt = softCloseAt;
  }
  const acceptUntil = readNullableOptionalString(record.acceptUntil, "timing.acceptUntil");
  if (acceptUntil !== undefined) {
    timing.acceptUntil = acceptUntil;
  }
  const effectivePolicyVersion = readOptionalInteger(
    record.effectivePolicyVersion,
    "timing.effectivePolicyVersion",
  );
  if (effectivePolicyVersion !== undefined) {
    timing.effectivePolicyVersion = effectivePolicyVersion;
  }
  const currentItemDurationSeconds = readNullableOptionalNumber(
    record.currentItemDurationSeconds,
    "timing.currentItemDurationSeconds",
  );
  if (currentItemDurationSeconds !== undefined) {
    timing.currentItemDurationSeconds = currentItemDurationSeconds;
  }
  if (record.scopes !== undefined) {
    timing.scopes = readTimingScopes(record.scopes);
  }

  return timing;
}

function readTimingScopes(value: unknown): AttemptTimingState["scopes"] {
  if (!Array.isArray(value)) {
    throw new LaunchRequestError(502, "timing.scopes must be an array");
  }

  return value.map((entry) => {
    const record = readRecord(entry, "timing.scopes entries must be JSON objects");
    return {
      key: readRequiredPayloadString(record, "key"),
      scopeType: readTimingScopeType(record.scopeType),
      identifier: readRequiredPayloadString(record, "identifier"),
      itemId: readNullableOptionalString(record.itemId, "timing scope itemId"),
      status: readTimingScopeStatus(record.status),
      elapsedTimeSeconds: readNumber(record.elapsedTimeSeconds, "timing scope elapsedTimeSeconds"),
      enteredAt: readNullableString(record.enteredAt, "timing scope enteredAt"),
      exitedAt: readNullableString(record.exitedAt, "timing scope exitedAt"),
      deadlineAt: readNullableString(record.deadlineAt, "timing scope deadlineAt"),
      minTimeSeconds: readNullableNumber(record.minTimeSeconds, "timing scope minTimeSeconds"),
      maxTimeSeconds: readNullableNumber(record.maxTimeSeconds, "timing scope maxTimeSeconds"),
      allowLateSubmission: readBoolean(
        record.allowLateSubmission,
        "timing scope allowLateSubmission",
      ),
      unlimited: readBoolean(record.unlimited, "timing scope unlimited"),
    };
  });
}

function parseAttemptPolicy(value: unknown): AttemptPolicyState {
  const record = readRecord(value, "policy must be a JSON object");
  return {
    overlayRevision: readNumber(record.overlayRevision, "policy.overlayRevision"),
    timing: parsePolicyTiming(record.timing),
    reopen: parsePolicyReopen(record.reopen),
    operatorMessage:
      record.operatorMessage === null ? null : parseOperatorMessage(record.operatorMessage),
    accommodations:
      record.accommodations === undefined
        ? createEmptyAttemptPolicyState().accommodations
        : readAttemptAccommodations(record.accommodations),
  };
}

function parsePolicyTiming(value: unknown): AttemptPolicyState["timing"] {
  const record = readRecord(value, "policy.timing must be a JSON object");
  return {
    additionalTimeSeconds: readNumber(
      record.additionalTimeSeconds,
      "policy.timing.additionalTimeSeconds",
    ),
    effectiveTimeLimitSeconds: readNullableNumber(
      record.effectiveTimeLimitSeconds,
      "policy.timing.effectiveTimeLimitSeconds",
    ),
    effectiveSoftCloseAt: readNullableString(
      record.effectiveSoftCloseAt,
      "policy.timing.effectiveSoftCloseAt",
    ),
    effectiveAcceptUntil: readNullableString(
      record.effectiveAcceptUntil,
      "policy.timing.effectiveAcceptUntil",
    ),
  };
}

function parsePolicyReopen(value: unknown): AttemptPolicyState["reopen"] {
  const record = readRecord(value, "policy.reopen must be a JSON object");
  const status = readRequiredPayloadString(record, "status");
  if (status !== "closed" && status !== "reopened") {
    throw new LaunchRequestError(502, "policy.reopen.status is invalid");
  }

  return {
    status,
    reopenedAt: readNullableString(record.reopenedAt, "policy.reopen.reopenedAt"),
    reopenUntil: readNullableString(record.reopenUntil, "policy.reopen.reopenUntil"),
  };
}

function parseOperatorMessage(value: unknown): AttemptPolicyState["operatorMessage"] {
  const record = readRecord(value, "policy.operatorMessage must be a JSON object");
  const level = readRequiredPayloadString(record, "level");
  if (level !== "info" && level !== "warning" && level !== "critical") {
    throw new LaunchRequestError(502, "policy.operatorMessage.level is invalid");
  }

  return {
    messageId: readRequiredPayloadString(record, "messageId"),
    level,
    title: readRequiredPayloadString(record, "title"),
    body: readRequiredPayloadString(record, "body"),
    postedAt: readRequiredPayloadString(record, "postedAt"),
    effectiveUntil: readNullableString(
      record.effectiveUntil,
      "policy.operatorMessage.effectiveUntil",
    ),
  };
}

function parseAttemptStatus(value: unknown): AttemptStatus {
  if (
    value !== "active" &&
    value !== "soft_closed" &&
    value !== "accepting_late_within_grace" &&
    value !== "submitted" &&
    value !== "expired_pending_recovery" &&
    value !== "reopened"
  ) {
    throw new LaunchRequestError(502, "Attempt status is invalid");
  }

  return value;
}

function readTimingScopeType(
  value: unknown,
): NonNullable<AttemptTimingState["scopes"]>[number]["scopeType"] {
  if (
    value !== "assessment-test" &&
    value !== "test-part" &&
    value !== "assessment-section" &&
    value !== "assessment-item-ref" &&
    value !== "item-session"
  ) {
    throw new LaunchRequestError(502, "Timing scope type is invalid");
  }

  return value;
}

function readTimingScopeStatus(
  value: unknown,
): NonNullable<AttemptTimingState["scopes"]>[number]["status"] {
  if (
    value !== "initial" &&
    value !== "interacting" &&
    value !== "suspended" &&
    value !== "closed" &&
    value !== "review" &&
    value !== "solution"
  ) {
    throw new LaunchRequestError(502, "Timing scope status is invalid");
  }

  return value;
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(502, message);
  }

  return value as Record<string, unknown>;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readRequiredPayloadString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new LaunchRequestError(502, `${key} must be a non-empty string`);
  }

  return value.trim();
}

function readOptionalPayloadString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new LaunchRequestError(502, `${key} must be a string`);
  }

  return value.trim() ? value.trim() : undefined;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new LaunchRequestError(502, `${label} must be a string or null`);
  }

  return value;
}

function readNullableOptionalString(value: unknown, label: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readNullableString(value, label);
}

function readNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LaunchRequestError(502, `${label} must be a finite number`);
  }

  return value;
}

function readNullableNumber(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }

  return readNumber(value, label);
}

function readNullableOptionalNumber(value: unknown, label: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readNullableNumber(value, label);
}

function readOptionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LaunchRequestError(502, `${label} must be an integer`);
  }

  return value;
}

function readNullableInteger(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LaunchRequestError(502, `${label} must be an integer or null`);
  }

  return value;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new LaunchRequestError(502, `${label} must be a boolean`);
  }

  return value;
}

function buildLaunchActor(input: {
  actor_kind: LaunchActor["kind"];
  actor_id: string | null;
  actor_display_name: string | null;
  launch_snapshot_json: string | null;
}): LaunchActor {
  if (input.actor_kind !== "student-learner") {
    return {
      kind: input.actor_kind,
      id: input.actor_id,
      displayName: input.actor_display_name,
    };
  }

  if (!input.actor_id) {
    throw new LaunchRequestError(500, "Student attempt is missing its pinned learner identity");
  }

  const snapshot = parseLaunchSnapshot(input.launch_snapshot_json);
  const snapshotActor =
    snapshot && typeof snapshot.actor === "object" && snapshot.actor !== null
      ? (snapshot.actor as Record<string, unknown>)
      : null;

  return {
    kind: "student-learner",
    learnerId: readSnapshotString(snapshotActor, "learnerId") ?? input.actor_id,
    sessionId: readSnapshotString(snapshot, "sessionId"),
    id: input.actor_id,
    displayName: readSnapshotString(snapshotActor, "displayName") ?? input.actor_display_name,
  };
}

function parseLaunchSnapshot(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readSnapshotString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) {
    return null;
  }

  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
