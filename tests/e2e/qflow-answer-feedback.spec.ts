import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import axe from "axe-core";
import { expect, test } from "@playwright/test";

const packagePath = process.env.QFLOW_FEEDBACK_TEST_PACKAGE;
const origin = "http://127.0.0.1:8787";

for (const [width, answer] of [
  [1280, "Alpha"],
  [390, "Beta"],
] as const) {
  test(`releases exact QFlow feedback and accessible media for ${answer} at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    test.skip(!packagePath, "Requires the exact QFlow feedback browser-export artifact.");
    if (!packagePath) throw new Error("Feedback artifact was not configured.");
    const bytes = readFileSync(packagePath);
    const receipt: unknown = JSON.parse(readFileSync(`${packagePath}.json`, "utf8"));
    if (
      !receipt ||
      typeof receipt !== "object" ||
      !("sha256" in receipt) ||
      typeof receipt.sha256 !== "string" ||
      !("questionCount" in receipt) ||
      receipt.questionCount !== 1 ||
      !("maximumScore" in receipt) ||
      receipt.maximumScore !== 0
    )
      throw new Error("Feedback artifact receipt is invalid.");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.sha256);
    const seed = `qflow-feedback-${width}-${Date.now()}`;
    const published = await request.post(`${origin}/internal/publish?assessmentSlug=${seed}`, {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "qflow-feedback.zip",
        "x-harbor-tenant-id": seed,
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
      throw new Error("Feedback publication identity is missing.");
    const errors: string[] = [],
      externalRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.name));
    page.on("request", (request) => {
      if (/youtube\.com|youtu\.be|vimeo\.com/.test(new URL(request.url()).hostname))
        externalRequests.push(request.url());
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?mode=preview&assessmentVersionId=${version.assessmentVersionId}`);
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 1");
    const attemptId = await page.getByTestId("attempt-id").textContent();
    if (!attemptId) throw new Error("Feedback attempt identity is missing.");
    const endpoint = `${origin}/api/attempts/${encodeURIComponent(attemptId)}/feedback`;
    expect(await (await request.get(endpoint)).json()).toEqual({ status: "withheld", items: [] });
    await expect(page.getByText("Correct explanation <literal>.", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Incorrect explanation: review the lesson.", { exact: true }),
    ).toHaveCount(0);
    const manifest = await request.get(
      `${origin}/api/content/manifest?attemptId=${encodeURIComponent(attemptId)}`,
    );
    const manifestText = await manifest.text();
    expect(manifestText).not.toContain("explanation");
    expect(manifestText).not.toContain("feedbackAssetIds");
    await page.getByRole("radio", { name: new RegExp(answer) }).check();
    await page.getByTestId("submit-attempt-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("delivery-state")).toHaveText("submitted");
    await expect
      .poll(async () => (await (await request.get(endpoint)).json()).status, { timeout: 15000 })
      .toBe("released");
    await page.getByRole("button", { name: "View results", exact: true }).click();
    let failed = false;
    await page.route("**/api/attempts/*/feedback", async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"unavailable"}',
        });
      } else await route.continue();
    });
    const load = page.getByRole("button", { name: "View answer feedback", exact: true });
    await load.click();
    await expect(page.getByRole("alert")).toHaveText("Answer feedback is unavailable. Try again.");
    await load.focus();
    await page.keyboard.press("Enter");
    const feedback = page.getByRole("region", { name: "Answer feedback", exact: true });
    const selected =
      answer === "Alpha"
        ? "Correct explanation <literal>."
        : "Incorrect explanation: review the lesson.";
    const hidden =
      answer === "Alpha"
        ? "Incorrect explanation: review the lesson."
        : "Correct explanation <literal>.";
    await expect(feedback.getByText(selected, { exact: true })).toBeVisible();
    await expect(feedback.getByText(hidden, { exact: true })).toHaveCount(0);
    await expect(
      feedback.getByRole("heading", { name: "Feedback question", exact: true }),
    ).toBeVisible();
    if (answer === "Alpha") {
      const image = feedback.getByRole("img", { name: "A blue answer diagram", exact: true });
      await expect
        .poll(() =>
          image.evaluate(
            (node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth === 64,
          ),
        )
        .toBe(true);
      await expect(
        feedback.getByRole("link", { name: "Read the lesson", exact: true }),
      ).toHaveAttribute("href", "https://example.org/lesson?a=1&b=2");
      await expect(
        feedback.getByText("Accessible answer description.", { exact: false }),
      ).toBeVisible();
    } else {
      const video = feedback.locator('video[aria-label="Video explanation"]');
      await expect(video).toBeVisible();
      expect(
        await video.evaluate((node) =>
          node instanceof HTMLVideoElement
            ? [node.autoplay, node.controls, node.textTracks.length]
            : [],
        ),
      ).toEqual([false, true, 1]);
      await video.evaluate((node) => {
        if (!(node instanceof HTMLVideoElement)) throw new Error("Video missing");
        node.load();
        node.textTracks[0].mode = "showing";
      });
      await expect
        .poll(() =>
          video.evaluate((node) => (node instanceof HTMLVideoElement ? node.readyState : 0)),
        )
        .toBe(4);
      await expect
        .poll(() =>
          video.evaluate((node) =>
            node instanceof HTMLVideoElement ? node.textTracks[0].cues?.length : 0,
          ),
        )
        .toBe(1);
      await expect(
        feedback.getByText("Accessible video transcript.", { exact: false }),
      ).toBeVisible();
    }
    await page.addScriptTag({ content: axe.source });
    expect(
      await page.evaluate(
        'globalThis.axe.run("[aria-label=\\"Answer feedback\\"]").then(result => result.violations.map(violation => violation.id))',
      ),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(externalRequests).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`answer-feedback-${width}.png`),
      fullPage: true,
    });
  });
}
