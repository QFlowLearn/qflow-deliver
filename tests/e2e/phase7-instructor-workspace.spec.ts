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
      "x-harbor-package-name": "phase7-instructor-workspace.zip",
      "x-harbor-tenant-id": "tenant_local_demo",
    },
    data: await createFixturePackage(),
  });

  expect(response.status()).toBe(201);
  return response.json();
}

test("instructor workspace handles assessment lifecycle, live intervention, and authoritative history", async ({
  page,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase7-instructor-${testInfo.parallelIndex}-${Date.now()}`,
  );

  await page.goto("/");
  await page.getByTestId("password-login-button").click();
  await page.getByTestId("institutional-login-button").click();
  await expect(page.getByTestId("signed-in-learner")).toHaveText("Morgan Lee");

  const learnerId = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session");
    const body = await response.json();
    return body.learner.id as string;
  });

  let assignmentId = "";
  const assignmentTitle = `Institutional Physics Quiz ${Date.now()}`;
  const updatedAssignmentTitle = `${assignmentTitle} Final`;

  await page.getByTestId("nav-link-assessments").click();
  await expect(page).toHaveURL(/\/assessments$/);
  await page.getByTestId("assessment-new-button").click();

  await page.getByTestId("assessment-package-select").selectOption(published.assessmentVersionId);
  await page.getByTestId("assessment-title-input").fill(assignmentTitle);
  await page.getByText("Targets", { exact: true }).click();
  await page.getByTestId("assessment-learner-targets-input").fill(learnerId);
  await page.getByTestId("assessment-save-button").click();

  const assignmentCard = page
    .locator('[data-testid^="assessment-card-"]')
    .filter({ hasText: assignmentTitle });
  await expect(assignmentCard).toBeVisible();
  await expect(assignmentCard).toContainText(assignmentTitle);
  const assignmentCardTestId = await assignmentCard.getAttribute("data-testid");
  assignmentId = assignmentCardTestId?.replace("assessment-card-", "") ?? "";
  expect(assignmentId).not.toBe("");
  const createdAssignmentCard = page.getByTestId(`assessment-card-${assignmentId}`);

  await page.getByTestId("assessment-title-input").fill(updatedAssignmentTitle);
  await page.getByTestId("assessment-save-button").click();
  await expect(createdAssignmentCard).toContainText(updatedAssignmentTitle);

  await page.getByTestId("assessment-activate-button").click();
  await expect(page.getByTestId("selected-assessment-status")).toHaveText("active");

  await page.getByTestId("nav-link-home").click();
  const learnerAction = page.getByTestId(`student-assessment-action-${assignmentId}`);
  await expect(learnerAction).toHaveText("Start Assessment");
  await learnerAction.click();

  await expect(page).toHaveURL(/\/session$/);
  await expect(page.getByTestId("delivery-state")).toHaveText("active");

  await page.getByTestId("session-home-button").click();
  await page.getByTestId("nav-link-assessments").click();
  await page.getByTestId("nav-link-roster").click();
  await expect(page).toHaveURL(/\/roster$/);

  const learnerRow = page.getByTestId(`roster-row-${learnerId}`);
  await expect(learnerRow).toBeVisible();
  await learnerRow.click();

  await page.getByTestId("override-additional-time-input").fill("600");
  await page.getByTestId("save-learner-override-button").click();
  await expect(page.getByTestId("override-additional-time-input")).toHaveValue("600");

  await page.getByLabel("Incident reason", { exact: true }).fill("Verified network interruption");
  await page.getByLabel("Minutes", { exact: true }).fill("5");
  await page.getByTestId("grant-extra-time-button").click();
  await expect(page.getByTestId("attempt-timeline-list")).toBeVisible();
  await expect(page.getByTestId("timeline-entry-override").first()).toBeVisible();

  await page.getByTestId("nav-link-session").click();
  await expect(page).toHaveURL(/\/session$/);
  await page.getByTestId("submit-attempt-button").click();
  await expect(page.getByTestId("delivery-state")).toHaveText("submitted");

  await page.getByTestId("session-home-button").click();
  await page.getByTestId("nav-link-assessments").click();
  await page.getByTestId("nav-link-roster").click();
  await page.getByTestId("open-attempt-history-button").click();

  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByTestId("history-attempt-list")).toBeVisible();
  await expect(page.locator(".history-context")).toContainText(updatedAssignmentTitle);
});
