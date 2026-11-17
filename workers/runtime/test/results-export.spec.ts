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
import type { DeliveryManifest } from "@harbor/content-model";
import runtimeWorker, { type Env as RuntimeEnv } from "../src/index";
import {
  buildSubmitFinalizationEnvelope,
  consumeSubmitFinalizationBatch,
  SUBMIT_FINALIZATION_QUEUE_NAME,
  type SubmitFinalizationEnvelope,
} from "../src/queues/submit-finalization";
import {
  consumeResultExportBatch,
  requeueCompletedResultExportsForAttemptResult,
  RESULT_EXPORT_QUEUE_NAME,
  type ResultExportEnvelope,
} from "../src/queues/result-export";
import { createQueueMock } from "./queue-mock";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

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
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-prompt>What is 2 + 2?</qti-prompt>
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
    "assignments",
    "assessment_version_activations",
    "attempt_timeline_events",
    "attempt_policy_commands",
    "attempt_policy_overlays",
    "attempt_entries",
    "access_codes",
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
  manifestObjectKey: string;
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

async function launchPreviewAttempt(
  input: {
    qtiTiming?: DeliveryManifest["qtiTiming"];
  } = {},
): Promise<BootstrapPayload> {
  const published = await publishFixture({
    tenantId: "tenant_phase8_results_export",
    assessmentSlug: "phase8-results-export",
  });
  if (input.qtiTiming) {
    await applyQtiTimingToManifest(published.manifestObjectKey, input.qtiTiming);
  }
  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: published.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: "phase8_results_export_preview",
      displayName: "Phase 8 Results Export Preview",
    },
  });

  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const bootstrap = await postJson("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: "phase8_results_export_session",
  });

  expect(bootstrap.status).toBe(200);
  return bootstrap.json<BootstrapPayload>();
}

async function applyQtiTimingToManifest(
  manifestObjectKey: string,
  qtiTiming: DeliveryManifest["qtiTiming"],
): Promise<void> {
  const manifestObject = await getBaseEnv().CONTENT_BUCKET.get(manifestObjectKey);
  expect(manifestObject).toBeTruthy();
  const manifest = await manifestObject!.json<DeliveryManifest>();
  await getBaseEnv().CONTENT_BUCKET.put(
    manifestObjectKey,
    JSON.stringify({
      ...manifest,
      qtiTiming,
    }),
    {
      httpMetadata: {
        contentType: "application/json",
      },
    },
  );
}

function buildScopedResultQtiTiming(): NonNullable<DeliveryManifest["qtiTiming"]> {
  return {
    assessmentTest: {
      identifier: "result-export-test",
      title: "Result Export Test",
      timeLimits: {
        scopeType: "assessment-test",
        identifier: "result-export-test",
        minTimeSeconds: null,
        maxTimeSeconds: 120,
        allowLateSubmission: false,
        rawAttributes: {
          "min-time": null,
          "max-time": "120",
          "allow-late-submission": null,
        },
      },
    },
    testParts: [
      {
        identifier: "part-1",
        navigationMode: "linear",
        submissionMode: "individual",
        timeLimits: {
          scopeType: "test-part",
          identifier: "part-1",
          minTimeSeconds: null,
          maxTimeSeconds: 90,
          allowLateSubmission: false,
          rawAttributes: {
            "min-time": null,
            "max-time": "90",
            "allow-late-submission": null,
          },
        },
        sectionIds: ["section-1"],
      },
    ],
    sections: [
      {
        identifier: "section-1",
        title: "Section 1",
        visible: true,
        testPartId: "part-1",
        timeLimits: {
          scopeType: "assessment-section",
          identifier: "section-1",
          minTimeSeconds: null,
          maxTimeSeconds: 60,
          allowLateSubmission: false,
          rawAttributes: {
            "min-time": null,
            "max-time": "60",
            "allow-late-submission": null,
          },
        },
        itemRefIds: ["item-1"],
      },
    ],
    itemRefs: [
      {
        identifier: "item-1",
        href: "items/item-1.xml",
        itemId: "item-1",
        testPartId: "part-1",
        sectionId: "section-1",
        timeLimits: null,
        itemSessionControl: null,
      },
    ],
  };
}

function buildRuntimeEnv(input: {
  sendSubmit: (message: SubmitFinalizationEnvelope) => Promise<void>;
  sendResultExport: (message: ResultExportEnvelope) => Promise<void>;
}): RuntimeEnv {
  const base = getBaseEnv();
  return {
    HARBOR_DB: base.HARBOR_DB,
    CONTENT_BUCKET: base.CONTENT_BUCKET,
    BOOTSTRAP_SIGNING_SECRET: base.BOOTSTRAP_SIGNING_SECRET,
    LTI_TOOL_PRIVATE_KEY_JWK: base.LTI_TOOL_PRIVATE_KEY_JWK,
    ATTEMPT_COORDINATOR: base.ATTEMPT_COORDINATOR,
    ATTEMPT_RUNTIME_METRICS: base.ATTEMPT_RUNTIME_METRICS,
    SUBMIT_FINALIZATION_QUEUE: createQueueMock<SubmitFinalizationEnvelope>({
      send: input.sendSubmit,
      sendBatchError: "sendBatch is not used in results-export tests",
    }),
    RESULT_EXPORT_QUEUE: createQueueMock<ResultExportEnvelope>({
      send: input.sendResultExport,
      sendBatchError: "sendBatch is not used in results-export tests",
    }),
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
}): Promise<CommitAttemptEventReceipt> {
  const response = await postAttemptEvent({
    runtimeEnv: input.runtimeEnv,
    attemptId: input.payload.attemptId,
    body: {
      attemptId: input.payload.attemptId,
      eventId: "evt_submit_export_01",
      idempotencyKey: "idem_submit_export_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-28T17:05:00.000Z",
      clientSessionId: "phase8_results_export_session",
      itemRef: input.payload.session.currentItemRef,
      type: "submit.requested",
      payload: {
        requestedAt: "2026-03-28T17:05:00.000Z",
        submissionMaterialization: {
          itemOrder: [input.payload.session.currentItemRef.itemId],
          testState: {
            identifier: "assessment-test",
            outcomeVariables: [
              {
                identifier: "SCORE",
                value: 1,
              },
              {
                identifier: "MAXSCORE",
                value: 1,
              },
              {
                identifier: "PASSED",
                value: true,
              },
            ],
          },
          partStates: {},
          sectionStates: {},
          items: {
            [input.payload.session.currentItemRef.itemId]: {
              itemId: input.payload.session.currentItemRef.itemId,
              itemIdentifier: "item-1",
              itemTitle: "Example item",
              capturedAt: "2026-03-28T17:05:00.000Z",
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

beforeEach(async () => {
  await resetBindings();
});

describe("result export queue flow", () => {
  it("enqueues export work only after authoritative finalization, not on the synchronous submit receipt path", async () => {
    const payload = await launchPreviewAttempt({
      qtiTiming: buildScopedResultQtiTiming(),
    });
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
    });

    expect(queuedSubmits).toEqual([
      buildSubmitFinalizationEnvelope({
        eventType: "submit.requested",
        receipt,
      }),
    ]);
    expect(queuedExports).toEqual([]);

    const batch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_submit_export_01",
        timestamp: new Date(receipt.serverTimestamp),
        attempts: 1,
        body: queuedSubmits[0],
      },
    ]);

    await consumeSubmitFinalizationBatch(batch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
      ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
      RESULT_EXPORT_QUEUE: runtimeEnv.RESULT_EXPORT_QUEUE,
    });

    expect(queuedExports).toHaveLength(1);
    expect(queuedExports[0]).toMatchObject({
      attemptId: payload.attemptId,
    });

    const exportState = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT status, attempt_id, source_receipt_id FROM result_exports ORDER BY created_at DESC LIMIT 1",
      )
      .first<{
        status: string;
        attempt_id: string;
        source_receipt_id: string;
      }>();

    expect(exportState).toEqual({
      status: "pending",
      attempt_id: payload.attemptId,
      source_receipt_id: receipt.receiptId,
    });
  });

  it("builds one durable QTI-aligned export artifact from Harbor ledgers even if fan-out is replayed", async () => {
    const payload = await launchPreviewAttempt();
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
    });
    const submitBatch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_submit_export_02",
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

    expect(queuedExports).toHaveLength(1);

    const exportBatch = createMessageBatch(RESULT_EXPORT_QUEUE_NAME, [
      {
        id: "msg_result_export_01",
        timestamp: new Date(receipt.serverTimestamp),
        attempts: 1,
        body: queuedExports[0],
      },
    ]);

    await consumeResultExportBatch(exportBatch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
    });
    await consumeResultExportBatch(exportBatch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
    });

    const exports = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT id, status, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, exported_at FROM result_exports ORDER BY created_at ASC",
      )
      .all<{
        id: string;
        status: string;
        artifact_path: string | null;
        artifact_content_type: string | null;
        artifact_sha256: string | null;
        artifact_size_bytes: number | null;
        exported_at: string | null;
      }>();

    expect(exports.results).toHaveLength(1);
    expect(exports.results[0]).toMatchObject({
      id: queuedExports[0].exportId,
      status: "complete",
      artifact_content_type: "application/xml; charset=utf-8",
    });
    expect(exports.results[0].artifact_path).toBeTruthy();
    expect(exports.results[0].artifact_sha256).toBeTruthy();
    expect(exports.results[0].artifact_size_bytes).toBeGreaterThan(0);
    expect(exports.results[0].exported_at).toBeTruthy();

    const artifact = await getBaseEnv().CONTENT_BUCKET.get(exports.results[0].artifact_path!);
    expect(artifact).toBeTruthy();
    const xml = await artifact!.text();

    expect(xml).toContain(
      '<assessmentResult xmlns="http://www.imsglobal.org/xsd/imsqti_result_v3p0">',
    );
    expect(xml).toContain(
      `<sessionIdentifier sourceID="https://harbor.local/runtime" identifier="${payload.attemptId}" />`,
    );
    expect(xml).toContain(
      '<outcomeVariable identifier="SCORE" cardinality="single" baseType="float">',
    );
    expect(xml).toContain(
      '<responseVariable identifier="duration" cardinality="single" baseType="duration">',
    );
    expect(xml).toContain(
      '<responseVariable identifier="duration.test-part.default-test-part" cardinality="single" baseType="duration">',
    );
    expect(xml).toContain(
      '<responseVariable identifier="duration.assessment-section.default-section" cardinality="single" baseType="duration">',
    );
    expect(xml).toContain('<itemResult identifier="item-1"');
    expect(xml).toContain('sessionStatus="final"');
    expect(xml).toContain(
      '<responseVariable identifier="numAttempts" cardinality="single" baseType="integer">',
    );
    expect(xml).toContain(
      '<responseVariable identifier="duration" cardinality="single" baseType="duration">',
    );
  });

  it("requeues completed exports and clears stale artifacts after a result is rescored", async () => {
    const payload = await launchPreviewAttempt();
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
    });
    const submitBatch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_submit_export_04",
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

    const initialExport = queuedExports[0];
    const exportBatch = createMessageBatch(RESULT_EXPORT_QUEUE_NAME, [
      {
        id: "msg_result_export_03",
        timestamp: new Date(receipt.serverTimestamp),
        attempts: 1,
        body: initialExport,
      },
    ]);

    await consumeResultExportBatch(exportBatch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
    });

    const completed = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT attempt_result_id, status, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, exported_at FROM result_exports WHERE id = ?",
      )
      .bind(initialExport.exportId)
      .first<{
        attempt_result_id: string;
        status: string;
        artifact_path: string | null;
        artifact_content_type: string | null;
        artifact_sha256: string | null;
        artifact_size_bytes: number | null;
        exported_at: string | null;
      }>();

    expect(completed).toMatchObject({
      status: "complete",
      artifact_content_type: "application/xml; charset=utf-8",
    });
    expect(completed?.artifact_path).toBeTruthy();
    expect(completed?.artifact_sha256).toBeTruthy();
    expect(completed?.artifact_size_bytes).toBeGreaterThan(0);
    expect(completed?.exported_at).toBeTruthy();

    queuedExports.length = 0;
    const requeuedCount = await requeueCompletedResultExportsForAttemptResult({
      db: getBaseEnv().HARBOR_DB,
      env: runtimeEnv,
      attemptResultId: completed!.attempt_result_id,
    });

    expect(requeuedCount).toBe(1);
    expect(queuedExports).toEqual([initialExport]);

    const stale = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT status, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, exported_at, error_message FROM result_exports WHERE id = ?",
      )
      .bind(initialExport.exportId)
      .first<{
        status: string;
        artifact_path: string | null;
        artifact_content_type: string | null;
        artifact_sha256: string | null;
        artifact_size_bytes: number | null;
        exported_at: string | null;
        error_message: string | null;
      }>();

    expect(stale).toEqual({
      status: "pending",
      artifact_path: null,
      artifact_content_type: null,
      artifact_sha256: null,
      artifact_size_bytes: null,
      exported_at: null,
      error_message: null,
    });
  });

  it("captures export failures as durable failed status instead of leaving them as console-only errors", async () => {
    const payload = await launchPreviewAttempt();
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
    });
    const submitBatch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_submit_export_03",
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

    const exportBatch = createMessageBatch(RESULT_EXPORT_QUEUE_NAME, [
      {
        id: "msg_result_export_02",
        timestamp: new Date(receipt.serverTimestamp),
        attempts: 1,
        body: queuedExports[0],
      },
    ]);

    await consumeResultExportBatch(exportBatch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: {
        async put() {
          throw new Error("R2 export write failed");
        },
      } as unknown as R2Bucket,
    });

    const failed = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT status, error_message, artifact_path FROM result_exports WHERE id = ?",
      )
      .bind(queuedExports[0].exportId)
      .first<{
        status: string;
        error_message: string | null;
        artifact_path: string | null;
      }>();

    expect(failed).toEqual({
      status: "failed",
      error_message: "R2 export write failed",
      artifact_path: null,
    });
  });
});
