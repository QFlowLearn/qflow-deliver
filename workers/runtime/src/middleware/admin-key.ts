import type { Env } from "../env";

export const ADMIN_KEY_HEADER = "x-harbor-admin-key";

export function requireAdminKeyResponse(request: Request, env: Env): Response | null {
  const configured = env.HARBOR_ADMIN_KEY?.trim();
  if (!configured) {
    return Response.json(
      { error: "QFlowLearn Delivery admin API is not configured" },
      { status: 503 },
    );
  }

  if (request.headers.get(ADMIN_KEY_HEADER) !== configured) {
    return Response.json({ error: "Invalid QFlowLearn Delivery admin key" }, { status: 401 });
  }

  return null;
}
