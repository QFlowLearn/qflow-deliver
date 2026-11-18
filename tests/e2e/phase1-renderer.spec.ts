import { readFileSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";

const workerOrigin = "http://127.0.0.1:8787";
const fixtureRoot = path.resolve(process.cwd(), "tests/fixtures/qti/basic-assessment");

async function createFixturePackage(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", readFileSync(path.join(fixtureRoot, "imsmanifest.xml"), "utf8"));
  zip.file(
    "items/item-1.xml",
    readFileSync(path.join(fixtureRoot, "items/item-1.xml"), "utf8").replace(
      "  <qti-item-body>",
      `  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"/>
  <qti-stylesheet href="styles/item.css" type="text/css"/>
  <qti-item-body>`,
    ),
  );
  zip.file(
    "assets/stimulus.svg",
    readFileSync(path.join(fixtureRoot, "assets/stimulus.svg"), "utf8"),
  );
  zip.file(
    "items/styles/item.css",
    readFileSync(path.join(fixtureRoot, "assets/item.css"), "utf8"),
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

async function publishFixture(
  request: APIRequestContext,
  seed: string,
): Promise<{ assessmentVersionId: string }> {
  const response = await request.post(`${workerOrigin}/internal/publish?assessmentSlug=${seed}`, {
    headers: {
      "content-type": "application/zip",
      "x-harbor-package-name": "basic-assessment.zip",
      "x-harbor-tenant-id": `tenant_${seed}`,
    },
    data: await createFixturePackage(),
  });
  expect(response.status()).toBe(201);

  return response.json() as Promise<{ assessmentVersionId: string }>;
}

test("Harbor renders the first published item through the retained QTI adapter and worker-gated assets", async ({
  page,
  request,
}, testInfo) => {
  const seed = `phase1-renderer-${testInfo.parallelIndex}-${Date.now()}`;
  const published = await publishFixture(request, seed);

  const requestedUrls: string[] = [];
  page.on("request", (value) => {
    requestedUrls.push(value.url());
  });

  await page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

  await expect(page.getByText("What is 2 + 2?")).toBeVisible();
  await expect(page.locator(".qti3-item-prompt")).toHaveCSS("font-weight", "700");
  await expect(page.locator(".qti3-item-prompt")).toHaveCSS("letter-spacing", "1px");
  await expect(page.locator("img[alt='Decorative Harbor stimulus']")).toBeVisible();
  await expect
    .poll(() => requestedUrls.some((url) => url.includes("/api/content/assets/")))
    .toBe(true);
  expect(requestedUrls.some((url) => url.includes("/package/") || url.endsWith(".zip"))).toBe(
    false,
  );
});

test("persists one resumable renderer checkpoint and restores it after reload", async ({
  page,
  request,
}, testInfo) => {
  const itemStateWriteCountKey = "harbor.e2e.itemStateWriteCount";
  await page.addInitScript((storageKey) => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
    if (!descriptor || typeof descriptor.value !== "function")
      throw new Error("IndexedDB put is unavailable");
    // SAFETY: this native descriptor is callable and is invoked below with its actual object-store receiver.
    const originalPut = descriptor.value as IDBObjectStore["put"];
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      configurable: true,
      writable: true,
      value(this: IDBObjectStore, record: unknown, key?: IDBValidKey) {
        if (this.name === "item-states") {
          const currentCount = Number.parseInt(
            window.sessionStorage.getItem(storageKey) ?? "0",
            10,
          );
          window.sessionStorage.setItem(storageKey, String(currentCount + 1));
        }

        return key === undefined
          ? originalPut.call(this, record)
          : originalPut.call(this, record, key);
      },
    });
  }, itemStateWriteCountKey);

  const published = await publishFixture(
    request,
    `phase1-item-state-recovery-${testInfo.parallelIndex}-${Date.now()}`,
  );
  await page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);
  const initialAttemptId = await page.getByTestId("attempt-id").textContent();
  expect(initialAttemptId).toBeTruthy();
  const answer = page.getByRole("radio", { name: "B. 4" });
  await expect(answer).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        return Number.parseInt(window.sessionStorage.getItem(storageKey) ?? "0", 10);
      }, itemStateWriteCountKey),
    )
    .toBeGreaterThanOrEqual(1);
  await page.evaluate(
    (storageKey) => window.sessionStorage.setItem(storageKey, "0"),
    itemStateWriteCountKey,
  );

  await answer.click();
  await page.getByTestId("save-response-button").click();
  await expect(page.getByTestId("replay-status")).toContainText(
    "Durable receipts now cover sequence",
  );
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        return Number.parseInt(window.sessionStorage.getItem(storageKey) ?? "0", 10);
      }, itemStateWriteCountKey),
    )
    .toBe(1);

  await page.reload();

  await expect(page.getByTestId("attempt-id")).toHaveText(initialAttemptId ?? "");
  await expect(answer).toBeChecked();
});

test("reports a rejected UI task through the browser error channel", async ({ page }) => {
  await page.goto("/");
  const reported = page.waitForEvent("pageerror");
  await page.evaluate(async () => {
    const moduleUrl = "/src/lib/ui-errors.ts";
    const uiModule: unknown = await import(moduleUrl);
    if (
      !uiModule ||
      typeof uiModule !== "object" ||
      !("reportUiError" in uiModule) ||
      typeof uiModule.reportUiError !== "function"
    )
      throw new Error("UI error reporter is unavailable");
    await Promise.reject(new Error("Unexpected UI task failure")).catch((error: unknown) => {
      uiModule.reportUiError(error);
    });
  });
  expect((await reported).message).toBe("Unexpected UI task failure");
});
