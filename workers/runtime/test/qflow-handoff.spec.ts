import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  QFLOW_HANDOFF_SECRET: string;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    QFLOW_HANDOFF_SECRET: string;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "qflow_handoffs",
    "assessment_version_activations",
    "lti_resource_links",
    "assignment_section_targets",
    "assignment_learner_targets",
    "access_codes",
    "attempt_entries",
    "assignments",
    "lti_registrations",
    "sections",
    "harbor_learners",
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
  manifestObjectKey: string;
}> {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "qflow-handoff.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function seedAssignmentDependencies(): Promise<void> {
  const now = "2026-03-27T09:00:00.000Z";
  await getTestEnv().HARBOR_DB.batch([
    getTestEnv()
      .HARBOR_DB.prepare(
        "INSERT INTO harbor_learners (id, tenant_id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "learner_qflow_01",
        "tenant_qflow_handoff",
        "Learner QFlow",
        "learner@example.com",
        now,
        now,
      ),
    getTestEnv()
      .HARBOR_DB.prepare(
        "INSERT INTO sections (id, tenant_id, source_kind, source_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "section_qflow_01",
        "tenant_qflow_handoff",
        "manual",
        "section-source-01",
        "Section QFlow",
        now,
        now,
      ),
    getTestEnv()
      .HARBOR_DB.prepare(
        "INSERT INTO lti_registrations (id, tenant_id, issuer, client_id, deployment_id, authorization_endpoint, jwks_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "lti_reg_qflow_01",
        "tenant_qflow_handoff",
        "https://platform.example.com",
        "client-qflow",
        "deployment-qflow",
        "https://platform.example.com/auth",
        "https://platform.example.com/jwks",
        now,
        now,
      ),
  ]);
}

async function readCount(
  tableName: string,
  whereClause?: string,
  bindings: string[] = [],
): Promise<number> {
  const row = await getTestEnv()
    .HARBOR_DB.prepare(
      `SELECT COUNT(*) AS count FROM ${tableName}${whereClause ? ` WHERE ${whereClause}` : ""}`,
    )
    .bind(...bindings)
    .first<{ count: number }>();

  return row?.count ?? 0;
}

async function signBody(body: string): Promise<string> {
  const { QFLOW_HANDOFF_SECRET } = getTestEnv();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(QFLOW_HANDOFF_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));

  return [...new Uint8Array(signature)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function postSignedQflow(body: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(body);
  return workerExports.default.fetch(
    new Request("https://harbor.local/internal/qflow/handoff", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harbor-qflow-signature": await signBody(rawBody),
      },
      body: rawBody,
    }),
  );
}

beforeEach(async () => {
  await resetBindings();
});

describe("qflow handoff runtime behavior", () => {
  it("rejects unsigned, malformed, or policy-inconsistent handoff requests before mutating control-plane state", async () => {
    const published = await publishFixture({
      tenantId: "tenant_qflow_handoff",
      assessmentSlug: "qflow-handoff-invalid",
    });

    const unsignedResponse = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/qflow/handoff", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          handoffId: "handoff_bad_01",
          kind: "activate-version",
          assessmentId: published.assessmentId,
          assessmentVersionId: published.assessmentVersionId,
          actorId: "qflow",
          reason: "test",
          activatedAt: "2026-03-27T00:00:00.000Z",
        }),
      }),
    );

    expect(unsignedResponse.status).toBe(401);
    expect(await unsignedResponse.json()).toEqual({
      error: "Missing qflow handoff signature",
    });

    const malformedBody = "{";
    const malformedResponse = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/qflow/handoff", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-harbor-qflow-signature": await signBody(malformedBody),
        },
        body: malformedBody,
      }),
    );

    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({
      error: "Request body must be valid JSON",
    });

    const invalidPolicyResponse = await postSignedQflow({
      handoffId: "handoff_bad_policy_01",
      kind: "upsert-assignment",
      assignmentId: "assign_bad_policy_01",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "invalid policy assignment",
      actorId: "qflow_system",
      issuedAt: "2026-03-27T10:05:00.000Z",
      policySnapshot: {
        availableFrom: "2026-03-27T10:00:00.000Z",
        availableUntil: "2026-03-28T10:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 0,
        timeLimitSeconds: 1200,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
    });

    expect(invalidPolicyResponse.status).toBe(400);
    expect(await invalidPolicyResponse.json()).toEqual({
      error: "policySnapshot.maxAttempts must be a positive integer",
    });

    expect(await readCount("qflow_handoffs")).toBe(0);
    expect(await readCount("assessment_version_activations")).toBe(0);
    expect(await readCount("assignments")).toBe(0);
    expect(await readCount("access_codes")).toBe(0);
  });

  it("activates versions and provisions assignment intents through the same Harbor version identity used by preview", async () => {
    const published = await publishFixture({
      tenantId: "tenant_qflow_handoff",
      assessmentSlug: "qflow-handoff",
    });

    const activateResponse = await postSignedQflow({
      handoffId: "handoff_activate_01",
      kind: "activate-version",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      actorId: "qflow_system",
      actorDisplayName: "qflowlearn",
      reason: "activate for institutional launch",
      activatedAt: "2026-03-27T10:00:00.000Z",
    });

    expect(activateResponse.status).toBe(200);
    expect(await activateResponse.json()).toMatchObject({
      handoffId: "handoff_activate_01",
      kind: "activate-version",
      version: {
        assessmentId: published.assessmentId,
        assessmentVersionId: published.assessmentVersionId,
        manifestObjectKey: published.manifestObjectKey,
      },
    });

    const assignmentResponse = await postSignedQflow({
      handoffId: "handoff_assign_01",
      kind: "upsert-assignment",
      assignmentId: "assign_qflow_01",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "qflow section handoff",
      status: "active",
      actorId: "qflow_system",
      actorDisplayName: "qflowlearn",
      issuedAt: "2026-03-27T10:05:00.000Z",
      accessCode: "QFLOW-001",
      policySnapshot: {
        availableFrom: "2026-03-27T10:00:00.000Z",
        availableUntil: "2026-03-28T10:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 2,
        timeLimitSeconds: 1200,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
    });

    expect(assignmentResponse.status).toBe(200);
    expect(await assignmentResponse.json()).toMatchObject({
      handoffId: "handoff_assign_01",
      kind: "upsert-assignment",
      assignment: {
        id: "assign_qflow_01",
        assessmentVersionId: published.assessmentVersionId,
      },
      version: {
        assessmentId: published.assessmentId,
        assessmentVersionId: published.assessmentVersionId,
        manifestObjectKey: published.manifestObjectKey,
      },
      accessCode: {
        accessCode: "QFLOW-001",
        assignmentId: "assign_qflow_01",
      },
    });

    const rows = await getTestEnv()
      .HARBOR_DB.prepare("SELECT COUNT(*) AS handoffs FROM qflow_handoffs")
      .first<{ handoffs: number }>();
    expect(rows?.handoffs).toBe(2);
  });

  it("fully honors bounded assignment intent targets and LTI linkages", async () => {
    const published = await publishFixture({
      tenantId: "tenant_qflow_handoff",
      assessmentSlug: "qflow-handoff-bounded-intent",
    });
    await seedAssignmentDependencies();

    const assignmentResponse = await postSignedQflow({
      handoffId: "handoff_assign_targets_01",
      kind: "upsert-assignment",
      assignmentId: "assign_qflow_targets_01",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "qflow targeted handoff",
      status: "active",
      actorId: "qflow_system",
      actorDisplayName: "qflowlearn",
      issuedAt: "2026-03-27T10:05:00.000Z",
      policySnapshot: {
        availableFrom: "2026-03-27T10:00:00.000Z",
        availableUntil: "2026-03-28T10:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 2,
        timeLimitSeconds: 1200,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
      targets: [
        {
          kind: "learner",
          learnerId: "learner_qflow_01",
        },
        {
          kind: "section",
          sectionId: "section_qflow_01",
        },
      ],
      ltiLinkages: [
        {
          registrationId: "lti_reg_qflow_01",
          resourceLinkId: "resource-link-qflow-01",
          contextId: "course-qflow-01",
          sectionId: "section_qflow_01",
        },
      ],
    });

    expect(assignmentResponse.status).toBe(200);
    expect(await assignmentResponse.json()).toMatchObject({
      assignment: {
        id: "assign_qflow_targets_01",
        targets: [
          {
            kind: "learner",
            learnerId: "learner_qflow_01",
          },
          {
            kind: "section",
            sectionId: "section_qflow_01",
          },
        ],
        ltiLinkages: [
          {
            registrationId: "lti_reg_qflow_01",
            resourceLinkId: "resource-link-qflow-01",
            contextId: "course-qflow-01",
            sectionId: "section_qflow_01",
          },
        ],
      },
    });

    expect(
      await readCount("assignment_learner_targets", "assignment_id = ?", [
        "assign_qflow_targets_01",
      ]),
    ).toBe(1);
    expect(
      await readCount("assignment_section_targets", "assignment_id = ?", [
        "assign_qflow_targets_01",
      ]),
    ).toBe(1);
    expect(
      await readCount("lti_resource_links", "assignment_id = ?", ["assign_qflow_targets_01"]),
    ).toBe(1);
  });

  it("treats duplicate qflow handoffs as idempotent and blocks conflicting replays", async () => {
    const published = await publishFixture({
      tenantId: "tenant_qflow_handoff",
      assessmentSlug: "qflow-handoff-idempotency",
    });
    await seedAssignmentDependencies();

    const activationBody = {
      handoffId: "handoff_activate_idempotent_01",
      kind: "activate-version",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      actorId: "qflow_system",
      actorDisplayName: "qflowlearn",
      reason: "activate once",
      activatedAt: "2026-03-27T10:00:00.000Z",
    };

    const firstActivation = await postSignedQflow(activationBody);
    const duplicateActivation = await postSignedQflow(activationBody);

    expect(firstActivation.status).toBe(200);
    expect(duplicateActivation.status).toBe(200);
    expect(await duplicateActivation.json()).toMatchObject({
      handoffId: "handoff_activate_idempotent_01",
      kind: "activate-version",
    });
    expect(
      await readCount("assessment_version_activations", "id = ?", [
        "qflowact_handoff_activate_idempotent_01",
      ]),
    ).toBe(1);

    const assignmentBody = {
      handoffId: "handoff_assign_idempotent_01",
      kind: "upsert-assignment",
      assignmentId: "assign_qflow_idempotent_01",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "idempotent handoff",
      status: "active",
      actorId: "qflow_system",
      actorDisplayName: "qflowlearn",
      issuedAt: "2026-03-27T10:05:00.000Z",
      accessCode: "QFLOW-IDEM-01",
      policySnapshot: {
        availableFrom: "2026-03-27T10:00:00.000Z",
        availableUntil: "2026-03-28T10:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 2,
        timeLimitSeconds: 1200,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
      targets: [
        {
          kind: "learner",
          learnerId: "learner_qflow_01",
        },
      ],
      ltiLinkages: [
        {
          registrationId: "lti_reg_qflow_01",
          resourceLinkId: "resource-link-qflow-idem-01",
          contextId: "course-qflow-01",
          sectionId: "section_qflow_01",
        },
      ],
    };

    const firstAssignment = await postSignedQflow(assignmentBody);
    const duplicateAssignment = await postSignedQflow(assignmentBody);

    expect(firstAssignment.status).toBe(200);
    expect(duplicateAssignment.status).toBe(200);
    expect(await duplicateAssignment.json()).toMatchObject({
      handoffId: "handoff_assign_idempotent_01",
      kind: "upsert-assignment",
      accessCode: {
        accessCode: "QFLOW-IDEM-01",
        assignmentId: "assign_qflow_idempotent_01",
      },
    });
    expect(await readCount("assignments", "id = ?", ["assign_qflow_idempotent_01"])).toBe(1);
    expect(
      await readCount("access_codes", "assignment_id = ?", ["assign_qflow_idempotent_01"]),
    ).toBe(1);
    expect(await readCount("qflow_handoffs", "id = ?", ["handoff_assign_idempotent_01"])).toBe(1);

    const conflictingReplay = await postSignedQflow({
      ...assignmentBody,
      title: "conflicting handoff replay",
    });

    expect(conflictingReplay.status).toBe(409);
    expect(await conflictingReplay.json()).toEqual({
      error: "QFlow handoffId has already been used for a different signed request",
    });
    expect(await readCount("assignments", "id = ?", ["assign_qflow_idempotent_01"])).toBe(1);
    expect(
      await readCount("access_codes", "assignment_id = ?", ["assign_qflow_idempotent_01"]),
    ).toBe(1);
  });
});
