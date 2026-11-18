import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

interface TestEnv {
  HARBOR_DB: D1Database;
  HARBOR_ADMIN_KEY: string;
  HARBOR_PASSWORD_RESET_FROM_EMAIL?: string;
  HARBOR_PUBLIC_ORIGIN?: string;
  EMAIL?: SendEmail;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
}

function getTestEnv(): TestEnv {
  return env as unknown as TestEnv;
}

const nativeEmail = env.EMAIL;

function observeResetEmails(): EmailMessage[] {
  const binding = nativeEmail;
  if (!binding) throw new Error("A local email binding is required");
  const messages: EmailMessage[] = [];
  getTestEnv().EMAIL = {
    async send(message: EmailMessage | EmailMessageBuilder) {
      if ("subject" in message) return binding.send(message);
      const result = await binding.send(message);
      messages.push(message);
      return result;
    },
  };
  return messages;
}

async function resetDb(): Promise<void> {
  const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "password_reset_requests",
    "password_login_attempts",
    "password_reset_tokens",
    "password_auth_accounts",
    "harbor_sessions",
    "learner_identities",
    "harbor_learners",
  ];
  const tables = await HARBOR_DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${knownTables
      .map(() => "?")
      .join(", ")})`,
  )
    .bind(...knownTables)
    .all<{ name: string }>();
  const deleteStatements = knownTables
    .filter((tableName) => tables.results.some((table) => table.name === tableName))
    .map((tableName) => `DELETE FROM ${tableName}`);
  if (deleteStatements.length > 0) {
    await HARBOR_DB.exec(`${deleteStatements.join("; ")};`);
  }

  getTestEnv().EMAIL = nativeEmail;
}

function postJson(path: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function createPasswordAccount(
  overrides: Partial<{
    tenantId: string;
    username: string;
    email: string;
    displayName: string;
    password: string;
  }> = {},
): Promise<Response> {
  const adminKey = getTestEnv().HARBOR_ADMIN_KEY ?? "harbor-admin-local-secret";
  return postJson(
    "/internal/auth/password/accounts",
    {
      tenantId: overrides.tenantId ?? "tenant_local_demo",
      username: overrides.username ?? "morgan",
      email: overrides.email ?? "morgan@example.edu",
      displayName: overrides.displayName ?? "Morgan Lee",
      password: overrides.password ?? "CorrectHorse123",
    },
    { "x-harbor-admin-key": adminKey },
  );
}

async function loginPassword(password = "CorrectHorse123"): Promise<Response> {
  return postJson("/api/auth/password/login", {
    usernameOrEmail: "morgan@example.edu",
    password,
  });
}

describe("password auth", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates an admin-managed account and logs in with a Harbor session cookie", async () => {
    const createResponse = await createPasswordAccount();
    expect(createResponse.status).toBe(201);

    const loginResponse = await loginPassword();
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get("set-cookie")).toContain("harbor_session=");

    const session = await loginResponse.json<{
      learner: { displayName: string; email: string | null };
      session: { providerKind: string };
    }>();
    expect(session.learner).toMatchObject({
      displayName: "Morgan Lee",
      email: "morgan@example.edu",
    });
    expect(session.session.providerKind).toBe("password");
  });

  it("rejects invalid credentials without creating a session", async () => {
    await createPasswordAccount();

    const response = await loginPassword("WrongHorse123");
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid username or password",
    });
  });

  it("throttles repeated failed login attempts before password verification", async () => {
    await createPasswordAccount();

    for (let index = 0; index < 8; index += 1) {
      expect((await loginPassword("WrongHorse123")).status).toBe(401);
    }

    const throttledResponse = await loginPassword("CorrectHorse123");
    expect(throttledResponse.status).toBe(429);
    await expect(throttledResponse.json()).resolves.toMatchObject({
      error: "Too many sign-in attempts. Try again later.",
    });
  });

  it("sends reset email without disclosing whether the account exists", async () => {
    await createPasswordAccount();
    const messages = observeResetEmails();
    getTestEnv().HARBOR_PASSWORD_RESET_FROM_EMAIL = "no-reply@deliver.example.test";
    getTestEnv().HARBOR_PUBLIC_ORIGIN = "https://deliver.example.test";

    const response = await postJson("/api/auth/password/forgot", {
      usernameOrEmail: "morgan@example.edu",
    });
    expect(response.status).toBe(200);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: "no-reply@deliver.example.test",
      to: "morgan@example.edu",
    });
    expect(readEmailMessageText(messages[0])).toContain(
      "https://deliver.example.test/reset-password",
    );
    expect(readEmailMessageText(messages[0])).toContain(
      "Subject: Reset your QFlowLearn Delivery password",
    );

    const unknownResponse = await postJson("/api/auth/password/forgot", {
      usernameOrEmail: "missing@example.edu",
    });
    expect(unknownResponse.status).toBe(200);
    expect(messages).toHaveLength(1);
  });

  it("throttles reset email requests while preserving the generic response", async () => {
    await createPasswordAccount();
    const messages = observeResetEmails();
    getTestEnv().HARBOR_PASSWORD_RESET_FROM_EMAIL = "no-reply@deliver.example.test";
    getTestEnv().HARBOR_PUBLIC_ORIGIN = "https://deliver.example.test";

    for (let index = 0; index < 3; index += 1) {
      const response = await postJson("/api/auth/password/forgot", {
        usernameOrEmail: "morgan@example.edu",
      });
      expect(response.status).toBe(200);
    }

    const throttledResponse = await postJson("/api/auth/password/forgot", {
      usernameOrEmail: "morgan@example.edu",
    });
    expect(throttledResponse.status).toBe(200);
    expect(messages).toHaveLength(3);
  });

  it("resets a password once and invalidates sibling reset tokens", async () => {
    await createPasswordAccount();
    const messages = observeResetEmails();
    getTestEnv().HARBOR_PASSWORD_RESET_FROM_EMAIL = "no-reply@deliver.example.test";
    getTestEnv().HARBOR_PUBLIC_ORIGIN = "https://deliver.example.test";

    await postJson("/api/auth/password/forgot", {
      usernameOrEmail: "morgan@example.edu",
    });
    await postJson("/api/auth/password/forgot", {
      usernameOrEmail: "morgan@example.edu",
    });
    const firstToken = extractResetToken(messages[0]);
    const secondToken = extractResetToken(messages[1]);

    const resetResponse = await postJson("/api/auth/password/reset", {
      token: secondToken,
      password: "NewCorrectHorse123",
    });
    expect(resetResponse.status).toBe(200);

    expect((await loginPassword()).status).toBe(401);
    expect((await loginPassword("NewCorrectHorse123")).status).toBe(200);

    const reuseResponse = await postJson("/api/auth/password/reset", {
      token: secondToken,
      password: "AnotherCorrectHorse123",
    });
    expect(reuseResponse.status).toBe(400);

    const siblingResponse = await postJson("/api/auth/password/reset", {
      token: firstToken,
      password: "SiblingCorrectHorse123",
    });
    expect(siblingResponse.status).toBe(400);
  });
});

function extractResetToken(message: unknown): string {
  const resetUrl = readEmailMessageText(message).match(
    /https:\/\/deliver\.example\.test\/reset-password\?\S+/,
  )?.[0];
  expect(resetUrl).toBeTruthy();
  const token = new URL(resetUrl ?? "").searchParams.get("token");
  expect(token).toBeTruthy();
  return token ?? "";
}

function readEmailMessageText(message: unknown): string {
  const text = Object.values(message as Record<string, unknown>).find(
    (value) => typeof value === "string" && value.includes("/reset-password"),
  );
  expect(text).toBeTruthy();
  return String(text);
}
