import type {
  AccessCodeLaunchActor,
  AssignmentPolicySnapshot,
  AuthoritativeAttemptSessionState,
  AttemptStatus,
} from "@harbor/attempt-protocol";

import { ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER } from "../attempts/attempt-durable-object";
import { parseStoredAssignmentPolicySnapshotRequired } from "../routes/assignment-request-parsers";
import { parseStoredDeliveryPolicy } from "../delivery/delivery-policy";
import {
  createAttemptEntry,
  type AttemptContext,
  LaunchRequestError,
} from "./create-preview-attempt";

const textEncoder = new TextEncoder();

export interface IssuedAccessCode {
  accessCodeId: string;
  accessCode: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  expiresAt: string | null;
}

export async function issueAccessCode(input: {
  db: D1Database;
  assignmentId?: string;
  assessmentVersionId?: string;
  assessmentId?: string;
  code?: string;
  expiresAt?: string | null;
}): Promise<IssuedAccessCode> {
  const resolvedTarget = await resolveAccessCodeTarget(input);

  const accessCode = normalizeAccessCode(input.code ?? buildGeneratedAccessCode());
  const expiresAt = input.expiresAt ?? null;
  const accessCodeId = createId("acode");

  try {
    await input.db
      .prepare(
        "INSERT INTO access_codes (id, assessment_version_id, assignment_id, code_sha256, code_last4, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        accessCodeId,
        resolvedTarget.assessmentVersionId,
        resolvedTarget.assignmentId,
        await sha256Hex(textEncoder.encode(accessCode)),
        accessCode.slice(-4),
        "active",
        expiresAt,
        new Date().toISOString(),
      )
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new LaunchRequestError(409, "Access code already exists");
    }

    throw error;
  }

  return {
    accessCodeId,
    accessCode,
    assessmentVersionId: resolvedTarget.assessmentVersionId,
    assignmentId: resolvedTarget.assignmentId,
    expiresAt,
  };
}

export async function createCodeAttempt(input: {
  db: D1Database;
  bucket: R2Bucket;
  attemptCoordinator: DurableObjectNamespace;
  accessCode: string;
  assessmentVersionId?: string;
  actor: AccessCodeLaunchActor;
}): Promise<AttemptContext> {
  const accessCode = normalizeAccessCode(input.accessCode);
  const record = await input.db
    .prepare(
      "SELECT codes.id, codes.assessment_version_id, codes.assignment_id, codes.status, codes.expires_at, assignments.status AS assignment_status, assignments.policy_snapshot_json FROM access_codes codes LEFT JOIN assignments ON assignments.id = codes.assignment_id WHERE code_sha256 = ?",
    )
    .bind(await sha256Hex(textEncoder.encode(accessCode)))
    .first<{
      id: string;
      assessment_version_id: string;
      assignment_id: string | null;
      status: string;
      expires_at: string | null;
      assignment_status: string | null;
      policy_snapshot_json: string | null;
    }>();

  if (!record) {
    throw new LaunchRequestError(404, "Access code not found");
  }

  if (record.status !== "active") {
    throw new LaunchRequestError(403, "Access code is not active");
  }

  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
    throw new LaunchRequestError(403, "Access code has expired");
  }

  if (input.assessmentVersionId && input.assessmentVersionId !== record.assessment_version_id) {
    throw new LaunchRequestError(
      403,
      "Access code does not match the requested assessment version",
    );
  }

  const assignmentPolicy = record.assignment_id
    ? parseStoredAssignmentPolicySnapshotRequired(
        record.policy_snapshot_json,
        "Assignment-linked access code is missing its policy snapshot",
      )
    : null;
  if (record.assignment_id) {
    if (record.assignment_status !== "active") {
      throw new LaunchRequestError(403, "Assignment is not active");
    }

    enforceAssignmentAvailability(assignmentPolicy!);
  }

  const reusableAttempt = await findReusableAttempt({
    db: input.db,
    attemptCoordinator: input.attemptCoordinator,
    accessCodeId: record.id,
    assignmentId: record.assignment_id,
    assessmentVersionId: record.assessment_version_id,
    actor: input.actor,
  });
  if (reusableAttempt) {
    return reusableAttempt;
  }

  if (record.assignment_id && assignmentPolicy) {
    await enforceRemainingAttempts({
      db: input.db,
      assignmentId: record.assignment_id,
      actor: input.actor,
      maxAttempts: assignmentPolicy.maxAttempts,
    });
  }

  return createAttemptEntry({
    db: input.db,
    bucket: input.bucket,
    assessmentVersionId: record.assessment_version_id,
    accessCodeId: record.id,
    assignmentId: record.assignment_id,
    launch: {
      mode: "access-code",
      actor: input.actor,
    },
    launchSnapshot: {
      launchMode: "access-code",
      sourceAccessCodeId: record.id,
      assignmentId: record.assignment_id,
      actor: input.actor,
      launchedAt: new Date().toISOString(),
    },
  });
}

function buildGeneratedAccessCode(): string {
  return `HBR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function normalizeAccessCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    throw new LaunchRequestError(400, "Access code must not be empty");
  }

  return normalized;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("unique constraint") || message.includes("constraint failed");
}

async function findReusableAttempt(input: {
  db: D1Database;
  attemptCoordinator: DurableObjectNamespace;
  accessCodeId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  actor: AccessCodeLaunchActor;
}): Promise<AttemptContext | null> {
  const candidateAttempts = await loadCandidateAttempts(input);

  for (const candidate of candidateAttempts) {
    const session = await readAuthoritativeSession({
      attemptCoordinator: input.attemptCoordinator,
      attemptId: candidate.id,
    });

    if (!isResumableAttemptStatus(session.attemptStatus)) {
      continue;
    }

    return {
      attemptId: candidate.id,
      assessmentVersionId: candidate.assessment_version_id,
      deliveryPolicy: parseStoredDeliveryPolicy(candidate.delivery_policy_snapshot),
      manifest: {
        manifestObjectKey: candidate.manifest_object_key,
      },
      currentItemRef: {
        itemId: candidate.current_item_id,
        itemHref: candidate.current_item_href,
      },
      launch: {
        mode: "access-code",
        actor: input.actor,
      },
    };
  }

  return null;
}

async function loadCandidateAttempts(input: {
  db: D1Database;
  accessCodeId: string;
  assignmentId: string | null;
  actor: AccessCodeLaunchActor;
}): Promise<
  Array<{
    id: string;
    assessment_version_id: string;
    delivery_policy_snapshot: string;
    manifest_object_key: string;
    current_item_id: string;
    current_item_href: string;
  }>
> {
  const queryParts = [
    "SELECT id, assessment_version_id, delivery_policy_snapshot, manifest_object_key, current_item_id, current_item_href",
    "FROM attempt_entries",
    input.assignmentId ? "WHERE assignment_id = ?" : "WHERE access_code_id = ?",
    "AND launch_mode = ?",
    "AND actor_kind = ?",
  ];
  const bindings: Array<string> = [
    input.assignmentId ?? input.accessCodeId,
    "access-code",
    input.actor.kind,
  ];

  if (input.actor.id) {
    queryParts.push("AND actor_id = ?");
    bindings.push(input.actor.id);
  } else {
    queryParts.push("AND actor_id IS NULL");

    if (input.actor.displayName) {
      queryParts.push("AND actor_display_name = ?");
      bindings.push(input.actor.displayName);
    } else {
      queryParts.push("AND actor_display_name IS NULL");
    }
  }

  queryParts.push("ORDER BY created_at DESC");
  queryParts.push("LIMIT 5");

  const result = await input.db
    .prepare(queryParts.join(" "))
    .bind(...bindings)
    .all<{
      id: string;
      assessment_version_id: string;
      delivery_policy_snapshot: string;
      manifest_object_key: string;
      current_item_id: string;
      current_item_href: string;
    }>();

  return result.results;
}

async function resolveAccessCodeTarget(input: {
  db: D1Database;
  assignmentId?: string;
  assessmentVersionId?: string;
  assessmentId?: string;
}): Promise<{
  assessmentVersionId: string;
  assignmentId: string | null;
}> {
  if (input.assignmentId) {
    const assignment = await input.db
      .prepare("SELECT id, assessment_version_id FROM assignments WHERE id = ?")
      .bind(input.assignmentId)
      .first<{
        id: string;
        assessment_version_id: string;
      }>();

    if (!assignment) {
      throw new LaunchRequestError(404, "Assignment not found");
    }

    return {
      assessmentVersionId: assignment.assessment_version_id,
      assignmentId: assignment.id,
    };
  }

  if (input.assessmentVersionId) {
    const publishedVersion = await input.db
      .prepare("SELECT id FROM assessment_versions WHERE id = ?")
      .bind(input.assessmentVersionId)
      .first<{ id: string }>();

    if (!publishedVersion) {
      throw new LaunchRequestError(404, "Published assessment version not found");
    }

    return {
      assessmentVersionId: publishedVersion.id,
      assignmentId: null,
    };
  }

  if (!input.assessmentId) {
    throw new LaunchRequestError(400, "assessmentVersionId or assessmentId is required");
  }

  const activatedVersion = await input.db
    .prepare(
      "SELECT assessment_version_id FROM assessment_version_activations WHERE assessment_id = ? ORDER BY activated_at DESC, created_at DESC LIMIT 1",
    )
    .bind(input.assessmentId)
    .first<{ assessment_version_id: string }>();

  if (activatedVersion?.assessment_version_id) {
    return {
      assessmentVersionId: activatedVersion.assessment_version_id,
      assignmentId: null,
    };
  }

  const latestPublishedVersion = await input.db
    .prepare(
      "SELECT id FROM assessment_versions WHERE assessment_id = ? ORDER BY version_number DESC, created_at DESC LIMIT 1",
    )
    .bind(input.assessmentId)
    .first<{ id: string }>();

  if (!latestPublishedVersion) {
    throw new LaunchRequestError(
      404,
      "Published assessment version not found for the requested assessment",
    );
  }

  return {
    assessmentVersionId: latestPublishedVersion.id,
    assignmentId: null,
  };
}

async function readAuthoritativeSession(input: {
  attemptCoordinator: DurableObjectNamespace;
  attemptId: string;
}): Promise<AuthoritativeAttemptSessionState> {
  const stub = input.attemptCoordinator.get(input.attemptCoordinator.idFromName(input.attemptId));
  const response = await stub.fetch("https://harbor-attempt.local/session", {
    method: "GET",
    headers: {
      [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: input.attemptId,
    },
  });

  if (!response.ok) {
    const payload = await response.json<{ error?: string }>().catch(() => ({ error: undefined }));
    throw new LaunchRequestError(
      response.status,
      payload.error ?? "Unable to inspect attempt state for relaunch reuse",
    );
  }

  return response.json<AuthoritativeAttemptSessionState>();
}

function isResumableAttemptStatus(status: AttemptStatus): boolean {
  return (
    status === "active" ||
    status === "soft_closed" ||
    status === "accepting_late_within_grace" ||
    status === "reopened"
  );
}

function enforceAssignmentAvailability(policy: AssignmentPolicySnapshot): void {
  const now = Date.now();
  if (policy.availableFrom && Date.parse(policy.availableFrom) > now) {
    throw new LaunchRequestError(403, "Assignment is not yet available");
  }

  if (policy.availableUntil && Date.parse(policy.availableUntil) < now) {
    throw new LaunchRequestError(403, "Assignment is no longer available");
  }
}

async function enforceRemainingAttempts(input: {
  db: D1Database;
  assignmentId: string;
  actor: AccessCodeLaunchActor;
  maxAttempts: number;
}): Promise<void> {
  const queryParts = [
    "SELECT COUNT(*) AS count",
    "FROM attempt_entries",
    "WHERE assignment_id = ?",
    "AND launch_mode = ?",
    "AND actor_kind = ?",
  ];
  const bindings: Array<string | number> = [input.assignmentId, "access-code", input.actor.kind];

  if (input.actor.id) {
    queryParts.push("AND actor_id = ?");
    bindings.push(input.actor.id);
  } else {
    queryParts.push("AND actor_id IS NULL");
    if (input.actor.displayName) {
      queryParts.push("AND actor_display_name = ?");
      bindings.push(input.actor.displayName);
    } else {
      queryParts.push("AND actor_display_name IS NULL");
    }
  }

  const row = await input.db
    .prepare(queryParts.join(" "))
    .bind(...bindings)
    .first<{ count: number }>();

  if ((row?.count ?? 0) >= input.maxAttempts) {
    throw new LaunchRequestError(403, "No remaining attempts are available for this assignment");
  }
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
