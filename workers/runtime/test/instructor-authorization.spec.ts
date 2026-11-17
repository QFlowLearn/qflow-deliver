import JSZip from "jszip";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAttemptEntry } from "../src/launch/create-preview-attempt";
import runtimeWorker, { type Env } from "../src/index";
import {
  ensureLearnerIdentity,
  createHarborSession,
  buildSessionCookieHeader,
} from "../src/routes/auth/session";
import { STAFF_ROUTES, matchStaffRoute } from "../src/staff/routes";
import { createInstructorRoutes } from "../src/routes/instructor/index";
import { createOneRosterPreview } from "../src/provisioning/oneroster-rest-preview";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const runtimeEnv: Env = {
  ...env,
  ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH: undefined,
  ALLOW_UNSAFE_LOCAL_INTERNAL_API: undefined,
  ALLOW_UNSAFE_LOCAL_INSTITUTIONAL_AUTH: undefined,
};
const origin = "https://lab.example";
async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    admin?: boolean;
    adminKey?: string;
    runtime?: Env;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.admin) headers.set("x-harbor-admin-key", env.HARBOR_ADMIN_KEY ?? "");
  if (options.adminKey !== undefined) headers.set("x-harbor-admin-key", options.adminKey);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return runtimeWorker.fetch(
    new Request(`${origin}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    options.runtime ?? runtimeEnv,
    createExecutionContext(),
  );
}
async function identity(
  tenantId = "tenant_auth",
  suffix = crypto.randomUUID(),
  issuer = "https://identity.example",
) {
  const learner = await ensureLearnerIdentity({
    db: env.HARBOR_DB,
    tenantId,
    providerKind: "institutional-sso",
    issuer,
    subject: suffix,
    displayName: `Staff ${suffix}`,
  });
  const session = await createHarborSession({
    db: env.HARBOR_DB,
    learner,
    providerKind: "institutional-sso",
    issuer,
    subject: suffix,
  });
  const cookie = await buildSessionCookieHeader(
    session.id,
    env.BOOTSTRAP_SIGNING_SECRET,
    session.expiresAt,
  );
  return { learner, session, cookie };
}
async function grant(
  learnerId: string,
  role: string,
  assignmentId: string | null = null,
  tenantId = "tenant_auth",
) {
  const id = `grant_${crypto.randomUUID()}`;
  const response = await request(`/internal/staff/grants/${id}`, {
    method: "PUT",
    admin: true,
    body: { tenantId, learnerId, role, assignmentId },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return id;
}
async function publish() {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifestXml);
  zip.file("items/item-1.xml", itemXml);
  zip.file("assets/stimulus.svg", stimulusSvg);
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  const response = await runtimeWorker.fetch(
    new Request(`${origin}/internal/publish?assessmentSlug=auth-${crypto.randomUUID()}`, {
      method: "POST",
      headers: {
        "x-harbor-admin-key": env.HARBOR_ADMIN_KEY ?? "",
        "x-harbor-tenant-id": "tenant_auth",
        "x-harbor-package-name": "authorization.zip",
        "content-type": "application/zip",
      },
      body: bytes,
    }),
    runtimeEnv,
    createExecutionContext(),
  );
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("assessmentId" in body) ||
    typeof body.assessmentId !== "string" ||
    !("assessmentVersionId" in body) ||
    typeof body.assessmentVersionId !== "string"
  )
    throw new Error("Invalid publication fixture");
  return { assessmentId: body.assessmentId, assessmentVersionId: body.assessmentVersionId };
}
async function assignment() {
  const published = await publish();
  const assignmentId = `assignment_${crypto.randomUUID()}`;
  const response = await request("/internal/assignments", {
    method: "POST",
    admin: true,
    body: {
      ...published,
      assignmentId,
      title: "Lab exam",
      status: "active",
      actor: { role: "system", actorId: "fixture" },
      policySnapshot: {
        reportingTimezone: "America/New_York",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        navigationMode: "linear",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
      },
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return { ...published, assignmentId };
}
beforeEach(async () => {
  await applyD1Migrations(env.HARBOR_DB, env.TEST_MIGRATIONS);
  await env.HARBOR_DB.exec(
    "DELETE FROM staff_access_events; DELETE FROM staff_grants; DELETE FROM harbor_sessions; DELETE FROM learner_identities; DELETE FROM harbor_learners;",
  );
});
describe("staff authorization boundary", () => {
  it("maps every registered instructor route and fails unknown management operations closed", async () => {
    const router = createInstructorRoutes({
      oneRosterPreview: createOneRosterPreview({ fetcher: fetch }),
    });
    for (const actual of router.routes) {
      if (actual.method === "ALL") continue;
      expect(
        matchStaffRoute(actual.method, actual.path),
        `${actual.method} ${actual.path}`,
      ).not.toBeNull();
    }
    const staff = await identity();
    await grant(staff.learner.id, "tenant-administrator");
    expect(
      (await request("/api/instructor/new-unmapped-operation", { cookie: staff.cookie })).status,
    ).toBe(403);
  });
  it("denies every management route to candidates, including their own tenant", async () => {
    const candidate = await identity();
    for (const route of STAFF_ROUTES) {
      const path = route.path.replace(/:[A-Za-z]+/g, "fixture");
      const response = await request(`/api/instructor${path}`, {
        method: route.method,
        body:
          route.method === "GET"
            ? undefined
            : { actor: { role: "tenant-administrator", actorId: candidate.learner.id } },
        cookie: candidate.cookie,
      });
      expect(response.status, `${route.method} ${path}`).toBe(403);
    }
    expect((await request("/api/instructor/assignments")).status).toBe(401);
    await env.HARBOR_DB.prepare("UPDATE harbor_sessions SET expires_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", candidate.session.id)
      .run();
    expect(
      (await request("/api/instructor/assignments", { cookie: candidate.cookie })).status,
    ).toBe(401);
  });
  it("requires explicit privileged provisioning, rejects cross-tenant/scopeless grants, and never reactivates revoked grants", async () => {
    const candidate = await identity();
    const id = `grant_${crypto.randomUUID()}`;
    const command = {
      tenantId: "tenant_auth",
      learnerId: candidate.learner.id,
      role: "tenant-administrator",
    };
    expect(
      (
        await request(`/internal/staff/grants/${id}`, {
          method: "PUT",
          body: command,
          runtime: { ...runtimeEnv, ALLOW_UNSAFE_LOCAL_INTERNAL_API: "true" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(`/internal/staff/grants/${id}`, {
          method: "PUT",
          body: command,
          cookie: candidate.cookie,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(`/internal/staff/grants/${id}`, {
          method: "PUT",
          admin: true,
          body: { ...command, tenantId: "other" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/internal/staff/grants/${id}`, {
          method: "PUT",
          admin: true,
          body: { ...command, role: "invigilator" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(`/internal/staff/grants/${id}`, { method: "PUT", admin: true, body: command }))
        .status,
    ).toBe(200);
    expect(
      (await request(`/internal/staff/grants/${id}`, { method: "PUT", admin: true, body: command }))
        .status,
    ).toBe(200);
    expect(
      (await request(`/internal/staff/grants/${id}`, { method: "DELETE", admin: true })).status,
    ).toBe(200);
    expect(
      (await request(`/internal/staff/grants/${id}`, { method: "PUT", admin: true, body: command }))
        .status,
    ).toBe(409);
  });
  it("records rejected privileged grant requests without their credentials or body", async () => {
    const staff = await identity();
    const body = {
      tenantId: "tenant_auth",
      learnerId: staff.learner.id,
      role: "tenant-administrator",
      unrecognized: "must-not-be-logged",
    };
    expect(
      (await request("/internal/staff/grants/audit-rejection", { method: "PUT", body })).status,
    ).toBe(401);
    expect(
      (
        await request("/internal/staff/grants/audit-rejection", {
          method: "PUT",
          body,
          adminKey: "incorrect-admin-credential",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("/internal/staff/grants/audit-rejection", {
          method: "PUT",
          body,
          admin: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/internal/staff/grants/no-such-grant", { method: "DELETE", admin: true }))
        .status,
    ).toBe(404);
    const events = await env.HARBOR_DB.prepare(
      "SELECT operation,outcome,response_status FROM staff_access_events ORDER BY rowid",
    ).all();
    expect(events.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "staff-grant.access",
          outcome: "denied",
          response_status: 401,
        }),
        expect.objectContaining({
          operation: "staff-grant.create",
          outcome: "failed",
          response_status: 400,
        }),
        expect.objectContaining({
          operation: "staff-grant.revoke",
          outcome: "failed",
          response_status: 404,
        }),
      ]),
    );
    expect(
      events.results.filter((row) => row.outcome === "denied" && row.response_status === 401),
    ).toHaveLength(2);
    const serialized = JSON.stringify(events.results);
    expect(serialized).not.toContain("must-not-be-logged");
    expect(serialized).not.toContain(env.HARBOR_ADMIN_KEY ?? "missing-credential");
  });
  it("checks grants afresh on the next request and records safe outcomes", async () => {
    const staff = await identity();
    const id = await grant(staff.learner.id, "tenant-administrator");
    expect((await request("/api/instructor/assignments", { cookie: staff.cookie })).status).toBe(
      200,
    );
    expect(
      (await request(`/internal/staff/grants/${id}`, { method: "DELETE", admin: true })).status,
    ).toBe(200);
    expect((await request("/api/instructor/assignments", { cookie: staff.cookie })).status).toBe(
      403,
    );
    const rows = await env.HARBOR_DB.prepare(
      "SELECT actor_id,actor_role,outcome,response_status FROM staff_access_events WHERE actor_id = ? ORDER BY rowid",
    )
      .bind(staff.learner.id)
      .all();
    expect(rows.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_id: staff.learner.id,
          actor_role: "tenant-administrator",
          outcome: "completed",
          response_status: 200,
        }),
        expect.objectContaining({
          actor_id: staff.learner.id,
          outcome: "denied",
          response_status: 403,
        }),
      ]),
    );
    const evidence = JSON.stringify(rows.results);
    expect(evidence).not.toContain(staff.cookie);
    expect(evidence).not.toContain(env.BOOTSTRAP_SIGNING_SECRET);
  });
  it("limits invigilators to granted assignments and scorers to scoring authority", async () => {
    const a = await assignment();
    const b = await assignment();
    const staff = await identity();
    await grant(staff.learner.id, "invigilator", a.assignmentId);
    const invigilatorCapabilities = await request(
      `/api/instructor/assignments/${a.assignmentId}/capabilities`,
      { cookie: staff.cookie },
    );
    expect(invigilatorCapabilities.status).toBe(200);
    expect(await invigilatorCapabilities.json()).toEqual({
      assignmentId: a.assignmentId,
      canOperateExam: true,
      canReadResults: false,
      canScoreResults: false,
      canManageAccommodations: false,
    });
    const list = await request("/api/instructor/assignments", { cookie: staff.cookie });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ assignments: [{ assignmentId: a.assignmentId }] });
    expect(
      (await request(`/api/instructor/assignments/${a.assignmentId}`, { cookie: staff.cookie }))
        .status,
    ).toBe(200);
    expect(
      (await request(`/api/instructor/assignments/${b.assignmentId}`, { cookie: staff.cookie }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(`/api/instructor/assignments/${a.assignmentId}/close`, {
          method: "POST",
          cookie: staff.cookie,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/instructor/assignments/${a.assignmentId}/score-amendments`, {
          method: "POST",
          cookie: staff.cookie,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/instructor/provisioning/runs", { cookie: staff.cookie })).status,
    ).toBe(403);
    const scorer = await identity();
    await grant(scorer.learner.id, "scorer", a.assignmentId);
    const scorerCapabilities = await request(
      `/api/instructor/assignments/${a.assignmentId}/capabilities`,
      { cookie: scorer.cookie },
    );
    expect(scorerCapabilities.status).toBe(200);
    expect(await scorerCapabilities.json()).toEqual({
      assignmentId: a.assignmentId,
      canOperateExam: false,
      canReadResults: true,
      canScoreResults: true,
      canManageAccommodations: false,
    });
    expect(
      (
        await request(`/api/instructor/manual-scoring?assignmentId=${a.assignmentId}`, {
          cookie: scorer.cookie,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/instructor/manual-scoring?assignmentId=${b.assignmentId}`, {
          cookie: scorer.cookie,
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/instructor/manual-scoring", { cookie: scorer.cookie })).status,
    ).toBe(403);
  });
  it("allows an assigned invigilator intervention and binds its timeline actor to the session", async () => {
    const a = await assignment();
    const b = await assignment();
    const invigilator = await identity();
    await grant(invigilator.learner.id, "invigilator", a.assignmentId);
    const attempt = await createAttemptEntry({
      db: env.HARBOR_DB,
      bucket: env.CONTENT_BUCKET,
      assessmentVersionId: a.assessmentVersionId,
      assignmentId: a.assignmentId,
      launch: {
        mode: "preview",
        actor: { kind: "preview-operator", id: "candidate-fixture", displayName: "Candidate" },
      },
    });
    const action = {
      actionId: crypto.randomUUID(),
      type: "extend-time",
      additionalTimeSeconds: 120,
      reason: "Workstation recovery",
      effectiveAt: new Date().toISOString(),
      actor: { role: "system", actorId: "forged", displayName: "Forged" },
    };
    const applied = await request(`/api/instructor/attempts/${attempt.attemptId}/actions`, {
      method: "POST",
      cookie: invigilator.cookie,
      body: action,
    });
    expect(applied.status, await applied.clone().text()).toBe(200);
    const transferAction = {
      actionId: crypto.randomUUID(),
      type: "transfer-workstation",
      clientSessionId: "replacement-secret-code",
      reason: "Verified replacement workstation",
      effectiveAt: new Date().toISOString(),
      actor: { role: "system", actorId: "forged" },
    };
    const transfer = await request(`/api/instructor/attempts/${attempt.attemptId}/actions`, {
      method: "POST",
      cookie: invigilator.cookie,
      body: transferAction,
    });
    expect(transfer.status).toBe(200);
    const duplicateTransfer = await request(
      `/api/instructor/attempts/${attempt.attemptId}/actions`,
      { method: "POST", cookie: invigilator.cookie, body: transferAction },
    );
    expect(duplicateTransfer.status).toBe(200);
    const scorer = await identity();
    await grant(scorer.learner.id, "scorer", a.assignmentId);
    expect(
      (
        await request(`/api/instructor/attempts/${attempt.attemptId}/actions`, {
          method: "POST",
          cookie: scorer.cookie,
          body: transferAction,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/instructor/attempts/${attempt.attemptId}/actions`, {
          method: "POST",
          cookie: invigilator.cookie,
          body: { ...transferAction, clientSessionId: "changed-code" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/api/instructor/attempts/${attempt.attemptId}/actions`, {
          method: "POST",
          cookie: invigilator.cookie,
          body: {
            ...transferAction,
            actionId: crypto.randomUUID(),
            clientSessionId: "next-replacement",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/instructor/attempts/${attempt.attemptId}/actions`, {
          method: "POST",
          cookie: invigilator.cookie,
          body: transferAction,
        })
      ).status,
    ).toBe(409);
    const timeline = await request(`/api/instructor/attempts/${attempt.attemptId}/timeline`, {
      cookie: invigilator.cookie,
    });
    expect(timeline.status).toBe(200);
    expect(await timeline.clone().text()).not.toContain("replacement-secret-code");
    expect(await timeline.json()).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          eventType: "override",
          actor: {
            role: "invigilator",
            actorId: invigilator.learner.id,
            displayName: invigilator.learner.displayName,
          },
          reason: "Workstation recovery",
        }),
      ]),
    });
    const other = await createAttemptEntry({
      db: env.HARBOR_DB,
      bucket: env.CONTENT_BUCKET,
      assessmentVersionId: b.assessmentVersionId,
      assignmentId: b.assignmentId,
      launch: {
        mode: "preview",
        actor: { kind: "preview-operator", id: "other-candidate", displayName: "Candidate" },
      },
    });
    expect(
      (
        await request(`/api/instructor/attempts/${other.attemptId}/actions`, {
          method: "POST",
          cookie: invigilator.cookie,
          body: action,
        })
      ).status,
    ).toBe(403);
  });
  it("derives command actor from authenticated manager and rejects cross-tenant access", async () => {
    const a = await assignment();
    const manager = await identity();
    await grant(manager.learner.id, "assessment-manager");
    const capabilities = await request(
      `/api/instructor/assignments/${a.assignmentId}/capabilities`,
      { cookie: manager.cookie },
    );
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({
      assignmentId: a.assignmentId,
      canOperateExam: true,
      canReadResults: true,
      canScoreResults: false,
      canManageAccommodations: true,
    });
    const response = await request("/api/instructor/assignments", {
      method: "POST",
      cookie: manager.cookie,
      body: {
        assignmentId: `managed_${crypto.randomUUID()}`,
        assessmentId: a.assessmentId,
        assessmentVersionId: a.assessmentVersionId,
        title: "Managed exam",
        policySnapshot: {
          reportingTimezone: "America/New_York",
          maxAttempts: 1,
          navigationMode: "linear",
          standaloneAllowed: true,
          iframeAllowed: false,
          allowedEmbedOrigins: [],
          secureBrowserRequired: false,
        },
        actor: { role: "system", actorId: "forged", displayName: "Forged" },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({
      createdBy: {
        role: "assessment-manager",
        actorId: manager.learner.id,
        displayName: manager.learner.displayName,
      },
    });
    expect(
      (
        await request(`/api/instructor/assignments/${a.assignmentId}/score-amendments`, {
          method: "POST",
          cookie: manager.cookie,
          body: {},
        })
      ).status,
    ).toBe(403);
    const outsider = await identity("tenant_other");
    await grant(outsider.learner.id, "tenant-administrator", null, "tenant_other");
    expect(
      (await request(`/api/instructor/assignments/${a.assignmentId}`, { cookie: outsider.cookie }))
        .status,
    ).toBe(404);
    const failure = await env.HARBOR_DB.prepare(
      "SELECT outcome,response_status FROM staff_access_events WHERE actor_id = ? ORDER BY rowid DESC LIMIT 1",
    )
      .bind(outsider.learner.id)
      .first();
    expect(failure).toMatchObject({ outcome: "failed", response_status: 404 });
  });
  it("blocks institutional demo routes on deployed origins and rejects demo sessions as staff", async () => {
    for (const path of [
      "/api/auth/institutional/login?profile=demo-student",
      "/api/auth/institutional/callback?state=fixture&code=fixture",
      "/internal/mock-institutional/authorize?state=fixture",
    ]) {
      const response = await request(path, {
        admin: path.startsWith("/internal/"),
        runtime: { ...runtimeEnv, ALLOW_UNSAFE_LOCAL_INSTITUTIONAL_AUTH: "true" },
      });
      expect(response.status, path).toBe(503);
    }
    const demo = await identity(
      "tenant_auth",
      crypto.randomUUID(),
      "https://institution.harbor.local",
    );
    await grant(demo.learner.id, "tenant-administrator");
    expect((await request("/api/instructor/assignments", { cookie: demo.cookie })).status).toBe(
      403,
    );
  });
  it("rejects expired grants and local demo bypass on deployed origins", async () => {
    const staff = await identity();
    const id = await grant(staff.learner.id, "tenant-administrator");
    await env.HARBOR_DB.prepare("UPDATE staff_grants SET expires_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", id)
      .run();
    expect((await request("/api/instructor/assignments", { cookie: staff.cookie })).status).toBe(
      403,
    );
    expect(
      (
        await request("/api/instructor/assignments", {
          runtime: { ...runtimeEnv, ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH: "true" },
        })
      ).status,
    ).toBe(503);
  });
});
