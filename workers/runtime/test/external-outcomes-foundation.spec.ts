import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  AuthoritativeResultExportRecord,
  QflowAssignmentStateResponse,
  QflowResultStateResponse,
  ResultExportArtifactLink,
  ResultExportStateSnapshot,
  ResultOpsFilterOptionsSnapshot,
  ResultOpsRowContextSnapshot,
  ResultOpsSummarySnapshot,
  ResultRemediationRequestRecord,
  ResultRemediationStateSnapshot,
} from "@harbor/attempt-protocol";
import {
  RESULT_EXPORT_FORMATS,
  RESULT_EXPORT_STATUSES,
  RESULT_REMEDIATION_SCOPES,
  RESULT_REMEDIATION_STATUSES,
} from "@harbor/attempt-protocol";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetDb(): Promise<void> {
  const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "lti_outcome_deliveries",
    "lti_attempt_launches",
    "result_remediation_requests",
    "result_exports",
    "attempt_result_items",
    "attempt_results",
    "result_finalizations",
    "assignment_learner_overrides",
    "assignments",
    "attempt_entries",
    "assessment_versions",
    "assessments",
  ];

  const tables = await HARBOR_DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${knownTables
      .map(() => "?")
      .join(", ")})`,
  )
    .bind(...knownTables)
    .all<{ name: string }>();

  const deleteStatements = knownTables
    .filter((tableName) => tables.results.some((table) => table.name === tableName))
    .map((tableName) => `DELETE FROM ${tableName}`);

  if (deleteStatements.length > 0) {
    await HARBOR_DB.exec(`${deleteStatements.join("; ")};`);
  }
}

async function readSchema(tableName: string): Promise<string | null> {
  const { HARBOR_DB } = getTestEnv();
  const table = await HARBOR_DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
    .bind(tableName)
    .first<{ sql: string | null }>();

  return table?.sql ?? null;
}

async function readIndexNames(tableName: string): Promise<string[]> {
  const { HARBOR_DB } = getTestEnv();
  const result = await HARBOR_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name ASC",
  )
    .bind(tableName)
    .all<{ name: string }>();

  return result.results.map((row) => row.name);
}

async function tableExists(tableName: string): Promise<boolean> {
  const { HARBOR_DB } = getTestEnv();
  const row = await HARBOR_DB.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
    .bind(tableName)
    .first<{ present: number }>();

  return Boolean(row?.present);
}

beforeEach(async () => {
  await resetDb();
});

describe("external outcome contracts", () => {
  it("defines authoritative result export records, remediation requests, and bounded qflow-facing state responses", () => {
    expect(RESULT_EXPORT_STATUSES).toEqual(["pending", "complete", "failed"]);
    expect(RESULT_EXPORT_FORMATS).toEqual(["qti3-results-report"]);
    expect(RESULT_REMEDIATION_SCOPES).toEqual(["result-finalization", "result-export"]);
    expect(RESULT_REMEDIATION_STATUSES).toEqual(["pending", "complete", "failed"]);

    expectTypeOf<AuthoritativeResultExportRecord>().toEqualTypeOf<{
      exportId: string;
      attemptId: string;
      attemptResultId: string;
      resultFinalizationId: string;
      assignmentId: string | null;
      assessmentVersionId: string;
      sourceReceiptId: string;
      format: "qti3-results-report";
      status: "pending" | "complete" | "failed";
      retryOfExportId: string | null;
      artifact: ResultExportArtifactLink | null;
      exportedAt: string | null;
      errorMessage: string | null;
      createdAt: string;
      updatedAt: string;
    }>();

    expectTypeOf<QflowAssignmentStateResponse>().toEqualTypeOf<{
      assignment: {
        assignmentId: string;
        assessmentId: string;
        assessmentVersionId: string;
        title: string;
        status: "draft" | "active" | "closed";
        updatedAt: string;
      };
      latestResult: {
        attemptId: string;
        sourceReceiptId: string;
        status: "pending" | "complete" | "failed" | "rescored";
        finalizedAt: string | null;
        totalScore: number | null;
        maxScore: number | null;
        passed: boolean | null;
      } | null;
      export: ResultExportStateSnapshot | null;
      remediation: ResultRemediationStateSnapshot;
    }>();

    expectTypeOf<QflowResultStateResponse>().toEqualTypeOf<{
      attemptId: string;
      assignmentId: string | null;
      assessmentVersionId: string;
      sourceReceiptId: string;
      result: {
        status: "pending" | "complete" | "failed" | "rescored";
        finalizedAt: string | null;
        totalScore: number | null;
        maxScore: number | null;
        passed: boolean | null;
      };
      export: ResultExportStateSnapshot | null;
      remediation: ResultRemediationStateSnapshot;
    }>();
  });

  it("expresses pending, complete, and failed work with retry lineage and artifact linkage", () => {
    expectTypeOf<ResultExportArtifactLink>().toEqualTypeOf<{
      path: string;
      contentType: string;
      sha256: string | null;
      sizeBytes: number | null;
    }>();

    expectTypeOf<ResultExportStateSnapshot>().toMatchTypeOf<{
      exportId: string;
      status: "pending" | "complete" | "failed";
      retryOfExportId: string | null;
      artifact: ResultExportArtifactLink | null;
      exportedAt: string | null;
      errorMessage: string | null;
    }>();

    expectTypeOf<ResultRemediationRequestRecord>().toMatchTypeOf<{
      requestId: string;
      scope: "result-finalization" | "result-export";
      status: "pending" | "complete" | "failed";
      retryOfRequestId: string | null;
      resultFinalizationId: string | null;
      resultExportId: string | null;
      reason: string;
      errorMessage: string | null;
    }>();

    expectTypeOf<ResultRemediationStateSnapshot>().toEqualTypeOf<{
      pendingCount: number;
      failedCount: number;
      latestRequest: {
        requestId: string;
        scope: "result-finalization" | "result-export";
        status: "pending" | "complete" | "failed";
        retryOfRequestId: string | null;
        requestedAt: string;
        completedAt: string | null;
        errorMessage: string | null;
      } | null;
    }>();

    expectTypeOf<ResultOpsRowContextSnapshot>().toEqualTypeOf<{
      tenantId: string;
      assessmentId: string;
      assessmentSlug: string;
      assessmentTitle: string;
      assignmentTitle: string | null;
    }>();

    expectTypeOf<ResultOpsFilterOptionsSnapshot>().toEqualTypeOf<{
      tenants: Array<{
        tenantId: string;
        rowCount: number;
        failedCount: number;
        pendingCount: number;
      }>;
      assignments: Array<{
        assignmentId: string;
        tenantId: string;
        title: string;
        rowCount: number;
        failedCount: number;
        pendingCount: number;
      }>;
    }>();

    expectTypeOf<ResultOpsSummarySnapshot>().toMatchTypeOf<{
      exports: {
        pendingCount: number;
        failedCount: number;
        retryCompleteCount: number;
      };
      remediation: {
        pendingCount: number;
        failedCount: number;
        exportCompleteCount: number;
      };
    }>();
  });

  it("exports one vocabulary from the shared package root for worker routes and results-ops consumers", () => {
    expect([
      ...RESULT_EXPORT_STATUSES,
      ...RESULT_REMEDIATION_STATUSES,
      ...RESULT_REMEDIATION_SCOPES,
      ...RESULT_EXPORT_FORMATS,
    ]).toEqual([
      "pending",
      "complete",
      "failed",
      "pending",
      "complete",
      "failed",
      "result-finalization",
      "result-export",
      "qti3-results-report",
    ]);
  });
});

describe("external outcome migration schema", () => {
  it("creates export and remediation ledgers with retry lineage and artifact linkage", async () => {
    const exports = await readSchema("result_exports");
    const remediations = await readSchema("result_remediation_requests");

    expect(exports).toContain('"attempt_result_id" TEXT NOT NULL');
    expect(exports).toContain('"result_finalization_id" TEXT NOT NULL');
    expect(exports).toContain('"source_receipt_id" TEXT NOT NULL');
    expect(exports).toContain('"export_format" TEXT NOT NULL');
    expect(exports).toContain('"artifact_path" TEXT');
    expect(exports).toContain('"artifact_content_type" TEXT');
    expect(exports).toContain('"artifact_sha256" TEXT');
    expect(exports).toContain('"artifact_size_bytes" INTEGER');
    expect(exports).toContain('"retry_of_export_id" TEXT');

    expect(remediations).toContain('"scope_kind" TEXT NOT NULL');
    expect(remediations).toContain('"source_receipt_id" TEXT NOT NULL');
    expect(remediations).toContain('"result_finalization_id" TEXT');
    expect(remediations).toContain('"result_export_id" TEXT');
    expect(remediations).toContain('"retry_of_request_id" TEXT');
    expect(remediations).toContain('"requested_by_role" TEXT NOT NULL');
    expect(remediations).toContain('"requested_by_id" TEXT NOT NULL');
    expect(remediations).toContain('"reason" TEXT NOT NULL');
    expect(remediations).toContain('"workflow_instance_id" TEXT');
  });

  it("adds read-heavy indexes for external state and results-ops queries", async () => {
    const exportIndexes = await readIndexNames("result_exports");
    const remediationIndexes = await readIndexNames("result_remediation_requests");

    expect(exportIndexes).toContain("result_exports_assignment_status_idx");
    expect(exportIndexes).toContain("result_exports_attempt_idx");
    expect(exportIndexes).toContain("result_exports_receipt_idx");

    expect(remediationIndexes).toContain("result_remediation_requests_assignment_status_idx");
    expect(remediationIndexes).toContain("result_remediation_requests_attempt_idx");
    expect(remediationIndexes).toContain("result_remediation_requests_receipt_idx");
  });

  it("tracks LTI Advantage state while keeping broader LMS sync out of scope", async () => {
    const ltiOutcomes = await readSchema("lti_outcome_deliveries");

    expect(ltiOutcomes).toContain('"attempt_result_id" TEXT NOT NULL');
    expect(ltiOutcomes).toContain('"result_finalization_id" TEXT NOT NULL');
    expect(ltiOutcomes).toContain('"lti_session_id" TEXT');
    expect(ltiOutcomes).toContain('"status" TEXT NOT NULL');
    expect(ltiOutcomes).toContain('"score_given" REAL');
    expect(ltiOutcomes).toContain('"score_maximum" REAL');

    expect(await tableExists("lti_sessions")).toBe(true);
    expect(await tableExists("lti_registration_sessions")).toBe(true);
    expect(await tableExists("lms_sync_jobs")).toBe(false);
  });
});
