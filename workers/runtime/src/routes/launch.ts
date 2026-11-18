import {
  createEmptyAttemptPolicyState,
  resolveAccommodationTimingEvidence,
  type AccessCodeLaunchActor,
  type AssignmentPolicySnapshot,
  type EntryLaunchResolution,
  type PreviewLaunchActor,
  type StudentLaunchActor,
} from "@harbor/attempt-protocol";

import {
  ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER,
  ATTEMPT_COORDINATOR_DELIVERY_CONTEXT_URL_HEADER,
} from "../attempts/attempt-durable-object";
import { createCodeAttempt, issueAccessCode } from "../launch/create-code-attempt";
import {
  createAttemptEntry,
  createPreviewAttempt,
  type AttemptContext,
  LaunchRequestError,
  loadPublishedVersionContext,
} from "../launch/create-preview-attempt";
import { issueBootstrapEnvelope } from "../launch/sign-bootstrap";
import { isUnsafeSafeExamBrowserUserAgentFallbackEnabled } from "../security/safe-exam-browser";
import { requireAllowedDeliveryContext } from "./delivery-context";
import {
  isGeneratedSafeExamBrowserConfigEnabled,
  resolveGeneratedSafeExamBrowserConfigPolicy,
} from "../security/generated-safe-exam-browser-config";
import {
  resolveEffectiveAccommodationSnapshot,
  writeAttemptAccommodationSnapshot,
} from "../accommodations/profiles";
import {
  readHarborSessionContextBySessionId,
  requireHarborSessionContext,
  type AuthenticatedLearnerContext,
} from "./auth/session";
import {
  applyAssignmentLearnerPolicyOverrides,
  applyLearnerOverrideToDeliveryPolicy,
  readAssignmentLearnerOverride,
} from "./instructor/services/policy-overrides";
import { parseStoredAssignmentPolicySnapshot } from "./assignment-request-parsers";
import { parseStoredDeliveryPolicy } from "../delivery/delivery-policy";
import { appendAttemptTimelineEvent } from "./operator-actions";
import { readJsonObject, readOptionalString, readRequiredStringField } from "./route-request-utils";
import {
  verifySafeExamBrowserLaunchToken,
  type SafeExamBrowserLaunchTokenClaims,
} from "./safe-exam-browser-config";
import type { AppContext } from "./hono-utils";

interface LaunchEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET: string;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
}

export type StudentLaunchEligibilityAuthority =
  | { kind: "harbor-targets" }
  | {
      kind: "external-signed-launch";
      source: "qflow";
      externalTenantId: string;
      launchId: string;
    }
  | {
      kind: "external-platform-launch";
      source: "lti";
      registrationId: string;
      sessionId: string;
    };

export async function launchStudentAssignment(input: {
  db: D1Database;
  bucket: R2Bucket;
  attemptCoordinator: DurableObjectNamespace;
  assignmentId: string;
  source: "institutional-sso" | "lti";
  learner: AuthenticatedLearnerContext;
  eligibility?: StudentLaunchEligibilityAuthority;
  requestUrl?: string;
  request?: Request;
  safeExamBrowserLaunchToken?: string | null;
}): Promise<AttemptContext> {
  const assignment = await input.db
    .prepare(
      "SELECT id, assessment_version_id, status, policy_snapshot_json FROM assignments WHERE id = ?",
    )
    .bind(input.assignmentId)
    .first<{
      id: string;
      assessment_version_id: string;
      status: string;
      policy_snapshot_json: string;
    }>();

  if (!assignment) {
    throw new LaunchRequestError(404, "Assignment not found");
  }

  const actor = buildStudentLaunchActor({
    learner: input.learner,
  });
  const learnerOverride = await readAssignmentLearnerOverride(
    input.db,
    assignment.id,
    input.learner.learner.id,
  );
  const policy = parseStoredAssignmentPolicySnapshot(assignment.policy_snapshot_json);
  const effectivePolicy = learnerOverride
    ? applyAssignmentLearnerPolicyOverrides(policy, learnerOverride.policyOverrides)
    : policy;

  const reusableAttempt = await findReusableStudentAttempt({
    db: input.db,
    attemptCoordinator: input.attemptCoordinator,
    assignmentId: assignment.id,
    actor,
  });
  if (reusableAttempt) {
    if (
      isGeneratedSafeExamBrowserConfigEnabled(reusableAttempt.deliveryPolicy.safeExamBrowser) &&
      !input.safeExamBrowserLaunchToken
    )
      throw new LaunchRequestError(403, "Use the Safe Exam Browser launch link for this attempt");
    return applyGeneratedSafeExamBrowserConfigToAttempt({
      db: input.db,
      attempt: reusableAttempt,
      assignmentId: assignment.id,
      attemptCoordinator: input.attemptCoordinator,
      request: input.request ?? null,
      generation: "resume",
      launchToken: input.safeExamBrowserLaunchToken ?? null,
    });
  }

  if (
    isGeneratedSafeExamBrowserConfigEnabled(effectivePolicy.safeExamBrowser) &&
    !input.safeExamBrowserLaunchToken
  ) {
    throw new LaunchRequestError(403, "Use the Safe Exam Browser launch link for this assignment");
  }

  const eligibility = input.eligibility ?? { kind: "harbor-targets" };
  if (eligibility.kind === "harbor-targets") {
    await requireAssignmentTargetEligibility({
      db: input.db,
      assignmentId: assignment.id,
      learnerId: input.learner.learner.id,
    });
  }

  if (assignment.status !== "active") {
    throw new LaunchRequestError(403, "Assignment is not active");
  }

  enforceAssignmentAvailability(effectivePolicy);
  await enforceRemainingStudentAttempts({
    db: input.db,
    assignmentId: assignment.id,
    learnerId: input.learner.learner.id,
    maxAttempts: effectivePolicy.maxAttempts,
  });
  const accommodationSnapshot = await resolveEffectiveAccommodationSnapshot({
    db: input.db,
    tenantId: input.learner.learner.tenantId,
    learnerId: input.learner.learner.id,
    assignmentOverride: learnerOverride
      ? {
          id: learnerOverride.id,
          accommodations: learnerOverride.accommodations,
        }
      : null,
  });

  const createdAttempt = await createAttemptEntry({
    db: input.db,
    bucket: input.bucket,
    assessmentVersionId: assignment.assessment_version_id,
    assignmentId: assignment.id,
    launch: {
      mode: input.source,
      actor,
    },
    launchSnapshot: {
      launchMode: input.source,
      assignmentId: assignment.id,
      learnerId: input.learner.learner.id,
      sessionId: input.learner.session.id,
      actor,
      launchedAt: new Date().toISOString(),
    },
  });

  const accommodatedAttempt = await applyLaunchAccommodationsToAttempt({
    db: input.db,
    attempt: createdAttempt,
    tenantId: input.learner.learner.tenantId,
    learnerId: input.learner.learner.id,
    assignmentId: assignment.id,
    baseAssignmentPolicy: policy,
    accommodationSnapshot,
    learnerOverride,
  });

  return applyGeneratedSafeExamBrowserConfigToAttempt({
    db: input.db,
    attempt: accommodatedAttempt,
    assignmentId: assignment.id,
    attemptCoordinator: input.attemptCoordinator,
    request: input.request ?? null,
    generation: "initial",
    launchToken: input.safeExamBrowserLaunchToken ?? null,
  });
}

export function buildEntryLaunchResolution(input: {
  attempt: AttemptContext;
  source: EntryLaunchResolution["source"];
  assignmentId?: string | null;
  learnerId?: string | null;
  sessionId?: string | null;
}): EntryLaunchResolution {
  return {
    source: input.source,
    assignmentId: input.assignmentId ?? null,
    assessmentVersionId: input.attempt.assessmentVersionId,
    learnerId: input.learnerId ?? null,
    sessionId:
      input.sessionId ??
      (input.attempt.launch.actor.kind === "student-learner"
        ? input.attempt.launch.actor.sessionId
        : null),
    launchActor: input.attempt.launch.actor,
  };
}

function buildStudentLaunchActor(input: {
  learner: AuthenticatedLearnerContext;
}): StudentLaunchActor {
  return {
    kind: "student-learner",
    learnerId: input.learner.learner.id,
    sessionId: input.learner.session.id,
    id: input.learner.learner.id,
    displayName: input.learner.learner.displayName,
  };
}

export async function handleIssueAccessCodesRequest(c: AppContext): Promise<Response> {
  return issueAccessCodes({
    request: c.req.raw,
    env: c.env,
  });
}

export async function issueAccessCodes(input: {
  request: Request;
  env: LaunchEnv;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const assignmentId = readOptionalString(body.assignmentId) ?? undefined;
  const assessmentVersionId = readOptionalString(body.assessmentVersionId) ?? undefined;
  const assessmentId = readOptionalString(body.assessmentId) ?? undefined;

  if (!assignmentId && !assessmentVersionId && !assessmentId) {
    throw new LaunchRequestError(
      400,
      "assignmentId, assessmentVersionId, or assessmentId is required",
    );
  }
  const code = readOptionalString(body.code) ?? undefined;
  const expiresAt = readOptionalString(body.expiresAt) ?? undefined;

  const issued = await issueAccessCode({
    db: input.env.HARBOR_DB,
    assignmentId,
    assessmentVersionId,
    assessmentId,
    code,
    expiresAt,
  });

  return Response.json(issued, { status: 201 });
}

export async function handlePreviewLaunchRequest(c: AppContext): Promise<Response> {
  return previewLaunch({
    request: c.req.raw,
    env: c.env,
  });
}

export async function previewLaunch(input: {
  request: Request;
  env: LaunchEnv;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const assessmentVersionId = readRequiredStringField(
    body,
    "assessmentVersionId",
    "assessmentVersionId is required",
  );
  const actor = readPreviewActor(body);
  const versionContext = await loadPublishedVersionContext({
    db: input.env.HARBOR_DB,
    bucket: input.env.CONTENT_BUCKET,
    assessmentVersionId,
  });
  await requireAllowedDeliveryContext({
    request: input.request,
    deliveryPolicy: {
      ...versionContext.deliveryPolicy,
      launchMode: "preview",
    },
    allowUnsafeSafeExamBrowserUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
      input.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
    ),
  });
  const payload = await createPreviewAttempt({
    db: input.env.HARBOR_DB,
    bucket: input.env.CONTENT_BUCKET,
    assessmentVersionId,
    actor,
  });
  const resolution = buildEntryLaunchResolution({
    attempt: payload,
    source: "preview",
  });
  await appendAttemptTimelineEvent({
    db: input.env.HARBOR_DB,
    attemptId: payload.attemptId,
    eventType: "launch",
    summary: {
      launchMode: resolution.source,
      assessmentVersionId: resolution.assessmentVersionId,
      sessionId: resolution.sessionId,
    },
  });

  return Response.json(
    await issueBootstrapEnvelope({
      attempt: payload,
      secret: input.env.BOOTSTRAP_SIGNING_SECRET,
    }),
    { status: 201 },
  );
}

export async function handleAccessCodeLaunchRequest(c: AppContext): Promise<Response> {
  return accessCodeLaunch({
    request: c.req.raw,
    env: c.env,
  });
}

export async function accessCodeLaunch(input: {
  request: Request;
  env: LaunchEnv;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const accessCode = readRequiredStringField(body, "accessCode", "accessCode is required");
  const assessmentVersionId = readOptionalString(body.assessmentVersionId) ?? undefined;
  const actor = readAccessCodeActor(body);

  const payload = await createCodeAttempt({
    db: input.env.HARBOR_DB,
    bucket: input.env.CONTENT_BUCKET,
    attemptCoordinator: input.env.ATTEMPT_COORDINATOR,
    accessCode,
    assessmentVersionId,
    actor,
  });
  await requireAllowedDeliveryContext({
    request: input.request,
    deliveryPolicy: payload.deliveryPolicy,
    allowUnsafeSafeExamBrowserUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
      input.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
    ),
  });
  const resolution = buildEntryLaunchResolution({
    attempt: payload,
    source: "access-code",
  });
  await appendAttemptTimelineEvent({
    db: input.env.HARBOR_DB,
    attemptId: payload.attemptId,
    eventType: "launch",
    summary: {
      launchMode: resolution.source,
      assessmentVersionId: resolution.assessmentVersionId,
      sessionId: resolution.sessionId,
    },
  });

  return Response.json(
    await issueBootstrapEnvelope({
      attempt: payload,
      secret: input.env.BOOTSTRAP_SIGNING_SECRET,
    }),
    { status: 201 },
  );
}

export async function handleStudentLaunchRequest(c: AppContext): Promise<Response> {
  return studentLaunch({
    request: c.req.raw,
    env: c.env,
  });
}

export async function studentLaunch(input: {
  request: Request;
  env: LaunchEnv;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const assignmentId = readRequiredStringField(body, "assignmentId", "assignmentId is required");
  const source =
    (readOptionalString(body.source) as "institutional-sso" | "lti" | undefined) ??
    "institutional-sso";
  const safeExamBrowserLaunchToken =
    readOptionalString(body.safeExamBrowserLaunchToken) ?? undefined;

  if (source !== "institutional-sso" && source !== "lti") {
    throw new LaunchRequestError(400, "source must be institutional-sso or lti");
  }

  const learner = safeExamBrowserLaunchToken
    ? await requireSafeExamBrowserLaunchTokenContext({
        env: input.env,
        token: safeExamBrowserLaunchToken,
        assignmentId,
      })
    : await requireHarborSessionContext(input.request, input.env);
  const payload = await launchStudentAssignment({
    db: input.env.HARBOR_DB,
    bucket: input.env.CONTENT_BUCKET,
    attemptCoordinator: input.env.ATTEMPT_COORDINATOR,
    assignmentId,
    source,
    learner,
    eligibility: { kind: "harbor-targets" },
    requestUrl: input.request.url,
    request: input.request,
    safeExamBrowserLaunchToken,
  });
  await requireAllowedDeliveryContext({
    request: input.request,
    deliveryPolicy: payload.deliveryPolicy,
    allowUnsafeSafeExamBrowserUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
      input.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
    ),
  });
  const resolution = buildEntryLaunchResolution({
    attempt: payload,
    source,
    assignmentId,
    learnerId: learner.learner.id,
    sessionId: learner.session.id,
  });
  await appendAttemptTimelineEvent({
    db: input.env.HARBOR_DB,
    attemptId: payload.attemptId,
    eventType: "launch",
    summary: {
      launchMode: resolution.source,
      assessmentVersionId: resolution.assessmentVersionId,
      assignmentId: resolution.assignmentId,
      learnerId: resolution.learnerId,
      sessionId: resolution.sessionId,
    },
  });

  return Response.json(
    await issueBootstrapEnvelope({
      attempt: payload,
      secret: input.env.BOOTSTRAP_SIGNING_SECRET,
    }),
    { status: 201 },
  );
}

async function requireSafeExamBrowserLaunchTokenContext(input: {
  env: Pick<LaunchEnv, "HARBOR_DB" | "BOOTSTRAP_SIGNING_SECRET">;
  token: string;
  assignmentId: string;
}): Promise<AuthenticatedLearnerContext> {
  const claims: SafeExamBrowserLaunchTokenClaims = await verifySafeExamBrowserLaunchToken({
    token: input.token,
    secret: input.env.BOOTSTRAP_SIGNING_SECRET,
  });
  if (claims.assignmentId !== input.assignmentId) {
    throw new LaunchRequestError(
      401,
      "Safe Exam Browser launch token does not match this assignment",
    );
  }

  const context = await readHarborSessionContextBySessionId(input.env, claims.sessionId);
  if (!context || context.learner.id !== claims.learnerId) {
    throw new LaunchRequestError(401, "QFlowLearn Delivery session is required");
  }

  return context;
}

async function applyGeneratedSafeExamBrowserConfigToAttempt(input: {
  db: D1Database;
  attemptCoordinator: DurableObjectNamespace;
  attempt: AttemptContext;
  assignmentId: string;
  request: Request | null;
  generation: "initial" | "resume";
  launchToken: string | null;
}): Promise<AttemptContext> {
  if (!input.launchToken) return input.attempt;
  if (!input.request)
    throw new LaunchRequestError(400, "Safe Exam Browser launch requires proof context");
  if (input.generation === "resume") {
    const stub = input.attemptCoordinator.get(
      input.attemptCoordinator.idFromName(input.attempt.attemptId),
    );
    const headers = new Headers(input.request.headers);
    headers.set(ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER, input.attempt.attemptId);
    headers.set(ATTEMPT_COORDINATOR_DELIVERY_CONTEXT_URL_HEADER, input.request.url);
    headers.set("content-type", "application/json");
    const response = await stub.fetch("https://harbor-attempt.local/generated-seb-rebind", {
      method: "POST",
      headers,
      body: JSON.stringify({ launchToken: input.launchToken }),
    });
    if (!response.ok)
      throw new LaunchRequestError(response.status, "Unable to verify the generated SEB relaunch");
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("deliveryPolicy" in payload))
      throw new LaunchRequestError(500, "Invalid generated SEB relaunch state");
    return {
      ...input.attempt,
      deliveryPolicy: parseStoredDeliveryPolicy(JSON.stringify(payload.deliveryPolicy)),
    };
  }
  // Initial policy/accommodation snapshots must be complete before the coordinator is initialized.
  const entry = await input.db
    .prepare(
      "SELECT assignment_policy_snapshot FROM attempt_entries WHERE id = ? AND assignment_id = ?",
    )
    .bind(input.attempt.attemptId, input.assignmentId)
    .first<{ assignment_policy_snapshot: string | null }>();
  if (!entry?.assignment_policy_snapshot)
    throw new LaunchRequestError(
      409,
      "Pinned assignment policy is required for generated SEB launch",
    );
  const resolved = await resolveGeneratedSafeExamBrowserConfigPolicy({
    assignmentPolicy: parseStoredAssignmentPolicySnapshot(entry.assignment_policy_snapshot),
    deliveryPolicy: input.attempt.deliveryPolicy,
    requestUrl: input.request.url,
    assignmentId: input.assignmentId,
    launchToken: input.launchToken,
  });
  if (!resolved)
    throw new LaunchRequestError(
      409,
      "Generated Safe Exam Browser config is not enabled for this attempt",
    );
  await requireAllowedDeliveryContext({
    request: input.request,
    deliveryPolicy: resolved.deliveryPolicy,
  });
  await input.db
    .prepare(
      "UPDATE attempt_entries SET delivery_policy_snapshot = ?, assignment_policy_snapshot = ? WHERE id = ? AND assignment_id = ?",
    )
    .bind(
      JSON.stringify(resolved.deliveryPolicy),
      JSON.stringify(resolved.assignmentPolicy),
      input.attempt.attemptId,
      input.assignmentId,
    )
    .run();
  return { ...input.attempt, deliveryPolicy: resolved.deliveryPolicy };
}

async function findReusableStudentAttempt(input: {
  db: D1Database;
  attemptCoordinator: DurableObjectNamespace;
  assignmentId: string;
  actor: StudentLaunchActor;
}): Promise<AttemptContext | null> {
  const attempts = await input.db
    .prepare(
      "SELECT id, assessment_version_id, delivery_policy_snapshot, manifest_object_key, current_item_id, current_item_href FROM attempt_entries WHERE assignment_id = ? AND actor_kind = ? AND actor_id = ? ORDER BY created_at DESC LIMIT 5",
    )
    .bind(input.assignmentId, input.actor.kind, input.actor.learnerId)
    .all<{
      id: string;
      assessment_version_id: string;
      delivery_policy_snapshot: string;
      manifest_object_key: string;
      current_item_id: string;
      current_item_href: string;
    }>();

  for (const attempt of attempts.results) {
    const session = await readAuthoritativeSession({
      attemptCoordinator: input.attemptCoordinator,
      attemptId: attempt.id,
    });
    if (!isResumableAttemptStatus(session.attemptStatus)) {
      continue;
    }

    return {
      attemptId: attempt.id,
      assessmentVersionId: attempt.assessment_version_id,
      deliveryPolicy: parseStoredDeliveryPolicy(attempt.delivery_policy_snapshot),
      manifest: {
        manifestObjectKey: attempt.manifest_object_key,
      },
      currentItemRef: {
        itemId: attempt.current_item_id,
        itemHref: attempt.current_item_href,
      },
      launch: {
        mode: parseStoredDeliveryPolicy(attempt.delivery_policy_snapshot).launchMode,
        actor: input.actor,
      },
    };
  }

  return null;
}

async function requireAssignmentTargetEligibility(input: {
  db: D1Database;
  assignmentId: string;
  learnerId: string;
}): Promise<void> {
  const direct = await input.db
    .prepare(
      "SELECT 1 AS match FROM assignment_learner_targets WHERE assignment_id = ? AND learner_id = ? LIMIT 1",
    )
    .bind(input.assignmentId, input.learnerId)
    .first<{ match: number }>();
  if (direct?.match === 1) {
    return;
  }

  const section = await input.db
    .prepare(
      "SELECT 1 AS match FROM assignment_section_targets targets INNER JOIN section_memberships memberships ON memberships.section_id = targets.section_id WHERE targets.assignment_id = ? AND memberships.learner_id = ? AND memberships.status = ? LIMIT 1",
    )
    .bind(input.assignmentId, input.learnerId, "active")
    .first<{ match: number }>();
  if (section?.match === 1) {
    return;
  }

  throw new LaunchRequestError(403, "Learner is not eligible for the requested assignment");
}

async function enforceRemainingStudentAttempts(input: {
  db: D1Database;
  assignmentId: string;
  learnerId: string;
  maxAttempts: number;
}): Promise<void> {
  const row = await input.db
    .prepare(
      "SELECT COUNT(*) AS count FROM attempt_entries WHERE assignment_id = ? AND actor_kind = ? AND actor_id = ?",
    )
    .bind(input.assignmentId, "student-learner", input.learnerId)
    .first<{ count: number }>();

  if ((row?.count ?? 0) >= input.maxAttempts) {
    throw new LaunchRequestError(403, "No remaining attempts are available for this assignment");
  }
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

async function readAuthoritativeSession(input: {
  attemptCoordinator: DurableObjectNamespace;
  attemptId: string;
}): Promise<{
  attemptStatus:
    | "active"
    | "soft_closed"
    | "accepting_late_within_grace"
    | "submitted"
    | "expired_pending_recovery"
    | "reopened";
}> {
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

  return response.json<{
    attemptStatus:
      | "active"
      | "soft_closed"
      | "accepting_late_within_grace"
      | "submitted"
      | "expired_pending_recovery"
      | "reopened";
  }>();
}

function isResumableAttemptStatus(
  status:
    | "active"
    | "soft_closed"
    | "accepting_late_within_grace"
    | "submitted"
    | "expired_pending_recovery"
    | "reopened",
): boolean {
  return (
    status === "active" ||
    status === "soft_closed" ||
    status === "accepting_late_within_grace" ||
    status === "reopened"
  );
}

async function applyLaunchAccommodationsToAttempt(input: {
  db: D1Database;
  attempt: AttemptContext;
  tenantId: string;
  learnerId: string;
  assignmentId: string;
  baseAssignmentPolicy: AssignmentPolicySnapshot;
  accommodationSnapshot: Awaited<ReturnType<typeof resolveEffectiveAccommodationSnapshot>>;
  learnerOverride: NonNullable<Awaited<ReturnType<typeof readAssignmentLearnerOverride>>> | null;
}): Promise<AttemptContext> {
  const effectiveAssignmentPolicy = input.learnerOverride
    ? applyAssignmentLearnerPolicyOverrides(
        input.baseAssignmentPolicy,
        input.learnerOverride.policyOverrides,
      )
    : input.baseAssignmentPolicy;
  const deliveryPolicy = input.learnerOverride
    ? applyLearnerOverrideToDeliveryPolicy(
        input.attempt.deliveryPolicy,
        input.learnerOverride.policyOverrides,
      )
    : input.attempt.deliveryPolicy;
  const timingEvidence = resolveAccommodationTimingEvidence({
    baseTimeLimitSeconds: effectiveAssignmentPolicy.timeLimitSeconds,
    policyAdditionalTimeSeconds: input.learnerOverride?.policyOverrides.additionalTimeSeconds ?? 0,
    accommodations: input.accommodationSnapshot.accommodations,
  });
  const overlaySeed = buildAccommodationOverlaySeed({
    additionalTimeSeconds: timingEvidence.additionalTimeSeconds,
    accommodations: input.accommodationSnapshot.accommodations,
  });

  await writeAttemptAccommodationSnapshot({
    db: input.db,
    attemptId: input.attempt.attemptId,
    tenantId: input.tenantId,
    learnerId: input.learnerId,
    assignmentId: input.assignmentId,
    snapshot: input.accommodationSnapshot,
    timing: timingEvidence,
  });

  if (input.learnerOverride) {
    await input.db
      .prepare(
        "UPDATE attempt_entries SET delivery_policy_snapshot = ?, assignment_policy_snapshot = ? WHERE id = ? AND assignment_id = ?",
      )
      .bind(
        JSON.stringify(deliveryPolicy),
        JSON.stringify(effectiveAssignmentPolicy),
        input.attempt.attemptId,
        input.assignmentId,
      )
      .run();
  }

  if (overlaySeed) {
    await input.db
      .prepare(
        "INSERT INTO attempt_policy_overlays (attempt_id, overlay_revision, additional_time_seconds, reopen_status, reopened_at, reopen_until, operator_message_json, accommodations_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET overlay_revision = excluded.overlay_revision, additional_time_seconds = excluded.additional_time_seconds, accommodations_json = excluded.accommodations_json, updated_at = excluded.updated_at",
      )
      .bind(
        input.attempt.attemptId,
        1,
        overlaySeed.additionalTimeSeconds,
        "closed",
        null,
        null,
        null,
        JSON.stringify(overlaySeed.accommodations),
        new Date().toISOString(),
      )
      .run();
  }

  return {
    ...input.attempt,
    deliveryPolicy,
  };
}

function buildAccommodationOverlaySeed(input: {
  additionalTimeSeconds: number;
  accommodations: ReturnType<typeof createEmptyAttemptPolicyState>["accommodations"];
}): {
  additionalTimeSeconds: number;
  accommodations: ReturnType<typeof createEmptyAttemptPolicyState>["accommodations"];
} | null {
  const additionalTimeSeconds = input.additionalTimeSeconds;
  const accommodations = input.accommodations;
  const emptyAccommodations = createEmptyAttemptPolicyState().accommodations;
  const hasAccommodations = JSON.stringify(accommodations) !== JSON.stringify(emptyAccommodations);

  if (additionalTimeSeconds === 0 && !hasAccommodations) {
    return null;
  }

  return {
    additionalTimeSeconds,
    accommodations,
  };
}

function readPreviewActor(body: Record<string, unknown>): PreviewLaunchActor {
  const actor = readActorObject(body);
  return {
    kind: "preview-operator",
    id: actor.id,
    displayName: actor.displayName,
  };
}

function readAccessCodeActor(body: Record<string, unknown>): AccessCodeLaunchActor {
  const actor = readActorObject(body);
  return {
    kind: "access-code-candidate",
    id: actor.id,
    displayName: actor.displayName,
  };
}

function readActorObject(body: Record<string, unknown>): {
  id: string | null;
  displayName: string | null;
} {
  const actorValue = body.actor;

  if (!actorValue || typeof actorValue !== "object") {
    return {
      id: null,
      displayName: null,
    };
  }

  const actor = actorValue as Record<string, unknown>;
  return {
    id: nullableString(actor.id),
    displayName: nullableString(actor.displayName),
  };
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new LaunchRequestError(400, "actor fields must be strings");
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
