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

async function launchPreviewAttempt(input: {
  page: Parameters<typeof test>[0]["page"];
  request: Parameters<typeof test>[0]["request"];
  seed: string;
}): Promise<void> {
  const published = await publishFixture(input.request, input.seed);

  await input.page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

  await expect(input.page.getByTestId("attempt-id")).toHaveCount(1);
}

test("confirms cheap durable submit and surfaces authoritative submitted state", async ({
  page,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase2-submit-${testInfo.parallelIndex}-${Date.now()}`,
  });

  await page.getByTestId("submit-attempt-button").click();

  await expect(page.getByTestId("delivery-state")).toHaveText("submitted");
  await expect(page.getByTestId("submit-status")).toContainText("durably submitted");
  await expect(page.getByTestId("save-response-button")).toBeDisabled();
});

test("restores submitted state after refresh without reopening mutable editing", async ({
  page,
  request,
}, testInfo) => {
  await launchPreviewAttempt({
    page,
    request,
    seed: `phase2-submit-refresh-${testInfo.parallelIndex}-${Date.now()}`,
  });

  const attemptId = await page.getByTestId("attempt-id").textContent();
  expect(attemptId).toBeTruthy();

  await page.getByTestId("submit-attempt-button").click();
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted");

  await page.reload();

  await expect(page.getByTestId("attempt-id")).toHaveText(attemptId ?? "");
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted");
  await expect(page.getByTestId("submit-status")).toContainText("durably submitted");
  await expect(page.getByTestId("save-response-button")).toBeDisabled();
});
