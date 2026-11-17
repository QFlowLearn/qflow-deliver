import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { expect, test } from "@playwright/test";
import { HARBOR_GLOSSARY_ON_SCREEN_SUPPORT } from "@harbor/attempt-protocol";

const workerOrigin = "http://127.0.0.1:8787";
const fixtureRoot = path.resolve(
  process.cwd(),
  "tests/fixtures/qti/accessibility-catalog-assessment",
);

async function createAccessibilityFixturePackage(): Promise<Buffer> {
  const zip = new JSZip();
  for (const filePath of listFixtureFiles(fixtureRoot)) {
    zip.file(
      path.relative(fixtureRoot, filePath).split(path.sep).join("/"),
      readFileSync(filePath),
    );
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

function listFixtureFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap((entry) => {
      const entryPath = path.join(root, entry);
      return statSync(entryPath).isDirectory() ? listFixtureFiles(entryPath) : [entryPath];
    })
    .sort();
}

async function publishAccessibilityFixture(
  request: Parameters<typeof test>[0]["request"],
  seed: string,
): Promise<{ assessmentVersionId: string }> {
  const response = await request.post(`${workerOrigin}/internal/publish?assessmentSlug=${seed}`, {
    headers: {
      "content-type": "application/zip",
      "x-harbor-package-name": "accessibility-catalog-assessment.zip",
      "x-harbor-tenant-id": `tenant_${seed}`,
    },
    data: await createAccessibilityFixturePackage(),
  });

  expect(response.status()).toBe(201);
  return response.json();
}

async function launchPreviewAttempt(input: {
  page: Parameters<typeof test>[0]["page"];
  request: Parameters<typeof test>[0]["request"];
  seed: string;
}): Promise<string> {
  const published = await publishAccessibilityFixture(input.request, input.seed);

  await input.page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);
  await expect(input.page.getByTestId("attempt-id")).toHaveCount(1);
  const attemptId = await input.page.getByTestId("attempt-id").textContent();
  expect(attemptId).toBeTruthy();
  return attemptId ?? "";
}

async function postAccommodationPolicy(input: {
  request: Parameters<typeof test>[0]["request"];
  attemptId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const response = await input.request.post(
    `${workerOrigin}/internal/attempts/${input.attemptId}/policy`,
    {
      headers: {
        "content-type": "application/json",
      },
      data: {
        commandId: `cmd_pnp_a11y_${Date.now()}`,
        type: "set-accommodations",
        actor: {
          role: "operator",
          actorId: "operator_01",
          displayName: "Operations Lead",
        },
        reason: "Accessibility support",
        issuedAt: now,
        effectiveAt: now,
        accommodations: {
          rendererPnp: { keywordTranslationLanguage: "es-MX" },
          sessionControl: {},
          shellTools: {
            textToSpeech: true,
            captions: true,
            transcripts: true,
          },
          pnpEntitlement: {
            activateAsOptionSet: [
              "text-to-speech",
              "transcript",
              HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
              "keyword-translation",
            ],
            activateAtInitializationSet: ["caption", "audio-description"],
            prohibitSet: ["sign-language"],
            languages: ["fr-CA", "de-AT", "es-ES", "ja"],
          },
        },
      },
    },
  );

  expect(response.status()).toBe(200);
}

async function postBlockedSupportPolicy(input: {
  request: Parameters<typeof test>[0]["request"];
  attemptId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const response = await input.request.post(
    `${workerOrigin}/internal/attempts/${input.attemptId}/policy`,
    {
      headers: {
        "content-type": "application/json",
      },
      data: {
        commandId: `cmd_pnp_blocked_${Date.now()}`,
        type: "set-accommodations",
        actor: {
          role: "operator",
          actorId: "operator_01",
          displayName: "Operations Lead",
        },
        reason: "Block accessibility supports",
        issuedAt: now,
        effectiveAt: now,
        accommodations: {
          rendererPnp: {},
          sessionControl: {},
          shellTools: {},
          pnpEntitlement: {
            prohibitSet: [
              "text-to-speech",
              "transcript",
              "caption",
              "audio-description",
              "sign-language",
            ],
          },
        },
      },
    },
  );

  expect(response.status()).toBe(200);
}

test("renders entitled catalog supports accessibly and records support evidence", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    class MockSpeechSynthesisUtterance {
      text: string;
      lang = "";
      onend: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(text: string) {
        this.text = String(text);
      }
    }

    const spoken: Array<{ text: string; lang: string }> = [];
    Object.defineProperty(window, "__harborSpeechUtterances", {
      value: spoken,
      configurable: true,
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: MockSpeechSynthesisUtterance,
      configurable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        paused: false,
        pending: false,
        speaking: false,
        cancel() {
          this.paused = false;
          this.speaking = false;
        },
        pause() {
          this.paused = true;
        },
        resume() {
          this.paused = false;
        },
        speak(utterance: MockSpeechSynthesisUtterance) {
          this.speaking = true;
          spoken.push({ text: utterance.text, lang: utterance.lang });
        },
      },
      configurable: true,
    });
  });

  const attemptId = await launchPreviewAttempt({
    page,
    request,
    seed: `pnp-a11y-${testInfo.parallelIndex}-${Date.now()}`,
  });

  await postAccommodationPolicy({ request, attemptId });
  await page.getByTestId("nav-link-details").click();
  await page.getByTestId("refresh-policy-button").click();
  await page.getByTestId("nav-link-session").click();

  await expect(page.getByTestId("tts-start-button")).toBeVisible();
  await expect(page.getByTestId("captions-tool-button")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("transcripts-tool-button")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByTestId("media-alternatives-tool-button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  const glossaryButton = page.getByRole("button", {
    name: /This paragraph references a catalog with no requested support/i,
  });
  const inlineGlossaryButton = page.getByRole("button", {
    name: /Inline-only glossary term/i,
  });
  await expect(glossaryButton).toBeVisible();
  await expect(inlineGlossaryButton).toBeVisible();

  let releaseGlossaryFile: (() => void) | undefined;
  const glossaryFileGate = new Promise<void>((resolve) => {
    releaseGlossaryFile = resolve;
  });
  await page.route("**/api/content/assets/**missing.html**", async (route) => {
    await glossaryFileGate;
    await route.continue();
  });
  await glossaryButton.click();
  await expect(page.getByTestId("glossary-content")).toContainText("Loading glossary content");
  await inlineGlossaryButton.evaluate((button) => button.click());
  await expect(page.getByTestId("glossary-content")).toContainText(
    "Inline glossary definition replaces a pending file request.",
  );
  await expect(page.getByTestId("glossary-content")).not.toContainText("Loading glossary content");
  releaseGlossaryFile?.();
  await page.unrouteAll({ behavior: "wait" });
  await page.getByTestId("glossary-dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("glossary-dialog")).toHaveCount(0);

  await page.route("**/api/content/assets/**missing.html**", async (route) => {
    await route.fulfill({ status: 503, body: "unavailable" });
  });
  await glossaryButton.click();
  await expect(page.getByTestId("glossary-dialog").getByRole("alert")).toContainText(
    "could not be loaded",
  );
  await page.getByTestId("glossary-dialog").getByRole("button", { name: "Close" }).click();
  await expect(glossaryButton).toBeFocused();
  await page.unrouteAll({ behavior: "wait" });

  await inlineGlossaryButton.focus();
  await expect(inlineGlossaryButton).toBeFocused();
  await inlineGlossaryButton.press("Enter");
  await expect(page.getByTestId("glossary-dialog")).toBeVisible();
  await expect(page.getByTestId("glossary-content")).toContainText(
    "Inline glossary definition replaces a pending file request.",
  );
  await page.getByTestId("glossary-dialog").getByRole("button", { name: "Close" }).press("Enter");
  await expect(page.getByTestId("glossary-dialog")).toHaveCount(0);
  await expect(inlineGlossaryButton).toBeFocused();

  const keywordButton = page.getByRole("button", { name: /Show support for photosynthesis/i });
  await keywordButton.focus();
  await keywordButton.press("Enter");
  const translationDialog = page.getByTestId("keyword-translation-dialog");
  await expect(translationDialog).toBeVisible();
  await expect(translationDialog.getByRole("button", { name: "Close translation" })).toBeFocused();
  await expect(translationDialog).toContainText("Fotosíntesis");
  await expect(translationDialog).toContainText(/Requested es-MX; showing es/i);
  await expect(translationDialog.getByLabel("Translation language")).toHaveValue("es-MX");

  await translationDialog.getByLabel("Translation language").selectOption("fr-CA");
  await expect(translationDialog).toContainText("Photosynthèse");
  await expect(translationDialog.getByTestId("resolved-language")).toContainText(
    /(Canadian French|French \(Canada\))/i,
  );
  await translationDialog.getByRole("button", { name: "Close translation" }).click();
  await expect(translationDialog).toHaveCount(0);
  await expect(keywordButton).toBeFocused();

  await page.reload();
  await expect(page.getByTestId("attempt-id")).toHaveText(attemptId);
  const resumedKeywordButton = page.getByRole("button", {
    name: /Show support for photosynthesis/i,
  });
  await resumedKeywordButton.click();
  await expect(page.getByLabel("Translation language")).toHaveValue("fr-CA");
  await page.getByLabel("Translation language").selectOption("de-AT");
  const translatedAudio = page.getByLabel(/Keyword translation in German, fallback for .*German/i);
  await expect(translatedAudio).toHaveAttribute("preload", "metadata");
  await translatedAudio.dispatchEvent("play");
  await translatedAudio.dispatchEvent("pause");
  await page.getByLabel("Translation language").selectOption("es-ES");
  const translatedVideo = page.getByLabel(
    /Keyword translation in .*Spanish, exact requested language/i,
  );
  await expect(translatedVideo).toHaveAttribute("preload", "metadata");
  await translatedVideo.dispatchEvent("play");
  await page.getByLabel("Translation language").selectOption("ja");
  await expect(translationDialog.getByRole("alert")).toContainText("unsupported media type");
  await page.getByRole("button", { name: "Close translation" }).click();
  await glossaryButton.click();
  await expect(page.getByTestId("glossary-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("glossary-dialog")).toHaveCount(0);
  await expect(glossaryButton).toBeFocused();

  const supportPanel = page.getByTestId("media-support-panel");
  await expect(supportPanel).toHaveAttribute("role", "region");
  await expect(supportPanel).toContainText("captions/presentation-en.vtt");
  await expect(supportPanel).toContainText("media/described.mp4#t=2,9");
  await expect(supportPanel).not.toContainText("media/sign-language.mp4");
  await expect(supportPanel).not.toContainText("ASL interpretation clip");

  await page.getByTestId("transcripts-tool-button").press("Enter");
  await expect(page.getByTestId("transcripts-tool-button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(supportPanel).toContainText("Resumen de transcripcion en espanol.");

  await page.getByTestId("tts-start-button").click();
  await expect(page.getByTestId("tts-pause-button")).toBeVisible();
  await expect(page.getByTestId("tts-status")).toContainText("Reading");
  await page.getByTestId("tts-pause-button").click();
  await expect(page.getByTestId("tts-resume-button")).toBeVisible();
  await expect(page.getByTestId("tts-status")).toContainText("Paused");
  await page.getByTestId("tts-resume-button").click();
  await expect(page.getByTestId("tts-stop-button")).toBeVisible();
  await page.getByTestId("tts-stop-button").click();
  await expect(page.getByTestId("tts-start-button")).toBeVisible();

  await page.getByTestId("next-item-button").click();
  await expect(page.getByTestId("current-item-id")).toHaveText("no-catalog-supports");
  await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
  await expect(page.getByTestId("captions-tool-button")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("transcripts-tool-button")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByTestId("media-alternatives-tool-button")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByTestId("captions-tool-button").click();
  await expect(supportPanel).toContainText(
    "No catalog caption support was resolved for this item.",
  );
  await page.getByTestId("transcripts-tool-button").click();
  await expect(supportPanel).toContainText(
    "No catalog transcript support was resolved for this item.",
  );
  await page.getByTestId("media-alternatives-tool-button").click();
  await expect(supportPanel).toContainText(
    "No catalog media alternatives were resolved for this item.",
  );

  await postBlockedSupportPolicy({ request, attemptId });
  await page.getByTestId("nav-link-details").click();
  await page.getByTestId("refresh-policy-button").click();
  await page.getByTestId("nav-link-session").click();
  await expect(page.getByTestId("captions-tool-button")).toHaveCount(0);
  await expect(page.getByTestId("transcripts-tool-button")).toHaveCount(0);
  await expect(page.getByTestId("media-alternatives-tool-button")).toHaveCount(0);
  await expect(page.getByTestId("tts-start-button")).toHaveCount(0);
  await expect(page.getByTestId("media-support-panel")).toHaveCount(0);

  const spoken = await page.evaluate(
    () => (window as unknown as { __harborSpeechUtterances: unknown[] }).__harborSpeechUtterances,
  );
  expect(spoken.length).toBeGreaterThan(0);

  await expect
    .poll(async () => {
      const response = await request.get(`${workerOrigin}/internal/attempts/${attemptId}/evidence`);
      expect(response.status()).toBe(200);
      const payload = await response.json<{
        events: Array<{
          eventType: string;
          payload: {
            support?: string;
            state?: string;
            requestedLanguage?: string;
            resolvedLanguage?: string;
            assetReferences?: string[];
          };
        }>;
      }>();
      return payload.events
        .filter((event) => event.eventType === "accommodation.support")
        .map((event) => `${event.payload.support}:${event.payload.state}`);
    })
    .toEqual(
      expect.arrayContaining([
        "caption:opened",
        "transcript:opened",
        "audio-description:opened",
        "sign-language:suppressed",
        "caption:unavailable",
        "transcript:unavailable",
        "audio-description:unavailable",
        "spoken:activated",
        "spoken:paused",
        "spoken:resumed",
        "spoken:stopped",
        "glossary-on-screen:offered",
        "glossary-on-screen:opened",
        "glossary-on-screen:closed",
        "glossary-on-screen:unavailable",
        "keyword-translation:offered",
        "keyword-translation:opened",
        "keyword-translation:activated",
        "keyword-translation:played",
        "keyword-translation:paused",
        "keyword-translation:stopped",
        "keyword-translation:unavailable",
      ]),
    );

  const evidenceResponse = await request.get(
    `${workerOrigin}/internal/attempts/${attemptId}/evidence`,
  );
  const evidencePayload = await evidenceResponse.json<{
    events: Array<{ payload: { support?: string; state?: string } }>;
  }>();
  const serializedEvidence = JSON.stringify(evidencePayload.events);
  expect(
    evidencePayload.events.filter(
      (event) =>
        event.payload.support === "glossary-on-screen" && event.payload.state === "offered",
    ),
  ).toHaveLength(1);
  expect(serializedEvidence).not.toContain("/api/content/assets/");
  expect(serializedEvidence).not.toContain("Fotosíntesis");
  expect(serializedEvidence).toContain("items/translations/photosynthesis-es.mp4");
});
