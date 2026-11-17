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
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1" required="true">
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
    tenantId: "tenant_results_validation",
    assessmentSlug: "results-validation",
  });
  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: published.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: "results_validation_preview",
      displayName: "Results Validation Preview",
    },
  });

  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const bootstrap = await postJson("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: "results_validation_session",
  });

  expect(bootstrap.status).toBe(200);
  return bootstrap.json<BootstrapPayload>();
}

function buildRuntimeEnv(): RuntimeEnv {
  const base = getBaseEnv();
  return {
    HARBOR_DB: base.HARBOR_DB,
    CONTENT_BUCKET: base.CONTENT_BUCKET,
    BOOTSTRAP_SIGNING_SECRET: base.BOOTSTRAP_SIGNING_SECRET,
    LTI_TOOL_PRIVATE_KEY_JWK: base.LTI_TOOL_PRIVATE_KEY_JWK,
    ATTEMPT_COORDINATOR: base.ATTEMPT_COORDINATOR,
    ATTEMPT_RUNTIME_METRICS: base.ATTEMPT_RUNTIME_METRICS,
    SUBMIT_FINALIZATION_QUEUE: createQueueMock<SubmitFinalizationEnvelope>({
      send: vi.fn(async () => undefined),
      sendBatchError: "sendBatch is not used in results validation tests",
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

async function consumeFinalizationEnvelope(envelope: SubmitFinalizationEnvelope): Promise<void> {
  await consumeSubmitFinalizationBatch(
    createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: `msg_${envelope.receiptId}`,
        timestamp: new Date(envelope.submittedAt),
        attempts: 1,
        body: envelope,
      },
    ]),
    {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
      ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
    },
  );
}

async function readFinalization(receiptId: string): Promise<{
  status: string;
  materialized_from: string;
  error_message: string | null;
} | null> {
  return getBaseEnv()
    .HARBOR_DB.prepare(
      "SELECT status, materialized_from, error_message FROM result_finalizations WHERE source_receipt_id = ?",
    )
    .bind(receiptId)
    .first<{
      status: string;
      materialized_from: string;
      error_message: string | null;
    }>();
}

async function readSingleResult(): Promise<{
  attempt_id: string;
  total_score: number | null;
  max_score: number | null;
}> {
  const row = await getBaseEnv()
    .HARBOR_DB.prepare(
      "SELECT attempt_id, total_score, max_score FROM attempt_results ORDER BY created_at DESC LIMIT 1",
    )
    .first<{
      attempt_id: string;
      total_score: number | null;
      max_score: number | null;
    }>();

  expect(row).toBeTruthy();
  return row!;
}

async function setAllowSkipping(input: {
  attemptId: string;
  allowSkipping: boolean;
}): Promise<void> {
  const { ATTEMPT_COORDINATOR } = getBaseEnv();
  const stub = ATTEMPT_COORDINATOR.get(ATTEMPT_COORDINATOR.idFromName(input.attemptId));
  const response = await stub.fetch("https://harbor-attempt.local/policy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harbor-attempt-id": input.attemptId,
    },
    body: JSON.stringify({
      commandId: `cmd_validation_allow_skipping_${input.allowSkipping ? "true" : "false"}`,
      type: "set-accommodations",
      actor: {
        role: "instructor",
        actorId: "results-validation-test",
        displayName: "Results Validation Test",
      },
      reason: "Test response validation policy",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      accommodations: {
        rendererPnp: {},
        sessionControl: {
          allow_skipping: input.allowSkipping,
        },
        shellTools: {},
      },
    }),
  });
  expect(response.status).toBe(200);
}

beforeEach(async () => {
  await resetBindings();
});

describe("QTI response validation during result finalization", () => {
  it("fails finalization for missing required responses when skipping is disabled", async () => {
    const payload = await launchPreviewAttempt();
    await replaceAuthoritativeItemXml({
      attemptId: payload.attemptId,
      itemId: payload.session.currentItemRef.itemId,
      xml: scoredItemXml,
    });
    const runtimeEnv = buildRuntimeEnv();
    await setAllowSkipping({
      attemptId: payload.attemptId,
      allowSkipping: false,
    });

    const submitResponse = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_submit_missing_required",
        idempotencyKey: "idem_submit_missing_required",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-27T22:13:00.000Z",
        clientSessionId: "results_validation_session",
        itemRef: payload.session.currentItemRef,
        type: "submit.requested",
        payload: {
          requestedAt: "2026-03-27T22:13:00.000Z",
        },
      },
    });
    expect(submitResponse.status).toBe(200);
    const receipt = await submitResponse.json<CommitAttemptEventReceipt>();

    await consumeFinalizationEnvelope(
      buildSubmitFinalizationEnvelope({
        eventType: "submit.requested",
        receipt,
      }),
    );

    const finalization = await readFinalization(receipt.receiptId);
    expect(finalization).toMatchObject({
      status: "failed",
      materialized_from: "authoritative-qti-snapshot",
    });
    expect(finalization?.error_message).toContain("qti.response.required.missing");

    const resultCount = await getBaseEnv()
      .HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM attempt_results WHERE attempt_id = ?")
      .bind(payload.attemptId)
      .first<{ count: number }>();
    expect(resultCount?.count).toBe(0);
  });

  it("accepts missing required responses when skipping is allowed", async () => {
    const payload = await launchPreviewAttempt();
    await replaceAuthoritativeItemXml({
      attemptId: payload.attemptId,
      itemId: payload.session.currentItemRef.itemId,
      xml: scoredItemXml,
    });
    const runtimeEnv = buildRuntimeEnv();
    await setAllowSkipping({
      attemptId: payload.attemptId,
      allowSkipping: true,
    });

    const submitResponse = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_submit_missing_allowed",
        idempotencyKey: "idem_submit_missing_allowed",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-27T22:14:00.000Z",
        clientSessionId: "results_validation_session",
        itemRef: payload.session.currentItemRef,
        type: "submit.requested",
        payload: {
          requestedAt: "2026-03-27T22:14:00.000Z",
        },
      },
    });
    expect(submitResponse.status).toBe(200);
    const receipt = await submitResponse.json<CommitAttemptEventReceipt>();

    await consumeFinalizationEnvelope(
      buildSubmitFinalizationEnvelope({
        eventType: "submit.requested",
        receipt,
      }),
    );

    const result = await readSingleResult();
    expect(result.attempt_id).toBe(payload.attemptId);
    expect(result.total_score).toBe(0);
    expect(result.max_score).toBe(1);
  });

  it("accepts missing required responses for deadline auto-submit even when skipping is disabled", async () => {
    const payload = await launchPreviewAttempt();
    await replaceAuthoritativeItemXml({
      attemptId: payload.attemptId,
      itemId: payload.session.currentItemRef.itemId,
      xml: scoredItemXml,
    });
    const runtimeEnv = buildRuntimeEnv();
    await setAllowSkipping({
      attemptId: payload.attemptId,
      allowSkipping: false,
    });

    const submitResponse = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_auto_submit_missing_required",
        idempotencyKey: "idem_auto_submit_missing_required",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-27T22:15:00.000Z",
        clientSessionId: "results_validation_session",
        itemRef: payload.session.currentItemRef,
        type: "timing.auto-submit.requested",
        payload: {
          requestedAt: "2026-03-27T22:15:00.000Z",
          reason: "max-time-reached",
          scopeKey: "assessment-test:test",
        },
      },
    });
    expect(submitResponse.status).toBe(200);
    const receipt = await submitResponse.json<CommitAttemptEventReceipt>();

    await consumeFinalizationEnvelope(
      buildSubmitFinalizationEnvelope({
        eventType: "timing.auto-submit.requested",
        receipt,
      }),
    );

    const result = await readSingleResult();
    expect(result.attempt_id).toBe(payload.attemptId);
    expect(result.total_score).toBe(0);
    expect(result.max_score).toBe(1);
  });

  it("fails finalization for malformed response shapes even during auto-submit", async () => {
    const payload = await launchPreviewAttempt();
    const runtimeEnv = buildRuntimeEnv();

    const responseChanged = await postAttemptEvent({
      runtimeEnv,
      attemptId: payload.attemptId,
      body: {
        attemptId: payload.attemptId,
        eventId: "evt_resp_malformed",
        idempotencyKey: "idem_resp_malformed",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-27T22:16:00.000Z",
        clientSessionId: "results_validation_session",
        itemRef: payload.session.currentItemRef,
        type: "response.changed",
        payload: {
          responseKey: payload.session.currentItemRef.itemId,
          responseState: {
            capturedAt: "2026-03-27T22:16:00.000Z",
            itemState: {
              responseVariables: [
                {
                  identifier: "RESPONSE",
                  value: ["choice-a", "choice-b"],
                },
              ],
              outcomeVariables: [],
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
        eventId: "evt_auto_submit_malformed",
        idempotencyKey: "idem_auto_submit_malformed",
        sequenceNumber: 2,
        clientTimestamp: "2026-03-27T22:17:00.000Z",
        clientSessionId: "results_validation_session",
        itemRef: payload.session.currentItemRef,
        type: "timing.auto-submit.requested",
        payload: {
          requestedAt: "2026-03-27T22:17:00.000Z",
          reason: "max-time-reached",
          scopeKey: "assessment-test:test",
        },
      },
    });
    expect(submitResponse.status).toBe(200);
    const receipt = await submitResponse.json<CommitAttemptEventReceipt>();

    await consumeFinalizationEnvelope(
      buildSubmitFinalizationEnvelope({
        eventType: "timing.auto-submit.requested",
        receipt,
      }),
    );

    const finalization = await readFinalization(receipt.receiptId);
    expect(finalization).toMatchObject({
      status: "failed",
      materialized_from: "authoritative-qti-snapshot",
    });
    expect(finalization?.error_message).toContain("qti.response.cardinality.invalid");
  });
});
