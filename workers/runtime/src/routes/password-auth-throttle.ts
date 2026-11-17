import { LaunchRequestError } from "../launch/create-preview-attempt";
import { sha256Hex } from "./password-auth-crypto";
import { createPasswordAuthId } from "./password-auth-utils";

const LOGIN_THROTTLE_WINDOW_SECONDS = 15 * 60;
const LOGIN_IDENTIFIER_FAILURE_LIMIT = 8;
const LOGIN_CLIENT_FAILURE_LIMIT = 20;
const RESET_THROTTLE_WINDOW_SECONDS = 60 * 60;
const RESET_IDENTIFIER_REQUEST_LIMIT = 3;
const RESET_CLIENT_REQUEST_LIMIT = 20;

export interface AttemptThrottleKey {
  tenantId: string;
  identifierHash: string;
  clientKeyHash: string;
}

export async function buildAttemptThrottleKey(input: {
  request: Request;
  tenantId: string;
  identifier: string;
}): Promise<AttemptThrottleKey> {
  const clientIp = input.request.headers.get("cf-connecting-ip") ?? "unknown";
  return {
    tenantId: input.tenantId,
    identifierHash: await sha256Hex(input.identifier),
    clientKeyHash: await sha256Hex(clientIp),
  };
}

export async function enforceLoginThrottle(db: D1Database, key: AttemptThrottleKey): Promise<void> {
  const since = new Date(Date.now() - LOGIN_THROTTLE_WINDOW_SECONDS * 1000).toISOString();
  const identifierFailures = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM password_login_attempts WHERE tenant_id = ? AND identifier_hash = ? AND outcome = ? AND attempted_at >= ?",
    )
    .bind(key.tenantId, key.identifierHash, "failure", since)
    .first<{ count: number }>();
  const clientFailures = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM password_login_attempts WHERE tenant_id = ? AND client_key_hash = ? AND outcome = ? AND attempted_at >= ?",
    )
    .bind(key.tenantId, key.clientKeyHash, "failure", since)
    .first<{ count: number }>();

  if (
    (identifierFailures?.count ?? 0) >= LOGIN_IDENTIFIER_FAILURE_LIMIT ||
    (clientFailures?.count ?? 0) >= LOGIN_CLIENT_FAILURE_LIMIT
  ) {
    throw new LaunchRequestError(429, "Too many sign-in attempts. Try again later.");
  }
}

export async function recordLoginFailure(db: D1Database, key: AttemptThrottleKey): Promise<void> {
  await db
    .prepare(
      "INSERT INTO password_login_attempts (id, tenant_id, identifier_hash, client_key_hash, outcome, attempted_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      createPasswordAuthId("pwlogin"),
      key.tenantId,
      key.identifierHash,
      key.clientKeyHash,
      "failure",
      new Date().toISOString(),
    )
    .run();
}

export async function clearLoginFailures(db: D1Database, key: AttemptThrottleKey): Promise<void> {
  await db
    .prepare(
      "DELETE FROM password_login_attempts WHERE tenant_id = ? AND identifier_hash = ? AND outcome = ?",
    )
    .bind(key.tenantId, key.identifierHash, "failure")
    .run();
}

export async function isPasswordResetThrottled(
  db: D1Database,
  key: AttemptThrottleKey,
): Promise<boolean> {
  const since = new Date(Date.now() - RESET_THROTTLE_WINDOW_SECONDS * 1000).toISOString();
  const identifierRequests = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM password_reset_requests WHERE tenant_id = ? AND identifier_hash = ? AND requested_at >= ?",
    )
    .bind(key.tenantId, key.identifierHash, since)
    .first<{ count: number }>();
  const clientRequests = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM password_reset_requests WHERE tenant_id = ? AND client_key_hash = ? AND requested_at >= ?",
    )
    .bind(key.tenantId, key.clientKeyHash, since)
    .first<{ count: number }>();

  return (
    (identifierRequests?.count ?? 0) >= RESET_IDENTIFIER_REQUEST_LIMIT ||
    (clientRequests?.count ?? 0) >= RESET_CLIENT_REQUEST_LIMIT
  );
}

export async function recordPasswordResetRequest(
  db: D1Database,
  key: AttemptThrottleKey,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO password_reset_requests (id, tenant_id, identifier_hash, client_key_hash, requested_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      createPasswordAuthId("pwforgot"),
      key.tenantId,
      key.identifierHash,
      key.clientKeyHash,
      new Date().toISOString(),
    )
    .run();
}
