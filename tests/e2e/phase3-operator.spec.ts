import { readFileSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { expect, test } from "@playwright/test";

const workerOrigin = "http://127.0.0.1:8787";
const fixtureRoot = path.resolve(process.cwd(), "tests/fixtures/qti/basic-assessment");

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
  assessmentId: string;
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

async function launchPreviewAttempt(input: {
  page: Parameters<typeof test>[0]["page"];
  request: Parameters<typeof test>[0]["request"];
  seed: string;
}): Promise<string> {
  const published = await publishFixture(input.request, input.seed);

  await input.page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

  await expect(input.page.getByTestId("attempt-id")).toHaveCount(1);
  const attemptId = await input.page.getByTestId("attempt-id").textContent();
  expect(attemptId).toBeTruthy();
  return attemptId ?? "";
}

async function postPolicyCommand(input: {
  request: Parameters<typeof test>[0]["request"];
  attemptId: string;
  body: unknown;
}): Promise<void> {
  const data =
    input.body && typeof input.body === "object" && !Array.isArray(input.body)
      ? {
          ...(input.body as Record<string, unknown>),
          ...(typeof (input.body as Record<string, unknown>).commandId === "string"
            ? {
                commandId: `${(input.body as Record<string, unknown>).commandId}_${input.attemptId}`,
              }
            : {}),
        }
      : input.body;
  const response = await input.request.post(
    `${workerOrigin}/internal/attempts/${input.attemptId}/policy`,
    {
      headers: {
        "content-type": "application/json",
      },
      data,
    },
  );

  expect(response.status()).toBe(200);
}

async function postBatchOperatorAction(input: {
  request: Parameters<typeof test>[0]["request"];
  attemptIds: string[];
  body: unknown;
}): Promise<void> {
  const response = await input.request.post(`${workerOrigin}/internal/attempt-actions/batch`, {
    headers: {
      "content-type": "application/json",
    },
    data: {
      attemptIds: input.attemptIds,
      action: input.body,
    },
  });

  expect(response.status()).toBe(200);
}

async function activateAssessmentVersion(input: {
  request: Parameters<typeof test>[0]["request"];
  assessmentId: string;
  assessmentVersionId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const response = await input.request.post(
    `${workerOrigin}/internal/assessments/${input.assessmentId}/activate-version`,
    {
      headers: {
        "content-type": "application/json",
      },
      data: {
        activationId: `activation-${Date.now()}`,
        assessmentVersionId: input.assessmentVersionId,
        actor: {
          role: "operator",
          actorId: "operator_01",
          displayName: "Operations Lead",
        },
        reason: "Corrected version for future launches",
        activatedAt: now,
      },
    },
  );

  expect(response.status()).toBe(200);
}

async function issueAccessCodeByAssessment(input: {
  request: Parameters<typeof test>[0]["request"];
  assessmentId: string;
  code: string;
}): Promise<{
  accessCode: string;
  assessmentVersionId: string;
}> {
  const response = await input.request.post(`${workerOrigin}/internal/access-codes`, {
    data: {
      assessmentId: input.assessmentId,
      code: input.code,
    },
  });

  expect(response.status()).toBe(201);
  return response.json();
}

test("shows policy refresh, operator messaging, and overlay-derived renderer settings without relaunching the shell", async ({
  page,
  request,
}, testInfo) => {
  const attemptId = await launchPreviewAttempt({
    page,
    request,
    seed: `phase3-operator-${testInfo.parallelIndex}-${Date.now()}`,
  });

  const now = new Date().toISOString();
  await postPolicyCommand({
    request,
    attemptId,
    body: {
      commandId: "cmd_extend_ui",
      type: "extend-time",
      actor: {
        role: "operator",
        actorId: "operator_01",
        displayName: "Operations Lead",
      },
      reason: "Approved extension",
      issuedAt: now,
      effectiveAt: now,
      additionalTimeSeconds: 90,
    },
  });
  await postPolicyCommand({
    request,
    attemptId,
    body: {
      commandId: "cmd_reopen_ui",
      type: "reopen-attempt",
      actor: {
        role: "operator",
        actorId: "operator_01",
        displayName: "Operations Lead",
      },
      reason: "Reconnect recovery",
      issuedAt: now,
      effectiveAt: now,
      reopenUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  });
  await postPolicyCommand({
    request,
    attemptId,
    body: {
      commandId: "cmd_message_ui",
      type: "post-operator-message",
      actor: {
        role: "operator",
        actorId: "operator_01",
        displayName: "Operations Lead",
      },
      reason: "Candidate notification",
      issuedAt: now,
      effectiveAt: now,
      message: {
        level: "warning",
        title: "Time updated",
        body: "Your attempt now has updated timing and review limits.",
        effectiveUntil: null,
      },
    },
  });
  await postPolicyCommand({
    request,
    attemptId,
    body: {
      commandId: "cmd_accommodation_ui",
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
        rendererPnp: {
          layoutSingleColumn: true,
          glossaryOnScreen: false,
        },
        sessionControl: {
          allow_review: false,
          allow_skipping: false,
          time_limits: {
            max_time: 90,
            allow_late_submission: true,
          },
        },
      },
    },
  });

  await page.getByTestId("nav-link-details").click();
  await page.getByTestId("refresh-policy-button").click();

  await expect(page.getByTestId("operator-message-banner")).toContainText("Time updated");
  await expect(page.getByTestId("operator-message-banner")).toContainText(
    "updated timing and review limits",
  );
  await expect(page.getByTestId("policy-overlay-status")).toContainText("Overlay revision 4");
  await expect(page.getByTestId("policy-overlay-status")).toContainText("reopened");
  await expect(page.getByTestId("policy-overlay-status")).toContainText("90s added");
  await expect(page.getByTestId("renderer-accommodation-status")).toContainText("single-column on");
  await expect(page.getByTestId("renderer-accommodation-status")).toContainText("review locked");

  await page.getByTestId("nav-link-session").click();
  await page.getByTestId("save-response-button").click();

  await page.getByTestId("nav-link-details").click();
  await expect(page.getByTestId("policy-overlay-status")).toContainText("Overlay revision 4");
  await expect(page.getByTestId("operator-message-banner")).toContainText("Time updated");
});

test("applies explicit batch operator actions only to the selected attempt set and exposes ordered timeline JSON", async ({
  browser,
  request,
}, testInfo) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();

  try {
    const firstAttemptId = await launchPreviewAttempt({
      page: firstPage,
      request,
      seed: `phase3-batch-first-${testInfo.parallelIndex}-${Date.now()}`,
    });
    await launchPreviewAttempt({
      page: secondPage,
      request,
      seed: `phase3-batch-second-${testInfo.parallelIndex}-${Date.now()}`,
    });

    const now = new Date().toISOString();
    await postBatchOperatorAction({
      request,
      attemptIds: [firstAttemptId],
      body: {
        actionId: "batch-message-01",
        type: "post-operator-message",
        actor: {
          role: "operator",
          actorId: "operator_01",
          displayName: "Operations Lead",
        },
        reason: "Selected attempt notification",
        effectiveAt: now,
        message: {
          level: "warning",
          title: "Selected batch",
          body: "Only the selected attempt should see this operator message.",
          effectiveUntil: null,
        },
      },
    });

    await firstPage.getByTestId("nav-link-details").click();
    await secondPage.getByTestId("nav-link-details").click();
    await firstPage.getByTestId("refresh-policy-button").click();
    await secondPage.getByTestId("refresh-policy-button").click();

    await expect(firstPage.getByTestId("operator-message-banner")).toContainText("Selected batch");
    await expect(firstPage.getByTestId("policy-overlay-status")).toContainText(
      "Overlay revision 1",
    );
    await expect(secondPage.getByTestId("operator-message-banner")).toHaveCount(0);
    await expect(secondPage.getByTestId("policy-overlay-status")).toContainText(
      "Overlay revision 0",
    );

    const timelineResponse = await request.get(
      `${workerOrigin}/internal/attempts/${firstAttemptId}/timeline`,
    );
    expect(timelineResponse.status()).toBe(200);
    const timeline = await timelineResponse.json<{
      entries: Array<{ eventType: string }>;
    }>();
    expect(timeline.entries.map((entry) => entry.eventType)).toEqual([
      "launch",
      "reconnect",
      "override",
    ]);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("keeps old access-code launches pinned while future assessment-level issuance resolves to the activated version", async ({
  page,
  request,
}, testInfo) => {
  const seed = `phase3-activation-${testInfo.parallelIndex}-${Date.now()}`;
  const firstPublish = await publishFixture(request, seed);
  const secondPublish = await publishFixture(request, seed);
  const pinnedCodeValue = `PINNED-${testInfo.parallelIndex}-${Date.now()}`;
  const activeCodeValue = `ACTIVE-${testInfo.parallelIndex}-${Date.now()}`;

  const pinnedCodeResponse = await request.post(`${workerOrigin}/internal/access-codes`, {
    data: {
      assessmentVersionId: firstPublish.assessmentVersionId,
      code: pinnedCodeValue,
    },
  });
  expect(pinnedCodeResponse.status()).toBe(201);
  const pinnedCode = await pinnedCodeResponse.json<{
    accessCode: string;
    assessmentVersionId: string;
  }>();

  await activateAssessmentVersion({
    request,
    assessmentId: firstPublish.assessmentId,
    assessmentVersionId: secondPublish.assessmentVersionId,
  });

  const activatedCode = await issueAccessCodeByAssessment({
    request,
    assessmentId: firstPublish.assessmentId,
    code: activeCodeValue,
  });
  expect(activatedCode.assessmentVersionId).toBe(secondPublish.assessmentVersionId);

  await page.goto(
    `/?mode=access-code&accessCode=${pinnedCode.accessCode}&candidateId=student_v1&candidateName=Student%20V1`,
  );
  await expect(page.getByTestId("assessment-version-id")).toHaveText(
    firstPublish.assessmentVersionId,
  );

  await page.goto(
    `/?mode=access-code&accessCode=${activatedCode.accessCode}&candidateId=student_v2&candidateName=Student%20V2`,
  );
  await expect(page.getByTestId("assessment-version-id")).toHaveText(
    secondPublish.assessmentVersionId,
  );
});
