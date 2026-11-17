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

const uploadItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-1" title="Upload Reflection" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="file"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-item-body>
    <qti-upload-interaction response-identifier="RESPONSE">
      <qti-prompt>Upload your reflection.</qti-prompt>
    </qti-upload-interaction>
  </qti-item-body>
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

async function launchPreviewAttempt(): Promise<BootstrapPayload> {
  const published = await publishFixture({
    tenantId: "tenant_phase5_results",
    assessmentSlug: "phase5-results",
  });
  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: published.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: "phase5_results_preview",
      displayName: "Phase 5 Results Preview",
    },
  });

  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const bootstrap = await postJson("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: "phase5_results_session",
  });

  expect(bootstrap.status).toBe(200);
  return bootstrap.json<BootstrapPayload>();
}

function buildRuntimeEnv(input: {
  send: (message: SubmitFinalizationEnvelope) => Promise<void>;
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
      send: input.send,
      sendBatchError: "sendBatch is not used in results-finalization tests",
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

async function readSingleResult(): Promise<{
  attempt_id: string;
  status: string;
  summary_source: string;
  total_score: number | null;
  max_score: number | null;
  passed: number | null;
}> {
  const { HARBOR_DB } = getBaseEnv();
  const row = await HARBOR_DB.prepare(
    "SELECT attempt_id, status, summary_source, total_score, max_score, passed FROM attempt_results ORDER BY created_at DESC LIMIT 1",
  ).first<{
    attempt_id: string;
    status: string;
    summary_source: string;
    total_score: number | null;
    max_score: number | null;
    passed: number | null;
  }>();

  expect(row).toBeTruthy();
  return row!;
}

async function readSingleResultItem(): Promise<{
  response_summary_text: string | null;
  score: number | null;
  max_score: number | null;
  outcome_variables_json: string;
}> {
  const { HARBOR_DB } = getBaseEnv();
  const row = await HARBOR_DB.prepare(
    "SELECT response_summary_text, score, max_score, outcome_variables_json FROM attempt_result_items ORDER BY created_at DESC LIMIT 1",
  ).first<{
    response_summary_text: string | null;
    score: number | null;
    max_score: number | null;
    outcome_variables_json: string;
  }>();

  expect(row).toBeTruthy();
  return row!;
}

async function replaceAuthoritativeItemXml(input: {
  attemptId: string;
  itemId: string;
  xml: string;
}): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET } = getBaseEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT manifest_object_key FROM attempt_entries WHERE id = ?",
  )
    .bind(input.attemptId)
    .first<{ manifest_object_key: string }>();
  expect(attempt).toBeTruthy();

  const manifestObject = await CONTENT_BUCKET.get(attempt!.manifest_object_key);
  expect(manifestObject).toBeTruthy();
  const manifest = await manifestObject!.json<DeliveryManifest>();
  const item = manifest.items[input.itemId];
  expect(item).toBeTruthy();

  await CONTENT_BUCKET.put(item!.objectKey, input.xml, {
    httpMetadata: {
      contentType: "application/xml",
    },
  });
}

beforeEach(async () => {
  await resetBindings();
});

describe("authoritative result finalization", () => {
  it("finalizes from Durable Object item snapshots when the submit event does not need the browser to stay alive", async () => {
    const payload = await launchPreviewAttempt();
    const queued: SubmitFinalizationEnvelope[] = [];
    const runtimeEnv = buildRuntimeEnv({
      send: vi.fn(async (message) => {
        queued.push(message);
      }),
    });

    const responseChanged = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_resp_01",
        idempotencyKey: "idem_resp_01",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-27T22:00:00.000Z",
        clientSessionId: "phase5_results_session",
        itemRef: payload.session.currentItemRef,
        type: "response.changed",
        payload: {
          responseKey: payload.session.currentItemRef.itemId,
          responseState: {
            capturedAt: "2026-03-27T22:00:00.000Z",
            itemState: {
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
            },
          },
        },
      },
    });

    expect(responseChanged.status).toBe(200);

    const submitResponse = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_submit_01",
        idempotencyKey: "idem_submit_01",
        sequenceNumber: 2,
        clientTimestamp: "2026-03-27T22:05:00.000Z",
        clientSessionId: "phase5_results_session",
        itemRef: payload.session.currentItemRef,
        type: "submit.requested",
        payload: {
          requestedAt: "2026-03-27T22:05:00.000Z",
        },
      },
    });

    expect(submitResponse.status).toBe(200);
    const receipt = await submitResponse.json<CommitAttemptEventReceipt>();
    expect(queued).toEqual([
      buildSubmitFinalizationEnvelope({
        eventType: "submit.requested",
        receipt,
      }),
    ]);

    const batch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_submit_01",
        timestamp: new Date(receipt.serverTimestamp),
        attempts: 1,
        body: queued[0],
      },
    ]);

    await consumeSubmitFinalizationBatch(batch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
      ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
    });

    const result = await readSingleResult();
    expect(result.attempt_id).toBe(payload.attemptId);
    expect(result.summary_source).toBe("authoritative-qti-snapshot");
    expect(result.total_score).toBe(1);
    expect(result.max_score).toBe(1);
    expect(result.passed).toBeNull();
  });

  it("rejects forged client SCORE outcomes when the submitted response is wrong", async () => {
    const payload = await launchPreviewAttempt();
    const runtimeEnv = buildRuntimeEnv({
      send: vi.fn(async () => undefined),
    });

    const responseChanged = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_resp_wrong",
        idempotencyKey: "idem_resp_wrong",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-27T22:10:00.000Z",
        clientSessionId: "phase5_results_session",
        itemRef: payload.session.currentItemRef,
        type: "response.changed",
        payload: {
          responseKey: payload.session.currentItemRef.itemId,
          responseState: {
            capturedAt: "2026-03-27T22:10:00.000Z",
            itemState: {
              responseVariables: [
                {
                  identifier: "RESPONSE",
                  value: "choice-b",
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
            },
          },
        },
      },
    });
    expect(responseChanged.status).toBe(200);

    const submitResponse = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_submit_wrong",
        idempotencyKey: "idem_submit_wrong",
        sequenceNumber: 2,
        clientTimestamp: "2026-03-27T22:11:00.000Z",
        clientSessionId: "phase5_results_session",
        itemRef: payload.session.currentItemRef,
        type: "submit.requested",
        payload: {
          requestedAt: "2026-03-27T22:11:00.000Z",
        },
      },
    });
    expect(submitResponse.status).toBe(200);
    const receipt = await submitResponse.json<CommitAttemptEventReceipt>();

    const batch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_submit_wrong",
        timestamp: new Date(receipt.serverTimestamp),
        attempts: 1,
        body: buildSubmitFinalizationEnvelope({
          eventType: "submit.requested",
          receipt,
        }),
      },
    ]);

    await consumeSubmitFinalizationBatch(batch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
      ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
    });

    const result = await readSingleResult();
    expect(result.summary_source).toBe("authoritative-qti-snapshot");
    expect(result.total_score).toBe(0);
    expect(result.max_score).toBe(1);

    const item = await readSingleResultItem();
    expect(item.response_summary_text).toBe("choice-b");
    expect(item.score).toBe(0);
    expect(item.max_score).toBe(1);
  });

  it("keeps the result pending when an item requires manual scoring", async () => {
    const payload = await launchPreviewAttempt();
    await replaceAuthoritativeItemXml({
      attemptId: payload.attemptId,
      itemId: payload.session.currentItemRef.itemId,
      xml: uploadItemXml,
    });
    const runtimeEnv = buildRuntimeEnv({
      send: vi.fn(async () => undefined),
    });

    const submitResponse = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_submit_manual",
        idempotencyKey: "idem_submit_manual",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-27T22:12:00.000Z",
        clientSessionId: "phase5_results_session",
        itemRef: payload.session.currentItemRef,
        type: "submit.requested",
        payload: {
          requestedAt: "2026-03-27T22:12:00.000Z",
        },
      },
    });
    expect(submitResponse.status).toBe(200);
    const receipt = await submitResponse.json<CommitAttemptEventReceipt>();

    const batch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_submit_manual",
        timestamp: new Date(receipt.serverTimestamp),
        attempts: 1,
        body: buildSubmitFinalizationEnvelope({
          eventType: "submit.requested",
          receipt,
        }),
      },
    ]);

    await consumeSubmitFinalizationBatch(batch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
      ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
    });

    const result = await readSingleResult();
    expect(result.status).toBe("pending");
    expect(result.total_score).toBeNull();
    expect(result.max_score).toBeNull();
    expect(result.passed).toBeNull();

    const item = await readSingleResultItem();
    expect(item.score).toBeNull();
    expect(item.max_score).toBe(1);
    expect(JSON.parse(item.outcome_variables_json)).toContainEqual({
      identifier: "HARBOR_SCORING_STATUS",
      value: "pending-manual-scoring",
    });
  });

  it("ignores submit-time forged outcomes and stays idempotent across queue retries", async () => {
    const payload = await launchPreviewAttempt();
    const queued: SubmitFinalizationEnvelope[] = [];
    const runtimeEnv = buildRuntimeEnv({
      send: vi.fn(async (message) => {
        queued.push(message);
      }),
    });

    const submitResponse = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_submit_02",
        idempotencyKey: "idem_submit_02",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-27T23:05:00.000Z",
        clientSessionId: "phase5_results_session",
        itemRef: payload.session.currentItemRef,
        type: "submit.requested",
        payload: {
          requestedAt: "2026-03-27T23:05:00.000Z",
          submissionMaterialization: {
            itemOrder: [payload.session.currentItemRef.itemId],
            testState: {
              identifier: "assessment-test",
              outcomeVariables: [
                {
                  identifier: "SCORE",
                  value: 0,
                },
                {
                  identifier: "MAXSCORE",
                  value: 0,
                },
                {
                  identifier: "PASSED",
                  value: false,
                },
              ],
            },
            partStates: {
              "part-1": {
                identifier: "part-1",
                outcomeVariables: [],
              },
            },
            sectionStates: {
              "section-1": {
                identifier: "section-1",
                outcomeVariables: [],
              },
            },
            items: {
              [payload.session.currentItemRef.itemId]: {
                itemId: payload.session.currentItemRef.itemId,
                itemIdentifier: "item-1",
                itemTitle: "Example item",
                capturedAt: "2026-03-27T23:05:00.000Z",
                responseVariables: [
                  {
                    identifier: "RESPONSE",
                    value: "choice-a",
                  },
                ],
                outcomeVariables: [
                  {
                    identifier: "SCORE",
                    value: 0,
                  },
                  {
                    identifier: "MAXSCORE",
                    value: 0,
                  },
                ],
                validationMessages: [],
              },
            },
          },
        },
      },
    });

    expect(submitResponse.status).toBe(200);
    const receipt = await submitResponse.json<CommitAttemptEventReceipt>();
    const envelope = buildSubmitFinalizationEnvelope({
      eventType: "submit.requested",
      receipt,
    });
    const batch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_submit_02",
        timestamp: new Date(receipt.serverTimestamp),
        attempts: 1,
        body: envelope,
      },
    ]);

    await consumeSubmitFinalizationBatch(batch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
      ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
    });
    await consumeSubmitFinalizationBatch(batch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
      ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
    });

    const { HARBOR_DB } = getBaseEnv();
    const counts = await HARBOR_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM result_finalizations WHERE source_receipt_id = ?) AS finalizations, (SELECT COUNT(*) FROM attempt_results WHERE attempt_id = ?) AS results, (SELECT COUNT(*) FROM attempt_result_items) AS items",
    )
      .bind(receipt.receiptId, payload.attemptId)
      .first<{ finalizations: number; results: number; items: number }>();

    expect(counts).toEqual({
      finalizations: 1,
      results: 1,
      items: 1,
    });

    const result = await readSingleResult();
    expect(result.summary_source).toBe("authoritative-qti-snapshot");
    expect(result.total_score).toBe(1);
    expect(result.max_score).toBe(1);
    expect(result.passed).toBeNull();

    const item = await readSingleResultItem();
    expect(item.response_summary_text).toBe("choice-a");
    expect(item.score).toBe(1);
    expect(item.max_score).toBe(1);
  });

  it("marks finalization failed when authoritative QTI has server-scoring diagnostics", async () => {
    const payload = await launchPreviewAttempt();
    await replaceAuthoritativeItemXml({
      attemptId: payload.attemptId,
      itemId: payload.session.currentItemRef.itemId,
      xml: scoredItemXml.replace(
        /  <qti-response-declaration[\s\S]*?<\/qti-response-declaration>\n/,
        "",
      ),
    });
    const queued: SubmitFinalizationEnvelope[] = [];
    const runtimeEnv = buildRuntimeEnv({
      send: vi.fn(async (message) => {
        queued.push(message);
      }),
    });

    const submitResponse = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_submit_bad_qti",
        idempotencyKey: "idem_submit_bad_qti",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-27T23:25:00.000Z",
        clientSessionId: "phase5_results_session",
        itemRef: payload.session.currentItemRef,
        type: "submit.requested",
        payload: {
          requestedAt: "2026-03-27T23:25:00.000Z",
        },
      },
    });
    expect(submitResponse.status).toBe(200);
    const receipt = await submitResponse.json<CommitAttemptEventReceipt>();

    await consumeSubmitFinalizationBatch(
      createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
        {
          id: "msg_submit_bad_qti",
          timestamp: new Date(receipt.serverTimestamp),
          attempts: 1,
          body: queued[0],
        },
      ]),
      {
        HARBOR_DB: getBaseEnv().HARBOR_DB,
        CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
        ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
        ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
      },
    );

    const failed = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT status, materialized_from, error_message FROM result_finalizations WHERE source_receipt_id = ?",
      )
      .bind(receipt.receiptId)
      .first<{
        status: string;
        materialized_from: string;
        error_message: string | null;
      }>();
    expect(failed).toMatchObject({
      status: "failed",
      materialized_from: "authoritative-qti-snapshot",
    });
    expect(failed?.error_message).toContain("could not be parsed");

    const resultCount = await getBaseEnv()
      .HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM attempt_results WHERE attempt_id = ?")
      .bind(payload.attemptId)
      .first<{ count: number }>();
    expect(resultCount?.count).toBe(0);
  });
});
