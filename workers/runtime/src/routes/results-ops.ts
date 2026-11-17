import type {
  AssignmentActorSnapshot,
  ResultOpsFilterOptionsSnapshot,
  ResultOpsRowContextSnapshot,
  ResultOpsSummarySnapshot,
  ResultExportStateSnapshot,
  ResultRemediationRequestRecord,
  ResultRemediationStateSnapshot,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../launch/create-preview-attempt";
import type { ResultExportEnvelope } from "../queues/result-export";
import type { ResultRemediationWorkflowParams } from "../workflows/result-remediation";
import { assertAttemptBelongsToTenant } from "./tenant-boundary";
import { readAssignmentActor, readJsonObject, readRequiredString } from "./route-request-utils";

interface ResultsOpsEnv {
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET?: string;
  ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH?: string;
  ALLOW_UNSAFE_LOCAL_INSTRUCTOR_TENANT_ID?: string;
  RESULT_EXPORT_QUEUE?: Queue<ResultExportEnvelope>;
  RESULT_REMEDIATION_WORKFLOW?: Workflow<ResultRemediationWorkflowParams>;
}

interface ResultFinalizationRow {
  id: string;
  attempt_id: string;
  assignment_id: string | null;
  assessment_version_id: string;
  source_receipt_id: string;
  status: "pending" | "complete" | "failed";
  error_message: string | null;
  submitted_at: string;
  finalized_at: string | null;
  updated_at: string;
}

interface ResultFinalizationOpsRow extends ResultFinalizationRow {
  assessment_id: string;
  assessment_slug: string;
  assessment_title: string;
  tenant_id: string;
  assignment_title: string | null;
}

interface AttemptResultRow {
  status: "pending" | "complete" | "failed" | "rescored";
  total_score: number | null;
  max_score: number | null;
  passed: number | null;
  finalized_at: string | null;
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

interface ResultRemediationRequestRow {
  id: string;
  attempt_id: string;
  assignment_id: string | null;
  assessment_version_id: string;
  source_receipt_id: string;
  scope_kind: "result-finalization" | "result-export";
  status: "pending" | "complete" | "failed";
  retry_of_request_id: string | null;
  result_finalization_id: string | null;
  result_export_id: string | null;
  requested_by_role: AssignmentActorSnapshot["role"];
  requested_by_id: string;
  requested_by_display_name: string | null;
  reason: string;
  workflow_instance_id: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ResultsOpsFilters {
  tenantId: string | null;
  assignmentId: string | null;
}

interface ResultsOpsRow {
  attemptId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
  context: ResultOpsRowContextSnapshot;
  finalization: {
    finalizationId: string;
    status: "pending" | "complete" | "failed";
    errorMessage: string | null;
    submittedAt: string;
    finalizedAt: string | null;
    updatedAt: string;
  };
  result: {
    status: "pending" | "complete" | "failed" | "rescored";
    totalScore: number | null;
    maxScore: number | null;
    passed: boolean | null;
    finalizedAt: string | null;
  } | null;
  export: ResultExportStateSnapshot | null;
  remediation: ResultRemediationStateSnapshot;
}

export async function getResultsOps(input: {
  env: ResultsOpsEnv;
  tenantId: string;
  request: Request;
}): Promise<Response> {
  const url = new URL(input.request.url);
  return Response.json(await readInstructorResultsOps(input.env, input.tenantId, url), {
    status: 200,
  });
}

export async function postResultsOpsRetry(input: {
  env: ResultsOpsEnv;
  tenantId: string;
  attemptId: string;
  request: Request;
}): Promise<Response> {
  const created = await retryInstructorResultsOpsAttempt(
    input.env,
    input.tenantId,
    input.attemptId,
    input.request,
  );

  return Response.json(
    {
      request: created.request,
      existing: created.existing,
    },
    { status: created.existing ? 200 : 202 },
  );
}

export async function readInstructorResultsOps(
  env: ResultsOpsEnv,
  tenantId: string,
  url: URL,
): Promise<{
  rows: ResultsOpsRow[];
  summary: ResultOpsSummarySnapshot;
  filters: ResultOpsFilterOptionsSnapshot;
}> {
  const filters = readResultsOpsFilters(url, tenantId);
  const allRows = await readResultsOpsRows(env.HARBOR_DB, tenantId);
  return {
    rows: applyResultsOpsFilters(allRows, filters),
    summary: await readResultsOpsSummary(env.HARBOR_DB, filters),
    filters: buildResultsOpsFilterOptions(allRows),
  };
}

export async function retryInstructorResultsOpsAttempt(
  env: ResultsOpsEnv,
  tenantId: string,
  attemptId: string,
  request: Request,
): Promise<{
  existing: boolean;
  request: ResultRemediationRequestRecord;
}> {
  await assertAttemptBelongsToTenant({
    db: env.HARBOR_DB,
    attemptId,
    tenantId,
  });
  const retryRequest = await readRetryRequest(request);
  return createOrReuseRemediationRequest({
    db: env.HARBOR_DB,
    workflow: env.RESULT_REMEDIATION_WORKFLOW,
    attemptId,
    request: retryRequest,
  });
}

async function readResultsOpsRows(db: D1Database, tenantId: string): Promise<ResultsOpsRow[]> {
  const finalizations = await db
    .prepare(
      `SELECT result_finalizations.id,
              result_finalizations.attempt_id,
              result_finalizations.assignment_id,
              result_finalizations.assessment_version_id,
              assessments.id AS assessment_id,
              assessments.slug AS assessment_slug,
              assessments.title AS assessment_title,
              assessments.tenant_id,
              assignments.title AS assignment_title,
              result_finalizations.source_receipt_id,
              result_finalizations.status,
              result_finalizations.error_message,
              result_finalizations.submitted_at,
              result_finalizations.finalized_at,
              result_finalizations.updated_at
         FROM result_finalizations
         INNER JOIN assessment_versions
           ON assessment_versions.id = result_finalizations.assessment_version_id
         INNER JOIN assessments
           ON assessments.id = assessment_versions.assessment_id
         LEFT JOIN assignments
           ON assignments.id = result_finalizations.assignment_id
        WHERE assessments.tenant_id = ?
        ORDER BY result_finalizations.updated_at DESC`,
    )
    .bind(tenantId)
    .all<ResultFinalizationOpsRow>();

  const rows = await Promise.all(
    finalizations.results.map(async (finalization) => {
      const [attemptResult, latestExport, remediation] = await Promise.all([
        readAttemptResult(db, finalization.attempt_id),
        readLatestExport(db, finalization.id),
        readRemediationStateSnapshot(db, finalization.attempt_id),
      ]);

      if (
        finalization.status === "complete" &&
        (!latestExport || latestExport.status === "complete")
      ) {
        return null;
      }

      return {
        attemptId: finalization.attempt_id,
        assignmentId: finalization.assignment_id,
        assessmentVersionId: finalization.assessment_version_id,
        sourceReceiptId: finalization.source_receipt_id,
        context: {
          tenantId: finalization.tenant_id,
          assessmentId: finalization.assessment_id,
          assessmentSlug: finalization.assessment_slug,
          assessmentTitle: finalization.assessment_title,
          assignmentTitle: finalization.assignment_title,
        },
        finalization: {
          finalizationId: finalization.id,
          status: finalization.status,
          errorMessage: finalization.error_message,
          submittedAt: finalization.submitted_at,
          finalizedAt: finalization.finalized_at,
          updatedAt: finalization.updated_at,
        },
        result: attemptResult
          ? {
              status: attemptResult.status,
              totalScore: attemptResult.total_score,
              maxScore: attemptResult.max_score,
              passed: attemptResult.passed === null ? null : attemptResult.passed === 1,
              finalizedAt: attemptResult.finalized_at,
            }
          : null,
        export: latestExport ? toResultExportStateSnapshot(latestExport) : null,
        remediation,
      };
    }),
  );

  return rows.filter((row): row is NonNullable<typeof row> => row !== null);
}

async function readResultsOpsSummary(
  db: D1Database,
  filters: ResultsOpsFilters,
): Promise<ResultOpsSummarySnapshot> {
  const finalizationWhere = buildResultsOpsScopeWhere("result_finalizations", filters);
  const exportsWhere = buildResultsOpsScopeWhere("result_exports", filters);
  const remediationWhere = buildResultsOpsScopeWhere("result_remediation_requests", filters);
  const [finalization, exports, remediation, latestRequest] = await Promise.all([
    firstWithBindings<{
      pending_count: number | null;
      failed_count: number | null;
    }>(
      db,
      `SELECT SUM(CASE WHEN result_finalizations.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN result_finalizations.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
           FROM result_finalizations
           INNER JOIN assessment_versions
             ON assessment_versions.id = result_finalizations.assessment_version_id
           INNER JOIN assessments
             ON assessments.id = assessment_versions.assessment_id${finalizationWhere.clause}`,
      finalizationWhere.bindings,
    ),
    firstWithBindings<{
      pending_count: number | null;
      failed_count: number | null;
      complete_count: number | null;
      retry_pending_count: number | null;
      retry_failed_count: number | null;
      retry_complete_count: number | null;
      latest_updated_at: string | null;
    }>(
      db,
      `SELECT SUM(CASE WHEN result_exports.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN result_exports.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                SUM(CASE WHEN result_exports.status = 'complete' THEN 1 ELSE 0 END) AS complete_count,
                SUM(CASE WHEN result_exports.retry_of_export_id IS NOT NULL AND result_exports.status = 'pending' THEN 1 ELSE 0 END) AS retry_pending_count,
                SUM(CASE WHEN result_exports.retry_of_export_id IS NOT NULL AND result_exports.status = 'failed' THEN 1 ELSE 0 END) AS retry_failed_count,
                SUM(CASE WHEN result_exports.retry_of_export_id IS NOT NULL AND result_exports.status = 'complete' THEN 1 ELSE 0 END) AS retry_complete_count,
                MAX(result_exports.updated_at) AS latest_updated_at
           FROM result_exports
           INNER JOIN assessment_versions
             ON assessment_versions.id = result_exports.assessment_version_id
           INNER JOIN assessments
             ON assessments.id = assessment_versions.assessment_id${exportsWhere.clause}`,
      exportsWhere.bindings,
    ),
    firstWithBindings<{
      pending_count: number | null;
      failed_count: number | null;
      complete_count: number | null;
      export_pending_count: number | null;
      export_failed_count: number | null;
      export_complete_count: number | null;
    }>(
      db,
      `SELECT SUM(CASE WHEN result_remediation_requests.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN result_remediation_requests.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                SUM(CASE WHEN result_remediation_requests.status = 'complete' THEN 1 ELSE 0 END) AS complete_count,
                SUM(CASE WHEN result_remediation_requests.scope_kind = 'result-export' AND result_remediation_requests.status = 'pending' THEN 1 ELSE 0 END) AS export_pending_count,
                SUM(CASE WHEN result_remediation_requests.scope_kind = 'result-export' AND result_remediation_requests.status = 'failed' THEN 1 ELSE 0 END) AS export_failed_count,
                SUM(CASE WHEN result_remediation_requests.scope_kind = 'result-export' AND result_remediation_requests.status = 'complete' THEN 1 ELSE 0 END) AS export_complete_count
           FROM result_remediation_requests
           INNER JOIN assessment_versions
             ON assessment_versions.id = result_remediation_requests.assessment_version_id
           INNER JOIN assessments
             ON assessments.id = assessment_versions.assessment_id${remediationWhere.clause}`,
      remediationWhere.bindings,
    ),
    firstWithBindings<{
      id: string;
      scope_kind: "result-finalization" | "result-export";
      status: "pending" | "complete" | "failed";
      retry_of_request_id: string | null;
      completed_at: string | null;
      error_message: string | null;
      created_at: string;
    }>(
      db,
      `SELECT result_remediation_requests.id,
                result_remediation_requests.scope_kind,
                result_remediation_requests.status,
                result_remediation_requests.retry_of_request_id,
                result_remediation_requests.completed_at,
                result_remediation_requests.error_message,
                result_remediation_requests.created_at
           FROM result_remediation_requests
           INNER JOIN assessment_versions
             ON assessment_versions.id = result_remediation_requests.assessment_version_id
           INNER JOIN assessments
             ON assessments.id = assessment_versions.assessment_id${remediationWhere.clause}
          ORDER BY result_remediation_requests.created_at DESC
          LIMIT 1`,
      remediationWhere.bindings,
    ),
  ]);

  return {
    finalization: {
      pendingCount: finalization?.pending_count ?? 0,
      failedCount: finalization?.failed_count ?? 0,
    },
    exports: {
      pendingCount: exports?.pending_count ?? 0,
      failedCount: exports?.failed_count ?? 0,
      completeCount: exports?.complete_count ?? 0,
      retryPendingCount: exports?.retry_pending_count ?? 0,
      retryFailedCount: exports?.retry_failed_count ?? 0,
      retryCompleteCount: exports?.retry_complete_count ?? 0,
      latestUpdatedAt: exports?.latest_updated_at ?? null,
    },
    remediation: {
      pendingCount: remediation?.pending_count ?? 0,
      failedCount: remediation?.failed_count ?? 0,
      completeCount: remediation?.complete_count ?? 0,
      exportPendingCount: remediation?.export_pending_count ?? 0,
      exportFailedCount: remediation?.export_failed_count ?? 0,
      exportCompleteCount: remediation?.export_complete_count ?? 0,
      latestRequest: latestRequest
        ? {
            requestId: latestRequest.id,
            scope: latestRequest.scope_kind,
            status: latestRequest.status,
            retryOfRequestId: latestRequest.retry_of_request_id,
            requestedAt: latestRequest.created_at,
            completedAt: latestRequest.completed_at,
            errorMessage: latestRequest.error_message,
          }
        : null,
    },
  };
}

function readResultsOpsFilters(url: URL, tenantId: string): ResultsOpsFilters {
  const requestedTenantId = readOptionalFilterParam(url.searchParams.get("tenantId"));
  if (requestedTenantId && requestedTenantId !== tenantId) {
    throw new LaunchRequestError(403, "Requested tenant is outside the session");
  }

  return {
    tenantId,
    assignmentId: readOptionalFilterParam(url.searchParams.get("assignmentId")),
  };
}

function readOptionalFilterParam(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function applyResultsOpsFilters(
  rows: ResultsOpsRow[],
  filters: ResultsOpsFilters,
): ResultsOpsRow[] {
  return rows.filter((row) => {
    if (filters.tenantId && row.context.tenantId !== filters.tenantId) {
      return false;
    }

    if (filters.assignmentId && row.assignmentId !== filters.assignmentId) {
      return false;
    }

    return true;
  });
}

function buildResultsOpsFilterOptions(rows: ResultsOpsRow[]): ResultOpsFilterOptionsSnapshot {
  const tenants = new Map<
    string,
    {
      tenantId: string;
      rowCount: number;
      failedCount: number;
      pendingCount: number;
    }
  >();
  const assignments = new Map<
    string,
    {
      assignmentId: string;
      tenantId: string;
      title: string;
      rowCount: number;
      failedCount: number;
      pendingCount: number;
    }
  >();

  for (const row of rows) {
    const tenant = tenants.get(row.context.tenantId) ?? {
      tenantId: row.context.tenantId,
      rowCount: 0,
      failedCount: 0,
      pendingCount: 0,
    };
    tenant.rowCount += 1;
    tenant.failedCount += isFailedResultsOpsRow(row) ? 1 : 0;
    tenant.pendingCount += isPendingResultsOpsRow(row) ? 1 : 0;
    tenants.set(tenant.tenantId, tenant);

    if (row.assignmentId) {
      const assignment = assignments.get(row.assignmentId) ?? {
        assignmentId: row.assignmentId,
        tenantId: row.context.tenantId,
        title: row.context.assignmentTitle ?? row.assignmentId,
        rowCount: 0,
        failedCount: 0,
        pendingCount: 0,
      };
      assignment.rowCount += 1;
      assignment.failedCount += isFailedResultsOpsRow(row) ? 1 : 0;
      assignment.pendingCount += isPendingResultsOpsRow(row) ? 1 : 0;
      assignments.set(assignment.assignmentId, assignment);
    }
  }

  return {
    tenants: [...tenants.values()].sort((left, right) =>
      left.tenantId.localeCompare(right.tenantId),
    ),
    assignments: [...assignments.values()].sort((left, right) => {
      const tenantOrder = left.tenantId.localeCompare(right.tenantId);
      return tenantOrder === 0 ? left.title.localeCompare(right.title) : tenantOrder;
    }),
  };
}

function isFailedResultsOpsRow(row: ResultsOpsRow): boolean {
  return row.finalization.status === "failed" || row.export?.status === "failed";
}

function isPendingResultsOpsRow(row: ResultsOpsRow): boolean {
  return row.finalization.status === "pending" || row.export?.status === "pending";
}

function buildResultsOpsScopeWhere(
  tableName: string,
  filters: ResultsOpsFilters,
): {
  clause: string;
  bindings: string[];
} {
  const clauses: string[] = [];
  const bindings: string[] = [];

  if (filters.tenantId) {
    clauses.push("assessments.tenant_id = ?");
    bindings.push(filters.tenantId);
  }

  if (filters.assignmentId) {
    clauses.push(`${tableName}.assignment_id = ?`);
    bindings.push(filters.assignmentId);
  }

  return {
    clause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    bindings,
  };
}

function firstWithBindings<T>(
  db: D1Database,
  query: string,
  bindings: string[],
): Promise<T | null> {
  const prepared = db.prepare(query);
  return bindings.length > 0 ? prepared.bind(...bindings).first<T>() : prepared.first<T>();
}

async function createOrReuseRemediationRequest(input: {
  db: D1Database;
  workflow?: Workflow<ResultRemediationWorkflowParams>;
  attemptId: string;
  request: {
    scope: "result-finalization" | "result-export";
    actor: AssignmentActorSnapshot;
    reason: string;
  };
}): Promise<{
  existing: boolean;
  request: ResultRemediationRequestRecord;
}> {
  const finalization = await readLatestFinalization(input.db, input.attemptId);
  if (!finalization) {
    throw new LaunchRequestError(404, "Result finalization record not found");
  }

  const exportRow =
    input.request.scope === "result-export"
      ? await readLatestExport(input.db, finalization.id)
      : null;

  if (input.request.scope === "result-finalization" && finalization.status === "complete") {
    throw new LaunchRequestError(409, "Result finalization is already complete");
  }

  if (input.request.scope === "result-export") {
    if (!exportRow) {
      throw new LaunchRequestError(404, "Result export record not found");
    }
    if (exportRow.status === "complete") {
      throw new LaunchRequestError(409, "Result export is already complete");
    }
  }

  const existingPending = await readPendingRemediationRequest(input.db, {
    attemptId: input.attemptId,
    scope: input.request.scope,
    resultFinalizationId: finalization.id,
    resultExportId: exportRow?.id ?? null,
  });
  if (existingPending) {
    return {
      existing: true,
      request: toRemediationRequestRecord(existingPending),
    };
  }

  if (!input.workflow) {
    throw new LaunchRequestError(500, "Result remediation workflow binding is unavailable");
  }

  const previous = await readLatestScopedRemediationRequest(input.db, {
    attemptId: input.attemptId,
    scope: input.request.scope,
    resultFinalizationId: finalization.id,
    resultExportId: exportRow?.id ?? null,
  });
  const createdAt = new Date().toISOString();
  const requestId = createId("rrem");
  const created: ResultRemediationRequestRow = {
    id: requestId,
    attempt_id: input.attemptId,
    assignment_id: finalization.assignment_id,
    assessment_version_id: finalization.assessment_version_id,
    source_receipt_id: finalization.source_receipt_id,
    scope_kind: input.request.scope,
    status: "pending",
    retry_of_request_id: previous?.id ?? null,
    result_finalization_id: finalization.id,
    result_export_id: exportRow?.id ?? null,
    requested_by_role: input.request.actor.role,
    requested_by_id: input.request.actor.actorId,
    requested_by_display_name: input.request.actor.displayName,
    reason: input.request.reason,
    workflow_instance_id: requestId,
    completed_at: null,
    error_message: null,
    created_at: createdAt,
    updated_at: createdAt,
  };

  await input.db
    .prepare(
      "INSERT INTO result_remediation_requests (id, attempt_id, assignment_id, assessment_version_id, source_receipt_id, scope_kind, status, result_finalization_id, result_export_id, retry_of_request_id, requested_by_role, requested_by_id, requested_by_display_name, reason, workflow_instance_id, completed_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      created.id,
      created.attempt_id,
      created.assignment_id,
      created.assessment_version_id,
      created.source_receipt_id,
      created.scope_kind,
      created.status,
      created.result_finalization_id,
      created.result_export_id,
      created.retry_of_request_id,
      created.requested_by_role,
      created.requested_by_id,
      created.requested_by_display_name,
      created.reason,
      created.workflow_instance_id,
      created.completed_at,
      created.error_message,
      created.created_at,
      created.updated_at,
    )
    .run();

  try {
    await input.workflow.create({
      id: created.id,
      params: {
        requestId: created.id,
      },
    });
  } catch (error) {
    await input.db
      .prepare(
        "UPDATE result_remediation_requests SET status = ?, completed_at = ?, error_message = ?, updated_at = ? WHERE id = ?",
      )
      .bind(
        "failed",
        createdAt,
        error instanceof Error ? error.message : String(error),
        createdAt,
        created.id,
      )
      .run();
    throw new LaunchRequestError(500, "Unable to start result remediation workflow");
  }

  return {
    existing: false,
    request: toRemediationRequestRecord(created),
  };
}

async function readLatestFinalization(
  db: D1Database,
  attemptId: string,
): Promise<ResultFinalizationRow | null> {
  return db
    .prepare(
      "SELECT id, attempt_id, assignment_id, assessment_version_id, source_receipt_id, status, error_message, submitted_at, finalized_at, updated_at FROM result_finalizations WHERE attempt_id = ? ORDER BY submitted_at DESC, created_at DESC LIMIT 1",
    )
    .bind(attemptId)
    .first<ResultFinalizationRow>();
}

async function readAttemptResult(
  db: D1Database,
  attemptId: string,
): Promise<AttemptResultRow | null> {
  return db
    .prepare(
      "SELECT status, total_score, max_score, passed, finalized_at FROM attempt_results WHERE attempt_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(attemptId)
    .first<AttemptResultRow>();
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

async function readPendingRemediationRequest(
  db: D1Database,
  input: {
    attemptId: string;
    scope: "result-finalization" | "result-export";
    resultFinalizationId: string | null;
    resultExportId: string | null;
  },
): Promise<ResultRemediationRequestRow | null> {
  return db
    .prepare(
      "SELECT id, attempt_id, assignment_id, assessment_version_id, source_receipt_id, scope_kind, status, retry_of_request_id, result_finalization_id, result_export_id, requested_by_role, requested_by_id, requested_by_display_name, reason, workflow_instance_id, completed_at, error_message, created_at, updated_at FROM result_remediation_requests WHERE attempt_id = ? AND scope_kind = ? AND status = 'pending' AND COALESCE(result_finalization_id, '') = COALESCE(?, '') AND COALESCE(result_export_id, '') = COALESCE(?, '') ORDER BY created_at DESC LIMIT 1",
    )
    .bind(input.attemptId, input.scope, input.resultFinalizationId, input.resultExportId)
    .first<ResultRemediationRequestRow>();
}

async function readLatestScopedRemediationRequest(
  db: D1Database,
  input: {
    attemptId: string;
    scope: "result-finalization" | "result-export";
    resultFinalizationId: string | null;
    resultExportId: string | null;
  },
): Promise<ResultRemediationRequestRow | null> {
  return db
    .prepare(
      "SELECT id, attempt_id, assignment_id, assessment_version_id, source_receipt_id, scope_kind, status, retry_of_request_id, result_finalization_id, result_export_id, requested_by_role, requested_by_id, requested_by_display_name, reason, workflow_instance_id, completed_at, error_message, created_at, updated_at FROM result_remediation_requests WHERE attempt_id = ? AND scope_kind = ? AND COALESCE(result_finalization_id, '') = COALESCE(?, '') AND COALESCE(result_export_id, '') = COALESCE(?, '') ORDER BY created_at DESC LIMIT 1",
    )
    .bind(input.attemptId, input.scope, input.resultFinalizationId, input.resultExportId)
    .first<ResultRemediationRequestRow>();
}

async function readRetryRequest(request: Request): Promise<{
  scope: "result-finalization" | "result-export";
  actor: AssignmentActorSnapshot;
  reason: string;
}> {
  const body = await readJsonObject(request);
  return {
    scope: readScope(body.scope),
    actor: readAssignmentActor(body.actor),
    reason: readRequiredString(body.reason, "reason is required"),
  };
}

function readScope(value: unknown): "result-finalization" | "result-export" {
  if (value !== "result-finalization" && value !== "result-export") {
    throw new LaunchRequestError(400, "scope must be result-finalization or result-export");
  }

  return value;
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

function toRemediationRequestRecord(
  row: ResultRemediationRequestRow,
): ResultRemediationRequestRecord {
  return {
    requestId: row.id,
    attemptId: row.attempt_id,
    assignmentId: row.assignment_id,
    assessmentVersionId: row.assessment_version_id,
    sourceReceiptId: row.source_receipt_id,
    scope: row.scope_kind,
    status: row.status,
    retryOfRequestId: row.retry_of_request_id,
    resultFinalizationId: row.result_finalization_id,
    resultExportId: row.result_export_id,
    requestedBy: {
      role: row.requested_by_role,
      actorId: row.requested_by_id,
      displayName: row.requested_by_display_name,
    },
    reason: row.reason,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
