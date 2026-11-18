import type {
  CreateAssignmentRequest,
  QflowAssignmentIntent,
  QflowHandoffRequest,
} from "@harbor/attempt-protocol";
import { issueAccessCode, type IssuedAccessCode } from "../../launch/create-code-attempt";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { isUnsafeSafeExamBrowserUserAgentFallbackEnabled } from "../../security/safe-exam-browser";
import { loadAssessmentVersionLinkage, persistAssignment, readAssignment } from "../assignments";
import {
  readAssignmentPolicySnapshot,
  readAssignmentTargetsInput,
  readLtiLinkages,
} from "../assignment-request-parsers";
import { requireSignedQflowRequest } from "./signature";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";

interface QflowEnv {
  HARBOR_DB: D1Database;
  QFLOW_HANDOFF_SECRET?: string;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
}

interface QflowHandoffRow {
  id: string;
  handoff_kind: QflowHandoffRequest["kind"];
  assessment_id: string;
  assessment_version_id: string;
  assignment_id: string | null;
  request_sha256: string;
}

export async function handleQflowHandoffRequest(c: AppContext): Promise<Response> {
  return qflowHandoff({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function qflowHandoff(input: {
  request: Request;
  env: QflowEnv;
  url: URL;
}): Promise<Response> {
  const { request, env } = input;
  const rawBody = await request.text();
  await requireSignedQflowRequest({ request, env, rawBody });
  const allowUnsafeUserAgentFallback = isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
    env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
  );
  const body = parseQflowRequest(rawBody, {
    allowUnsafeUserAgentFallback,
  });
  const requestSha256 = await sha256Hex(rawBody);
  const existingHandoff = await readQflowHandoff(env.HARBOR_DB, body.handoffId);

  if (existingHandoff) {
    return await buildExistingHandoffResponse({
      env,
      intent: body,
      requestSha256,
      existing: existingHandoff,
    });
  }

  if (body.kind === "activate-version") {
    return await handleActivationIntent({
      env,
      intent: body,
      rawBody,
      requestSha256,
    });
  }

  return await handleAssignmentIntent({
    env,
    intent: body,
    rawBody,
    requestSha256,
  });
}

async function handleActivationIntent(input: {
  env: QflowEnv;
  intent: Extract<QflowHandoffRequest, { kind: "activate-version" }>;
  rawBody: string;
  requestSha256: string;
}): Promise<Response> {
  const version = await loadAssessmentVersionLinkage({
    db: input.env.HARBOR_DB,
    assessmentId: input.intent.assessmentId,
    assessmentVersionId: input.intent.assessmentVersionId,
  });
  const activationId = `qflowact_${input.intent.handoffId}`;
  const createdAt = new Date().toISOString();

  await input.env.HARBOR_DB.prepare(
    "INSERT OR IGNORE INTO assessment_version_activations (id, assessment_id, assessment_version_id, actor_role, actor_id, actor_display_name, reason, activated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      activationId,
      input.intent.assessmentId,
      input.intent.assessmentVersionId,
      "system",
      input.intent.actorId,
      input.intent.actorDisplayName ?? "qflowlearn",
      input.intent.reason,
      input.intent.activatedAt,
      createdAt,
    )
    .run();

  await recordQflowHandoff({
    db: input.env.HARBOR_DB,
    handoffId: input.intent.handoffId,
    kind: input.intent.kind,
    assessmentId: input.intent.assessmentId,
    assessmentVersionId: input.intent.assessmentVersionId,
    assignmentId: null,
    requestSha256: input.requestSha256,
    payloadJson: input.rawBody,
  });

  return Response.json(
    {
      handoffId: input.intent.handoffId,
      kind: input.intent.kind,
      activationId,
      version,
    },
    { status: 200 },
  );
}

async function handleAssignmentIntent(input: {
  env: QflowEnv;
  intent: Extract<QflowHandoffRequest, { kind: "upsert-assignment" }>;
  rawBody: string;
  requestSha256: string;
}): Promise<Response> {
  const assignment = await persistAssignment({
    db: input.env.HARBOR_DB,
    request: buildAssignmentRequest(input.intent),
    mode: "upsert",
    allowUnsafeSafeExamBrowserUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
      input.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
    ),
  });
  const version = await loadAssessmentVersionLinkage({
    db: input.env.HARBOR_DB,
    assessmentId: input.intent.assessmentId,
    assessmentVersionId: input.intent.assessmentVersionId,
  });
  const accessCode = input.intent.accessCode
    ? await issueOrReuseAccessCode({
        db: input.env.HARBOR_DB,
        assignmentId: assignment.id,
        assessmentVersionId: assignment.assessmentVersionId,
        accessCode: input.intent.accessCode,
      })
    : null;

  await recordQflowHandoff({
    db: input.env.HARBOR_DB,
    handoffId: input.intent.handoffId,
    kind: input.intent.kind,
    assessmentId: input.intent.assessmentId,
    assessmentVersionId: input.intent.assessmentVersionId,
    assignmentId: assignment.id,
    requestSha256: input.requestSha256,
    payloadJson: input.rawBody,
  });

  return Response.json(
    {
      handoffId: input.intent.handoffId,
      kind: input.intent.kind,
      assignment: await readAssignment(input.env.HARBOR_DB, assignment.id),
      version,
      accessCode,
    },
    { status: 200 },
  );
}

async function buildExistingHandoffResponse(input: {
  env: QflowEnv;
  intent: QflowHandoffRequest;
  requestSha256: string;
  existing: QflowHandoffRow;
}): Promise<Response> {
  if (input.existing.request_sha256 !== input.requestSha256) {
    throw new LaunchRequestError(
      409,
      "QFlow handoffId has already been used for a different signed request",
    );
  }

  const version = await loadAssessmentVersionLinkage({
    db: input.env.HARBOR_DB,
    assessmentId: input.intent.assessmentId,
    assessmentVersionId: input.intent.assessmentVersionId,
  });

  if (input.intent.kind === "activate-version") {
    return Response.json(
      {
        handoffId: input.intent.handoffId,
        kind: input.intent.kind,
        activationId: `qflowact_${input.intent.handoffId}`,
        version,
      },
      { status: 200 },
    );
  }

  return Response.json(
    {
      handoffId: input.intent.handoffId,
      kind: input.intent.kind,
      assignment: await readAssignment(input.env.HARBOR_DB, input.intent.assignmentId),
      version,
      accessCode: input.intent.accessCode
        ? await readIssuedAccessCodeByAssignmentAndValue({
            db: input.env.HARBOR_DB,
            assignmentId: input.intent.assignmentId,
            assessmentVersionId: input.intent.assessmentVersionId,
            accessCode: input.intent.accessCode,
          })
        : null,
    },
    { status: 200 },
  );
}

async function recordQflowHandoff(input: {
  db: D1Database;
  handoffId: string;
  kind: QflowHandoffRequest["kind"];
  assessmentId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  requestSha256: string;
  payloadJson: string;
}): Promise<void> {
  try {
    await input.db
      .prepare(
        "INSERT INTO qflow_handoffs (id, handoff_kind, assessment_id, assessment_version_id, assignment_id, request_sha256, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.handoffId,
        input.kind,
        input.assessmentId,
        input.assessmentVersionId,
        input.assignmentId,
        input.requestSha256,
        input.payloadJson,
        new Date().toISOString(),
      )
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await readQflowHandoff(input.db, input.handoffId);
      if (existing?.request_sha256 === input.requestSha256) {
        return;
      }

      throw new LaunchRequestError(
        409,
        "QFlow handoffId has already been used for a different signed request",
      );
    }

    throw error;
  }
}

async function readQflowHandoff(
  db: D1Database,
  handoffId: string,
): Promise<QflowHandoffRow | null> {
  return (
    (await db
      .prepare(
        "SELECT id, handoff_kind, assessment_id, assessment_version_id, assignment_id, request_sha256 FROM qflow_handoffs WHERE id = ?",
      )
      .bind(handoffId)
      .first<QflowHandoffRow>()) ?? null
  );
}

async function issueOrReuseAccessCode(input: {
  db: D1Database;
  assignmentId: string;
  assessmentVersionId: string;
  accessCode: string;
}): Promise<IssuedAccessCode> {
  try {
    return await issueAccessCode({
      db: input.db,
      assignmentId: input.assignmentId,
      code: input.accessCode,
    });
  } catch (error) {
    if (error instanceof LaunchRequestError && error.status === 409) {
      const existing = await readIssuedAccessCodeByAssignmentAndValue({
        db: input.db,
        assignmentId: input.assignmentId,
        assessmentVersionId: input.assessmentVersionId,
        accessCode: input.accessCode,
      });
      if (existing) {
        return existing;
      }
    }

    throw error;
  }
}

async function readIssuedAccessCodeByAssignmentAndValue(input: {
  db: D1Database;
  assignmentId: string;
  assessmentVersionId: string;
  accessCode: string;
}): Promise<IssuedAccessCode | null> {
  const row = await input.db
    .prepare(
      "SELECT id, expires_at FROM access_codes WHERE assignment_id = ? AND code_sha256 = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(input.assignmentId, await sha256Hex(input.accessCode.trim().toUpperCase()))
    .first<{ id: string; expires_at: string | null }>();

  if (!row) {
    return null;
  }

  return {
    accessCodeId: row.id,
    accessCode: input.accessCode.trim().toUpperCase(),
    assessmentVersionId: input.assessmentVersionId,
    assignmentId: input.assignmentId,
    expiresAt: row.expires_at,
  };
}

function parseQflowRequest(
  rawBody: string,
  options: {
    allowUnsafeUserAgentFallback?: boolean;
  } = {},
): QflowHandoffRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new LaunchRequestError(400, "Request body must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LaunchRequestError(400, "Request body must be a JSON object");
  }

  const body = parsed as Record<string, unknown>;
  const kind = readRequiredString(body.kind, "kind is required");

  if (kind === "activate-version") {
    return {
      handoffId: readRequiredString(body.handoffId, "handoffId is required"),
      kind,
      assessmentId: readRequiredString(body.assessmentId, "assessmentId is required"),
      assessmentVersionId: readRequiredString(
        body.assessmentVersionId,
        "assessmentVersionId is required",
      ),
      actorId: readRequiredString(body.actorId, "actorId is required"),
      actorDisplayName: readOptionalString(body.actorDisplayName),
      reason: readRequiredString(body.reason, "reason is required"),
      activatedAt: readRequiredString(body.activatedAt, "activatedAt is required"),
    };
  }

  if (kind === "upsert-assignment") {
    return {
      handoffId: readRequiredString(body.handoffId, "handoffId is required"),
      kind,
      assignmentId: readRequiredString(body.assignmentId, "assignmentId is required"),
      assessmentId: readRequiredString(body.assessmentId, "assessmentId is required"),
      assessmentVersionId: readRequiredString(
        body.assessmentVersionId,
        "assessmentVersionId is required",
      ),
      title: readRequiredString(body.title, "title is required"),
      status: readOptionalStatus(body.status),
      policySnapshot: readAssignmentPolicySnapshot(body.policySnapshot, options),
      targets: readAssignmentTargetsInput(body.targets),
      ltiLinkages: readLtiLinkages(body.ltiLinkages),
      actorId: readRequiredString(body.actorId, "actorId is required"),
      actorDisplayName: readOptionalString(body.actorDisplayName),
      issuedAt: readRequiredString(body.issuedAt, "issuedAt is required"),
      accessCode: readOptionalString(body.accessCode),
    };
  }

  throw new LaunchRequestError(400, "Unsupported qflow handoff kind");
}

function buildAssignmentRequest(intent: QflowAssignmentIntent): CreateAssignmentRequest {
  return {
    assignmentId: intent.assignmentId,
    assessmentId: intent.assessmentId,
    assessmentVersionId: intent.assessmentVersionId,
    title: intent.title,
    status: intent.status,
    actor: {
      role: "qflow",
      actorId: intent.actorId,
      displayName: intent.actorDisplayName ?? "qflowlearn",
    },
    policySnapshot: intent.policySnapshot,
    targets: intent.targets,
    ltiLinkages: intent.ltiLinkages,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LaunchRequestError(400, message);
  }

  return value.trim();
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new LaunchRequestError(400, "Optional string value must be a string");
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readOptionalStatus(value: unknown): "draft" | "active" | "closed" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const status = readRequiredString(value, "status must be a non-empty string");
  if (status !== "draft" && status !== "active" && status !== "closed") {
    throw new LaunchRequestError(400, "status must be draft, active, or closed");
  }

  return status;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("unique constraint") || message.includes("constraint failed");
}
