import { beforeEach, describe, expect, it } from "vitest";

import { applyTestMigrations, getTestEnv } from "./lti-test-environment";

beforeEach(async () => {
  await applyTestMigrations();
});

describe("tenant-scoped LTI storage foundation", () => {
  it("uses composite tenant keys and removes custom registration attempts", async () => {
    const { HARBOR_DB } = getTestEnv();
    const clients = await HARBOR_DB.prepare("PRAGMA table_info(lti_clients)").all<{
      name: string;
      pk: number;
    }>();
    const sessions = await HARBOR_DB.prepare("PRAGMA table_info(lti_sessions)").all<{
      name: string;
      pk: number;
    }>();
    const attempts = await HARBOR_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lti_registration_attempts'",
    ).first<{ name: string }>();

    expect(
      clients.results
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
    ).toEqual(["tenant_id", "id"]);
    expect(
      sessions.results
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
    ).toEqual(["tenant_id", "id"]);
    const sessionIndexes = await HARBOR_DB.prepare("PRAGMA index_list(lti_sessions)").all<{
      name: string;
      unique: number;
    }>();
    expect(
      sessionIndexes.results.some(
        (index) => index.name === "lti_sessions_id_uniq" && index.unique === 1,
      ),
    ).toBe(true);
    expect(attempts).toBeNull();
  });

  it("rejects duplicate protocol session ids across tenants", async () => {
    const { HARBOR_DB } = getTestEnv();
    await HARBOR_DB.prepare(
      "INSERT INTO lti_sessions (id, tenant_id, payload, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind("ltisess_shared", "tenant_a", "{}", Date.now() + 60_000)
      .run();
    await expect(
      HARBOR_DB.prepare(
        "INSERT INTO lti_sessions (id, tenant_id, payload, expires_at) VALUES (?, ?, ?, ?)",
      )
        .bind("ltisess_shared", "tenant_b", "{}", Date.now() + 60_000)
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("enforces immutable registration ownership and tenant-consistent session bindings", async () => {
    const { HARBOR_DB } = getTestEnv();
    const now = new Date().toISOString();
    await HARBOR_DB.prepare(
      `INSERT INTO lti_registrations
         (id, tenant_id, issuer, client_id, deployment_id, authorization_endpoint, token_endpoint, jwks_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "ltireg_binding",
        "tenant_binding",
        "https://platform.binding.test",
        "client-binding",
        "deployment-binding",
        "https://platform.binding.test/authorize",
        "https://platform.binding.test/token",
        "https://platform.binding.test/jwks",
        now,
        now,
      )
      .run();
    await HARBOR_DB.prepare(
      "INSERT INTO lti_sessions (id, tenant_id, payload, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind("ltisess_binding", "tenant_binding", "{}", Date.now() + 60_000)
      .run();
    await HARBOR_DB.prepare(
      `INSERT INTO lti_session_bindings
         (lti_session_id, registration_id, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind("ltisess_binding", "ltireg_binding", "tenant_binding", now, now)
      .run();

    await expect(
      HARBOR_DB.prepare("UPDATE lti_registrations SET tenant_id = ? WHERE id = ?")
        .bind("tenant_other", "ltireg_binding")
        .run(),
    ).rejects.toThrow("lti_registration_tenant_conflict");
    await expect(
      HARBOR_DB.prepare(
        `INSERT INTO lti_session_bindings
           (lti_session_id, registration_id, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind("missing-session", "ltireg_binding", "tenant_binding", now, now)
        .run(),
    ).rejects.toThrow("FOREIGN KEY constraint failed");
  });
});
