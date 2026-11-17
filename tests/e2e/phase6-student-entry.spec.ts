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
      "x-harbor-package-name": "phase6-student-entry.zip",
      "x-harbor-tenant-id": "tenant_local_demo",
    },
    data: await createFixturePackage(),
  });

  expect(response.status()).toBe(201);
  return response.json();
}

test("institutional sign-in persists and targeted assessments can start then resume from home", async ({
  page,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase6-student-entry-${testInfo.parallelIndex}-${Date.now()}`,
  );

  await page.goto("/");
  await page.getByTestId("password-login-button").click();
  await page.getByTestId("institutional-login-button").click();

  await expect(page.getByTestId("signed-in-learner")).toHaveText("Morgan Lee");
  await page.reload();
  await expect(page.getByTestId("signed-in-learner")).toHaveText("Morgan Lee");

  const sessionPayload = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session");
    return {
      status: response.status,
      body: await response.json(),
    };
  });
  expect(sessionPayload.status).toBe(200);

  const assignmentId = `assign_phase6_student_${testInfo.parallelIndex}_${Date.now()}`;
  const createAssignment = await request.post(`${workerOrigin}/internal/assignments`, {
    data: {
      assignmentId,
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Institutional Biology Quiz",
      actor: {
        role: "instructor",
        actorId: "inst_phase6",
        displayName: "Phase 6 Instructor",
      },
      policySnapshot: {
        availableFrom: "2026-03-27T00:00:00.000Z",
        availableUntil: "2026-12-31T00:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 2,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
      targets: [
        {
          kind: "learner",
          learnerId: sessionPayload.body.learner.id,
        },
      ],
    },
  });
  expect(createAssignment.status()).toBe(201);

  await page.reload();
  const assignmentAction = page.getByTestId(`student-assessment-action-${assignmentId}`);
  await expect.poll(() => assignmentAction.count()).toBe(1);
  await expect(assignmentAction).toHaveText("Start Assessment");
  await assignmentAction.click();

  await expect(page).toHaveURL(/\/session$/);
  await expect(page.getByTestId("attempt-id")).toHaveCount(1);
  await expect(page.getByTestId("delivery-state")).toHaveText("active");

  await page.getByTestId("session-home-button").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId(`student-assessment-action-${assignmentId}`)).toHaveText(
    "Resume Attempt",
  );
});
