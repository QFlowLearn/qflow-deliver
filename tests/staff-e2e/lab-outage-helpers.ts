import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { adminHeaders, api, password, tenantId } from "./lab-recovery-fixture";

export async function signInOutageStaff(
  admin: APIRequestContext,
  staff: APIRequestContext,
  assignmentId: string | null = null,
) {
  const username = `outage-staff-${crypto.randomUUID()}`;
  const created = await admin.post(`${api}/internal/auth/password/accounts`, {
    headers: adminHeaders,
    data: {
      tenantId,
      username,
      email: `${username}@example.test`,
      displayName: "Outage coordinator",
      password,
    },
  });
  expect(created.status()).toBe(201);
  const account: unknown = await created.json();
  if (
    !account ||
    typeof account !== "object" ||
    !("learnerId" in account) ||
    typeof account.learnerId !== "string"
  )
    throw new Error("Invalid coordinator account");
  const grant = await admin.put(`${api}/internal/staff/grants/${username}`, {
    headers: adminHeaders,
    data: {
      tenantId,
      learnerId: account.learnerId,
      role: assignmentId ? "invigilator" : "assessment-manager",
      assignmentId,
    },
  });
  expect(grant.status()).toBe(200);
  expect(
    (
      await staff.post(`${api}/api/auth/password/login`, {
        data: { tenantId, usernameOrEmail: username, password },
      })
    ).status(),
  ).toBe(200);
  return account.learnerId;
}

export async function readTimingWitness(request: APIRequestContext, attemptId: string) {
  const response = await request.get(`${api}/api/attempts/${attemptId}/policy`);
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("timing" in body) ||
    !body.timing ||
    typeof body.timing !== "object" ||
    !("expiresAt" in body.timing) ||
    typeof body.timing.expiresAt !== "string" ||
    !("acceptUntil" in body.timing) ||
    typeof body.timing.acceptUntil !== "string" ||
    !("policy" in body) ||
    !body.policy ||
    typeof body.policy !== "object" ||
    !("timing" in body.policy) ||
    !body.policy.timing ||
    typeof body.policy.timing !== "object" ||
    !("additionalTimeSeconds" in body.policy.timing) ||
    typeof body.policy.timing.additionalTimeSeconds !== "number" ||
    !("attemptStatus" in body) ||
    typeof body.attemptStatus !== "string"
  )
    throw new Error("Invalid timing witness");
  return {
    expiresAt: body.timing.expiresAt,
    acceptUntil: body.timing.acceptUntil,
    additionalTimeSeconds: body.policy.timing.additionalTimeSeconds,
    status: body.attemptStatus,
  };
}

export async function readOneFinalizedAttempt(page: Page, attemptId: string) {
  let finalResult: unknown;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${api}/api/attempts/${attemptId}/history`);
        expect(response.status()).toBe(200);
        const body: unknown = await response.json();
        if (
          !body ||
          typeof body !== "object" ||
          !("attempts" in body) ||
          !Array.isArray(body.attempts)
        )
          throw new Error("Invalid result history");
        // An auto-submit with no client summary becomes visible after its asynchronous finalization.
        if (body.attempts.length === 0) return "pending";
        expect(body.attempts).toHaveLength(1);
        const result: unknown = body.attempts[0];
        if (
          !result ||
          typeof result !== "object" ||
          !("finalization" in result) ||
          !result.finalization ||
          typeof result.finalization !== "object" ||
          !("status" in result.finalization)
        )
          throw new Error("Invalid finalization witness");
        finalResult = result;
        return result.finalization.status;
      },
      { timeout: 15000 },
    )
    .toBe("complete");
  return finalResult;
}

export async function expectOneFinalizedAnswerSet(page: Page, attemptId: string) {
  const finalResult = await readOneFinalizedAttempt(page, attemptId);
  expect(finalResult).toMatchObject({
    attemptId,
    itemCount: 2,
    answeredItemCount: 2,
    items: [
      {
        itemId: "item-1",
        responseSummary: expect.stringContaining("Final answer to question one."),
      },
      {
        itemId: "item-2",
        responseSummary: expect.stringContaining("Final answer to question two."),
      },
    ],
  });
  return finalResult;
}
