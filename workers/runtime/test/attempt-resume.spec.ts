import { http } from "msw/http";
import { network, fetchFromTestOrigin } from "./network";
import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { DeliveryManifest } from "@harbor/content-model";

import type {
  AttemptEventCommitResponse,
  AttemptEventEnvelope,
  AuthoritativeAttemptSessionState,
  BootstrapEnvelope,
  BootstrapPayload,
  CurrentItemRef,
} from "@harbor/attempt-protocol";

import {
  createAttemptClient,
  createFetchAttemptTransport,
  type AttemptClientTransport,
} from "../../../apps/harbor-web/src/lib/attempt-client";
import {
  createAttemptJournal,
  createMemoryAttemptJournalStore,
  createMemoryAttemptReplayReceiptStore,
  type AttemptJournalStore,
} from "../../../apps/harbor-web/src/lib/attempt-journal";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const CURRENT_ITEM: CurrentItemRef = {
  itemId: "item-1",
  itemHref: "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/items/item-1.xml",
};

function createAcceptedResponse(event: AttemptEventEnvelope): AttemptEventCommitResponse {
  return {
    outcome: "accepted",
    receiptId: `rcpt_${event.sequenceNumber}`,
    attemptId: event.attemptId,
    acceptedEventId: event.eventId,
    acceptedSequenceNumber: event.sequenceNumber,
    highestCommittedSequence: event.sequenceNumber,
    attemptStatus: "active",
    currentItemRef: event.itemRef,
    timing: {
      startedAt: "2026-03-26T23:00:00.000Z",
      expiresAt: null,
      remainingTimeSeconds: null,
    },
    serverTimestamp: "2026-03-26T23:00:00.000Z",
  };
}

function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
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

async function authorizeWorkstationTransfer(attemptId: string, clientSessionId: string) {
  const response = await postJson(`/internal/attempts/${attemptId}/actions`, {
    actionId: `transfer-${attemptId}-${clientSessionId}`,
    type: "transfer-workstation",
    clientSessionId,
    actor: { role: "operator", actorId: "lab-support" },
    reason: "Replace failed workstation",
    effectiveAt: new Date().toISOString(),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function exchangeBootstrap(
  bootstrapToken: string,
  clientSessionId?: string,
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

async function issueAccessCode(assessmentVersionId: string): Promise<{
  accessCodeId: string;
  accessCode: string;
}> {
  const response = await postJson("/internal/access-codes", {
    assessmentVersionId,
    code: "RESUME-2026",
  });

  expect(response.status).toBe(201);
  return response.json();
}

async function launchAccessCodeAttempt(input: {
  accessCode: string;
  actorId: string;
  clientSessionId: string;
}): Promise<BootstrapPayload> {
  const launch = await postJson("/api/launch/access-code", {
    accessCode: input.accessCode,
    actor: {
      kind: "access-code-candidate",
      id: input.actorId,
      displayName: "Resume Candidate",
    },
  });

  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const bootstrap = await exchangeBootstrap(envelope.bootstrapToken, input.clientSessionId);
  expect(bootstrap.status).toBe(200);
  return bootstrap.json<BootstrapPayload>();
}

async function countAttemptsForAccessCode(accessCodeId: string): Promise<number> {
  const { HARBOR_DB } = getTestEnv();
  const result = await HARBOR_DB.prepare(
    "SELECT COUNT(*) AS count FROM attempt_entries WHERE access_code_id = ?",
  )
    .bind(accessCodeId)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

beforeEach(async () => {
  await resetBindings();
});

describe("attempt recovery seams", () => {
  it("writes before send and reserves past durable pending work even when sending fails", async () => {
    const attemptId = "attempt_resume_01";
    const journal = createAttemptJournal({
      store: createMemoryAttemptJournalStore(),
      now: () => "2026-03-26T23:00:00.000Z",
    });

    await journal.append({
      attemptId,
      eventId: "evt_02",
      idempotencyKey: "idem_02",
      sequenceNumber: 2,
      clientTimestamp: "2026-03-26T23:00:02.000Z",
      clientSessionId: "client_session_resume_01",
      itemRef: CURRENT_ITEM,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_02",
        responseState: {
          candidateResponse: "B",
        },
      },
    });

    await journal.append({
      attemptId,
      eventId: "evt_01",
      idempotencyKey: "idem_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T23:00:01.000Z",
      clientSessionId: "client_session_resume_01",
      itemRef: CURRENT_ITEM,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_01",
        responseState: {
          candidateResponse: "A",
        },
      },
    });

    expect((await journal.list(attemptId)).map((entry) => entry.event.sequenceNumber)).toEqual([
      1, 2,
    ]);

    await journal.pruneCovered({
      attemptId,
      highestCommittedSequence: 1,
    });

    expect((await journal.list(attemptId)).map((entry) => entry.event.sequenceNumber)).toEqual([2]);

    const session: AuthoritativeAttemptSessionState = {
      currentItemRef: CURRENT_ITEM,
      sequence: {
        lastAcceptedSequence: 1,
        nextSequence: 2,
      },
      timing: {
        startedAt: "2026-03-26T23:00:00.000Z",
        expiresAt: null,
        remainingTimeSeconds: null,
      },
      attemptStatus: "active",
    };

    let wasWrittenBeforeSend = false;
    const committedSequences: number[] = [];
    const transport: AttemptClientTransport = {
      commit: async (event) => {
        committedSequences.push(event.sequenceNumber);
        wasWrittenBeforeSend = (await journal.list(attemptId)).some(
          (entry) => entry.event.idempotencyKey === event.idempotencyKey,
        );

        throw new Error("network unavailable");
      },
    };

    const client = createAttemptClient({
      attemptId,
      clientSessionId: "client_session_resume_01",
      initialSession: session,
      journal,
      transport,
      createId: (() => {
        const ids = ["evt_03", "idem_03"];
        return () => ids.shift() ?? crypto.randomUUID();
      })(),
      now: () => "2026-03-26T23:00:03.000Z",
    });

    await expect(
      client.queueAndSend({
        type: "response.changed",
        payload: {
          responseKey: "RESPONSE_03",
          responseState: {
            candidateResponse: "C",
          },
        },
      }),
    ).rejects.toThrow("network unavailable");

    expect(wasWrittenBeforeSend).toBe(true);
    expect(committedSequences).toEqual([3]);
    expect((await journal.list(attemptId)).map((entry) => entry.event.sequenceNumber)).toEqual([
      2, 3,
    ]);
  });

  it("queues the final response and submit intent before sending either event", async () => {
    const attemptId = "attempt_resume_submit_batch_01";
    const journal = createAttemptJournal({
      store: createMemoryAttemptJournalStore(),
      now: () => "2026-03-26T23:10:00.000Z",
    });
    const receiptStore = createMemoryAttemptReplayReceiptStore();

    const session: AuthoritativeAttemptSessionState = {
      currentItemRef: CURRENT_ITEM,
      sequence: {
        lastAcceptedSequence: null,
        nextSequence: 1,
      },
      timing: {
        startedAt: "2026-03-26T23:10:00.000Z",
        expiresAt: null,
        remainingTimeSeconds: null,
      },
      attemptStatus: "active",
    };

    let failFirstSend = true;
    const committedSequences: number[] = [];
    const committedEvents: AttemptEventEnvelope[] = [];
    const transport: AttemptClientTransport = {
      commit: async (event) => {
        committedSequences.push(event.sequenceNumber);
        committedEvents.push(event);

        if (failFirstSend) {
          failFirstSend = false;
          throw new Error("network unavailable");
        }

        return {
          ...createAcceptedResponse(event),
          attemptStatus: event.type === "submit.requested" ? "submitted" : "active",
        };
      },
    };

    const client = createAttemptClient({
      attemptId,
      clientSessionId: "client_session_resume_submit_batch_01",
      initialSession: session,
      journal,
      receiptStore,
      transport,
      createId: (() => {
        const ids = [
          "evt_response_final",
          "idem_response_final",
          "evt_submit_final",
          "idem_submit_final",
        ];
        return () => ids.shift() ?? crypto.randomUUID();
      })(),
      now: () => "2026-03-26T23:10:01.000Z",
    });

    await expect(
      client.queueAndSendBatch([
        {
          type: "response.changed",
          payload: {
            responseKey: "RESPONSE_FINAL",
            responseState: {
              candidateResponse: "C",
            },
          },
        },
        {
          type: "submit.requested",
          payload: {
            requestedAt: "2026-03-26T23:10:01.000Z",
            submissionSummary: null,
            submissionMaterialization: null,
          },
        },
      ]),
    ).rejects.toThrow("network unavailable");

    const locallyQueued = await journal.list(attemptId);
    expect(locallyQueued.map((entry) => entry.event.sequenceNumber)).toEqual([1, 2]);
    expect(locallyQueued.map((entry) => entry.event.type)).toEqual([
      "response.changed",
      "submit.requested",
    ]);
    expect(committedSequences).toEqual([1]);
    expect(committedEvents[0]?.syncTrace).toMatchObject({
      sendReason: "initial",
      queueDepthAtSend: 2,
      replayAttempt: 0,
    });

    const replayResponses = await client.replayPending();
    expect(replayResponses.map((response) => response.attemptStatus)).toEqual([
      "active",
      "submitted",
    ]);
    expect(await journal.list(attemptId)).toEqual([]);
    expect(
      (await receiptStore.list(attemptId)).map((record) => ({
        eventType: record.eventType,
        outcome: record.outcome,
        receiptId: record.receiptId,
      })),
    ).toEqual([
      {
        eventType: "response.changed",
        outcome: "accepted",
        receiptId: "rcpt_1",
      },
      {
        eventType: "submit.requested",
        outcome: "accepted",
        receiptId: "rcpt_2",
      },
    ]);
    expect(committedSequences).toEqual([1, 1, 2]);
    expect(committedEvents.slice(1).map((event) => event.syncTrace)).toEqual([
      expect.objectContaining({
        sendReason: "replay",
        queueDepthAtSend: 2,
        replayAttempt: 1,
      }),
      expect.objectContaining({
        sendReason: "replay",
        queueDepthAtSend: 2,
        replayAttempt: 2,
      }),
    ]);
  });

  it("serializes concurrent client writes so each event receives the next sequence", async () => {
    const attemptId = "attempt_concurrent_client_writes_01";
    const journal = createAttemptJournal({
      store: createMemoryAttemptJournalStore(),
      now: () => "2026-03-26T23:05:00.000Z",
    });
    let releaseFirstCommit: (() => void) | undefined;
    const firstCommitGate = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    let markFirstCommitStarted: (() => void) | undefined;
    const firstCommitStarted = new Promise<void>((resolve) => {
      markFirstCommitStarted = resolve;
    });
    const committedSequences: number[] = [];
    const client = createAttemptClient({
      attemptId,
      clientSessionId: "client_session_concurrent_01",
      initialSession: {
        currentItemRef: CURRENT_ITEM,
        sequence: { lastAcceptedSequence: null, nextSequence: 1 },
        timing: {
          startedAt: "2026-03-26T23:05:00.000Z",
          expiresAt: null,
          remainingTimeSeconds: null,
        },
        attemptStatus: "active",
      },
      journal,
      transport: {
        commit: async (event) => {
          committedSequences.push(event.sequenceNumber);
          if (event.sequenceNumber === 1) {
            markFirstCommitStarted?.();
            await firstCommitGate;
          }
          return createAcceptedResponse(event);
        },
      },
    });

    const first = client.queueAndSend({
      type: "response.changed",
      payload: { responseKey: "RESPONSE_1", responseState: "A" },
    });
    await firstCommitStarted;
    const second = client.queueAndSend({
      type: "response.changed",
      payload: { responseKey: "RESPONSE_2", responseState: "B" },
    });
    releaseFirstCommit?.();

    await Promise.all([first, second]);
    expect(committedSequences).toEqual([1, 2]);
    expect(client.getState()).toMatchObject({
      highestCommittedSequence: 2,
      nextSequenceNumber: 3,
    });
  });

  it("replays keyword language selection and reconciles authoritative preferences", async () => {
    const attemptId = "attempt_keyword_language_replay_01";
    const journal = createAttemptJournal({
      store: createMemoryAttemptJournalStore(),
      now: () => "2026-03-26T23:05:00.000Z",
    });
    let offline = true;
    const transport: AttemptClientTransport = {
      commit: async (event) => {
        if (offline) throw new Error("network unavailable");
        return {
          ...createAcceptedResponse(event),
          deliveryPreferences: { keywordTranslationLanguage: "fr-CA" },
        };
      },
    };
    const client = createAttemptClient({
      attemptId,
      clientSessionId: "client_keyword_language_replay",
      initialSession: {
        currentItemRef: CURRENT_ITEM,
        sequence: { lastAcceptedSequence: null, nextSequence: 1 },
        timing: {
          startedAt: "2026-03-26T23:05:00.000Z",
          expiresAt: null,
          remainingTimeSeconds: null,
        },
        attemptStatus: "active",
        deliveryPreferences: { keywordTranslationLanguage: null },
      },
      journal,
      transport,
      createId: (() => {
        const ids = ["evt_keyword_language", "idem_keyword_language"];
        return () => ids.shift() ?? crypto.randomUUID();
      })(),
      now: () => "2026-03-26T23:05:01.000Z",
    });

    const pendingSelection = client.queueAndSend({
      type: "keyword-translation.language.selected",
      payload: { requestedLanguage: "fr-CA" },
    });
    expect(client.getState().deliveryPreferences).toEqual({
      keywordTranslationLanguage: "fr-CA",
    });
    await expect(pendingSelection).rejects.toThrow("network unavailable");
    expect(client.getState().deliveryPreferences).toEqual({
      keywordTranslationLanguage: "fr-CA",
    });
    expect((await journal.list(attemptId))[0]?.event).toMatchObject({
      type: "keyword-translation.language.selected",
      payload: { requestedLanguage: "fr-CA" },
    });

    offline = false;
    await client.replayPending();
    expect(await journal.list(attemptId)).toHaveLength(0);
    expect(client.getState().deliveryPreferences).toEqual({
      keywordTranslationLanguage: "fr-CA",
    });
  });

  it("discards a terminally rejected language selection and restores authoritative preferences", async () => {
    const attemptId = "attempt_keyword_language_rejected_01";
    const journal = createAttemptJournal({
      store: createMemoryAttemptJournalStore(),
      now: () => "2026-03-26T23:06:00.000Z",
    });
    network.use(
      http.post(`https://harbor.local/api/attempts/${attemptId}/events`, () =>
        Response.json(
          {
            error: "Keyword translation language is not currently entitled for this attempt",
            highestCommittedSequence: 0,
            expectedNextSequence: 1,
            deliveryPreferences: { keywordTranslationLanguage: "fr-CA" },
          },
          { status: 409 },
        ),
      ),
    );
    const client = createAttemptClient({
      attemptId,
      clientSessionId: "client_keyword_language_rejected",
      initialSession: {
        currentItemRef: CURRENT_ITEM,
        sequence: { lastAcceptedSequence: null, nextSequence: 1 },
        timing: {
          startedAt: "2026-03-26T23:06:00.000Z",
          expiresAt: null,
          remainingTimeSeconds: null,
        },
        attemptStatus: "active",
        deliveryPreferences: { keywordTranslationLanguage: "fr-CA" },
      },
      journal,
      transport: createFetchAttemptTransport(fetchFromTestOrigin),
      createId: (() => {
        const ids = ["evt_keyword_language_rejected", "idem_keyword_language_rejected"];
        return () => ids.shift() ?? crypto.randomUUID();
      })(),
      now: () => "2026-03-26T23:06:01.000Z",
    });

    const rejectedSelection = client.queueAndSend({
      type: "keyword-translation.language.selected",
      payload: { requestedLanguage: "ja" },
    });
    expect(client.getState().deliveryPreferences).toEqual({
      keywordTranslationLanguage: "ja",
    });

    await expect(rejectedSelection).rejects.toMatchObject({ status: 409 });
    expect(client.getState()).toMatchObject({
      highestCommittedSequence: 0,
      nextSequenceNumber: 1,
      deliveryPreferences: { keywordTranslationLanguage: "fr-CA" },
    });
    expect(await journal.list(attemptId)).toEqual([]);
  });

  it("prunes stale replay entries already covered by the authoritative sequence", async () => {
    const attemptId = "attempt_resume_stale_prune_01";
    const journal = createAttemptJournal({
      store: createMemoryAttemptJournalStore(),
      now: () => "2026-03-26T23:15:00.000Z",
    });

    await journal.appendMany([
      {
        attemptId,
        eventId: "evt_stale_01",
        idempotencyKey: "idem_stale_01",
        sequenceNumber: 1,
        clientTimestamp: "2026-03-26T23:15:01.000Z",
        clientSessionId: "client_session_stale_prune_01",
        itemRef: CURRENT_ITEM,
        type: "response.changed",
        payload: {
          responseKey: "RESPONSE_01",
          responseState: {
            candidateResponse: "A",
          },
        },
      },
      {
        attemptId,
        eventId: "evt_stale_02",
        idempotencyKey: "idem_stale_02",
        sequenceNumber: 2,
        clientTimestamp: "2026-03-26T23:15:02.000Z",
        clientSessionId: "client_session_stale_prune_01",
        itemRef: CURRENT_ITEM,
        type: "response.changed",
        payload: {
          responseKey: "RESPONSE_02",
          responseState: {
            candidateResponse: "B",
          },
        },
      },
    ]);

    const session: AuthoritativeAttemptSessionState = {
      currentItemRef: CURRENT_ITEM,
      sequence: {
        lastAcceptedSequence: null,
        nextSequence: 1,
      },
      timing: {
        startedAt: "2026-03-26T23:15:00.000Z",
        expiresAt: null,
        remainingTimeSeconds: null,
      },
      attemptStatus: "active",
    };

    const client = createAttemptClient({
      attemptId,
      clientSessionId: "client_session_stale_prune_01",
      initialSession: session,
      journal,
      transport: {
        commit: async (event) => ({
          outcome: "stale_sequence",
          attemptId,
          highestCommittedSequence: 2,
          expectedNextSequence: 3,
          attemptStatus: "active",
          currentItemRef: CURRENT_ITEM,
          timing: session.timing,
          requestedSequenceNumber: event.sequenceNumber,
        }),
      },
      now: () => "2026-03-26T23:15:03.000Z",
    });

    const responses = await client.replayPending();

    expect(responses[0]).toMatchObject({
      outcome: "stale_sequence",
      highestCommittedSequence: 2,
      expectedNextSequence: 3,
    });
    expect(await journal.list(attemptId)).toEqual([]);
    expect(client.getState()).toMatchObject({
      highestCommittedSequence: 2,
      nextSequenceNumber: 3,
    });
  });

  it("does not send final response or submit intent when local recovery storage fails", async () => {
    const attemptId = "attempt_resume_submit_quota_01";
    const failingStore: AttemptJournalStore = {
      async read() {
        return [];
      },
      async write() {
        throw new Error("storage quota exceeded");
      },
    };
    const journal = createAttemptJournal({
      store: failingStore,
      now: () => "2026-03-26T23:20:00.000Z",
    });

    const session: AuthoritativeAttemptSessionState = {
      currentItemRef: CURRENT_ITEM,
      sequence: {
        lastAcceptedSequence: null,
        nextSequence: 1,
      },
      timing: {
        startedAt: "2026-03-26T23:20:00.000Z",
        expiresAt: null,
        remainingTimeSeconds: null,
      },
      attemptStatus: "active",
    };

    const committedSequences: number[] = [];
    const client = createAttemptClient({
      attemptId,
      clientSessionId: "client_session_resume_submit_quota_01",
      initialSession: session,
      journal,
      transport: {
        commit: async (event) => {
          committedSequences.push(event.sequenceNumber);
          return createAcceptedResponse(event);
        },
      },
      createId: (() => {
        const ids = [
          "evt_response_quota",
          "idem_response_quota",
          "evt_submit_quota",
          "idem_submit_quota",
        ];
        return () => ids.shift() ?? crypto.randomUUID();
      })(),
      now: () => "2026-03-26T23:20:01.000Z",
    });

    await expect(
      client.queueAndSendBatch([
        {
          type: "response.changed",
          payload: {
            responseKey: "RESPONSE_FINAL",
            responseState: {
              candidateResponse: "C",
            },
          },
        },
        {
          type: "submit.requested",
          payload: {
            requestedAt: "2026-03-26T23:20:01.000Z",
            submissionSummary: null,
            submissionMaterialization: null,
          },
        },
      ]),
    ).rejects.toThrow("storage quota exceeded");

    expect(committedSequences).toEqual([]);
  });
});

describe("phase 2 resume expectations", () => {
  it("reuses the latest eligible access-code attempt instead of creating a duplicate relaunch", async () => {
    const published = await publishFixture({
      tenantId: "tenant_resume_reuse",
      assessmentSlug: "basic-assessment",
    });
    const issued = await issueAccessCode(published.assessmentVersionId);

    const firstAttempt = await launchAccessCodeAttempt({
      accessCode: issued.accessCode,
      actorId: "candidate_resume_01",
      clientSessionId: "client_session_resume_a",
    });
    await authorizeWorkstationTransfer(firstAttempt.attemptId, "client_session_resume_b");
    const secondAttempt = await launchAccessCodeAttempt({
      accessCode: issued.accessCode,
      actorId: "candidate_resume_01",
      clientSessionId: "client_session_resume_b",
    });

    expect(secondAttempt.attemptId).toBe(firstAttempt.attemptId);
    expect(await countAttemptsForAccessCode(issued.accessCodeId)).toBe(1);
  });

  it("hydrates authoritative sequence and current-item state through the existing bootstrap path on reconnect", async () => {
    const published = await publishFixture({
      tenantId: "tenant_resume_bootstrap",
      assessmentSlug: "basic-assessment",
    });
    const targetItemRef = await appendReviewItemToManifest(published.manifestObjectKey);
    const issued = await issueAccessCode(published.assessmentVersionId);
    const firstAttempt = await launchAccessCodeAttempt({
      accessCode: issued.accessCode,
      actorId: "candidate_resume_02",
      clientSessionId: "client_session_resume_a",
    });

    const navigation = await commitAttemptEvent(firstAttempt.attemptId, {
      attemptId: firstAttempt.attemptId,
      eventId: "evt_resume_navigation_01",
      idempotencyKey: "idem_resume_navigation_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T23:45:00.000Z",
      clientSessionId: "client_session_resume_a",
      itemRef: firstAttempt.session.currentItemRef,
      type: "navigation.requested",
      payload: {
        targetItemRef,
      },
    });

    expect(navigation.status).toBe(200);

    await authorizeWorkstationTransfer(firstAttempt.attemptId, "client_session_resume_b");
    const resumedAttempt = await launchAccessCodeAttempt({
      accessCode: issued.accessCode,
      actorId: "candidate_resume_02",
      clientSessionId: "client_session_resume_b",
    });

    expect(resumedAttempt.attemptId).toBe(firstAttempt.attemptId);
    expect(resumedAttempt.session.currentItemRef).toEqual(targetItemRef);
    const manifest = await workerExports.default.fetch(
      new Request(`https://harbor.local/api/content/manifest?attemptId=${firstAttempt.attemptId}`),
    );
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ currentItemId: targetItemRef.itemId });
    expect(resumedAttempt.session.sequence).toEqual({
      lastAcceptedSequence: 1,
      nextSequence: 2,
    });
  });

  it("returns accepted candidate responses to a clean workstation without scoring material", async () => {
    const published = await publishFixture({
      tenantId: "tenant_checkpoint",
      assessmentSlug: "checkpoint",
    });
    const issued = await issueAccessCode(published.assessmentVersionId);
    const first = await launchAccessCodeAttempt({
      accessCode: issued.accessCode,
      actorId: "candidate_checkpoint",
      clientSessionId: "workstation_a",
    });
    const accommodation = await postJson(`/internal/attempts/${first.attemptId}/policy`, {
      commandId: "checkpoint-accommodations",
      type: "set-accommodations",
      actor: { role: "operator", actorId: "lab-support" },
      reason: "Pinned recovery accommodations",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      accommodations: {
        rendererPnp: { layoutSingleColumn: true },
        sessionControl: { allow_review: true },
        shellTools: { notepad: true },
      },
    });
    expect(accommodation.status).toBe(200);
    const pinnedA = await launchAccessCodeAttempt({
      accessCode: issued.accessCode,
      actorId: "candidate_checkpoint",
      clientSessionId: "workstation_a",
    });
    const itemState = {
      schema: "qti3.attempt-state.v1",
      itemIdentifier: "item-1",
      status: "suspended",
      responses: { RESPONSE: "B", ESSAY: "A sustained explanation", ORDER: ["x", "y"] },
      outcomes: { SCORE: 99, SECRET: "must-not-be-returned" },
      validationMessages: [],
    };
    const saved = await commitAttemptEvent(first.attemptId, {
      attemptId: first.attemptId,
      eventId: "checkpoint_event",
      idempotencyKey: "checkpoint_key",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "workstation_a",
      itemRef: first.session.currentItemRef,
      type: "response.changed",
      payload: { responseKey: first.session.currentItemRef.itemId, responseState: { itemState } },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ outcome: "accepted" });
    await authorizeWorkstationTransfer(first.attemptId, "workstation_b");
    const clean = await launchAccessCodeAttempt({
      accessCode: issued.accessCode,
      actorId: "candidate_checkpoint",
      clientSessionId: "workstation_b",
    });
    expect(clean.attemptId).toBe(first.attemptId);
    expect(clean.session.responseCheckpoint).toMatchObject({
      acceptedSequenceNumber: 1,
      items: { "item-1": { responses: itemState.responses, outcomes: {}, status: "suspended" } },
    });
    expect(JSON.stringify(clean.session.responseCheckpoint)).not.toContain("must-not-be-returned");
    expect(clean.session.timing?.expiresAt).toEqual(first.session.timing?.expiresAt);
    expect(clean.policy).toEqual(pinnedA.policy);
    expect(clean.policy?.accommodations.rendererPnp.layoutSingleColumn).toBe(true);
    expect(clean.session.deliveryPreferences).toEqual(pinnedA.session.deliveryPreferences);
    const wrongQuestion = await commitAttemptEvent(first.attemptId, {
      attemptId: first.attemptId,
      eventId: "wrong-question",
      idempotencyKey: "wrong-question",
      sequenceNumber: 2,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "workstation_b",
      itemRef: clean.session.currentItemRef,
      type: "response.changed",
      payload: {
        intent: "checkpoint",
        responseKey: "item-1",
        responseState: { itemState: { ...itemState, itemIdentifier: "another-question" } },
      },
    });
    expect(wrongQuestion.status).toBe(409);
    for (const malformed of [null, { schema: "unknown" }, { responseVariables: [] }]) {
      const invalid = await commitAttemptEvent(first.attemptId, {
        attemptId: first.attemptId,
        eventId: "invalid-checkpoint",
        idempotencyKey: "invalid-checkpoint",
        sequenceNumber: 2,
        clientTimestamp: new Date().toISOString(),
        clientSessionId: "workstation_b",
        itemRef: clean.session.currentItemRef,
        type: "response.changed",
        payload: {
          intent: "checkpoint",
          responseKey: "item-1",
          responseState: { itemState: malformed },
        },
      });
      expect(invalid.status).toBe(400);
    }
    const submitted = await commitAttemptEvent(first.attemptId, {
      attemptId: first.attemptId,
      eventId: "checkpoint-submit",
      idempotencyKey: "checkpoint-submit",
      sequenceNumber: 2,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "workstation_b",
      itemRef: clean.session.currentItemRef,
      type: "submit.requested",
      payload: { requestedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({
      outcome: "accepted",
      attemptStatus: "submitted",
    });
    const forbiddenTransfer = await postJson(`/internal/attempts/${first.attemptId}/actions`, {
      actionId: "submitted-transfer",
      type: "transfer-workstation",
      clientSessionId: "workstation_c",
      actor: { role: "operator", actorId: "lab-support" },
      reason: "Cannot reopen by transfer",
      effectiveAt: new Date().toISOString(),
    });
    expect(forbiddenTransfer.status).toBe(409);
  });

  it("surfaces stale-session reconciliation when an obsolete clientSessionId keeps sending events", async () => {
    const published = await publishFixture({
      tenantId: "tenant_resume_stale",
      assessmentSlug: "basic-assessment",
    });
    const issued = await issueAccessCode(published.assessmentVersionId);
    const originalAttempt = await launchAccessCodeAttempt({
      accessCode: issued.accessCode,
      actorId: "candidate_resume_03",
      clientSessionId: "client_session_resume_a",
    });

    await authorizeWorkstationTransfer(originalAttempt.attemptId, "client_session_resume_b");
    const resumedAttempt = await launchAccessCodeAttempt({
      accessCode: issued.accessCode,
      actorId: "candidate_resume_03",
      clientSessionId: "client_session_resume_b",
    });

    const currentSessionCommit = await commitAttemptEvent(resumedAttempt.attemptId, {
      attemptId: resumedAttempt.attemptId,
      eventId: "evt_resume_current_01",
      idempotencyKey: "idem_resume_current_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T23:45:10.000Z",
      clientSessionId: "client_session_resume_b",
      itemRef: resumedAttempt.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_CURRENT",
        responseState: {
          candidateResponse: "B",
        },
      },
    });

    expect(currentSessionCommit.status).toBe(200);

    const staleCommit = await commitAttemptEvent(originalAttempt.attemptId, {
      attemptId: originalAttempt.attemptId,
      eventId: "evt_resume_stale_01",
      idempotencyKey: "idem_resume_stale_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T23:45:12.000Z",
      clientSessionId: "client_session_resume_a",
      itemRef: originalAttempt.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_STALE",
        responseState: {
          candidateResponse: "A",
        },
      },
    });

    expect(staleCommit.status).toBe(200);
    const stalePayload = await staleCommit.json<{
      outcome: string;
      highestCommittedSequence: number;
      currentClientSessionId: string | null;
    }>();

    expect(stalePayload.outcome).toBe("stale_session");
    expect(stalePayload.highestCommittedSequence).toBe(1);
    expect(stalePayload.currentClientSessionId).toBeNull();
  });
});
