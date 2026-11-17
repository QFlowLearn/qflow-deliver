import { expect, test } from "@playwright/test";
import { seedRecoveryExam, signInAndOpen } from "./lab-recovery-fixture";
import {
  deferred,
  eventsUrl,
  expectAcceptedCheckpoint,
  expectRecovered,
  preparePendingAnswer,
} from "./lab-cached-reload-fixture";

test("cached reload recovers pending answers and its question after content loading failed during the outage", async ({
  page,
  request,
}) => {
  await signInAndOpen(page, await seedRecoveryExam(request));
  await preparePendingAnswer(page);
  await page.route("**/api/content/**", (route) => route.abort("failed"));
  await page.reload();
  await expect(page.getByTestId("pending-event-count")).toHaveText("1");
  await expect(page.getByRole("alert").filter({ hasText: "Failed to fetch" })).toBeVisible();
  await page.unroute("**/api/content/**");
  await page.unroute(eventsUrl);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectRecovered(page);
  await expectAcceptedCheckpoint(page);
});

for (const contentPath of ["**/api/content/manifest?*", "**/api/content/items/*?*"]) {
  test(`manual retry restores a failed cached question with an already-drained journal: ${contentPath}`, async ({
    page,
    request,
  }) => {
    await signInAndOpen(page, await seedRecoveryExam(request));
    await preparePendingAnswer(page);
    await page.unroute(eventsUrl);
    await page.route(contentPath, (route) => route.abort("failed"));
    await page.reload();
    await expect(page.getByTestId("pending-event-count")).toHaveText("0");
    await expect(page.getByRole("alert").filter({ hasText: "Failed to fetch" })).toBeVisible();
    await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
    await expect(page.getByTestId("retry-pending-button")).toBeVisible();
    await page.unroute(contentPath);
    await page.getByTestId("retry-pending-button").click();
    await expectRecovered(page);
    await expectAcceptedCheckpoint(page);
  });
}

test("a reconnect cancels a stalled content load and its late success cannot replace the latest recovery failure", async ({
  page,
  request,
}) => {
  await signInAndOpen(page, await seedRecoveryExam(request));
  await preparePendingAnswer(page);
  await page.unroute(eventsUrl);
  const held = deferred<void>();
  const release = deferred<void>();
  const released = deferred<void>();
  let first = true;
  let serviceUnavailable = true;
  await page.route("**/api/content/manifest?*", async (route) => {
    if (first) {
      first = false;
      const response = await route.fetch();
      held.resolve();
      await release.promise;
      await route.fulfill({ response });
      released.resolve();
      return;
    }
    if (serviceUnavailable) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Latest connection is still unavailable" }),
      });
      return;
    }
    await route.continue();
  });
  try {
    await page.reload();
    await held.promise;
    await expect(page.getByTestId("pending-event-count")).toHaveText("0");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const currentError = page
      .getByRole("alert")
      .filter({ hasText: "Latest connection is still unavailable" });
    await expect(currentError).toBeVisible();
    release.resolve();
    await released.promise;
    await expect(currentError).toBeVisible();
    serviceUnavailable = false;
    await page.getByTestId("retry-pending-button").click();
    await expectRecovered(page);
    await expectAcceptedCheckpoint(page);
    const newest = "An edit made after the cached session recovered.";
    await page.getByRole("textbox", { name: "Explain your reasoning.", exact: true }).fill(newest);
    await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
    await expectAcceptedCheckpoint(page, newest);
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Explain your reasoning.", exact: true }),
    ).toHaveValue(newest);
  } finally {
    release.resolve();
  }
});
