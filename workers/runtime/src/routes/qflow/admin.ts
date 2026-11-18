import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { readJsonObject, readRequiredString } from "../route-request-utils";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";
const QFLOW_PUBLISH_FEATURE_KEY = "qflow_publish";
const ADMIN_KEY_HEADER = "x-harbor-admin-key";

interface QflowAdminEnv {
  HARBOR_DB: D1Database;
  HARBOR_ADMIN_KEY?: string;
}

type QflowAdminLinkRequest = {
  qflowTenantId: string;
  tenantId: string;
  status?: "active" | "inactive";
  entitlementStatus?: "active" | "inactive";
  expiresAt?: string | null;
  grantedBy?: string;
  reason?: string;
};

export async function handleQflowAdminRequest(c: AppContext): Promise<Response> {
  return qflowAdmin({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function qflowAdmin(input: {
  request: Request;
  env: QflowAdminEnv;
  url: URL;
}): Promise<Response> {
  const { request, env } = input;
  requireAdminKey(request, env);

  if (request.method === "GET") {
    return Response.json(await listQflowTenantLinks(env.HARBOR_DB), { status: 200 });
  }

  if (request.method === "POST") {
    const body = await readJsonObject(request);
    const input = readQflowAdminLinkRequest(body);
    const record = await upsertQflowTenantLink({
      db: env.HARBOR_DB,
      input,
    });
    return Response.json(record, { status: 200 });
  }

  return Response.json({ error: "Route not found" }, { status: 404 });
}

async function listQflowTenantLinks(db: D1Database): Promise<{
  links: Array<{
    qflowTenantId: string;
    tenantId: string;
    linkStatus: string;
    entitlementStatus: string | null;
    effectiveAt: string;
    expiresAt: string | null;
    updatedAt: string;
  }>;
}> {
  const rows = await db
    .prepare(
      "SELECT qflow_tenant_links.qflow_tenant_id, qflow_tenant_links.tenant_id, qflow_tenant_links.status AS link_status, qflow_tenant_links.effective_at, qflow_tenant_links.expires_at, qflow_tenant_links.updated_at, tenant_feature_entitlements.status AS entitlement_status FROM qflow_tenant_links LEFT JOIN tenant_feature_entitlements ON tenant_feature_entitlements.tenant_id = qflow_tenant_links.tenant_id AND tenant_feature_entitlements.feature_key = ? ORDER BY qflow_tenant_links.updated_at DESC, qflow_tenant_links.qflow_tenant_id ASC",
    )
    .bind(QFLOW_PUBLISH_FEATURE_KEY)
    .all<{
      qflow_tenant_id: string;
      tenant_id: string;
      link_status: string;
      entitlement_status: string | null;
      effective_at: string;
      expires_at: string | null;
      updated_at: string;
    }>();

  return {
    links: rows.results.map((row) => ({
      qflowTenantId: row.qflow_tenant_id,
      tenantId: row.tenant_id,
      linkStatus: row.link_status,
      entitlementStatus: row.entitlement_status,
      effectiveAt: row.effective_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    })),
  };
}

async function upsertQflowTenantLink(input: {
  db: D1Database;
  input: QflowAdminLinkRequest;
}): Promise<{
  qflowTenantId: string;
  tenantId: string;
  linkStatus: string;
  entitlementStatus: string;
  effectiveAt: string;
  expiresAt: string | null;
}> {
  const now = new Date().toISOString();
  const linkStatus = input.input.status ?? "active";
  const entitlementStatus = input.input.entitlementStatus ?? linkStatus;
  const expiresAt = input.input.expiresAt ?? null;

  await input.db
    .prepare(
      "INSERT INTO qflow_tenant_links (id, qflow_tenant_id, tenant_id, status, effective_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(qflow_tenant_id) DO UPDATE SET tenant_id = excluded.tenant_id, status = excluded.status, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
    )
    .bind(
      createId("qflowlink"),
      input.input.qflowTenantId,
      input.input.tenantId,
      linkStatus,
      now,
      expiresAt,
      now,
      now,
    )
    .run();

  await input.db
    .prepare(
      "INSERT INTO tenant_feature_entitlements (id, tenant_id, feature_key, status, effective_at, expires_at, granted_by, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, feature_key) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at, granted_by = excluded.granted_by, reason = excluded.reason, updated_at = excluded.updated_at",
    )
    .bind(
      createId("ent"),
      input.input.tenantId,
      QFLOW_PUBLISH_FEATURE_KEY,
      entitlementStatus,
      now,
      expiresAt,
      input.input.grantedBy ?? "harbor-admin",
      input.input.reason ?? "qflow delivery subscription",
      now,
      now,
    )
    .run();

  return {
    qflowTenantId: input.input.qflowTenantId,
    tenantId: input.input.tenantId,
    linkStatus,
    entitlementStatus,
    effectiveAt: now,
    expiresAt,
  };
}

function requireAdminKey(request: Request, env: QflowAdminEnv): void {
  const configured = env.HARBOR_ADMIN_KEY?.trim();
  if (!configured) {
    throw new LaunchRequestError(503, "QFlowLearn Delivery admin API is not configured");
  }
  if (request.headers.get(ADMIN_KEY_HEADER) !== configured) {
    throw new LaunchRequestError(401, "Invalid QFlowLearn Delivery admin key");
  }
}

function readQflowAdminLinkRequest(body: Record<string, unknown>): QflowAdminLinkRequest {
  const qflowTenantId = readRequiredString(body.qflowTenantId, "qflowTenantId is required");
  const tenantId = readRequiredString(body.tenantId, "tenantId is required");
  const status = readStatus(body.status, "status");
  const entitlementStatus = readStatus(body.entitlementStatus, "entitlementStatus");
  const expiresAt = readNullableString(body.expiresAt, "expiresAt");
  return {
    qflowTenantId,
    tenantId,
    status,
    entitlementStatus,
    expiresAt,
    grantedBy: readAdminOptionalString(body.grantedBy),
    reason: readAdminOptionalString(body.reason),
  };
}

function readAdminOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new LaunchRequestError(400, `${field} must be a string or null`);
  }
  return value.trim() || null;
}

function readStatus(value: unknown, field: string): "active" | "inactive" | undefined {
  if (value === undefined) return undefined;
  if (value === "active" || value === "inactive") return value;
  throw new LaunchRequestError(400, `${field} must be active or inactive`);
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
