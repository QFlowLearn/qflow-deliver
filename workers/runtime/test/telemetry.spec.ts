import JSZip from "jszip";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  BootstrapEnvelope,
  BootstrapPayload,
  DeliveryPolicySnapshot,
} from "@harbor/attempt-protocol";
import type { Env as RuntimeEnv } from "../src/index";
import runtimeWorker from "../src/index";
import { runtimeWorker as runtimeConfiguration } from "../runtime-config";
import {
  ATTEMPT_RUNTIME_METRIC_BLOB_LABELS,
  ATTEMPT_RUNTIME_METRIC_DOUBLE_LABELS,
  ATTEMPT_RUNTIME_METRIC_INDEX_LABELS,
  ATTEMPT_RUNTIME_METRICS_DATASET,
  buildAttemptEventMetric,
  buildOverrideMetric,
  createAttemptRuntimeLog,
  toAnalyticsEnginePoint,
} from "../src/observability/attempt-runtime-metrics";
import type { SubmitFinalizationEnvelope } from "../src/queues/submit-finalization";
import { createQueueMock } from "./queue-mock";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

function readRuntimeBindings(): {
  ATTEMPT_RUNTIME_METRICS?: AnalyticsEngineDataset;
  SUBMIT_FINALIZATION_QUEUE?: Queue<unknown>;
  RESULT_EXPORT_QUEUE?: Queue<unknown>;
} {
  return env as unknown as {
    ATTEMPT_RUNTIME_METRICS?: AnalyticsEngineDataset;
    SUBMIT_FINALIZATION_QUEUE?: Queue<unknown>;
    RESULT_EXPORT_QUEUE?: Queue<unknown>;
  };
}

function getBaseEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET: string;
  LTI_TOOL_PRIVATE_KEY_JWK: string;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
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
  zip.file("items/item-1.xml", itemXml);
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

async function updatePublishedDeliveryPolicy(input: {
  assessmentVersionId: string;
  deliveryPolicy: DeliveryPolicySnapshot;
}): Promise<void> {
  const { HARBOR_DB } = getBaseEnv();
  await HARBOR_DB.prepare(
    "UPDATE assessment_versions SET delivery_policy_snapshot = ? WHERE id = ?",
  )
    .bind(JSON.stringify(input.deliveryPolicy), input.assessmentVersionId)
    .run();
}

async function updateAttemptStartedAt(attemptId: string, startedAt: string): Promise<void> {
  const { HARBOR_DB } = getBaseEnv();
  await HARBOR_DB.prepare("UPDATE attempt_entries SET created_at = ? WHERE id = ?")
    .bind(startedAt, attemptId)
    .run();
}

async function readLatestAttemptId(): Promise<string> {
  const { HARBOR_DB } = getBaseEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT id FROM attempt_entries ORDER BY created_at DESC LIMIT 1",
  ).first<{ id: string }>();

  expect(attempt?.id).toBeTruthy();
  return attempt!.id;
}

async function launchPreviewAttempt(input: {
  tenantId: string;
  assessmentSlug: string;
  clientSessionId: string;
  deliveryPolicy?: DeliveryPolicySnapshot;
  startedAtBeforeBootstrap?: string;
}): Promise<BootstrapPayload> {
  const published = await publishFixture({
    tenantId: input.tenantId,
    assessmentSlug: input.assessmentSlug,
  });

  if (input.deliveryPolicy) {
    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: input.deliveryPolicy,
    });
  }

  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: published.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: "preview_phase4_telemetry",
      displayName: "Phase 4 Telemetry Preview",
    },
  });

  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  if (input.startedAtBeforeBootstrap) {
    await updateAttemptStartedAt(await readLatestAttemptId(), input.startedAtBeforeBootstrap);
  }
  const bootstrap = await postJson("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: input.clientSessionId,
  });

  expect(bootstrap.status).toBe(200);
  return bootstrap.json<BootstrapPayload>();
}

function buildRuntimeEnv(input?: {
  onSend?: (message: SubmitFinalizationEnvelope) => Promise<void>;
}): {
  runtimeEnv: RuntimeEnv;
  points: AnalyticsEngineDataPoint[];
  queued: SubmitFinalizationEnvelope[];
} {
  const base = getBaseEnv();
  const points: AnalyticsEngineDataPoint[] = [];
  const queued: SubmitFinalizationEnvelope[] = [];

  return {
    runtimeEnv: {
      HARBOR_DB: base.HARBOR_DB,
      CONTENT_BUCKET: base.CONTENT_BUCKET,
      BOOTSTRAP_SIGNING_SECRET: base.BOOTSTRAP_SIGNING_SECRET,
      ALLOW_UNSAFE_LOCAL_INTERNAL_API: "true",
      LTI_TOOL_PRIVATE_KEY_JWK: base.LTI_TOOL_PRIVATE_KEY_JWK,
      ATTEMPT_COORDINATOR: base.ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: {
        writeDataPoint(point) {
          points.push(point ?? {});
        },
      } as AnalyticsEngineDataset,
      SUBMIT_FINALIZATION_QUEUE: createQueueMock<SubmitFinalizationEnvelope>({
        async send(message) {
          queued.push(message);
          await input?.onSend?.(message);
        },
        sendBatchError: "sendBatch is not used in phase 4 tests",
      }),
    },
    points,
    queued,
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
  attemptId: string;
  route: string;
  family: string;
  eventType: string;
  outcome: string;
  attemptStatus: string;
  graceWindow: string;
  actorRole: string;
  latencyMs: number;
  sequenceNumber: number;
  highestCommittedSequence: number;
} {
  return {
    attemptId: String(point.indexes?.[0]),
    route: String(point.blobs?.[0]),
    family: String(point.blobs?.[1]),
    eventType: String(point.blobs?.[2]),
    outcome: String(point.blobs?.[3]),
    attemptStatus: String(point.blobs?.[4]),
    graceWindow: String(point.blobs?.[5]),
    actorRole: String(point.blobs?.[6]),
    latencyMs: Number(point.doubles?.[0]),
    sequenceNumber: Number(point.doubles?.[1]),
    highestCommittedSequence: Number(point.doubles?.[2]),
  };
}

function buildResponseChangedEvent(input: {
  attemptId: string;
  sequenceNumber: number;
  idempotencyKey: string;
  clientSessionId: string;
  itemRef: BootstrapPayload["session"]["currentItemRef"];
}): Record<string, unknown> {
  return {
    attemptId: input.attemptId,
    eventId: `evt_${input.idempotencyKey}`,
    idempotencyKey: input.idempotencyKey,
    sequenceNumber: input.sequenceNumber,
    clientTimestamp: new Date().toISOString(),
    clientSessionId: input.clientSessionId,
    itemRef: input.itemRef,
    type: "response.changed",
    payload: {
      responseKey: `RESPONSE_${input.sequenceNumber}`,
      responseState: {
        value: input.sequenceNumber,
      },
    },
  };
}

beforeEach(async () => {
  await resetBindings();
});

describe("phase 4 telemetry bindings", () => {
  it("binds one analytics dataset plus both result queues with explicit DLQ paths", () => {
    const config = runtimeConfiguration;
    const runtimeBindings = readRuntimeBindings();

    expect(config.observability).toMatchObject({
      enabled: true,
      logs: {
        enabled: true,
        invocationLogs: true,
      },
    });
    expect(config.env.ATTEMPT_RUNTIME_METRICS).toEqual({
      type: "analytics-engine-dataset",
      name: "ATTEMPT_RUNTIME_METRICS",
    });
    expect(config.env.SUBMIT_FINALIZATION_QUEUE).toEqual({
      type: "queue",
      name: "harbor-submit-finalization",
    });
    expect(config.env.RESULT_EXPORT_QUEUE).toEqual({
      type: "queue",
      name: "harbor-result-export",
    });
    expect(config.triggers.filter((trigger) => trigger.type === "queue")).toEqual([
      {
        type: "queue",
        name: "harbor-submit-finalization",
        deadLetterQueue: "harbor-submit-finalization-dlq",
      },
      { type: "queue", name: "harbor-result-export", deadLetterQueue: "harbor-result-export-dlq" },
    ]);
    expect(typeof runtimeBindings.ATTEMPT_RUNTIME_METRICS?.writeDataPoint).toBe("function");
    expect(typeof runtimeBindings.SUBMIT_FINALIZATION_QUEUE?.send).toBe("function");
    expect(typeof runtimeBindings.RESULT_EXPORT_QUEUE?.send).toBe("function");
  });
});

describe("phase 4 runtime telemetry", () => {
  it("records authoritative commit outcomes and grace-window accepts on the attempt-event route", async () => {
    const activePayload = await launchPreviewAttempt({
      tenantId: "tenant_phase4_telemetry_active",
      assessmentSlug: "phase4-telemetry-active",
      clientSessionId: "phase4_session_active",
    });
    const gracePayload = await launchPreviewAttempt({
      tenantId: "tenant_phase4_telemetry_grace",
      assessmentSlug: "phase4-telemetry-grace",
      clientSessionId: "phase4_session_grace",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
      startedAtBeforeBootstrap: new Date(Date.now() - 75_000).toISOString(),
    });

    const { runtimeEnv, points } = buildRuntimeEnv();

    const acceptedCtx = createExecutionContext();
    const accepted = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${activePayload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          buildResponseChangedEvent({
            attemptId: activePayload.attemptId,
            sequenceNumber: 1,
            idempotencyKey: "accepted",
            clientSessionId: "phase4_session_active",
            itemRef: activePayload.session.currentItemRef,
          }),
        ),
      }),
      acceptedCtx,
    );
    expect(accepted.status).toBe(200);
    await waitOnExecutionContext(acceptedCtx);

    const duplicateCtx = createExecutionContext();
    const duplicate = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${activePayload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          buildResponseChangedEvent({
            attemptId: activePayload.attemptId,
            sequenceNumber: 1,
            idempotencyKey: "accepted",
            clientSessionId: "phase4_session_active",
            itemRef: activePayload.session.currentItemRef,
          }),
        ),
      }),
      duplicateCtx,
    );
    expect(duplicate.status).toBe(200);
    await waitOnExecutionContext(duplicateCtx);

    const staleSequenceCtx = createExecutionContext();
    const staleSequence = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${activePayload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          buildResponseChangedEvent({
            attemptId: activePayload.attemptId,
            sequenceNumber: 1,
            idempotencyKey: "stale-sequence",
            clientSessionId: "phase4_session_active",
            itemRef: activePayload.session.currentItemRef,
          }),
        ),
      }),
      staleSequenceCtx,
    );
    expect(staleSequence.status).toBe(200);
    await waitOnExecutionContext(staleSequenceCtx);

    const gapCtx = createExecutionContext();
    const gap = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${activePayload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          buildResponseChangedEvent({
            attemptId: activePayload.attemptId,
            sequenceNumber: 3,
            idempotencyKey: "gap",
            clientSessionId: "phase4_session_active",
            itemRef: activePayload.session.currentItemRef,
          }),
        ),
      }),
      gapCtx,
    );
    expect(gap.status).toBe(200);
    await waitOnExecutionContext(gapCtx);

    const staleSessionCtx = createExecutionContext();
    const staleSession = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${activePayload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          buildResponseChangedEvent({
            attemptId: activePayload.attemptId,
            sequenceNumber: 2,
            idempotencyKey: "stale-session",
            clientSessionId: "phase4_session_other",
            itemRef: activePayload.session.currentItemRef,
          }),
        ),
      }),
      staleSessionCtx,
    );
    expect(staleSession.status).toBe(200);
    await waitOnExecutionContext(staleSessionCtx);

    const graceCtx = createExecutionContext();
    const graceAccepted = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/api/attempts/${gracePayload.attemptId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          buildResponseChangedEvent({
            attemptId: gracePayload.attemptId,
            sequenceNumber: 1,
            idempotencyKey: "grace-accepted",
            clientSessionId: "phase4_session_grace",
            itemRef: gracePayload.session.currentItemRef,
          }),
        ),
      }),
      graceCtx,
    );
    expect(graceAccepted.status).toBe(200);
    await waitOnExecutionContext(graceCtx);

    const metrics = points.map(readMetricPoint);
    expect(metrics).toHaveLength(6);
    expect(metrics.map((metric) => metric.outcome)).toEqual([
      "accepted",
      "duplicate",
      "stale_sequence",
      "gap",
      "stale_session",
      "accepted",
    ]);
    expect(metrics[0]).toMatchObject({
      route: "attempt-events",
      family: "commit",
      eventType: "response.changed",
      attemptStatus: "active",
      graceWindow: "standard",
      actorRole: "candidate",
      sequenceNumber: 1,
      highestCommittedSequence: 1,
    });
    expect(metrics[2]).toMatchObject({
      outcome: "stale_sequence",
      sequenceNumber: 1,
      highestCommittedSequence: 1,
    });
    expect(metrics[3]).toMatchObject({
      outcome: "gap",
      sequenceNumber: 3,
      highestCommittedSequence: 1,
    });
    expect(metrics[4]).toMatchObject({
      outcome: "stale_session",
      sequenceNumber: 2,
      highestCommittedSequence: 1,
    });
    expect(metrics[5]).toMatchObject({
      attemptId: gracePayload.attemptId,
      attemptStatus: "accepting_late_within_grace",
      graceWindow: "within_grace",
      sequenceNumber: 1,
      highestCommittedSequence: 1,
    });
    expect(metrics.every((metric) => metric.latencyMs >= 0)).toBe(true);
  });

  it("records override telemetry on the real operator-action path", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_phase4_override",
      assessmentSlug: "phase4-override",
      clientSessionId: "phase4_session_override",
    });
    const { runtimeEnv, points } = buildRuntimeEnv();
    const ctx = createExecutionContext();

    const response = await fetchWithRuntimeEnv(
      runtimeEnv,
      new Request(`https://harbor.local/internal/attempts/${launched.attemptId}/actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actionId: "act_extend_01",
          type: "extend-time",
          actor: {
            role: "operator",
            actorId: "operator_01",
            displayName: "Ops",
          },
          reason: "Approved extension",
          effectiveAt: new Date().toISOString(),
          additionalTimeSeconds: 120,
        }),
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);

    const [metric] = points.map(readMetricPoint);
    expect(metric).toMatchObject({
      attemptId: launched.attemptId,
      route: "operator-actions",
      family: "override",
      eventType: "extend-time",
      outcome: "applied",
      attemptStatus: "active",
      actorRole: "operator",
      sequenceNumber: 1,
      highestCommittedSequence: 1,
    });
    expect(metric.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("phase 4 telemetry contracts", () => {
  it("keeps fixed metric dimensions for commit, submit, replay, and override outcomes", () => {
    expect(ATTEMPT_RUNTIME_METRICS_DATASET).toBe("ATTEMPT_RUNTIME_METRICS");
    expect(ATTEMPT_RUNTIME_METRIC_INDEX_LABELS).toEqual(["attemptId"]);
    expect(ATTEMPT_RUNTIME_METRIC_BLOB_LABELS).toEqual([
      "route",
      "family",
      "eventType",
      "outcome",
      "attemptStatus",
      "graceWindow",
      "actorRole",
    ]);
    expect(ATTEMPT_RUNTIME_METRIC_DOUBLE_LABELS).toEqual([
      "latencyMs",
      "sequenceNumber",
      "highestCommittedSequence",
    ]);

    const acceptedMetric = buildAttemptEventMetric({
      attemptId: "attempt_accepted",
      eventType: "response.changed",
      latencyMs: 28,
      response: {
        outcome: "accepted",
        receiptId: "rcpt_01",
        attemptId: "attempt_accepted",
        acceptedEventId: "evt_01",
        acceptedSequenceNumber: 4,
        highestCommittedSequence: 4,
        attemptStatus: "active",
        currentItemRef: {
          itemId: "item-1",
          itemHref: "items/item-1.xml",
        },
        timing: {
          startedAt: "2026-03-27T00:00:00.000Z",
          expiresAt: "2026-03-27T00:30:00.000Z",
          softCloseAt: "2026-03-27T00:30:00.000Z",
          acceptUntil: "2026-03-27T00:30:30.000Z",
          remainingTimeSeconds: 10,
        },
        policy: {
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
        },
        serverTimestamp: "2026-03-27T00:29:50.000Z",
      },
    });
    const gapMetric = buildAttemptEventMetric({
      attemptId: "attempt_gap",
      eventType: "response.changed",
      latencyMs: 44,
      response: {
        outcome: "gap",
        attemptId: "attempt_gap",
        highestCommittedSequence: 7,
        expectedNextSequence: 8,
        attemptStatus: "active",
        currentItemRef: {
          itemId: "item-1",
          itemHref: "items/item-1.xml",
        },
        timing: {
          startedAt: "2026-03-27T00:00:00.000Z",
          expiresAt: "2026-03-27T00:30:00.000Z",
          softCloseAt: "2026-03-27T00:30:00.000Z",
          acceptUntil: "2026-03-27T00:30:30.000Z",
          remainingTimeSeconds: 10,
        },
        policy: {
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
        },
        requestedSequenceNumber: 10,
        replayFromSequenceNumber: 8,
      },
    });
    const graceSubmitMetric = buildAttemptEventMetric({
      attemptId: "attempt_submit",
      eventType: "submit.requested",
      latencyMs: 91,
      response: {
        outcome: "accepted",
        receiptId: "rcpt_submit_01",
        attemptId: "attempt_submit",
        acceptedEventId: "evt_submit_01",
        acceptedSequenceNumber: 8,
        highestCommittedSequence: 8,
        attemptStatus: "accepting_late_within_grace",
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
        policy: {
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
        },
        serverTimestamp: "2026-03-27T00:30:10.000Z",
      },
    });
    const overrideMetric = buildOverrideMetric({
      attemptId: "attempt_override",
      actionType: "extend-time",
      actorRole: "operator",
      attemptStatus: "active",
      latencyMs: 17,
      overlayRevision: 3,
    });

    expect(acceptedMetric).toMatchObject({
      family: "commit",
      eventType: "response.changed",
      outcome: "accepted",
      attemptStatus: "active",
      graceWindow: "standard",
      actorRole: "candidate",
      latencyMs: 28,
      sequenceNumber: 4,
      highestCommittedSequence: 4,
    });
    expect(gapMetric).toMatchObject({
      family: "commit",
      outcome: "gap",
      sequenceNumber: 10,
      highestCommittedSequence: 7,
    });
    expect(graceSubmitMetric).toMatchObject({
      family: "submit",
      outcome: "accepted",
      attemptStatus: "accepting_late_within_grace",
      graceWindow: "within_grace",
      sequenceNumber: 8,
    });
    expect(overrideMetric).toMatchObject({
      family: "override",
      eventType: "extend-time",
      outcome: "applied",
      actorRole: "operator",
      sequenceNumber: 3,
      highestCommittedSequence: 3,
    });

    expect(toAnalyticsEnginePoint(graceSubmitMetric)).toEqual({
      indexes: ["attempt_submit"],
      blobs: [
        "attempt-events",
        "submit",
        "submit.requested",
        "accepted",
        "accepting_late_within_grace",
        "within_grace",
        "candidate",
      ],
      doubles: [91, 8, 8],
    });
    expect(createAttemptRuntimeLog(overrideMetric)).toMatchObject({
      dataset: "ATTEMPT_RUNTIME_METRICS",
      family: "override",
      outcome: "applied",
      attemptId: "attempt_override",
    });
  });
});
