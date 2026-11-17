import { isLocalDemoUrl } from "../../security/local-demo";
import type {
  HarborLearnerRecord,
  HarborSessionRecord,
  InstitutionalSessionResponse,
  LearnerIdentityProviderKind,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { signHmacSha256Hex, verifyHmacSha256Hex } from "../../security/hmac-signed-value";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";

const HARBOR_SESSION_COOKIE = "harbor_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const AUTH_STATE_TTL_SECONDS = 10 * 60;
const DEFAULT_TENANT_ID = "tenant_local_demo";
const DEFAULT_INSTITUTIONAL_PROVIDER_KEY = "local-institutional";
const DEFAULT_INSTITUTIONAL_ISSUER = "https://institution.harbor.local";

interface AuthEnv {
  ALLOW_UNSAFE_LOCAL_INSTITUTIONAL_AUTH?: string;
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET: string;
}

interface SessionRow {
  session_id: string;
  learner_id: string;
  provider_kind: LearnerIdentityProviderKind;
  issuer: string;
  subject: string;
  status: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  tenant_id: string;
  display_name: string;
  email: string | null;
}

interface AuthStateRow {
  id: string;
  state: string;
  nonce: string;
  provider_key: string;
  redirect_to: string;
  profile_hint: string | null;
  requested_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface AuthenticatedLearnerContext {
  learner: HarborLearnerRecord;
  session: HarborSessionRecord;
}

export async function requireHarborSessionContext(
  request: Request,
  env: AuthEnv,
): Promise<AuthenticatedLearnerContext> {
  const context = await readHarborSessionContext(request, env);
  if (!context) {
    throw new LaunchRequestError(401, "QFlowLearn Delivery session is required");
  }

  return context;
}

export async function readHarborSessionContext(
  request: Request,
  env: AuthEnv,
): Promise<AuthenticatedLearnerContext | null> {
  const cookie = readCookie(request.headers.get("cookie"), HARBOR_SESSION_COOKIE);
  if (!cookie) {
    return null;
  }

  const sessionId = await verifySignedCookie(cookie, env.BOOTSTRAP_SIGNING_SECRET);
  if (!sessionId) {
    return null;
  }

  return readHarborSessionContextBySessionId(env, sessionId);
}

export async function readHarborSessionContextBySessionId(
  env: Pick<AuthEnv, "HARBOR_DB">,
  sessionId: string,
): Promise<AuthenticatedLearnerContext | null> {
  const row = await env.HARBOR_DB.prepare(
    "SELECT sessions.id AS session_id, sessions.learner_id, sessions.provider_kind, sessions.issuer, sessions.subject, sessions.status, sessions.created_at, sessions.expires_at, sessions.last_seen_at, sessions.revoked_at, learners.tenant_id, learners.display_name, learners.email FROM harbor_sessions sessions INNER JOIN harbor_learners learners ON learners.id = sessions.learner_id WHERE sessions.id = ?",
  )
    .bind(sessionId)
    .first<SessionRow>();

  if (!row) {
    return null;
  }

  const now = Date.now();
  const expired = Date.parse(row.expires_at) <= now;
  if (row.status !== "active" || row.revoked_at || expired) {
    if (expired && row.status !== "expired") {
      await env.HARBOR_DB.prepare(
        "UPDATE harbor_sessions SET status = ?, last_seen_at = ? WHERE id = ?",
      )
        .bind("expired", new Date().toISOString(), row.session_id)
        .run();
    }
    return null;
  }

  const touchedAt = new Date().toISOString();
  await env.HARBOR_DB.prepare("UPDATE harbor_sessions SET last_seen_at = ? WHERE id = ?")
    .bind(touchedAt, row.session_id)
    .run();

  return mapSessionRow({
    ...row,
    last_seen_at: touchedAt,
  });
}

export async function ensureLearnerIdentity(input: {
  db: D1Database;
  tenantId?: string;
  providerKind: LearnerIdentityProviderKind;
  issuer: string;
  subject: string;
  displayName: string;
  email?: string | null;
}): Promise<AuthenticatedLearnerContext["learner"]> {
  const existing = await input.db
    .prepare(
      "SELECT learners.id, learners.tenant_id, learners.display_name, learners.email, learners.created_at, learners.updated_at FROM learner_identities identities INNER JOIN harbor_learners learners ON learners.id = identities.learner_id WHERE identities.provider_kind = ? AND identities.issuer = ? AND identities.subject = ?",
    )
    .bind(input.providerKind, input.issuer, input.subject)
    .first<{
      id: string;
      tenant_id: string;
      display_name: string;
      email: string | null;
      created_at: string;
      updated_at: string;
    }>();

  const updatedAt = new Date().toISOString();
  if (existing) {
    if (input.tenantId && existing.tenant_id !== input.tenantId) {
      throw new LaunchRequestError(
        403,
        "Learner identity is already linked to a different QFlowLearn Delivery tenant",
      );
    }
    await input.db
      .prepare(
        "UPDATE harbor_learners SET display_name = ?, email = ?, updated_at = ? WHERE id = ?",
      )
      .bind(input.displayName, input.email ?? null, updatedAt, existing.id)
      .run();
    await input.db
      .prepare(
        "UPDATE learner_identities SET email = ?, display_name = ?, updated_at = ? WHERE provider_kind = ? AND issuer = ? AND subject = ?",
      )
      .bind(
        input.email ?? null,
        input.displayName,
        updatedAt,
        input.providerKind,
        input.issuer,
        input.subject,
      )
      .run();

    return {
      id: existing.id,
      tenantId: existing.tenant_id,
      displayName: input.displayName,
      email: input.email ?? null,
      createdAt: existing.created_at,
      updatedAt,
    };
  }

  const learnerId = createId("learner");
  const identityId = createId("ident");
  const createdAt = updatedAt;
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;

  await input.db.batch([
    input.db
      .prepare(
        "INSERT INTO harbor_learners (id, tenant_id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(learnerId, tenantId, input.displayName, input.email ?? null, createdAt, updatedAt),
    input.db
      .prepare(
        "INSERT INTO learner_identities (id, learner_id, provider_kind, issuer, subject, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        identityId,
        learnerId,
        input.providerKind,
        input.issuer,
        input.subject,
        input.email ?? null,
        input.displayName,
        createdAt,
        updatedAt,
      ),
  ]);

  return {
    id: learnerId,
    tenantId,
    displayName: input.displayName,
    email: input.email ?? null,
    createdAt,
    updatedAt,
  };
}

export async function createHarborSession(input: {
  db: D1Database;
  learner: HarborLearnerRecord;
  providerKind: LearnerIdentityProviderKind;
  issuer: string;
  subject: string;
}): Promise<HarborSessionRecord> {
  const sessionId = createId("hsess");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  await input.db
    .prepare(
      "INSERT INTO harbor_sessions (id, learner_id, provider_kind, issuer, subject, status, created_at, expires_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      sessionId,
      input.learner.id,
      input.providerKind,
      input.issuer,
      input.subject,
      "active",
      createdAt,
      expiresAt,
      createdAt,
      null,
    )
    .run();

  return {
    id: sessionId,
    learnerId: input.learner.id,
    providerKind: input.providerKind,
    issuer: input.issuer,
    subject: input.subject,
    status: "active",
    createdAt,
    expiresAt,
    lastSeenAt: createdAt,
    revokedAt: null,
  };
}

export async function buildSessionCookieHeader(
  sessionId: string,
  secret: string,
  expiresAt: string,
): Promise<string> {
  const signature = await signHmacSha256Hex(secret, sessionId);
  return serializeCookie(HARBOR_SESSION_COOKIE, `${sessionId}.${signature}`, expiresAt);
}

export function buildClearedSessionCookieHeader(): string {
  return `${HARBOR_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export async function handleSessionReadRequest(c: AppContext): Promise<Response> {
  return readSessionResponse({
    request: c.req.raw,
    env: c.env,
  });
}

export async function readSessionResponse(input: {
  request: Request;
  env: AuthEnv;
}): Promise<Response> {
  const context = await requireHarborSessionContext(input.request, input.env);
  const payload: InstitutionalSessionResponse = {
    learner: context.learner,
    session: context.session,
  };
  return Response.json(payload, { status: 200 });
}

export async function handleLogoutRequest(c: AppContext): Promise<Response> {
  return logoutHarborSession({
    request: c.req.raw,
    env: c.env,
  });
}

export async function logoutHarborSession(input: {
  request: Request;
  env: AuthEnv;
}): Promise<Response> {
  const context = await readHarborSessionContext(input.request, input.env);
  if (context) {
    await input.env.HARBOR_DB.prepare(
      "UPDATE harbor_sessions SET status = ?, revoked_at = ?, last_seen_at = ? WHERE id = ?",
    )
      .bind("revoked", new Date().toISOString(), new Date().toISOString(), context.session.id)
      .run();
  }

  return Response.json(
    { ok: true },
    {
      status: 200,
      headers: {
        "set-cookie": buildClearedSessionCookieHeader(),
      },
    },
  );
}

export async function handleInstitutionalLoginRequest(c: AppContext): Promise<Response> {
  return startInstitutionalLogin({
    env: c.env,
    url: requestUrl(c),
  });
}

export async function startInstitutionalLogin(input: {
  env: AuthEnv;
  url: URL;
}): Promise<Response> {
  requireLocalInstitutionalDemo(input.env, input.url);
  const stateId = createId("iauth");
  const state = crypto.randomUUID().replaceAll("-", "");
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + AUTH_STATE_TTL_SECONDS * 1000).toISOString();
  const redirectTo = sanitizeRedirectTo(input.url.searchParams.get("redirectTo"));
  const profileHint = readOptionalTrimmed(input.url.searchParams.get("profile")) ?? "demo-student";

  await input.env.HARBOR_DB.prepare(
    "INSERT INTO institutional_auth_states (id, state, nonce, provider_key, redirect_to, profile_hint, requested_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      stateId,
      state,
      nonce,
      DEFAULT_INSTITUTIONAL_PROVIDER_KEY,
      redirectTo,
      profileHint,
      createdAt,
      expiresAt,
      null,
    )
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      location: `/internal/mock-institutional/authorize?state=${encodeURIComponent(state)}`,
    },
  });
}

export async function handleMockInstitutionalAuthorizeRequest(c: AppContext): Promise<Response> {
  return mockInstitutionalAuthorize({
    env: c.env,
    url: requestUrl(c),
  });
}

export async function mockInstitutionalAuthorize(input: {
  env: AuthEnv;
  url: URL;
}): Promise<Response> {
  requireLocalInstitutionalDemo(input.env, input.url);
  const state = readRequiredQueryParam(input.url, "state");
  const authState = await readInstitutionalAuthState(input.env.HARBOR_DB, state);
  ensureAuthStateOpen(authState);

  return new Response(null, {
    status: 302,
    headers: {
      location: `/api/auth/institutional/callback?state=${encodeURIComponent(
        authState.state,
      )}&code=${encodeURIComponent(authState.id)}`,
    },
  });
}

export async function handleInstitutionalCallbackRequest(c: AppContext): Promise<Response> {
  return completeInstitutionalCallback({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function completeInstitutionalCallback(input: {
  request: Request;
  env: AuthEnv;
  url: URL;
}): Promise<Response> {
  requireLocalInstitutionalDemo(input.env, input.url);
  const state = readRequiredQueryParam(input.url, "state");
  const code = readRequiredQueryParam(input.url, "code");
  const authState = await readInstitutionalAuthState(input.env.HARBOR_DB, state);
  ensureAuthStateOpen(authState);

  if (code !== authState.id) {
    throw new LaunchRequestError(401, "Institutional callback code is invalid");
  }

  const profile = readInstitutionalProfile(authState.profile_hint);
  const learner = await ensureLearnerIdentity({
    db: input.env.HARBOR_DB,
    tenantId: DEFAULT_TENANT_ID,
    providerKind: "institutional-sso",
    issuer: DEFAULT_INSTITUTIONAL_ISSUER,
    subject: profile.subject,
    displayName: profile.displayName,
    email: profile.email,
  });
  const session = await createHarborSession({
    db: input.env.HARBOR_DB,
    learner,
    providerKind: "institutional-sso",
    issuer: DEFAULT_INSTITUTIONAL_ISSUER,
    subject: profile.subject,
  });

  await input.env.HARBOR_DB.prepare(
    "UPDATE institutional_auth_states SET consumed_at = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), authState.id)
    .run();

  const headers = new Headers();
  headers.set(
    "set-cookie",
    await buildSessionCookieHeader(
      session.id,
      input.env.BOOTSTRAP_SIGNING_SECRET,
      session.expiresAt,
    ),
  );
  headers.set("location", authState.redirect_to);

  return new Response(null, {
    status: 302,
    headers,
  });
}

function readInstitutionalProfile(profileHint: string | null): {
  subject: string;
  displayName: string;
  email: string;
} {
  switch (profileHint) {
    case "demo-student-alt":
      return {
        subject: "student-demo-alt",
        displayName: "Casey Rivera",
        email: "casey.rivera@example.edu",
      };
    default:
      return {
        subject: "student-demo",
        displayName: "Morgan Lee",
        email: "morgan.lee@example.edu",
      };
  }
}

async function readInstitutionalAuthState(db: D1Database, state: string): Promise<AuthStateRow> {
  const row = await db
    .prepare(
      "SELECT id, state, nonce, provider_key, redirect_to, profile_hint, requested_at, expires_at, consumed_at FROM institutional_auth_states WHERE state = ?",
    )
    .bind(state)
    .first<AuthStateRow>();

  if (!row) {
    throw new LaunchRequestError(401, "Institutional auth state is invalid");
  }

  return row;
}

function ensureAuthStateOpen(authState: AuthStateRow): void {
  if (authState.consumed_at) {
    throw new LaunchRequestError(409, "Institutional auth state has already been used");
  }

  if (Date.parse(authState.expires_at) <= Date.now()) {
    throw new LaunchRequestError(401, "Institutional auth state has expired");
  }
}

function mapSessionRow(row: SessionRow): AuthenticatedLearnerContext {
  return {
    learner: {
      id: row.learner_id,
      tenantId: row.tenant_id,
      displayName: row.display_name,
      email: row.email,
      createdAt: row.created_at,
      updatedAt: row.last_seen_at,
    },
    session: {
      id: row.session_id,
      learnerId: row.learner_id,
      providerKind: row.provider_kind,
      issuer: row.issuer,
      subject: row.subject,
      status: row.status as HarborSessionRecord["status"],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
    },
  };
}

async function verifySignedCookie(cookieValue: string, secret: string): Promise<string | null> {
  const [value, signature] = cookieValue.split(".", 2);
  if (!value || !signature) {
    return null;
  }

  return (await verifyHmacSha256Hex(secret, value, signature)) ? value : null;
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const chunk of cookieHeader.split(";")) {
    const [cookieName, ...rest] = chunk.trim().split("=");
    if (cookieName === name) {
      return rest.join("=");
    }
  }

  return null;
}

function serializeCookie(name: string, value: string, expiresAt: string): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(
    expiresAt,
  ).toUTCString()}`;
}

function sanitizeRedirectTo(value: string | null): string {
  const redirectTo = readOptionalTrimmed(value) ?? "/";
  if (!redirectTo.startsWith("/")) {
    return "/";
  }

  return redirectTo;
}

function readRequiredQueryParam(url: URL, key: string): string {
  const value = readOptionalTrimmed(url.searchParams.get(key));
  if (!value) {
    throw new LaunchRequestError(400, `${key} is required`);
  }

  return value;
}

function readOptionalTrimmed(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function requireLocalInstitutionalDemo(env: AuthEnv, url: URL): void {
  if (
    env.ALLOW_UNSAFE_LOCAL_INSTITUTIONAL_AUTH?.trim().toLowerCase() !== "true" ||
    !isLocalDemoUrl(url)
  )
    throw new LaunchRequestError(
      503,
      "Local institutional demo authentication is not available on this origin",
    );
}
