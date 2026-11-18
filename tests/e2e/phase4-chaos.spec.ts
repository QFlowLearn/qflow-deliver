import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const workerOrigin =
  process.env.PLAYWRIGHT_API_BASE_URL ??
  process.env.STAGING_URL ??
  process.env.PLAYWRIGHT_BASE_URL ??
  process.env.STAGING_UI_URL ??
  "http://127.0.0.1:8787";

const fixtureRoot = path.resolve(process.cwd(), "tests/fixtures/qti/basic-assessment");

test.describe.configure({ mode: "serial" });

async function createFixturePackage(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", readFileSync(path.join(fixtureRoot, "imsmanifest.xml"), "utf8"));
  zip.file("items/item-1.xml", readFileSync(path.join(fixtureRoot, "items/item-1.xml"), "utf8"));
  zip.file(
    "assets/stimulus.svg",
    readFileSync(path.join(fixtureRoot, "assets/stimulus.svg"), "utf8"),
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

async function publishFixture(
  request: Parameters<typeof test>[0]["request"],
  seed: string,
): Promise<{
  assessmentVersionId: string;
}> {
  const response = await request.post(`${workerOrigin}/internal/publish?assessmentSlug=${seed}`, {
    headers: {
      "content-type": "application/zip",
      "x-harbor-package-name": "basic-assessment.zip",
      "x-harbor-tenant-id": `tenant_${seed}`,
    },
    data: await createFixturePackage(),
  });

  expect(response.status()).toBe(201);
  return response.json();
}

async function issueAccessCode(input: {
  request: Parameters<typeof test>[0]["request"];
  assessmentVersionId: string;
  code: string;
}): Promise<{
  accessCode: string;
}> {
  const response = await input.request.post(`${workerOrigin}/internal/access-codes`, {
    data: {
      assessmentVersionId: input.assessmentVersionId,
      code: input.code,
    },
  });

  expect(response.status()).toBe(201);
  return response.json();
}

async function launchPreviewAttempt(input: {
  page: Parameters<typeof test>[0]["page"];
  request: Parameters<typeof test>[0]["request"];
  seed: string;
}): Promise<void> {
  const published = await publishFixture(input.request, input.seed);

  await openSession(
    input.page,
    `/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`,
  );

  await expect(input.page.getByTestId("attempt-id")).toHaveCount(1);
  await expect(input.page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(input.page.getByTestId("save-response-button")).toBeVisible();
}

interface ProofPacketOutboxEntry {
  eventId: string;
  idempotencyKey: string;
  sequenceNumber: number;
  type: string;
  queuedAt: string;
}

interface ProofPacketEvidenceEvent {
  eventId: string | null;
  eventType: string;
  evidenceKind: string;
  sequenceNumber: number | null;
  outcome: string;
  receiptId: string | null;
  eventSource: string;
  syncSignals: string[];
}

interface ProofPacketRecoverySnapshot {
  outbox: ProofPacketOutboxEntry[];
  receipts: Array<{
    eventId: string;
    idempotencyKey: string;
    sequenceNumber: number;
    eventType: string;
    outcome: string;
    receiptId: string | null;
    confirmedAt: string;
  }>;
  metadata: Record<string, unknown> | null;
  itemStateKeys: string[];
}

async function readAttemptRecoverySnapshot(
  page: Page,
  attemptId: string,
): Promise<ProofPacketRecoverySnapshot> {
  return page.evaluate((scopedAttemptId) => {
    return new Promise<ProofPacketRecoverySnapshot>((resolve, reject) => {
      const request = indexedDB.open("harbor-attempt-recovery");
      request.onerror = () => reject(request.error ?? new Error("Unable to open attempt outbox."));
      request.onsuccess = () => {
        const db = request.result;
        const storeNames = [...db.objectStoreNames];
        const transaction = db.transaction(storeNames, "readonly");
        const readStoreRecord = (storeName: string) =>
          new Promise<unknown>((resolveRecord, rejectRecord) => {
            if (!storeNames.includes(storeName)) {
              resolveRecord(null);
              return;
            }
            const recordRequest = transaction.objectStore(storeName).get(scopedAttemptId);
            recordRequest.onerror = () =>
              rejectRecord(recordRequest.error ?? new Error(`Unable to read ${storeName}.`));
            recordRequest.onsuccess = () =>
              resolveRecord((recordRequest.result as unknown) ?? null);
          });
        const readReceipts = () =>
          new Promise<unknown[]>((resolveRecords, rejectRecords) => {
            if (!storeNames.includes("replay-receipts")) {
              resolveRecords([]);
              return;
            }
            const receiptRequest = transaction
              .objectStore("replay-receipts")
              .index("attemptId")
              .getAll(scopedAttemptId);
            receiptRequest.onerror = () =>
              rejectRecords(receiptRequest.error ?? new Error("Unable to read receipts."));
            receiptRequest.onsuccess = () =>
              resolveRecords((receiptRequest.result as unknown[]) ?? []);
          });

        Promise.all([
          readStoreRecord("attempt-journal"),
          readStoreRecord("attempt-metadata"),
          readStoreRecord("item-states"),
          readReceipts(),
        ]).then(([journalRecord, metadata, itemStates, receipts]) => {
          const record = journalRecord as {
            entries?: Array<{
              queuedAt?: string;
              event?: {
                eventId?: string;
                idempotencyKey?: string;
                sequenceNumber?: number;
                type?: string;
              };
            }>;
          } | null;
          const stateRecord = itemStates as {
            itemStates?: Record<string, unknown>;
          } | null;
          resolve({
            outbox: (record?.entries ?? []).map((entry) => ({
              eventId: entry.event?.eventId ?? "",
              idempotencyKey: entry.event?.idempotencyKey ?? "",
              sequenceNumber: entry.event?.sequenceNumber ?? 0,
              type: entry.event?.type ?? "unknown",
              queuedAt: entry.queuedAt ?? "",
            })),
            receipts: (receipts as Array<Record<string, unknown>>).map((receipt) => {
              if (
                typeof receipt.eventId !== "string" ||
                typeof receipt.idempotencyKey !== "string" ||
                typeof receipt.eventType !== "string" ||
                typeof receipt.outcome !== "string" ||
                typeof receipt.confirmedAt !== "string"
              )
                throw new Error("Invalid persisted replay receipt");
              return {
                eventId: receipt.eventId,
                idempotencyKey: receipt.idempotencyKey,
                sequenceNumber:
                  typeof receipt.sequenceNumber === "number" ? receipt.sequenceNumber : 0,
                eventType: receipt.eventType,
                outcome: receipt.outcome,
                receiptId: typeof receipt.receiptId === "string" ? receipt.receiptId : null,
                confirmedAt: receipt.confirmedAt,
              };
            }),
            metadata: (metadata as Record<string, unknown> | null) ?? null,
            itemStateKeys: Object.keys(stateRecord?.itemStates ?? {}),
          });
        }, reject);
      };
    });
  }, attemptId);
}

async function readAttemptEvidence(
  request: Parameters<typeof test>[0]["request"],
  attemptId: string,
): Promise<ProofPacketEvidenceEvent[]> {
  const response = await request.get(
    `${workerOrigin}/internal/attempts/${encodeURIComponent(attemptId)}/evidence`,
  );
  expect(response.status()).toBe(200);
  const body = await response.json<{
    events: ProofPacketEvidenceEvent[];
  }>();
  return body.events.map((event) => ({
    eventId: event.eventId,
    eventType: event.eventType,
    evidenceKind: event.evidenceKind,
    sequenceNumber: event.sequenceNumber,
    outcome: event.outcome,
    receiptId: event.receiptId,
    eventSource: event.eventSource,
    syncSignals: event.syncSignals,
  }));
}

async function writeOfflineProofPacket(
  testInfo: TestInfo,
  packet: {
    scenario: string;
    attemptId: string;
    recoveryBeforeRestore: ProofPacketRecoverySnapshot;
    recoveryAfterReplay?: ProofPacketRecoverySnapshot;
    evidence: ProofPacketEvidenceEvent[];
    finalDeliveryState: string | null;
    finalPendingEventCount: string | null;
  },
): Promise<void> {
  const path = testInfo.outputPath("offline-delivery-proof-packet.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...packet,
      },
      null,
      2,
    ),
  );
  await testInfo.attach("offline-delivery-proof-packet", {
    path,
    contentType: "application/json",
  });
}

test("replays offline work after reconnect on the deployed shell boundary", async ({
  page,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase4-offline-${testInfo.parallelIndex}-${Date.now()}`,
  });

  await page.context().setOffline(true);
  await page.getByTestId("save-response-button").click();

  await expect(page.getByTestId("pending-event-count")).toHaveText("1");
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("1");
  await expect(page.getByTestId("replay-status")).toContainText(
    "saved update(s) will sync when the connection is available",
  );

  await page.context().setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });

  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("2");
  await expect(page.getByTestId("next-sequence-number")).toHaveText("3");
  await expect(page.getByTestId("replay-status")).toContainText(
    "Durable receipts now cover sequence 2.",
  );
});

test("projects duplicate-tab authority changes back onto stale tabs", async ({
  page,
  context,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase4-duplicate-tab-${testInfo.parallelIndex}-${Date.now()}`,
  );
  const issued = await issueAccessCode({
    request,
    assessmentVersionId: published.assessmentVersionId,
    code: `PHASE4-${Date.now()}`,
  });
  const accessCodeUrl = `/?mode=access-code&accessCode=${issued.accessCode}&candidateId=phase4_candidate_01&candidateName=Phase%204%20Candidate`;

  await openSession(page, accessCodeUrl);
  await expect(page.getByTestId("attempt-id")).toHaveCount(1);
  const attemptId = await page.getByTestId("attempt-id").textContent();

  await page.getByTestId("save-response-button").click();
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("2");

  const duplicateTab = await context.newPage();
  await duplicateTab.goto(accessCodeUrl);
  const replacementCode = await duplicateTab
    .getByTestId("replacement-workstation-code")
    .textContent();
  expect(
    (
      await request.post(`${workerOrigin}/internal/attempts/${attemptId}/actions`, {
        data: {
          actionId: `transfer-${Date.now()}`,
          type: "transfer-workstation",
          clientSessionId: replacementCode,
          actor: { role: "operator", actorId: "chaos-test" },
          reason: "Authorize replacement tab",
          effectiveAt: new Date().toISOString(),
        },
      })
    ).status(),
  ).toBe(200);
  await openSession(duplicateTab, accessCodeUrl);

  await expect(duplicateTab.getByTestId("attempt-id")).toHaveText(attemptId ?? "");
  await expect(duplicateTab.getByTestId("highest-committed-sequence")).toHaveText("2");

  await duplicateTab.getByTestId("save-response-button").click();
  await expect(duplicateTab.getByTestId("highest-committed-sequence")).toHaveText("3");

  await page.getByTestId("save-response-button").click();
  await expect(page.getByTestId("replay-status")).toContainText("no longer current");
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("3");
  await expect(page.getByTestId("save-response-button")).toBeDisabled();

  await duplicateTab.close();
});

test("recovers a degraded submit request and keeps submitted state durable after reload", async ({
  page,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase4-submit-recovery-${testInfo.parallelIndex}-${Date.now()}`,
  });

  let blocked = false;
  await page.route("**/api/attempts/**", async (route) => {
    const postData = route.request().postDataJSON() as { type?: string } | null;
    if (!blocked && postData?.type === "submit.requested") {
      blocked = true;
      await route.abort("failed");
      return;
    }

    await route.continue();
  });

  await page.getByTestId("submit-attempt-button").click();

  await expect(page.getByTestId("pending-event-count")).toHaveText("1");
  await expect(page.getByTestId("delivery-state")).toHaveText("active");
  await expectPendingFinish(page);

  await page.unroute("**/api/attempts/**");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });

  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("submit-status")).toContainText("durably submitted");
  await expect(page.getByTestId("save-response-button")).toBeDisabled();

  await page.reload();

  await expect(page.getByTestId("delivery-state")).toHaveText("submitted");
  await expect(page.getByTestId("submit-status")).toContainText("durably submitted");
  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("save-response-button")).toBeDisabled();
});

test("queues final response and submit intent when response save fails during submit", async ({
  page,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase4-submit-response-gap-${testInfo.parallelIndex}-${Date.now()}`,
  });

  let blocked = false;
  await page.route("**/api/attempts/**", async (route) => {
    const postData = route.request().postDataJSON() as { type?: string } | null;
    if (!blocked && postData?.type === "response.changed") {
      blocked = true;
      await route.abort("failed");
      return;
    }

    await route.continue();
  });

  await page.getByTestId("submit-attempt-button").click();

  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  await expect(page.getByTestId("delivery-state")).toHaveText("active");
  await expectPendingFinish(page);

  await page.unroute("**/api/attempts/**");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });

  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("submit-status")).toContainText("durably submitted");
});

test("queues submit while offline and replays it after reconnect", async ({
  page,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase4-submit-offline-${testInfo.parallelIndex}-${Date.now()}`,
  });

  const attemptId = await page.getByTestId("attempt-id").textContent();
  expect(attemptId).toBeTruthy();

  await page.route("**/api/attempts/**", async (route) => {
    await route.abort("failed");
  });
  await page.getByTestId("submit-attempt-button").click();

  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  await expect(page.getByTestId("delivery-state")).toHaveText("active");
  await expectPendingFinish(page);
  await expectPendingFinish(page);
  const recoveryBeforeRestore = await readAttemptRecoverySnapshot(page, attemptId ?? "");

  await page.unroute("**/api/attempts/**");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });

  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted", {
    timeout: 15_000,
  });
  const evidence = await readAttemptEvidence(request, attemptId ?? "");
  await writeOfflineProofPacket(testInfo, {
    scenario: "offline-submit-replay",
    attemptId: attemptId ?? "",
    recoveryBeforeRestore,
    recoveryAfterReplay: await readAttemptRecoverySnapshot(page, attemptId ?? ""),
    evidence,
    finalDeliveryState: await page.getByTestId("delivery-state").textContent(),
    finalPendingEventCount: await page.getByTestId("pending-event-count").textContent(),
  });
});

test("keeps queued submit across reload while the attempt endpoint is unavailable", async ({
  page,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase4-submit-reload-${testInfo.parallelIndex}-${Date.now()}`,
  });
  const attemptId = await page.getByTestId("attempt-id").textContent();
  expect(attemptId).toBeTruthy();

  await page.route("**/api/attempts/**", async (route) => {
    await route.abort("failed");
  });

  await page.getByTestId("submit-attempt-button").click();
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  await expectPendingFinish(page);
  const recoveryBeforeRestore = await readAttemptRecoverySnapshot(page, attemptId ?? "");

  await page.reload();
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");

  await page.unroute("**/api/attempts/**");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });

  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted", {
    timeout: 15_000,
  });
  await writeOfflineProofPacket(testInfo, {
    scenario: "offline-submit-reload-replay",
    attemptId: attemptId ?? "",
    recoveryBeforeRestore,
    recoveryAfterReplay: await readAttemptRecoverySnapshot(page, attemptId ?? ""),
    evidence: await readAttemptEvidence(request, attemptId ?? ""),
    finalDeliveryState: await page.getByTestId("delivery-state").textContent(),
    finalPendingEventCount: await page.getByTestId("pending-event-count").textContent(),
  });
});

test("replays queued submit after tab close and reopen", async ({
  page,
  context,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase4-submit-reopen-${testInfo.parallelIndex}-${Date.now()}`,
  });

  const recoveryUrl = page.url();
  const attemptId = await page.getByTestId("attempt-id").textContent();
  expect(attemptId).toBeTruthy();
  await context.route("**/api/attempts/**", async (route) => {
    await route.abort("failed");
  });

  await page.getByTestId("submit-attempt-button").click();
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  await expectPendingFinish(page);
  const recoveryBeforeRestore = await readAttemptRecoverySnapshot(page, attemptId ?? "");
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto(recoveryUrl);
  await expect(reopened.getByTestId("pending-event-count")).toHaveText("2");
  await expectPendingFinish(reopened);

  await context.unroute("**/api/attempts/**");
  await reopened.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });

  await expect(reopened.getByTestId("pending-event-count")).toHaveText("0");
  await expect(reopened.getByTestId("delivery-state")).toHaveText("submitted", {
    timeout: 15_000,
  });
  await writeOfflineProofPacket(testInfo, {
    scenario: "offline-submit-tab-reopen-replay",
    attemptId: attemptId ?? "",
    recoveryBeforeRestore,
    recoveryAfterReplay: await readAttemptRecoverySnapshot(reopened, attemptId ?? ""),
    evidence: await readAttemptEvidence(request, attemptId ?? ""),
    finalDeliveryState: await reopened.getByTestId("delivery-state").textContent(),
    finalPendingEventCount: await reopened.getByTestId("pending-event-count").textContent(),
  });
});

test("retries queued submit after transient worker errors", async ({ page, request }, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase4-submit-worker-retry-${testInfo.parallelIndex}-${Date.now()}`,
  });
  const attemptId = await page.getByTestId("attempt-id").textContent();
  expect(attemptId).toBeTruthy();

  let failuresRemaining = 2;
  await page.route("**/api/attempts/**", async (route) => {
    const postData = route.request().postDataJSON() as { type?: string } | null;
    const isReplayableCommit =
      postData?.type === "response.changed" || postData?.type === "submit.requested";
    if (isReplayableCommit && failuresRemaining > 0) {
      failuresRemaining -= 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "transient worker error" }),
      });
      return;
    }

    await route.continue();
  });

  await page.getByTestId("submit-attempt-button").click();
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  await expectPendingFinish(page);
  const recoveryBeforeRestore = await readAttemptRecoverySnapshot(page, attemptId ?? "");

  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");

  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted", {
    timeout: 15_000,
  });
  await writeOfflineProofPacket(testInfo, {
    scenario: "offline-submit-transient-retry",
    attemptId: attemptId ?? "",
    recoveryBeforeRestore,
    recoveryAfterReplay: await readAttemptRecoverySnapshot(page, attemptId ?? ""),
    evidence: await readAttemptEvidence(request, attemptId ?? ""),
    finalDeliveryState: await page.getByTestId("delivery-state").textContent(),
    finalPendingEventCount: await page.getByTestId("pending-event-count").textContent(),
  });
});

async function openSession(page: Page, url: string): Promise<void> {
  // Reopened sessions can reuse a durable presentation receipt without a new send.
  await page.goto(url);
  await expect(page.getByTestId("save-response-button")).toBeEnabled();
  await expect(page.getByTestId("highest-committed-sequence")).not.toHaveText("0");
}

async function expectPendingFinish(page: Page): Promise<void> {
  await expect(page.getByTestId("submission-state")).toHaveText("pending");
  await expect(page.getByTestId("submit-attempt-button")).toBeDisabled();
  await expect(page.getByTestId("save-response-button")).toBeDisabled();
}
