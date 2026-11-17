import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AssignmentLearnerOverrideRecord,
  AttemptPolicyReadResponse,
  AttemptTimelineResponse,
  BootstrapEnvelope,
  BootstrapPayload,
  InstructorAssignmentListResponse,
} from "@harbor/attempt-protocol";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";
import qflowPartSettingsPackage from "../../../tests/fixtures/qti/part-settings/qflow-part-settings.zip.b64?raw";
import { ensureLearnerIdentity } from "../src/routes/auth/session";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET: string;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    BOOTSTRAP_SIGNING_SECRET: string;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetDb(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "assignment_learner_overrides",
    "attempt_timeline_events",
    "attempt_policy_commands",
    "attempt_policy_overlays",
    "lti_resource_links",
    "lti_launch_states",
    "lti_registrations",
    "institutional_auth_states",
    "harbor_sessions",
    "assignment_section_targets",
    "assignment_learner_targets",
    "section_memberships",
    "sections",
    "learner_identities",
    "harbor_learners",
    "attempt_results",
    "result_finalizations",
    "attempt_entries",
    "access_codes",
    "assignments",
    "delivery_artifacts",
    "assessment_versions",
    "assessments",
  ];

  const tables = await HARBOR_DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${knownTables
      .map(() => "?")
      .join(", ")})`,
  )
    .bind(...knownTables)
    .all<{ name: string }>();

  const deleteStatements = knownTables
    .filter((tableName) => tables.results.some((table) => table.name === tableName))
    .map((tableName) => `DELETE FROM ${tableName}`);

  if (deleteStatements.length > 0) {
    await HARBOR_DB.exec(`${deleteStatements.join("; ")};`);
  }

  let cursor: string | undefined;
  do {
    const listed = await CONTENT_BUCKET.list({ cursor });
    await Promise.all(listed.objects.map((object) => CONTENT_BUCKET.delete(object.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function createFixturePackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifestXml);
  zip.file("items/item-1.xml", itemXml);
  zip.file("assets/stimulus.svg", stimulusSvg);
  return zip.generateAsync({ type: "uint8array" });
}

async function publishFixture(input: { tenantId: string; assessmentSlug: string }): Promise<{
  assessmentId: string;
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "instructor-operations.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function postJson(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function putJson(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "PUT",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string, headers?: Record<string, string>): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
      redirect: "manual",
      headers,
    }),
  );
}

async function exchangeBootstrap(bootstrapToken: string): Promise<BootstrapPayload> {
  const response = await postJson("/api/bootstrap", { bootstrapToken });
  expect(response.status).toBe(200);
  return response.json<BootstrapPayload>();
}

async function performInstitutionalLogin(): Promise<{
  cookie: string;
  session: { learner: { id: string; displayName: string } };
}> {
  const loginResponse = await get("/api/auth/institutional/login?redirectTo=/");
  expect(loginResponse.status).toBe(302);

  const authorizeLocation = loginResponse.headers.get("location");
  expect(authorizeLocation).toBeTruthy();
  const authorizeResponse = await get(authorizeLocation!);
  expect(authorizeResponse.status).toBe(302);

  const callbackLocation = authorizeResponse.headers.get("location");
  expect(callbackLocation).toBeTruthy();
  const callbackResponse = await get(callbackLocation!);
  expect(callbackResponse.status).toBe(302);

  const cookie = callbackResponse.headers.get("set-cookie");
  expect(cookie).toBeTruthy();

  const sessionResponse = await get("/api/auth/session", {
    cookie: cookie!,
  });
  expect(sessionResponse.status).toBe(200);

  return {
    cookie: cookie!,
    session: await sessionResponse.json(),
  };
}

beforeEach(async () => {
  await resetDb();
});

describe("instructor assignment operations", () => {
  it("enforces canonical QFlow part limits separately from learner overrides without rewriting published content", async () => {
    const packageBytes = Uint8Array.from(atob(qflowPartSettingsPackage), (value) =>
      value.charCodeAt(0),
    );
    const publishedResponse = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/publish?assessmentSlug=qflow-part-settings", {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-harbor-package-name": "qflow-part-settings.zip",
          "x-harbor-tenant-id": "tenant_local_demo",
        },
        body: packageBytes.buffer,
      }),
    );
    const published: unknown = await publishedResponse.json();
    expect(publishedResponse.status, JSON.stringify(published)).toBe(201);
    if (
      typeof published !== "object" ||
      published === null ||
      !("assessmentId" in published) ||
      typeof published.assessmentId !== "string" ||
      !("assessmentVersionId" in published) ||
      typeof published.assessmentVersionId !== "string" ||
      !("packageObjectKey" in published) ||
      typeof published.packageObjectKey !== "string"
    )
      throw new Error("Publication did not return its immutable version context");
    const bucket = getTestEnv().CONTENT_BUCKET;
    const storedPackage = await bucket.get(published.packageObjectKey);
    if (!storedPackage) throw new Error("The canonical package was not stored");
    expect(new Uint8Array(await storedPackage.arrayBuffer())).toEqual(packageBytes);
    const prefix = `tenants/tenant_local_demo/assessments/${published.assessmentId}/versions/${published.assessmentVersionId}/`;
    const listing = await bucket.list({ prefix });
    expect(listing.truncated).toBe(false);
    expect(listing.objects.length).toBeGreaterThanOrEqual(4);
    const originalObjects = new Map<string, Uint8Array>();
    for (const entry of listing.objects) {
      const object = await bucket.get(entry.key);
      if (!object) throw new Error("A published object disappeared before launch");
      originalObjects.set(entry.key, new Uint8Array(await object.arrayBuffer()));
    }
    const login = await performInstitutionalLogin();
    const actor = { role: "instructor", actorId: "inst_qflow_settings", displayName: "Instructor" };
    const assignmentId = "assign_qflow_part_settings";
    expect(
      (
        await postJson("/api/instructor/assignments", {
          assignmentId,
          assessmentId: published.assessmentId,
          assessmentVersionId: published.assessmentVersionId,
          title: "Canonical part settings assignment",
          status: "active",
          actor,
          policySnapshot: {
            availableFrom: null,
            availableUntil: null,
            reportingTimezone: "America/New_York",
            maxAttempts: 2,
            timeLimitSeconds: 1800,
            gracePeriodSeconds: 30,
            navigationMode: "linear",
            standaloneAllowed: true,
            iframeAllowed: false,
            allowedEmbedOrigins: [],
            secureBrowserRequired: false,
            secureBrowserProviderHint: null,
            proctoringProvider: null,
          },
          targets: [{ kind: "learner", learnerId: login.session.learner.id }],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await putJson(
          `/api/instructor/assignments/${assignmentId}/learners/${login.session.learner.id}/override`,
          {
            actor,
            policyOverrides: { additionalTimeSeconds: 120, timeLimitSeconds: 2400 },
            accommodations: { rendererPnp: { layoutSingleColumn: true }, sessionControl: {} },
          },
        )
      ).status,
    ).toBe(200);
    const launched = await postJson(
      "/api/launch/student",
      {
        assignmentId,
        source: "institutional-sso",
      },
      { cookie: login.cookie },
    );
    expect(launched.status).toBe(201);
    const envelope = await launched.json<BootstrapEnvelope>();
    const bootstrap = await postJson("/api/bootstrap", {
      bootstrapToken: envelope.bootstrapToken,
      clientSessionId: "qflow_part_settings_client",
    });
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();
    expect(payload.assessmentVersionId).toBe(published.assessmentVersionId);
    expect(payload.deliveryPolicy.timeLimitSeconds).toBe(2400);
    expect(payload.policy?.timing).toMatchObject({
      additionalTimeSeconds: 120,
      effectiveTimeLimitSeconds: 2520,
    });
    expect(payload.policy?.accommodations.rendererPnp.layoutSingleColumn).toBe(true);
    const contentResponse = await workerExports.default.fetch(
      new Request(
        `https://harbor.local/api/content/manifest?attemptId=${encodeURIComponent(payload.attemptId)}`,
      ),
    );
    expect(contentResponse.status).toBe(200);
    expect(await contentResponse.json()).toMatchObject({
      assessmentVersionId: published.assessmentVersionId,
      assessmentInstructions: [
        {
          scopeType: "test-part",
          scopeIdentifier: "part-1-8f5609ae-0d4b-4b5a-95f9-2763d36de275",
          title: "Part 1",
          itemIds: [
            "item-b35efecb-927b-46d4-a4e8-21950c2e44e0-r1",
            "item-83eb5274-d3d0-4c39-b559-534205a21b2c-r1",
          ],
          content: [
            {
              kind: "element",
              name: "section",
              children: [
                {
                  kind: "element",
                  name: "p",
                  children: [
                    {
                      kind: "text",
                      text: "Read every question before submitting.",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(
      payload.session.timing?.scopes?.find((scope) => scope.scopeType === "test-part"),
    ).toMatchObject({ minTimeSeconds: 60, maxTimeSeconds: 300, status: "interacting" });
    // Assignment timing does not replace the separately authored part minimum/maximum.
    const earlySubmit = await postJson(`/api/attempts/${payload.attemptId}/events`, {
      attemptId: payload.attemptId,
      eventId: "qflow_settings_early_submit",
      idempotencyKey: "qflow_settings_early_submit",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "qflow_part_settings_client",
      itemRef: payload.session.currentItemRef,
      type: "submit.requested",
      payload: { requestedAt: new Date().toISOString() },
    });
    expect(earlySubmit.status).toBe(409);
    expect(await earlySubmit.json()).toMatchObject({
      timingBlock: { scopeType: "test-part", minTimeSeconds: 60 },
    });
    const extended = await postJson(`/api/instructor/attempts/${payload.attemptId}/actions`, {
      actionId: "qflow_settings_extend",
      type: "extend-time",
      actor,
      reason: "Approved assessment extension",
      effectiveAt: new Date().toISOString(),
      additionalTimeSeconds: 90,
    });
    expect(extended.status).toBe(200);
    expect(await extended.json()).toMatchObject({
      policy: { timing: { additionalTimeSeconds: 210, effectiveTimeLimitSeconds: 2610 } },
    });
    const resumed = await exchangeBootstrap(envelope.bootstrapToken);
    expect(
      resumed.session.timing?.scopes?.find((scope) => scope.scopeType === "test-part"),
    ).toMatchObject({ minTimeSeconds: 60, maxTimeSeconds: 300 });
    expect(
      resumed.session.timing?.scopes?.find((scope) => scope.scopeType === "assessment-test"),
    ).toMatchObject({ maxTimeSeconds: 2610 });
    const after = await bucket.list({ prefix });
    expect(after.objects.map((entry) => entry.key)).toEqual(
      listing.objects.map((entry) => entry.key),
    );
    for (const [key, original] of originalObjects) {
      const object = await bucket.get(key);
      if (!object) throw new Error("Policy changes removed a published object");
      expect(new Uint8Array(await object.arrayBuffer())).toEqual(original);
    }
  });

  it("creates, updates, activates, closes, and lists assignments while persisting learner overrides", async () => {
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "instructor-assignment-ops",
    });
    const login = await performInstitutionalLogin();

    const createResponse = await postJson("/api/instructor/assignments", {
      assignmentId: "assign_instructor_ops_01",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Instructor Operations Draft",
      status: "draft",
      actor: {
        role: "instructor",
        actorId: "inst_01",
        displayName: "Instructor One",
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
        secureBrowserRequired: true,
        secureBrowserProviderHint: "Safe Exam Browser",
        proctoringProvider: "seb",
      },
      targets: [{ kind: "learner", learnerId: login.session.learner.id }],
    });
    expect(createResponse.status).toBe(201);

    const listResponse = await get("/api/instructor/assignments");
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json<InstructorAssignmentListResponse>();
    expect(list.assignments).toHaveLength(1);
    expect(list.assignments[0]).toMatchObject({
      assignmentId: "assign_instructor_ops_01",
      status: "draft",
      learnerTargetCount: 1,
      sectionTargetCount: 0,
    });

    const updateResponse = await putJson("/api/instructor/assignments/assign_instructor_ops_01", {
      title: "Instructor Operations Updated",
      actor: {
        role: "instructor",
        actorId: "inst_01",
        displayName: "Instructor One",
      },
      policySnapshot: {
        availableFrom: "2026-03-27T00:00:00.000Z",
        availableUntil: "2026-03-31T00:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 3,
        timeLimitSeconds: 2100,
        gracePeriodSeconds: 45,
        navigationMode: "linear",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
      targets: [{ kind: "learner", learnerId: login.session.learner.id }],
    });
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json<{
      title: string;
      policySnapshot: { maxAttempts: number };
    }>();
    expect(updated.title).toBe("Instructor Operations Updated");
    expect(updated.policySnapshot.maxAttempts).toBe(3);

    const activateResponse = await postJson(
      "/api/instructor/assignments/assign_instructor_ops_01/activate",
      {},
    );
    expect(activateResponse.status).toBe(200);
    expect((await activateResponse.json<{ status: string }>()).status).toBe("active");

    const overrideResponse = await putJson(
      `/api/instructor/assignments/assign_instructor_ops_01/learners/${login.session.learner.id}/override`,
      {
        actor: {
          role: "instructor",
          actorId: "inst_01",
          displayName: "Instructor One",
        },
        policyOverrides: {
          additionalTimeSeconds: 300,
          timeLimitSeconds: 2400,
          secureBrowserRequired: false,
        },
        accommodations: {
          rendererPnp: {
            layoutSingleColumn: true,
          },
          sessionControl: {
            allow_review: true,
          },
        },
      },
    );
    expect(overrideResponse.status).toBe(200);
    const override = await overrideResponse.json<AssignmentLearnerOverrideRecord>();
    expect(override.policyOverrides.additionalTimeSeconds).toBe(300);
    expect(override.policyOverrides.timeLimitSeconds).toBe(2400);
    expect(override.accommodations.rendererPnp.layoutSingleColumn).toBe(true);

    const overrideRead = await get(
      `/api/instructor/assignments/assign_instructor_ops_01/learners/${login.session.learner.id}/override`,
    );
    expect(overrideRead.status).toBe(200);
    expect((await overrideRead.json<AssignmentLearnerOverrideRecord>()).updatedBy.actorId).toBe(
      "inst_01",
    );

    const closeResponse = await postJson(
      "/api/instructor/assignments/assign_instructor_ops_01/close",
      {},
    );
    expect(closeResponse.status).toBe(200);
    expect((await closeResponse.json<{ status: string }>()).status).toBe("closed");
  });

  it("rejects learner overrides outside assignment targeting", async () => {
    const { HARBOR_DB } = getTestEnv();
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "instructor-assignment-ops-reject",
    });
    const login = await performInstitutionalLogin();
    const outsider = await ensureLearnerIdentity({
      db: HARBOR_DB,
      tenantId: "tenant_local_demo",
      providerKind: "institutional-sso",
      issuer: "https://institution.harbor.local",
      subject: "outsider-learner",
      displayName: "Outside Learner",
      email: "outside@example.edu",
    });

    const createResponse = await postJson("/api/instructor/assignments", {
      assignmentId: "assign_instructor_ops_02",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Restricted Assignment",
      status: "active",
      actor: {
        role: "instructor",
        actorId: "inst_02",
        displayName: "Instructor Two",
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
      targets: [{ kind: "learner", learnerId: login.session.learner.id }],
    });
    expect(createResponse.status).toBe(201);

    const overrideResponse = await putJson(
      `/api/instructor/assignments/assign_instructor_ops_02/learners/${outsider.id}/override`,
      {
        actor: {
          role: "instructor",
          actorId: "inst_02",
          displayName: "Instructor Two",
        },
        policyOverrides: {
          additionalTimeSeconds: 120,
        },
      },
    );

    expect(overrideResponse.status).toBe(403);
    expect((await overrideResponse.json<{ error: string }>()).error).toContain("not targeted");
  });

  it("applies learner overrides to new launches and reuses the existing live attempt policy path", async () => {
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "instructor-launch-override",
    });
    const login = await performInstitutionalLogin();

    const createResponse = await postJson("/api/instructor/assignments", {
      assignmentId: "assign_instructor_ops_03",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Launch Override Assignment",
      status: "active",
      actor: {
        role: "instructor",
        actorId: "inst_03",
        displayName: "Instructor Three",
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
        secureBrowserRequired: true,
        secureBrowserProviderHint: "Safe Exam Browser",
        proctoringProvider: "seb",
      },
      targets: [{ kind: "learner", learnerId: login.session.learner.id }],
    });
    expect(createResponse.status).toBe(201);

    const overrideResponse = await putJson(
      `/api/instructor/assignments/assign_instructor_ops_03/learners/${login.session.learner.id}/override`,
      {
        actor: {
          role: "instructor",
          actorId: "inst_03",
          displayName: "Instructor Three",
        },
        policyOverrides: {
          additionalTimeSeconds: 120,
          timeLimitSeconds: 2400,
          secureBrowserRequired: false,
        },
        accommodations: {
          rendererPnp: {
            layoutSingleColumn: true,
          },
          sessionControl: {},
        },
      },
    );
    expect(overrideResponse.status).toBe(200);

    const launchResponse = await postJson(
      "/api/launch/student",
      {
        assignmentId: "assign_instructor_ops_03",
        source: "institutional-sso",
      },
      { cookie: login.cookie },
    );
    expect(launchResponse.status).toBe(201);
    const envelope = await launchResponse.json<BootstrapEnvelope>();
    const payload = await exchangeBootstrap(envelope.bootstrapToken);

    expect(payload.deliveryPolicy.timeLimitSeconds).toBe(2400);
    expect(payload.deliveryPolicy.secureBrowserRequired).toBe(false);
    expect(payload.policy!.timing.additionalTimeSeconds).toBe(120);
    expect(payload.policy!.accommodations.rendererPnp.layoutSingleColumn).toBe(true);

    const actionResponse = await postJson(`/api/instructor/attempts/${payload.attemptId}/actions`, {
      actionId: "instructor_extend_01",
      type: "extend-time",
      actor: {
        role: "instructor",
        actorId: "inst_03",
        displayName: "Instructor Three",
      },
      reason: "Approved additional time",
      effectiveAt: new Date().toISOString(),
      additionalTimeSeconds: 90,
    });
    expect(actionResponse.status).toBe(200);
    const policy = await actionResponse.json<AttemptPolicyReadResponse>();
    expect(policy.policy.overlayRevision).toBe(2);
    expect(policy.policy.timing.additionalTimeSeconds).toBe(210);

    const timelineResponse = await get(`/api/instructor/attempts/${payload.attemptId}/timeline`);
    expect(timelineResponse.status).toBe(200);
    const timeline = await timelineResponse.json<AttemptTimelineResponse>();
    expect(
      timeline.entries.some(
        (entry) =>
          entry.eventType === "override" &&
          entry.actor?.role === "instructor" &&
          entry.reason === "Approved additional time",
      ),
    ).toBe(true);
  });
});
