import { recordStaffAccess } from "../staff/store";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { requireAdminKeyResponse } from "./admin-key";

function isUnsafeLocalFlagEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function isSignedQflowInternalRoute(method: string, pathname: string): boolean {
  return (
    method === "POST" &&
    (pathname === "/internal/qflow/handoff" ||
      pathname === "/internal/qflow/capability" ||
      pathname === "/internal/qflow/publish" ||
      pathname === "/internal/qflow/state")
  );
}

export function requireInternalApiAccessResponse(
  request: Request,
  env: Env,
  pathname: string,
): Response | null {
  if (!pathname.startsWith("/internal/")) {
    return null;
  }

  if (isSignedQflowInternalRoute(request.method, pathname)) {
    return null;
  }

  if (isUnsafeLocalFlagEnabled(env.ALLOW_UNSAFE_LOCAL_INTERNAL_API)) {
    return null;
  }

  return requireAdminKeyResponse(request, env);
}

export const internalApiMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const authError = requireInternalApiAccessResponse(c.req.raw, c.env, pathname);
  if (authError) {
    if (pathname.startsWith("/internal/staff/grants/"))
      await recordStaffAccess(c.env.HARBOR_DB, {
        tenantId: null,
        actorId: null,
        actorRole: null,
        operation: "staff-grant.access",
        resourceId: null,
        outcome: "denied",
        responseStatus: authError.status,
      });
    return authError;
  }

  await next();
};

export const adminKeyMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const authError = requireAdminKeyResponse(c.req.raw, c.env);
  if (authError) {
    return authError;
  }

  await next();
};
