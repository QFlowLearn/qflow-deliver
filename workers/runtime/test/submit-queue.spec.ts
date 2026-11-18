import { prepareQueueInbox } from "./native-queue-sink";
import JSZip from "jszip";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AttemptEventCommitResponse,
  BootstrapEnvelope,
  BootstrapPayload,
  CommitAttemptEventReceipt,
} from "@harbor/attempt-protocol";
import runtimeWorker, { type Env as RuntimeEnv } from "../src/index";
import {
  SUBMIT_FINALIZATION_DLQ_NAME,
  SUBMIT_FINALIZATION_QUEUE_NAME,
  buildSubmitFinalizationEnvelope,
  consumeSubmitFinalizationBatch,
  runPendingSubmitFinalizationRequeues,
} from "../src/queues/submit-finalization";
import { ensurePendingSubmitFinalization } from "../src/queues/submit-finalization-outbox";
import { observeQueue } from "./queue-fixture";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const scoredItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-1" title="Addition Warmup" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response>
      <qti-value>A</qti-value>
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
      <qti-simple-choice identifier="A">3</qti-simple-choice>
      <qti-simple-choice identifier="B">4</qti-simple-choice>
      <qti-simple-choice identifier="C">5</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

const ACTIVE_POLICY = {
  overlayRevision: 0,
  timing: {
    additionalTimeSeconds: 0,
    effectiveTimeLimitSeconds: 1800,
    effectiveSoftCloseAt: "2026-03-27T00:30:00.000Z",
    effectiveAcceptUntil: "2026-03-27T00:30:30.000Z",
  },
  reopen: {
    status: "closed",
    reopenedAt: null,
    reopenUntil: null,
  },
  operatorMessage: null,
  accommodations: {
    rendererPnp: {},
    sessionControl: {},
  },
} as const;

function buildSubmitReceipt(): CommitAttemptEventReceipt {
  return {
    outcome: "accepted",
    receiptId: "rcpt_submit_01",
    attemptId: "attempt_submit_01",
    acceptedEventId: "evt_submit_01",
    acceptedSequenceNumber: 8,
    highestCommittedSequence: 8,
    attemptStatus: "submitted",
    currentItemRef: {
      itemId: "item-2",
      itemHref: "items/item-2.xml",
    },
    timing: {
      startedAt: "2026-03-27T00:00:00.000Z",
      expiresAt: "2026-03-27T00:30:00.000Z",
      softCloseAt: "2026-03-27T00:30:00.000Z",
      acceptUntil: "2026-03-27T00:30:30.000Z",
      remainingTimeSeconds: 0,
    },
    policy: ACTIVE_POLICY,
    serverTimestamp: "2026-03-27T00:30:10.000Z",
  };
}

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
    tenantId: "tenant_phase4_submit_queue",
    assessmentSlug: "phase4-submit-queue",
  });
  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: published.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: "preview_phase4_submit_queue",
      displayName: "Phase 4 Submit Queue",
    },
  });

  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const bootstrap = await postJson("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: "phase4_submit_queue_session",
  });

  expect(bootstrap.status).toBe(200);
  return bootstrap.json<BootstrapPayload>();
}

function buildRuntimeEnv(input: {
  send: (message: ReturnType<typeof buildSubmitFinalizationEnvelope>) => Promise<void>;
}): {
  runtimeEnv: RuntimeEnv;
  points: AnalyticsEngineDataPoint[];
} {
  const base = getBaseEnv();
  const points: AnalyticsEngineDataPoint[] = [];

  return {
    runtimeEnv: {
      HARBOR_DB: base.HARBOR_DB,
      CONTENT_BUCKET: base.CONTENT_BUCKET,
      BOOTSTRAP_SIGNING_SECRET: base.BOOTSTRAP_SIGNING_SECRET,
      LTI_TOOL_PRIVATE_KEY_JWK: base.LTI_TOOL_PRIVATE_KEY_JWK,
      ATTEMPT_COORDINATOR: base.ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: {
        writeDataPoint(point) {
          points.push(point ?? {});
        },
      } as AnalyticsEngineDataset,
      SUBMIT_FINALIZATION_QUEUE: observeQueue<ReturnType<typeof buildSubmitFinalizationEnvelope>>(
        env.SUBMIT_FINALIZATION_QUEUE,
        {
          beforeSend: input.send,
          sendBatchError: "sendBatch is not used in phase 4 tests",
        },
      ),
    },
    points,
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

function readMetricPoint(point: AnalyticsEngineDataPoint): {
  route: string;
  family: string;
  outcome: string;
  sequenceNumber: number;
} {
  return {
    route: String(point.blobs?.[0]),
    family: String(point.blobs?.[1]),
    outcome: String(point.blobs?.[3]),
    sequenceNumber: Number(point.doubles?.[1]),
  };
}

beforeEach(async () => {
  await resetBindings();
});

describe("submit finalization queue contracts", () => {
  it("observes successful sends while storing the envelope in the native queue", async () => {
    const nativeQueue = env.SUBMIT_FINALIZATION_QUEUE;
    await prepareQueueInbox(env.HARBOR_DB);
    const recorded: Array<ReturnType<typeof buildSubmitFinalizationEnvelope>> = [];
    const queue = observeQueue(nativeQueue, {
      beforeSend(message) {
        recorded.push(message);
      },
    });
    const envelope = buildSubmitFinalizationEnvelope({
      eventType: "submit.requested",
      receipt: {
        ...buildSubmitReceipt(),
        receiptId: `receipt_native_queue_${crypto.randomUUID()}`,
      },
    });
    const response = await queue.send(envelope);
    expect(recorded).toEqual([envelope]);
    expect(response.metadata.metrics.backlogCount).toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => {
        const delivered = await env.HARBOR_DB.prepare(
          "SELECT body_json FROM test_queue_deliveries WHERE queue_name = ? AND json_extract(body_json, '$.receiptId') = ?",
        )
          .bind(SUBMIT_FINALIZATION_QUEUE_NAME, envelope.receiptId)
          .first<{ body_json: string }>();
        return delivered ? JSON.parse(delivered.body_json) : null;
      })
      .toEqual(envelope);
  });

  it("builds the minimal post-receipt envelope for accepted submit fan-out", () => {
    const envelope = buildSubmitFinalizationEnvelope({
      eventType: "submit.requested",
      receipt: buildSubmitReceipt(),
    });

    expect(SUBMIT_FINALIZATION_QUEUE_NAME).toBe("harbor-submit-finalization");
    expect(SUBMIT_FINALIZATION_DLQ_NAME).toBe("harbor-submit-finalization-dlq");
    expect(Object.keys(envelope).sort()).toEqual([
      "acceptedSequenceNumber",
      "attemptId",
      "eventType",
      "receiptId",
      "submittedAt",
    ]);
    expect(envelope).toEqual({
      attemptId: "attempt_submit_01",
      eventType: "submit.requested",
      receiptId: "rcpt_submit_01",
      acceptedSequenceNumber: 8,
      submittedAt: "2026-03-27T00:30:10.000Z",
    });
  });

  it("materializes result-finalization state when the consumer receives D1 and Durable Object authority", async () => {
    const payload = await launchPreviewAttempt();
    const queued: Array<ReturnType<typeof buildSubmitFinalizationEnvelope>> = [];
    const { runtimeEnv } = buildRuntimeEnv({
      send: async (message) => {
        queued.push(message);
      },
    });
    const ctx = createExecutionContext();
    const response = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${payload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attemptId: payload.attemptId,
          eventId: "evt_submit_materialize_01",
          idempotencyKey: "idem_submit_materialize_01",
          sequenceNumber: 1,
          clientTimestamp: new Date().toISOString(),
          clientSessionId: "phase4_submit_queue_session",
          itemRef: payload.session.currentItemRef,
          type: "submit.requested",
          payload: {
            requestedAt: new Date().toISOString(),
            submissionMaterialization: {
              itemOrder: [payload.session.currentItemRef.itemId],
              testState: {
                identifier: "assessment-test",
                outcomeVariables: [
                  { identifier: "SCORE", value: 1 },
                  { identifier: "MAXSCORE", value: 1 },
                ],
              },
              partStates: {},
              sectionStates: {},
              items: {
                [payload.session.currentItemRef.itemId]: {
                  itemId: payload.session.currentItemRef.itemId,
                  itemIdentifier: "item-1",
                  itemTitle: "Item 1",
                  capturedAt: new Date().toISOString(),
                  responseVariables: [{ identifier: "RESPONSE", value: "A" }],
                  outcomeVariables: [
                    { identifier: "SCORE", value: 1 },
                    { identifier: "MAXSCORE", value: 1 },
                  ],
                  validationMessages: [],
                },
              },
            },
          },
        }),
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    const receipt = await response.json<CommitAttemptEventReceipt>();
    await waitOnExecutionContext(ctx);
    const batch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_01",
        timestamp: new Date("2026-03-27T00:30:11.000Z"),
        attempts: 1,
        body: queued[0],
      },
    ]);
    const recorded: Array<{
      attemptId: string;
      outcome: string;
      receiptId: string;
    }> = [];

    await consumeSubmitFinalizationBatch(batch, {
      HARBOR_DB: getBaseEnv().HARBOR_DB,
      CONTENT_BUCKET: getBaseEnv().CONTENT_BUCKET,
      ATTEMPT_COORDINATOR: getBaseEnv().ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
      record: (entry) => recorded.push(entry),
    });

    expect(recorded).toEqual([
      {
        attemptId: payload.attemptId,
        outcome: "consumed",
        receiptId: receipt.receiptId,
      },
    ]);

    const finalized = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT status, materialized_from FROM result_finalizations WHERE source_receipt_id = ?",
      )
      .bind(receipt.receiptId)
      .first<{ status: string; materialized_from: string }>();

    expect(finalized).toEqual({
      status: "complete",
      materialized_from: "authoritative-qti-snapshot",
    });
  });

  it("exposes a worker queue handler that finalizes the queued submit and acknowledges the batch", async () => {
    const payload = await launchPreviewAttempt();
    const queued: Array<ReturnType<typeof buildSubmitFinalizationEnvelope>> = [];
    const { runtimeEnv } = buildRuntimeEnv({
      send: async (message) => {
        queued.push(message);
      },
    });
    const submitCtx = createExecutionContext();
    const submitResponse = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${payload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attemptId: payload.attemptId,
          eventId: "evt_submit_worker_queue_01",
          idempotencyKey: "idem_submit_worker_queue_01",
          sequenceNumber: 1,
          clientTimestamp: new Date().toISOString(),
          clientSessionId: "phase4_submit_queue_session",
          itemRef: payload.session.currentItemRef,
          type: "submit.requested",
          payload: {
            requestedAt: new Date().toISOString(),
          },
        }),
      }),
      submitCtx,
    );

    expect(submitResponse.status).toBe(200);
    await waitOnExecutionContext(submitCtx);

    const exportedHandler = workerExports.default as {
      queue?: (batch: MessageBatch<unknown>, env: unknown, ctx: ExecutionContext) => Promise<void>;
    };
    const batch = createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: "msg_01",
        timestamp: new Date("2026-03-27T00:30:11.000Z"),
        attempts: 1,
        body: queued[0],
      },
    ]);
    const ctx = createExecutionContext();
    const base = getBaseEnv();
    const handlerEnv = {
      HARBOR_DB: base.HARBOR_DB,
      CONTENT_BUCKET: base.CONTENT_BUCKET,
      BOOTSTRAP_SIGNING_SECRET: base.BOOTSTRAP_SIGNING_SECRET,
      LTI_TOOL_PRIVATE_KEY_JWK: base.LTI_TOOL_PRIVATE_KEY_JWK,
      ATTEMPT_COORDINATOR: base.ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: getBaseEnv().ATTEMPT_RUNTIME_METRICS,
      SUBMIT_FINALIZATION_QUEUE: observeQueue<ReturnType<typeof buildSubmitFinalizationEnvelope>>(
        env.SUBMIT_FINALIZATION_QUEUE,
        {
          async beforeSend() {
            throw new Error("queue producer is not used by the queue consumer");
          },
          sendBatchError: "queue producer is not used by the queue consumer",
        },
      ),
    };

    expect(typeof exportedHandler.queue).toBe("function");

    const queueHandler = runtimeWorker.queue as
      | ((
          batch: MessageBatch<ReturnType<typeof buildSubmitFinalizationEnvelope>>,
          env: typeof handlerEnv,
          ctx: ExecutionContext,
        ) => Promise<void>)
      | undefined;
    await queueHandler?.(batch, handlerEnv, ctx);

    const readQueueResult = getQueueResult as unknown as (
      batch: MessageBatch<ReturnType<typeof buildSubmitFinalizationEnvelope>>,
      ctx: ExecutionContext,
    ) => Promise<{ outcome: string; explicitAcks: string[] }>;
    const result = await readQueueResult(batch, ctx);
    expect(result.outcome).toBe("ok");
    expect(result.explicitAcks).toEqual(["msg_01"]);
  });

  it("returns the submit receipt before async finalization settles and then records the queue handoff", async () => {
    const payload = await launchPreviewAttempt();
    let resolveSend!: () => void;
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const queued: Array<ReturnType<typeof buildSubmitFinalizationEnvelope>> = [];
    const send = async (
      message: ReturnType<typeof buildSubmitFinalizationEnvelope>,
    ): Promise<void> => {
      queued.push(message);
      await sendPromise;
    };
    const { runtimeEnv, points } = buildRuntimeEnv({ send });
    const ctx = createExecutionContext();
    const request = new Request(`https://harbor.local/api/attempts/${payload.attemptId}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attemptId: payload.attemptId,
        eventId: "evt_submit_01",
        idempotencyKey: "idem_submit_01",
        sequenceNumber: 1,
        clientTimestamp: new Date().toISOString(),
        clientSessionId: "phase4_submit_queue_session",
        itemRef: payload.session.currentItemRef,
        type: "submit.requested",
        payload: {
          requestedAt: new Date().toISOString(),
        },
      }),
    });

    const response = await Promise.race([
      fetchWithRuntimeEnv(runtimeEnv, request, ctx),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("submit fetch waited on queue delivery"));
        }, 500);
      }),
    ]);

    expect(response.status).toBe(200);
    const receipt = await response.json<CommitAttemptEventReceipt>();
    expect(receipt).toMatchObject({
      outcome: "accepted",
      attemptId: payload.attemptId,
      acceptedSequenceNumber: 1,
      highestCommittedSequence: 1,
      attemptStatus: "submitted",
    });
    expect(points.map(readMetricPoint)).toEqual([
      {
        route: "attempt-events",
        family: "submit",
        outcome: "accepted",
        sequenceNumber: 1,
      },
    ]);

    resolveSend();
    await waitOnExecutionContext(ctx);

    expect(queued).toHaveLength(1);
    expect(queued).toEqual([
      {
        attemptId: payload.attemptId,
        eventType: "submit.requested",
        receiptId: receipt.receiptId,
        acceptedSequenceNumber: 1,
        submittedAt: receipt.serverTimestamp,
      },
    ]);
    expect(points.map(readMetricPoint)).toEqual([
      {
        route: "attempt-events",
        family: "submit",
        outcome: "accepted",
        sequenceNumber: 1,
      },
      {
        route: "submit-queue",
        family: "submit_finalization",
        outcome: "queued",
        sequenceNumber: 1,
      },
    ]);
  });

  it("persists pending finalization before queue delivery and requeues stranded submissions", async () => {
    const payload = await launchPreviewAttempt();
    const queueFailure = new Error("queue temporarily unavailable");
    const { runtimeEnv } = buildRuntimeEnv({
      send: async () => {
        throw queueFailure;
      },
    });
    const ctx = createExecutionContext();
    const response = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${payload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attemptId: payload.attemptId,
          eventId: "evt_submit_outbox_01",
          idempotencyKey: "idem_submit_outbox_01",
          sequenceNumber: 1,
          clientTimestamp: "2026-03-27T00:30:10.000Z",
          clientSessionId: "phase4_submit_queue_session",
          itemRef: payload.session.currentItemRef,
          type: "submit.requested",
          payload: {
            requestedAt: "2026-03-27T00:30:10.000Z",
          },
        }),
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    const receipt = await response.json<CommitAttemptEventReceipt>();
    await waitOnExecutionContext(ctx);

    const pending = await getBaseEnv()
      .HARBOR_DB.prepare(
        "SELECT status, source_sequence_number, source_event_type FROM result_finalizations WHERE source_receipt_id = ?",
      )
      .bind(receipt.receiptId)
      .first<{ status: string; source_sequence_number: number; source_event_type: string }>();
    expect(pending).toEqual({
      status: "pending",
      source_sequence_number: 1,
      source_event_type: "submit.requested",
    });

    const requeued: ReturnType<typeof buildSubmitFinalizationEnvelope>[] = [];
    const requeueSummary = await runPendingSubmitFinalizationRequeues({
      env: {
        ...runtimeEnv,
        SUBMIT_FINALIZATION_QUEUE: observeQueue<ReturnType<typeof buildSubmitFinalizationEnvelope>>(
          env.SUBMIT_FINALIZATION_QUEUE,
          {
            async beforeSend(message) {
              requeued.push(message);
            },
            sendBatchError: "sendBatch is not used by requeue tests",
          },
        ),
      },
    });

    expect(requeueSummary).toEqual({
      checkedCount: 1,
      queuedCount: 1,
      failedCount: 0,
    });
    expect(requeued).toEqual([
      {
        attemptId: payload.attemptId,
        eventType: "submit.requested",
        receiptId: receipt.receiptId,
        acceptedSequenceNumber: 1,
        submittedAt: receipt.serverTimestamp,
      },
    ]);
  });

  it("preserves auto-submit source type when requeueing stranded finalizations", async () => {
    const payload = await launchPreviewAttempt();
    const { runtimeEnv } = buildRuntimeEnv({
      send: async () => undefined,
    });
    const receipt: CommitAttemptEventReceipt = {
      ...buildSubmitReceipt(),
      receiptId: "rcpt_auto_submit_requeue_01",
      attemptId: payload.attemptId,
      acceptedEventId: "evt_auto_submit_requeue_01",
      acceptedSequenceNumber: 2,
      highestCommittedSequence: 2,
      serverTimestamp: "2026-03-27T00:30:01.000Z",
    };
    const envelope = buildSubmitFinalizationEnvelope({
      eventType: "timing.auto-submit.requested",
      receipt,
    });

    await ensurePendingSubmitFinalization({
      db: getBaseEnv().HARBOR_DB,
      envelope,
    });

    const requeued: ReturnType<typeof buildSubmitFinalizationEnvelope>[] = [];
    const requeueSummary = await runPendingSubmitFinalizationRequeues({
      env: {
        ...runtimeEnv,
        SUBMIT_FINALIZATION_QUEUE: observeQueue<ReturnType<typeof buildSubmitFinalizationEnvelope>>(
          env.SUBMIT_FINALIZATION_QUEUE,
          {
            async beforeSend(message) {
              requeued.push(message);
            },
            sendBatchError: "sendBatch is not used by requeue tests",
          },
        ),
      },
    });

    expect(requeueSummary).toEqual({
      checkedCount: 1,
      queuedCount: 1,
      failedCount: 0,
    });
    expect(requeued).toEqual([
      {
        attemptId: payload.attemptId,
        eventType: "timing.auto-submit.requested",
        receiptId: receipt.receiptId,
        acceptedSequenceNumber: 2,
        submittedAt: receipt.serverTimestamp,
      },
    ]);
  });

  it("queues finalization when a submitted receipt is replayed as a duplicate", async () => {
    const payload = await launchPreviewAttempt();
    const queued: Array<ReturnType<typeof buildSubmitFinalizationEnvelope>> = [];
    const { runtimeEnv } = buildRuntimeEnv({
      send: async (message) => {
        queued.push(message);
      },
    });
    const event = {
      attemptId: payload.attemptId,
      eventId: "evt_submit_duplicate_queue_01",
      idempotencyKey: "idem_submit_duplicate_queue_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-27T00:30:10.000Z",
      clientSessionId: "phase4_submit_queue_session",
      itemRef: payload.session.currentItemRef,
      type: "submit.requested",
      payload: {
        requestedAt: "2026-03-27T00:30:10.000Z",
      },
    };

    const firstCtx = createExecutionContext();
    const first = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${payload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
      }),
      firstCtx,
    );
    expect(first.status).toBe(200);
    const acceptedReceipt = await first.json<CommitAttemptEventReceipt>();
    await waitOnExecutionContext(firstCtx);

    const secondCtx = createExecutionContext();
    const duplicate = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${payload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
      }),
      secondCtx,
    );
    expect(duplicate.status).toBe(200);
    const duplicateReceipt = await duplicate.json<AttemptEventCommitResponse>();
    expect(duplicateReceipt).toMatchObject({
      outcome: "duplicate",
      storedReceipt: {
        receiptId: acceptedReceipt.receiptId,
        attemptStatus: "submitted",
      },
    });
    await waitOnExecutionContext(secondCtx);

    expect(queued).toEqual([
      {
        attemptId: payload.attemptId,
        eventType: "submit.requested",
        receiptId: acceptedReceipt.receiptId,
        acceptedSequenceNumber: 1,
        submittedAt: acceptedReceipt.serverTimestamp,
      },
      {
        attemptId: payload.attemptId,
        eventType: "submit.requested",
        receiptId: acceptedReceipt.receiptId,
        acceptedSequenceNumber: 1,
        submittedAt: acceptedReceipt.serverTimestamp,
      },
    ]);
  });
});
