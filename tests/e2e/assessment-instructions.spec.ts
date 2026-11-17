import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:8787";

for (const width of [1280, 390]) {
  test(`retains scoped candidate instructions and their image through navigation and reload at ${width}px`, async ({
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
      readFileSync("tests/fixtures/qti/part-settings/scoped-instructions.xml", "utf8"),
    );
    source.file(
      "assets/map.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#185b83"/></svg>',
    );
    const seed = `instructions-${width}-${testInfo.parallelIndex}-${Date.now()}`;
    const published = await request.post(`${origin}/internal/publish?assessmentSlug=${seed}`, {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "scoped-instructions.zip",
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
      throw new Error("Published instruction fixture has no version identity");

    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?mode=preview&assessmentVersionId=${version.assessmentVersionId}`);
    const instructions = page.getByRole("region", { name: "Assessment instructions" });
    await expect(instructions.getByText("Answer both questions.", { exact: true })).toBeVisible();
    await expect(
      instructions.getByText("Read every question before submitting.", { exact: true }),
    ).toBeVisible();
    await expect(
      instructions.getByText("Use the map for the first question.", { exact: true }),
    ).toBeVisible();
    await expect(instructions.getByText("Explain the second answer.")).toHaveCount(0);
    await expect(page.getByText("Private scorer key.")).toHaveCount(0);
    const image = instructions.getByRole("img", { name: "Reference map" });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
      )
      .toBe(true);
    await expect(image).toHaveAttribute("src", /\/api\/content\/assets\/.+attemptId=/);
    await page.screenshot({
      path: testInfo.outputPath(`instructions-first-${width}.png`),
      fullPage: true,
    });

    const attemptId = await page.getByTestId("attempt-id").textContent();
    if (!attemptId) throw new Error("Instruction fixture has no attempt identity");
    await page.getByRole("radio", { name: /Paris/ }).check();
    await page.getByTestId("save-response-button").click();
    const next = page.getByTestId("next-item-button");
    await expect(next).toBeEnabled();
    await next.focus();
    await expect(next).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
    await expect(instructions.getByText("Use the map for the first question.")).toHaveCount(0);
    await expect(
      instructions.getByText("Explain the second answer.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("attempt-id")).toHaveText(attemptId);
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
    await expect(instructions.getByText("Answer both questions.", { exact: true })).toBeVisible();
    await expect(
      instructions.getByText("Read every question before submitting.", { exact: true }),
    ).toBeVisible();
    await expect(
      instructions.getByText("Explain the second answer.", { exact: true }),
    ).toBeVisible();
    await expect(instructions.getByText("Use the map for the first question.")).toHaveCount(0);
    await expect(page.getByText("Private scorer key.")).toHaveCount(0);
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`instructions-second-${width}.png`),
      fullPage: true,
    });
  });
}
