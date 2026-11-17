import type { MiddlewareHandler } from "hono";
import type { AssignmentActorSnapshot } from "@harbor/attempt-protocol";
import type { Env } from "../../env";
import { isUnsafeSafeExamBrowserUserAgentFallbackEnabled } from "../../security/safe-exam-browser";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { readJsonObject } from "../route-request-utils";
import {
  authorizeStaffRoute,
  readStaffPrincipal,
  staffCommandActor,
  type StaffPrincipal,
} from "../../staff/authorization";
import { matchStaffRoute } from "../../staff/routes";
import { recordStaffAccess } from "../../staff/store";
import type { StaffGrant } from "../../staff/permissions";

export type InstructorRouteEnv = {
  Bindings: Env;
  Variables: {
    instructorTenantId: string;
    staffActor: AssignmentActorSnapshot;
    staffVisibleAssignmentIds: readonly string[] | null;
    staffGrants: readonly StaffGrant[];
  };
};

export function allowUnsafeSebUserAgentFallback(env: Env): boolean {
  return isUnsafeSafeExamBrowserUserAgentFallbackEnabled(env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK);
}

/** Authenticate, authorize an explicit operation, and attribute staff commands before dispatch. */
export const instructorAuthMiddleware: MiddlewareHandler<InstructorRouteEnv> = async (c, next) => {
  const matched = matchStaffRoute(c.req.method, new URL(c.req.url).pathname);
  const operation = matched
    ? `${matched.route.method} ${matched.route.path}`
    : "unknown-management-route";
  let principal: StaffPrincipal;
  try {
    principal = await readStaffPrincipal(c.req.raw, c.env);
  } catch (error: unknown) {
    if (!(error instanceof LaunchRequestError)) throw error;
    await recordStaffAccess(c.env.HARBOR_DB, {
      tenantId: null,
      actorId: null,
      actorRole: null,
      operation,
      resourceId: null,
      outcome: "denied",
      responseStatus: error.status,
    });
    return Response.json({ error: error.message }, { status: error.status });
  }
  const access = matched
    ? await authorizeStaffRoute(
        c.env.HARBOR_DB,
        principal,
        matched.route,
        matched.params,
        new URL(c.req.url),
      )
    : null;
  if (!matched || !access) {
    await recordStaffAccess(c.env.HARBOR_DB, {
      tenantId: principal.tenantId,
      actorId: principal.learnerId,
      actorRole: null,
      operation,
      resourceId: null,
      outcome: "denied",
      responseStatus: 403,
    });
    return c.json({ error: "Staff permission is required for this operation" }, 403);
  }
  const actor = staffCommandActor(principal, access.role);
  c.set("instructorTenantId", principal.tenantId);
  c.set("staffActor", actor);
  c.set("staffVisibleAssignmentIds", access.visibleAssignmentIds);
  c.set("staffGrants", principal.grants);
  await recordStaffAccess(c.env.HARBOR_DB, {
    tenantId: principal.tenantId,
    actorId: principal.learnerId,
    actorRole: access.role,
    operation,
    resourceId: access.assignmentId,
    outcome: "allowed",
    responseStatus: 200,
  });
  // The named local demo retains legacy fixture actors. It has no production authority.
  if (matched.route.actor && !principal.localDemo) {
    try {
      c.req.raw = await attributeStaffRequest(c.req.raw, actor);
    } catch (error: unknown) {
      if (!(error instanceof LaunchRequestError)) throw error;
      await recordStaffAccess(c.env.HARBOR_DB, {
        tenantId: principal.tenantId,
        actorId: principal.learnerId,
        actorRole: access.role,
        operation,
        resourceId: access.assignmentId,
        outcome: "failed",
        responseStatus: error.status,
      });
      return Response.json({ error: error.message }, { status: error.status });
    }
  }
  await next();
  await recordStaffAccess(c.env.HARBOR_DB, {
    tenantId: principal.tenantId,
    actorId: principal.learnerId,
    actorRole: access.role,
    operation,
    resourceId: access.assignmentId,
    outcome: c.res.status < 400 ? "completed" : "failed",
    responseStatus: c.res.status,
  });
};

async function attributeStaffRequest(
  request: Request,
  actor: AssignmentActorSnapshot,
): Promise<Request> {
  const headers = new Headers(request.headers);
  if (headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await request.clone().formData();
    form.set("actor", JSON.stringify(actor));
    headers.delete("content-type");
    headers.delete("content-length");
    return new Request(request.url, {
      method: request.method,
      headers,
      body: form,
      signal: request.signal,
      redirect: request.redirect,
    });
  }
  const body = await readJsonObject(request);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify({ ...body, actor }),
    signal: request.signal,
    redirect: request.redirect,
  });
}
