import { testSession } from "@longsightgroup/lti-tool/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { bindVerifiedLtiSession } from "../src/lti/tenant-routing";
import type { LtiRegistrationRow } from "../src/lti/types";
import { getTestEnv, resetLtiProtocolTables } from "./lti-test-environment";

beforeEach(async () => {
  await resetLtiProtocolTables();
});

describe("LTI tenant session routing", () => {
  it("accepts identical binding replay and rejects ownership reassignment", async () => {
    const { HARBOR_DB } = getTestEnv();
    const registrationA = registrationFixture("a");
    const registrationB = registrationFixture("b");
    registrationB.tenant_id = registrationA.tenant_id;
    await insertRegistration(HARBOR_DB, registrationA);
    await insertRegistration(HARBOR_DB, registrationB);
    await insertProtocolSession(HARBOR_DB, "ltisess_bound", registrationA.tenant_id);

    const sessionA = testSession({
      id: "ltisess_bound",
      platform: {
        issuer: registrationA.issuer,
        clientId: registrationA.client_id,
        deploymentId: registrationA.deployment_id,
        name: "Platform A",
      },
    });
    await bindVerifiedLtiSession(HARBOR_DB, sessionA, registrationA);
    await expect(
      bindVerifiedLtiSession(HARBOR_DB, sessionA, registrationA),
    ).resolves.toBeUndefined();

    const sessionB = testSession({
      id: "ltisess_bound",
      platform: {
        issuer: registrationB.issuer,
        clientId: registrationB.client_id,
        deploymentId: registrationB.deployment_id,
        name: "Platform B",
      },
    });
    await expect(bindVerifiedLtiSession(HARBOR_DB, sessionB, registrationB)).rejects.toMatchObject({
      status: 409,
      message: "LTI session is already bound to another registration",
    });

    const binding = await HARBOR_DB.prepare(
      "SELECT registration_id, tenant_id FROM lti_session_bindings WHERE lti_session_id = ?",
    )
      .bind("ltisess_bound")
      .first<{ registration_id: string; tenant_id: string }>();
    expect(binding).toEqual({
      registration_id: registrationA.id,
      tenant_id: registrationA.tenant_id,
    });
  });
});

function registrationFixture(suffix: string): LtiRegistrationRow {
  return {
    id: `ltireg_${suffix}`,
    tenant_id: `tenant_${suffix}`,
    issuer: `https://platform-${suffix}.harbor.test`,
    client_id: `client-${suffix}`,
    deployment_id: `deployment-${suffix}`,
    authorization_endpoint: `https://platform-${suffix}.harbor.test/authorize`,
    token_endpoint: `https://platform-${suffix}.harbor.test/token`,
    jwks_url: `https://platform-${suffix}.harbor.test/jwks`,
  };
}

async function insertRegistration(
  database: D1Database,
  registration: LtiRegistrationRow,
): Promise<void> {
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO lti_registrations
         (id, tenant_id, issuer, client_id, deployment_id, authorization_endpoint, token_endpoint, jwks_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      registration.id,
      registration.tenant_id,
      registration.issuer,
      registration.client_id,
      registration.deployment_id,
      registration.authorization_endpoint,
      registration.token_endpoint,
      registration.jwks_url,
      now,
      now,
    )
    .run();
}

async function insertProtocolSession(
  database: D1Database,
  sessionId: string,
  tenantId: string,
): Promise<void> {
  await database
    .prepare("INSERT INTO lti_sessions (id, tenant_id, payload, expires_at) VALUES (?, ?, ?, ?)")
    .bind(sessionId, tenantId, "{}", Date.now() + 60_000)
    .run();
}
