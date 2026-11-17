import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QFLOW_SSO_LAUNCH_TOKEN_AUDIENCE,
  QFLOW_SSO_LAUNCH_TOKEN_ISSUER,
  type QflowSsoLaunchTokenClaims,
} from "@harbor/attempt-protocol";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";
import { encodeBase64Url, signQflowValue } from "../src/routes/qflow/signature";
import { verifyQflowSsoLaunchToken } from "../src/routes/qflow/sso-token";

const QFLOW_SSO_VECTOR_SECRET = "secret";
const QFLOW_SSO_VECTOR_CLAIMS: QflowSsoLaunchTokenClaims = {
  iss: QFLOW_SSO_LAUNCH_TOKEN_ISSUER,
  aud: QFLOW_SSO_LAUNCH_TOKEN_AUDIENCE,
  sub: "user-1",
  jti: "launch-1",
  iat: 1781956800,
  exp: 1781957100,
  qflowTenantId: "tenant-1",
  assignmentId: "assignment-1",
  learner: {
    subject: "user-1",
    displayName: "Morgan Lee",
    email: "morgan@example.edu",
  },
};
const QFLOW_SSO_VECTOR_TOKEN =
  "eyJpc3MiOiJxZmxvd2xlYXJuIiwiYXVkIjoiaGFyYm9yOnFmbG93LXNzby1sYXVuY2giLCJzdWIiOiJ1c2VyLTEiLCJqdGkiOiJsYXVuY2gtMSIsImlhdCI6MTc4MTk1NjgwMCwiZXhwIjoxNzgxOTU3MTAwLCJxZmxvd1RlbmFudElkIjoidGVuYW50LTEiLCJhc3NpZ25tZW50SWQiOiJhc3NpZ25tZW50LTEiLCJsZWFybmVyIjp7InN1YmplY3QiOiJ1c2VyLTEiLCJkaXNwbGF5TmFtZSI6Ik1vcmdhbiBMZWUiLCJlbWFpbCI6Im1vcmdhbkBleGFtcGxlLmVkdSJ9fQ.6c6303995a3c7b2748beb385fa6805749ded5828fc80431cc729e096aba93bd8";

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

async function resetDb(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "attempt_timeline_events",
    "harbor_sessions",
    "learner_identities",
    "harbor_learners",
    "qflow_sso_launches",
    "qflow_handoffs",
    "qflow_assessment_mappings",
    "qflow_publish_requests",
    "qflow_tenant_links",
    "assignment_section_targets",
    "assignment_learner_targets",
    "attempt_entries",
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

function bodyFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
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
        "x-harbor-package-name": "qflow-sso.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: bodyFromBytes(await createFixturePackage()),
    }),
  );
  expect(response.status).toBe(201);
  return response.json();
}

async function signBody(body: string): Promise<string> {
  return signQflowValue(body, getTestEnv().QFLOW_HANDOFF_SECRET);
}

async function postSignedQflowHandoff(body: Record<string, unknown>): Promise<Response> {
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

async function linkQflowTenant(input: { qflowTenantId: string; tenantId: string }): Promise<void> {
  const now = "2026-04-28T00:00:00.000Z";
  await getTestEnv()
    .HARBOR_DB.prepare(
      "INSERT INTO qflow_tenant_links (id, qflow_tenant_id, tenant_id, status, effective_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, status = excluded.status, effective_at = excluded.effective_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
    )
    .bind(
      `qflowlink_${input.qflowTenantId}`,
      input.qflowTenantId,
      input.tenantId,
      "active",
      now,
      null,
      now,
      now,
    )
    .run();
}

async function setupQflowAssignment(
  overrides: {
    tenantId?: string;
    qflowTenantId?: string;
    assessmentSlug?: string;
    assignmentId?: string;
    handoffId?: string;
  } = {},
): Promise<{ assignmentId: string; qflowTenantId: string; tenantId: string }> {
  const tenantId = overrides.tenantId ?? "tenant_qflow_sso";
  const qflowTenantId = overrides.qflowTenantId ?? "qflow_tenant_sso";
  await linkQflowTenant({ qflowTenantId, tenantId });
  const published = await publishFixture({
    tenantId,
    assessmentSlug: overrides.assessmentSlug ?? "qflow-sso-launch",
  });
  await recordQflowPublishFixture({
    tenantId,
    qflowTenantId,
    qflowAssessmentId: `${qflowTenantId}_assessment`,
    assessmentId: published.assessmentId,
    assessmentVersionId: published.assessmentVersionId,
    publishId: `publish_${overrides.handoffId ?? "handoff_qflow_sso"}`,
  });
  const assignmentId = overrides.assignmentId ?? "assign_qflow_sso";
  const response = await postSignedQflowHandoff({
    handoffId: overrides.handoffId ?? "handoff_qflow_sso",
    kind: "upsert-assignment",
    assignmentId,
    assessmentId: published.assessmentId,
    assessmentVersionId: published.assessmentVersionId,
    title: "QFlow SSO Assignment",
    status: "active",
    policySnapshot: {
      availableFrom: "2026-03-28T12:00:00.000Z",
      availableUntil: "2026-12-29T12:00:00.000Z",
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
      safeExamBrowser: null,
      proctoringProvider: null,
    },
    actorId: "qflow_system",
    actorDisplayName: "qflowlearn",
    issuedAt: "2026-04-28T12:00:00.000Z",
  });
  expect(response.status).toBe(200);
  return { assignmentId, qflowTenantId, tenantId };
}

async function recordQflowPublishFixture(input: {
  tenantId: string;
  qflowTenantId: string;
  qflowAssessmentId: string;
  assessmentId: string;
  assessmentVersionId: string;
  publishId: string;
}): Promise<void> {
  const now = "2026-04-28T12:00:00.000Z";
  await getTestEnv()
    .HARBOR_DB.prepare(
      "INSERT INTO qflow_publish_requests (id, tenant_id, qflow_tenant_id, qflow_assessment_id, assessment_slug, package_url, package_name, export_format, export_warnings_json, request_sha256, package_sha256, package_size_bytes, package_content_type, assessment_id, assessment_version_id, status, payload_json, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      input.publishId,
      input.tenantId,
      input.qflowTenantId,
      input.qflowAssessmentId,
      input.qflowAssessmentId,
      `https://qflow.local/packages/${input.qflowAssessmentId}.zip`,
      `${input.qflowAssessmentId}.zip`,
      "qti3",
      "[]",
      `request_sha_${input.publishId}`,
      `package_sha_${input.publishId}`,
      1024,
      "application/zip",
      input.assessmentId,
      input.assessmentVersionId,
      "published",
      "{}",
      now,
      now,
      now,
    )
    .run();
}

async function signLaunchToken(
  overrides: Partial<QflowSsoLaunchTokenClaims> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: QflowSsoLaunchTokenClaims = {
    iss: QFLOW_SSO_LAUNCH_TOKEN_ISSUER,
    aud: QFLOW_SSO_LAUNCH_TOKEN_AUDIENCE,
    sub: "qflow-user-1",
    jti: "qlaunch_test_1",
    iat: now,
    exp: now + 300,
    qflowTenantId: "qflow_tenant_sso",
    assignmentId: "assign_qflow_sso",
    learner: {
      subject: "qflow-user-1",
      displayName: "Morgan Lee",
      email: "morgan@example.edu",
    },
    ...overrides,
  };
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${await signBody(payload)}`;
}

beforeEach(async () => {
  await resetDb();
});

describe("qflow sso launch", () => {
  it("verifies the canonical qflow sso launch token vector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T12:01:00.000Z"));
    try {
      await expect(
        verifyQflowSsoLaunchToken({
          token: QFLOW_SSO_VECTOR_TOKEN,
          secret: QFLOW_SSO_VECTOR_SECRET,
        }),
      ).resolves.toEqual(QFLOW_SSO_VECTOR_CLAIMS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid qflow launch token claims", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T12:01:00.000Z"));
    try {
      const payload = encodeBase64Url(
        new TextEncoder().encode(
          JSON.stringify({
            ...QFLOW_SSO_VECTOR_CLAIMS,
            sub: "user-2",
          }),
        ),
      );
      const token = `${payload}.${await signQflowValue(payload, QFLOW_SSO_VECTOR_SECRET)}`;

      await expect(
        verifyQflowSsoLaunchToken({ token, secret: QFLOW_SSO_VECTOR_SECRET }),
      ).rejects.toThrow("QFlow launch token subject does not match learner");
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifies a signed qflow launch token, creates a Harbor session, and redirects to session", async () => {
    await setupQflowAssignment();
    const token = await signLaunchToken();
    const response = await workerExports.default.fetch(
      new Request(`https://harbor.local/api/qflow/sso/launch?token=${encodeURIComponent(token)}`, {
        redirect: "manual",
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("harbor_session=");
    expect(response.headers.get("location")).toContain(
      "/session?mode=institutional-sso&bootstrapToken=",
    );

    const learner = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT learners.display_name, learners.email FROM learner_identities identities INNER JOIN harbor_learners learners ON learners.id = identities.learner_id WHERE identities.provider_kind = ? AND identities.issuer = ? AND identities.subject = ?",
      )
      .bind("institutional-sso", "qflowlearn:qflow_tenant_sso", "qflow-user-1")
      .first<{ display_name: string; email: string | null }>();
    expect(learner).toMatchObject({
      display_name: "Morgan Lee",
      email: "morgan@example.edu",
    });
  });

  it("rejects replayed qflow launch tokens", async () => {
    await setupQflowAssignment();
    const token = await signLaunchToken({ jti: "qlaunch_replay" });
    const launchUrl = `https://harbor.local/api/qflow/sso/launch?token=${encodeURIComponent(
      token,
    )}`;

    const firstResponse = await workerExports.default.fetch(
      new Request(launchUrl, { redirect: "manual" }),
    );
    expect(firstResponse.status).toBe(302);

    const replayResponse = await workerExports.default.fetch(
      new Request(launchUrl, { redirect: "manual" }),
    );
    expect(replayResponse.status).toBe(401);
    await expect(replayResponse.json()).resolves.toMatchObject({
      error: "QFlow launch token has already been used",
    });
  });

  it("does not accept the admin key as a qflow learner launch credential", async () => {
    const response = await workerExports.default.fetch(
      new Request("https://harbor.local/api/qflow/sso/launch", {
        redirect: "manual",
        headers: { "x-harbor-admin-key": "admin" },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "token is required" });
  });

  it("rejects bad signatures, unlinked tenants, and non-qflow assignments", async () => {
    await setupQflowAssignment();
    const token = await signLaunchToken();
    const badSignature = await workerExports.default.fetch(
      new Request(
        `https://harbor.local/api/qflow/sso/launch?token=${encodeURIComponent(`${token}x`)}`,
        { redirect: "manual" },
      ),
    );
    expect(badSignature.status).toBe(401);

    const unlinked = await workerExports.default.fetch(
      new Request(
        `https://harbor.local/api/qflow/sso/launch?token=${encodeURIComponent(
          await signLaunchToken({ qflowTenantId: "qflow_missing" }),
        )}`,
        { redirect: "manual" },
      ),
    );
    expect(unlinked.status).toBe(403);

    const nonQflow = await workerExports.default.fetch(
      new Request(
        `https://harbor.local/api/qflow/sso/launch?token=${encodeURIComponent(
          await signLaunchToken({ assignmentId: "assign_missing" }),
        )}`,
        { redirect: "manual" },
      ),
    );
    expect(nonQflow.status).toBe(404);
  });

  it("rejects reused qflow learner identities from a previously linked Harbor tenant", async () => {
    await setupQflowAssignment({
      tenantId: "tenant_qflow_sso_old",
      qflowTenantId: "qflow_tenant_relinked",
      assessmentSlug: "qflow-sso-old",
      assignmentId: "assign_qflow_sso_old",
      handoffId: "handoff_qflow_sso_old",
    });
    const oldTenantToken = await signLaunchToken({
      qflowTenantId: "qflow_tenant_relinked",
      assignmentId: "assign_qflow_sso_old",
      jti: "qlaunch_old_tenant",
    });
    const oldTenantResponse = await workerExports.default.fetch(
      new Request(
        `https://harbor.local/api/qflow/sso/launch?token=${encodeURIComponent(oldTenantToken)}`,
        { redirect: "manual" },
      ),
    );
    expect(oldTenantResponse.status).toBe(302);

    await setupQflowAssignment({
      tenantId: "tenant_qflow_sso_new",
      qflowTenantId: "qflow_tenant_relinked",
      assessmentSlug: "qflow-sso-new",
      assignmentId: "assign_qflow_sso_new",
      handoffId: "handoff_qflow_sso_new",
    });
    const newTenantToken = await signLaunchToken({
      qflowTenantId: "qflow_tenant_relinked",
      assignmentId: "assign_qflow_sso_new",
      jti: "qlaunch_new_tenant",
    });
    const newTenantResponse = await workerExports.default.fetch(
      new Request(
        `https://harbor.local/api/qflow/sso/launch?token=${encodeURIComponent(newTenantToken)}`,
        { redirect: "manual" },
      ),
    );

    expect(newTenantResponse.status).toBe(403);
    await expect(newTenantResponse.json()).resolves.toMatchObject({
      error: "Learner identity is already linked to a different QFlowLearn Delivery tenant",
    });
  });

  it("rejects assignment launches from another qflow tenant linked to the same Harbor tenant", async () => {
    await setupQflowAssignment({
      tenantId: "tenant_shared_harbor",
      qflowTenantId: "qflow_tenant_a",
      assessmentSlug: "qflow-tenant-a",
      assignmentId: "assign_qflow_tenant_a",
      handoffId: "handoff_qflow_tenant_a",
    });
    await setupQflowAssignment({
      tenantId: "tenant_shared_harbor",
      qflowTenantId: "qflow_tenant_b",
      assessmentSlug: "qflow-tenant-b",
      assignmentId: "assign_qflow_tenant_b",
      handoffId: "handoff_qflow_tenant_b",
    });

    const response = await workerExports.default.fetch(
      new Request(
        `https://harbor.local/api/qflow/sso/launch?token=${encodeURIComponent(
          await signLaunchToken({
            qflowTenantId: "qflow_tenant_b",
            assignmentId: "assign_qflow_tenant_a",
            jti: "qlaunch_cross_qflow_tenant",
          }),
        )}`,
        { redirect: "manual" },
      ),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "QFlow assignment launch not found",
    });
  });
});
