import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { expect, test } from "@playwright/test";

const workerOrigin = "http://127.0.0.1:8787";
const fixtureRoot = path.resolve(process.cwd(), "tests/fixtures/qti/presidents-sampler-demo");

function appendFixtureDirectory(zip: JSZip, root: string, currentDirectory: string): void {
  for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
    const absolutePath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      appendFixtureDirectory(zip, root, absolutePath);
      continue;
    }

    const relativePath = path.relative(root, absolutePath).replaceAll("\\", "/");
    zip.file(relativePath, readFileSync(absolutePath));
  }
}

async function createFixturePackage(): Promise<Buffer> {
  const zip = new JSZip();
  appendFixtureDirectory(zip, fixtureRoot, fixtureRoot);
  return zip.generateAsync({ type: "nodebuffer" });
}

const correctAnswers = [
  "George Washington",
  "Thomas Jefferson",
  "Abraham Lincoln",
  "Theodore Roosevelt",
  "Franklin D. Roosevelt",
  "John F. Kennedy",
  "Lyndon B. Johnson",
  "Richard Nixon",
  "Gerald Ford",
  "Ronald Reagan",
  "Barack Obama",
  "William Howard Taft",
];

test("Presidents sampler demo finalizes to the full assessment score total", async ({
  page,
  request,
}, testInfo) => {
  const seed = `presidents-score-${testInfo.parallelIndex}-${Date.now()}`;
  const publishResponse = await request.post(
    `${workerOrigin}/internal/publish?assessmentSlug=${seed}`,
    {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "presidents-sampler-demo.zip",
        "x-harbor-tenant-id": `tenant_${seed}`,
      },
      data: await createFixturePackage(),
    },
  );
  expect(publishResponse.status()).toBe(201);

  const published = (await publishResponse.json()) as {
    assessmentVersionId: string;
  };

  await page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

  await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 12");
  await expect(page.getByTestId("attempt-id")).not.toHaveText("");

  for (let itemIndex = 1; itemIndex < 12; itemIndex += 1) {
    await page.getByTestId("next-item-button").click();
    await expect(page.getByTestId("current-item-position")).toHaveText(
      `Question ${itemIndex + 1} of 12`,
    );
  }

  await page.getByTestId("submit-attempt-button").click();
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted");
  await page.getByRole("button", { name: "View results" }).click();

  await expect(page).toHaveURL(/\/history(\?|$)/);
  await expect(page.getByTestId("history-attempt-list")).toBeVisible();
  await expect(page.getByTestId("latest-submitted-score")).toHaveText("0 / 12", {
    timeout: 15_000,
  });
});

test("Presidents sampler demo scores known-correct responses across the full assessment", async ({
  page,
  request,
}, testInfo) => {
  const seed = `presidents-score-correct-${testInfo.parallelIndex}-${Date.now()}`;
  const publishResponse = await request.post(
    `${workerOrigin}/internal/publish?assessmentSlug=${seed}`,
    {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "presidents-sampler-demo.zip",
        "x-harbor-tenant-id": `tenant_${seed}`,
      },
      data: await createFixturePackage(),
    },
  );
  expect(publishResponse.status()).toBe(201);

  const published = (await publishResponse.json()) as {
    assessmentVersionId: string;
  };

  await page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

  await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 12");
  await expect(page.getByTestId("attempt-id")).not.toHaveText("");

  for (let itemIndex = 0; itemIndex < correctAnswers.length; itemIndex += 1) {
    await page.getByText(correctAnswers[itemIndex]!, { exact: true }).click();

    if (itemIndex < correctAnswers.length - 1) {
      await page.getByTestId("next-item-button").click();
      await expect(page.getByTestId("current-item-position")).toHaveText(
        `Question ${itemIndex + 2} of 12`,
      );
    }
  }

  await page.getByTestId("submit-attempt-button").click();
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted");
  await page.getByRole("button", { name: "View results" }).click();

  await expect(page).toHaveURL(/\/history(\?|$)/);
  await expect(page.getByTestId("history-attempt-list")).toBeVisible();
  await expect(page.getByTestId("latest-submitted-score")).toHaveText("12 / 12", {
    timeout: 15_000,
  });
});
