import { expect, test } from "@playwright/test";
import { seedRecoveryExam, signInAndOpen } from "./lab-recovery-fixture";

test("autosaves real choice and essay edits without Save and restores them after reload", async ({
  page,
  request,
}) => {
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  await page.getByRole("radio", { name: "B. Blue", exact: true }).check();
  await page.getByRole("button", { name: "Move Act up", exact: true }).click();
  await page.getByRole("textbox").fill("An answer that must survive a workstation failure.");
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed", {
    timeout: 6000,
  });
  await expect(page.getByTestId("last-confirmed-save")).not.toHaveText("");
  await page.reload();
  await expect(page.getByRole("radio", { name: "B. Blue", exact: true })).toBeChecked();
  await expect(page.getByRole("listitem").nth(1)).toContainText("Act");
  await expect(page.getByRole("textbox")).toHaveValue(
    "An answer that must survive a workstation failure.",
  );
});

test("checkpoints during two minutes of uninterrupted typing within the declared healthy-network budget", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(160_000);
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  const receipts: number[] = [];
  const captures: number[] = [];
  const receiptReads: Promise<void>[] = [];
  page.on("response", (response) => {
    if (!response.url().endsWith("/events") || response.request().method() !== "POST") return;
    const event: unknown = response.request().postDataJSON();
    if (
      !event ||
      typeof event !== "object" ||
      !("type" in event) ||
      event.type !== "response.changed" ||
      !("payload" in event) ||
      !event.payload ||
      typeof event.payload !== "object" ||
      !("responseState" in event.payload) ||
      !event.payload.responseState ||
      typeof event.payload.responseState !== "object" ||
      !("capturedAt" in event.payload.responseState) ||
      typeof event.payload.responseState.capturedAt !== "string"
    )
      return;
    const capturedAt = Date.parse(event.payload.responseState.capturedAt);
    receiptReads.push(
      response.json().then((body: unknown) => {
        if (
          !body ||
          typeof body !== "object" ||
          !("outcome" in body) ||
          body.outcome !== "accepted" ||
          !("serverTimestamp" in body) ||
          typeof body.serverTimestamp !== "string"
        )
          throw new Error("Continuous-typing checkpoint was not accepted");
        captures.push(capturedAt);
        receipts.push(Date.parse(body.serverTimestamp));
      }),
    );
  });
  const started = Date.now();
  await page.getByRole("textbox").pressSequentially("abcdef".repeat(100), { delay: 205 });
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed", {
    timeout: 6000,
  });
  const ended = Date.now();
  await Promise.all(receiptReads);
  const captureTimes = [started, ...captures, ended];
  const receiptTimes = [started, ...receipts, ended];
  const maxCaptureGapMs = Math.max(...captureTimes.slice(1).map((at, i) => at - captureTimes[i]));
  const maxReceiptGapMs = Math.max(...receiptTimes.slice(1).map((at, i) => at - receiptTimes[i]));
  const maxReceiptLatencyMs = Math.max(...receipts.map((at, i) => at - captures[i]));
  await testInfo.attach("autosave-measurements.json", {
    body: JSON.stringify({
      typingDurationMs: ended - started,
      acceptedCheckpoints: receipts.length,
      maxCaptureGapMs,
      maxReceiptGapMs,
      maxReceiptLatencyMs,
    }),
    contentType: "application/json",
  });
  expect(ended - started).toBeGreaterThanOrEqual(120_000);
  expect(receipts.length).toBeGreaterThan(20);
  expect(maxCaptureGapMs).toBeLessThanOrEqual(5000);
  expect(maxReceiptGapMs).toBeLessThanOrEqual(6000);
  expect(maxReceiptLatencyMs).toBeLessThanOrEqual(1000);
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue("abcdef".repeat(100));
});

test("offline autosave stays local until replay obtains a server receipt", async ({
  page,
  request,
  context,
}) => {
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  await context.setOffline(true);
  await page.getByRole("textbox").fill("A locally retained essay awaiting confirmation.");
  await expect(page.getByTestId("response-save-status")).toHaveText(
    "Saved locally; server confirmation pending",
    { timeout: 6000 },
  );
  await expect(page.getByTestId("last-confirmed-save")).toHaveText("");
  await expect(page.getByTestId("pending-event-count")).not.toHaveText("0");
  await context.setOffline(false);
  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue(
    "A locally retained essay awaiting confirmation.",
  );
});

test("a newer journaled draft survives reload and replays over the older accepted answer", async ({
  page,
  request,
}) => {
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  await page.getByRole("textbox").fill("The older accepted answer.");
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  await page.route("**/api/attempts/**/events", (route) => route.abort());
  await page.getByRole("textbox").fill("The newer local draft.");
  await expect(page.getByTestId("response-save-status")).toHaveText(
    "Saved locally; server confirmation pending",
  );
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue("The newer local draft.");
  await expect(page.getByTestId("pending-event-count")).not.toHaveText("0");
  await page.unroute("**/api/attempts/**/events");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue("The newer local draft.");
});

test("a lost autosave acknowledgement replays the original durable receipt", async ({
  page,
  request,
}) => {
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  let receiptId: string | null = null;
  let interrupted = false;
  await page.route("**/api/attempts/**/events", async (route) => {
    const event: unknown = route.request().postDataJSON();
    if (
      interrupted ||
      !event ||
      typeof event !== "object" ||
      !("type" in event) ||
      event.type !== "response.changed"
    ) {
      await route.continue();
      return;
    }
    interrupted = true;
    const accepted = await route.fetch();
    const body: unknown = await accepted.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("receiptId" in body) ||
      typeof body.receiptId !== "string"
    )
      throw new Error("Autosave was not accepted before the dropped acknowledgement");
    receiptId = body.receiptId;
    await route.abort();
  });
  await page.getByRole("textbox").fill("Accepted before its acknowledgement was lost.");
  await expect(page.getByTestId("response-save-status")).toHaveText(
    "Saved locally; server confirmation pending",
  );
  const replay = page.waitForResponse(
    (response) =>
      response.url().endsWith("/events") &&
      response.request().postData()?.includes('"response.changed"') === true,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  expect(await (await replay).json()).toMatchObject({
    outcome: "duplicate",
    storedReceipt: { receiptId },
  });
  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue(
    "Accepted before its acknowledgement was lost.",
  );
});

test("a failed initial presentation and the first autosave reserve different durable sequence numbers", async ({
  page,
  request,
}) => {
  const exam = await seedRecoveryExam(request);
  await page.route("**/api/attempts/**/events", (route) => route.abort());
  await signInAndOpen(page, exam);
  await page.getByRole("textbox").fill("The first essay survives a disconnected startup.");
  await expect(page.getByTestId("pending-event-count")).toHaveText("2");
  await page.unroute("**/api/attempts/**/events");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue(
    "The first essay survives a disconnected startup.",
  );
});

test("successive offline autosaves reserve a distinct sequence and replay every draft through the same receipts", async ({
  page,
  request,
}) => {
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("1");
  await page.route("**/api/attempts/**/events", (route) => route.abort());
  for (const [index, text] of [
    "First offline draft",
    "Second offline draft",
    "Final offline draft",
  ].entries()) {
    await page.getByRole("textbox").fill(text);
    await expect(page.getByTestId("pending-event-count")).toHaveText(String(index + 1));
  }
  await page.unroute("**/api/attempts/**/events");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("4");
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue("Final offline draft");
});

test("replaying an older receipt cannot label a newer unconfirmed edit as saved", async ({
  page,
  request,
}) => {
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("1");
  await page.route("**/api/attempts/**/events", (route) => route.abort());
  await page.getByRole("textbox").fill("The journaled offline draft.");
  await expect(page.getByTestId("pending-event-count")).toHaveText("1");
  await page.unroute("**/api/attempts/**/events");
  const replayReached = deferred<string>();
  const releaseReplay = deferred<void>();
  const releaseLatest = deferred<void>();
  let firstResponse = true;
  await page.route("**/api/attempts/**/events", async (route) => {
    const event: unknown = route.request().postDataJSON();
    if (
      !event ||
      typeof event !== "object" ||
      !("type" in event) ||
      event.type !== "response.changed"
    ) {
      await route.continue();
      return;
    }
    if (firstResponse) {
      firstResponse = false;
      const accepted = await route.fetch();
      const body: unknown = await accepted.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("serverTimestamp" in body) ||
        typeof body.serverTimestamp !== "string"
      )
        throw new Error("Replay was not accepted");
      replayReached.resolve(body.serverTimestamp);
      await releaseReplay.promise;
      await route.fulfill({ response: accepted });
    } else {
      await releaseLatest.promise;
      await route.continue();
    }
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const firstTimestamp = await replayReached.promise;
    await page.getByRole("textbox").fill("A newer edit with no server receipt yet.");
    releaseReplay.resolve();
    await expect(page.getByTestId("last-confirmed-save")).toHaveText(firstTimestamp);
    await expect(page.getByTestId("response-save-status")).not.toContainText("Server confirmed");
    releaseLatest.resolve();
    await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
    await page.reload();
    await expect(page.getByRole("textbox")).toHaveValue("A newer edit with no server receipt yet.");
  } finally {
    releaseReplay.resolve();
    releaseLatest.resolve();
  }
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  // SAFETY: the Promise executor assigns resolve synchronously before this helper returns.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
