import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  QFLOW_HANDOFF_SECRET: string;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    QFLOW_HANDOFF_SECRET: string;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = ["qflow_tenant_links", "tenant_feature_entitlements"];

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

async function postCapability(body: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(body);
  return workerExports.default.fetch(
    new Request("https://harbor.local/internal/qflow/capability", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harbor-qflow-signature": await signBody(rawBody),
      },
      body: rawBody,
    }),
  );
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
      "qflow capability test entitlement",
      now,
      now,
    )
    .run();
}

beforeEach(async () => {
  await resetBindings();
});

describe("qflow delivery capability", () => {
  it("rejects unsigned capability checks", async () => {
    const response = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/qflow/capability", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qflowTenantId: "qflow_tenant_01" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Missing qflow handoff signature",
    });
  });

  it("returns enabled for linked and entitled qflow tenants", async () => {
    await linkQflowTenantToHarbor({
      qflowTenantId: "qflow_tenant_01",
      tenantId: "tenant_qflow_publish",
    });
    await grantQflowPublishEntitlement("tenant_qflow_publish");

    const response = await postCapability({ qflowTenantId: "qflow_tenant_01" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      enabled: true,
      qflowTenantId: "qflow_tenant_01",
      tenantId: "tenant_qflow_publish",
    });
  });

  it("returns disabled for unlinked qflow tenants", async () => {
    const response = await postCapability({ qflowTenantId: "qflow_tenant_01" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      enabled: false,
      qflowTenantId: "qflow_tenant_01",
      error: "qflow_tenant_not_linked",
      message: "QFlow tenant is not linked to an active QFlowLearn Delivery subscription",
    });
  });

  it("returns disabled for linked qflow tenants without publish entitlement", async () => {
    await linkQflowTenantToHarbor({
      qflowTenantId: "qflow_tenant_01",
      tenantId: "tenant_qflow_publish",
    });

    const response = await postCapability({ qflowTenantId: "qflow_tenant_01" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      enabled: false,
      qflowTenantId: "qflow_tenant_01",
      error: "qflow_publish_not_entitled",
      message: "QFlowLearn Delivery tenant is not entitled to QFlow publish",
    });
  });
});
