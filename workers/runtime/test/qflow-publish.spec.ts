import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { QflowPublishResponse } from "@harbor/attempt-protocol";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";
import { qflowPublish } from "../src/routes/qflow/publish";
import { launchErrorToResponse } from "../src/middleware/launch-errors";

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

function getRouteEnv(): ReturnType<typeof getTestEnv> & {
  QFLOW_RUNNER_KEY: string;
} {
  return {
    ...getTestEnv(),
    QFLOW_RUNNER_KEY: "runner-test-key",
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "assignments",
    "qflow_assessment_mappings",
    "qflow_publish_requests",
    "qflow_tenant_links",
    "tenant_feature_entitlements",
    "assessment_version_validation_findings",
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

async function invokePublishHandler(invoke: () => Promise<Response>): Promise<Response> {
  try {
    return await invoke();
  } catch (error) {
    const response = launchErrorToResponse(error);
    if (response) {
      return response;
    }

    throw error;
  }
}

async function postSignedQflowPublish(
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const request = new Request("https://harbor.local/internal/qflow/publish", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harbor-qflow-signature": await signBody(rawBody),
    },
    body: rawBody,
  });

  return invokePublishHandler(() =>
    qflowPublish({
      request,
      env: getRouteEnv(),
      url: new URL(request.url),
      packageFetcher: fetcher,
    }),
  );
}

async function readCount(tableName: string): Promise<number> {
  const row = await getTestEnv()
    .HARBOR_DB.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .first<{ count: number }>();

  return row?.count ?? 0;
}

async function grantQflowPublishEntitlement(tenantId: string): Promise<void> {
  const now = "2026-04-28T00:00:00.000Z";
  await getTestEnv()
    .HARBOR_DB.prepare(
      "INSERT INTO tenant_feature_entitlements (id, tenant_id, feature_key, status, effective_at, expires_at, granted_by, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      `ent_${tenantId}`,
      tenantId,
      "qflow_publish",
      "active",
      now,
      null,
      "test",
      "qflow publish test entitlement",
      now,
      now,
    )
    .run();
}

async function linkQflowTenantToHarbor(input: {
  qflowTenantId: string;
  tenantId: string;
}): Promise<void> {
  const now = "2026-04-28T00:00:00.000Z";
  await getTestEnv()
    .HARBOR_DB.prepare(
      "INSERT INTO qflow_tenant_links (id, qflow_tenant_id, tenant_id, status, effective_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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

beforeEach(async () => {
  await resetBindings();
});

describe("qflow publish runtime behavior", () => {
  it("pulls a signed qflow package through the runner key and publishes it as an immutable Harbor version", async () => {
    const packageBytes = await createFixturePackage();
    await linkQflowTenantToHarbor({
      qflowTenantId: "qflow_tenant_01",
      tenantId: "tenant_qflow_publish",
    });
    await grantQflowPublishEntitlement("tenant_qflow_publish");
    const packageUrl =
      "https://qflow.local/api/assessments/qflow_assessment_01/package?format=qti3";
    const fetchRequests: Request[] = [];
    const fetcher: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      fetchRequests.push(request);

      return new Response(bodyFromBytes(packageBytes), {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "x-qflow-export-warning-count": "1",
          "x-qflow-export-warning-codes": "missing_alt_text",
        },
      });
    };

    const body = {
      publishId: "qpub_pull_01",
      qflowTenantId: "qflow_tenant_01",
      qflowAssessmentId: "qflow_assessment_01",
      assessmentSlug: "qflow-assessment-01",
      packageUrl,
      packageName: "qflow-assessment-01.zip",
      exportFormat: "qti3",
      exportWarnings: [{ code: "authoring_warning" }],
      actorId: "qflow_system",
      issuedAt: "2026-04-28T10:00:00.000Z",
    };

    const response = await postSignedQflowPublish(body, fetcher);
    expect(response.status).toBe(201);
    const payload = await response.json<QflowPublishResponse>();

    expect(fetchRequests).toHaveLength(1);
    expect(fetchRequests[0]?.url).toBe(packageUrl);
    expect(fetchRequests[0]?.headers.get("x-runner-key")).toBe("runner-test-key");
    expect(payload).toMatchObject({
      publishId: "qpub_pull_01",
      status: "published",
      source: {
        qflowTenantId: "qflow_tenant_01",
        qflowAssessmentId: "qflow_assessment_01",
        packageUrl,
        exportFormat: "qti3",
      },
    });
    expect(payload.version.assessmentId).toMatch(/^asmt_/);
    expect(payload.version.assessmentVersionId).toMatch(/^vers_/);
    expect(payload.links.previewUrl).toContain("/session?mode=preview");
    expect(payload.links.previewUrl).toContain(payload.version.assessmentVersionId);
    expect(payload.links.adminUrl).toContain("/assessments?assessmentVersionId=");
    expect(payload.fetchedPackage).toMatchObject({
      sizeBytes: packageBytes.byteLength,
      contentType: "application/zip",
    });
    expect(payload.validation?.summary).toMatchObject({
      readyForDelivery: true,
      blockedCount: 0,
    });
    expect(payload.validation?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "accepted",
          code: "qti.package.manifest-present",
        }),
      ]),
    );
    expect(payload.source.exportWarnings).toEqual([
      { code: "authoring_warning" },
      {
        source: "qflow-export-headers",
        count: 1,
        codes: ["missing_alt_text"],
      },
    ]);

    const { HARBOR_DB } = getTestEnv();
    const stateBody = {
      scope: "assessment-version",
      qflowTenantId: body.qflowTenantId,
      qflowAssessmentId: body.qflowAssessmentId,
      assessmentVersionId: payload.version.assessmentVersionId,
    };
    async function readState(overrides: Record<string, unknown> = {}) {
      const raw = JSON.stringify({ ...stateBody, ...overrides });
      return workerExports.default.fetch(
        new Request("https://harbor.local/internal/qflow/state", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harbor-qflow-signature": await signBody(raw),
          },
          body: raw,
        }),
      );
    }
    const emptyState = await readState();
    expect(emptyState.status).toBe(200);
    expect(await emptyState.json()).toEqual({
      assessmentVersionId: payload.version.assessmentVersionId,
      active: 0,
      draft: 0,
      closed: 0,
    });
    for (const [index, status] of ["active", "active", "draft", "closed"].entries()) {
      await HARBOR_DB.prepare(
        "INSERT INTO assignments (id, assessment_id, assessment_version_id, title, status, policy_snapshot_json, created_by_role, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          `state_assignment_${index}`,
          payload.version.assessmentId,
          payload.version.assessmentVersionId,
          "Assignment",
          status,
          "{}",
          "instructor",
          "test",
          "2026-01-01",
          "2026-01-01",
        )
        .run();
    }
    const populatedState = await readState();
    expect(await populatedState.json()).toEqual({
      assessmentVersionId: payload.version.assessmentVersionId,
      active: 2,
      draft: 1,
      closed: 1,
    });
    expect((await readState({ qflowTenantId: "unrelated" })).status).toBe(404);
    expect((await readState({ qflowAssessmentId: "unrelated" })).status).toBe(404);
    expect((await readState({ assessmentVersionId: "unrelated" })).status).toBe(404);
    const unsigned = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/qflow/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stateBody),
      }),
    );
    expect(unsigned.status).toBe(401);

    const publishRow = await HARBOR_DB.prepare(
      "SELECT id, qflow_assessment_id, assessment_id, assessment_version_id, package_sha256, export_warnings_json FROM qflow_publish_requests WHERE id = ?",
    )
      .bind("qpub_pull_01")
      .first<{
        id: string;
        qflow_assessment_id: string;
        assessment_id: string;
        assessment_version_id: string;
        package_sha256: string;
        export_warnings_json: string;
      }>();

    expect(publishRow).toMatchObject({
      id: "qpub_pull_01",
      qflow_assessment_id: "qflow_assessment_01",
      assessment_id: payload.version.assessmentId,
      assessment_version_id: payload.version.assessmentVersionId,
      package_sha256: payload.fetchedPackage.sha256,
    });
    expect(JSON.parse(publishRow?.export_warnings_json ?? "[]")).toEqual(
      payload.source.exportWarnings,
    );

    const mappingRow = await HARBOR_DB.prepare(
      "SELECT latest_assessment_version_id, latest_publish_request_id FROM qflow_assessment_mappings WHERE tenant_id = ? AND qflow_tenant_id = ? AND qflow_assessment_id = ?",
    )
      .bind("tenant_qflow_publish", "qflow_tenant_01", "qflow_assessment_01")
      .first<{
        latest_assessment_version_id: string;
        latest_publish_request_id: string;
      }>();

    expect(mappingRow).toEqual({
      latest_assessment_version_id: payload.version.assessmentVersionId,
      latest_publish_request_id: "qpub_pull_01",
    });

    const duplicateResponse = await postSignedQflowPublish(body, fetcher);
    expect(duplicateResponse.status).toBe(200);
    const duplicatePayload = await duplicateResponse.json<QflowPublishResponse>();
    expect(duplicatePayload.version.assessmentVersionId).toBe(payload.version.assessmentVersionId);
    expect(duplicatePayload.validation?.summary).toEqual(payload.validation?.summary);
    expect(fetchRequests).toHaveLength(1);
    expect(await readCount("assessment_versions")).toBe(1);
  });

  it("rejects unsigned route requests and conflicting publishId replays before mutating state", async () => {
    const unsignedRequest = new Request("https://harbor.local/internal/qflow/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        publishId: "qpub_unsigned_01",
        qflowTenantId: "qflow_tenant_01",
        qflowAssessmentId: "qflow_assessment_01",
        packageUrl: "https://qflow.local/api/assessments/qflow_assessment_01/package?format=qti3",
      }),
    });
    const unsignedResponse = await invokePublishHandler(() =>
      qflowPublish({
        request: unsignedRequest,
        env: getRouteEnv(),
        url: new URL(unsignedRequest.url),
      }),
    );

    expect(unsignedResponse.status).toBe(401);
    expect(await unsignedResponse.json()).toEqual({
      error: "Missing qflow handoff signature",
    });
    expect(await readCount("qflow_publish_requests")).toBe(0);

    const packageBytes = await createFixturePackage();
    await linkQflowTenantToHarbor({
      qflowTenantId: "qflow_tenant_01",
      tenantId: "tenant_qflow_publish",
    });
    await grantQflowPublishEntitlement("tenant_qflow_publish");
    const fetcher: typeof fetch = async () =>
      new Response(bodyFromBytes(packageBytes), {
        status: 200,
        headers: {
          "content-type": "application/zip",
        },
      });
    const body = {
      publishId: "qpub_conflict_01",
      qflowTenantId: "qflow_tenant_01",
      qflowAssessmentId: "qflow_assessment_01",
      packageUrl: "https://qflow.local/api/assessments/qflow_assessment_01/package?format=qti3",
    };

    const firstResponse = await postSignedQflowPublish(body, fetcher);
    expect(firstResponse.status).toBe(201);

    const conflictResponse = await postSignedQflowPublish(
      {
        ...body,
        packageUrl: "https://qflow.local/api/assessments/qflow_assessment_02/package?format=qti3",
      },
      fetcher,
    );
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toEqual({
      error: "QFlow publishId has already been used for a different signed request",
    });
    expect(await readCount("qflow_publish_requests")).toBe(1);
    expect(await readCount("assessment_versions")).toBe(1);
  });

  it("rejects unlinked qflow tenants before fetching a qflow package or creating Harbor publish rows", async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error("qflow package should not be fetched for non-subscribers");
    };

    const response = await postSignedQflowPublish(
      {
        publishId: "qpub_no_entitlement_01",
        qflowTenantId: "qflow_tenant_01",
        qflowAssessmentId: "qflow_assessment_01",
        packageUrl: "https://qflow.local/api/assessments/qflow_assessment_01/package?format=qti3",
      },
      fetcher,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "QFlow tenant is not linked to an active QFlowLearn Delivery subscription",
    });
    expect(await readCount("qflow_publish_requests")).toBe(0);
    expect(await readCount("assessment_versions")).toBe(0);
  });

  it("rejects linked tenants without a qflow publish entitlement before fetching a package", async () => {
    await linkQflowTenantToHarbor({
      qflowTenantId: "qflow_tenant_without_feature",
      tenantId: "tenant_without_feature",
    });
    const fetcher: typeof fetch = async () => {
      throw new Error("qflow package should not be fetched without entitlement");
    };

    const response = await postSignedQflowPublish(
      {
        publishId: "qpub_no_feature_01",
        qflowTenantId: "qflow_tenant_without_feature",
        qflowAssessmentId: "qflow_assessment_01",
        packageUrl: "https://qflow.local/api/assessments/qflow_assessment_01/package?format=qti3",
      },
      fetcher,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "QFlowLearn Delivery tenant is not entitled to QFlow publish",
    });
    expect(await readCount("qflow_publish_requests")).toBe(0);
    expect(await readCount("assessment_versions")).toBe(0);
  });
});
