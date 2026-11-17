import { expect, test } from "@playwright/test";
import { seedRecoveryExam, signInAndOpen } from "./lab-recovery-fixture";
import {
  deferred,
  expectAcceptedCheckpoint,
  readReceipts,
  eventsUrl,
  expectRecovered,
  pendingEssay,
  preparePendingAnswer,
} from "./lab-cached-reload-fixture";

for (const { initialSend, trigger } of [
  { initialSend: "aborted", trigger: "online" },
  { initialSend: "accepted-before-ack", trigger: "online" },
  { initialSend: "aborted", trigger: "manual" },
] as const) {
  test(`cached reload drains pending work when online arrives during a bootstrap replay that is ${initialSend} (${trigger})`, async ({
    page,
    request,
  }, testInfo) => {
    await signInAndOpen(page, await seedRecoveryExam(request));
    await preparePendingAnswer(page);
    await page.unroute(eventsUrl);
    const reached = deferred<void>();
    const release = deferred<void>();
    const sent: { eventId: string; idempotencyKey: string; sequenceNumber: number }[] = [];
    let first = true;
    let originalReceipt: string | null = null;
    let presentationSends = 0;
    await page.route(eventsUrl, async (route) => {
      const event: unknown = route.request().postDataJSON();
      if (event && typeof event === "object" && "type" in event && event.type === "item.presented")
        presentationSends++;
      if (
        !event ||
        typeof event !== "object" ||
        !("type" in event) ||
        event.type !== "response.changed"
      ) {
        await route.continue();
        return;
      }
      if (
        !("eventId" in event) ||
        typeof event.eventId !== "string" ||
        !("idempotencyKey" in event) ||
        typeof event.idempotencyKey !== "string" ||
        !("sequenceNumber" in event) ||
        typeof event.sequenceNumber !== "number"
      )
        throw new Error("Invalid response event identity");
      sent.push({
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        sequenceNumber: event.sequenceNumber,
      });
      if (!first) {
        await route.continue();
        return;
      }
      first = false;
      if (initialSend === "accepted-before-ack") {
        const response = await route.fetch();
        const body: unknown = await response.json();
        expect(body).toMatchObject({ outcome: "accepted" });
        if (
          !body ||
          typeof body !== "object" ||
          !("receiptId" in body) ||
          typeof body.receiptId !== "string"
        )
          throw new Error("Missing initial receipt");
        originalReceipt = body.receiptId;
      }
      reached.resolve();
      await release.promise;
      await route.abort("failed");
    });
    try {
      await page.reload();
      await reached.promise;
      await expect(page.getByTestId("pending-event-count")).toHaveText("1");
      // The browser can emit online while the bootstrap request still owns the transport.
      if (trigger === "manual") {
        await page.getByTestId("retry-pending-button").click();
      } else {
        await page.evaluate(() => {
          for (let index = 0; index < 20; index++) window.dispatchEvent(new Event("online"));
        });
      }
      // Reconnection must not wait for the request left on the dead connection.
      await expectRecovered(page);
      expect(presentationSends).toBe(0);
      release.resolve();
      expect(sent).toHaveLength(2);
      const receipts = await readReceipts(page);
      if (initialSend === "accepted-before-ack")
        expect(receipts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              eventId: sent[0]?.eventId,
              outcome: "duplicate",
              receiptId: originalReceipt,
            }),
          ]),
        );
      await expectAcceptedCheckpoint(page);
      expect(new Set(sent.map((event) => event.eventId)).size).toBe(1);
      expect(new Set(sent.map((event) => event.idempotencyKey)).size).toBe(1);
      await page.reload();
      await expect(
        page.getByRole("textbox", { name: "Explain your reasoning.", exact: true }),
      ).toHaveValue(pendingEssay);
      await expect(page.getByTestId("save-response-button")).toBeEnabled();
      expect(presentationSends).toBe(0);
      await testInfo.attach("cached-reload-replay.json", {
        contentType: "application/json",
        body: JSON.stringify({
          initialSend,
          trigger,
          sent,
          originalReceipt,
          receipts,
          presentationSends,
        }),
      });
    } finally {
      release.resolve();
    }
  });
}
