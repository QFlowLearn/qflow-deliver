import { setOutboxWakeup } from "../src/attempts/attempt-alarm-schedule";
import { runOutboxAlarm } from "./outbox-alarm";
import JSZip from "jszip";
import {
  abortAllDurableObjects,
  runInDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
  applyD1Migrations,
} from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { DeliveryManifest } from "@harbor/content-model";
import {
  ATTEMPT_EVENT_TYPES,
  type AttemptEventEnvelope,
  type AttemptEventCommitResponse,
  type AttemptEvidenceResponse,
  type AttemptEventType,
  type AttemptReconciliationDuplicate,
  type AttemptReconciliationGap,
  type AttemptReconciliationStaleSequence,
  type AttemptTimingState,
  type AuthoritativeAttemptSessionState,
  type BootstrapEnvelope,
  type BootstrapPayload,
  type CommitAttemptEventReceipt,
} from "@harbor/attempt-protocol";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import {
  runPendingSubmitFinalizationRequeues,
  type SubmitFinalizationEnvelope,
} from "../src/queues/submit-finalization";
import { createQueueMock } from "./queue-mock";
import { commitAttemptEvent as commitThroughRoute } from "../src/routes/attempt-events";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const CURRENT_ITEM = {
  itemId: "item-1",
  itemHref: "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/items/item-1.xml",
} as const;

const TIMING_STATE: AttemptTimingState = {
  startedAt: "2026-03-26T22:00:00.000Z",
  expiresAt: "2026-03-26T22:30:00.000Z",
  remainingTimeSeconds: 1800,
};

function getTestEnv(): {
  SUBMIT_FINALIZATION_QUEUE: Queue<SubmitFinalizationEnvelope>;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    SUBMIT_FINALIZATION_QUEUE: Queue<SubmitFinalizationEnvelope>;
    ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
    ATTEMPT_COORDINATOR: DurableObjectNamespace;
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "attempt_evidence_events",
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
  zip.file("items/item-1.xml", itemXml);
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

async function getJson(path: string): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
    }),
  );
}

async function launchPreviewAttempt(seed: {
  tenantId: string;
  assessmentSlug: string;
  includeReviewItem?: boolean;
}): Promise<{
  attemptId: string;
  manifestObjectKey: string;
  currentItemRef: BootstrapPayload["session"]["currentItemRef"];
  reviewItemRef?: {
    itemId: string;
    itemHref: string;
  };
}> {
  const published = await publishFixture(seed);
  const reviewItemRef = seed.includeReviewItem
    ? await appendReviewItemToManifest(published.manifestObjectKey)
    : undefined;

  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: published.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: "preview_attempt_events",
      displayName: "Attempt Events Preview",
    },
  });

  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const bootstrap = await postJson("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
  });

  expect(bootstrap.status).toBe(200);
  const payload = await bootstrap.json<BootstrapPayload>();

  return {
    attemptId: payload.attemptId,
    manifestObjectKey: published.manifestObjectKey,
    currentItemRef: payload.session.currentItemRef,
    reviewItemRef,
  };
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

async function commitAttemptEvent(
  attemptId: string,
  event: AttemptEventEnvelope,
): Promise<Response> {
  return postJson(`/api/attempts/${attemptId}/events`, event);
}

async function readAttemptEntry(attemptId: string): Promise<{
  current_item_id: string;
  current_item_href: string;
}> {
  const { HARBOR_DB } = getTestEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT current_item_id, current_item_href FROM attempt_entries WHERE id = ?",
  )
    .bind(attemptId)
    .first<{
      current_item_id: string;
      current_item_href: string;
    }>();

  expect(attempt).toBeTruthy();
  return attempt!;
}

beforeEach(async () => {
  await resetBindings();
});

describe("attempt-event protocol contracts", () => {
  it("covers the hot-path event types while keeping bootstrap additive", () => {
    expect(ATTEMPT_EVENT_TYPES).toEqual([
      "item.presented",
      "accommodation.support",
      "response.changed",
      "item.submit-requested",
      "item.suspended",
      "item.completed",
      "navigation.requested",
      "keyword-translation.language.selected",
      "timing.deadline.warned",
      "timing.deadline.reached",
      "heartbeat",
      "submit.requested",
      "timing.auto-submit.requested",
    ]);

    expectTypeOf<AttemptEventType>().toEqualTypeOf<
      | "item.presented"
      | "accommodation.support"
      | "response.changed"
      | "item.submit-requested"
      | "item.suspended"
      | "item.completed"
      | "navigation.requested"
      | "keyword-translation.language.selected"
      | "timing.deadline.warned"
      | "timing.deadline.reached"
      | "heartbeat"
      | "submit.requested"
      | "timing.auto-submit.requested"
    >();

    const bootstrapPayload: BootstrapPayload = {
      attemptId: "attempt_01",
      assessmentVersionId: "vers_01",
      deliveryPolicy: {
        launchMode: "access-code",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
      },
      manifest: {
        manifestObjectKey:
          "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/manifests/delivery.json",
      },
      launch: {
        mode: "access-code",
        actor: {
          kind: "access-code-candidate",
          id: "candidate_01",
          displayName: "Student Candidate",
        },
      },
      session: {
        currentItemRef: CURRENT_ITEM,
        sequence: null,
        timing: null,
      },
    };

    const submitRequested: AttemptEventEnvelope<"submit.requested"> = {
      attemptId: "attempt_01",
      eventId: "evt_submit_01",
      idempotencyKey: "idem_submit_01",
      sequenceNumber: 6,
      clientTimestamp: "2026-03-26T22:29:55.000Z",
      clientSessionId: "client_session_01",
      itemRef: CURRENT_ITEM,
      type: "submit.requested",
      payload: {
        requestedAt: "2026-03-26T22:29:55.000Z",
      },
    };

    expect(bootstrapPayload.session.sequence).toBeNull();
    expect(bootstrapPayload.session.timing).toBeNull();
    expect(submitRequested.type).toBe("submit.requested");
    expect(submitRequested.sequenceNumber).toBe(6);
  });

  it("defines accepted receipts with the authoritative frontier and renderable timing state", () => {
    const receipt: CommitAttemptEventReceipt = {
      outcome: "accepted",
      receiptId: "rcpt_01",
      attemptId: "attempt_01",
      acceptedEventId: "evt_response_01",
      acceptedSequenceNumber: 4,
      highestCommittedSequence: 4,
      attemptStatus: "active",
      currentItemRef: CURRENT_ITEM,
      timing: TIMING_STATE,
      serverTimestamp: "2026-03-26T22:12:30.000Z",
    };

    const session: AuthoritativeAttemptSessionState = {
      currentItemRef: CURRENT_ITEM,
      sequence: {
        lastAcceptedSequence: receipt.acceptedSequenceNumber,
        nextSequence: receipt.highestCommittedSequence + 1,
      },
      timing: receipt.timing,
      attemptStatus: receipt.attemptStatus,
    };

    expect(receipt.attemptId).toBe("attempt_01");
    expect(receipt.acceptedEventId).toBe("evt_response_01");
    expect(receipt.acceptedSequenceNumber).toBe(4);
    expect(receipt.highestCommittedSequence).toBe(4);
    expect(receipt.attemptStatus).toBe("active");
    expect(receipt.timing.remainingTimeSeconds).toBe(1800);
    expect(session.sequence.nextSequence).toBe(5);
  });

  it("distinguishes duplicate, stale-sequence, and gap reconciliation outcomes for replay", () => {
    const duplicate: AttemptReconciliationDuplicate = {
      outcome: "duplicate",
      attemptId: "attempt_01",
      highestCommittedSequence: 4,
      expectedNextSequence: 5,
      attemptStatus: "active",
      currentItemRef: CURRENT_ITEM,
      timing: TIMING_STATE,
      requestedSequenceNumber: 4,
      storedReceipt: {
        outcome: "accepted",
        receiptId: "rcpt_01",
        attemptId: "attempt_01",
        acceptedEventId: "evt_response_01",
        acceptedSequenceNumber: 4,
        highestCommittedSequence: 4,
        attemptStatus: "active",
        currentItemRef: CURRENT_ITEM,
        timing: TIMING_STATE,
        serverTimestamp: "2026-03-26T22:12:30.000Z",
      },
    };

    const stale: AttemptReconciliationStaleSequence = {
      outcome: "stale_sequence",
      attemptId: "attempt_01",
      highestCommittedSequence: 4,
      expectedNextSequence: 5,
      attemptStatus: "active",
      currentItemRef: CURRENT_ITEM,
      timing: TIMING_STATE,
      requestedSequenceNumber: 2,
    };

    const gap: AttemptReconciliationGap = {
      outcome: "gap",
      attemptId: "attempt_01",
      highestCommittedSequence: 4,
      expectedNextSequence: 5,
      attemptStatus: "active",
      currentItemRef: CURRENT_ITEM,
      timing: TIMING_STATE,
      requestedSequenceNumber: 7,
      replayFromSequenceNumber: 5,
    };

    const outcomes: Array<AttemptEventCommitResponse["outcome"]> = [
      duplicate.outcome,
      stale.outcome,
      gap.outcome,
    ];

    expect(outcomes).toEqual(["duplicate", "stale_sequence", "gap"]);
    expect(duplicate.storedReceipt.acceptedSequenceNumber).toBe(4);
    expect(stale.expectedNextSequence).toBe(5);
    expect(gap.replayFromSequenceNumber).toBe(5);
  });
});

describe("attempt event route", () => {
  it("persists entitled keyword languages and rejects unauthorized selections", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_keyword_language",
      assessmentSlug: "keyword-language-selection",
    });
    const issuedAt = new Date().toISOString();
    const policy = await postJson(`/internal/attempts/${launched.attemptId}/policy`, {
      commandId: "cmd_keyword_language_policy",
      type: "set-accommodations",
      actor: {
        role: "operator",
        actorId: "operator_keyword_language",
        displayName: "Keyword Language Operator",
      },
      reason: "Entitle keyword translation languages",
      issuedAt,
      effectiveAt: issuedAt,
      accommodations: {
        rendererPnp: { keywordTranslationLanguage: "es-MX" },
        sessionControl: {},
        shellTools: {},
        pnpEntitlement: {
          activateAsOptionSet: ["keyword-translation"],
          languages: ["fr-CA", "de"],
        },
      },
    });
    expect(policy.status).toBe(200);

    const selected = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_keyword_language_selected",
      idempotencyKey: "idem_keyword_language_selected",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_keyword_language_a",
      itemRef: launched.currentItemRef,
      type: "keyword-translation.language.selected",
      payload: { requestedLanguage: "FR-ca" },
    });
    expect(selected.status).toBe(200);
    await expect(selected.json<CommitAttemptEventReceipt>()).resolves.toMatchObject({
      outcome: "accepted",
      deliveryPreferences: { keywordTranslationLanguage: "fr-CA" },
    });

    const duplicate = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_keyword_language_selected",
      idempotencyKey: "idem_keyword_language_selected",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_keyword_language_a",
      itemRef: launched.currentItemRef,
      type: "keyword-translation.language.selected",
      payload: { requestedLanguage: "FR-ca" },
    });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      outcome: "duplicate",
      deliveryPreferences: { keywordTranslationLanguage: "fr-CA" },
    });

    const unauthorized = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_keyword_language_unauthorized",
      idempotencyKey: "idem_keyword_language_unauthorized",
      sequenceNumber: 2,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_keyword_language_a",
      itemRef: launched.currentItemRef,
      type: "keyword-translation.language.selected",
      payload: { requestedLanguage: "ja" },
    });
    expect(unauthorized.status).toBe(409);
    await expect(unauthorized.json()).resolves.toMatchObject({
      deliveryPreferences: { keywordTranslationLanguage: "fr-CA" },
    });

    const evidence = await getJson(`/internal/attempts/${launched.attemptId}/evidence`);
    expect(evidence.status).toBe(200);
    await expect(evidence.json<AttemptEvidenceResponse>()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          eventType: "keyword-translation.language.selected",
          evidenceKind: "accommodation-support",
          payload: expect.objectContaining({
            support: "keyword-translation",
            state: "language-selected",
            requestedLanguage: "FR-ca",
            resolvedLanguage: "fr-CA",
          }),
        }),
      ]),
    });
  });

  it("records item presentation, response changes, and every submit attempt in the evidence ledger", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_local_demo",
      assessmentSlug: "basic-assessment",
    });

    const removedEvidenceSideChannel = await postJson(
      `/api/attempts/${launched.attemptId}/evidence`,
      {
        eventType: "item.presented",
        itemRef: launched.currentItemRef,
      },
    );
    expect(removedEvidenceSideChannel.status).toBe(404);

    const presented = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_presented_01",
      idempotencyKey: "idem_presented_01",
      sequenceNumber: 1,
      type: "item.presented",
      clientTimestamp: "2026-03-26T22:00:05.000Z",
      clientSessionId: "client_session_evidence",
      itemRef: launched.currentItemRef,
      payload: {
        presentedAt: "2026-03-26T22:00:05.000Z",
        presentationSource: "bootstrap",
      },
    });
    expect(presented.status).toBe(200);

    const supportEvidence = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_support_evidence_01",
      idempotencyKey: "support-availability:transcript-offered",
      sequenceNumber: 2,
      type: "accommodation.support",
      clientTimestamp: "2026-03-26T22:00:06.000Z",
      clientSessionId: "client_session_evidence",
      itemRef: launched.currentItemRef,
      payload: {
        support: "transcript",
        state: "offered",
        activation: "available",
        catalogAvailability: "available",
        entryCount: 1,
        catalogIds: ["audio-transcript"],
        referenceIds: ["transcript-reference"],
        requestedLanguage: null,
        resolvedLanguage: "en",
        selectionReason: "exact-language",
        assetReferences: ["items/transcripts/presentation-en.html"],
        mediaTypes: ["text/html"],
        inlineHtmlCount: 0,
        eventSource: "accommodation-support",
      },
    });
    expect(supportEvidence.status).toBe(200);
    const duplicateSupportEvidence = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_support_evidence_02",
      idempotencyKey: "support-availability:transcript-offered",
      sequenceNumber: 2,
      type: "accommodation.support",
      clientTimestamp: "2026-03-26T22:00:07.000Z",
      clientSessionId: "client_session_evidence",
      itemRef: launched.currentItemRef,
      payload: {
        support: "transcript",
        state: "offered",
        activation: "available",
        catalogAvailability: "available",
        entryCount: 1,
        catalogIds: ["audio-transcript"],
        referenceIds: ["transcript-reference"],
        requestedLanguage: null,
        resolvedLanguage: "en",
        selectionReason: "exact-language",
        assetReferences: ["items/transcripts/presentation-en.html"],
        mediaTypes: ["text/html"],
        inlineHtmlCount: 0,
        eventSource: "accommodation-support",
      },
    });
    expect(duplicateSupportEvidence.status).toBe(200);
    await expect(duplicateSupportEvidence.json()).resolves.toMatchObject({ outcome: "duplicate" });

    const responseChanged = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_response_evidence_01",
      idempotencyKey: "idem_response_evidence_01",
      sequenceNumber: 3,
      clientTimestamp: "2026-03-26T22:01:00.000Z",
      clientSessionId: "client_session_evidence",
      itemRef: launched.currentItemRef,
      type: "response.changed",
      syncTrace: {
        queuedAt: "2026-03-26T22:00:59.500Z",
        sentAt: "2026-03-26T22:01:00.000Z",
        sendReason: "initial",
        queueDepthAtSend: 1,
        replayAttempt: 0,
      },
      payload: {
        responseKey: "RESPONSE",
        responseState: {
          capturedAt: "2026-03-26T22:01:00.000Z",
          itemState: {
            responseVariables: [
              {
                identifier: "RESPONSE",
                value: "ChoiceC",
              },
            ],
          },
        },
      },
    });
    expect(responseChanged.status).toBe(200);

    const submit = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_submit_evidence_01",
      idempotencyKey: "idem_submit_evidence_01",
      sequenceNumber: 4,
      clientTimestamp: "2026-03-26T22:29:59.000Z",
      clientSessionId: "client_session_evidence",
      itemRef: launched.currentItemRef,
      type: "submit.requested",
      syncTrace: {
        queuedAt: "2026-03-26T22:20:00.000Z",
        sentAt: "2026-03-26T22:29:59.000Z",
        sendReason: "replay",
        queueDepthAtSend: 2,
        replayAttempt: 2,
      },
      payload: {
        requestedAt: "2026-03-26T22:29:59.000Z",
        submissionSummary: {
          itemCount: 1,
          answeredItemCount: 1,
          scoredItemCount: 0,
          totalScore: null,
          maxScore: null,
          items: [],
        },
      },
    });
    expect(submit.status).toBe(200);

    const lateSubmit = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_submit_evidence_02",
      idempotencyKey: "idem_submit_evidence_02",
      sequenceNumber: 5,
      clientTimestamp: "2026-03-26T22:30:01.000Z",
      clientSessionId: "client_session_evidence",
      itemRef: launched.currentItemRef,
      type: "submit.requested",
      payload: {
        requestedAt: "2026-03-26T22:30:01.000Z",
      },
    });
    expect(lateSubmit.status).toBe(200);
    await expect(lateSubmit.json()).resolves.toMatchObject({
      outcome: "late_preserved",
      attemptStatus: "submitted",
    });

    const evidenceResponse = await getJson(`/internal/attempts/${launched.attemptId}/evidence`);
    expect(evidenceResponse.status).toBe(200);
    const evidence = await evidenceResponse.json<AttemptEvidenceResponse>();
    const instructorEvidenceResponse = await getJson(
      `/api/instructor/attempts/${launched.attemptId}/evidence`,
    );
    expect(instructorEvidenceResponse.status).toBe(200);
    const instructorEvidence = await instructorEvidenceResponse.json<AttemptEvidenceResponse>();

    expect(evidence.events.map((event) => event.eventType)).toEqual([
      "timing.policy.created",
      "item.presented",
      "accommodation.support",
      "response.changed",
      "submit.requested",
      "submit.requested",
    ]);
    expect(evidence.events.map((event) => event.evidenceKind)).toEqual([
      "timing",
      "item-presentation",
      "accommodation-support",
      "response",
      "submit",
      "submit",
    ]);
    expect(evidence.events.map((event) => event.outcome)).toEqual([
      "observed",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "late_preserved",
    ]);
    expect(evidence.events[0]).toMatchObject({
      eventType: "timing.policy.created",
      eventSource: "server",
    });
    expect(evidence.events[1]).toMatchObject({
      itemRef: launched.currentItemRef,
      sequenceNumber: 1,
      receiptId: expect.stringMatching(/^rcpt_/),
      clientTimestamp: "2026-03-26T22:00:05.000Z",
      eventSource: "bootstrap",
    });
    expect(evidence.events[2]).toMatchObject({
      itemRef: launched.currentItemRef,
      sequenceNumber: 2,
      receiptId: expect.stringMatching(/^rcpt_/),
      clientTimestamp: "2026-03-26T22:00:06.000Z",
      eventSource: "accommodation-support",
      payload: {
        support: "transcript",
        state: "offered",
        activation: "available",
        catalogAvailability: "available",
        catalogIds: ["audio-transcript"],
      },
    });
    expect(evidence.events[3]).toMatchObject({
      responseKey: "RESPONSE",
      clientTimestamp: "2026-03-26T22:01:00.000Z",
      itemRef: launched.currentItemRef,
      syncSignals: ["queued_locally", "receipt_confirmed"],
    });
    expect(evidence.events[3]?.flags.clientSyncTrace).toMatchObject({
      sendReason: "initial",
      queueDepthAtSend: 1,
    });
    expect(evidence.events[3]?.payload.responseState).toMatchObject({
      itemState: {
        responseVariables: [
          {
            identifier: "RESPONSE",
            value: "ChoiceC",
          },
        ],
      },
    });
    expect(evidence.events[4]).toMatchObject({
      eventId: "evt_submit_evidence_01",
      sequenceNumber: 4,
      receiptId: expect.stringMatching(/^rcpt_/),
      syncSignals: ["queued_locally", "replayed", "receipt_confirmed"],
    });
    expect(evidence.events[4]?.flags.clientSyncTrace).toMatchObject({
      sendReason: "replay",
      replayAttempt: 2,
    });
    expect(evidence.events[5]).toMatchObject({
      eventId: "evt_submit_evidence_02",
      sequenceNumber: 5,
      outcome: "late_preserved",
      receiptId: null,
    });
    expect(evidence.events.every((event) => typeof event.serverTimestamp === "string")).toBe(true);
    expect(instructorEvidence.events).toHaveLength(evidence.events.length);
    expect(instructorEvidence.events.map((event) => event.eventType)).toEqual(
      evidence.events.map((event) => event.eventType),
    );
  });

  it("accepts in-order response, lifecycle, heartbeat, and navigation events and returns durable receipts", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_attempt_events_accept",
      assessmentSlug: "basic-assessment",
      includeReviewItem: true,
    });
    const targetItemRef = launched.reviewItemRef!;

    const acceptedResponses = [
      await commitAttemptEvent(launched.attemptId, {
        attemptId: launched.attemptId,
        eventId: "evt_response_01",
        idempotencyKey: "idem_response_01",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-26T22:01:00.000Z",
        clientSessionId: "client_session_01",
        itemRef: launched.currentItemRef,
        type: "response.changed",
        payload: {
          responseKey: "RESPONSE_1",
          responseState: {
            candidateResponse: "A",
          },
        },
      }),
      await commitAttemptEvent(launched.attemptId, {
        attemptId: launched.attemptId,
        eventId: "evt_suspended_01",
        idempotencyKey: "idem_suspended_01",
        sequenceNumber: 2,
        clientTimestamp: "2026-03-26T22:01:05.000Z",
        clientSessionId: "client_session_01",
        itemRef: launched.currentItemRef,
        type: "item.suspended",
        payload: {
          reason: "navigate",
        },
      }),
      await commitAttemptEvent(launched.attemptId, {
        attemptId: launched.attemptId,
        eventId: "evt_heartbeat_01",
        idempotencyKey: "idem_heartbeat_01",
        sequenceNumber: 3,
        clientTimestamp: "2026-03-26T22:01:10.000Z",
        clientSessionId: "client_session_01",
        itemRef: launched.currentItemRef,
        type: "heartbeat",
        payload: {
          observedAt: "2026-03-26T22:01:10.000Z",
        },
      }),
      await commitAttemptEvent(launched.attemptId, {
        attemptId: launched.attemptId,
        eventId: "evt_navigation_01",
        idempotencyKey: "idem_navigation_01",
        sequenceNumber: 4,
        clientTimestamp: "2026-03-26T22:01:15.000Z",
        clientSessionId: "client_session_01",
        itemRef: launched.currentItemRef,
        type: "navigation.requested",
        payload: {
          targetItemRef,
        },
      }),
    ];

    expect(acceptedResponses.map((response) => response.status)).toEqual([200, 200, 200, 200]);

    const receipts = await Promise.all(
      acceptedResponses.map((response) => response.json<CommitAttemptEventReceipt>()),
    );

    expect(receipts.map((receipt) => receipt.outcome)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(receipts.map((receipt) => receipt.highestCommittedSequence)).toEqual([1, 2, 3, 4]);
    expect(receipts[3]?.currentItemRef).toEqual(targetItemRef);
    expect(receipts[3]?.attemptStatus).toBe("active");
  });

  it("returns the stored receipt when the same idempotency key is replayed", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_attempt_events_duplicate",
      assessmentSlug: "basic-assessment",
    });

    const accepted = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_response_duplicate",
      idempotencyKey: "idem_duplicate",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T22:05:00.000Z",
      clientSessionId: "client_session_duplicate",
      itemRef: launched.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_DUPLICATE",
        responseState: {
          candidateResponse: "B",
        },
      },
    });

    expect(accepted.status).toBe(200);
    const receipt = await accepted.json<CommitAttemptEventReceipt>();

    const duplicate = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_response_duplicate_replayed",
      idempotencyKey: "idem_duplicate",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T22:05:01.000Z",
      clientSessionId: "client_session_duplicate",
      itemRef: launched.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_DUPLICATE",
        responseState: {
          candidateResponse: "B",
        },
      },
    });

    expect(duplicate.status).toBe(200);
    const duplicatePayload = await duplicate.json<AttemptReconciliationDuplicate>();

    expect(duplicatePayload.outcome).toBe("duplicate");
    expect(duplicatePayload.storedReceipt.receiptId).toBe(receipt.receiptId);
    expect(duplicatePayload.highestCommittedSequence).toBe(1);

    const next = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_response_next",
      idempotencyKey: "idem_next",
      sequenceNumber: 2,
      clientTimestamp: "2026-03-26T22:05:02.000Z",
      clientSessionId: "client_session_duplicate",
      itemRef: launched.currentItemRef,
      type: "heartbeat",
      payload: {
        observedAt: "2026-03-26T22:05:02.000Z",
      },
    });

    expect(next.status).toBe(200);
    const nextPayload = await next.json<CommitAttemptEventReceipt>();
    expect(nextPayload.highestCommittedSequence).toBe(2);
  });

  it("returns stale and gap reconciliation without moving authoritative sequencing out of the Durable Object", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_attempt_events_reconcile",
      assessmentSlug: "basic-assessment",
      includeReviewItem: true,
    });
    const targetItemRef = launched.reviewItemRef!;

    const first = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_navigation_frontier",
      idempotencyKey: "idem_navigation_frontier",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T22:09:00.000Z",
      clientSessionId: "client_session_reconcile",
      itemRef: launched.currentItemRef,
      type: "navigation.requested",
      payload: {
        targetItemRef,
      },
    });

    expect(first.status).toBe(200);

    const stale = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_stale",
      idempotencyKey: "idem_stale",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T22:09:01.000Z",
      clientSessionId: "client_session_reconcile",
      itemRef: CURRENT_ITEM,
      type: "heartbeat",
      payload: {
        observedAt: "2026-03-26T22:09:01.000Z",
      },
    });

    const gap = await commitAttemptEvent(launched.attemptId, {
      attemptId: launched.attemptId,
      eventId: "evt_gap",
      idempotencyKey: "idem_gap",
      sequenceNumber: 3,
      clientTimestamp: "2026-03-26T22:09:02.000Z",
      clientSessionId: "client_session_reconcile",
      itemRef: targetItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_GAP",
        responseState: {
          candidateResponse: "C",
        },
      },
    });

    expect(stale.status).toBe(200);
    expect(gap.status).toBe(200);

    const stalePayload = await stale.json<AttemptReconciliationStaleSequence>();
    const gapPayload = await gap.json<AttemptReconciliationGap>();
    const attemptEntry = await readAttemptEntry(launched.attemptId);

    expect(stalePayload.outcome).toBe("stale_sequence");
    expect(stalePayload.expectedNextSequence).toBe(2);
    expect(stalePayload.currentItemRef).toEqual(targetItemRef);
    expect(gapPayload.outcome).toBe("gap");
    expect(gapPayload.replayFromSequenceNumber).toBe(2);
    expect(gapPayload.currentItemRef).toEqual(targetItemRef);
    expect(attemptEntry.current_item_id).toBe("item-1");
    expect(attemptEntry.current_item_href).toBe("items/item-1.xml");
  });
});

// These tests use real workerd storage and D1 failures, without replacing application methods.
function coordinator(attemptId: string): DurableObjectStub {
  const namespace = getTestEnv().ATTEMPT_COORDINATOR;
  return namespace.get(namespace.idFromName(attemptId));
}

async function outboxStatus(stub: DurableObjectStub) {
  return runInDurableObject(stub, async (_instance, state) => ({
    pending: (await state.storage.list({ prefix: "commit-outbox:" })).size,
    alarm: (await state.storage.get<number>("attempt-alarm-outbox-at")) ?? null,
  }));
}

function sendToCoordinator(stub: DurableObjectStub, event: AttemptEventEnvelope) {
  return stub.fetch("https://harbor-attempt.local/commit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harbor-attempt-id": event.attemptId,
      "x-harbor-delivery-context-url": "https://harbor.local/api/attempts/events",
    },
    body: JSON.stringify(event),
  });
}

async function commitWithBackground(event: AttemptEventEnvelope): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await commitThroughRoute({
    request: new Request(`https://harbor.local/api/attempts/${event.attemptId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
    env: getTestEnv(),
    attemptId: event.attemptId,
    ctx,
  });
  await waitOnExecutionContext(ctx);
  return response;
}

describe("durable save confirmation outbox", () => {
  it("confirms answers during D1 read failures and recovers after object eviction without another client write", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_outbox_read_failure",
      assessmentSlug: "outbox",
    });
    let stub = coordinator(launched.attemptId);
    const event: AttemptEventEnvelope<"response.changed"> = {
      attemptId: launched.attemptId,
      eventId: "evt_outbox_answer",
      idempotencyKey: "idem_outbox_answer",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "outbox_session",
      itemRef: launched.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE",
        intent: "checkpoint",
        responseState: {
          itemState: {
            schema: "qti3.attempt-state.v1",
            itemIdentifier: "item-1",
            status: "suspended",
            responses: { RESPONSE: "ChoiceC" },
            outcomes: {},
            validationMessages: [],
          },
        },
      },
    };
    const db = getTestEnv().HARBOR_DB;
    await db.exec("ALTER TABLE attempt_deadline_jobs RENAME TO unavailable_deadline_jobs");
    try {
      // Exercise the actual save handler while the deadline SELECT cannot succeed.
      const response = await commitWithBackground(event);
      expect(response.status, await response.clone().text()).toBe(200);
      const receipt = await response.json<CommitAttemptEventReceipt>();
      expect(receipt.outcome).toBe("accepted");
      await expect
        .poll(() => outboxStatus(stub))
        .toEqual({ pending: 1, alarm: expect.any(Number) });
      expect(await runOutboxAlarm(stub)).toBe(true);
      await expect
        .poll(() => outboxStatus(stub))
        .toEqual({ pending: 1, alarm: expect.any(Number) });

      await abortAllDurableObjects();
      stub = coordinator(launched.attemptId);
      const duplicate = await sendToCoordinator(stub, event);
      expect(duplicate.status).toBe(200);
      await expect(duplicate.json()).resolves.toMatchObject({
        outcome: "duplicate",
        highestCommittedSequence: 1,
        storedReceipt: { receiptId: receipt.receiptId },
      });
      const session = await stub.fetch("https://harbor-attempt.local/session", {
        headers: { "x-harbor-attempt-id": launched.attemptId },
      });
      expect(session.status).toBe(200);
      await expect(session.json()).resolves.toMatchObject({
        responseCheckpoint: { items: { "item-1": { responses: { RESPONSE: "ChoiceC" } } } },
        sequence: { lastAcceptedSequence: 1, nextSequence: 2 },
      });
    } finally {
      await db.exec("ALTER TABLE unavailable_deadline_jobs RENAME TO attempt_deadline_jobs");
    }
    await abortAllDurableObjects();
    stub = coordinator(launched.attemptId);
    expect(await runOutboxAlarm(stub)).toBe(true);
    await expect.poll(() => outboxStatus(stub)).toEqual({ pending: 0, alarm: null });
    const evidence = await db
      .prepare("SELECT outcome FROM attempt_evidence_events WHERE attempt_id = ? AND event_id = ?")
      .bind(event.attemptId, event.eventId)
      .all<{ outcome: string }>();
    expect(evidence.results).toEqual([{ outcome: "accepted" }]);
    expect(await runOutboxAlarm(stub)).toBe(false);
  });

  it("retries a partial D1 projection without duplicating timeline or timing evidence", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_outbox_partial",
      assessmentSlug: "outbox",
    });
    let stub = coordinator(launched.attemptId);
    const db = getTestEnv().HARBOR_DB;
    await db.exec(
      "CREATE TRIGGER fail_outbox_timing BEFORE INSERT ON attempt_evidence_events WHEN NEW.event_type = 'item.completed' BEGIN SELECT RAISE(ABORT, 'D1 unavailable'); END",
    );
    try {
      const response = await sendToCoordinator(stub, {
        attemptId: launched.attemptId,
        eventId: "evt_outbox_completed",
        idempotencyKey: "idem_outbox_completed",
        sequenceNumber: 1,
        clientTimestamp: new Date().toISOString(),
        clientSessionId: "outbox_session",
        itemRef: launched.currentItemRef,
        type: "item.completed",
        payload: {},
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await expect
        .poll(() => outboxStatus(stub))
        .toEqual({ pending: 1, alarm: expect.any(Number) });
      for (let retry = 0; retry < 2; retry++) {
        expect(await runOutboxAlarm(stub)).toBe(true);
        await expect
          .poll(() =>
            runInDurableObject(
              stub,
              async (_instance, state) =>
                (await state.storage.get<{ failures: number }>("commit-outbox-retry"))?.failures,
            ),
          )
          .toBe(retry + 1);
        await expect
          .poll(() => outboxStatus(stub))
          .toEqual({ pending: 1, alarm: expect.any(Number) });
      }
      const timeline = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM attempt_timeline_events WHERE attempt_id = ? AND event_type = 'accepted-checkpoint'",
        )
        .bind(launched.attemptId)
        .first<{ count: number }>();
      expect(timeline?.count).toBe(1);
    } finally {
      await db.exec("DROP TRIGGER fail_outbox_timing");
    }
    await abortAllDurableObjects();
    stub = coordinator(launched.attemptId);
    expect(await runOutboxAlarm(stub)).toBe(true);
    await expect.poll(() => outboxStatus(stub)).toEqual({ pending: 0, alarm: null });
    const timeline = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM attempt_timeline_events WHERE attempt_id = ? AND event_type = 'accepted-checkpoint'",
      )
      .bind(launched.attemptId)
      .first<{ count: number }>();
    expect(timeline?.count).toBe(1);
    const timing = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM attempt_evidence_events WHERE attempt_id = ? AND event_type = 'timing.scope.exited'",
      )
      .bind(launched.attemptId)
      .first<{ count: number }>();
    expect(timing?.count).toBe(1);
  });

  it("confirms submission when D1 finalization fails and later creates the durable queue handoff", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_outbox_submit",
      assessmentSlug: "outbox",
    });
    let stub = coordinator(launched.attemptId);
    const db = getTestEnv().HARBOR_DB;
    await db.exec(
      "CREATE TRIGGER fail_outbox_finalization BEFORE INSERT ON result_finalizations BEGIN SELECT RAISE(ABORT, 'D1 unavailable'); END",
    );
    const event: AttemptEventEnvelope<"submit.requested"> = {
      attemptId: launched.attemptId,
      eventId: "evt_outbox_submit",
      idempotencyKey: "idem_outbox_submit",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "outbox_session",
      itemRef: launched.currentItemRef,
      type: "submit.requested",
      payload: { requestedAt: new Date().toISOString() },
    };
    let receipt: CommitAttemptEventReceipt;
    try {
      const response = await commitWithBackground(event);
      expect(response.status, await response.clone().text()).toBe(200);
      receipt = await response.json<CommitAttemptEventReceipt>();
      expect(receipt).toMatchObject({ outcome: "accepted", attemptStatus: "submitted" });
      expect(await runOutboxAlarm(stub)).toBe(true);
      await expect
        .poll(() => outboxStatus(stub))
        .toEqual({ pending: 1, alarm: expect.any(Number) });
      const duplicate = await sendToCoordinator(stub, event);
      await expect(duplicate.json()).resolves.toMatchObject({
        outcome: "duplicate",
        storedReceipt: { receiptId: receipt.receiptId },
      });
    } finally {
      await db.exec("DROP TRIGGER fail_outbox_finalization");
    }
    await abortAllDurableObjects();
    stub = coordinator(launched.attemptId);
    expect(await runOutboxAlarm(stub)).toBe(true);
    await expect.poll(() => outboxStatus(stub)).toEqual({ pending: 0, alarm: null });
    const finalizations = await db
      .prepare("SELECT source_receipt_id, status FROM result_finalizations WHERE attempt_id = ?")
      .bind(launched.attemptId)
      .all<{ source_receipt_id: string; status: string }>();
    expect(finalizations.results).toEqual([
      { source_receipt_id: receipt.receiptId, status: "pending" },
    ]);
    const evidence = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM attempt_evidence_events WHERE attempt_id = ? AND event_type = 'submit.requested'",
      )
      .bind(launched.attemptId)
      .first<{ count: number }>();
    expect(evidence?.count).toBe(1);
    const queued: SubmitFinalizationEnvelope[] = [];
    const requeued = await runPendingSubmitFinalizationRequeues({
      env: {
        HARBOR_DB: db,
        ATTEMPT_RUNTIME_METRICS: getTestEnv().ATTEMPT_RUNTIME_METRICS,
        SUBMIT_FINALIZATION_QUEUE: createQueueMock<SubmitFinalizationEnvelope>({
          async send(message) {
            queued.push(message);
          },
          sendBatchError: "Outbox requeue uses individual messages",
        }),
      },
    });
    expect(requeued).toMatchObject({ queuedCount: 1, failedCount: 0 });
    expect(queued).toEqual([
      {
        attemptId: launched.attemptId,
        eventType: "submit.requested",
        receiptId: receipt.receiptId,
        acceptedSequenceNumber: 1,
        submittedAt: receipt.serverTimestamp,
      },
    ]);
  });
  it("drains a backlog over bounded alarm invocations without postponing the existing wake-up", async () => {
    const launched = await launchPreviewAttempt({
      tenantId: "tenant_outbox_backlog",
      assessmentSlug: "outbox",
    });
    const stub = coordinator(launched.attemptId);
    const existingWakeup = Date.now() + 5_000;
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.transaction((txn) => setOutboxWakeup(txn, existingWakeup)),
    );
    for (let sequence = 1; sequence <= 26; sequence++) {
      const response = await sendToCoordinator(stub, {
        attemptId: launched.attemptId,
        eventId: `evt_backlog_${sequence}`,
        idempotencyKey: `idem_backlog_${sequence}`,
        sequenceNumber: sequence,
        clientTimestamp: new Date().toISOString(),
        clientSessionId: "backlog_session",
        itemRef: launched.currentItemRef,
        type: "heartbeat",
        payload: { observedAt: new Date().toISOString() },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    await expect.poll(() => outboxStatus(stub)).toEqual({ pending: 26, alarm: existingWakeup });
    expect(await runOutboxAlarm(stub)).toBe(true);
    await expect
      .poll(() => outboxStatus(stub))
      .toEqual({ pending: 1, alarm: existingWakeup + 1_000 });
    const projected = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT sequence_number FROM attempt_evidence_events WHERE attempt_id = ? AND event_type = 'heartbeat' ORDER BY sequence_number",
      )
      .bind(launched.attemptId)
      .all<{ sequence_number: number }>();
    expect(projected.results.map((row) => row.sequence_number)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(await runOutboxAlarm(stub)).toBe(true);
    await expect.poll(() => outboxStatus(stub)).toEqual({ pending: 0, alarm: null });
    const total = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT COUNT(*) AS count FROM attempt_evidence_events WHERE attempt_id = ? AND event_type = 'heartbeat'",
      )
      .bind(launched.attemptId)
      .first<{ count: number }>();
    expect(total?.count).toBe(26);
  });
});
