import type {
  AssignmentActorSnapshot,
  AssignmentPolicySnapshot,
  AssignmentReadResponse,
  AssignmentRecord,
  AssignmentStatus,
  AssignmentTarget,
  CreateAssignmentRequest,
  LtiAssignmentLinkage,
  StudentAssignmentListItem,
  StudentAssignmentListResponse,
} from "@harbor/attempt-protocol";
import { requireHarborSessionContext } from "./auth/session";
import { LaunchRequestError } from "../launch/create-preview-attempt";
import { readCreateAssignmentRequest } from "./assignment-request-parsers";
import { parseStoredAssignmentPolicySnapshot } from "./assignment-request-parsers";
import { isUnsafeSafeExamBrowserUserAgentFallbackEnabled } from "../security/safe-exam-browser";
import { assertLtiLinkagesBelongToAssessmentTenant } from "../lti/linkage-tenant";
import { readSafeExamBrowserPolicy } from "./safe-exam-browser-policy";
import type { AppContext } from "./hono-utils";
import { readAssignmentIdParam } from "./route-params";

interface AssignmentsEnv {
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET: string;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
}

interface AssignmentRow {
  id: string;
  assessment_id: string;
  assessment_version_id: string;
  title: string;
  status: AssignmentStatus;
  policy_snapshot_json: string;
  created_by_role: AssignmentActorSnapshot["role"];
  created_by_id: string;
  created_by_display_name: string | null;
  created_at: string;
  updated_at: string;
}

interface StudentAssignmentRow {
  id: string;
  assessment_id: string;
  assessment_version_id: string;
  title: string;
  status: AssignmentStatus;
  policy_snapshot_json: string;
  target_source: "explicit" | "section";
}

interface AttemptProjectionRow {
  id: string;
  assignment_id: string;
}

const SQL_IN_BIND_CHUNK_SIZE = 80;

export async function handlePostInternalAssignmentRequest(c: AppContext): Promise<Response> {
  return postInternalAssignment({
    request: c.req.raw,
    env: c.env,
  });
}

export async function postInternalAssignment(input: {
  env: AssignmentsEnv;
  request: Request;
}): Promise<Response> {
  const assignment = await persistAssignment({
    db: input.env.HARBOR_DB,
    request: await readCreateAssignmentRequest(input.request, {
      allowUnsafeUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
        input.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
      ),
    }),
    mode: "create",
    allowUnsafeSafeExamBrowserUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
      input.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
    ),
  });

  return Response.json(assignment, { status: 201 });
}

export async function handleGetInternalAssignmentRequest(c: AppContext): Promise<Response> {
  return getInternalAssignment({
    env: c.env,
    assignmentId: readAssignmentIdParam(c),
  });
}

export async function getInternalAssignment(input: {
  env: AssignmentsEnv;
  assignmentId: string;
}): Promise<Response> {
  return Response.json(await readAssignment(input.env.HARBOR_DB, input.assignmentId), {
    status: 200,
  });
}

export async function handleStudentAssignmentsRequest(c: AppContext): Promise<Response> {
  return listStudentAssignments({
    request: c.req.raw,
    env: c.env,
  });
}

export async function listStudentAssignments(input: {
  request: Request;
  env: AssignmentsEnv;
}): Promise<Response> {
  return Response.json(await readStudentAssignments(input.request, input.env), { status: 200 });
}

export async function persistAssignment(input: {
  db: D1Database;
  request: CreateAssignmentRequest;
  mode: "create" | "upsert";
  allowUnsafeSafeExamBrowserUserAgentFallback?: boolean;
}): Promise<AssignmentRecord> {
  await requireVersionForAssessment({
    db: input.db,
    assessmentId: input.request.assessmentId,
    assessmentVersionId: input.request.assessmentVersionId,
  });

  const existing = await readAssignmentRow(input.db, input.request.assignmentId);
  if (existing && input.mode === "create") {
    throw new LaunchRequestError(409, "Assignment already exists");
  }

  const createdAt = existing?.created_at ?? new Date().toISOString();
  const updatedAt = new Date().toISOString();
  const createdBy = existing
    ? {
        role: existing.created_by_role,
        actorId: existing.created_by_id,
        displayName: existing.created_by_display_name,
      }
    : input.request.actor;
  const policySnapshot = {
    ...input.request.policySnapshot,
    safeExamBrowser: readSafeExamBrowserPolicy(input.request.policySnapshot.safeExamBrowser, {
      allowUnsafeUserAgentFallback: input.allowUnsafeSafeExamBrowserUserAgentFallback,
    }),
  };

  await assertLtiLinkagesBelongToAssessmentTenant({
    db: input.db,
    assessmentId: input.request.assessmentId,
    linkages: input.request.ltiLinkages ?? [],
  });

  await input.db
    .prepare(
      "INSERT INTO assignments (id, assessment_id, assessment_version_id, title, status, policy_snapshot_json, created_by_role, created_by_id, created_by_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET assessment_id = excluded.assessment_id, assessment_version_id = excluded.assessment_version_id, title = excluded.title, status = excluded.status, policy_snapshot_json = excluded.policy_snapshot_json, updated_at = excluded.updated_at",
    )
    .bind(
      input.request.assignmentId,
      input.request.assessmentId,
      input.request.assessmentVersionId,
      input.request.title,
      input.request.status ?? "active",
      JSON.stringify(policySnapshot),
      createdBy.role,
      createdBy.actorId,
      createdBy.displayName,
      createdAt,
      updatedAt,
    )
    .run();

  await persistAssignmentTargets({
    db: input.db,
    assignmentId: input.request.assignmentId,
    targets: input.request.targets ?? [],
  });
  await persistAssignmentLtiLinkages({
    db: input.db,
    assignmentId: input.request.assignmentId,
    ltiLinkages: input.request.ltiLinkages ?? [],
  });

  return readAssignment(input.db, input.request.assignmentId);
}

export async function readAssignment(
  db: D1Database,
  assignmentId: string,
): Promise<AssignmentReadResponse> {
  const row = await readAssignmentRow(db, assignmentId);
  if (!row) {
    throw new LaunchRequestError(404, "Assignment not found");
  }

  return mapAssignmentRow(db, row);
}

export async function loadAssessmentVersionLinkage(input: {
  db: D1Database;
  assessmentId: string;
  assessmentVersionId: string;
}): Promise<{
  assessmentId: string;
  assessmentVersionId: string;
  manifestObjectKey: string;
}> {
  const row = await input.db
    .prepare(
      "SELECT assessment_id, id AS assessment_version_id, manifest_object_key FROM assessment_versions WHERE assessment_id = ? AND id = ?",
    )
    .bind(input.assessmentId, input.assessmentVersionId)
    .first<{
      assessment_id: string;
      assessment_version_id: string;
      manifest_object_key: string;
    }>();

  if (!row) {
    throw new LaunchRequestError(
      404,
      "Assessment version was not found for the requested assignment",
    );
  }

  return {
    assessmentId: row.assessment_id,
    assessmentVersionId: row.assessment_version_id,
    manifestObjectKey: row.manifest_object_key,
  };
}

export async function readStudentAssignments(
  request: Request,
  env: AssignmentsEnv,
): Promise<StudentAssignmentListResponse> {
  const context = await requireHarborSessionContext(request, env);
  const directAssignments = await env.HARBOR_DB.prepare(
    "SELECT assignments.id, assignments.assessment_id, assignments.assessment_version_id, assignments.title, assignments.status, assignments.policy_snapshot_json, 'explicit' AS target_source FROM assignments INNER JOIN assignment_learner_targets targets ON targets.assignment_id = assignments.id WHERE targets.learner_id = ?",
  )
    .bind(context.learner.id)
    .all<StudentAssignmentRow>();
  const sectionAssignments = await env.HARBOR_DB.prepare(
    "SELECT DISTINCT assignments.id, assignments.assessment_id, assignments.assessment_version_id, assignments.title, assignments.status, assignments.policy_snapshot_json, 'section' AS target_source FROM assignments INNER JOIN assignment_section_targets targets ON targets.assignment_id = assignments.id INNER JOIN section_memberships memberships ON memberships.section_id = targets.section_id WHERE memberships.learner_id = ? AND memberships.status = ?",
  )
    .bind(context.learner.id, "active")
    .all<StudentAssignmentRow>();

  const assignmentMap = new Map<string, StudentAssignmentRow>();
  for (const row of [...sectionAssignments.results, ...directAssignments.results]) {
    assignmentMap.set(row.id, row);
  }

  const assignmentRows = [...assignmentMap.values()];
  if (assignmentRows.length === 0) {
    return {
      learner: context.learner,
      session: context.session,
      assignments: [],
    };
  }

  const attempts = await readStudentAttemptProjections({
    db: env.HARBOR_DB,
    assignmentIds: assignmentRows.map((row) => row.id),
    learnerId: context.learner.id,
  });
  const submittedAttemptIds = await readSubmittedAttemptIds(
    env.HARBOR_DB,
    attempts.map((attempt) => attempt.id),
  );

  const attemptsByAssignment = new Map<string, AttemptProjectionRow[]>();
  for (const attempt of attempts) {
    const bucket = attemptsByAssignment.get(attempt.assignment_id) ?? [];
    bucket.push(attempt);
    attemptsByAssignment.set(attempt.assignment_id, bucket);
  }

  const assignments = assignmentRows.map((row) =>
    buildStudentAssignmentListItem(
      row,
      attemptsByAssignment.get(row.id) ?? [],
      submittedAttemptIds,
    ),
  );

  return {
    learner: context.learner,
    session: context.session,
    assignments,
  };
}

async function readStudentAttemptProjections(input: {
  db: D1Database;
  assignmentIds: string[];
  learnerId: string;
}): Promise<AttemptProjectionRow[]> {
  const rows: AttemptProjectionRow[] = [];

  for (const assignmentIds of chunkArray(input.assignmentIds, SQL_IN_BIND_CHUNK_SIZE)) {
    const attempts = await input.db
      .prepare(
        `SELECT id, assignment_id FROM attempt_entries WHERE assignment_id IN (${assignmentIds
          .map(() => "?")
          .join(", ")}) AND actor_kind = ? AND actor_id = ? ORDER BY created_at DESC`,
      )
      .bind(...assignmentIds, "student-learner", input.learnerId)
      .all<AttemptProjectionRow>();
    rows.push(...attempts.results);
  }

  return rows;
}

async function readSubmittedAttemptIds(db: D1Database, attemptIds: string[]): Promise<Set<string>> {
  const submittedAttemptIds = new Set<string>();

  for (const chunk of chunkArray(attemptIds, SQL_IN_BIND_CHUNK_SIZE)) {
    const submitted = await db
      .prepare(
        `SELECT attempt_id FROM attempt_results WHERE attempt_id IN (${chunk
          .map(() => "?")
          .join(", ")})`,
      )
      .bind(...chunk)
      .all<{ attempt_id: string }>();
    for (const row of submitted.results) {
      submittedAttemptIds.add(row.attempt_id);
    }
  }

  return submittedAttemptIds;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function readAssignmentRow(
  db: D1Database,
  assignmentId: string,
): Promise<AssignmentRow | null> {
  return (
    (await db
      .prepare(
        "SELECT id, assessment_id, assessment_version_id, title, status, policy_snapshot_json, created_by_role, created_by_id, created_by_display_name, created_at, updated_at FROM assignments WHERE id = ?",
      )
      .bind(assignmentId)
      .first<AssignmentRow>()) ?? null
  );
}

async function mapAssignmentRow(db: D1Database, row: AssignmentRow): Promise<AssignmentRecord> {
  return {
    id: row.id,
    assessmentId: row.assessment_id,
    assessmentVersionId: row.assessment_version_id,
    title: row.title,
    status: row.status,
    policySnapshot: parseStoredAssignmentPolicySnapshot(row.policy_snapshot_json),
    targets: await readAssignmentTargets(db, row.id),
    ltiLinkages: await readAssignmentLtiLinkages(db, row.id),
    createdBy: {
      role: row.created_by_role,
      actorId: row.created_by_id,
      displayName: row.created_by_display_name,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireVersionForAssessment(input: {
  db: D1Database;
  assessmentId: string;
  assessmentVersionId: string;
}): Promise<void> {
  const row = await input.db
    .prepare("SELECT id FROM assessment_versions WHERE assessment_id = ? AND id = ?")
    .bind(input.assessmentId, input.assessmentVersionId)
    .first<{ id: string }>();

  if (!row) {
    throw new LaunchRequestError(
      404,
      "Assessment version was not found for the requested assignment",
    );
  }
}

async function persistAssignmentTargets(input: {
  db: D1Database;
  assignmentId: string;
  targets: AssignmentTarget[];
}): Promise<void> {
  await input.db.batch([
    input.db
      .prepare("DELETE FROM assignment_learner_targets WHERE assignment_id = ?")
      .bind(input.assignmentId),
    input.db
      .prepare("DELETE FROM assignment_section_targets WHERE assignment_id = ?")
      .bind(input.assignmentId),
  ]);

  for (const target of input.targets) {
    if (target.kind === "learner") {
      await input.db
        .prepare(
          "INSERT INTO assignment_learner_targets (id, assignment_id, learner_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(createId("atarget"), input.assignmentId, target.learnerId, new Date().toISOString())
        .run();
      continue;
    }

    await input.db
      .prepare(
        "INSERT INTO assignment_section_targets (id, assignment_id, section_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(createId("starget"), input.assignmentId, target.sectionId, new Date().toISOString())
      .run();
  }
}

async function persistAssignmentLtiLinkages(input: {
  db: D1Database;
  assignmentId: string;
  ltiLinkages: LtiAssignmentLinkage[];
}): Promise<void> {
  await input.db
    .prepare("DELETE FROM lti_resource_links WHERE assignment_id = ?")
    .bind(input.assignmentId)
    .run();

  for (const linkage of input.ltiLinkages) {
    await input.db
      .prepare(
        "INSERT INTO lti_resource_links (id, registration_id, assignment_id, resource_link_id, context_id, section_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        createId("ltilink"),
        linkage.registrationId,
        input.assignmentId,
        linkage.resourceLinkId,
        linkage.contextId ?? null,
        linkage.sectionId ?? null,
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
  }
}

async function readAssignmentTargets(
  db: D1Database,
  assignmentId: string,
): Promise<AssignmentTarget[]> {
  const learnerTargets = await db
    .prepare(
      "SELECT learner_id FROM assignment_learner_targets WHERE assignment_id = ? ORDER BY learner_id",
    )
    .bind(assignmentId)
    .all<{ learner_id: string }>();
  const sectionTargets = await db
    .prepare(
      "SELECT section_id FROM assignment_section_targets WHERE assignment_id = ? ORDER BY section_id",
    )
    .bind(assignmentId)
    .all<{ section_id: string }>();

  return [
    ...learnerTargets.results.map((row) => ({
      kind: "learner" as const,
      learnerId: row.learner_id,
    })),
    ...sectionTargets.results.map((row) => ({
      kind: "section" as const,
      sectionId: row.section_id,
    })),
  ];
}

async function readAssignmentLtiLinkages(
  db: D1Database,
  assignmentId: string,
): Promise<LtiAssignmentLinkage[]> {
  const linkages = await db
    .prepare(
      "SELECT registration_id, resource_link_id, context_id, section_id FROM lti_resource_links WHERE assignment_id = ? ORDER BY resource_link_id",
    )
    .bind(assignmentId)
    .all<{
      registration_id: string;
      resource_link_id: string;
      context_id: string | null;
      section_id: string | null;
    }>();

  return linkages.results.map((row) => ({
    registrationId: row.registration_id,
    resourceLinkId: row.resource_link_id,
    contextId: row.context_id,
    sectionId: row.section_id,
  }));
}

function buildStudentAssignmentListItem(
  row: StudentAssignmentRow,
  attempts: AttemptProjectionRow[],
  submittedAttemptIds: Set<string>,
): StudentAssignmentListItem {
  const policy = parseStoredAssignmentPolicySnapshot(row.policy_snapshot_json);
  const safeExamBrowser = buildStudentSafeExamBrowserSummary(policy);
  const latestAttempt = attempts[0] ?? null;
  const attemptCount = attempts.length;
  const remainingAttempts = Math.max(policy.maxAttempts - attemptCount, 0);
  const availableNow = isAssignmentCurrentlyAvailable(row.status, policy);
  const latestAttemptSubmitted =
    latestAttempt !== null && submittedAttemptIds.has(latestAttempt.id);

  if (!availableNow && !latestAttempt) {
    return {
      assignmentId: row.id,
      assessmentId: row.assessment_id,
      assessmentVersionId: row.assessment_version_id,
      title: row.title,
      availableFrom: policy.availableFrom,
      availableUntil: policy.availableUntil,
      attemptStatus: "ineligible",
      resumeAttemptId: null,
      submittedAttemptId: null,
      attemptCount,
      remainingAttempts,
      canLaunch: false,
      targetSource: row.target_source,
      safeExamBrowser,
    };
  }

  if (latestAttempt && !latestAttemptSubmitted) {
    return {
      assignmentId: row.id,
      assessmentId: row.assessment_id,
      assessmentVersionId: row.assessment_version_id,
      title: row.title,
      availableFrom: policy.availableFrom,
      availableUntil: policy.availableUntil,
      attemptStatus: "in-progress",
      resumeAttemptId: latestAttempt.id,
      submittedAttemptId: null,
      attemptCount,
      remainingAttempts,
      canLaunch: true,
      targetSource: row.target_source,
      safeExamBrowser,
    };
  }

  if (latestAttemptSubmitted) {
    return {
      assignmentId: row.id,
      assessmentId: row.assessment_id,
      assessmentVersionId: row.assessment_version_id,
      title: row.title,
      availableFrom: policy.availableFrom,
      availableUntil: policy.availableUntil,
      attemptStatus: "submitted",
      resumeAttemptId: null,
      submittedAttemptId: latestAttempt!.id,
      attemptCount,
      remainingAttempts,
      canLaunch: availableNow && remainingAttempts > 0,
      targetSource: row.target_source,
      safeExamBrowser,
    };
  }

  return {
    assignmentId: row.id,
    assessmentId: row.assessment_id,
    assessmentVersionId: row.assessment_version_id,
    title: row.title,
    availableFrom: policy.availableFrom,
    availableUntil: policy.availableUntil,
    attemptStatus: "not-started",
    resumeAttemptId: null,
    submittedAttemptId: null,
    attemptCount,
    remainingAttempts,
    canLaunch: availableNow && remainingAttempts > 0,
    targetSource: row.target_source,
    safeExamBrowser,
  };
}

function buildStudentSafeExamBrowserSummary(
  policy: AssignmentPolicySnapshot,
): StudentAssignmentListItem["safeExamBrowser"] {
  const safeExamBrowser = policy.safeExamBrowser ?? null;
  if (!safeExamBrowser) {
    return null;
  }

  const hasConfigKey = Boolean(safeExamBrowser.configKeyHash);
  const hasBrowserExamKeys = (safeExamBrowser.browserExamKeys ?? []).length > 0;
  const generatedConfigAvailable = safeExamBrowser.generatedConfig?.enabled === true;

  return {
    required: policy.secureBrowserRequired,
    configured: hasConfigKey || hasBrowserExamKeys || generatedConfigAvailable,
    generatedConfigAvailable,
  };
}

function isAssignmentCurrentlyAvailable(
  status: AssignmentStatus,
  policy: AssignmentPolicySnapshot,
): boolean {
  if (status !== "active") {
    return false;
  }

  const now = Date.now();
  if (policy.availableFrom && Date.parse(policy.availableFrom) > now) {
    return false;
  }
  if (policy.availableUntil && Date.parse(policy.availableUntil) < now) {
    return false;
  }

  return true;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
