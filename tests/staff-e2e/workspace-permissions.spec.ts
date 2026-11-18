import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { expect, test } from "@playwright/test";

const api = "http://127.0.0.1:8791";
const adminHeaders = { "x-harbor-admin-key": "staff-e2e-test-admin" };
const tenantId = "tenant_local_demo";
const password = "StaffAcceptanceOnly123";

for (const role of ["assessment-manager", "invigilator", "scorer"] as const) {
  test(`${role} can open its authorized roster without requesting forbidden scoring features`, async ({
    page,
    request,
  }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    const seed = crypto.randomUUID();
    const username = `staff-${seed}`;
    const account = await request.post(`${api}/internal/auth/password/accounts`, {
      headers: adminHeaders,
      data: { tenantId, username, email: `${username}@example.test`, displayName: role, password },
    });
    expect(account.status()).toBe(201);
    const identity: unknown = await account.json();
    if (
      !identity ||
      typeof identity !== "object" ||
      !("learnerId" in identity) ||
      typeof identity.learnerId !== "string"
    )
      throw new Error("Account fixture has no learner identity");
    const learnerId = identity.learnerId;
    const zip = new JSZip();
    const root = path.resolve("tests/fixtures/qti/basic-assessment");
    for (const file of ["imsmanifest.xml", "items/item-1.xml", "assets/stimulus.svg"])
      zip.file(file, readFileSync(path.join(root, file)));
    const publish = await request.post(`${api}/internal/publish?assessmentSlug=${username}`, {
      headers: {
        ...adminHeaders,
        "content-type": "application/zip",
        "x-harbor-package-name": "staff-browser.zip",
        "x-harbor-tenant-id": tenantId,
      },
      data: await zip.generateAsync({ type: "nodebuffer" }),
    });
    expect(publish.status()).toBe(201);
    const publication: unknown = await publish.json();
    if (
      !publication ||
      typeof publication !== "object" ||
      !("assessmentId" in publication) ||
      typeof publication.assessmentId !== "string" ||
      !("assessmentVersionId" in publication) ||
      typeof publication.assessmentVersionId !== "string"
    )
      throw new Error("Publication fixture is invalid");
    const assignmentId = `assign_${seed}`;
    const create = await request.post(`${api}/internal/assignments`, {
      headers: adminHeaders,
      data: {
        assignmentId,
        assessmentId: publication.assessmentId,
        assessmentVersionId: publication.assessmentVersionId,
        title: `Staff exam ${seed}`,
        status: "active",
        actor: { role: "system", actorId: "staff-browser-fixture" },
        policySnapshot: {
          reportingTimezone: "America/New_York",
          maxAttempts: 1,
          timeLimitSeconds: 1800,
          navigationMode: "linear",
          standaloneAllowed: true,
          iframeAllowed: false,
          allowedEmbedOrigins: [],
          secureBrowserRequired: false,
        },
        targets: [{ kind: "learner", learnerId }],
      },
    });
    expect(create.status()).toBe(201);
    const grantId = `grant_${seed}`;
    expect(
      (
        await request.put(`${api}/internal/staff/grants/${grantId}`, {
          headers: adminHeaders,
          data: {
            tenantId,
            learnerId,
            role,
            assignmentId: role === "assessment-manager" ? null : assignmentId,
          },
        })
      ).status(),
    ).toBe(200);

    await page.goto("/login");
    await page.getByLabel("Username or email", { exact: true }).fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByTestId("signed-in-learner")).toHaveText(role);
    const readRequests: string[] = [];
    page.on("request", (outgoing) => {
      if (outgoing.method() === "GET" && outgoing.url().includes("/api/instructor/"))
        readRequests.push(new URL(outgoing.url()).pathname);
    });
    const profileReadStarted = Promise.withResolvers<void>();
    const releaseProfileRead = Promise.withResolvers<void>();
    if (role === "assessment-manager") {
      await page.route(
        `**/api/instructor/learners/${learnerId}/accommodation-profiles`,
        async (route) => {
          profileReadStarted.resolve();
          await releaseProfileRead.promise;
          await route.continue();
        },
      );
    }
    try {
      await page.goto("/roster");
      await expect(page.getByTestId(`roster-row-${learnerId}`)).toBeVisible();
      if (role === "assessment-manager") await profileReadStarted.promise;
      const capabilityResponse = await page.request.get(
        `/api/instructor/assignments/${assignmentId}/capabilities`,
      );
      expect(capabilityResponse.status()).toBe(200);
      expect(await capabilityResponse.json()).toMatchObject({
        assignmentId,
        canReadResults: role !== "invigilator",
        canScoreResults: role === "scorer",
      });
      if (role !== "scorer")
        expect(readRequests.filter((url) => url.includes("/manual-scoring"))).toEqual([]);
      if (role === "invigilator")
        expect(
          readRequests.filter((url) => /\/(results|reporting|score-amendments)$/.test(url)),
        ).toEqual([]);

      expect(
        (
          await request.delete(`${api}/internal/staff/grants/${grantId}`, { headers: adminHeaders })
        ).status(),
      ).toBe(200);
      expect(
        (
          await page.request.get(`/api/instructor/assignments/${assignmentId}/capabilities`)
        ).status(),
      ).toBe(403);
      if (role === "assessment-manager") {
        const denied = page.waitForResponse(
          (response) =>
            response
              .url()
              .endsWith(`/api/instructor/learners/${learnerId}/accommodation-profiles`) &&
            response.status() === 403,
        );
        releaseProfileRead.resolve();
        await denied;
        await expect(page.getByTestId(`roster-row-${learnerId}`)).toHaveCount(0);
        await expect(
          page.getByRole("alert").filter({ hasText: "Staff permission is required" }),
        ).toBeVisible();
      }
      await page.reload();
      await expect(page.getByTestId(`roster-row-${learnerId}`)).toHaveCount(0);
      expect(browserErrors).toEqual([]);
    } finally {
      releaseProfileRead.resolve();
    }
  });
}

test("an authenticated password candidate cannot use management without an explicit grant", async ({
  page,
  request,
}) => {
  const username = `candidate-${crypto.randomUUID()}`;
  expect(
    (
      await request.post(`${api}/internal/auth/password/accounts`, {
        headers: adminHeaders,
        data: {
          tenantId,
          username,
          email: `${username}@example.test`,
          displayName: "Candidate",
          password,
        },
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await page.request.post("/api/auth/password/login", {
        data: { tenantId, usernameOrEmail: username, password },
      })
    ).status(),
  ).toBe(200);
  expect((await page.request.get("/api/instructor/assignments")).status()).toBe(403);
  expect((await request.get(`${api}/api/instructor/assignments`)).status()).toBe(401);
  expect((await page.request.get("/api/auth/institutional/login")).status()).toBe(503);
});
