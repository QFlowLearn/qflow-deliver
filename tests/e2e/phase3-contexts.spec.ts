import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { expect, test } from "@playwright/test";
import type { DeliveryPolicySnapshot } from "@harbor/attempt-protocol";

const workerOrigin = "http://127.0.0.1:8787";
const shellOrigin = "http://127.0.0.1:4173";
const sebConfigKeyHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
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

function updatePublishedDeliveryPolicy(input: {
  assessmentVersionId: string;
  deliveryPolicy: DeliveryPolicySnapshot;
}): void {
  const sql = [
    "UPDATE assessment_versions",
    `SET delivery_policy_snapshot = ${toSqlLiteral(JSON.stringify(input.deliveryPolicy))}`,
    `WHERE id = ${toSqlLiteral(input.assessmentVersionId)};`,
  ].join(" ");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      execFileSync(
        "pnpm",
        [
          "--dir",
          "workers/runtime",
          "exec",
          "cf",
          "d1",
          "raw",
          "00000000-0000-4000-8000-000000000001",
          "--local",
          "--persist-to",
          ".wrangler/state",
          "--sql",
          sql,
        ],
        {
          cwd: process.cwd(),
          stdio: "pipe",
        },
      );
      return;
    } catch (error) {
      if (attempt < 4 && error instanceof Error && error.message.includes("SQLITE_BUSY")) {
        sleepMs(250);
        continue;
      }

      throw error;
    }
  }
}

async function postPolicyCommand(input: {
  request: Parameters<typeof test>[0]["request"];
  attemptId: string;
  body: unknown;
}): Promise<void> {
  const response = await input.request.post(
    `${workerOrigin}/internal/attempts/${input.attemptId}/policy`,
    {
      headers: {
        "content-type": "application/json",
      },
      data: input.body,
    },
  );

  expect(response.status()).toBe(200);
}

async function loadPreviewInIframe(input: {
  page: Parameters<typeof test>[0]["page"];
  assessmentVersionId: string;
}) {
  await input.page.goto("/");
  await input.page.setContent(
    `
      <main style="margin:0;padding:24px;background:#f5efe5;">
        <iframe
          data-testid="harbor-embed"
          title="Harbor Embedded Preview"
          src="/?mode=preview&assessmentVersionId=${encodeURIComponent(input.assessmentVersionId)}&previewActorId=embedded_preview&previewActorDisplayName=Embedded%20Preview"
          style="width:100%;min-height:1400px;border:0;"
        ></iframe>
      </main>
    `,
  );

  return input.page.frameLocator('[data-testid="harbor-embed"]');
}

function toSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sleepMs(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function createSafeExamBrowserConfigKeyRequestHash(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.hash = "";
  return createHash("sha256").update(`${url.toString()}${sebConfigKeyHash}`).digest("hex");
}

test("allows approved iframe delivery while keeping assets, operator messaging, and accommodations visible", async ({
  page,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase3-context-iframe-${testInfo.parallelIndex}-${Date.now()}`,
  );
  updatePublishedDeliveryPolicy({
    assessmentVersionId: published.assessmentVersionId,
    deliveryPolicy: {
      launchMode: "preview",
      navigationMode: "linear",
      maxAttempts: 1,
      timeLimitSeconds: 1800,
      gracePeriodSeconds: 300,
      standaloneAllowed: true,
      iframeAllowed: true,
      allowedEmbedOrigins: [shellOrigin],
      secureBrowserRequired: false,
      secureBrowserProviderHint: null,
    },
  });

  const requestedUrls: string[] = [];
  page.on("request", (value) => {
    requestedUrls.push(value.url());
  });

  const frame = await loadPreviewInIframe({
    page,
    assessmentVersionId: published.assessmentVersionId,
  });

  await expect(frame.getByTestId("attempt-id")).toHaveCount(1);
  await expect(frame.getByTestId("delivery-context-status")).toContainText("iframe");
  await expect(frame.locator("img[alt='Decorative Harbor stimulus']")).toBeVisible();
  await expect
    .poll(() =>
      requestedUrls.some(
        (url) => url.includes("/api/content/assets/") && url.includes("contextMode=iframe"),
      ),
    )
    .toBe(true);

  const attemptId = await frame.getByTestId("attempt-id").textContent();
  expect(attemptId).toBeTruthy();

  const now = new Date().toISOString();
  const commandNonce = `${testInfo.parallelIndex}-${Date.now()}-${attemptId}`;
  await postPolicyCommand({
    request,
    attemptId: attemptId ?? "",
    body: {
      commandId: `cmd_iframe_message_${commandNonce}`,
      type: "post-operator-message",
      actor: {
        role: "operator",
        actorId: "operator_01",
        displayName: "Operations Lead",
      },
      reason: "Iframe message confirmation",
      issuedAt: now,
      effectiveAt: now,
      message: {
        level: "warning",
        title: "Iframe delivery active",
        body: "Policy and accommodations remain visible inside the embedded shell.",
        effectiveUntil: null,
      },
    },
  });
  await postPolicyCommand({
    request,
    attemptId: attemptId ?? "",
    body: {
      commandId: `cmd_iframe_accommodation_${commandNonce}`,
      type: "set-accommodations",
      actor: {
        role: "operator",
        actorId: "operator_01",
        displayName: "Operations Lead",
      },
      reason: "Iframe accommodation confirmation",
      issuedAt: now,
      effectiveAt: now,
      accommodations: {
        rendererPnp: {
          layoutSingleColumn: true,
          glossaryOnScreen: false,
        },
        sessionControl: {
          allow_review: false,
          allow_skipping: false,
        },
      },
    },
  });

  await frame.getByTestId("nav-link-details").focus();
  await expect(frame.getByTestId("nav-link-details")).toBeFocused();
  await frame.getByTestId("nav-link-details").click();
  await frame.getByTestId("refresh-policy-button").focus();
  await expect(frame.getByTestId("refresh-policy-button")).toBeFocused();
  await frame.getByTestId("refresh-policy-button").click();

  await expect(frame.getByTestId("operator-message-banner")).toContainText(
    "Iframe delivery active",
  );
  await expect(frame.getByTestId("renderer-accommodation-status")).toContainText(
    "single-column on",
  );
  await expect(frame.getByTestId("renderer-accommodation-status")).toContainText("review locked");
});

test("blocks disallowed iframe delivery with server-backed messaging before bootstrap completes", async ({
  page,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase3-context-blocked-${testInfo.parallelIndex}-${Date.now()}`,
  );
  updatePublishedDeliveryPolicy({
    assessmentVersionId: published.assessmentVersionId,
    deliveryPolicy: {
      launchMode: "preview",
      navigationMode: "linear",
      maxAttempts: 1,
      timeLimitSeconds: 1800,
      gracePeriodSeconds: 300,
      standaloneAllowed: true,
      iframeAllowed: true,
      allowedEmbedOrigins: ["https://allowed.example"],
      secureBrowserRequired: false,
      secureBrowserProviderHint: null,
    },
  });

  const frame = await loadPreviewInIframe({
    page,
    assessmentVersionId: published.assessmentVersionId,
  });

  await expect(frame.getByTestId("delivery-context-blocked")).toContainText("Launch blocked");
  await expect(frame.getByTestId("delivery-context-blocked")).toContainText(
    "embedded origin is not allowed",
  );
  await expect(frame.getByTestId("delivery-context-status")).toContainText("iframe");
  await expect(frame.getByTestId("attempt-id")).toHaveCount(0);
});

test("allows secure-browser-required delivery and completes a short submit flow", async ({
  browser,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase3-context-secure-${testInfo.parallelIndex}-${Date.now()}`,
  );
  updatePublishedDeliveryPolicy({
    assessmentVersionId: published.assessmentVersionId,
    deliveryPolicy: {
      launchMode: "preview",
      navigationMode: "linear",
      maxAttempts: 1,
      timeLimitSeconds: 1800,
      gracePeriodSeconds: 300,
      standaloneAllowed: true,
      iframeAllowed: false,
      allowedEmbedOrigins: [],
      secureBrowserRequired: true,
      secureBrowserProviderHint: "safe-exam-browser",
      safeExamBrowser: {
        verificationMode: "config-key",
        configKeyHash: sebConfigKeyHash,
        browserExamKeys: [],
      },
    },
  });

  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith(`${shellOrigin}/api/`)) {
      const workerUrl = requestUrl.replace(shellOrigin, workerOrigin);
      await route.continue({
        headers: {
          ...route.request().headers(),
          "x-safeexambrowser-configkeyhash": createSafeExamBrowserConfigKeyRequestHash(workerUrl),
        },
      });
      return;
    }

    await route.continue();
  });
  const page = await context.newPage();

  try {
    await page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

    await expect(page.getByTestId("attempt-id")).toHaveCount(1);
    await expect(page.getByTestId("delivery-context-status")).toContainText(
      "secure browser verified",
    );
    await expect(page.locator("img[alt='Decorative Harbor stimulus']")).toBeVisible();
    await expect(page.getByTestId("save-response-button")).toBeEnabled();

    await page.getByTestId("save-response-button").click();
    await page.getByTestId("submit-attempt-button").click();

    await expect(page.getByTestId("delivery-state")).toHaveText("submitted");
    await expect(page.getByTestId("submit-status")).toContainText("durably submitted");
  } finally {
    await context.close();
  }
});
