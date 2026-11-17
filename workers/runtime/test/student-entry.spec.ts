import { parseStoredAssignmentPolicySnapshot } from "../src/routes/assignment-request-parsers";
import JSZip from "jszip";
import { applyD1Migrations, env as testEnv } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  BootstrapPayload,
  InstitutionalSessionResponse,
  StudentAssignmentListResponse,
  StudentSafeExamBrowserLaunchResponse,
} from "@harbor/attempt-protocol";
import {
  buildGeneratedSafeExamBrowserSettings,
  computeSafeExamBrowserConfigKeyHash,
} from "../src/security/generated-safe-exam-browser-config";
import {
  createSafeExamBrowserConfigKeyRequestHash,
  HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER,
  HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER,
} from "../src/security/safe-exam-browser";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetDb(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
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
        "x-harbor-package-name": "student-entry.zip",
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

async function get(path: string, headers?: Record<string, string>): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
      redirect: "manual",
      headers,
    }),
  );
}

async function gunzipToText(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

async function exchangeBootstrap(bootstrapToken: string): Promise<Response> {
  return postJson("/api/bootstrap", { bootstrapToken });
}

async function performInstitutionalLogin(profile = "demo-student"): Promise<{
  cookie: string;
  session: InstitutionalSessionResponse;
}> {
  const loginResponse = await get(
    `/api/auth/institutional/login?redirectTo=/&profile=${encodeURIComponent(profile)}`,
  );
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
    session: await sessionResponse.json<InstitutionalSessionResponse>(),
  };
}

beforeEach(async () => {
  await resetDb();
});

describe("institutional student entry", () => {
  it("establishes an institutional session that survives later Harbor reads", async () => {
    const { cookie, session } = await performInstitutionalLogin();

    expect(session.learner.displayName).toBe("Morgan Lee");
    expect(session.session.providerKind).toBe("institutional-sso");
    expect(cookie).toContain("harbor_session=");

    const secondRead = await get("/api/auth/session", { cookie });
    expect(secondRead.status).toBe(200);

    const reread = await secondRead.json<InstitutionalSessionResponse>();
    expect(reread.learner.id).toBe(session.learner.id);
    expect(reread.session.id).toBe(session.session.id);
  });

  it("lists learner-targeted and section-targeted assignments for the signed-in learner", async () => {
    const { HARBOR_DB } = getTestEnv();
    const { cookie, session } = await performInstitutionalLogin();
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "student-entry-list",
    });

    const sectionId = "section_demo_01";
    await HARBOR_DB.batch([
      HARBOR_DB.prepare(
        "INSERT INTO sections (id, tenant_id, source_kind, source_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        sectionId,
        "tenant_local_demo",
        "manual",
        "section-demo-01",
        "Section Demo",
        new Date().toISOString(),
        new Date().toISOString(),
      ),
      HARBOR_DB.prepare(
        "INSERT INTO section_memberships (id, section_id, learner_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "membership_demo_01",
        sectionId,
        session.learner.id,
        "learner",
        "active",
        new Date().toISOString(),
        new Date().toISOString(),
      ),
    ]);

    const explicitAssignment = await postJson("/internal/assignments", {
      assignmentId: "assign_student_explicit",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Explicit Target",
      actor: {
        role: "instructor",
        actorId: "inst_01",
        displayName: "Instructor",
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
      targets: [{ kind: "learner", learnerId: session.learner.id }],
    });
    expect(explicitAssignment.status).toBe(201);

    const sectionAssignment = await postJson("/internal/assignments", {
      assignmentId: "assign_student_section",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Section Target",
      actor: {
        role: "instructor",
        actorId: "inst_01",
        displayName: "Instructor",
      },
      policySnapshot: {
        availableFrom: "2026-03-27T00:00:00.000Z",
        availableUntil: "2026-12-31T00:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 1,
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
      targets: [{ kind: "section", sectionId }],
    });
    expect(sectionAssignment.status).toBe(201);

    const listResponse = await get("/api/student/assignments", { cookie });
    expect(listResponse.status).toBe(200);

    const payload = await listResponse.json<StudentAssignmentListResponse>();
    expect(payload.assignments).toHaveLength(2);
    expect(payload.assignments.map((assignment) => assignment.targetSource).sort()).toEqual([
      "explicit",
      "section",
    ]);
    expect(payload.assignments.every((assignment) => assignment.canLaunch)).toBe(true);
    expect(
      payload.assignments.every((assignment) => assignment.attemptStatus === "not-started"),
    ).toBe(true);
  });

  it("lists a large learner assessment set without exceeding D1 SQL bind limits", async () => {
    const { HARBOR_DB } = getTestEnv();
    const { cookie, session } = await performInstitutionalLogin();
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "student-entry-large-list",
    });
    const now = new Date().toISOString();
    const policySnapshot = JSON.stringify({
      availableFrom: "2026-03-27T00:00:00.000Z",
      availableUntil: "2026-12-31T00:00:00.000Z",
      reportingTimezone: "America/New_York",
      maxAttempts: 1,
      timeLimitSeconds: 1800,
      gracePeriodSeconds: 30,
      navigationMode: "free",
      standaloneAllowed: true,
      iframeAllowed: false,
      allowedEmbedOrigins: [],
      secureBrowserRequired: false,
      secureBrowserProviderHint: null,
      proctoringProvider: null,
    });
    const statements: D1PreparedStatement[] = [];
    const assignmentCount = 1050;

    for (let index = 0; index < assignmentCount; index += 1) {
      const assignmentId = `assign_student_large_${index}`;
      statements.push(
        HARBOR_DB.prepare(
          "INSERT INTO assignments (id, assessment_id, assessment_version_id, title, status, policy_snapshot_json, created_by_role, created_by_id, created_by_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          assignmentId,
          published.assessmentId,
          published.assessmentVersionId,
          `Large Set ${index}`,
          "active",
          policySnapshot,
          "instructor",
          "inst_01",
          "Instructor",
          now,
          now,
        ),
        HARBOR_DB.prepare(
          "INSERT INTO assignment_learner_targets (id, assignment_id, learner_id, created_at) VALUES (?, ?, ?, ?)",
        ).bind(`atarget_student_large_${index}`, assignmentId, session.learner.id, now),
      );
    }

    for (let index = 0; index < statements.length; index += 100) {
      await HARBOR_DB.batch(statements.slice(index, index + 100));
    }

    const listResponse = await get("/api/student/assignments", { cookie });
    expect(listResponse.status).toBe(200);

    const payload = await listResponse.json<StudentAssignmentListResponse>();
    expect(payload.assignments).toHaveLength(assignmentCount);
    expect(payload.assignments.every((assignment) => assignment.canLaunch)).toBe(true);
  });

  it("launches and then reuses the same learner assignment attempt through the student launch seam", async () => {
    const { HARBOR_DB } = getTestEnv();
    const { cookie, session } = await performInstitutionalLogin();
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "student-entry-launch",
    });

    const assignmentResponse = await postJson("/internal/assignments", {
      assignmentId: "assign_student_launch",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Launchable Assignment",
      actor: {
        role: "instructor",
        actorId: "inst_01",
        displayName: "Instructor",
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
      targets: [{ kind: "learner", learnerId: session.learner.id }],
    });
    expect(assignmentResponse.status).toBe(201);

    const firstLaunch = await postJson(
      "/api/launch/student",
      {
        assignmentId: "assign_student_launch",
        source: "institutional-sso",
      },
      { cookie },
    );
    expect(firstLaunch.status).toBe(201);
    const firstEnvelope = await firstLaunch.json<{ bootstrapToken: string }>();
    const firstBootstrap = await exchangeBootstrap(firstEnvelope.bootstrapToken);
    expect(firstBootstrap.status).toBe(200);
    const firstPayload = await firstBootstrap.json<BootstrapPayload>();

    expect(firstPayload.launch.mode).toBe("institutional-sso");
    expect(firstPayload.launch.actor.kind).toBe("student-learner");
    expect(firstPayload.launch.actor.id).toBe(session.learner.id);

    const attemptEntry = await HARBOR_DB.prepare(
      "SELECT launch_mode, actor_kind, actor_id FROM attempt_entries WHERE id = ?",
    )
      .bind(firstPayload.attemptId)
      .first<{
        launch_mode: string;
        actor_kind: string;
        actor_id: string | null;
      }>();
    expect(attemptEntry?.launch_mode).toBe("institutional-sso");
    expect(attemptEntry?.actor_kind).toBe("student-learner");
    expect(attemptEntry?.actor_id).toBe(session.learner.id);

    const originalAssignment = await HARBOR_DB.prepare(
      "SELECT policy_snapshot_json FROM assignments WHERE id = ?",
    )
      .bind("assign_student_launch")
      .first<{ policy_snapshot_json: string }>();
    if (!originalAssignment) throw new Error("Assignment fixture disappeared");
    const originalPolicy = parseStoredAssignmentPolicySnapshot(
      originalAssignment.policy_snapshot_json,
    );
    await HARBOR_DB.prepare("UPDATE assignments SET policy_snapshot_json = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          ...originalPolicy,
          secureBrowserRequired: true,
          secureBrowserProviderHint: "safe-exam-browser",
          safeExamBrowser: {
            verificationMode: "config-key",
            generatedConfig: { enabled: true },
            browserExamKeys: [],
          },
        }),
        "assign_student_launch",
      )
      .run();
    const secondLaunch = await postJson(
      "/api/launch/student",
      {
        assignmentId: "assign_student_launch",
        source: "institutional-sso",
      },
      { cookie },
    );
    expect(secondLaunch.status).toBe(201);
    const secondEnvelope = await secondLaunch.json<{ bootstrapToken: string }>();
    const secondBootstrap = await exchangeBootstrap(secondEnvelope.bootstrapToken);
    const secondPayload = await secondBootstrap.json<BootstrapPayload>();

    expect(secondPayload.attemptId).toBe(firstPayload.attemptId);
  });

  it("generates an authenticated Safe Exam Browser config and accepts the signed SEB launch token", async () => {
    const { HARBOR_DB } = getTestEnv();
    const { cookie, session } = await performInstitutionalLogin();
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "student-entry-seb-generated-config",
    });

    const assignmentResponse = await postJson("/internal/assignments", {
      assignmentId: "assign_student_seb_generated",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "SEB Generated Config",
      actor: {
        role: "instructor",
        actorId: "inst_01",
        displayName: "Instructor",
      },
      policySnapshot: {
        availableFrom: "2026-03-27T00:00:00.000Z",
        availableUntil: "2026-12-31T00:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: true,
        secureBrowserProviderHint: "Safe Exam Browser",
        safeExamBrowser: {
          verificationMode: "config-key",
          generatedConfig: {
            enabled: true,
          },
          browserExamKeys: [],
        },
        proctoringProvider: "seb",
      },
      targets: [{ kind: "learner", learnerId: session.learner.id }],
    });
    expect(assignmentResponse.status).toBe(201);

    const listResponse = await get("/api/student/assignments", { cookie });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json<StudentAssignmentListResponse>();
    expect(list.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignmentId: "assign_student_seb_generated",
          safeExamBrowser: {
            required: true,
            configured: true,
            generatedConfigAvailable: true,
          },
        }),
      ]),
    );

    const launchResponse = await postJson(
      "/api/student/assignments/assign_student_seb_generated/safe-exam-browser/launch",
      {},
      { cookie },
    );
    expect(launchResponse.status).toBe(201);
    const launch = await launchResponse.json<StudentSafeExamBrowserLaunchResponse>();
    expect(launch.configLaunchUrl).toMatch(
      /^sebs:\/\/harbor\.local\/api\/student\/assignments\/assign_student_seb_generated\/safe-exam-browser\/config\.seb\?token=/u,
    );
    expect(launch.startUrl).toContain("sebLaunchToken=");

    const configUrl = new URL(launch.configDownloadUrl);
    const configResponse = await get(`${configUrl.pathname}${configUrl.search}`);
    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("content-type")).toBe("application/seb");
    const configText = await gunzipToText(await configResponse.arrayBuffer());
    expect(configText.startsWith("plnd<?xml")).toBe(true);
    expect(configText).toContain("<key>startURL</key>");
    expect(configText).toContain(launch.startUrl.replaceAll("&", "&amp;"));

    const settings = buildGeneratedSafeExamBrowserSettings({
      urls: {
        startUrl: launch.startUrl,
        quitUrl: launch.quitUrl,
      },
    });
    const configKeyHash = await computeSafeExamBrowserConfigKeyHash(settings);
    const proofHash = await createSafeExamBrowserConfigKeyRequestHash({
      requestUrl: launch.startUrl,
      configKeyHash,
    });
    const sebLaunchToken = new URL(launch.startUrl).searchParams.get("sebLaunchToken");
    expect(sebLaunchToken).toBeTruthy();

    const sebLaunch = await postJson(
      "/api/launch/student",
      {
        assignmentId: "assign_student_seb_generated",
        source: "institutional-sso",
        safeExamBrowserLaunchToken: sebLaunchToken,
      },
      {
        [HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER]: proofHash,
        [HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER]: launch.startUrl,
        "x-harbor-secure-browser-provider": "safe-exam-browser",
      },
    );
    expect(sebLaunch.status).toBe(201);
    const envelope = await sebLaunch.json<{ bootstrapToken: string }>();
    const sebProofHeaders = {
      [HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER]: proofHash,
      [HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER]: launch.startUrl,
      "x-harbor-secure-browser-provider": "safe-exam-browser",
    };
    const bootstrap = await postJson(
      "/api/bootstrap",
      { bootstrapToken: envelope.bootstrapToken, clientSessionId: "seb_generated_client" },
      sebProofHeaders,
    );
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();
    expect(payload.launch.mode).toBe("institutional-sso");
    expect(payload.launch.actor.kind).toBe("student-learner");
    expect(payload.launch.actor.learnerId).toBe(session.learner.id);

    const attemptEntry = await HARBOR_DB.prepare(
      "SELECT delivery_policy_snapshot FROM attempt_entries WHERE id = ?",
    )
      .bind(payload.attemptId)
      .first<{ delivery_policy_snapshot: string }>();
    if (!attemptEntry) throw new Error("Generated attempt policy was not persisted");
    expect(JSON.parse(attemptEntry.delivery_policy_snapshot).safeExamBrowser.configKeyHash).toBe(
      configKeyHash,
    );
    const eventPath = `/api/attempts/${payload.attemptId}/events`;
    const eventBase = {
      attemptId: payload.attemptId,
      clientSessionId: "seb_generated_client",
      clientTimestamp: new Date().toISOString(),
      itemRef: payload.session.currentItemRef,
    };
    const firstCommit = await postJson(
      eventPath,
      {
        ...eventBase,
        eventId: "seb_first",
        idempotencyKey: "seb_first",
        sequenceNumber: 1,
        type: "response.changed",
        payload: {
          responseKey: payload.session.currentItemRef.itemId,
          responseState: {
            itemState: { responseVariables: [{ identifier: "RESPONSE", value: "B" }] },
          },
        },
      },
      sebProofHeaders,
    );
    expect(firstCommit.status).toBe(200);
    expect(await firstCommit.json()).toMatchObject({
      outcome: "accepted",
      highestCommittedSequence: 1,
    });

    const originalAssignment = await HARBOR_DB.prepare(
      "SELECT policy_snapshot_json FROM assignments WHERE id = ?",
    )
      .bind("assign_student_seb_generated")
      .first<{ policy_snapshot_json: string }>();
    if (!originalAssignment) throw new Error("Assignment fixture disappeared");
    const originalPolicy = parseStoredAssignmentPolicySnapshot(
      originalAssignment.policy_snapshot_json,
    );
    await HARBOR_DB.prepare("UPDATE assignments SET policy_snapshot_json = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          ...originalPolicy,
          timeLimitSeconds: 60,
          safeExamBrowser: {
            ...originalPolicy.safeExamBrowser,
            generatedConfig: { enabled: true, allowQuit: false },
          },
        }),
        "assign_student_seb_generated",
      )
      .run();
    const freshMetadata = await postJson(
      "/api/student/assignments/assign_student_seb_generated/safe-exam-browser/launch",
      {},
      { cookie },
    );
    expect(freshMetadata.status).toBe(201);
    const freshLaunch = await freshMetadata.json<StudentSafeExamBrowserLaunchResponse>();
    const freshConfigUrl = new URL(freshLaunch.configDownloadUrl);
    const freshConfig = await get(`${freshConfigUrl.pathname}${freshConfigUrl.search}`);
    expect(freshConfig.status).toBe(200);
    expect(await gunzipToText(await freshConfig.arrayBuffer())).toContain(
      "<key>allowQuit</key>\n  <true/>",
    );
    const freshKey = await computeSafeExamBrowserConfigKeyHash(
      buildGeneratedSafeExamBrowserSettings({
        urls: { startUrl: freshLaunch.startUrl, quitUrl: freshLaunch.quitUrl },
      }),
    );
    expect(freshKey).not.toBe(configKeyHash);
    const freshProof = await createSafeExamBrowserConfigKeyRequestHash({
      requestUrl: freshLaunch.startUrl,
      configKeyHash: freshKey,
    });
    const freshHeaders = {
      [HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER]: freshProof,
      [HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER]: freshLaunch.startUrl,
      "x-harbor-secure-browser-provider": "safe-exam-browser",
    };
    const rejectedProof = await postJson(
      "/api/launch/student",
      {
        assignmentId: "assign_student_seb_generated",
        source: "institutional-sso",
        safeExamBrowserLaunchToken: new URL(freshLaunch.startUrl).searchParams.get(
          "sebLaunchToken",
        ),
      },
      sebProofHeaders,
    );
    expect(rejectedProof.status).toBe(403);
    const unchanged = await HARBOR_DB.prepare(
      "SELECT delivery_policy_snapshot FROM attempt_entries WHERE id = ?",
    )
      .bind(payload.attemptId)
      .first<{ delivery_policy_snapshot: string }>();
    if (!unchanged) throw new Error("Attempt disappeared after rejected relaunch");
    expect(JSON.parse(unchanged.delivery_policy_snapshot).safeExamBrowser.configKeyHash).toBe(
      configKeyHash,
    );
    const coordinator = testEnv.ATTEMPT_COORDINATOR.get(
      testEnv.ATTEMPT_COORDINATOR.idFromName(payload.attemptId),
    );
    const internalHeaders = {
      ...freshHeaders,
      "x-harbor-attempt-id": payload.attemptId,
      "x-harbor-delivery-context-url": "https://harbor.local/api/launch/student",
      "content-type": "application/json",
    };
    const invalidToken = await coordinator.fetch(
      "https://harbor-attempt.local/generated-seb-rebind",
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ launchToken: "invalid-token" }),
      },
    );
    expect(invalidToken.status).toBe(401);
    const arbitraryPolicy = await coordinator.fetch(
      "https://harbor-attempt.local/generated-seb-rebind",
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          launchToken: new URL(freshLaunch.startUrl).searchParams.get("sebLaunchToken"),
          deliveryPolicy: { secureBrowserRequired: false },
        }),
      },
    );
    expect(arbitraryPolicy.status).toBe(400);
    const otherAssignment = await postJson("/internal/assignments", {
      assignmentId: "assign_student_seb_other",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Other SEB exam",
      actor: { role: "system", actorId: "fixture" },
      policySnapshot: originalPolicy,
      targets: [{ kind: "learner", learnerId: session.learner.id }],
    });
    expect(otherAssignment.status).toBe(201);
    const otherMetadata = await postJson(
      "/api/student/assignments/assign_student_seb_other/safe-exam-browser/launch",
      {},
      { cookie },
    );
    expect(otherMetadata.status).toBe(201);
    const otherLaunch = await otherMetadata.json<StudentSafeExamBrowserLaunchResponse>();
    const wrongAssignment = await coordinator.fetch(
      "https://harbor-attempt.local/generated-seb-rebind",
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          launchToken: new URL(otherLaunch.startUrl).searchParams.get("sebLaunchToken"),
        }),
      },
    );
    expect(wrongAssignment.status).toBe(403);
    const alternate = await performInstitutionalLogin("demo-student-alt");
    await HARBOR_DB.prepare(
      "INSERT INTO assignment_learner_targets (id,assignment_id,learner_id,created_at) VALUES (?,?,?,?)",
    )
      .bind(
        "target_seb_alternate",
        "assign_student_seb_generated",
        alternate.session.learner.id,
        new Date().toISOString(),
      )
      .run();
    const alternateMetadata = await postJson(
      "/api/student/assignments/assign_student_seb_generated/safe-exam-browser/launch",
      {},
      { cookie: alternate.cookie },
    );
    expect(alternateMetadata.status).toBe(201);
    const alternateLaunch = await alternateMetadata.json<StudentSafeExamBrowserLaunchResponse>();
    const wrongLearner = await coordinator.fetch(
      "https://harbor-attempt.local/generated-seb-rebind",
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          launchToken: new URL(alternateLaunch.startUrl).searchParams.get("sebLaunchToken"),
        }),
      },
    );
    expect(wrongLearner.status).toBe(403);
    expect(
      (
        await postJson(
          `/api/attempts/${payload.attemptId}/generated-seb-rebind`,
          { launchToken: new URL(freshLaunch.startUrl).searchParams.get("sebLaunchToken") },
          freshHeaders,
        )
      ).status,
    ).toBe(404);
    const stateAfterRejected = await coordinator.fetch("https://harbor-attempt.local/session", {
      headers: { "x-harbor-attempt-id": payload.attemptId },
    });
    expect(await stateAfterRejected.json()).toMatchObject({
      sequence: { lastAcceptedSequence: 1, nextSequence: 2 },
    });
    const resumedLaunch = await postJson(
      "/api/launch/student",
      {
        assignmentId: "assign_student_seb_generated",
        source: "institutional-sso",
        safeExamBrowserLaunchToken: new URL(freshLaunch.startUrl).searchParams.get(
          "sebLaunchToken",
        ),
      },
      freshHeaders,
    );
    expect(resumedLaunch.status).toBe(201);
    const resumedEnvelope = await resumedLaunch.json<{ bootstrapToken: string }>();
    const blockedBootstrap = await postJson(
      "/api/bootstrap",
      { bootstrapToken: resumedEnvelope.bootstrapToken },
      sebProofHeaders,
    );
    expect(blockedBootstrap.status).toBe(403);
    const resumedBootstrap = await postJson(
      "/api/bootstrap",
      { bootstrapToken: resumedEnvelope.bootstrapToken, clientSessionId: "seb_generated_client" },
      freshHeaders,
    );
    expect(resumedBootstrap.status).toBe(200);
    const resumed = await resumedBootstrap.json<BootstrapPayload>();
    expect(resumed.attemptId).toBe(payload.attemptId);
    if (!resumed.session.sequence) throw new Error("Resumed attempt has no authoritative sequence");
    expect(resumed.session.sequence.nextSequence).toBe(2);
    expect(resumed.deliveryPolicy.timeLimitSeconds).toBe(1800);
    const heartbeat = {
      ...eventBase,
      eventId: "seb_second",
      idempotencyKey: "seb_second",
      sequenceNumber: 2,
      type: "heartbeat",
      payload: { observedAt: new Date().toISOString() },
    };
    const secondCommit = await postJson(eventPath, heartbeat, freshHeaders);
    expect(secondCommit.status).toBe(200);
    expect(await secondCommit.json()).toMatchObject({
      outcome: "accepted",
      highestCommittedSequence: 2,
    });
    const staleProof = await postJson(
      eventPath,
      { ...heartbeat, eventId: "seb_stale", idempotencyKey: "seb_stale", sequenceNumber: 3 },
      sebProofHeaders,
    );
    expect(staleProof.status).toBe(403);
    const stub = testEnv.ATTEMPT_COORDINATOR.get(
      testEnv.ATTEMPT_COORDINATOR.idFromName(payload.attemptId),
    );
    const materialization = await stub.fetch(
      "https://harbor-attempt.local/result-materialization",
      { headers: { "x-harbor-attempt-id": payload.attemptId } },
    );
    expect(await materialization.json()).toMatchObject({
      submissionMaterialization: {
        items: {
          [payload.session.currentItemRef.itemId]: {
            responseVariables: expect.arrayContaining([{ identifier: "RESPONSE", value: "B" }]),
          },
        },
      },
    });
    const submit = await postJson(
      eventPath,
      {
        ...eventBase,
        eventId: "seb_submit",
        idempotencyKey: "seb_submit",
        sequenceNumber: 3,
        type: "submit.requested",
        payload: { requestedAt: new Date().toISOString() },
      },
      freshHeaders,
    );
    expect(submit.status).toBe(200);
    const afterSubmit = await coordinator.fetch(
      "https://harbor-attempt.local/generated-seb-rebind",
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          launchToken: new URL(freshLaunch.startUrl).searchParams.get("sebLaunchToken"),
        }),
      },
    );
    expect(afterSubmit.status).toBe(409);
    const timeline = await get(`/internal/attempts/${payload.attemptId}/timeline`);
    expect(timeline.status).toBe(200);
    const timelineBody = await timeline.json<{
      entries: Array<{ eventType: string; summary: Record<string, unknown> }>;
    }>();
    const secureEvents = timelineBody.entries.filter(
      (entry) => entry.eventType === "secure-browser",
    );
    expect(secureEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.objectContaining({
            phase: "bootstrap",
            outcome: "verified",
            verificationMethod: "config-key-js-api",
          }),
        }),
        expect.objectContaining({
          summary: expect.objectContaining({ phase: "relaunch", outcome: "verified" }),
        }),
        expect.objectContaining({
          summary: expect.objectContaining({ phase: "relaunch", outcome: "blocked" }),
        }),
        expect.objectContaining({
          summary: expect.objectContaining({
            phase: "commit",
            outcome: "blocked",
            blockedReason: "secure_browser_key_mismatch",
          }),
        }),
      ]),
    );
    expect(secureEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.objectContaining({ phase: "bootstrap", outcome: "blocked" }),
        }),
      ]),
    );
    expect(
      secureEvents
        .filter((entry) => entry.summary.phase === "commit")
        .every((entry) => entry.summary.outcome === "blocked"),
    ).toBe(true);
    const serializedEvidence = JSON.stringify(secureEvents);
    for (const secret of [
      configKeyHash,
      freshKey,
      proofHash,
      freshProof,
      launch.startUrl,
      freshLaunch.startUrl,
      sebLaunchToken,
    ])
      if (secret) expect(serializedEvidence).not.toContain(secret);
  });
});
