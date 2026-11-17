import JSZip from "jszip";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BootstrapEnvelope,
  BootstrapPayload,
  CommitAttemptEventReceipt,
} from "@harbor/attempt-protocol";
import runtimeWorker, { type Env as RuntimeEnv } from "../src/index";
import {
  buildSubmitFinalizationEnvelope,
  consumeSubmitFinalizationBatch,
  SUBMIT_FINALIZATION_QUEUE_NAME,
  type SubmitFinalizationEnvelope,
} from "../src/queues/submit-finalization";
import {
  consumeResultExportBatch,
  RESULT_EXPORT_QUEUE_NAME,
  type ResultExportEnvelope,
} from "../src/queues/result-export";
import { executeResultRemediationRequest } from "../src/workflows/result-remediation";
import { createQueueMock } from "./queue-mock";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const RESULTS_OPS_TENANT_ID = "tenant_results_ops";
const scoredItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-1" title="Addition Warmup" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response>
      <qti-value>choice-a</qti-value>
    </qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>1</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-prompt>What is 2 + 2?</qti-prompt>
    <div>
      <img src="../assets/stimulus.svg" alt="Decorative Harbor stimulus"/>
    </div>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-simple-choice identifier="choice-a">4</qti-simple-choice>
      <qti-simple-choice identifier="choice-b">5</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

function getBaseEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET: string;
  LTI_TOOL_PRIVATE_KEY_JWK: string;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
  TEST_MIGRATIONS: Array<{
    name: string;
    queries: string[];
  }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    BOOTSTRAP_SIGNING_SECRET: string;
    LTI_TOOL_PRIVATE_KEY_JWK: string;
    ATTEMPT_COORDINATOR: DurableObjectNamespace;
    ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
    TEST_MIGRATIONS: Array<{
      name: string;
      queries: string[];
    }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getBaseEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "result_remediation_requests",
    "result_exports",
    "attempt_result_items",
    "attempt_results",
    "result_finalizations",
    "qflow_handoffs",
    "assessment_version_activations",
    "attempt_timeline_events",
    "attempt_policy_commands",
    "attempt_policy_overlays",
    "attempt_entries",
    "access_codes",
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
  zip.file("items/item-1.xml", scoredItemXml);
  zip.file("assets/stimulus.svg", stimulusSvg);
  return zip.generateAsync({ type: "uint8array" });
}

async function publishFixture(input: { tenantId: string; assessmentSlug: string }): Promise<{
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "basic-assessment.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
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

async function launchPreviewAttempt(slug: string): Promise<BootstrapPayload> {
  const published = await publishFixture({
    tenantId: RESULTS_OPS_TENANT_ID,
    assessmentSlug: slug,
  });
  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: published.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: `${slug}_preview`,
      displayName: `Preview ${slug}`,
    },
  });

  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const bootstrap = await postJson("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: `${slug}_session`,
  });

  expect(bootstrap.status).toBe(200);
  return bootstrap.json<BootstrapPayload>();
}

function buildRuntimeEnv(input?: {
  attemptCoordinator?: DurableObjectNamespace;
  sendSubmit?: (message: SubmitFinalizationEnvelope) => Promise<void>;
  sendResultExport?: (message: ResultExportEnvelope) => Promise<void>;
  createRemediationWorkflow?: (requestId: string) => Promise<void>;
}): RuntimeEnv {
  const base = getBaseEnv();
  return {
    HARBOR_DB: base.HARBOR_DB,
    CONTENT_BUCKET: base.CONTENT_BUCKET,
    BOOTSTRAP_SIGNING_SECRET: base.BOOTSTRAP_SIGNING_SECRET,
    ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH: "true",
    ALLOW_UNSAFE_LOCAL_INSTRUCTOR_TENANT_ID: RESULTS_OPS_TENANT_ID,
    LTI_TOOL_PRIVATE_KEY_JWK: base.LTI_TOOL_PRIVATE_KEY_JWK,
    ATTEMPT_COORDINATOR: input?.attemptCoordinator ?? base.ATTEMPT_COORDINATOR,
    ATTEMPT_RUNTIME_METRICS: base.ATTEMPT_RUNTIME_METRICS,
    SUBMIT_FINALIZATION_QUEUE: createQueueMock<SubmitFinalizationEnvelope>({
      send:
        input?.sendSubmit ??
        (async () => {
          throw new Error("SUBMIT_FINALIZATION_QUEUE.send was not stubbed");
        }),
      sendBatchError: "sendBatch is not used in results-ops tests",
    }),
    RESULT_EXPORT_QUEUE: createQueueMock<ResultExportEnvelope>({
      send:
        input?.sendResultExport ??
        (async () => {
          throw new Error("RESULT_EXPORT_QUEUE.send was not stubbed");
        }),
      sendBatchError: "sendBatch is not used in results-ops tests",
    }),
    RESULT_REMEDIATION_WORKFLOW: {
      async create(options?: { id?: string; params?: { requestId: string } }) {
        await input?.createRemediationWorkflow?.(options?.params?.requestId ?? "");
        return {
          id: options?.id ?? "workflow_result_remediation_test",
        };
      },
      async get() {
        throw new Error("Workflow get is not used in results-ops tests");
      },
      async createBatch() {
        throw new Error("Workflow createBatch is not used in results-ops tests");
      },
    } as unknown as RuntimeEnv["RESULT_REMEDIATION_WORKFLOW"],
  };
}

async function fetchWithRuntimeEnv(
  runtimeEnv: RuntimeEnv,
  request: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  return (
    runtimeWorker.fetch as unknown as (
      request: Request,
      env: RuntimeEnv,
      ctx: ExecutionContext,
    ) => Promise<Response>
  )(request, runtimeEnv, ctx);
}

async function postAttemptEvent(input: {
  runtimeEnv: RuntimeEnv;
  attemptId: string;
  body: Record<string, unknown>;
}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await fetchWithRuntimeEnv(
    input.runtimeEnv,
    new Request(`https://harbor.local/api/attempts/${input.attemptId}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
    }),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function submitAttemptWithAuthoritativeMaterialization(input: {
  runtimeEnv: RuntimeEnv;
  payload: BootstrapPayload;
  clientSessionId: string;
}): Promise<CommitAttemptEventReceipt> {
  const response = await postAttemptEvent({
    runtimeEnv: input.runtimeEnv,
    attemptId: input.payload.attemptId,
    body: {
      attemptId: input.payload.attemptId,
      eventId: "evt_submit_results_ops_01",
      idempotencyKey: `idem_${input.payload.attemptId}`,
      sequenceNumber: 1,
      clientTimestamp: "2026-03-28T18:00:00.000Z",
      clientSessionId: input.clientSessionId,
      itemRef: input.payload.session.currentItemRef,
      type: "submit.requested",
      payload: {
        requestedAt: "2026-03-28T18:00:00.000Z",
        submissionMaterialization: {
          itemOrder: [input.payload.session.currentItemRef.itemId],
          testState: {
            identifier: "assessment-test",
            outcomeVariables: [
              { identifier: "SCORE", value: 1 },
              { identifier: "MAXSCORE", value: 1 },
              { identifier: "PASSED", value: true },
            ],
          },
          partStates: {},
          sectionStates: {},
          items: {
            [input.payload.session.currentItemRef.itemId]: {
              itemId: input.payload.session.currentItemRef.itemId,
              itemIdentifier: "item-1",
              itemTitle: "Example item",
              capturedAt: "2026-03-28T18:00:00.000Z",
              responseVariables: [
                {
                  identifier: "RESPONSE",
                  value: "choice-a",
                },
              ],
              outcomeVariables: [
                {
                  identifier: "SCORE",
                  value: 1,
                },
                {
                  identifier: "MAXSCORE",
                  value: 1,
                },
              ],
              validationMessages: [],
            },
          },
        },
      },
    },
  });

  expect(response.status).toBe(200);
  return response.json<CommitAttemptEventReceipt>();
}

function createFailingAttemptCoordinator(message: string): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get() {
      return {
        fetch: async () =>
          Response.json(
            {
              error: message,
            },
            { status: 500 },
          ),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

async function createPendingExportState(slug: string): Promise<{
  attemptId: string;
  assessmentVersionId: string;
  sourceReceiptId: string;
  finalizationId: string;
  exportId: string;
}> {
  const clientSessionId = `${slug}_session`;
  const payload = await launchPreviewAttempt(slug);
  const queuedSubmits: SubmitFinalizationEnvelope[] = [];
  const queuedExports: ResultExportEnvelope[] = [];
  const runtimeEnv = buildRuntimeEnv({
    sendSubmit: vi.fn(async (message) => {
      queuedSubmits.push(message);
    }),
    sendResultExport: vi.fn(async (message) => {
      queuedExports.push(message);
    }),
  });

  const receipt = await submitAttemptWithAuthoritativeMaterialization({
    runtimeEnv,
    payload,
    clientSessionId,
  });
  const submitBatch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
    {
      id: `msg_${slug}_submit`,
      timestamp: new Date(receipt.serverTimestamp),
      attempts: 1,
      body: queuedSubmits[0],
    },
  ]);

  await consumeSubmitFinalizationBatch(submitBatch, {
    HARBOR_DB: getBaseEnv().HARBOR_DB,
    CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
    ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
    ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
    RESULT_EXPORT_QUEUE: runtimeEnv.RESULT_EXPORT_QUEUE,
  });

  const pending = await getBaseEnv()
    .HARBOR_DB.prepare(
      "SELECT id, result_finalization_id, assessment_version_id FROM result_exports WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(payload.attemptId)
    .first<{
      id: string;
      result_finalization_id: string;
      assessment_version_id: string;
    }>();

  expect(pending).toBeTruthy();
  return {
    attemptId: payload.attemptId,
    assessmentVersionId: pending!.assessment_version_id,
    sourceReceiptId: receipt.receiptId,
    finalizationId: pending!.result_finalization_id,
    exportId: pending!.id,
  };
}

async function createFailedExportState(slug: string): Promise<{
  attemptId: string;
  assessmentVersionId: string;
  sourceReceiptId: string;
  finalizationId: string;
  exportId: string;
}> {
  const pending = await createPendingExportState(slug);
  const exportBatch = createMessageBatch(RESULT_EXPORT_QUEUE_NAME, [
    {
      id: `msg_${slug}_export`,
      timestamp: new Date(),
      attempts: 1,
      body: {
        exportId: pending.exportId,
        attemptId: pending.attemptId,
        sourceReceiptId: pending.sourceReceiptId,
      },
    },
  ]);

  await consumeResultExportBatch(exportBatch, {
    HARBOR_DB: getBaseEnv().HARBOR_DB,
    CONTENT_BUCKET: {
      async put() {
        throw new Error("Results ops export failure");
      },
    } as unknown as R2Bucket,
  });

  return pending;
}

async function createFailedFinalizationState(slug: string): Promise<{
  attemptId: string;
  assessmentVersionId: string;
  sourceReceiptId: string;
  finalizationId: string;
}> {
  const clientSessionId = `${slug}_session`;
  const payload = await launchPreviewAttempt(slug);
  const queuedSubmits: SubmitFinalizationEnvelope[] = [];
  const queuedExports: ResultExportEnvelope[] = [];
  const runtimeEnv = buildRuntimeEnv({
    sendSubmit: vi.fn(async (message) => {
      queuedSubmits.push(message);
    }),
    sendResultExport: vi.fn(async (message) => {
      queuedExports.push(message);
    }),
  });

  const receipt = await submitAttemptWithAuthoritativeMaterialization({
    runtimeEnv,
    payload,
    clientSessionId,
  });
  const submitBatch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
    {
      id: `msg_${slug}_submit_failed`,
      timestamp: new Date(receipt.serverTimestamp),
      attempts: 1,
      body: queuedSubmits[0],
    },
  ]);

  await consumeSubmitFinalizationBatch(submitBatch, {
    HARBOR_DB: getBaseEnv().HARBOR_DB,
    CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
    ATTEMPT_COORDINATOR: createFailingAttemptCoordinator("Results ops materialization failure"),
    ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
    RESULT_EXPORT_QUEUE: runtimeEnv.RESULT_EXPORT_QUEUE,
  });

  const failed = await getBaseEnv()
    .HARBOR_DB.prepare(
      "SELECT id, assessment_version_id FROM result_finalizations WHERE source_receipt_id = ?",
    )
    .bind(receipt.receiptId)
    .first<{
      id: string;
      assessment_version_id: string;
    }>();

  expect(failed).toBeTruthy();
  return {
    attemptId: payload.attemptId,
    assessmentVersionId: failed!.assessment_version_id,
    sourceReceiptId: receipt.receiptId,
    finalizationId: failed!.id,
  };
}

async function createAssignmentForVersion(input: {
  assessmentVersionId: string;
  assignmentId: string;
  title: string;
}): Promise<void> {
  const version = await getBaseEnv()
    .HARBOR_DB.prepare("SELECT assessment_id FROM assessment_versions WHERE id = ?")
    .bind(input.assessmentVersionId)
    .first<{ assessment_id: string }>();
  expect(version).toBeTruthy();

  const now = new Date().toISOString();
  await getBaseEnv()
    .HARBOR_DB.prepare(
      "INSERT INTO assignments (id, assessment_id, assessment_version_id, title, status, policy_snapshot_json, created_by_role, created_by_id, created_by_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      input.assignmentId,
      version!.assessment_id,
      input.assessmentVersionId,
      input.title,
      "active",
      "{}",
      "operator",
      "ops_test",
      "Ops Test",
      now,
      now,
    )
    .run();
}

async function attachAssignmentToResultState(input: {
  attemptId: string;
  assignmentId: string;
}): Promise<void> {
  await getBaseEnv().HARBOR_DB.batch([
    getBaseEnv()
      .HARBOR_DB.prepare("UPDATE attempt_entries SET assignment_id = ? WHERE id = ?")
      .bind(input.assignmentId, input.attemptId),
    getBaseEnv()
      .HARBOR_DB.prepare("UPDATE result_finalizations SET assignment_id = ? WHERE attempt_id = ?")
      .bind(input.assignmentId, input.attemptId),
    getBaseEnv()
      .HARBOR_DB.prepare("UPDATE attempt_results SET assignment_id = ? WHERE attempt_id = ?")
      .bind(input.assignmentId, input.attemptId),
    getBaseEnv()
      .HARBOR_DB.prepare("UPDATE result_exports SET assignment_id = ? WHERE attempt_id = ?")
      .bind(input.assignmentId, input.attemptId),
  ]);
}

async function insertRemediationRequest(input: {
  requestId: string;
  attemptId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
  scopeKind: string;
  status: string;
  resultFinalizationId: string | null;
  resultExportId: string | null;
  retryOfRequestId?: string | null;
  workflowInstanceId?: string | null;
  completedAt?: string | null;
}): Promise<void> {
  const now = "2026-03-28T18:10:00.000Z";
  await getBaseEnv()
    .HARBOR_DB.prepare(
      "INSERT INTO result_remediation_requests (id, attempt_id, assignment_id, assessment_version_id, source_receipt_id, scope_kind, status, result_finalization_id, result_export_id, retry_of_request_id, requested_by_role, requested_by_id, requested_by_display_name, reason, workflow_instance_id, completed_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      input.requestId,
      input.attemptId,
      input.assignmentId,
      input.assessmentVersionId,
      input.sourceReceiptId,
      input.scopeKind,
      input.status,
      input.resultFinalizationId,
      input.resultExportId,
      input.retryOfRequestId ?? null,
      "operator",
      "ops_01",
      "Results Ops",
      "Retry stalled processing",
      input.workflowInstanceId ?? null,
      input.completedAt ?? null,
      input.status === "failed" ? "Prior remediation failed" : null,
      now,
      now,
    )
    .run();
}

beforeEach(async () => {
  await resetBindings();
});

describe("results ops routes and remediation workflow", () => {
  it("reads pending and failed result-processing rows with enough state to distinguish current work from historical retries", async () => {
    const failedFinalization = await createFailedFinalizationState("results-ops-finalization");
    await insertRemediationRequest({
      requestId: "rrem_failed_history_01",
      attemptId: failedFinalization.attemptId,
      assignmentId: null,
      assessmentVersionId: failedFinalization.assessmentVersionId,
      sourceReceiptId: failedFinalization.sourceReceiptId,
      scopeKind: "result-finalization",
      status: "failed",
      resultFinalizationId: failedFinalization.finalizationId,
      resultExportId: null,
      completedAt: "2026-03-28T18:12:00.000Z",
    });

    const pendingExport = await createPendingExportState("results-ops-pending");
    await createAssignmentForVersion({
      assessmentVersionId: pendingExport.assessmentVersionId,
      assignmentId: "assign_results_ops_pending",
      title: "Results Ops Pending Assignment",
    });
    await attachAssignmentToResultState({
      attemptId: pendingExport.attemptId,
      assignmentId: "assign_results_ops_pending",
    });
    const runtimeEnv = buildRuntimeEnv({
      sendSubmit: vi.fn(async () => {}),
      sendResultExport: vi.fn(async () => {}),
    });

    const response = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request("https://harbor.local/api/instructor/results-ops"),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    const payload = await response.json<{
      summary: {
        finalization: {
          pendingCount: number;
          failedCount: number;
        };
        exports: {
          pendingCount: number;
          failedCount: number;
          retryPendingCount: number;
        };
        remediation: {
          pendingCount: number;
          failedCount: number;
          exportCompleteCount: number;
        };
      };
      filters: {
        tenants: Array<{
          tenantId: string;
          rowCount: number;
        }>;
        assignments: Array<{
          assignmentId: string;
          tenantId: string;
          title: string;
          rowCount: number;
        }>;
      };
      rows: Array<{
        attemptId: string;
        assignmentId: string | null;
        context: {
          tenantId: string;
          assignmentTitle: string | null;
        };
        finalization: {
          status: string;
          errorMessage: string | null;
        };
        export: {
          status: string;
        } | null;
        remediation: {
          failedCount: number;
          latestRequest: {
            scope: string;
            status: string;
          } | null;
        };
      }>;
    }>();

    expect(payload.summary).toMatchObject({
      finalization: {
        pendingCount: 0,
        failedCount: 1,
      },
      exports: {
        pendingCount: 1,
        failedCount: 0,
        retryPendingCount: 0,
      },
      remediation: {
        pendingCount: 0,
        failedCount: 1,
        exportCompleteCount: 0,
      },
    });
    expect(payload.filters.tenants).toEqual([
      expect.objectContaining({
        tenantId: RESULTS_OPS_TENANT_ID,
        rowCount: 2,
      }),
    ]);
    expect(payload.filters.assignments).toEqual([
      expect.objectContaining({
        assignmentId: "assign_results_ops_pending",
        tenantId: RESULTS_OPS_TENANT_ID,
        title: "Results Ops Pending Assignment",
        rowCount: 1,
      }),
    ]);

    const failedRow = payload.rows.find((row) => row.attemptId === failedFinalization.attemptId);
    const pendingRow = payload.rows.find((row) => row.attemptId === pendingExport.attemptId);

    expect(failedRow).toMatchObject({
      finalization: {
        status: "failed",
        errorMessage: "Results ops materialization failure",
      },
      export: null,
      remediation: {
        failedCount: 1,
        latestRequest: {
          scope: "result-finalization",
          status: "failed",
        },
      },
    });
    expect(pendingRow).toMatchObject({
      assignmentId: "assign_results_ops_pending",
      context: {
        tenantId: RESULTS_OPS_TENANT_ID,
        assignmentTitle: "Results Ops Pending Assignment",
      },
      finalization: {
        status: "complete",
      },
      export: {
        status: "pending",
      },
      remediation: {
        failedCount: 0,
        latestRequest: null,
      },
    });

    const filteredResponse = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(
        "https://harbor.local/api/instructor/results-ops?assignmentId=assign_results_ops_pending",
      ),
      createExecutionContext(),
    );
    expect(filteredResponse.status).toBe(200);
    const filteredPayload = await filteredResponse.json<{
      summary: {
        finalization: {
          failedCount: number;
        };
        exports: {
          pendingCount: number;
        };
      };
      rows: Array<{
        attemptId: string;
      }>;
    }>();
    expect(filteredPayload.rows.map((row) => row.attemptId)).toEqual([pendingExport.attemptId]);
    expect(filteredPayload.summary).toMatchObject({
      finalization: {
        failedCount: 0,
      },
      exports: {
        pendingCount: 1,
      },
    });
  });

  it("creates one idempotent, auditable export retry request without duplicating authoritative result rows", async () => {
    const failedExport = await createFailedExportState("results-ops-export");
    const workflowRequests: string[] = [];
    const runtimeEnv = buildRuntimeEnv({
      sendSubmit: vi.fn(async () => {}),
      sendResultExport: vi.fn(async () => {}),
      createRemediationWorkflow: vi.fn(async (requestId) => {
        workflowRequests.push(requestId);
      }),
    });

    const retryBody = {
      scope: "result-export",
      actor: {
        role: "operator",
        actorId: "ops_retry",
        displayName: "Retry Operator",
      },
      reason: "Retry failed export",
    };

    const first = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(
        `https://harbor.local/api/instructor/results-ops/attempts/${failedExport.attemptId}/retry`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(retryBody),
        },
      ),
      createExecutionContext(),
    );
    const second = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(
        `https://harbor.local/api/instructor/results-ops/attempts/${failedExport.attemptId}/retry`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(retryBody),
        },
      ),
      createExecutionContext(),
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);

    const firstPayload = await first.json<{
      request: {
        requestId: string;
      };
    }>();
    const secondPayload = await second.json<{
      request: {
        requestId: string;
      };
    }>();

    expect(secondPayload.request.requestId).toBe(firstPayload.request.requestId);
    expect(workflowRequests).toEqual([firstPayload.request.requestId]);

    const remediation = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT COUNT(*) AS remediation_count, requested_by_role, requested_by_id, reason, workflow_instance_id FROM result_remediation_requests WHERE attempt_id = ?",
      )
      .bind(failedExport.attemptId)
      .first<{
        remediation_count: number;
        requested_by_role: string;
        requested_by_id: string;
        reason: string;
        workflow_instance_id: string | null;
      }>();

    expect(remediation).toEqual({
      remediation_count: 1,
      requested_by_role: "operator",
      requested_by_id: "ops_retry",
      reason: "Retry failed export",
      workflow_instance_id: firstPayload.request.requestId,
    });

    const authoritativeResults = await getBaseEnv()
      .HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM attempt_results WHERE attempt_id = ?")
      .bind(failedExport.attemptId)
      .first<{ count: number }>();

    expect(authoritativeResults?.count).toBe(1);
  });

  it("runs explicit finalization or export recovery only, and rejects unsupported remediation scopes", async () => {
    const failedFinalization = await createFailedFinalizationState(
      "results-ops-remediate-finalization",
    );
    const failedExport = await createFailedExportState("results-ops-remediate-export");
    const queuedExports: ResultExportEnvelope[] = [];

    await insertRemediationRequest({
      requestId: "rrem_finalization_retry_01",
      attemptId: failedFinalization.attemptId,
      assignmentId: null,
      assessmentVersionId: failedFinalization.assessmentVersionId,
      sourceReceiptId: failedFinalization.sourceReceiptId,
      scopeKind: "result-finalization",
      status: "pending",
      resultFinalizationId: failedFinalization.finalizationId,
      resultExportId: null,
      workflowInstanceId: "rrem_finalization_retry_01",
    });
    await insertRemediationRequest({
      requestId: "rrem_export_retry_01",
      attemptId: failedExport.attemptId,
      assignmentId: null,
      assessmentVersionId: failedExport.assessmentVersionId,
      sourceReceiptId: failedExport.sourceReceiptId,
      scopeKind: "result-export",
      status: "pending",
      resultFinalizationId: failedExport.finalizationId,
      resultExportId: failedExport.exportId,
      workflowInstanceId: "rrem_export_retry_01",
    });
    await insertRemediationRequest({
      requestId: "rrem_bad_scope_01",
      attemptId: failedExport.attemptId,
      assignmentId: null,
      assessmentVersionId: failedExport.assessmentVersionId,
      sourceReceiptId: failedExport.sourceReceiptId,
      scopeKind: "downstream-sync",
      status: "pending",
      resultFinalizationId: failedExport.finalizationId,
      resultExportId: failedExport.exportId,
      workflowInstanceId: "rrem_bad_scope_01",
    });

    const remediationEnv = buildRuntimeEnv({
      sendSubmit: vi.fn(async () => {}),
      sendResultExport: vi.fn(async (message) => {
        queuedExports.push(message);
      }),
    });

    await executeResultRemediationRequest({
      env: remediationEnv,
      requestId: "rrem_finalization_retry_01",
    });
    queuedExports.length = 0;
    await executeResultRemediationRequest({
      env: remediationEnv,
      requestId: "rrem_export_retry_01",
    });

    await expect(
      executeResultRemediationRequest({
        env: remediationEnv,
        requestId: "rrem_bad_scope_01",
      }),
    ).rejects.toThrow("Unsupported remediation scope");

    const retriedFinalization = await getBaseEnv()
      .HARBOR_DB.prepare("SELECT status FROM result_finalizations WHERE id = ?")
      .bind(failedFinalization.finalizationId)
      .first<{ status: string }>();
    expect(retriedFinalization?.status).toBe("complete");

    const finalizationResultCount = await getBaseEnv()
      .HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM attempt_results WHERE attempt_id = ?")
      .bind(failedFinalization.attemptId)
      .first<{ count: number }>();
    expect(finalizationResultCount?.count).toBe(1);

    const exportRows = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT id, retry_of_export_id, status FROM result_exports WHERE attempt_id = ? ORDER BY created_at ASC",
      )
      .bind(failedExport.attemptId)
      .all<{
        id: string;
        retry_of_export_id: string | null;
        status: string;
      }>();

    expect(exportRows.results).toHaveLength(2);
    expect(exportRows.results[1]).toMatchObject({
      retry_of_export_id: failedExport.exportId,
      status: "pending",
    });
    expect(queuedExports).toHaveLength(1);
    expect(queuedExports[0]).toMatchObject({
      attemptId: failedExport.attemptId,
    });

    const badScopeStatus = await getBaseEnv()
      .HARBOR_DB.prepare("SELECT status FROM result_remediation_requests WHERE id = ?")
      .bind("rrem_bad_scope_01")
      .first<{ status: string }>();
    expect(badScopeStatus?.status).toBe("failed");

    const opsResponse = await fetchWithRuntimeEnv(
      remediationEnv,
      new Request("https://harbor.local/api/instructor/results-ops"),
      createExecutionContext(),
    );
    expect(opsResponse.status).toBe(200);
    const opsPayload = await opsResponse.json<{
      summary: {
        exports: {
          retryPendingCount: number;
          retryFailedCount: number;
          retryCompleteCount: number;
        };
        remediation: {
          pendingCount: number;
          failedCount: number;
          completeCount: number;
          exportCompleteCount: number;
        };
      };
    }>();
    expect(opsPayload.summary).toMatchObject({
      exports: {
        retryPendingCount: 1,
        retryFailedCount: 0,
        retryCompleteCount: 0,
      },
      remediation: {
        pendingCount: 0,
        failedCount: 1,
        completeCount: 2,
        exportCompleteCount: 1,
      },
    });
  });
});
