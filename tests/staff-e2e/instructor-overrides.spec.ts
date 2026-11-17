import { expect, test, type Page } from "@playwright/test";
import { seedRecoveryExam } from "./lab-recovery-fixture";
import { signInOutageStaff } from "./lab-outage-helpers";

async function openRoster(page: Page, assignmentId: string) {
  await page.goto("/assessments");
  await page.getByTestId(`assessment-card-${assignmentId}`).click();
  await page.getByTestId("nav-link-roster").click();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await expect(page.getByTestId("save-learner-override-button")).toBeEnabled();
}

async function refreshRoster(page: Page) {
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/roster"));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
}

test("a roster refresh preserves the instructor override draft and Save persists every entered value", async ({
  page,
  request,
}, testInfo) => {
  const exam = await seedRecoveryExam(request);
  const actorId = await signInOutageStaff(request, page.request);
  await openRoster(page, exam.assignmentId);
  await page.getByLabel("Extra time seconds", { exact: true }).fill("600");
  await page.getByLabel("Max Attempts", { exact: true }).fill("3");
  await page.getByLabel("Time limit", { exact: true }).fill("2400");
  await page.getByLabel("Grace period", { exact: true }).fill("120");
  await page.getByLabel("Single-column layout", { exact: true }).check();
  await refreshRoster(page);
  await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("600");
  await expect(page.getByLabel("Max Attempts", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Time limit", { exact: true })).toHaveValue("2400");
  await expect(page.getByLabel("Grace period", { exact: true })).toHaveValue("120");
  await expect(page.getByLabel("Single-column layout", { exact: true })).toBeChecked();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`/learners/${exam.learnerId}/override`),
  );
  await page.getByTestId("save-learner-override-button").click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const override: unknown = await response.json();
  expect(override).toMatchObject({
    assignmentId: exam.assignmentId,
    learnerId: exam.learnerId,
    policyOverrides: {
      additionalTimeSeconds: 600,
      maxAttempts: 3,
      timeLimitSeconds: 2400,
      gracePeriodSeconds: 120,
    },
    accommodations: { rendererPnp: { layoutSingleColumn: true } },
    updatedBy: { actorId },
  });
  await expect(page.getByTestId("save-learner-override-button")).toBeEnabled();
  await page.reload();
  await openRoster(page, exam.assignmentId);
  await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("600");
  await expect(page.getByLabel("Max Attempts", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Time limit", { exact: true })).toHaveValue("2400");
  await expect(page.getByLabel("Grace period", { exact: true })).toHaveValue("120");
  await expect(page.getByLabel("Single-column layout", { exact: true })).toBeChecked();
  await testInfo.attach("override-persistence.json", {
    contentType: "application/json",
    body: JSON.stringify(override),
  });
});

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function saveOverride(page: Page, learnerId: string) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`/learners/${learnerId}/override`),
  );
  await page.getByTestId("save-learner-override-button").click();
  const response = await saved;
  await expect(page.getByTestId("save-learner-override-button")).toBeEnabled();
  return response;
}

test("a failed override save keeps the draft through refresh and retries without a browser error", async ({
  page,
  request,
}) => {
  const exam = await seedRecoveryExam(request);
  await signInOutageStaff(request, page.request);
  await openRoster(page, exam.assignmentId);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByLabel("Extra time seconds", { exact: true }).fill("600");
  const endpoint = `**/learners/${exam.learnerId}/override`;
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Override save unavailable" }),
    }),
  );
  expect((await saveOverride(page, exam.learnerId)).status()).toBe(503);
  await expect(page.getByRole("alert")).toContainText("Override save unavailable");
  await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("600");
  await refreshRoster(page);
  await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("600");
  const beforeRetry = await page.request.get(
    `/api/instructor/assignments/${exam.assignmentId}/roster`,
  );
  expect(await beforeRetry.json()).toMatchObject({
    rows: expect.arrayContaining([
      expect.objectContaining({
        learner: expect.objectContaining({ id: exam.learnerId }),
        activeOverride: null,
      }),
    ]),
  });
  await page.unroute(endpoint);
  const saved = await saveOverride(page, exam.learnerId);
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ policyOverrides: { additionalTimeSeconds: 600 } });
  await refreshRoster(page);
  await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("600");
  expect(errors).toEqual([]);
});

test("an acknowledged save cannot overwrite a newer edit and clean forms follow authoritative changes", async ({
  page,
  request,
}, testInfo) => {
  const exam = await seedRecoveryExam(request);
  const actorId = await signInOutageStaff(request, page.request);
  await openRoster(page, exam.assignmentId);
  const reached = gate();
  const release = gate();
  const endpoint = `**/learners/${exam.learnerId}/override`;
  await page.route(endpoint, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    reached.open();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    await page.getByLabel("Extra time seconds", { exact: true }).fill("600");
    await page.getByTestId("save-learner-override-button").click();
    await reached.promise;
    await page.getByLabel("Extra time seconds", { exact: true }).fill("900");
    release.open();
    await expect(page.getByTestId("save-learner-override-button")).toBeEnabled();
    await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("900");
    await refreshRoster(page);
    await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("900");
    await page.unroute(endpoint);
    const saved = await saveOverride(page, exam.learnerId);
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toMatchObject({ policyOverrides: { additionalTimeSeconds: 900 } });
    const updated = await page.request.put(
      `/api/instructor/assignments/${exam.assignmentId}/learners/${exam.learnerId}/override`,
      {
        data: {
          actor: { role: "instructor", actorId },
          policyOverrides: { additionalTimeSeconds: 1200 },
        },
      },
    );
    expect(updated.status()).toBe(200);
    await refreshRoster(page);
    await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("1200");
    await testInfo.attach("override-acknowledgement.json", {
      contentType: "application/json",
      body: JSON.stringify({
        assignmentId: exam.assignmentId,
        learnerId: exam.learnerId,
        acceptedBeforeAck: 600,
        editWhileAwaitingAck: 900,
        acceptedNextSave: 900,
        cleanFormAfterAuthoritativeRefresh: 1200,
      }),
    });
  } finally {
    release.open();
  }
});

test("switching learner or assessment cannot carry an unsaved override into another candidate", async ({
  page,
  request,
}) => {
  const first = await seedRecoveryExam(request);
  const second = await seedRecoveryExam(request);
  const actorId = await signInOutageStaff(request, page.request);
  const response = await page.request.get(`/api/instructor/assignments/${first.assignmentId}`);
  expect(response.status()).toBe(200);
  const assignment: unknown = await response.json();
  if (
    !assignment ||
    typeof assignment !== "object" ||
    !("policySnapshot" in assignment) ||
    !("title" in assignment) ||
    typeof assignment.title !== "string"
  )
    throw new Error("Missing assignment fixture");
  expect(
    (
      await page.request.put(`/api/instructor/assignments/${first.assignmentId}`, {
        data: {
          title: assignment.title,
          actor: { role: "instructor", actorId },
          policySnapshot: assignment.policySnapshot,
          targets: [
            { kind: "learner", learnerId: first.learnerId },
            { kind: "learner", learnerId: second.learnerId },
          ],
        },
      })
    ).status(),
  ).toBe(200);
  await openRoster(page, first.assignmentId);
  await page.getByTestId(`roster-row-${first.learnerId}`).click();
  await page.getByLabel("Extra time seconds", { exact: true }).fill("600");
  await page.getByTestId(`roster-row-${second.learnerId}`).click();
  await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("");
  await page.getByLabel("Extra time seconds", { exact: true }).fill("120");
  const saved = await saveOverride(page, second.learnerId);
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({
    assignmentId: first.assignmentId,
    learnerId: second.learnerId,
    policyOverrides: { additionalTimeSeconds: 120 },
  });
  await page.getByTestId(`roster-row-${first.learnerId}`).click();
  await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("");
  await page.getByLabel("Extra time seconds", { exact: true }).fill("900");
  await openRoster(page, second.assignmentId);
  await expect(page.getByLabel("Extra time seconds", { exact: true })).toHaveValue("");
  const roster = await page.request.get(`/api/instructor/assignments/${first.assignmentId}/roster`);
  expect(await roster.json()).toMatchObject({
    rows: expect.arrayContaining([
      expect.objectContaining({
        learner: expect.objectContaining({ id: first.learnerId }),
        activeOverride: null,
      }),
    ]),
  });
});
