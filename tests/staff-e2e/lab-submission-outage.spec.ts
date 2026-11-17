import { expect, test, type Page } from "@playwright/test";
import { seedRecoveryExam, signInAndOpen, api } from "./lab-recovery-fixture";
import {
  expectOneFinalizedAnswerSet,
  readOneFinalizedAttempt,
  readTimingWitness,
  signInOutageStaff,
} from "./lab-outage-helpers";

async function finishTwoItemExam(page: Page) {
  await page.getByRole("radio", { name: "B. Blue", exact: true }).check();
  await page.getByRole("textbox").fill("Final answer to question one.");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("current-item-id")).toHaveText("item-2");
  // The coordinator updates its item ID before the next item finishes loading.
  // Target the actual second question, rather than filling the previous renderer during navigation.
  await expect(
    page.getByRole("textbox", { name: "What would you do next?", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[inert] harbor-qti-renderer-host")).toHaveCount(0);
  await expect(page.getByTestId("save-response-button")).toBeEnabled();
  await page
    .getByRole("textbox", { name: "What would you do next?", exact: true })
    .fill("Final answer to question two.");
  await expect
    .poll(() =>
      page
        .locator("qti-assessment-item-player")
        .evaluate((element) =>
          "serialize" in element && typeof element.serialize === "function"
            ? element.serialize()
            : null,
        ),
    )
    .toMatchObject({ responses: { TEXT: "Final answer to question two." } });
}

async function expectPendingLock(page: Page) {
  await expect(page.getByTestId("submission-state")).toHaveText("pending");
  await expect(
    page.getByRole("heading", { name: "Finish saved; confirmation pending" }),
  ).toBeVisible();
  await expect(page.getByTestId("submit-attempt-button")).toBeDisabled();
  await expect(page.getByTestId("save-response-button")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  // inert prevents keyboard/pointer editing throughout the renderer, including custom controls.
  await expect(page.locator("[inert] harbor-qti-renderer-host")).toHaveCount(1);
}

test("Finish freezes a real multi-item answer set before any acknowledgement and survives reopen", async ({
  page,
  context,
  request,
}) => {
  await signInAndOpen(page, await seedRecoveryExam(request));
  await finishTwoItemExam(page);
  // Hold the first request to prove locking happens before a response or transport failure.
  let releaseRequests!: () => void; // SAFETY: Promise executes this initializer synchronously.
  const disconnected = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });
  await context.route("**/api/**", async (route) => {
    await disconnected;
    await route.abort("failed");
  });
  await page.getByTestId("submit-attempt-button").click();
  try {
    await expectPendingLock(page);
  } finally {
    releaseRequests();
  }
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  const attemptId = await page.getByTestId("attempt-id").innerText();
  const recoveryUrl = page.url();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(recoveryUrl);
  await expect(reopened.getByTestId("submission-state")).toHaveText("pending");
  await expect(reopened.getByTestId("submit-attempt-button")).toBeDisabled();
  await expect(reopened.getByTestId("pending-event-count")).toHaveText("2");
  await context.unroute("**/api/**");
  await reopened.getByTestId("retry-pending-button").click();
  await expect(reopened.getByTestId("submission-state")).toHaveText("confirmed");
  await expect(reopened.getByTestId("pending-event-count")).toHaveText("0");
  await expect(reopened.getByTestId("submission-receipt")).not.toHaveText("");
  await expect(reopened.getByTestId("submit-attempt-button")).toBeDisabled();
  await reopened.reload();
  await expect(reopened.getByTestId("submission-state")).toHaveText("confirmed");
  await expectOneFinalizedAnswerSet(reopened, attemptId);
});

test("a lost Finish acknowledgement replays the same event and original receipt", async ({
  page,
  request,
}) => {
  await signInAndOpen(page, await seedRecoveryExam(request));
  await finishTwoItemExam(page);
  let originalReceipt: string | null = null;
  let originalKey: string | null = null;
  let replayKey: string | null = null;
  await page.route("**/api/attempts/*/events", async (route) => {
    const event: unknown = route.request().postDataJSON();
    if (
      !event ||
      typeof event !== "object" ||
      !("type" in event) ||
      event.type !== "submit.requested"
    ) {
      await route.continue();
      return;
    }
    if (!("idempotencyKey" in event) || typeof event.idempotencyKey !== "string")
      throw new Error("Missing Finish identity");
    if (originalReceipt) {
      replayKey = event.idempotencyKey;
      await route.continue();
      return;
    }
    const accepted = await route.fetch();
    const receipt: unknown = await accepted.json();
    expect(receipt).toMatchObject({ outcome: "accepted", attemptStatus: "submitted" });
    if (
      !receipt ||
      typeof receipt !== "object" ||
      !("receiptId" in receipt) ||
      typeof receipt.receiptId !== "string"
    )
      throw new Error("Missing submission receipt");
    originalReceipt = receipt.receiptId;
    originalKey = event.idempotencyKey;
    await route.abort("failed");
  });
  await page.getByTestId("submit-attempt-button").click();
  await expectPendingLock(page);
  await expect(page.getByTestId("pending-event-count")).toHaveText("1");
  await page.getByTestId("retry-pending-button").click();
  await expect(page.getByTestId("submission-state")).toHaveText("confirmed");
  await expect(page.getByTestId("submission-receipt")).toHaveText(originalReceipt ?? "missing");
  expect(replayKey).toBe(originalKey);
  await expectOneFinalizedAnswerSet(page, await page.getByTestId("attempt-id").innerText());
  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
});

test("a shared network outage reconciles all candidates, explicit time adjustment and one final result each", async ({
  browser,
  request,
  playwright,
}, testInfo) => {
  test.setTimeout(60_000);
  const staff = await playwright.request.newContext();
  const contexts = await Promise.all(
    [0, 1, 2].map(() => browser.newContext({ baseURL: "http://127.0.0.1:4175" })),
  );
  try {
    const actorId = await signInOutageStaff(request, staff);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    // A fixed three-seat rehearsal, not a load or capacity test.
    for (const candidate of pages) {
      await signInAndOpen(candidate, await seedRecoveryExam(request));
      await finishTwoItemExam(candidate);
      await expect(candidate.getByTestId("response-save-status")).toContainText("Server confirmed");
    }
    const attemptIds = await Promise.all(
      pages.map((candidate) => candidate.getByTestId("attempt-id").innerText()),
    );
    // C's server accepts Finish, then its acknowledgement is lost before the shared cut.
    const recoveringAccepted = pages[2];
    if (!recoveringAccepted) throw new Error("Missing accepted candidate");
    let acceptedReceipt: string | null = null;
    await recoveringAccepted.route("**/api/attempts/*/events", async (route) => {
      const event: unknown = route.request().postDataJSON();
      if (
        !event ||
        typeof event !== "object" ||
        !("type" in event) ||
        event.type !== "submit.requested" ||
        acceptedReceipt
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const receipt: unknown = await response.json();
      if (
        !receipt ||
        typeof receipt !== "object" ||
        !("receiptId" in receipt) ||
        typeof receipt.receiptId !== "string"
      )
        throw new Error("Missing original receipt");
      acceptedReceipt = receipt.receiptId;
      await route.abort("failed");
    });
    await recoveringAccepted.getByTestId("submit-attempt-button").click();
    await expectPendingLock(recoveringAccepted);
    const before = await Promise.all(
      pages.map((candidate, i) => readTimingWitness(candidate.request, attemptIds[i]!)),
    );
    await Promise.all(contexts.map((context) => context.setOffline(true)));
    const [interrupted, finishing, reopening] = pages;
    if (!interrupted || !finishing || !reopening) throw new Error("Missing outage candidate");
    // Candidate A is interrupted before Finish; navigation cannot load another question.
    await interrupted.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(interrupted.getByTestId("pending-event-count")).toHaveText("1");
    await expect(interrupted.getByTestId("current-item-id")).toHaveText("item-2");
    await expect(
      interrupted.getByRole("heading", { name: "Connection interrupted" }),
    ).toBeVisible();
    // B finishes without a connection; C closes and tries to relaunch without one.
    await finishing.getByTestId("submit-attempt-button").click();
    await expectPendingLock(finishing);
    await expectPendingLock(reopening);
    const recoveryUrl = reopening.url();
    await expect(reopening.reload()).rejects.toThrow();
    const during = await Promise.all(
      pages.map((candidate, i) => readTimingWitness(candidate.request, attemptIds[i]!)),
    );
    expect(during).toEqual(before); // Full browser disconnection itself changed no server deadline.
    const actionId = `outage-${crypto.randomUUID()}`;
    const reason = "Shared network incident: authorized 60 seconds for interrupted candidate A";
    expect(
      (
        await interrupted.request.post(`${api}/api/instructor/attempts/${attemptIds[0]}/actions`, {
          data: {
            actionId,
            type: "extend-time",
            reason,
            effectiveAt: new Date().toISOString(),
            additionalTimeSeconds: 60,
          },
        })
      ).status(),
    ).toBe(403);
    const applied = await staff.post(`${api}/api/instructor/attempts/${attemptIds[0]}/actions`, {
      data: {
        actionId,
        type: "extend-time",
        reason,
        effectiveAt: new Date().toISOString(),
        additionalTimeSeconds: 60,
        actor: { role: "tenant-administrator", actorId: "forged" },
      },
    });
    expect(applied.status(), await applied.text()).toBe(200);
    const afterAdjustment = await Promise.all(
      pages.map((candidate, i) => readTimingWitness(candidate.request, attemptIds[i]!)),
    );
    expect(afterAdjustment[0]?.additionalTimeSeconds).toBe(60);
    expect(Date.parse(afterAdjustment[0]!.expiresAt) - Date.parse(before[0]!.expiresAt)).toBe(
      60_000,
    );
    expect(afterAdjustment.slice(1)).toEqual(before.slice(1));
    const timelineResponse = await staff.get(
      `${api}/api/instructor/attempts/${attemptIds[0]}/timeline`,
    );
    expect(timelineResponse.status()).toBe(200);
    const timeline: unknown = await timelineResponse.json();
    expect(timeline).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ actor: expect.objectContaining({ actorId }), reason }),
      ]),
    });
    expect(JSON.stringify(timeline)).not.toContain('"actorId":"forged"');
    await Promise.all(contexts.map((context) => context.setOffline(false)));
    await reopening.goto(recoveryUrl);
    await expect(interrupted.getByTestId("pending-event-count")).toHaveText("0");
    await expect(interrupted.getByTestId("submission-state")).toHaveText("none");
    await expect(interrupted.getByRole("textbox")).toHaveValue("Final answer to question two.");
    await interrupted.getByTestId("submit-attempt-button").click();
    const results: unknown[] = [];
    const receipts: string[] = [];
    for (const [i, candidate] of pages.entries()) {
      await expect(candidate.getByTestId("submission-state")).toHaveText("confirmed");
      await expect(candidate.getByTestId("pending-event-count")).toHaveText("0");
      receipts.push(await candidate.getByTestId("submission-receipt").innerText());
      results.push(await expectOneFinalizedAnswerSet(candidate, attemptIds[i]!));
    }
    expect(new Set(receipts).size).toBe(3);
    expect(receipts[2]).toBe(acceptedReceipt);
    await testInfo.attach("outage-reconciliation.json", {
      contentType: "application/json",
      body: JSON.stringify({
        seats: 3,
        before,
        during,
        afterAdjustment,
        receipts,
        results,
        actorId,
        actionId,
        reason,
      }),
    });
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await staff.dispose();
  }
});

test("overdue frozen work stays locked and preserved until an authenticated staff reopen authorizes replay", async ({
  page,
  request,
  playwright,
}, testInfo) => {
  const exam = await seedRecoveryExam(request, { timeLimitSeconds: 6, gracePeriodSeconds: 0 });
  await signInAndOpen(page, exam);
  await finishTwoItemExam(page);
  const attemptId = await page.getByTestId("attempt-id").innerText();
  const before = await readTimingWitness(page.request, attemptId);
  await page.context().setOffline(true);
  await page.getByTestId("submit-attempt-button").click();
  await expectPendingLock(page);
  await expect
    .poll(async () => (await readTimingWitness(page.request, attemptId)).status, {
      timeout: 10_000,
    })
    .toBe("expired_pending_recovery");
  await page.context().setOffline(false);
  await expect(page.getByTestId("submission-state")).toHaveText("review_required");
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  await expect(page.getByTestId("submit-attempt-button")).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Final work needs invigilator review" }),
  ).toBeVisible();
  expect(await readTimingWitness(page.request, attemptId)).toEqual({
    ...before,
    status: "expired_pending_recovery",
  });
  const staff = await playwright.request.newContext();
  try {
    const actorId = await signInOutageStaff(request, staff);
    const evidenceBefore = await staff.get(`${api}/api/instructor/attempts/${attemptId}/evidence`);
    expect(evidenceBefore.status()).toBe(200);
    const evidence: unknown = await evidenceBefore.json();
    expect(evidence).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ eventType: "response.changed", outcome: "late_preserved" }),
      ]),
    });
    const reason = "Verified outage; authorize the frozen final answer set after review";
    const actionId = `reopen-${crypto.randomUUID()}`;
    const approved = await staff.post(`${api}/api/instructor/attempts/${attemptId}/actions`, {
      data: {
        actionId,
        type: "reopen-attempt",
        reason,
        effectiveAt: new Date().toISOString(),
        reopenUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(approved.status(), await approved.text()).toBe(200);
    // No additional Finish and no re-capture: replay exactly the retained batch.
    await page.getByTestId("retry-pending-button").click();
    await expect(page.getByTestId("submission-state")).toHaveText("confirmed");
    await expect(page.getByTestId("pending-event-count")).toHaveText("0");
    const result = await expectOneFinalizedAnswerSet(page, attemptId);
    const timeline = await staff.get(`${api}/api/instructor/attempts/${attemptId}/timeline`);
    expect(await timeline.json()).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ actor: expect.objectContaining({ actorId }), reason }),
      ]),
    });
    await testInfo.attach("overdue-recovery.json", {
      contentType: "application/json",
      body: JSON.stringify({ before, actorId, actionId, reason, result }),
    });
  } finally {
    await staff.dispose();
  }
});

test("replays frozen work after an independent submission has already finalized during the outage", async ({
  page,
  request,
  playwright,
}) => {
  await signInAndOpen(page, await seedRecoveryExam(request));
  await finishTwoItemExam(page);
  await page
    .getByRole("textbox", { name: "What would you do next?", exact: true })
    .fill("Earlier accepted response");
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  const attemptId = await page.getByTestId("attempt-id").innerText();
  const captured: unknown[] = [];
  await page.route("**/api/attempts/*/events", async (route) => {
    captured.push(route.request().postDataJSON());
    await route.abort("failed");
  });
  await page
    .getByRole("textbox", { name: "What would you do next?", exact: true })
    .fill("Final answer to question two.");
  await page.getByTestId("submit-attempt-button").click();
  await expectPendingLock(page);
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  const finalResponse = captured.find(
    (event) =>
      event && typeof event === "object" && "type" in event && event.type === "response.changed",
  );
  if (!finalResponse || typeof finalResponse !== "object")
    throw new Error("Missing frozen response envelope");
  // A separate accepted auto-submit occupies the sequence reserved locally for the frozen response.
  // The Worker timing suite exercises the deadline dispatcher; here we exercise its client aftermath.
  const independentlySubmitted = await page.request.post(
    `${api}/api/attempts/${attemptId}/events`,
    {
      data: {
        ...finalResponse,
        eventId: `independent-${crypto.randomUUID()}`,
        idempotencyKey: `independent-${crypto.randomUUID()}`,
        type: "timing.auto-submit.requested",
        payload: { requestedAt: new Date().toISOString(), reason: "assignment-deadline-reached" },
      },
    },
  );
  expect(independentlySubmitted.status()).toBe(200);
  expect(await independentlySubmitted.json()).toMatchObject({
    outcome: "accepted",
    attemptStatus: "submitted",
  });
  const priorResult = await readOneFinalizedAttempt(page, attemptId);
  expect(priorResult).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({
        itemId: "item-2",
        responseSummary: expect.stringContaining("Earlier accepted response"),
      }),
    ]),
  });
  await page.unroute("**/api/attempts/*/events");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("submission-state")).toHaveText("review_required");
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  await page.reload();
  await expect(page.getByTestId("submission-state")).toHaveText("review_required");
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  const staff = await playwright.request.newContext();
  try {
    await signInOutageStaff(request, staff);
    const reopened = await staff.post(`${api}/api/instructor/attempts/${attemptId}/actions`, {
      data: {
        actionId: `reopen-${crypto.randomUUID()}`,
        type: "reopen-attempt",
        effectiveAt: new Date().toISOString(),
        reopenUntil: new Date(Date.now() + 60_000).toISOString(),
        reason: "Authorize retained final answers after independent deadline submission",
      },
    });
    expect(reopened.status()).toBe(200);
    await page.getByTestId("retry-pending-button").click();
    await expect(page.getByTestId("submission-state")).toHaveText("confirmed");
    await expect(page.getByTestId("pending-event-count")).toHaveText("0");
    await expectOneFinalizedAnswerSet(page, attemptId);
  } finally {
    await staff.dispose();
  }
});
