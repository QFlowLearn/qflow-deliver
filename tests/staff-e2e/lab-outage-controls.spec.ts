import { expect, test } from "@playwright/test";
import { api, seedRecoveryExam, signInAndOpen } from "./lab-recovery-fixture";
import { readTimingWitness, signInOutageStaff } from "./lab-outage-helpers";

test("an assigned invigilator records a chosen duration and real incident reason from the roster", async ({
  page,
  request,
  browser,
}, testInfo) => {
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  const attemptId = await page.getByTestId("attempt-id").innerText();
  const before = await readTimingWitness(page.request, attemptId);
  const staffContext = await browser.newContext({ baseURL: "http://127.0.0.1:4175" });
  try {
    const staff = await staffContext.newPage();
    const actorId = await signInOutageStaff(request, staff.request, exam.assignmentId);
    await staff.goto("/roster");
    await expect(staff.getByTestId(`roster-row-${exam.learnerId}`)).toBeVisible();
    const form = staff.getByRole("form", { name: "Timing intervention" });
    await form.getByRole("button", { name: "Extend time", exact: true }).click();
    expect(
      await form
        .getByLabel("Incident reason", { exact: true })
        .evaluate((input) => input instanceof HTMLTextAreaElement && input.validity.valueMissing),
    ).toBe(true);
    const reason = "Network interruption verified at workstation 4; award two minutes";
    await form.getByLabel("Incident reason", { exact: true }).fill(reason);
    await form.getByLabel("Minutes", { exact: true }).fill("0");
    await form.getByRole("button", { name: "Extend time", exact: true }).click();
    expect(await readTimingWitness(page.request, attemptId)).toEqual(before);
    expect(
      await form
        .getByLabel("Minutes", { exact: true })
        .evaluate((input) => input instanceof HTMLInputElement && input.validity.rangeUnderflow),
    ).toBe(true);
    await form.getByLabel("Minutes", { exact: true }).fill("2");
    await testInfo.attach("timing-controls-desktop.png", {
      contentType: "image/png",
      body: await form.screenshot(),
    });
    const extended = staff.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/attempts/${attemptId}/actions`),
    );
    await form.getByRole("button", { name: "Extend time", exact: true }).click();
    expect((await extended).status()).toBe(200);
    await expect(form.getByLabel("Incident reason", { exact: true })).toHaveValue("");
    const after = await readTimingWitness(page.request, attemptId);
    expect(after.additionalTimeSeconds).toBe(120);
    expect(Date.parse(after.expiresAt) - Date.parse(before.expiresAt)).toBe(120_000);
    const timeline = await staff.request.get(
      `${api}/api/instructor/attempts/${attemptId}/timeline`,
    );
    expect(await timeline.json()).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ actor: expect.objectContaining({ actorId }), reason }),
      ]),
    });
    const reopenReason = "Authorize a seven minute recovery window after identity check";
    await form.getByLabel("Incident reason", { exact: true }).fill(reopenReason);
    await form.getByLabel("Minutes", { exact: true }).fill("7");
    await staff.setViewportSize({ width: 390, height: 844 });
    await form.scrollIntoViewIfNeeded();
    const bounds = await form.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.x ?? -1) + (bounds?.width ?? 1000)).toBeLessThanOrEqual(390);
    await testInfo.attach("timing-controls-mobile.png", {
      contentType: "image/png",
      body: await form.screenshot(),
    });
    const issuedAt = Date.now();
    const reopened = staff.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/attempts/${attemptId}/actions`),
    );
    await form.getByRole("button", { name: "Reopen", exact: true }).click();
    const applied = await reopened;
    expect(applied.status()).toBe(200);
    const result: unknown = await applied.json();
    expect(result).toMatchObject({
      attemptStatus: "reopened",
      policy: { reopen: { status: "reopened" } },
    });
    if (
      !result ||
      typeof result !== "object" ||
      !("policy" in result) ||
      !result.policy ||
      typeof result.policy !== "object" ||
      !("reopen" in result.policy) ||
      !result.policy.reopen ||
      typeof result.policy.reopen !== "object" ||
      !("reopenUntil" in result.policy.reopen) ||
      typeof result.policy.reopen.reopenUntil !== "string"
    )
      throw new Error("Missing authorized recovery window");
    expect(Date.parse(result.policy.reopen.reopenUntil) - issuedAt).toBeGreaterThanOrEqual(
      7 * 60_000,
    );
    expect(Date.parse(result.policy.reopen.reopenUntil) - issuedAt).toBeLessThan(7 * 60_000 + 5000);
    const finalTimeline = await staff.request.get(
      `${api}/api/instructor/attempts/${attemptId}/timeline`,
    );
    expect(await finalTimeline.json()).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          actor: expect.objectContaining({ actorId }),
          reason: reopenReason,
        }),
      ]),
    });
  } finally {
    await staffContext.close();
  }
});
