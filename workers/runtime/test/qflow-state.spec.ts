import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  QFLOW_HANDOFF_SECRET: string;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    QFLOW_HANDOFF_SECRET: string;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "result_remediation_requests",
    "result_exports",
    "attempt_results",
    "result_finalizations",
    "qflow_handoffs",
    "assessment_version_activations",
    "access_codes",
    "attempt_entries",
    "assignments",
    "delivery_artifacts",
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

  let cursor: string | undefined;
  do {
    const listed = await CONTENT_BUCKET.list({ cursor });
    await Promise.all(listed.objects.map((object) => CONTENT_BUCKET.delete(object.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function createFixturePackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifestXml);
  zip.file("items/item-1.xml", itemXml);
  zip.file("assets/stimulus.svg", stimulusSvg);
  return zip.generateAsync({ type: "uint8array" });
}

async function publishFixture(input: { tenantId: string; assessmentSlug: string }): Promise<{
  assessmentId: string;
  assessmentVersionId: string;
  manifestObjectKey: string;
}> {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "qflow-state.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function signBody(body: string): Promise<string> {
  const { QFLOW_HANDOFF_SECRET } = getTestEnv();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(QFLOW_HANDOFF_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));

  return [...new Uint8Array(signature)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function postSignedQflow(path: string, body: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(body);
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harbor-qflow-signature": await signBody(rawBody),
      },
      body: rawBody,
    }),
  );
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function createQflowAssignment(input: {
  assignmentId: string;
  title: string;
  tenantId: string;
  assessmentSlug: string;
}): Promise<{
  assessmentId: string;
  assessmentVersionId: string;
  manifestObjectKey: string;
}> {
  const published = await publishFixture({
    tenantId: input.tenantId,
    assessmentSlug: input.assessmentSlug,
  });

  const response = await postSignedQflow("/internal/qflow/handoff", {
    handoffId: `handoff_${input.assignmentId}`,
    kind: "upsert-assignment",
    assignmentId: input.assignmentId,
    assessmentId: published.assessmentId,
    assessmentVersionId: published.assessmentVersionId,
    title: input.title,
    status: "active",
    actorId: "qflow_system",
    actorDisplayName: "qflowlearn",
    issuedAt: "2026-03-28T12:00:00.000Z",
    policySnapshot: {
      availableFrom: "2026-03-28T12:00:00.000Z",
      availableUntil: "2026-03-29T12:00:00.000Z",
      reportingTimezone: "America/New_York",
      maxAttempts: 2,
      timeLimitSeconds: 1200,
      gracePeriodSeconds: 30,
      navigationMode: "free",
      standaloneAllowed: true,
      iframeAllowed: false,
      allowedEmbedOrigins: [],
      secureBrowserRequired: false,
      secureBrowserProviderHint: null,
      proctoringProvider: null,
    },
  });

  expect(response.status).toBe(200);
  return published;
}

async function seedAssignmentResultState(input: {
  assignmentId: string;
  assessmentVersionId: string;
  manifestObjectKey: string;
  attemptId: string;
  resultFinalizationId: string;
  attemptResultId: string;
  sourceReceiptId: string;
  submittedAt: string;
  finalizedAt: string;
  resultStatus: "pending" | "complete" | "failed" | "rescored";
  totalScore: number | null;
  maxScore: number | null;
  passed: number | null;
  exportId: string;
  exportStatus: "pending" | "complete" | "failed";
  exportedAt: string | null;
  exportErrorMessage: string | null;
  remediationRequestId: string;
  remediationStatus: "pending" | "complete" | "failed";
  remediationScope: "result-finalization" | "result-export";
  remediationCompletedAt: string | null;
  remediationErrorMessage: string | null;
}): Promise<void> {
  const createdAt = "2026-03-28T12:10:00.000Z";
  await getTestEnv().HARBOR_DB.batch([
    getTestEnv()
      .HARBOR_DB.prepare(
        "INSERT INTO attempt_entries (id, assessment_version_id, access_code_id, launch_mode, actor_kind, actor_id, actor_display_name, delivery_policy_snapshot, manifest_object_key, current_item_id, current_item_href, created_at, assignment_id, assignment_policy_snapshot, launch_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.attemptId,
        input.assessmentVersionId,
        null,
        "preview",
        "preview-operator",
        `actor_${input.attemptId}`,
        "Preview Operator",
        JSON.stringify({
          mode: "preview",
          navigationMode: "free",
        }),
        input.manifestObjectKey,
        "item-1",
        "items/item-1.xml",
        createdAt,
        input.assignmentId,
        JSON.stringify({
          maxAttempts: 2,
        }),
        JSON.stringify({
          launchedAt: createdAt,
        }),
      ),
    getTestEnv()
      .HARBOR_DB.prepare(
        "INSERT INTO result_finalizations (id, attempt_id, assessment_version_id, assignment_id, source_receipt_id, source_sequence_number, status, materialized_from, submitted_at, finalized_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.resultFinalizationId,
        input.attemptId,
        input.assessmentVersionId,
        input.assignmentId,
        input.sourceReceiptId,
        1,
        "complete",
        "durable-object",
        input.submittedAt,
        input.finalizedAt,
        null,
        createdAt,
        input.finalizedAt,
      ),
    getTestEnv()
      .HARBOR_DB.prepare(
        "INSERT INTO attempt_results (id, attempt_id, result_finalization_id, assessment_version_id, assignment_id, source_receipt_id, status, summary_source, total_score, max_score, passed, test_outcome_variables_json, submitted_at, finalized_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.attemptResultId,
        input.attemptId,
        input.resultFinalizationId,
        input.assessmentVersionId,
        input.assignmentId,
        input.sourceReceiptId,
        input.resultStatus,
        "qti3-item-results",
        input.totalScore,
        input.maxScore,
        input.passed,
        "[]",
        input.submittedAt,
        input.finalizedAt,
        createdAt,
        input.finalizedAt,
      ),
    getTestEnv()
      .HARBOR_DB.prepare(
        "INSERT INTO result_exports (id, attempt_id, attempt_result_id, result_finalization_id, assignment_id, assessment_version_id, source_receipt_id, export_format, status, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, retry_of_export_id, exported_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.exportId,
        input.attemptId,
        input.attemptResultId,
        input.resultFinalizationId,
        input.assignmentId,
        input.assessmentVersionId,
        input.sourceReceiptId,
        "qti3-results-report",
        input.exportStatus,
        input.exportStatus === "complete" ? `results/${input.exportId}.xml` : null,
        input.exportStatus === "complete" ? "application/xml" : null,
        input.exportStatus === "complete" ? `sha256-${input.exportId}` : null,
        input.exportStatus === "complete" ? 512 : null,
        null,
        input.exportedAt,
        input.exportErrorMessage,
        createdAt,
        input.finalizedAt,
      ),
    getTestEnv()
      .HARBOR_DB.prepare(
        "INSERT INTO result_remediation_requests (id, attempt_id, assignment_id, assessment_version_id, source_receipt_id, scope_kind, status, result_finalization_id, result_export_id, retry_of_request_id, requested_by_role, requested_by_id, requested_by_display_name, reason, workflow_instance_id, completed_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.remediationRequestId,
        input.attemptId,
        input.assignmentId,
        input.assessmentVersionId,
        input.sourceReceiptId,
        input.remediationScope,
        input.remediationStatus,
        input.resultFinalizationId,
        input.exportId,
        null,
        "qflow",
        "qflow_system",
        "qflowlearn",
        "retry export state",
        `workflow_${input.remediationRequestId}`,
        input.remediationCompletedAt,
        input.remediationErrorMessage,
        createdAt,
        input.finalizedAt,
      ),
  ]);
}

beforeEach(async () => {
  await resetBindings();
});

describe("qflow state route", () => {
  it("exposes bounded assignment, result, export, and remediation state without leaking internal fields", async () => {
    const assignment = await createQflowAssignment({
      assignmentId: "assign_qflow_state_shape_01",
      title: "QFlow State Shape",
      tenantId: "tenant_qflow_state",
      assessmentSlug: "qflow-state-shape",
    });

    await seedAssignmentResultState({
      assignmentId: "assign_qflow_state_shape_01",
      assessmentVersionId: assignment.assessmentVersionId,
      manifestObjectKey: assignment.manifestObjectKey,
      attemptId: "attempt_qflow_state_shape_01",
      resultFinalizationId: "rfin_qflow_state_shape_01",
      attemptResultId: "ares_qflow_state_shape_01",
      sourceReceiptId: "receipt_qflow_state_shape_01",
      submittedAt: "2026-03-28T12:20:00.000Z",
      finalizedAt: "2026-03-28T12:21:00.000Z",
      resultStatus: "complete",
      totalScore: 8,
      maxScore: 10,
      passed: 1,
      exportId: "rexp_qflow_state_shape_01",
      exportStatus: "failed",
      exportedAt: null,
      exportErrorMessage: "Downstream sync failed",
      remediationRequestId: "rrem_qflow_state_shape_01",
      remediationStatus: "pending",
      remediationScope: "result-export",
      remediationCompletedAt: null,
      remediationErrorMessage: null,
    });

    const response = await postSignedQflow("/internal/qflow/state", {
      assignmentId: "assign_qflow_state_shape_01",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      assignment: {
        assignmentId: "assign_qflow_state_shape_01",
        assessmentId: assignment.assessmentId,
        assessmentVersionId: assignment.assessmentVersionId,
        title: "QFlow State Shape",
        status: "active",
        updatedAt: expect.any(String),
      },
      latestResult: {
        attemptId: "attempt_qflow_state_shape_01",
        sourceReceiptId: "receipt_qflow_state_shape_01",
        status: "complete",
        finalizedAt: "2026-03-28T12:21:00.000Z",
        totalScore: 8,
        maxScore: 10,
        passed: true,
      },
      export: {
        exportId: "rexp_qflow_state_shape_01",
        format: "qti3-results-report",
        status: "failed",
        retryOfExportId: null,
        artifact: null,
        exportedAt: null,
        errorMessage: "Downstream sync failed",
        updatedAt: "2026-03-28T12:21:00.000Z",
      },
      remediation: {
        pendingCount: 1,
        failedCount: 0,
        latestRequest: {
          requestId: "rrem_qflow_state_shape_01",
          scope: "result-export",
          status: "pending",
          retryOfRequestId: null,
          requestedAt: "2026-03-28T12:10:00.000Z",
          completedAt: null,
          errorMessage: null,
        },
      },
    });
  });

  it("reads current Harbor assignment data and the latest authoritative result ledgers instead of qflow handoff history", async () => {
    const assignment = await createQflowAssignment({
      assignmentId: "assign_qflow_state_authority_01",
      title: "Original QFlow Title",
      tenantId: "tenant_qflow_state",
      assessmentSlug: "qflow-state-authority",
    });

    await getTestEnv()
      .HARBOR_DB.prepare("UPDATE assignments SET title = ?, updated_at = ? WHERE id = ?")
      .bind("Harbor Updated Title", "2026-03-28T12:45:00.000Z", "assign_qflow_state_authority_01")
      .run();

    await seedAssignmentResultState({
      assignmentId: "assign_qflow_state_authority_01",
      assessmentVersionId: assignment.assessmentVersionId,
      manifestObjectKey: assignment.manifestObjectKey,
      attemptId: "attempt_qflow_state_old_01",
      resultFinalizationId: "rfin_qflow_state_old_01",
      attemptResultId: "ares_qflow_state_old_01",
      sourceReceiptId: "receipt_qflow_state_old_01",
      submittedAt: "2026-03-28T12:20:00.000Z",
      finalizedAt: "2026-03-28T12:21:00.000Z",
      resultStatus: "complete",
      totalScore: 6,
      maxScore: 10,
      passed: 0,
      exportId: "rexp_qflow_state_old_01",
      exportStatus: "complete",
      exportedAt: "2026-03-28T12:22:00.000Z",
      exportErrorMessage: null,
      remediationRequestId: "rrem_qflow_state_old_01",
      remediationStatus: "complete",
      remediationScope: "result-export",
      remediationCompletedAt: "2026-03-28T12:23:00.000Z",
      remediationErrorMessage: null,
    });
    await seedAssignmentResultState({
      assignmentId: "assign_qflow_state_authority_01",
      assessmentVersionId: assignment.assessmentVersionId,
      manifestObjectKey: assignment.manifestObjectKey,
      attemptId: "attempt_qflow_state_new_01",
      resultFinalizationId: "rfin_qflow_state_new_01",
      attemptResultId: "ares_qflow_state_new_01",
      sourceReceiptId: "receipt_qflow_state_new_01",
      submittedAt: "2026-03-28T12:40:00.000Z",
      finalizedAt: "2026-03-28T12:41:00.000Z",
      resultStatus: "rescored",
      totalScore: 9,
      maxScore: 10,
      passed: 1,
      exportId: "rexp_qflow_state_new_01",
      exportStatus: "complete",
      exportedAt: "2026-03-28T12:42:00.000Z",
      exportErrorMessage: null,
      remediationRequestId: "rrem_qflow_state_new_01",
      remediationStatus: "failed",
      remediationScope: "result-export",
      remediationCompletedAt: "2026-03-28T12:43:00.000Z",
      remediationErrorMessage: "Retry failed",
    });

    const response = await postSignedQflow("/internal/qflow/state", {
      assignmentId: "assign_qflow_state_authority_01",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      assignment: {
        assignmentId: "assign_qflow_state_authority_01",
        title: "Harbor Updated Title",
        updatedAt: "2026-03-28T12:45:00.000Z",
      },
      latestResult: {
        attemptId: "attempt_qflow_state_new_01",
        sourceReceiptId: "receipt_qflow_state_new_01",
        status: "rescored",
        totalScore: 9,
        maxScore: 10,
        passed: true,
      },
      export: {
        exportId: "rexp_qflow_state_new_01",
        status: "complete",
      },
      remediation: {
        pendingCount: 0,
        failedCount: 1,
        latestRequest: {
          requestId: "rrem_qflow_state_new_01",
          status: "failed",
          errorMessage: "Retry failed",
        },
      },
    });
  });

  it("keeps the route narrow by rejecting missing or non-qflow assignments", async () => {
    const published = await publishFixture({
      tenantId: "tenant_qflow_state",
      assessmentSlug: "qflow-state-narrow",
    });

    const createInstructorAssignment = await postJson("/internal/assignments", {
      assignmentId: "assign_instructor_only_01",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Instructor Only Assignment",
      actor: {
        role: "instructor",
        actorId: "inst_01",
        displayName: "Instructor One",
      },
      policySnapshot: {
        availableFrom: "2026-03-28T12:00:00.000Z",
        availableUntil: "2026-03-29T12:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 2,
        timeLimitSeconds: 1200,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
    });

    expect(createInstructorAssignment.status).toBe(201);

    const missingIdResponse = await postSignedQflow("/internal/qflow/state", {});
    expect(missingIdResponse.status).toBe(400);

    const instructorAssignmentResponse = await postSignedQflow("/internal/qflow/state", {
      assignmentId: "assign_instructor_only_01",
    });
    expect(instructorAssignmentResponse.status).toBe(404);
  });
});
