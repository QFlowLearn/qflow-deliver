import { expect, test } from "@playwright/test";
import {
  adminHeaders,
  api,
  password,
  seedRecoveryExam,
  signInAndOpen,
  tenantId,
} from "./lab-recovery-fixture";

test("an assigned invigilator transfers accepted work to a clean browser and the old workstation cannot write or reclaim it", async ({
  page,
  request,
  browser,
}) => {
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  const attemptId = await page.getByTestId("attempt-id").textContent();
  await page.getByRole("radio", { name: "B. Blue", exact: true }).check();
  await page.getByRole("button", { name: "Move Act up", exact: true }).click();
  await page.getByRole("textbox").fill("The accepted essay from workstation A.");
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("current-item-id")).toHaveText("item-2");
  const originalRecovery = await readBrowserRecoveryWitness(page);

  const replacementContext = await browser.newContext({ baseURL: "http://127.0.0.1:4175" });
  const staffContext = await browser.newContext({ baseURL: "http://127.0.0.1:4175" });
  try {
    const replacement = await replacementContext.newPage();
    expect(
      (
        await replacement.request.post("/api/auth/password/login", {
          data: { tenantId, usernameOrEmail: exam.username, password },
        })
      ).status(),
    ).toBe(200);
    await replacement.goto("/");
    await replacement.getByTestId(`student-assessment-action-${exam.assignmentId}`).click();
    await expect(replacement.getByRole("alert")).toContainText("another workstation");
    const code = await replacement.getByTestId("replacement-workstation-code").textContent();
    expect(code).toBeTruthy();
    expect(
      (
        await replacement.request.post(`/api/instructor/attempts/${attemptId}/actions`, {
          data: { type: "transfer-workstation", clientSessionId: code },
        })
      ).status(),
    ).toBe(403);

    const staffName = `invigilator-${crypto.randomUUID()}`;
    const staffAccount = await request.post(`${api}/internal/auth/password/accounts`, {
      headers: adminHeaders,
      data: {
        tenantId,
        username: staffName,
        email: `${staffName}@example.test`,
        displayName: "Assigned invigilator",
        password,
      },
    });
    expect(staffAccount.status()).toBe(201);
    const identity: unknown = await staffAccount.json();
    if (
      !identity ||
      typeof identity !== "object" ||
      !("learnerId" in identity) ||
      typeof identity.learnerId !== "string"
    )
      throw new Error("Invalid invigilator fixture");
    expect(
      (
        await request.put(`${api}/internal/staff/grants/${staffName}`, {
          headers: adminHeaders,
          data: {
            tenantId,
            learnerId: identity.learnerId,
            role: "invigilator",
            assignmentId: exam.assignmentId,
          },
        })
      ).status(),
    ).toBe(200);
    const staff = await staffContext.newPage();
    expect(
      (
        await staff.request.post("/api/auth/password/login", {
          data: { tenantId, usernameOrEmail: staffName, password },
        })
      ).status(),
    ).toBe(200);
    await staff.goto("/roster");
    await expect(staff.getByTestId("last-server-response-save")).toContainText("2026");
    await staff.getByLabel("Replacement workstation code", { exact: true }).fill(code ?? "");
    await staff
      .getByLabel("Transfer reason", { exact: true })
      .fill("Workstation A failed; identity checked at B");
    const transferred = staff.waitForResponse(
      (response) =>
        response.url().endsWith(`/attempts/${attemptId}/actions`) &&
        response.request().method() === "POST",
    );
    await staff.getByRole("button", { name: "Transfer workstation", exact: true }).click();
    expect((await transferred).status()).toBe(200);

    await replacement.getByTestId(`student-assessment-action-${exam.assignmentId}`).click();
    await expect(replacement.getByTestId("attempt-id")).toHaveText(attemptId ?? "");
    await expect(replacement.getByTestId("assessment-version-id")).toHaveText(
      exam.assessmentVersionId,
    );
    await expect(replacement.getByTestId("current-item-id")).toHaveText("item-2");
    const recovered = await readBrowserRecoveryWitness(replacement);
    expect(recovered.expiresAt).toEqual(originalRecovery.expiresAt);
    expect(recovered.policy).toEqual(originalRecovery.policy);
    await replacement.getByRole("textbox").fill("A new answer from B.");
    await expect(replacement.getByTestId("response-save-status")).toContainText("Server confirmed");
    await replacement.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(replacement.getByRole("radio", { name: "B. Blue", exact: true })).toBeChecked();
    await expect(replacement.getByRole("textbox")).toHaveValue(
      "The accepted essay from workstation A.",
    );
    await expect(replacement.getByRole("listitem").nth(1)).toContainText("Act");

    await page.getByRole("textbox").fill("Stale A must not overwrite B.");
    await expect(page.getByTestId("replay-status")).toContainText("no longer current");
    await expect(page.getByTestId("save-response-button")).toBeDisabled();
    expect(
      (
        await page.request.post("/api/bootstrap", {
          data: {
            bootstrapToken: originalRecovery.bootstrapToken,
            clientSessionId: originalRecovery.clientSessionId,
          },
        })
      ).status(),
    ).toBe(409);
    await page.reload();
    await expect(page.getByTestId("replay-status")).toContainText("no longer current");
    // Cached recovery stops before loading content when this workstation no longer owns the attempt.
    await expect(page.getByTestId("save-response-button")).toHaveCount(0);
    await expect(page.getByTestId("submit-attempt-button")).toBeDisabled();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByTestId("pending-event-count")).not.toHaveText("0");
    await replacement.getByRole("button", { name: "Next", exact: true }).click();
    await expect(replacement.getByRole("textbox")).toHaveValue("A new answer from B.");
    const timeline = await staff.request.get(`/api/instructor/attempts/${attemptId}/timeline`);
    expect(timeline.status()).toBe(200);
    expect(await timeline.text()).toContain("Workstation A failed; identity checked at B");
  } finally {
    await replacementContext.close();
    await staffContext.close();
  }
});

/** Observe the actual cached bootstrap to compare pinned policy/time, without printing credentials. */
async function readBrowserRecoveryWitness(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const cached: unknown = JSON.parse(
      sessionStorage.getItem("harbor.bootstrappedSession") ?? "null",
    );
    if (
      !cached ||
      typeof cached !== "object" ||
      !("session" in cached) ||
      !cached.session ||
      typeof cached.session !== "object"
    )
      throw new Error("Missing recovery cache");
    const session = cached.session;
    if (
      !("payload" in session) ||
      !session.payload ||
      typeof session.payload !== "object" ||
      !("envelope" in session) ||
      !session.envelope ||
      typeof session.envelope !== "object" ||
      !("bootstrapToken" in session.envelope)
    )
      throw new Error("Invalid cached bootstrap");
    const payload = session.payload;
    if (
      !("session" in payload) ||
      !payload.session ||
      typeof payload.session !== "object" ||
      !("timing" in payload.session) ||
      !payload.session.timing ||
      typeof payload.session.timing !== "object" ||
      !("expiresAt" in payload.session.timing)
    )
      throw new Error("Missing pinned timing");
    return {
      bootstrapToken: session.envelope.bootstrapToken,
      clientSessionId: sessionStorage.getItem("harbor.clientSessionId"),
      expiresAt: payload.session.timing.expiresAt,
      policy: "policy" in payload ? payload.policy : null,
    };
  });
}
