import { upsertLaunchRegistration } from "@longsightgroup/lti-tool";
import { exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHarborLtiRegistrationPath } from "../src/lti/registration-link";
import { D1RegistrationProjectionStore } from "../src/lti/registration-projection-store";
import { getHarborLtiCore, type HarborLtiToolEnv } from "../src/lti/tool";
import {
  ADMIN_HEADERS,
  countRows,
  get,
  getTestEnv,
  postJson,
  resetLtiProtocolTables,
} from "./lti-test-environment";

const LINK_ENV = {
  LTI_REGISTRATION_LINK_SECRET: "lti-registration-link-local-secret",
} as const;

beforeEach(async () => {
  await resetLtiProtocolTables();
});

describe("LTI dynamic registration", () => {
  it("round-trips signed tenant state and isolates package storage", async () => {
    const calls = stubDynamicRegistrationPlatform();
    const tenantPath = await createHarborLtiRegistrationPath(LINK_ENV, "tenant_a");
    const otherPath = await createHarborLtiRegistrationPath(LINK_ENV, "tenant_b");

    const unsigned = await get(
      "/api/lti/register/tenant_a?openid_configuration=https%3A%2F%2Fplatform.harbor.test%2F.well-known%2Fopenid-configuration",
    );
    expect(unsigned.status).toBe(404);

    const start = await startRegistration(tenantPath);
    expect(start.status).toBe(200);
    expect(await start.text()).toContain(`action="${tenantPath}/complete"`);
    const sessionToken = await readSessionToken("tenant_a");

    const wrongTenant = await completeRegistration(otherPath, sessionToken);
    expect(wrongTenant.status).toBe(400);
    await expect(wrongTenant.json()).resolves.toEqual({
      error: "Registration session is invalid or expired",
    });

    const complete = await completeRegistration(tenantPath, sessionToken);
    expect(complete.status).toBe(200);
    expect(await complete.text()).toContain("Registration Successful");
    expect(calls.filter((url) => url.endsWith("/register"))).toHaveLength(1);

    const projection = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT tenant_id FROM lti_registrations WHERE issuer = ? AND client_id = ? AND deployment_id = ?",
      )
      .bind("https://platform.harbor.test", "dynamic-client", "dynamic-deployment")
      .first<{ tenant_id: string }>();
    expect(projection?.tenant_id).toBe("tenant_a");

    const tenantCounts = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT tenant_id, COUNT(*) AS count FROM lti_clients GROUP BY tenant_id ORDER BY tenant_id",
      )
      .all<{ tenant_id: string; count: number }>();
    expect(tenantCounts.results).toEqual([{ tenant_id: "tenant_a", count: 1 }]);
  });

  it("atomically consumes a registration session under concurrent completion", async () => {
    const calls = stubDynamicRegistrationPlatform();
    const path = await createHarborLtiRegistrationPath(LINK_ENV, "tenant_concurrent");
    expect((await startRegistration(path)).status).toBe(200);
    const token = await readSessionToken("tenant_concurrent");

    const responses = await Promise.all([
      completeRegistration(path, token),
      completeRegistration(path, token),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const expired = responses.find((response) => response.status === 400);
    await expect(expired?.json()).resolves.toEqual({
      error: "Registration session is invalid or expired",
    });
    expect(calls.filter((url) => url.endsWith("/register"))).toHaveLength(1);
    expect(await countRows("lti_registrations")).toBe(1);
  });

  it("keeps protocol completion successful and reconciles a failed Harbor projection", async () => {
    const calls = stubDynamicRegistrationPlatform();
    const path = await createHarborLtiRegistrationPath(LINK_ENV, "tenant_projection_fail");
    expect((await startRegistration(path)).status).toBe(200);
    const token = await readSessionToken("tenant_projection_fail");
    await getTestEnv()
      .HARBOR_DB.prepare(
        `CREATE TRIGGER fail_registration_projection
         BEFORE INSERT ON lti_registrations
         BEGIN
           SELECT RAISE(ABORT, 'forced projection failure');
         END`,
      )
      .run();

    const complete = await completeRegistration(path, token);
    expect(complete.status).toBe(200);
    expect(await complete.text()).toContain("Registration Successful");
    expect(await countRows("lti_registrations")).toBe(0);
    expect(await countRows("lti_clients")).toBe(1);
    await getTestEnv().HARBOR_DB.exec("DROP TRIGGER fail_registration_projection");

    const registrationCalls = calls.filter((url) => url.endsWith("/register")).length;
    const reconcile = await postJson(
      "/internal/lti/registrations/reconcile",
      { tenantId: "tenant_projection_fail" },
      ADMIN_HEADERS,
    );
    expect(reconcile.status).toBe(200);
    expect(await countRows("lti_registrations")).toBe(1);
    expect(calls.filter((url) => url.endsWith("/register"))).toHaveLength(registrationCalls);
  });

  it("reconciles package storage into Harbor projections and rejects cross-tenant ownership", async () => {
    const calls = stubDynamicRegistrationPlatform();
    const path = await createHarborLtiRegistrationPath(LINK_ENV, "tenant_reconcile");
    expect((await startRegistration(path)).status).toBe(200);
    const token = await readSessionToken("tenant_reconcile");
    const complete = await completeRegistration(path, token);
    expect(complete.status).toBe(200);
    expect(await countRows("lti_registrations")).toBe(1);

    await getTestEnv().HARBOR_DB.exec("DELETE FROM lti_registrations");
    const registrationCalls = calls.filter((url) => url.endsWith("/register")).length;
    const reconcile = await postJson(
      "/internal/lti/registrations/reconcile",
      { tenantId: "tenant_reconcile" },
      ADMIN_HEADERS,
    );
    expect(reconcile.status).toBe(200);
    await expect(reconcile.json()).resolves.toEqual({
      tenantId: "tenant_reconcile",
      discoveredCount: 1,
      missingCount: 1,
      alreadyPresentCount: 0,
    });
    expect(await countRows("lti_registrations")).toBe(1);
    expect(calls.filter((url) => url.endsWith("/register"))).toHaveLength(registrationCalls);

    const { storage } = await getHarborLtiCore(
      getTestEnv() as unknown as HarborLtiToolEnv,
      "tenant_conflict",
    );
    await upsertLaunchRegistration(storage, {
      iss: "https://platform.harbor.test",
      clientId: "dynamic-client",
      deploymentId: "dynamic-deployment",
      authUrl: "https://platform.harbor.test/authorize",
      tokenUrl: "https://platform.harbor.test/token",
      jwksUrl: "https://platform.harbor.test/jwks",
    });
    const conflict = await postJson(
      "/internal/lti/registrations/reconcile",
      { tenantId: "tenant_conflict" },
      ADMIN_HEADERS,
    );
    expect(conflict.status).toBe(409);
    expect(await countRows("lti_registrations")).toBe(1);
  });

  it("rolls back every projection when ownership changes after reconciliation preflight", async () => {
    const { HARBOR_DB } = getTestEnv();
    await HARBOR_DB.prepare(
      `CREATE TRIGGER force_registration_tenant_race
       BEFORE INSERT ON lti_registrations
       WHEN NEW.issuer = 'https://conflict.harbor.test'
       BEGIN
         SELECT RAISE(ABORT, 'lti_registration_tenant_conflict');
       END`,
    ).run();

    const store = new D1RegistrationProjectionStore(HARBOR_DB);
    await expect(
      store.reconcile("tenant_race", [
        discoveredProjection("https://safe.harbor.test", "safe"),
        discoveredProjection("https://conflict.harbor.test", "conflict"),
      ]),
    ).rejects.toMatchObject({
      status: 409,
      message: "LTI registration is already owned by another tenant",
    });
    expect(await countRows("lti_registrations")).toBe(0);
  });
});

function discoveredProjection(issuer: string, suffix: string) {
  return {
    issuer,
    clientId: `client-${suffix}`,
    deploymentId: `deployment-${suffix}`,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUrl: `${issuer}/jwks`,
  };
}

function stubDynamicRegistrationPlatform(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push(url);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://platform.harbor.test",
          authorization_endpoint: "https://platform.harbor.test/authorize",
          registration_endpoint: "https://platform.harbor.test/register",
          jwks_uri: "https://platform.harbor.test/jwks",
          token_endpoint: "https://platform.harbor.test/token",
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
          token_endpoint_auth_signing_alg_values_supported: ["RS256"],
          scopes_supported: [
            "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
            "https://purl.imsglobal.org/spec/lti-ags/scope/score",
            "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
          ],
          response_types_supported: ["id_token"],
          id_token_signing_alg_values_supported: ["RS256"],
          claims_supported: ["iss", "sub", "name", "email"],
          subject_types_supported: ["public"],
          "https://purl.imsglobal.org/spec/lti-platform-configuration": {
            product_family_code: "moodle",
            version: "4.4",
            messages_supported: [
              { type: "LtiResourceLinkRequest" },
              { type: "LtiDeepLinkingRequest" },
            ],
          },
        });
      }
      if (url.endsWith("/register")) {
        const request = JSON.parse(String(init?.body)) as { scope: string };
        return Response.json({
          client_id: "dynamic-client",
          application_type: "web",
          response_types: ["id_token"],
          grant_types: ["implicit", "client_credentials"],
          initiate_login_uri: "https://harbor.local/api/lti/login",
          redirect_uris: ["https://harbor.local", "https://harbor.local/api/lti/launch"],
          client_name: "QFlowLearn Delivery",
          jwks_uri: "https://harbor.local/api/lti/jwks",
          token_endpoint_auth_method: "private_key_jwt",
          scope: request.scope,
          "https://purl.imsglobal.org/spec/lti-tool-configuration": {
            domain: "harbor.local",
            target_link_uri: "https://harbor.local",
            claims: ["iss", "sub", "name", "email"],
            messages: [{ type: "LtiResourceLinkRequest" }],
            deployment_id: "dynamic-deployment",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

function startRegistration(path: string): Promise<Response> {
  return get(
    `${path}?openid_configuration=https%3A%2F%2Fplatform.harbor.test%2F.well-known%2Fopenid-configuration&registration_token=registration-token`,
  );
}

function completeRegistration(path: string, sessionToken: string): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}/complete`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["services", "ags"],
        ["services", "nrps"],
        ["sessionToken", sessionToken],
      ]),
    }),
  );
}

async function readSessionToken(tenantId: string): Promise<string> {
  const row = await getTestEnv()
    .HARBOR_DB.prepare(
      `SELECT id
       FROM lti_registration_sessions
       WHERE tenant_id = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("Registration session not found");
  }
  return row.id;
}
