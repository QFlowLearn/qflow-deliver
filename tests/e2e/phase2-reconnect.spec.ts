import { readFileSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { expect, test } from "@playwright/test";

const workerOrigin = "http://127.0.0.1:8787";
const fixtureRoot = path.resolve(process.cwd(), "tests/fixtures/qti/basic-assessment");

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
}

test("replays unacknowledged work after connectivity returns without dropping durable coverage", async ({
  page,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase2-replay-${testInfo.parallelIndex}-${Date.now()}`,
  });

  await page.route("**/api/attempts/**", async (route) => {
    await route.abort();
  });

  await page.getByTestId("save-response-button").click();

  await expect(page.getByTestId("pending-event-count")).toHaveText("1");
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("1");
  await expect(page.getByTestId("replay-status")).toContainText(
    "saved update(s) will sync when the connection is available",
  );

  await page.unroute("**/api/attempts/**");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });

  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("2");
  await expect(page.getByTestId("next-sequence-number")).toHaveText("3");
  await expect(page.getByTestId("replay-status")).toContainText(
    "Durable receipts now cover sequence 2.",
  );

  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });

  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("2");
});

test("keeps queued work across a hard refresh on the same tab and resumes the same attempt shell state", async ({
  page,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase2-refresh-${testInfo.parallelIndex}-${Date.now()}`,
  });

  const initialAttemptId = await page.getByTestId("attempt-id").textContent();
  expect(initialAttemptId).toBeTruthy();

  await page.route("**/api/attempts/**", async (route) => {
    await route.abort();
  });

  await page.getByTestId("save-response-button").click();
  await expect(page.getByTestId("pending-event-count")).toHaveText("1");

  await page.reload();

  await expect(page.getByTestId("attempt-id")).toHaveText(initialAttemptId ?? "");
  await expect(page.getByTestId("current-item-id")).toHaveText("item-1");
  await expect(page.getByTestId("pending-event-count")).toHaveText("1");
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("1");

  await page.unroute("**/api/attempts/**");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });

  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(page.getByTestId("highest-committed-sequence")).toHaveText("2");
  await expect(page.getByTestId("next-sequence-number")).toHaveText("3");
});

test("reconciles duplicate or stale tabs back to authoritative attempt state", async ({
  page,
  context,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase2-stale-tab-${testInfo.parallelIndex}-${Date.now()}`,
  );
  const issued = await issueAccessCode({
    request,
    assessmentVersionId: published.assessmentVersionId,
    code: `RESUME-${testInfo.parallelIndex}-${Date.now()}`,
  });
  const accessCodeUrl = `/?mode=access-code&accessCode=${issued.accessCode}&candidateId=candidate_resume_01&candidateName=Resume%20Candidate`;

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
          actor: { role: "operator", actorId: "reconnect-test" },
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

async function openSession(page: import("@playwright/test").Page, url: string): Promise<void> {
  // Wait for completed question recovery. A reopened session can reuse its
  // durable presentation receipt without sending another presentation event.
  await page.goto(url);
  await expect(page.getByTestId("save-response-button")).toBeEnabled();
  await expect(page.getByTestId("highest-committed-sequence")).not.toHaveText("0");
}
