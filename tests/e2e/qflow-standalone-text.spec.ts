import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import axe from "axe-core";
import { expect, test } from "@playwright/test";

const packagePath = process.env.QFLOW_CONTENT_TEST_PACKAGE;
const origin = "http://127.0.0.1:8787";

for (const width of [1280, 390]) {
  test(`delivers the exact QFlow-authored text package without inflating counts or scores at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    test.skip(!packagePath, "Requires the explicit QFlow browser-export handoff artifact.");
    if (!packagePath) throw new Error("QFlow handoff artifact was not configured.");
    const bytes = readFileSync(packagePath);
    const receipt: unknown = JSON.parse(readFileSync(`${packagePath}.json`, "utf8"));
    if (
      !receipt ||
      typeof receipt !== "object" ||
      !("sha256" in receipt) ||
      typeof receipt.sha256 !== "string" ||
      !("text" in receipt) ||
      typeof receipt.text !== "string"
    )
      throw new Error("QFlow handoff receipt is invalid.");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.sha256);
    const seed = `qflow-text-${width}-${testInfo.parallelIndex}-${Date.now()}`;
    const published = await request.post(`${origin}/internal/publish?assessmentSlug=${seed}`, {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "qflow-text.zip",
        "x-harbor-tenant-id": `tenant_${seed}`,
      },
      data: bytes,
    });
    expect(published.status(), await published.text()).toBe(201);
    const version: unknown = await published.json();
    if (
      !version ||
      typeof version !== "object" ||
      !("assessmentVersionId" in version) ||
      typeof version.assessmentVersionId !== "string"
    )
      throw new Error("QFlow text publication has no version identity.");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.name));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?mode=preview&assessmentVersionId=${version.assessmentVersionId}`);
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");
    await expect(page.getByTestId("assessment-instructions-before")).toHaveCount(0);
    await page.getByRole("radio", { name: /Paris/ }).check();
    await page.getByTestId("next-item-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
    const instructions = page.getByTestId("assessment-instructions-before");
    await expect.poll(() => instructions.locator("p").innerText()).toBe(receipt.text);
    expect(await instructions.locator("script").count()).toBe(0);
    expect(
      await page.evaluate(() => {
        const before = document.querySelector('[data-testid="assessment-instructions-before"]');
        const frame = document.querySelector(".renderer-tool-frame");
        if (!before || !frame) throw new Error("Content reading order is missing.");
        return Boolean(before.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    ).toBe(true);
    const attemptId = await page.getByTestId("attempt-id").textContent();
    if (!attemptId) throw new Error("QFlow text launch has no attempt identity.");
    const response = await request.get(
      `${origin}/api/content/manifest?attemptId=${encodeURIComponent(attemptId)}`,
    );
    expect(response.status()).toBe(200);
    const manifest: unknown = await response.json();
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("itemOrder" in manifest) ||
      !Array.isArray(manifest.itemOrder) ||
      !("items" in manifest) ||
      !manifest.items ||
      typeof manifest.items !== "object"
    )
      throw new Error("QFlow text launch has no question inventory.");
    expect(manifest.itemOrder).toHaveLength(2);
    const questions = Object.values(manifest.items);
    expect(questions).toHaveLength(2);
    await page.reload();
    await expect(page.getByTestId("attempt-id")).toHaveText(attemptId);
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
    await expect.poll(() => instructions.locator("p").innerText()).toBe(receipt.text);
    await page.addScriptTag({ content: axe.source });
    const audit: unknown = await page.evaluate(
      'globalThis.axe.run(".assessment-instructions").then(result => result.violations.map(violation => violation.id))',
    );
    expect(audit).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`qflow-text-${width}.png`), fullPage: true });
    await page.getByRole("radio", { name: /Paris/ }).check();
    await page.getByTestId("submit-attempt-button").click();
    await expect(page.getByTestId("delivery-state")).toHaveText("submitted");
    await page.getByRole("button", { name: "View results" }).click();
    // Submission is durable before asynchronous finalization. The history page
    // deliberately exposes Refresh rather than polling results automatically.
    await expect
      .poll(
        async () => {
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
          return page.getByTestId("latest-submitted-score").textContent();
        },
        { timeout: 15000 },
      )
      .toBe("2 / 2");
    expect(errors).toEqual([]);
  });
}
