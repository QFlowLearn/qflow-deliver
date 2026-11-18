import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
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

function getAdminKey(): string {
  return (env as { HARBOR_ADMIN_KEY?: string }).HARBOR_ADMIN_KEY ?? "harbor-admin-local-secret";
}

function postAdmin(body: Record<string, unknown>, adminKey = getAdminKey()): Promise<Response> {
  return workerExports.default.fetch(
    new Request("https://harbor.local/internal/admin/qflow-tenants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harbor-admin-key": adminKey,
      },
      body: JSON.stringify(body),
    }),
  );
}

function getAdmin(adminKey = getAdminKey()): Promise<Response> {
  return workerExports.default.fetch(
    new Request("https://harbor.local/internal/admin/qflow-tenants", {
      method: "GET",
      headers: {
        "x-harbor-admin-key": adminKey,
      },
    }),
  );
}

beforeEach(async () => {
  await resetBindings();
});

describe("qflow admin subscription operations", () => {
  it("links a qflow tenant and grants qflow publish entitlement", async () => {
    const response = await postAdmin({
      qflowTenantId: "qflow_tenant_paid",
      tenantId: "tenant_paid_delivery",
      grantedBy: "ops",
      reason: "paid Harbor delivery subscription",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      qflowTenantId: "qflow_tenant_paid",
      tenantId: "tenant_paid_delivery",
      linkStatus: "active",
      entitlementStatus: "active",
    });

    const link = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT tenant_id, status FROM qflow_tenant_links WHERE qflow_tenant_id = ?",
      )
      .bind("qflow_tenant_paid")
      .first<{ tenant_id: string; status: string }>();
    expect(link).toMatchObject({
      tenant_id: "tenant_paid_delivery",
      status: "active",
    });

    const entitlement = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT status, granted_by, reason FROM tenant_feature_entitlements WHERE tenant_id = ? AND feature_key = ?",
      )
      .bind("tenant_paid_delivery", "qflow_publish")
      .first<{ status: string; granted_by: string; reason: string }>();
    expect(entitlement).toMatchObject({
      status: "active",
      granted_by: "ops",
      reason: "paid Harbor delivery subscription",
    });
  });

  it("can disable the entitlement and link for non-subscribers", async () => {
    await postAdmin({
      qflowTenantId: "qflow_tenant_paid",
      tenantId: "tenant_paid_delivery",
    });

    const response = await postAdmin({
      qflowTenantId: "qflow_tenant_paid",
      tenantId: "tenant_paid_delivery",
      status: "inactive",
      entitlementStatus: "inactive",
      reason: "subscription cancelled",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      linkStatus: "inactive",
      entitlementStatus: "inactive",
    });

    const entitlement = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT status, reason FROM tenant_feature_entitlements WHERE tenant_id = ? AND feature_key = ?",
      )
      .bind("tenant_paid_delivery", "qflow_publish")
      .first<{ status: string; reason: string }>();
    expect(entitlement).toMatchObject({
      status: "inactive",
      reason: "subscription cancelled",
    });
  });

  it("lists qflow tenant links with entitlement status", async () => {
    await postAdmin({
      qflowTenantId: "qflow_tenant_paid",
      tenantId: "tenant_paid_delivery",
    });

    const response = await getAdmin();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      links: [
        {
          qflowTenantId: "qflow_tenant_paid",
          tenantId: "tenant_paid_delivery",
          linkStatus: "active",
          entitlementStatus: "active",
        },
      ],
    });
  });

  it("rejects missing or invalid admin keys", async () => {
    const response = await postAdmin(
      {
        qflowTenantId: "qflow_tenant_paid",
        tenantId: "tenant_paid_delivery",
      },
      "wrong-key",
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid QFlowLearn Delivery admin key" });
  });
});
