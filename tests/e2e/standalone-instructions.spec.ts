import { readFileSync } from "node:fs";
import JSZip from "jszip";
import axe from "axe-core";
import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:8787";

for (const width of [1280, 390]) {
  test(`delivers standalone text before, between and after two real questions at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const source = await JSZip.loadAsync(
      Buffer.from(
        readFileSync("tests/fixtures/qti/part-settings/qflow-part-settings.zip.b64", "utf8"),
        "base64",
      ),
    );
    source.file(
      "assessment.xml",
      readFileSync("tests/fixtures/qti/part-settings/ordered-text.xml", "utf8"),
    );
    source.file(
      "assets/map.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"><rect width="32" height="18" fill="#185b83"/></svg>',
    );
    const seed = `standalone-${width}-${testInfo.parallelIndex}-${Date.now()}`;
    const published = await request.post(`${origin}/internal/publish?assessmentSlug=${seed}`, {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "ordered-text.zip",
        "x-harbor-tenant-id": `tenant_${seed}`,
      },
      data: await source.generateAsync({ type: "nodebuffer" }),
    });
    expect(published.status(), await published.text()).toBe(201);
    const version: unknown = await published.json();
    if (
      !version ||
      typeof version !== "object" ||
      !("assessmentVersionId" in version) ||
      typeof version.assessmentVersionId !== "string"
    )
      throw new Error("Standalone publication has no version identity.");
    const errors: string[] = [],
      dialogs: string[] = [];
    page.on("pageerror", (error) => errors.push(error.name));
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.dismiss();
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?mode=preview&assessmentVersionId=${version.assessmentVersionId}`);
    const before = page.getByTestId("assessment-instructions-before");
    const after = page.getByTestId("assessment-instructions-after");
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");
    await expect(before.getByText("Read before starting.", { exact: true })).toBeVisible();
    await expect(
      before.getByText("Use both questions to practise.", { exact: true }),
    ).toBeVisible();
    await expect(before.locator("p")).toHaveText([
      "Read before starting.",
      "Use both questions to practise.",
    ]);
    await expect(after).toHaveCount(0);
    const attemptId = await page.getByTestId("attempt-id").textContent();
    if (!attemptId) throw new Error("Standalone launch has no durable attempt identity.");
    const manifestResponse = await request.get(
      `${origin}/api/content/manifest?attemptId=${encodeURIComponent(attemptId)}`,
    );
    expect(manifestResponse.status()).toBe(200);
    const manifest: unknown = await manifestResponse.json();
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("itemOrder" in manifest) ||
      !Array.isArray(manifest.itemOrder) ||
      !("items" in manifest) ||
      !manifest.items ||
      typeof manifest.items !== "object"
    )
      throw new Error("Standalone launch has no real question inventory.");
    expect(manifest.itemOrder).toHaveLength(2);
    expect(Object.keys(manifest.items)).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain("Private scorer key.");
    await page.getByRole("radio", { name: /Paris/ }).check();
    const next = page.getByTestId("next-item-button");
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
    expect(
      await page.evaluate(() => {
        const before = document.querySelector('[data-testid="assessment-instructions-before"]');
        const frame = document.querySelector(".renderer-tool-frame");
        const after = document.querySelector('[data-testid="assessment-instructions-after"]');
        if (!before || !frame || !after) throw new Error("Reading-order regions are missing.");
        return [
          Boolean(before.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING),
          Boolean(frame.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING),
        ];
      }),
    ).toEqual([true, true]);
    await expect(before.getByText(/Read <script> literally/)).toBeVisible();
    await expect(before.getByText(/Consider α & β before the second question/)).toBeVisible();
    await expect(after.locator("p")).toHaveText([
      "Check your responses before finishing.",
      "Submit when you are ready.",
    ]);
    await expect(before.getByText("Read before starting.")).toHaveCount(0);
    await expect(page.getByText("Private scorer key.")).toHaveCount(0);
    expect(await before.locator("script").count()).toBe(0);
    const image = before.getByRole("img", { name: "Reference map" });
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth),
      )
      .toBe(32);
    await expect(image).toHaveAttribute("src", /\/api\/content\/assets\/.+attemptId=/);
    await page.reload();
    await expect(page.getByTestId("attempt-id")).toHaveText(attemptId);
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
    await expect(before.getByText(/Read <script> literally/)).toBeVisible();
    await expect(after.getByText("Submit when you are ready.", { exact: true })).toBeVisible();
    const previous = page.getByTestId("previous-item-button");
    await previous.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");
    await expect(before.getByText("Read before starting.", { exact: true })).toBeVisible();
    await expect(after).toHaveCount(0);
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.addScriptTag({ content: axe.source });
    const audit: unknown = await page.evaluate(
      'globalThis.axe.run(".assessment-instructions").then(result => result.violations.map(violation => ({id: violation.id, nodes: violation.nodes.map(node => node.failureSummary)})))',
    );
    expect(audit).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`standalone-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
    expect(dialogs).toEqual([]);
  });
}
