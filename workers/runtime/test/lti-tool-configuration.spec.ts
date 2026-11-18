import { beforeEach, describe, expect, it } from "vitest";

import { getHarborLtiTool } from "../src/lti/tool";
import { get, getTestEnv, postJson, resetDb } from "./lti-test-environment";
import { createRegistration } from "./lti-test-fixtures";
import { servePlatformJwks } from "./lti-test-platform";

beforeEach(async () => {
  await resetDb();
  servePlatformJwks();
});

describe("lti-tool configuration", () => {
  it("requires the configured LTI private JWK instead of generating a fallback key", async () => {
    await expect(
      getHarborLtiTool(
        {
          HARBOR_DB: getTestEnv().HARBOR_DB,
          BOOTSTRAP_SIGNING_SECRET: "test-secret",
          LTI_STATE_SECRET: "lti-state-test-secret",
          LTI_TOOL_PRIVATE_KEY_JWK: "",
        },
        "tenant_test",
      ),
    ).rejects.toThrow("LTI_TOOL_PRIVATE_KEY_JWK is required");
  });

  it("requires admin auth for internal LTI registration and does not expose mock LMS routes", async () => {
    const registrationPayload = {
      registrationId: "ltireg_admin_guard",
      tenantId: "tenant_local_demo",
      issuer: "https://platform.harbor.test",
      clientId: "harbor-client",
      deploymentId: "deployment-1",
      authorizationEndpoint: "https://platform.harbor.test/authorize",
      jwksUrl: "https://platform.harbor.test/jwks",
      tokenEndpoint: "https://platform.harbor.test/token",
    };

    const missingAuth = await postJson("/internal/lti/registrations", registrationPayload);
    expect(missingAuth.status).toBe(401);
    await expect(missingAuth.json()).resolves.toEqual({
      error: "Invalid QFlowLearn Delivery admin key",
    });

    const wrongAuth = await postJson("/internal/lti/registrations", registrationPayload, {
      "x-harbor-admin-key": "wrong-key",
    });
    expect(wrongAuth.status).toBe(401);
    await expect(wrongAuth.json()).resolves.toEqual({
      error: "Invalid QFlowLearn Delivery admin key",
    });

    const removedLmsJwks = await get("/internal/mock-lti/jwks");
    expect(removedLmsJwks.status).toBe(404);
  });

  it("exposes tool JWKS and retains registration token endpoints for services", async () => {
    const registration = await createRegistration({
      tokenEndpoint: "https://platform.harbor.test/oauth2/token",
    });

    expect(registration.tokenEndpoint).toBe("https://platform.harbor.test/oauth2/token");

    const stored = await getTestEnv()
      .HARBOR_DB.prepare("SELECT token_endpoint FROM lti_registrations WHERE id = ?")
      .bind(registration.registrationId)
      .first<{ token_endpoint: string | null }>();
    expect(stored?.token_endpoint).toBe("https://platform.harbor.test/oauth2/token");

    const jwksResponse = await get("/api/lti/jwks");
    expect(jwksResponse.status).toBe(200);
    const jwks = await jwksResponse.json<{ keys?: Array<{ kty?: string; kid?: string }> }>();
    expect(jwks.keys).toEqual([
      expect.objectContaining({
        kty: "RSA",
        kid: "main",
      }),
    ]);
  });
});
