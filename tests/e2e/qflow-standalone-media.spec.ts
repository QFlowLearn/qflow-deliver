import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import axe from "axe-core";
import { expect, test } from "@playwright/test";

const packagePath = process.env.QFLOW_MEDIA_TEST_PACKAGE;
const origin = "http://127.0.0.1:8787";

for (const width of [1280, 390]) {
  test(`delivers the exact QFlow image/video package with captions and two scored questions at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    test.skip(!packagePath, "Requires the exact QFlow media browser-export artifact.");
    if (!packagePath) throw new Error("QFlow media artifact was not configured.");
    const bytes = readFileSync(packagePath);
    const receipt: unknown = JSON.parse(readFileSync(`${packagePath}.json`, "utf8"));
    if (
      !receipt ||
      typeof receipt !== "object" ||
      !("sha256" in receipt) ||
      typeof receipt.sha256 !== "string" ||
      !("questionCount" in receipt) ||
      receipt.questionCount !== 2 ||
      !("maximumScore" in receipt) ||
      receipt.maximumScore !== 2 ||
      !("contents" in receipt) ||
      !Array.isArray(receipt.contents) ||
      receipt.contents.length !== 3
    )
      throw new Error("QFlow media receipt is invalid.");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.sha256);
    const seed = `qflow-media-${width}-${testInfo.parallelIndex}-${Date.now()}`;
    const published = await request.post(`${origin}/internal/publish?assessmentSlug=${seed}`, {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "qflow-media.zip",
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
      throw new Error("QFlow media publication has no version identity.");
    const errors: string[] = [],
      externalRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.name));
    page.on("request", (request) => {
      if (/youtube\.com|youtu\.be|vimeo\.com/.test(new URL(request.url()).hostname))
        externalRequests.push(request.url());
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?mode=preview&assessmentVersionId=${version.assessmentVersionId}`);
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");
    await expect(page.getByTestId("assessment-instructions-before")).toHaveCount(0);
    await page.getByRole("radio", { name: /Paris/ }).check();
    await page.getByTestId("next-item-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
    const instructions = page.getByTestId("assessment-instructions-before");
    const image = instructions.getByRole("img", { name: "A blue rectangle", exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate(
          (element) =>
            element instanceof HTMLImageElement && element.complete && element.naturalWidth === 64,
        ),
      )
      .toBe(true);
    await expect(
      instructions.getByText("Literal <script> description.", { exact: false }),
    ).toBeVisible();
    expect(await instructions.locator("script, iframe").count()).toBe(0);
    const video = instructions.locator('video[aria-label="A moving blue rectangle"]');
    await expect(video).toBeVisible();
    expect(
      await video.evaluate((element) =>
        element instanceof HTMLVideoElement
          ? [element.autoplay, element.controls, element.textTracks.length]
          : [],
      ),
    ).toEqual([false, true, 1]);
    await video.evaluate((element) => {
      if (!(element instanceof HTMLVideoElement)) throw new Error("Video missing.");
      element.load();
      element.textTracks[0].mode = "showing";
    });
    await expect
      .poll(() =>
        video.evaluate((element) => (element instanceof HTMLVideoElement ? element.readyState : 0)),
      )
      .toBe(4);
    await expect
      .poll(() =>
        video.evaluate((element) =>
          element instanceof HTMLVideoElement ? element.textTracks[0].cues?.length : 0,
        ),
      )
      .toBe(1);
    expect(await video.locator("track").getAttribute("srclang")).toBe("en-US");
    await expect(
      instructions.getByText("The transcript remains readable without playback.", { exact: false }),
    ).toBeVisible();
    const online = instructions.getByRole("link", {
      name: "Online rectangle demonstration",
      exact: true,
    });
    await expect(online).toHaveAttribute("href", "https://youtu.be/example");
    await online.focus();
    await expect(online).toBeFocused();
    await expect(
      instructions.getByText("Internet access is required", { exact: false }),
    ).toBeVisible();
    await expect(
      instructions.getByText("Equivalent instructions: consider the blue rectangle.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(externalRequests).toEqual([]);
    const attemptId = await page.getByTestId("attempt-id").textContent();
    if (!attemptId) throw new Error("Media launch has no attempt identity.");
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
      throw new Error("Media launch has no real question inventory.");
    expect(manifest.itemOrder).toHaveLength(2);
    expect(Object.values(manifest.items)).toHaveLength(2);
    await page.reload();
    await expect(page.getByTestId("attempt-id")).toHaveText(attemptId);
    await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
    await expect(image).toBeVisible();
    await expect(video).toBeVisible();
    await expect(online).toBeVisible();
    await page.addScriptTag({ content: axe.source });
    const audit: unknown = await page.evaluate(
      'globalThis.axe.run(".assessment-instructions").then(result => result.violations.map(violation => violation.id))',
    );
    expect(audit).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`qflow-media-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("radio", { name: /Paris/ }).check();
    await page.getByTestId("submit-attempt-button").click();
    await expect(page.getByTestId("delivery-state")).toHaveText("submitted");
    await page.getByRole("button", { name: "View results" }).click();
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
