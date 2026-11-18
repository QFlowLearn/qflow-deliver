import JSZip from "jszip";
import { runDurableObjectAlarm, applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  AttemptEventEnvelope,
  BootstrapEnvelope,
  BootstrapPayload,
  CommitAttemptEventReceipt,
  DeliveryPolicySnapshot,
} from "@harbor/attempt-protocol";
import type { DeliveryManifest } from "@harbor/content-model";
import { runOutboxAlarm } from "./outbox-alarm";
import { runPendingSubmitFinalizationRequeues } from "../src/queues/submit-finalization";
import { processSubmitFinalizationEnvelope } from "../src/queues/submit-finalization";
import { observeQueue } from "./queue-fixture";
import type { SubmitFinalizationEnvelope } from "../src/queues/submit-finalization";

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

const CURRENT_ITEM = {
  itemId: "item-1",
  itemHref: "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/items/item-1.xml",
} as const;

function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    ATTEMPT_COORDINATOR: DurableObjectNamespace;
    ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "attempt_deadline_jobs",
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

async function updatePublishedDeliveryPolicy(input: {
  assessmentVersionId: string;
  deliveryPolicy: DeliveryPolicySnapshot;
}): Promise<void> {
  const { HARBOR_DB } = getTestEnv();
  await HARBOR_DB.prepare(
    "UPDATE assessment_versions SET delivery_policy_snapshot = ? WHERE id = ?",
  )
    .bind(JSON.stringify(input.deliveryPolicy), input.assessmentVersionId)
    .run();
}

async function launchPreviewAttempt(seed: {
  tenantId: string;
  assessmentSlug: string;
}): Promise<BootstrapEnvelope> {
  const published = await publishFixture(seed);
  await updatePublishedDeliveryPolicy({
    assessmentVersionId: published.assessmentVersionId,
    deliveryPolicy: {
      launchMode: "preview",
      navigationMode: "linear",
      maxAttempts: 1,
      timeLimitSeconds: 60,
      gracePeriodSeconds: 30,
    },
  });

  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: published.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: "preview_attempt_timing",
      displayName: "Attempt Timing Preview",
    },
  });

  expect(launch.status).toBe(201);
  return launch.json<BootstrapEnvelope>();
}

async function preparePreviewAttempt(input: {
  tenantId: string;
  assessmentSlug: string;
  deliveryPolicy: DeliveryPolicySnapshot;
  includeReviewItem?: boolean;
  qtiTiming?: DeliveryManifest["qtiTiming"];
}): Promise<{
  envelope: BootstrapEnvelope;
  reviewItemRef: {
    itemId: string;
    itemHref: string;
  } | null;
}> {
  const published = await publishFixture({
    tenantId: input.tenantId,
    assessmentSlug: input.assessmentSlug,
  });
  const reviewItemRef = input.includeReviewItem
    ? await appendReviewItemToManifest(published.manifestObjectKey)
    : null;
  if (input.qtiTiming) {
    await applyQtiTimingToManifest(published.manifestObjectKey, input.qtiTiming);
  }

  await updatePublishedDeliveryPolicy({
    assessmentVersionId: published.assessmentVersionId,
    deliveryPolicy: input.deliveryPolicy,
  });

  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: published.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: "preview_attempt_timing",
      displayName: "Attempt Timing Preview",
    },
  });

  expect(launch.status).toBe(201);
  return {
    envelope: await launch.json<BootstrapEnvelope>(),
    reviewItemRef,
  };
}

async function readLatestAttemptId(): Promise<string> {
  const { HARBOR_DB } = getTestEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT id FROM attempt_entries ORDER BY created_at DESC LIMIT 1",
  ).first<{ id: string }>();

  expect(attempt?.id).toBeTruthy();
  return attempt!.id;
}

async function updateAttemptStartedAt(attemptId: string, startedAt: string): Promise<void> {
  const { HARBOR_DB } = getTestEnv();
  await HARBOR_DB.prepare("UPDATE attempt_entries SET created_at = ? WHERE id = ?")
    .bind(startedAt, attemptId)
    .run();
}

async function appendReviewItemToManifest(manifestObjectKey: string): Promise<{
  itemId: string;
  itemHref: string;
}> {
  const { CONTENT_BUCKET } = getTestEnv();
  const manifestObject = await CONTENT_BUCKET.get(manifestObjectKey);
  expect(manifestObject).toBeTruthy();
  const manifest = await manifestObject!.json<DeliveryManifest>();
  const reviewObjectKey = manifestObjectKey.replace(
    "/manifests/delivery.json",
    "/items/item-review.xml",
  );
  const reviewItemRef = {
    itemId: "item-review",
    itemHref: "items/item-review.xml",
  };

  const nextManifest: DeliveryManifest = {
    ...manifest,
    itemOrder: [...manifest.itemOrder, reviewItemRef.itemId],
    items: {
      ...manifest.items,
      [reviewItemRef.itemId]: {
        id: reviewItemRef.itemId,
        identifier: "review-item",
        title: "Review Item",
        href: "items/item-review.xml",
        deliveryObjectKey: reviewObjectKey.replace("/items/", "/delivery/items/"),
        objectKey: reviewObjectKey,
        assetIds: [],
      },
    },
  };

  await CONTENT_BUCKET.put(manifestObjectKey, JSON.stringify(nextManifest), {
    httpMetadata: {
      contentType: "application/json",
    },
  });

  return reviewItemRef;
}

async function applyQtiTimingToManifest(
  manifestObjectKey: string,
  qtiTiming: DeliveryManifest["qtiTiming"],
): Promise<void> {
  const { CONTENT_BUCKET } = getTestEnv();
  const manifestObject = await CONTENT_BUCKET.get(manifestObjectKey);
  expect(manifestObject).toBeTruthy();
  const manifest = await manifestObject!.json<DeliveryManifest>();
  await CONTENT_BUCKET.put(
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

async function exchangeBootstrap(
  bootstrapToken: string,
  clientSessionId = "client_session_timing_01",
): Promise<Response> {
  return postJson("/api/bootstrap", {
    bootstrapToken,
    clientSessionId,
  });
}

async function commitAttemptEvent(
  attemptId: string,
  event: AttemptEventEnvelope,
): Promise<Response> {
  return postJson(`/api/attempts/${attemptId}/events`, event);
}

function buildDeadlineWorkerEnv(
  sent: SubmitFinalizationEnvelope[],
): Parameters<typeof runPendingSubmitFinalizationRequeues>[0]["env"] &
  Parameters<typeof processSubmitFinalizationEnvelope>[1] {
  const base = getTestEnv();

  return {
    HARBOR_DB: base.HARBOR_DB,
    CONTENT_BUCKET: base.CONTENT_BUCKET,
    ATTEMPT_COORDINATOR: base.ATTEMPT_COORDINATOR,
    ATTEMPT_RUNTIME_METRICS: {
      writeDataPoint() {
        return undefined;
      },
    } as AnalyticsEngineDataset,
    SUBMIT_FINALIZATION_QUEUE: observeQueue<SubmitFinalizationEnvelope>(
      env.SUBMIT_FINALIZATION_QUEUE,
      {
        async beforeSend(message) {
          sent.push(message);
        },
        sendBatchError: "sendBatch is not used by deadline auto-submit tests",
      },
    ),
  };
}

beforeEach(async () => {
  await resetBindings();
});

function createStartedAtOffset(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function buildTwoItemQtiTiming(input?: {
  itemMinTimeSeconds?: number;
  itemMaxTimeSeconds?: number;
  allowLateSubmission?: boolean;
}): NonNullable<DeliveryManifest["qtiTiming"]> {
  const itemTimeLimits =
    input?.itemMinTimeSeconds !== undefined ||
    input?.itemMaxTimeSeconds !== undefined ||
    input?.allowLateSubmission !== undefined
      ? {
          scopeType: "assessment-item-ref" as const,
          identifier: "item-1",
          minTimeSeconds: input.itemMinTimeSeconds ?? null,
          maxTimeSeconds: input.itemMaxTimeSeconds ?? null,
          allowLateSubmission: input.allowLateSubmission ?? false,
          rawAttributes: {
            "min-time":
              input.itemMinTimeSeconds !== undefined ? String(input.itemMinTimeSeconds) : null,
            "max-time":
              input.itemMaxTimeSeconds !== undefined ? String(input.itemMaxTimeSeconds) : null,
            "allow-late-submission":
              input.allowLateSubmission !== undefined ? String(input.allowLateSubmission) : null,
          },
        }
      : null;

  return {
    assessmentTest: {
      identifier: "timed-test",
      title: "Timed Test",
      timeLimits: null,
    },
    testParts: [
      {
        identifier: "part-1",
        navigationMode: "linear",
        submissionMode: "individual",
        timeLimits: null,
        sectionIds: ["section-1"],
      },
    ],
    sections: [
      {
        identifier: "section-1",
        title: "Timed Section",
        visible: true,
        testPartId: "part-1",
        timeLimits: null,
        itemRefIds: ["item-1", "item-review"],
      },
    ],
    itemRefs: [
      {
        identifier: "item-1",
        href: "items/item-1.xml",
        itemId: "item-1",
        testPartId: "part-1",
        sectionId: "section-1",
        timeLimits: itemTimeLimits,
        itemSessionControl: null,
      },
      {
        identifier: "item-review",
        href: "items/item-review.xml",
        itemId: "item-review",
        testPartId: "part-1",
        sectionId: "section-1",
        timeLimits: null,
        itemSessionControl: null,
      },
    ],
  };
}

describe("phase 2 timing contracts", () => {
  it("extends the pinned delivery policy and bootstrap session types with additive grace and acceptance-window fields", () => {
    expectTypeOf<DeliveryPolicySnapshot>().toMatchTypeOf<{
      gracePeriodSeconds?: number | null;
    }>();

    const payload: BootstrapPayload = {
      attemptId: "attempt_timing_01",
      assessmentVersionId: "vers_timing_01",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
      manifest: {
        manifestObjectKey:
          "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/manifests/delivery.json",
      },
      launch: {
        mode: "preview",
        actor: {
          kind: "preview-operator",
          id: "preview_attempt_timing",
          displayName: "Attempt Timing Preview",
        },
      },
      session: {
        currentItemRef: CURRENT_ITEM,
        sequence: null,
        timing: {
          startedAt: "2026-03-26T22:00:00.000Z",
          expiresAt: "2026-03-26T22:01:00.000Z",
          softCloseAt: "2026-03-26T22:01:00.000Z",
          acceptUntil: "2026-03-26T22:01:30.000Z",
          remainingTimeSeconds: 60,
        },
        attemptStatus: "active",
      },
    };

    expect(payload.deliveryPolicy.gracePeriodSeconds).toBe(30);
    expect(payload.session.timing?.softCloseAt).toBe("2026-03-26T22:01:00.000Z");
    expect(payload.session.timing?.acceptUntil).toBe("2026-03-26T22:01:30.000Z");
    expect(payload.session.attemptStatus).toBe("active");
  });
});

describe("phase 2 timing bootstrap and receipt projection", () => {
  it("projects pinned time-limit and grace-window boundaries through bootstrap timing state", async () => {
    const startedAt = createStartedAtOffset(-10_000);
    const softCloseAt = addSeconds(startedAt, 60);
    const acceptUntil = addSeconds(startedAt, 90);
    const envelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_bootstrap",
      assessmentSlug: "basic-assessment",
    });
    await updateAttemptStartedAt(await readLatestAttemptId(), startedAt);

    const bootstrap = await exchangeBootstrap(envelope.bootstrapToken);
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();

    expect(payload.deliveryPolicy.timeLimitSeconds).toBe(60);
    expect(payload.deliveryPolicy.gracePeriodSeconds).toBe(30);
    expect(payload.session.timing?.startedAt).toBe(startedAt);
    expect(payload.session.timing?.expiresAt).toBe(softCloseAt);
    expect(payload.session.timing?.softCloseAt).toBe(softCloseAt);
    expect(payload.session.timing?.acceptUntil).toBe(acceptUntil);
    expect(payload.session.timing?.remainingTimeSeconds).toBeGreaterThanOrEqual(49);
    expect(payload.session.timing?.remainingTimeSeconds).toBeLessThanOrEqual(50);
    expect(payload.session.attemptStatus).toBe("active");
  });

  it("preserves mutable writes after the acceptance boundary with recoverable delivery-state details", async () => {
    const startedAt = createStartedAtOffset(-91_000);
    const acceptUntil = addSeconds(startedAt, 90);
    const envelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_expired_event",
      assessmentSlug: "basic-assessment",
    });
    const attemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(attemptId, startedAt);

    const expired = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_timing_expired_01",
      idempotencyKey: "idem_timing_expired_01",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_01",
      itemRef: CURRENT_ITEM,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_TIMING_EXPIRED",
        responseState: {
          candidateResponse: "C",
        },
      },
    });

    expect(expired.status).toBe(200);
    const expiredPayload = await expired.json<{
      outcome?: string;
      attemptStatus?: string;
      timing?: {
        acceptUntil?: string | null;
      };
    }>();

    expect(expiredPayload.outcome).toBe("late_preserved");
    expect(expiredPayload.attemptStatus).toBe("expired_pending_recovery");
    expect(expiredPayload.timing?.acceptUntil).toBe(acceptUntil);

    const stub = getTestEnv().ATTEMPT_COORDINATOR.get(
      getTestEnv().ATTEMPT_COORDINATOR.idFromName(attemptId),
    );
    await runDurableObjectAlarm(stub);
    const bootstrap = await exchangeBootstrap(envelope.bootstrapToken);
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();
    expect(payload.session.attemptStatus).toBe("submitted");
  });

  it("enforces navigation from the pinned delivery policy and authoritative current item", async () => {
    const startedAt = createStartedAtOffset(-10_000);
    const linear = await preparePreviewAttempt({
      tenantId: "tenant_attempt_timing_linear",
      assessmentSlug: "basic-assessment",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
      includeReviewItem: true,
    });
    expect(linear.reviewItemRef).toBeTruthy();
    const linearAttemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(linearAttemptId, startedAt);
    const linearBootstrap = await exchangeBootstrap(linear.envelope.bootstrapToken);
    expect(linearBootstrap.status).toBe(200);
    const linearPayload = await linearBootstrap.json<BootstrapPayload>();

    const linearForward = await commitAttemptEvent(linearAttemptId, {
      attemptId: linearAttemptId,
      eventId: "evt_navigation_linear_forward",
      idempotencyKey: "idem_navigation_linear_forward",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_01",
      itemRef: linearPayload.session.currentItemRef,
      type: "navigation.requested",
      payload: {
        targetItemRef: linear.reviewItemRef!,
      },
    });

    expect(linearForward.status).toBe(200);
    const linearForwardReceipt = await linearForward.json<CommitAttemptEventReceipt>();
    expect(linearForwardReceipt.currentItemRef).toEqual(linear.reviewItemRef);

    const linearBackward = await commitAttemptEvent(linearAttemptId, {
      attemptId: linearAttemptId,
      eventId: "evt_navigation_linear_backward",
      idempotencyKey: "idem_navigation_linear_backward",
      sequenceNumber: 2,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_01",
      itemRef: linear.reviewItemRef!,
      type: "navigation.requested",
      payload: {
        targetItemRef: linearPayload.session.currentItemRef,
      },
    });

    expect(linearBackward.status).toBe(409);
    const linearBackwardPayload = await linearBackward.json<{
      error: string;
      currentItemRef?: {
        itemId: string;
      };
    }>();
    expect(linearBackwardPayload.error.toLowerCase()).toContain("linear");
    expect(linearBackwardPayload.currentItemRef?.itemId).toBe("item-review");

    const free = await preparePreviewAttempt({
      tenantId: "tenant_attempt_timing_free",
      assessmentSlug: "basic-assessment",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "free",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
      includeReviewItem: true,
    });
    expect(free.reviewItemRef).toBeTruthy();
    const freeAttemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(freeAttemptId, startedAt);
    const freeBootstrap = await exchangeBootstrap(free.envelope.bootstrapToken);
    expect(freeBootstrap.status).toBe(200);
    const freePayload = await freeBootstrap.json<BootstrapPayload>();

    const freeForward = await commitAttemptEvent(freeAttemptId, {
      attemptId: freeAttemptId,
      eventId: "evt_navigation_free_forward",
      idempotencyKey: "idem_navigation_free_forward",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_02",
      itemRef: freePayload.session.currentItemRef,
      type: "navigation.requested",
      payload: {
        targetItemRef: free.reviewItemRef!,
      },
    });
    expect(freeForward.status).toBe(200);

    const freeBackward = await commitAttemptEvent(freeAttemptId, {
      attemptId: freeAttemptId,
      eventId: "evt_navigation_free_backward",
      idempotencyKey: "idem_navigation_free_backward",
      sequenceNumber: 2,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_02",
      itemRef: free.reviewItemRef!,
      type: "navigation.requested",
      payload: {
        targetItemRef: freePayload.session.currentItemRef,
      },
    });

    expect(freeBackward.status).toBe(200);
    const freeBackwardReceipt = await freeBackward.json<CommitAttemptEventReceipt>();
    expect(freeBackwardReceipt.currentItemRef).toEqual(freePayload.session.currentItemRef);
  });

  it("enforces authored QTI minimum time after package publication and bootstrap", async () => {
    const zip = new JSZip();
    zip.file(
      "imsmanifest.xml",
      `<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="timed">
      <resources><resource identifier="test" type="imsqti_test_xmlv3p0" href="assessment.xml"><file href="assessment.xml"/></resource>
      <resource identifier="one" type="imsqti_item_xmlv3p0" href="items/item-1.xml"><file href="items/item-1.xml"/></resource>
      <resource identifier="two" type="imsqti_item_xmlv3p0" href="items/item-2.xml"><file href="items/item-2.xml"/></resource></resources></manifest>`,
    );
    zip.file(
      "assessment.xml",
      `<qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="timed" title="Read before answering">
      <qti-test-part identifier="part" navigation-mode="linear" submission-mode="simultaneous">
        <qti-assessment-section identifier="section" title="Questions" visible="true">
          <qti-assessment-item-ref identifier="one" href="items/item-1.xml"><qti-time-limits min-time="3600"/></qti-assessment-item-ref>
          <qti-assessment-item-ref identifier="two" href="items/item-2.xml"/>
        </qti-assessment-section>
      </qti-test-part></qti-assessment-test>`,
    );
    zip.file("items/item-1.xml", scoredItemXml);
    zip.file(
      "items/item-2.xml",
      scoredItemXml.replace('identifier="item-1"', 'identifier="item-2"'),
    );
    zip.file("assets/stimulus.svg", stimulusSvg);
    const published = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/publish?assessmentSlug=authored-time", {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-harbor-package-name": "timed.zip",
          "x-harbor-tenant-id": "authored_time",
        },
        body: await zip.generateAsync({ type: "arraybuffer" }),
      }),
    );
    expect(published.status, await published.clone().text()).toBe(201);
    const version = await published.json<{ assessmentVersionId: string }>();
    const launch = await postJson("/api/launch/preview", {
      mode: "preview",
      assessmentVersionId: version.assessmentVersionId,
      actor: { kind: "preview-operator", id: "reader", displayName: "Reader" },
    });
    expect(launch.status).toBe(201);
    const envelope = await launch.json<BootstrapEnvelope>();
    const boot = await exchangeBootstrap(envelope.bootstrapToken, "authored_time_client");
    expect(boot.status).toBe(200);
    const payload = await boot.json<BootstrapPayload>();
    const navigation = await commitAttemptEvent(payload.attemptId, {
      attemptId: payload.attemptId,
      eventId: "too-early",
      idempotencyKey: "too-early",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "authored_time_client",
      itemRef: payload.session.currentItemRef,
      type: "navigation.requested",
      payload: { targetItemRef: { itemId: "item-2", itemHref: "items/item-2.xml" } },
    });
    expect(navigation.status).toBe(409);
    expect(await navigation.json()).toMatchObject({
      timingBlock: { scopeType: "assessment-item-ref", minTimeSeconds: 3600 },
    });
    const resumed = await exchangeBootstrap(envelope.bootstrapToken, "authored_time_client");
    expect(await resumed.json()).toMatchObject({
      session: { currentItemRef: payload.session.currentItemRef },
    });
  });

  it("blocks linear forward navigation until an item minimum time elapses", async () => {
    const blockedStartedAt = createStartedAtOffset(-2_000);
    const blocked = await preparePreviewAttempt({
      tenantId: "tenant_attempt_timing_min_blocked",
      assessmentSlug: "basic-assessment",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
      includeReviewItem: true,
      qtiTiming: buildTwoItemQtiTiming({ itemMinTimeSeconds: 10 }),
    });
    const blockedAttemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(blockedAttemptId, blockedStartedAt);
    const blockedBootstrap = await exchangeBootstrap(
      blocked.envelope.bootstrapToken,
      "client_session_timing_min_01",
    );
    expect(blockedBootstrap.status).toBe(200);
    const blockedPayload = await blockedBootstrap.json<BootstrapPayload>();

    const blockedNavigation = await commitAttemptEvent(blockedAttemptId, {
      attemptId: blockedAttemptId,
      eventId: "evt_navigation_min_blocked",
      idempotencyKey: "idem_navigation_min_blocked",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_min_01",
      itemRef: blockedPayload.session.currentItemRef,
      type: "navigation.requested",
      payload: {
        targetItemRef: blocked.reviewItemRef!,
      },
    });

    expect(blockedNavigation.status).toBe(409);
    const blockedBody = await blockedNavigation.json<{
      timingBlock?: {
        scopeType: string;
        minTimeSeconds: number;
        elapsedTimeSeconds: number;
      };
    }>();
    expect(blockedBody.timingBlock).toMatchObject({
      scopeType: "assessment-item-ref",
      minTimeSeconds: 10,
    });
    expect(blockedBody.timingBlock?.elapsedTimeSeconds).toBeLessThan(10);

    const elapsed = await preparePreviewAttempt({
      tenantId: "tenant_attempt_timing_min_elapsed",
      assessmentSlug: "basic-assessment",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
      includeReviewItem: true,
      qtiTiming: buildTwoItemQtiTiming({ itemMinTimeSeconds: 10 }),
    });
    const elapsedAttemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(elapsedAttemptId, createStartedAtOffset(-12_000));
    const elapsedBootstrap = await exchangeBootstrap(
      elapsed.envelope.bootstrapToken,
      "client_session_timing_min_02",
    );
    expect(elapsedBootstrap.status).toBe(200);
    const elapsedPayload = await elapsedBootstrap.json<BootstrapPayload>();

    const elapsedNavigation = await commitAttemptEvent(elapsedAttemptId, {
      attemptId: elapsedAttemptId,
      eventId: "evt_navigation_min_elapsed",
      idempotencyKey: "idem_navigation_min_elapsed",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_min_02",
      itemRef: elapsedPayload.session.currentItemRef,
      type: "navigation.requested",
      payload: {
        targetItemRef: elapsed.reviewItemRef!,
      },
    });

    expect(elapsedNavigation.status).toBe(200);
  });

  it("excludes suspended time from item-session duration while container scopes keep accruing", async () => {
    const envelope = await preparePreviewAttempt({
      tenantId: "tenant_attempt_timing_suspension",
      assessmentSlug: "basic-assessment",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
      qtiTiming: buildTwoItemQtiTiming(),
    });
    const attemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(attemptId, createStartedAtOffset(-1_000));
    const bootstrap = await exchangeBootstrap(
      envelope.envelope.bootstrapToken,
      "client_session_timing_suspend",
    );
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();

    const suspended = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_item_suspended_duration",
      idempotencyKey: "idem_item_suspended_duration",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_suspend",
      itemRef: payload.session.currentItemRef,
      type: "item.suspended",
      payload: {
        reason: "navigation-preview",
      },
    });
    expect(suspended.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const resumed = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_item_resumed_duration",
      idempotencyKey: "idem_item_resumed_duration",
      sequenceNumber: 2,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_suspend",
      itemRef: payload.session.currentItemRef,
      type: "navigation.requested",
      payload: {
        targetItemRef: payload.session.currentItemRef,
      },
    });
    expect(resumed.status).toBe(200);

    const submitted = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_submit_suspended_duration",
      idempotencyKey: "idem_submit_suspended_duration",
      sequenceNumber: 3,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_suspend",
      itemRef: payload.session.currentItemRef,
      type: "submit.requested",
      payload: {
        requestedAt: new Date().toISOString(),
      },
    });
    expect(submitted.status).toBe(200);
    const receipt = await submitted.json<CommitAttemptEventReceipt>();
    const itemScope = receipt.timing.scopes?.find(
      (scope) => scope.scopeType === "item-session" && scope.itemId === "item-1",
    );
    const testPartScope = receipt.timing.scopes?.find((scope) => scope.scopeType === "test-part");

    expect(itemScope?.elapsedTimeSeconds).toBeGreaterThanOrEqual(0.8);
    expect(itemScope?.elapsedTimeSeconds).toBeLessThan(2.8);
    expect(testPartScope?.elapsedTimeSeconds).toBeGreaterThan(itemScope?.elapsedTimeSeconds ?? 0);
  });

  it("keeps session reads pure and accepts explicit auto-submit once a max-time deadline is exceeded", async () => {
    const envelope = await preparePreviewAttempt({
      tenantId: "tenant_attempt_timing_auto_submit",
      assessmentSlug: "basic-assessment",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
      qtiTiming: buildTwoItemQtiTiming({
        itemMaxTimeSeconds: 1,
        allowLateSubmission: false,
      }),
    });
    const attemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(attemptId, createStartedAtOffset(-2_000));

    const bootstrap = await exchangeBootstrap(
      envelope.envelope.bootstrapToken,
      "client_session_timing_auto_submit",
    );
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();

    expect(payload.session.attemptStatus).toBe("active");
    expect(payload.session.sequence?.lastAcceptedSequence).toBeNull();
    const expiredItemScope = payload.session.timing?.scopes?.find(
      (scope) => scope.scopeType === "item-session" && scope.itemId === "item-1",
    );
    expect(expiredItemScope?.status).toBe("interacting");

    const autoSubmit = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_auto_submit_deadline",
      idempotencyKey: "idem_auto_submit_deadline",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_auto_submit",
      itemRef: payload.session.currentItemRef,
      type: "timing.auto-submit.requested",
      payload: {
        requestedAt: new Date().toISOString(),
        reason: "max-time-reached",
        scopeKey: expiredItemScope?.key ?? null,
      },
    });

    expect(autoSubmit.status).toBe(200);
    const autoSubmitPayload = await autoSubmit.json<CommitAttemptEventReceipt>();
    expect(autoSubmitPayload.attemptStatus).toBe("submitted");
    expect(autoSubmitPayload.highestCommittedSequence).toBe(1);
    const itemScope = autoSubmitPayload.timing.scopes?.find(
      (scope) => scope.scopeType === "item-session" && scope.itemId === "item-1",
    );
    expect(itemScope?.status).toBe("closed");

    const lateWrite = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_auto_submit_late_write",
      idempotencyKey: "idem_auto_submit_late_write",
      sequenceNumber: 2,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_auto_submit",
      itemRef: payload.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_AFTER_AUTO_SUBMIT",
        responseState: {
          candidateResponse: "late",
        },
      },
    });

    expect(lateWrite.status).toBe(200);
    const lateWritePayload = await lateWrite.json<{
      outcome?: string;
      attemptStatus?: string;
      error?: string;
    }>();
    expect(lateWritePayload.outcome).toBe("late_preserved");
    expect(lateWritePayload.attemptStatus).toBe("submitted");
  });

  it("server auto-submits abandoned timed attempts and finalizes the last saved work", async () => {
    const envelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_abandoned",
      assessmentSlug: "basic-assessment",
    });
    const attemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(attemptId, createStartedAtOffset(-10_000));

    const bootstrap = await exchangeBootstrap(
      envelope.bootstrapToken,
      "client_session_timing_abandoned",
    );
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();

    const save = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_abandoned_save_01",
      idempotencyKey: "idem_abandoned_save_01",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_abandoned",
      itemRef: payload.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "item-1",
        responseState: {
          capturedAt: new Date().toISOString(),
          itemState: {
            responseVariables: [
              {
                identifier: "RESPONSE",
                value: "A",
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
    });
    expect(save.status).toBe(200);

    const sent: SubmitFinalizationEnvelope[] = [];
    const runtimeEnv = buildDeadlineWorkerEnv(sent);
    const stub = getTestEnv().ATTEMPT_COORDINATOR.get(
      getTestEnv().ATTEMPT_COORDINATOR.idFromName(attemptId),
    );
    await runOutboxAlarm(stub);
    await stub.fetch("https://harbor-attempt.local/__test/outbox/advance-alarm");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await stub.fetch("https://harbor-attempt.local/deliver-outbox", {
      method: "POST",
      headers: { "x-harbor-attempt-id": attemptId },
    });
    const summary = await runPendingSubmitFinalizationRequeues({ env: runtimeEnv });
    expect(summary.queuedCount).toBe(1);
    expect(sent).toHaveLength(1);

    await processSubmitFinalizationEnvelope(sent[0]!, runtimeEnv);
    const result = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT total_score, max_score, status FROM attempt_results WHERE attempt_id = ?",
      )
      .bind(attemptId)
      .first<{
        total_score: number | null;
        max_score: number | null;
        status: string;
      }>();

    expect(result).toEqual({
      total_score: 1,
      max_score: 1,
      status: "complete",
    });

    await runDurableObjectAlarm(
      getTestEnv().ATTEMPT_COORDINATOR.get(getTestEnv().ATTEMPT_COORDINATOR.idFromName(attemptId)),
    );
    await stub.fetch("https://harbor-attempt.local/deliver-outbox", {
      method: "POST",
      headers: { "x-harbor-attempt-id": attemptId },
    });
    const evidence = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT payload_json FROM attempt_evidence_events WHERE attempt_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(attemptId, "timing.auto-submit.accepted")
      .first<{ payload_json: string }>();

    expect(JSON.parse(evidence?.payload_json ?? "{}")).toMatchObject({
      source: "server",
    });
  });

  it("reconciles missing deadline jobs when stored attempt state is reused", async () => {
    const startedAt = createStartedAtOffset(-10_000);
    const envelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_reconcile_jobs",
      assessmentSlug: "basic-assessment",
    });
    const attemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(attemptId, startedAt);

    const bootstrap = await exchangeBootstrap(
      envelope.bootstrapToken,
      "client_session_timing_reconcile_jobs",
    );
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();

    await getTestEnv()
      .HARBOR_DB.prepare("DELETE FROM attempt_deadline_jobs WHERE attempt_id = ?")
      .bind(attemptId)
      .run();

    const heartbeat = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_reconcile_jobs_heartbeat_01",
      idempotencyKey: "idem_reconcile_jobs_heartbeat_01",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_reconcile_jobs",
      itemRef: payload.session.currentItemRef,
      type: "heartbeat",
      payload: {
        observedAt: new Date().toISOString(),
      },
    });
    expect(heartbeat.status).toBe(200);

    await runDurableObjectAlarm(
      getTestEnv().ATTEMPT_COORDINATOR.get(getTestEnv().ATTEMPT_COORDINATOR.idFromName(attemptId)),
    );
    const reconciliationStub = getTestEnv().ATTEMPT_COORDINATOR.get(
      getTestEnv().ATTEMPT_COORDINATOR.idFromName(attemptId),
    );
    await reconciliationStub.fetch("https://harbor-attempt.local/deliver-outbox", {
      method: "POST",
      headers: { "x-harbor-attempt-id": attemptId },
    });
    const reconciled = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT COUNT(*) AS count FROM attempt_deadline_jobs WHERE attempt_id = ? AND status = 'pending'",
      )
      .bind(attemptId)
      .first<{ count: number }>();
    expect(reconciled?.count).toBeGreaterThan(0);
  });

  it("fails fast when an attempt points at a missing delivery manifest", async () => {
    const envelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_missing_manifest",
      assessmentSlug: "basic-assessment",
    });
    const attemptId = await readLatestAttemptId();
    const attempt = await getTestEnv()
      .HARBOR_DB.prepare("SELECT manifest_object_key FROM attempt_entries WHERE id = ?")
      .bind(attemptId)
      .first<{ manifest_object_key: string }>();
    expect(attempt?.manifest_object_key).toBeTruthy();
    await getTestEnv().CONTENT_BUCKET.delete(attempt!.manifest_object_key);

    const bootstrap = await exchangeBootstrap(
      envelope.bootstrapToken,
      "client_session_timing_missing_manifest",
    );
    expect(bootstrap.status).toBe(500);
    await expect(bootstrap.json()).resolves.toMatchObject({
      error: "Attempt delivery manifest object is missing",
    });
  });

  it("wakes a due attempt independently of another attempt with a later deadline", async () => {
    const notDue = await preparePreviewAttempt({
      tenantId: "tenant_attempt_timing_not_due_job",
      assessmentSlug: "basic-assessment",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 3600,
        gracePeriodSeconds: 30,
      },
    });
    const notDueAttemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(notDueAttemptId, createStartedAtOffset(-120_000));
    const notDueBootstrap = await exchangeBootstrap(
      notDue.envelope.bootstrapToken,
      "client_session_timing_not_due_job",
    );
    expect(notDueBootstrap.status).toBe(200);

    const due = await preparePreviewAttempt({
      tenantId: "tenant_attempt_timing_due_job",
      assessmentSlug: "basic-assessment",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1,
        gracePeriodSeconds: 30,
      },
    });
    const dueAttemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(dueAttemptId, createStartedAtOffset(-2_000));
    const dueBootstrap = await exchangeBootstrap(
      due.envelope.bootstrapToken,
      "client_session_timing_due_job",
    );
    expect(dueBootstrap.status).toBe(200);

    const sent: SubmitFinalizationEnvelope[] = [];
    const dueStub = getTestEnv().ATTEMPT_COORDINATOR.get(
      getTestEnv().ATTEMPT_COORDINATOR.idFromName(dueAttemptId),
    );
    await dueStub.fetch("https://harbor-attempt.local/__test/outbox/advance-alarm");
    await runDurableObjectAlarm(dueStub);
    await dueStub.fetch("https://harbor-attempt.local/deliver-outbox", {
      method: "POST",
      headers: { "x-harbor-attempt-id": dueAttemptId },
    });
    const summary = await runPendingSubmitFinalizationRequeues({
      env: buildDeadlineWorkerEnv(sent),
    });
    expect(summary.queuedCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.attemptId).toBe(dueAttemptId);

    const notDueStatus = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT status FROM attempt_deadline_jobs WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(notDueAttemptId)
      .first<{ status: string }>();
    expect(notDueStatus?.status).toBe("pending");
  });

  it("turns submit into a durable state transition and preserves later mutable writes as late evidence", async () => {
    const startedAt = createStartedAtOffset(-10_000);
    const envelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_submit",
      assessmentSlug: "basic-assessment",
    });
    const attemptId = await readLatestAttemptId();
    await updateAttemptStartedAt(attemptId, startedAt);

    const bootstrap = await exchangeBootstrap(envelope.bootstrapToken);
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();

    const submit = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_submit_requested_01",
      idempotencyKey: "idem_submit_requested_01",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_01",
      itemRef: payload.session.currentItemRef,
      type: "submit.requested",
      payload: {
        requestedAt: new Date().toISOString(),
      },
    });

    expect(submit.status).toBe(200);
    const submitReceipt = await submit.json<CommitAttemptEventReceipt>();
    expect(submitReceipt.attemptStatus).toBe("submitted");
    expect(submitReceipt.highestCommittedSequence).toBe(1);

    const submittedBootstrap = await exchangeBootstrap(envelope.bootstrapToken);
    expect(submittedBootstrap.status).toBe(200);
    const submittedPayload = await submittedBootstrap.json<BootstrapPayload>();
    expect(submittedPayload.session.attemptStatus).toBe("submitted");

    const lateWrite = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_submit_late_write_01",
      idempotencyKey: "idem_submit_late_write_01",
      sequenceNumber: 2,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_01",
      itemRef: payload.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_AFTER_SUBMIT",
        responseState: {
          candidateResponse: "D",
        },
      },
    });

    expect(lateWrite.status).toBe(200);
    const lateWritePayload = await lateWrite.json<{
      outcome?: string;
      attemptStatus?: string;
    }>();
    expect(lateWritePayload.outcome).toBe("late_preserved");
    expect(lateWritePayload.attemptStatus).toBe("submitted");

    const secondLateWrite = await commitAttemptEvent(attemptId, {
      attemptId,
      eventId: "evt_submit_late_write_02",
      idempotencyKey: "idem_submit_late_write_02",
      sequenceNumber: 3,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_01",
      itemRef: payload.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_AFTER_SUBMIT_AGAIN",
        responseState: {
          candidateResponse: "E",
        },
      },
    });

    expect(secondLateWrite.status).toBe(200);
    const secondLateWritePayload = await secondLateWrite.json<{
      outcome?: string;
      attemptStatus?: string;
    }>();
    expect(secondLateWritePayload.outcome).toBe("late_preserved");
    expect(secondLateWritePayload.attemptStatus).toBe("submitted");

    const preserved = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT event_id, outcome FROM attempt_evidence_events WHERE attempt_id = ? AND outcome = 'late_preserved' ORDER BY sequence_number ASC",
      )
      .bind(attemptId)
      .all<{ event_id: string; outcome: string }>();

    expect(preserved.results).toEqual([
      {
        event_id: "evt_submit_late_write_01",
        outcome: "late_preserved",
      },
      {
        event_id: "evt_submit_late_write_02",
        outcome: "late_preserved",
      },
    ]);
  });

  it("flags grace-window work while keeping timing boundaries renderable on accepted receipts", async () => {
    const activeStartedAt = createStartedAtOffset(-10_000);
    const activeSoftCloseAt = addSeconds(activeStartedAt, 60);
    const activeAcceptUntil = addSeconds(activeStartedAt, 90);
    const activeEnvelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_receipts_active",
      assessmentSlug: "basic-assessment",
    });
    await updateAttemptStartedAt(await readLatestAttemptId(), activeStartedAt);
    const bootstrap = await exchangeBootstrap(activeEnvelope.bootstrapToken);
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();

    const onTime = await commitAttemptEvent(payload.attemptId, {
      attemptId: payload.attemptId,
      eventId: "evt_timing_ontime_01",
      idempotencyKey: "idem_timing_ontime_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T22:00:10.000Z",
      clientSessionId: "client_session_timing_01",
      itemRef: payload.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_TIMING_01",
        responseState: {
          candidateResponse: "A",
        },
      },
    });

    expect(onTime.status).toBe(200);
    const onTimeReceipt = await onTime.json<CommitAttemptEventReceipt>();
    expect(onTimeReceipt.attemptStatus).toBe("active");
    expect(onTimeReceipt.timing.softCloseAt).toBe(activeSoftCloseAt);
    expect(onTimeReceipt.timing.acceptUntil).toBe(activeAcceptUntil);

    const graceStartedAt = createStartedAtOffset(-75_000);
    const graceAcceptUntil = addSeconds(graceStartedAt, 90);
    const graceEnvelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_receipts_grace",
      assessmentSlug: "basic-assessment",
    });
    await updateAttemptStartedAt(await readLatestAttemptId(), graceStartedAt);
    const graceBootstrap = await exchangeBootstrap(graceEnvelope.bootstrapToken);
    expect(graceBootstrap.status).toBe(200);
    const gracePayload = await graceBootstrap.json<BootstrapPayload>();

    const grace = await commitAttemptEvent(gracePayload.attemptId, {
      attemptId: gracePayload.attemptId,
      eventId: "evt_timing_grace_01",
      idempotencyKey: "idem_timing_grace_01",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_01",
      itemRef: gracePayload.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_TIMING_02",
        responseState: {
          candidateResponse: "B",
        },
      },
    });

    expect(grace.status).toBe(200);
    const graceReceipt = await grace.json<CommitAttemptEventReceipt>();
    expect(graceReceipt.attemptStatus).toBe("accepting_late_within_grace");
    expect(graceReceipt.timing.remainingTimeSeconds).toBe(0);
    expect(graceReceipt.timing.acceptUntil).toBe(graceAcceptUntil);
  });

  it("shows recoverable expired state from bootstrap after the acceptance boundary ends", async () => {
    const startedAt = createStartedAtOffset(-91_000);
    const acceptUntil = addSeconds(startedAt, 90);
    const envelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_expired",
      assessmentSlug: "basic-assessment",
    });
    await updateAttemptStartedAt(await readLatestAttemptId(), startedAt);

    const bootstrap = await exchangeBootstrap(envelope.bootstrapToken);
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();

    expect(payload.session.attemptStatus).toBe("expired_pending_recovery");
    expect(payload.session.timing?.remainingTimeSeconds).toBe(0);
    expect(payload.session.timing?.acceptUntil).toBe(acceptUntil);
  });

  it("accepts deadline auto-submit even when network delivery lands after the acceptance boundary", async () => {
    const startedAt = createStartedAtOffset(-95_000);
    const envelope = await launchPreviewAttempt({
      tenantId: "tenant_attempt_timing_slow_auto_submit",
      assessmentSlug: "basic-assessment",
    });
    await updateAttemptStartedAt(await readLatestAttemptId(), startedAt);

    const bootstrap = await exchangeBootstrap(
      envelope.bootstrapToken,
      "client_session_timing_slow_auto_submit",
    );
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();
    expect(payload.session.attemptStatus).toBe("expired_pending_recovery");

    const autoSubmit = await commitAttemptEvent(payload.attemptId, {
      attemptId: payload.attemptId,
      eventId: "evt_slow_auto_submit_01",
      idempotencyKey: "idem_slow_auto_submit_01",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_timing_slow_auto_submit",
      itemRef: payload.session.currentItemRef,
      type: "timing.auto-submit.requested",
      payload: {
        requestedAt: payload.session.timing?.softCloseAt,
        reason: "assignment-deadline-reached",
        scopeKey:
          payload.session.timing?.scopes?.find((scope) => scope.scopeType === "assessment-test")
            ?.key ?? null,
      },
    });

    expect(autoSubmit.status).toBe(200);
    const result = await autoSubmit.json<
      CommitAttemptEventReceipt | { outcome: "duplicate"; storedReceipt: CommitAttemptEventReceipt }
    >();
    const receipt = result.outcome === "duplicate" ? result.storedReceipt : result;
    expect(receipt.attemptStatus).toBe("submitted");
    expect(receipt.timingDecision).toMatchObject({
      classification: "on-time",
      allowLateSubmission: true,
    });
  });
});
