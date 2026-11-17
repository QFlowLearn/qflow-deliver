import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const api = "http://127.0.0.1:8791";
export const adminHeaders = { "x-harbor-admin-key": "staff-e2e-test-admin" };
export const password = "LabRecoveryAcceptance123";
export const tenantId = "tenant_local_demo";

/** Synthetic account/package/assignment through the real privileged local HTTP boundary. */
export async function seedRecoveryExam(
  request: APIRequestContext,
  timing: { readonly timeLimitSeconds: number; readonly gracePeriodSeconds: number } = {
    timeLimitSeconds: 1800,
    gracePeriodSeconds: 0,
  },
) {
  const username = `recovery-${crypto.randomUUID()}`;
  const account = await request.post(`${api}/internal/auth/password/accounts`, {
    headers: adminHeaders,
    data: {
      tenantId,
      username,
      email: `${username}@example.test`,
      displayName: "Recovery candidate",
      password,
    },
  });
  expect(account.status(), await account.text()).toBe(201);
  const identity: unknown = await account.json();
  if (
    !identity ||
    typeof identity !== "object" ||
    !("learnerId" in identity) ||
    typeof identity.learnerId !== "string"
  )
    throw new Error("Invalid candidate fixture");
  const zip = new JSZip();
  for (const name of ["imsmanifest.xml", "items/item-1.xml", "items/item-2.xml"])
    zip.file(name, readFileSync(path.resolve("tests/fixtures/qti/lab-recovery", name)));
  const published = await request.post(`${api}/internal/publish?assessmentSlug=${username}`, {
    headers: {
      ...adminHeaders,
      "content-type": "application/zip",
      "x-harbor-tenant-id": tenantId,
      "x-harbor-package-name": "recovery.zip",
    },
    data: await zip.generateAsync({ type: "nodebuffer" }),
  });
  expect(published.status()).toBe(201);
  const publication: unknown = await published.json();
  if (
    !publication ||
    typeof publication !== "object" ||
    !("assessmentId" in publication) ||
    typeof publication.assessmentId !== "string" ||
    !("assessmentVersionId" in publication) ||
    typeof publication.assessmentVersionId !== "string"
  )
    throw new Error("Invalid publication fixture");
  const assignmentId = `assign_${crypto.randomUUID()}`;
  const created = await request.post(`${api}/internal/assignments`, {
    headers: adminHeaders,
    data: {
      assignmentId,
      assessmentId: publication.assessmentId,
      assessmentVersionId: publication.assessmentVersionId,
      title: "Workstation recovery",
      status: "active",
      actor: { role: "system", actorId: "fixture" },
      policySnapshot: {
        reportingTimezone: "UTC",
        maxAttempts: 1,
        timeLimitSeconds: timing.timeLimitSeconds,
        gracePeriodSeconds: timing.gracePeriodSeconds,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
      },
      targets: [{ kind: "learner", learnerId: identity.learnerId }],
    },
  });
  expect(created.status()).toBe(201);
  return {
    username,
    learnerId: identity.learnerId,
    assignmentId,
    assessmentVersionId: publication.assessmentVersionId,
  };
}

export async function signInAndOpen(
  page: Page,
  exam: Awaited<ReturnType<typeof seedRecoveryExam>>,
) {
  expect(
    (
      await page.request.post("/api/auth/password/login", {
        data: { tenantId, usernameOrEmail: exam.username, password },
      })
    ).status(),
  ).toBe(200);
  await page.goto("/");
  await page.getByTestId(`student-assessment-action-${exam.assignmentId}`).click();
  await expect(page.getByTestId("attempt-id")).toHaveCount(1);
  // The attempt ID is available before manifest/item loading. Outage scenarios
  // that interrupt an active question must begin only once that question is usable.
  await expect(
    page.getByRole("textbox", { name: "Explain your reasoning.", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[inert] harbor-qti-renderer-host")).toHaveCount(0);
}
