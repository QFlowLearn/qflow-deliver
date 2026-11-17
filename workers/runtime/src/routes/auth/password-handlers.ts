import type { InstitutionalSessionResponse } from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { buildSessionCookieHeader, createHarborSession, ensureLearnerIdentity } from "./session";
import { readJsonObject } from "../route-request-utils";
import {
  hashPassword,
  PASSWORD_ALGORITHM,
  PASSWORD_ITERATIONS,
  randomBase64Url,
  sha256Hex,
  spendPasswordVerificationWork,
  verifyPassword,
  type PasswordHashRecord,
} from "../password-auth-crypto";
import {
  buildAttemptThrottleKey,
  clearLoginFailures,
  enforceLoginThrottle,
  isPasswordResetThrottled,
  recordLoginFailure,
  recordPasswordResetRequest,
} from "../password-auth-throttle";
import {
  buildPasswordIssuer,
  createPasswordAuthId,
  ensurePasswordAccepted,
  normalizeEmail,
  normalizeIdentifier,
  PASSWORD_RESET_TTL_SECONDS,
  readRequiredString,
  readTenantId,
  throwInvalidCredentials,
} from "../password-auth-utils";
import {
  buildResetEmailMessage,
  buildResetEmailText,
  buildResetUrl,
} from "../password-reset-email";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";

interface PasswordAuthEnv {
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET: string;
  EMAIL?: SendEmail;
  HARBOR_PASSWORD_RESET_FROM_EMAIL?: string;
  HARBOR_PUBLIC_ORIGIN?: string;
}

interface PasswordAccountRow extends PasswordHashRecord {
  id: string;
  learner_id: string;
  tenant_id: string;
  username_normalized: string;
  email_normalized: string;
  display_name: string;
  status: string;
}

interface PasswordResetRow extends PasswordAccountRow {
  token_id: string;
  expires_at: string;
  consumed_at: string | null;
}

export async function handlePasswordAccountCreateRequest(c: AppContext): Promise<Response> {
  return createPasswordAccount({
    request: c.req.raw,
    env: c.env,
  });
}

export async function createPasswordAccount(input: {
  request: Request;
  env: PasswordAuthEnv;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const tenantId = readRequiredString(body.tenantId, "tenantId");
  const username = normalizeIdentifier(readRequiredString(body.username, "username"));
  const email = normalizeEmail(readRequiredString(body.email, "email"));
  const displayName = readRequiredString(body.displayName, "displayName");
  const password = readRequiredString(body.password, "password");
  ensurePasswordAccepted(password);

  const existing = await readAccountByIdentifier(input.env.HARBOR_DB, tenantId, username);
  if (existing || email !== username) {
    const emailAccount = await readAccountByIdentifier(input.env.HARBOR_DB, tenantId, email);
    if (existing || emailAccount) {
      throw new LaunchRequestError(409, "Password account already exists");
    }
  }

  const accountId = createPasswordAuthId("pwa");
  const now = new Date().toISOString();
  const passwordDigest = await hashPassword(password);
  const learner = await ensureLearnerIdentity({
    db: input.env.HARBOR_DB,
    tenantId,
    providerKind: "password",
    issuer: buildPasswordIssuer(tenantId),
    subject: accountId,
    displayName,
    email,
  });

  await input.env.HARBOR_DB.prepare(
    "INSERT INTO password_auth_accounts (id, learner_id, tenant_id, username_normalized, email_normalized, display_name, password_hash, password_salt, password_algorithm, password_iterations, status, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      accountId,
      learner.id,
      tenantId,
      username,
      email,
      displayName,
      passwordDigest.hash,
      passwordDigest.salt,
      PASSWORD_ALGORITHM,
      PASSWORD_ITERATIONS,
      "active",
      now,
      now,
      null,
    )
    .run();

  return Response.json(
    {
      accountId,
      learnerId: learner.id,
      tenantId,
      username,
      email,
      status: "active",
    },
    { status: 201 },
  );
}

export async function handlePasswordLoginRequest(c: AppContext): Promise<Response> {
  return loginPasswordAccount({
    request: c.req.raw,
    env: c.env,
  });
}

export async function loginPasswordAccount(input: {
  request: Request;
  env: PasswordAuthEnv;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const tenantId = readTenantId(body.tenantId);
  const usernameOrEmail = normalizeIdentifier(
    readRequiredString(body.usernameOrEmail, "usernameOrEmail"),
  );
  const password = readRequiredString(body.password, "password");
  const throttleKey = await buildAttemptThrottleKey({
    request: input.request,
    tenantId,
    identifier: usernameOrEmail,
  });

  await enforceLoginThrottle(input.env.HARBOR_DB, throttleKey);

  const account = await readAccountByIdentifier(input.env.HARBOR_DB, tenantId, usernameOrEmail);
  if (!account || account.status !== "active") {
    await spendPasswordVerificationWork(password);
    await recordLoginFailure(input.env.HARBOR_DB, throttleKey);
    throwInvalidCredentials();
  }

  const passwordMatches = await verifyPassword(account, password);
  if (!passwordMatches) {
    await recordLoginFailure(input.env.HARBOR_DB, throttleKey);
    throwInvalidCredentials();
  }

  const learner = await ensureLearnerIdentity({
    db: input.env.HARBOR_DB,
    tenantId,
    providerKind: "password",
    issuer: buildPasswordIssuer(tenantId),
    subject: account.id,
    displayName: account.display_name,
    email: account.email_normalized,
  });
  const session = await createHarborSession({
    db: input.env.HARBOR_DB,
    learner,
    providerKind: "password",
    issuer: buildPasswordIssuer(tenantId),
    subject: account.id,
  });

  await input.env.HARBOR_DB.prepare(
    "UPDATE password_auth_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), new Date().toISOString(), account.id)
    .run();
  await clearLoginFailures(input.env.HARBOR_DB, throttleKey);

  const payload: InstitutionalSessionResponse = { learner, session };
  return Response.json(payload, {
    status: 200,
    headers: {
      "set-cookie": await buildSessionCookieHeader(
        session.id,
        input.env.BOOTSTRAP_SIGNING_SECRET,
        session.expiresAt,
      ),
    },
  });
}

export async function handlePasswordForgotRequest(c: AppContext): Promise<Response> {
  return requestPasswordReset({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function requestPasswordReset(input: {
  request: Request;
  env: PasswordAuthEnv;
  url: URL;
}): Promise<Response> {
  const from = input.env.HARBOR_PASSWORD_RESET_FROM_EMAIL?.trim();
  if (!input.env.EMAIL || !from) {
    throw new LaunchRequestError(503, "Password reset email is not configured");
  }

  const body = await readJsonObject(input.request);
  const tenantId = readTenantId(body.tenantId);
  const usernameOrEmail = normalizeIdentifier(
    readRequiredString(body.usernameOrEmail, "usernameOrEmail"),
  );
  const throttleKey = await buildAttemptThrottleKey({
    request: input.request,
    tenantId,
    identifier: usernameOrEmail,
  });
  if (await isPasswordResetThrottled(input.env.HARBOR_DB, throttleKey)) {
    await recordPasswordResetRequest(input.env.HARBOR_DB, throttleKey);
    return Response.json({ ok: true }, { status: 200 });
  }

  await recordPasswordResetRequest(input.env.HARBOR_DB, throttleKey);
  const account = await readAccountByIdentifier(input.env.HARBOR_DB, tenantId, usernameOrEmail);

  if (account?.status === "active") {
    const token = randomBase64Url(32);
    const tokenHash = await sha256Hex(token);
    const requestedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000).toISOString();

    await input.env.HARBOR_DB.batch([
      input.env.HARBOR_DB.prepare(
        "UPDATE password_reset_tokens SET consumed_at = ? WHERE account_id = ? AND consumed_at IS NULL",
      ).bind(requestedAt, account.id),
      input.env.HARBOR_DB.prepare(
        "INSERT INTO password_reset_tokens (id, account_id, token_hash, requested_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(createPasswordAuthId("pwreset"), account.id, tokenHash, requestedAt, expiresAt, null),
    ]);

    const emailText = buildResetEmailText({
      displayName: account.display_name,
      resetUrl: buildResetUrl({
        origin: input.env.HARBOR_PUBLIC_ORIGIN?.trim() || input.url.origin,
        token,
      }),
      expiresAt,
    });
    await input.env.EMAIL.send(
      buildResetEmailMessage({
        from,
        to: account.email_normalized,
        text: emailText,
      }),
    );
  }

  return Response.json({ ok: true }, { status: 200 });
}

export async function handlePasswordResetRequest(c: AppContext): Promise<Response> {
  return resetPasswordAccount({
    request: c.req.raw,
    env: c.env,
  });
}

export async function resetPasswordAccount(input: {
  request: Request;
  env: PasswordAuthEnv;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const token = readRequiredString(body.token, "token");
  const password = readRequiredString(body.password, "password");
  ensurePasswordAccepted(password);

  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const claim = await input.env.HARBOR_DB.prepare(
    "UPDATE password_reset_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
  )
    .bind(now, tokenHash, now)
    .run();
  if (claim.meta.changes !== 1) {
    throw new LaunchRequestError(400, "Password reset token is invalid or expired");
  }

  const reset = await readResetToken(input.env.HARBOR_DB, tokenHash);
  if (!reset) {
    throw new LaunchRequestError(400, "Password reset token is invalid or expired");
  }

  const passwordDigest = await hashPassword(password);
  await input.env.HARBOR_DB.batch([
    input.env.HARBOR_DB.prepare(
      "UPDATE password_auth_accounts SET password_hash = ?, password_salt = ?, password_algorithm = ?, password_iterations = ?, updated_at = ? WHERE id = ?",
    ).bind(
      passwordDigest.hash,
      passwordDigest.salt,
      PASSWORD_ALGORITHM,
      PASSWORD_ITERATIONS,
      now,
      reset.id,
    ),
    input.env.HARBOR_DB.prepare(
      "UPDATE password_reset_tokens SET consumed_at = ? WHERE account_id = ? AND consumed_at IS NULL",
    ).bind(now, reset.id),
  ]);

  return Response.json({ ok: true }, { status: 200 });
}

async function readAccountByIdentifier(
  db: D1Database,
  tenantId: string,
  identifier: string,
): Promise<PasswordAccountRow | null> {
  return await db
    .prepare(
      "SELECT id, learner_id, tenant_id, username_normalized, email_normalized, display_name, password_hash, password_salt, password_algorithm, password_iterations, status FROM password_auth_accounts WHERE tenant_id = ? AND (username_normalized = ? OR email_normalized = ?)",
    )
    .bind(tenantId, identifier, identifier)
    .first<PasswordAccountRow>();
}

async function readResetToken(db: D1Database, tokenHash: string): Promise<PasswordResetRow | null> {
  return await db
    .prepare(
      "SELECT accounts.id, accounts.learner_id, accounts.tenant_id, accounts.username_normalized, accounts.email_normalized, accounts.display_name, accounts.password_hash, accounts.password_salt, accounts.password_algorithm, accounts.password_iterations, accounts.status, tokens.id AS token_id, tokens.expires_at, tokens.consumed_at FROM password_reset_tokens tokens INNER JOIN password_auth_accounts accounts ON accounts.id = tokens.account_id WHERE tokens.token_hash = ?",
    )
    .bind(tokenHash)
    .first<PasswordResetRow>();
}
