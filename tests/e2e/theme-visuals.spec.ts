import { readFileSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { expect, test } from "@playwright/test";
import { HARBOR_QTI3_COLOR_THEMES } from "@harbor/attempt-protocol";

const workerOrigin = "http://127.0.0.1:8787";
const fixtureRoot = path.resolve(process.cwd(), "tests/fixtures/qti/basic-assessment");

async function createPackage(): Promise<Buffer> {
  const zip = new JSZip();
  for (const file of [
    "imsmanifest.xml",
    "items/item-1.xml",
    "assets/stimulus.svg",
    "assets/item.css",
  ]) {
    zip.file(file, readFileSync(path.join(fixtureRoot, file)));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

async function launch(input: {
  page: Parameters<typeof test>[0]["page"];
  request: Parameters<typeof test>[0]["request"];
  seed: string;
}): Promise<string> {
  const publish = await input.request.post(
    `${workerOrigin}/internal/publish?assessmentSlug=${input.seed}`,
    {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "theme-assessment.zip",
        "x-harbor-tenant-id": `tenant_${input.seed}`,
      },
      data: await createPackage(),
    },
  );
  expect(publish.status()).toBe(201);
  const { assessmentVersionId } = await publish.json<{ assessmentVersionId: string }>();
  await input.page.goto(`/?mode=preview&assessmentVersionId=${assessmentVersionId}`);
  return (await input.page.getByTestId("attempt-id").textContent()) ?? "";
}

async function setTheme(input: {
  page: Parameters<typeof test>[0]["page"];
  request: Parameters<typeof test>[0]["request"];
  attemptId: string;
  theme: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const response = await input.request.post(
    `${workerOrigin}/internal/attempts/${input.attemptId}/policy`,
    {
      data: {
        commandId: `cmd_theme_${input.theme}_${Date.now()}`,
        type: "set-accommodations",
        actor: { role: "operator", actorId: "theme-test", displayName: "Theme test" },
        reason: "Theme visual verification",
        issuedAt: now,
        effectiveAt: now,
        accommodations: {
          rendererPnp: { textAppearance: { colorStyle: input.theme } },
          sessionControl: {},
          shellTools: {},
        },
      },
    },
  );
  expect(response.status()).toBe(200);
  await input.page.getByTestId("nav-link-details").click();
  await input.page.getByTestId("refresh-policy-button").click();
  await input.page.getByTestId("nav-link-session").click();
  await expect(input.page.locator(".session-page")).toHaveClass(new RegExp(input.theme));
}

for (const theme of HARBOR_QTI3_COLOR_THEMES) {
  test(`${theme} applies accessible colors to all learner-facing states`, async ({
    page,
    request,
  }, testInfo) => {
    const attemptId = await launch({
      page,
      request,
      seed: `theme-${testInfo.parallelIndex}-${theme}-${Date.now()}`,
    });
    await setTheme({ page, request, attemptId, theme });

    const choiceInputs = page.locator(".qti3-choice-option input");
    await expect(choiceInputs).toHaveCount(3);
    await choiceInputs.nth(0).click();
    await page.keyboard.press("ArrowDown");
    await expect(choiceInputs.nth(1)).toBeFocused();
    await page.locator(".renderer-canvas").evaluate((canvas) => {
      const feedback = document.createElement("p");
      feedback.className = "qti3-feedback theme-test-feedback";
      feedback.textContent = "Feedback state";
      canvas.append(feedback);
    });

    const colors = await page.locator(".session-page").evaluate((shell) => {
      const player = document.querySelector("qti-assessment-item-player");
      const choice = document.querySelector(".qti3-choice-option");
      const selectedChoice = document.querySelector('.qti3-choice-option[data-selected="true"]');
      const focusedInput = document.activeElement;
      const focusedChoice = focusedInput?.closest(".qti3-choice-option");
      const control = document.querySelector<HTMLElement>(".assessment-item-panel button");
      const feedback = document.querySelector<HTMLElement>(".theme-test-feedback");
      const shellStyle = getComputedStyle(shell);
      const playerStyle = player ? getComputedStyle(player) : null;
      const choiceStyle = choice ? getComputedStyle(choice) : null;
      const selectedStyle = selectedChoice ? getComputedStyle(selectedChoice) : null;
      const focusStyle = focusedInput ? getComputedStyle(focusedInput) : null;
      const focusedChoiceStyle = focusedChoice ? getComputedStyle(focusedChoice) : null;
      const controlStyle = control ? getComputedStyle(control) : null;
      const feedbackStyle = feedback ? getComputedStyle(feedback) : null;
      return {
        shellForeground: shellStyle.color,
        shellBackground: shellStyle.backgroundColor,
        playerForeground: playerStyle?.color,
        playerBackground: playerStyle?.backgroundColor,
        choiceForeground: choiceStyle?.color ?? "",
        choiceBackground: choiceStyle?.backgroundColor ?? "",
        selectedForeground: selectedStyle?.color ?? "",
        selectedBackground: selectedStyle?.backgroundColor ?? "",
        focusColor: focusStyle?.outlineColor ?? "",
        focusStyle: focusStyle?.outlineStyle ?? "none",
        focusWidth: focusStyle?.outlineWidth ?? "0px",
        focusedChoiceBackground: focusedChoiceStyle?.backgroundColor ?? "",
        controlForeground: controlStyle?.color ?? "",
        controlBackground: controlStyle?.backgroundColor ?? "",
        feedbackForeground: feedbackStyle?.color ?? "",
        feedbackBackground: feedbackStyle?.backgroundColor ?? "",
      };
    });
    expect(contrastRatio(colors.shellForeground, colors.shellBackground)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(colors.playerForeground).toBe(colors.shellForeground);
    expect(colors.playerBackground).toBe(colors.shellBackground);
    expect(contrastRatio(colors.choiceForeground, colors.choiceBackground)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      contrastRatio(colors.controlForeground, colors.controlBackground),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colors.selectedForeground, colors.selectedBackground),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colors.feedbackForeground, colors.feedbackBackground),
    ).toBeGreaterThanOrEqual(4.5);
    expect(colors.focusStyle).not.toBe("none");
    expect(Number.parseFloat(colors.focusWidth)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(colors.focusColor, colors.focusedChoiceBackground)).toBeGreaterThanOrEqual(
      3,
    );
    await expect(page.locator(".session-page")).toHaveScreenshot(`${theme}.png`, {
      animations: "disabled",
    });
  });
}

test("forced-colors mode remains owned by the operating system", async ({
  page,
  request,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  const attemptId = await launch({
    page,
    request,
    seed: `forced-colors-${testInfo.parallelIndex}-${Date.now()}`,
  });
  await setTheme({
    page,
    request,
    attemptId,
    theme: "qti3-player-color-yellowblue",
  });
  await expect(page.locator(".session-page")).toHaveCSS("forced-color-adjust", "auto");
  await expect(page.locator(".renderer-canvas")).toHaveCSS("forced-color-adjust", "auto");
  const forcedColorChoices = page.locator(".qti3-choice-option input");
  await forcedColorChoices.first().click();
  await page.keyboard.press("ArrowDown");
  await expect(forcedColorChoices.nth(1)).toBeFocused();
  const focusOutline = await forcedColorChoices.nth(1).evaluate((input) => {
    const style = getComputedStyle(input);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(focusOutline.style).not.toBe("none");
  expect(Number.parseFloat(focusOutline.width)).toBeGreaterThanOrEqual(3);
  await expect(page.locator(".session-page")).toHaveScreenshot("forced-colors.png", {
    animations: "disabled",
  });
});

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string): number => {
    const [red = 0, green = 0, blue = 0] = color.match(/[\d.]+/g)?.map(Number) ?? [];
    const channelScale = color.startsWith("color(") ? 1 : 255;
    const channel = (value: number): number => {
      const normalized = value / channelScale;
      return normalized <= 0.04045
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
  };
  const high = Math.max(luminance(foreground), luminance(background));
  const low = Math.min(luminance(foreground), luminance(background));
  return (high + 0.05) / (low + 0.05);
}
