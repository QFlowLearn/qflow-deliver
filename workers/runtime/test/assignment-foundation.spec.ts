import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  AssignmentRecord,
  AssignmentReadResponse,
  BootstrapPayload,
  CreateAssignmentRequest,
  QflowAssignmentIntent,
  QflowActivateVersionIntent,
  QflowPublishRequest,
} from "@harbor/attempt-protocol";
import { ASSIGNMENT_STATUSES, QFLOW_HANDOFF_KINDS } from "@harbor/attempt-protocol";
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
    "access_codes",
    "attempt_entries",
    "assignments",
    "delivery_artifacts",
    "qflow_assessment_mappings",
    "qflow_publish_requests",
    "qflow_tenant_links",
    "tenant_feature_entitlements",
    "qflow_handoffs",
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

async function readSchema(tableName: string): Promise<string | null> {
  const { HARBOR_DB } = getTestEnv();
  const table = await HARBOR_DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
    .bind(tableName)
    .first<{ sql: string | null }>();

  return table?.sql ?? null;
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
        "x-harbor-package-name": "assignment-foundation.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function getJson(path: string): Promise<Response> {
  return workerExports.default.fetch(new Request(`https://harbor.local${path}`, { method: "GET" }));
}

function buildAssignmentRequest(input: {
  assessmentId: string;
  assessmentVersionId: string;
  assignmentId?: string;
  title?: string;
  maxAttempts?: number;
}): CreateAssignmentRequest {
  return {
    assignmentId: input.assignmentId ?? "assign_foundation_01",
    assessmentId: input.assessmentId,
    assessmentVersionId: input.assessmentVersionId,
    title: input.title ?? "Midterm A",
    actor: {
      role: "instructor",
      actorId: "inst_01",
      displayName: "Instructor One",
    },
    policySnapshot: {
      availableFrom: "2026-03-27T00:00:00.000Z",
      availableUntil: "2026-03-29T00:00:00.000Z",
      reportingTimezone: "America/New_York",
      maxAttempts: input.maxAttempts ?? 2,
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
  };
}

beforeEach(async () => {
  await resetDb();
});

describe("assignment and qflow contracts", () => {
  it("defines assignment policy snapshots bound to immutable versions and future launch-time snapshots", () => {
    expect(ASSIGNMENT_STATUSES).toEqual(["draft", "active", "closed"]);

    expectTypeOf<CreateAssignmentRequest>().toMatchTypeOf<{
      assignmentId: string;
      assessmentId: string;
      assessmentVersionId: string;
      title: string;
      actor: {
        role:
          | "instructor"
          | "operator"
          | "system"
          | "qflow"
          | "tenant-administrator"
          | "assessment-manager"
          | "invigilator"
          | "scorer";
        actorId: string;
        displayName: string | null;
      };
      policySnapshot: {
        availableFrom: string | null;
        availableUntil: string | null;
        reportingTimezone: string;
        maxAttempts: number;
        timeLimitSeconds: number | null;
        gracePeriodSeconds: number | null;
        navigationMode: "linear" | "free";
        secureBrowserRequired: boolean;
      };
    }>();

    expectTypeOf<AssignmentRecord>().toMatchTypeOf<{
      id: string;
      assessmentId: string;
      assessmentVersionId: string;
      policySnapshot: {
        reportingTimezone: string;
        allowedEmbedOrigins: string[];
      };
      createdBy: {
        actorId: string;
      };
    }>();

    expectTypeOf<AssignmentReadResponse>().toEqualTypeOf<AssignmentRecord>();
  });

  it("defines qflow handoff intents around Harbor immutable version ids instead of mutable authoring identifiers", () => {
    expect(QFLOW_HANDOFF_KINDS).toEqual(["activate-version", "upsert-assignment"]);

    expectTypeOf<QflowActivateVersionIntent>().toMatchTypeOf<{
      handoffId: string;
      kind: "activate-version";
      assessmentId: string;
      assessmentVersionId: string;
      actorId: string;
      reason: string;
      activatedAt: string;
    }>();

    expectTypeOf<QflowAssignmentIntent>().toMatchTypeOf<{
      handoffId: string;
      kind: "upsert-assignment";
      assignmentId: string;
      assessmentId: string;
      assessmentVersionId: string;
      policySnapshot: {
        maxAttempts: number;
        navigationMode: "linear" | "free";
      };
      accessCode?: string | null;
    }>();

    expectTypeOf<QflowPublishRequest>().toMatchTypeOf<{
      publishId: string;
      qflowTenantId: string;
      qflowAssessmentId: string;
      packageUrl: string;
      exportFormat?: "qti3" | null;
    }>();
  });
});

describe("assignment and qflow migration schema", () => {
  it("creates assignment and qflow tables plus assignment-linked launch columns without overloading the old launch seam", async () => {
    const assignments = await readSchema("assignments");
    const qflowHandoffs = await readSchema("qflow_handoffs");
    const qflowPublishRequests = await readSchema("qflow_publish_requests");
    const qflowMappings = await readSchema("qflow_assessment_mappings");
    const qflowTenantLinks = await readSchema("qflow_tenant_links");
    const tenantEntitlements = await readSchema("tenant_feature_entitlements");
    const attemptEntries = await readSchema("attempt_entries");
    const accessCodes = await readSchema("access_codes");

    expect(assignments).toContain('"assessment_version_id" TEXT NOT NULL');
    expect(assignments).toContain('"policy_snapshot_json" TEXT NOT NULL');
    expect(assignments).toContain('"created_by_role" TEXT NOT NULL');

    expect(qflowHandoffs).toContain('"handoff_kind" TEXT NOT NULL');
    expect(qflowHandoffs).toContain('"assessment_version_id" TEXT NOT NULL');
    expect(qflowHandoffs).toContain('"request_sha256" TEXT NOT NULL');

    expect(qflowPublishRequests).toContain('"qflow_assessment_id" TEXT NOT NULL');
    expect(qflowPublishRequests).toContain('"package_url" TEXT NOT NULL');
    expect(qflowPublishRequests).toContain('"request_sha256" TEXT NOT NULL');

    expect(qflowMappings).toContain('"latest_assessment_version_id" TEXT NOT NULL');
    expect(qflowMappings).toContain(
      'UNIQUE ("tenant_id", "qflow_tenant_id", "qflow_assessment_id")',
    );

    expect(qflowTenantLinks).toContain('"qflow_tenant_id" TEXT NOT NULL');
    expect(qflowTenantLinks).toContain('"tenant_id" TEXT NOT NULL');
    expect(qflowTenantLinks).toContain('UNIQUE ("qflow_tenant_id")');

    expect(tenantEntitlements).toContain('"feature_key" TEXT NOT NULL');
    expect(tenantEntitlements).toContain('"status" TEXT NOT NULL');
    expect(tenantEntitlements).toContain('UNIQUE ("tenant_id", "feature_key")');

    expect(attemptEntries).toContain('"assignment_id" TEXT');
    expect(attemptEntries).toContain('"assignment_policy_snapshot" TEXT');
    expect(attemptEntries).toContain('"launch_snapshot_json" TEXT');

    expect(accessCodes).toContain('"assignment_id" TEXT');
  });
});

describe("assignment runtime behavior", () => {
  it("creates and reads assignment records bound to one immutable version, then issues assignment-scoped access codes", async () => {
    const published = await publishFixture({
      tenantId: "tenant_assignment_foundation",
      assessmentSlug: "assignment-foundation",
    });
    const request = buildAssignmentRequest({
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
    });

    const createResponse = await postJson("/internal/assignments", request);
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<AssignmentRecord>();

    expect(created).toMatchObject({
      id: request.assignmentId,
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Midterm A",
      status: "active",
      policySnapshot: {
        reportingTimezone: "America/New_York",
        maxAttempts: 2,
        navigationMode: "free",
        secureBrowserRequired: true,
        secureBrowserProviderHint: "Safe Exam Browser",
      },
    });

    const readResponse = await getJson(`/internal/assignments/${created.id}`);
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json<AssignmentReadResponse>()).toMatchObject({
      id: created.id,
      assessmentVersionId: published.assessmentVersionId,
      policySnapshot: {
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 30,
      },
    });

    const accessCodeResponse = await postJson("/internal/access-codes", {
      assignmentId: created.id,
      code: "FOUND-ASSIGN",
    });
    expect(accessCodeResponse.status).toBe(201);
    expect(await accessCodeResponse.json()).toMatchObject({
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: created.id,
      accessCode: "FOUND-ASSIGN",
    });
  });

  it("rejects invalid Safe Exam Browser policy input before assignment save", async () => {
    const published = await publishFixture({
      tenantId: "tenant_assignment_seb_validation",
      assessmentSlug: "assignment-seb-validation",
    });
    const request = buildAssignmentRequest({
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_seb_validation",
    });

    const invalidHashResponse = await postJson("/internal/assignments", {
      ...request,
      policySnapshot: {
        ...request.policySnapshot,
        safeExamBrowser: {
          verificationMode: "config-key",
          configKeyHash: "not-a-hash",
          browserExamKeys: [],
        },
      },
    });
    expect(invalidHashResponse.status).toBe(400);
    expect(await invalidHashResponse.json<{ error: string }>()).toMatchObject({
      error: "policySnapshot.safeExamBrowser.configKeyHash must be a 64-character hex hash",
    });

    const fallbackResponse = await postJson("/internal/assignments", {
      ...request,
      assignmentId: "assign_seb_fallback",
      policySnapshot: {
        ...request.policySnapshot,
        safeExamBrowser: {
          verificationMode: "config-key",
          configKeyHash: null,
          browserExamKeys: [],
          allowUserAgentFallback: true,
        },
      },
    });
    expect(fallbackResponse.status).toBe(400);
    expect(await fallbackResponse.json<{ error: string }>()).toMatchObject({
      error:
        "policySnapshot.safeExamBrowser.allowUserAgentFallback is disabled by server configuration",
    });

    const invalidPlatformResponse = await postJson("/internal/assignments", {
      ...request,
      assignmentId: "assign_seb_platform",
      policySnapshot: {
        ...request.policySnapshot,
        safeExamBrowser: {
          verificationMode: "browser-exam-key",
          configKeyHash: null,
          browserExamKeys: [
            {
              keyHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              platform: "linux",
            },
          ],
        },
      },
    });
    expect(invalidPlatformResponse.status).toBe(400);
    expect(await invalidPlatformResponse.json<{ error: string }>()).toMatchObject({
      error:
        "policySnapshot.safeExamBrowser.browserExamKeys[].platform must be windows, macos, ios, or unknown",
    });
  });
});
