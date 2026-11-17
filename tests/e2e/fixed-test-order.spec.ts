import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ids, xml, createFixedOrderPackage } from "../fixtures/qti/fixed-order-fixture";

const origin = "http://127.0.0.1:8787";
for (const width of [1280, 390]) {
  test(`keeps shuffled questions and fixed slots through navigation and reload at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const seed = `fixed-order-${width}-${testInfo.parallelIndex}-${Date.now()}`;
    const published = await request.post(`${origin}/internal/publish?assessmentSlug=${seed}`, {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "fixed-order.zip",
        "x-harbor-tenant-id": `tenant_${seed}`,
      },
      data: Buffer.from(
        await createFixedOrderPackage(
          readFileSync("tests/fixtures/qti/basic-assessment/items/item-1.xml", "utf8"),
          readFileSync("tests/fixtures/qti/basic-assessment/assets/stimulus.svg", "utf8"),
          xml,
        ),
      ),
    });
    expect(published.status(), await published.text()).toBe(201);
    const version: unknown = await published.json();
    if (
      !version ||
      typeof version !== "object" ||
      !("assessmentVersionId" in version) ||
      typeof version.assessmentVersionId !== "string"
    )
      throw new Error("Published version is invalid");
    await page.goto(`/?mode=preview&assessmentVersionId=${version.assessmentVersionId}`);
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 9");
    const attemptId = await page.getByTestId("attempt-id").textContent();
    if (!attemptId) throw new Error("Attempt identity is missing");
    const response = await request.get(
      `${origin}/api/content/manifest?attemptId=${encodeURIComponent(attemptId)}`,
    );
    expect(response.status()).toBe(200);
    const manifest: unknown = await response.json();
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("itemOrder" in manifest) ||
      !Array.isArray(manifest.itemOrder)
    )
      throw new Error("Learner order is missing");
    const order: string[] = [];
    for (const id of manifest.itemOrder) {
      if (typeof id !== "string") throw new Error("Learner item ID is invalid");
      order.push(id);
    }
    expect(order[1]).toBe("B");
    expect(order.slice(4, 6)).toEqual(["E", "F"]);
    expect(new Set(order)).toEqual(new Set(ids));
    for (let index = 0; index < order.length; index++) {
      const id = order[index];
      if (!id) throw new Error("Expected question missing");
      await expect(page.getByTestId("current-item-id")).toHaveText(id);
      await expect(page.locator(".qti3-item-prompt")).toHaveText(`Question ${id}`);
      await expect(page.getByTestId("current-item-position")).toHaveText(
        `Question ${index + 1} of 9`,
      );
      if (index === 1) {
        await page.reload();
        await expect(page.getByTestId("attempt-id")).toHaveText(attemptId);
        await expect(page.getByTestId("current-item-id")).toHaveText(id);
        await expect(page.locator(".qti3-item-prompt")).toHaveText(`Question ${id}`);
      }
      if (index < order.length - 1) await page.getByTestId("next-item-button").click();
    }
    await expect(page.getByTestId("next-item-button")).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath(`fixed-order-${width}.png`),
      fullPage: true,
    });
  });
}
