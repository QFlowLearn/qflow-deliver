import { applyD1Migrations, createExecutionContext, env as testEnv } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import runtimeWorker, { type Env as RuntimeEnv } from "../src/index";

function buildProductionLikeEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    ...(env as unknown as RuntimeEnv),
    ALLOW_UNSAFE_LOCAL_INTERNAL_API: undefined,
    ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH: undefined,
    ...overrides,
  };
}

async function fetchRuntime(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  return (
    runtimeWorker.fetch as unknown as (
      request: Request,
      env: RuntimeEnv,
      ctx: ExecutionContext,
    ) => Promise<Response>
  )(request, runtimeEnv, createExecutionContext());
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.HARBOR_DB, testEnv.TEST_MIGRATIONS);
});

describe("runtime auth boundaries", () => {
  it("requires the admin key before dispatching non-qflow internal routes", async () => {
    const response = await fetchRuntime(
      new Request("https://harbor.local/internal/access-codes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      buildProductionLikeEnv({ HARBOR_ADMIN_KEY: "admin-boundary-test" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid QFlowLearn Delivery admin key" });
  });

  it("requires an instructor session when the local auth bypass is absent", async () => {
    const response = await fetchRuntime(
      new Request("https://harbor.local/api/instructor/assignments", {
        method: "GET",
      }),
      buildProductionLikeEnv(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "QFlowLearn Delivery session is required" });
  });

  it("fails qflow signed routes when the dedicated handoff secret is missing", async () => {
    const response = await fetchRuntime(
      new Request("https://harbor.local/internal/qflow/capability", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-harbor-qflow-signature": "placeholder",
        },
        body: JSON.stringify({ qflowTenantId: "qflow_boundary" }),
      }),
      buildProductionLikeEnv({ QFLOW_HANDOFF_SECRET: undefined }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "QFLOW_HANDOFF_SECRET is not configured",
    });
  });
});
