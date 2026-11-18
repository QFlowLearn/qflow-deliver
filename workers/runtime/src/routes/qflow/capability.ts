import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { requireSignedQflowRequest } from "./signature";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";

const QFLOW_PUBLISH_FEATURE_KEY = "qflow_publish";

interface QflowCapabilityEnv {
  HARBOR_DB: D1Database;
  QFLOW_HANDOFF_SECRET?: string;
}

type QflowCapabilityRequest = {
  qflowTenantId: string;
  actorId?: string | null;
  issuedAt?: string | null;
};

type QflowCapabilityResponse =
  | {
      ok: true;
      enabled: true;
      qflowTenantId: string;
      tenantId: string;
    }
  | {
      ok: false;
      enabled: false;
      qflowTenantId: string;
      error: "qflow_tenant_not_linked" | "qflow_publish_not_entitled";
      message: string;
    };

export async function handleQflowCapabilityRequest(c: AppContext): Promise<Response> {
  return qflowCapability({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function qflowCapability(input: {
  request: Request;
  env: QflowCapabilityEnv;
  url: URL;
}): Promise<Response> {
  const { request, env } = input;
  const rawBody = await request.text();
  await requireSignedQflowRequest({ request, env, rawBody });
  const intent = parseCapabilityRequest(rawBody);
  const capability = await readQflowPublishCapability({
    db: env.HARBOR_DB,
    qflowTenantId: intent.qflowTenantId,
  });

  return Response.json(capability, {
    status: capability.enabled ? 200 : 403,
  });
}

async function readQflowPublishCapability(input: {
  db: D1Database;
  qflowTenantId: string;
}): Promise<QflowCapabilityResponse> {
  const now = new Date().toISOString();
  const link = await input.db
    .prepare(
      "SELECT tenant_id FROM qflow_tenant_links WHERE qflow_tenant_id = ? AND status = ? AND effective_at <= ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
    )
    .bind(input.qflowTenantId, "active", now, now)
    .first<{ tenant_id: string }>();

  if (!link) {
    return {
      ok: false,
      enabled: false,
      qflowTenantId: input.qflowTenantId,
      error: "qflow_tenant_not_linked",
      message: "QFlow tenant is not linked to an active QFlowLearn Delivery subscription",
    };
  }

  const entitlement = await input.db
    .prepare(
      "SELECT id FROM tenant_feature_entitlements WHERE tenant_id = ? AND feature_key = ? AND status = ? AND effective_at <= ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
    )
    .bind(link.tenant_id, QFLOW_PUBLISH_FEATURE_KEY, "active", now, now)
    .first<{ id: string }>();

  if (!entitlement) {
    return {
      ok: false,
      enabled: false,
      qflowTenantId: input.qflowTenantId,
      error: "qflow_publish_not_entitled",
      message: "QFlowLearn Delivery tenant is not entitled to QFlow publish",
    };
  }

  return {
    ok: true,
    enabled: true,
    qflowTenantId: input.qflowTenantId,
    tenantId: link.tenant_id,
  };
}

function parseCapabilityRequest(rawBody: string): QflowCapabilityRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new LaunchRequestError(400, "Request body must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LaunchRequestError(400, "Request body must be a JSON object");
  }

  const body = parsed as Record<string, unknown>;
  return {
    qflowTenantId: readRequiredString(body.qflowTenantId, "qflowTenantId is required"),
    actorId: readOptionalString(body.actorId),
    issuedAt: readOptionalString(body.issuedAt),
  };
}

function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LaunchRequestError(400, message);
  }

  return value.trim();
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new LaunchRequestError(400, "Optional string value must be a string");
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
