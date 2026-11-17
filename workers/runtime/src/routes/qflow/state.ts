import { readQflowAssessmentState } from "./assessment-state";
import type {
  QflowAssignmentStateResponse,
  ResultExportStateSnapshot,
  ResultRemediationStateSnapshot,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { readAssignment } from "../assignments";
import { requireSignedQflowRequest } from "./signature";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";

interface QflowStateEnv {
  HARBOR_DB: D1Database;
  QFLOW_HANDOFF_SECRET?: string;
}

interface AssignmentResultRow {
  attempt_id: string;
  result_finalization_id: string;
  source_receipt_id: string;
  status: "pending" | "complete" | "failed" | "rescored";
  finalized_at: string | null;
  total_score: number | null;
  max_score: number | null;
  passed: number | null;
}

interface ResultExportRow {
  id: string;
  export_format: "qti3-results-report";
  status: "pending" | "complete" | "failed";
  retry_of_export_id: string | null;
  artifact_path: string | null;
  artifact_content_type: string | null;
  artifact_sha256: string | null;
  artifact_size_bytes: number | null;
  exported_at: string | null;
  error_message: string | null;
  updated_at: string;
}

export async function handleQflowStateRequest(c: AppContext): Promise<Response> {
  return qflowState({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function qflowState(input: {
  request: Request;
  env: QflowStateEnv;
  url: URL;
}): Promise<Response> {
  const { request, env, url } = input;
  const rawBody = await request.text();
  await requireSignedQflowRequest({ request, env, rawBody });
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new LaunchRequestError(400, "Request body must be valid JSON");
  }
  if (body && typeof body === "object" && !Array.isArray(body) && "scope" in body) {
    if (body.scope !== "assessment-version")
      throw new LaunchRequestError(400, "Unknown state scope");
    return readQflowAssessmentState(env.HARBOR_DB, body as Record<string, unknown>);
  }
  const stateRequest = parseStateRequest(rawBody);

  return Response.json(
    await readQflowAssignmentState(
      env.HARBOR_DB,
      stateRequest.assignmentId,
      stateRequest.qflowTenantId,
    ),
    {
      status: 200,
    },
  );
}

async function readQflowAssignmentState(
  db: D1Database,
  assignmentId: string,
  qflowTenantId: string | null,
): Promise<QflowAssignmentStateResponse> {
  const assignment = await readAssignment(db, assignmentId);
  const qflowOwned = qflowTenantId
    ? await hasQflowTenantAssignmentHandoff(db, assignmentId, qflowTenantId)
    : await hasQflowAssignmentHandoff(db, assignmentId);
  if (!qflowOwned) {
    throw new LaunchRequestError(404, "QFlow assignment state not found");
  }

  const latestResult = await readLatestAssignmentResult(db, assignmentId);
  const exportState = latestResult
    ? await readLatestExport(db, latestResult.result_finalization_id)
    : null;
  const remediation = latestResult
    ? await readRemediationStateSnapshot(db, latestResult.attempt_id)
    : emptyRemediationStateSnapshot();

  return {
    assignment: {
      assignmentId: assignment.id,
      assessmentId: assignment.assessmentId,
      assessmentVersionId: assignment.assessmentVersionId,
      title: assignment.title,
      status: assignment.status,
      updatedAt: assignment.updatedAt,
    },
    latestResult: latestResult
      ? {
          attemptId: latestResult.attempt_id,
          sourceReceiptId: latestResult.source_receipt_id,
          status: latestResult.status,
          finalizedAt: latestResult.finalized_at,
          totalScore: latestResult.total_score,
          maxScore: latestResult.max_score,
          passed: latestResult.passed === null ? null : latestResult.passed === 1,
        }
      : null,
    export: exportState ? toResultExportStateSnapshot(exportState) : null,
    remediation,
  };
}

async function hasQflowAssignmentHandoff(db: D1Database, assignmentId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM qflow_handoffs WHERE assignment_id = ? LIMIT 1")
    .bind(assignmentId)
    .first<{ present: number }>();

  return Boolean(row?.present);
}

async function hasQflowTenantAssignmentHandoff(
  db: D1Database,
  assignmentId: string,
  qflowTenantId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS present FROM assignments INNER JOIN qflow_handoffs ON qflow_handoffs.assignment_id = assignments.id INNER JOIN qflow_publish_requests ON qflow_publish_requests.assessment_id = assignments.assessment_id AND qflow_publish_requests.assessment_version_id = assignments.assessment_version_id WHERE assignments.id = ? AND qflow_publish_requests.qflow_tenant_id = ? LIMIT 1",
    )
    .bind(assignmentId, qflowTenantId)
    .first<{ present: number }>();

  return Boolean(row?.present);
}

async function readLatestAssignmentResult(
  db: D1Database,
  assignmentId: string,
): Promise<AssignmentResultRow | null> {
  return db
    .prepare(
      "SELECT attempt_id, result_finalization_id, source_receipt_id, status, finalized_at, total_score, max_score, passed FROM attempt_results WHERE assignment_id = ? ORDER BY submitted_at DESC, updated_at DESC LIMIT 1",
    )
    .bind(assignmentId)
    .first<AssignmentResultRow>();
}

async function readLatestExport(
  db: D1Database,
  resultFinalizationId: string,
): Promise<ResultExportRow | null> {
  return db
    .prepare(
      "SELECT id, export_format, status, retry_of_export_id, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, exported_at, error_message, updated_at FROM result_exports WHERE result_finalization_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(resultFinalizationId)
    .first<ResultExportRow>();
}

async function readRemediationStateSnapshot(
  db: D1Database,
  attemptId: string,
): Promise<ResultRemediationStateSnapshot> {
  const counts = await db
    .prepare(
      "SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count FROM result_remediation_requests WHERE attempt_id = ?",
    )
    .bind(attemptId)
    .first<{
      pending_count: number | null;
      failed_count: number | null;
    }>();
  const latest = await db
    .prepare(
      "SELECT id, scope_kind, status, retry_of_request_id, completed_at, error_message, created_at FROM result_remediation_requests WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(attemptId)
    .first<{
      id: string;
      scope_kind: "result-finalization" | "result-export";
      status: "pending" | "complete" | "failed";
      retry_of_request_id: string | null;
      completed_at: string | null;
      error_message: string | null;
      created_at: string;
    }>();

  return {
    pendingCount: counts?.pending_count ?? 0,
    failedCount: counts?.failed_count ?? 0,
    latestRequest: latest
      ? {
          requestId: latest.id,
          scope: latest.scope_kind,
          status: latest.status,
          retryOfRequestId: latest.retry_of_request_id,
          requestedAt: latest.created_at,
          completedAt: latest.completed_at,
          errorMessage: latest.error_message,
        }
      : null,
  };
}

function emptyRemediationStateSnapshot(): ResultRemediationStateSnapshot {
  return {
    pendingCount: 0,
    failedCount: 0,
    latestRequest: null,
  };
}

function toResultExportStateSnapshot(row: ResultExportRow): ResultExportStateSnapshot {
  return {
    exportId: row.id,
    format: row.export_format,
    status: row.status,
    retryOfExportId: row.retry_of_export_id,
    artifact: row.artifact_path
      ? {
          path: row.artifact_path,
          contentType: row.artifact_content_type ?? "application/octet-stream",
          sha256: row.artifact_sha256,
          sizeBytes: row.artifact_size_bytes,
        }
      : null,
    exportedAt: row.exported_at,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  };
}

function parseStateRequest(rawBody: string): {
  assignmentId: string;
  qflowTenantId: string | null;
} {
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
  return {
    assignmentId: readRequiredString(body.assignmentId, "assignmentId is required"),
    qflowTenantId: readOptionalString(body.qflowTenantId),
  };
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
