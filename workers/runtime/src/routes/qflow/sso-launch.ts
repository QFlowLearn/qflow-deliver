import {
  buildSessionCookieHeader,
  createHarborSession,
  ensureLearnerIdentity,
} from "../auth/session";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { issueBootstrapEnvelope } from "../../launch/sign-bootstrap";
import { buildEntryLaunchResolution, launchStudentAssignment } from "../launch";
import { appendAttemptTimelineEvent } from "../operator-actions";
import { resolveQflowLaunchAuthority } from "./launch-authority";
import { readQflowHandoffSecret } from "./signature";
import { verifyQflowSsoLaunchToken } from "./sso-token";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";

interface QflowSsoLaunchEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET: string;
  QFLOW_HANDOFF_SECRET?: string;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
}

export async function handleQflowSsoLaunchRequest(c: AppContext): Promise<Response> {
  return qflowSsoLaunch({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function qflowSsoLaunch(input: {
  request: Request;
  env: QflowSsoLaunchEnv;
  url: URL;
}): Promise<Response> {
  const { request, env, url } = input;
  const claims = await verifyQflowSsoLaunchToken({
    token: readRequiredQueryParam(url, "token"),
    secret: readQflowHandoffSecret(env),
  });
  const authority = await resolveQflowLaunchAuthority({
    db: env.HARBOR_DB,
    qflowTenantId: claims.qflowTenantId,
    assignmentId: claims.assignmentId,
    launchId: claims.jti,
  });
  await consumeQflowSsoLaunchToken({
    db: env.HARBOR_DB,
    qflowTenantId: claims.qflowTenantId,
    jti: claims.jti,
    assignmentId: claims.assignmentId,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  });

  const issuer = `qflowlearn:${claims.qflowTenantId}`;
  const learner = await ensureLearnerIdentity({
    db: env.HARBOR_DB,
    tenantId: authority.tenantId,
    providerKind: "institutional-sso",
    issuer,
    subject: claims.learner.subject,
    displayName: claims.learner.displayName,
    email: claims.learner.email ?? null,
  });
  if (learner.tenantId !== authority.tenantId) {
    throw new LaunchRequestError(
      403,
      "QFlow learner is not linked to this QFlowLearn Delivery tenant",
    );
  }
  const session = await createHarborSession({
    db: env.HARBOR_DB,
    learner,
    providerKind: "institutional-sso",
    issuer,
    subject: claims.learner.subject,
  });
  const context = { learner, session };
  const attempt = await launchStudentAssignment({
    db: env.HARBOR_DB,
    bucket: env.CONTENT_BUCKET,
    attemptCoordinator: env.ATTEMPT_COORDINATOR,
    assignmentId: claims.assignmentId,
    source: "institutional-sso",
    learner: context,
    eligibility: {
      kind: "external-signed-launch",
      source: "qflow",
      externalTenantId: authority.qflowTenantId,
      launchId: authority.launchId,
    },
    requestUrl: request.url,
  });
  const resolution = buildEntryLaunchResolution({
    attempt,
    source: "institutional-sso",
    assignmentId: claims.assignmentId,
    learnerId: learner.id,
    sessionId: session.id,
  });
  await appendAttemptTimelineEvent({
    db: env.HARBOR_DB,
    attemptId: attempt.attemptId,
    eventType: "launch",
    summary: {
      launchMode: resolution.source,
      assessmentVersionId: resolution.assessmentVersionId,
      assignmentId: resolution.assignmentId,
      learnerId: resolution.learnerId,
      sessionId: resolution.sessionId,
      qflowTenantId: authority.qflowTenantId,
      qflowLaunchId: authority.launchId,
    },
  });
  const envelope = await issueBootstrapEnvelope({
    attempt,
    secret: env.BOOTSTRAP_SIGNING_SECRET,
  });
  const headers = new Headers();
  headers.set(
    "set-cookie",
    await buildSessionCookieHeader(session.id, env.BOOTSTRAP_SIGNING_SECRET, session.expiresAt),
  );
  headers.set(
    "location",
    `/session?mode=institutional-sso&bootstrapToken=${encodeURIComponent(envelope.bootstrapToken)}`,
  );

  return new Response(null, { status: 302, headers });
}

function readRequiredQueryParam(url: URL, key: string): string {
  const value = url.searchParams.get(key)?.trim();
  if (!value) {
    throw new LaunchRequestError(400, `${key} is required`);
  }
  return value;
}

async function consumeQflowSsoLaunchToken(input: {
  db: D1Database;
  qflowTenantId: string;
  jti: string;
  assignmentId: string;
  expiresAt: string;
}): Promise<void> {
  try {
    await input.db
      .prepare(
        "INSERT INTO qflow_sso_launches (id, qflow_tenant_id, jti, assignment_id, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `qflowsso_${crypto.randomUUID().replaceAll("-", "")}`,
        input.qflowTenantId,
        input.jti,
        input.assignmentId,
        input.expiresAt,
        new Date().toISOString(),
      )
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new LaunchRequestError(401, "QFlow launch token has already been used");
    }
    throw error;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed|constraint failed/i.test(error.message)
  );
}
