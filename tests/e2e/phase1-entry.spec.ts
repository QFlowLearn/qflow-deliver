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

test("preview launch enters the Harbor shell and fetches manifest and item content incrementally", async ({
  page,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase1-entry-preview-${testInfo.parallelIndex}-${Date.now()}`,
  );
  const requestedUrls: string[] = [];

  page.on("request", (value) => {
    requestedUrls.push(value.url());
  });

  await page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

  await expect(page.getByTestId("harbor-shell")).toBeVisible();
  await expect(page.getByTestId("assessment-version-id")).toHaveText(published.assessmentVersionId);

  await expect
    .poll(() => requestedUrls.some((url) => url.includes("/api/content/manifest?attemptId=")))
    .toBe(true);
  await expect
    .poll(() => requestedUrls.some((url) => url.includes("/api/content/items/item-1?attemptId=")))
    .toBe(true);
  expect(requestedUrls.some((url) => url.includes("/package/") || url.endsWith(".zip"))).toBe(
    false,
  );
});

test("access-code launch enters the same Harbor shell without a hardcoded detached code", async ({
  page,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase1-entry-access-${testInfo.parallelIndex}-${Date.now()}`,
  );

  const accessCodeResponse = await request.post(`${workerOrigin}/internal/access-codes`, {
    data: {
      assessmentVersionId: published.assessmentVersionId,
    },
  });
  expect(accessCodeResponse.status()).toBe(201);

  const accessCodeBody = (await accessCodeResponse.json()) as {
    accessCode: string;
  };

  const requestedUrls: string[] = [];
  page.on("request", (value) => {
    requestedUrls.push(value.url());
  });

  await page.goto(`/?mode=access-code&accessCode=${accessCodeBody.accessCode}`);

  await expect(page.getByTestId("harbor-shell")).toBeVisible();
  await expect(page.getByTestId("harbor-shell")).toHaveAttribute("data-launch-mode", "access-code");

  await expect
    .poll(() => requestedUrls.some((url) => url.includes("/api/content/manifest?attemptId=")))
    .toBe(true);
  await expect
    .poll(() => requestedUrls.some((url) => url.includes("/api/content/items/item-1?attemptId=")))
    .toBe(true);
  expect(requestedUrls.some((url) => url.includes("/package/") || url.endsWith(".zip"))).toBe(
    false,
  );
});
