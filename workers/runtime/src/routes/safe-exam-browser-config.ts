import { readPinnedSafeExamBrowserPolicy } from "../security/pinned-safe-exam-browser-policy";
import type {
  AssignmentPolicySnapshot,
  AssignmentStatus,
  StudentSafeExamBrowserLaunchResponse,
} from "@harbor/attempt-protocol";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import {
  buildGeneratedSafeExamBrowserSettings,
  buildGeneratedSafeExamBrowserUrls,
  buildSafeExamBrowserConfigFile,
  isGeneratedSafeExamBrowserConfigEnabled,
} from "../security/generated-safe-exam-browser-config";
import { parseStoredAssignmentPolicySnapshot } from "./assignment-request-parsers";
import { readHarborSessionContextBySessionId, requireHarborSessionContext } from "./auth/session";
import type { AppContext } from "./hono-utils";
import { readAssignmentIdParam } from "./route-params";

interface SafeExamBrowserConfigEnv {
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET: string;
}

interface StudentAssignmentRow {
  id: string;
  assessment_id: string;
  assessment_version_id: string;
  title: string;
  status: AssignmentStatus;
  policy_snapshot_json: string;
}

interface AttemptProjectionRow {
  id: string;
}

export interface SafeExamBrowserLaunchTokenClaims {
  typ: "harbor-seb-launch";
  assignmentId: string;
  learnerId: string;
  sessionId: string;
  iat: number;
  exp: number;
  jti: string;
}

const SAFE_EXAM_BROWSER_LAUNCH_TOKEN_TTL_SECONDS = 10 * 60;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function verifySafeExamBrowserLaunchToken(input: {
  token: string;
  secret: string;
}): Promise<SafeExamBrowserLaunchTokenClaims> {
  const parts = input.token.split(".");
  if (parts.length !== 3) {
    throw new LaunchRequestError(401, "Invalid Safe Exam Browser launch token");
  }

  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = parseJsonTokenPart<{ alg?: string; typ?: string }>(
    encodedHeader,
    "Invalid Safe Exam Browser launch token",
  );
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new LaunchRequestError(401, "Invalid Safe Exam Browser launch token");
  }

  const signingKey = await importSigningKey(input.secret);
  const expectedSignature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    textEncoder.encode(`${encodedHeader}.${encodedClaims}`),
  );

  if (!timingSafeEqual(new Uint8Array(expectedSignature), decodeBase64Url(encodedSignature))) {
    throw new LaunchRequestError(401, "Invalid Safe Exam Browser launch token");
  }

  const claims = parseJsonTokenPart<SafeExamBrowserLaunchTokenClaims>(
    encodedClaims,
    "Invalid Safe Exam Browser launch token",
  );
  if (!isSafeExamBrowserLaunchTokenClaims(claims)) {
    throw new LaunchRequestError(401, "Invalid Safe Exam Browser launch token");
  }

  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new LaunchRequestError(401, "Safe Exam Browser launch token has expired");
  }

  return claims;
}

export async function handleLaunchMetadataRequest(c: AppContext): Promise<Response> {
  return issueSafeExamBrowserLaunchMetadata({
    request: c.req.raw,
    env: c.env,
    assignmentId: readAssignmentIdParam(c),
  });
}

export async function issueSafeExamBrowserLaunchMetadata(input: {
  request: Request;
  env: SafeExamBrowserConfigEnv;
  assignmentId: string;
}): Promise<Response> {
  const context = await requireHarborSessionContext(input.request, input.env);
  const assignment = await readTargetedAssignment({
    db: input.env.HARBOR_DB,
    assignmentId: input.assignmentId,
    learnerId: context.learner.id,
  });
  const policy = await readPinnedSafeExamBrowserPolicy({
    db: input.env.HARBOR_DB,
    attemptCoordinator: input.env.ATTEMPT_COORDINATOR,
    assignmentId: assignment.id,
    learnerId: context.learner.id,
    initialPolicy: parseStoredAssignmentPolicySnapshot(assignment.policy_snapshot_json),
  });
  requireGeneratedSafeExamBrowserPolicy(policy);
  await requireLaunchableStudentAssignment({
    db: input.env.HARBOR_DB,
    assignment,
    policy,
    learnerId: context.learner.id,
  });

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SAFE_EXAM_BROWSER_LAUNCH_TOKEN_TTL_SECONDS;
  const token = await issueSafeExamBrowserLaunchToken({
    secret: input.env.BOOTSTRAP_SIGNING_SECRET,
    claims: {
      typ: "harbor-seb-launch",
      assignmentId: input.assignmentId,
      learnerId: context.learner.id,
      sessionId: context.session.id,
      iat: now,
      exp: expiresAt,
      jti: createId("sebtok"),
    },
  });
  const urls = buildStudentSafeExamBrowserUrls({
    requestUrl: input.request.url,
    assignmentId: input.assignmentId,
    launchToken: token,
  });

  return Response.json(
    {
      assignmentId: input.assignmentId,
      configDownloadUrl: urls.configDownloadUrl,
      configLaunchUrl: urls.configLaunchUrl,
      configFileName: urls.configFileName,
      startUrl: urls.startUrl,
      quitUrl: urls.quitUrl,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    } satisfies StudentSafeExamBrowserLaunchResponse,
    {
      status: 201,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

export async function handleConfigDownloadRequest(c: AppContext): Promise<Response> {
  return downloadSafeExamBrowserConfig({
    request: c.req.raw,
    env: c.env,
    assignmentId: readAssignmentIdParam(c),
  });
}

export async function downloadSafeExamBrowserConfig(input: {
  request: Request;
  env: SafeExamBrowserConfigEnv;
  assignmentId: string;
}): Promise<Response> {
  const token = readRequiredToken(new URL(input.request.url));
  const claims = await verifySafeExamBrowserLaunchToken({
    token,
    secret: input.env.BOOTSTRAP_SIGNING_SECRET,
  });
  if (claims.assignmentId !== input.assignmentId) {
    throw new LaunchRequestError(
      401,
      "Safe Exam Browser launch token does not match this assignment",
    );
  }

  const context = await readHarborSessionContextBySessionId(input.env, claims.sessionId);
  if (!context || context.learner.id !== claims.learnerId) {
    throw new LaunchRequestError(401, "QFlowLearn Delivery session is required");
  }

  const assignment = await readTargetedAssignment({
    db: input.env.HARBOR_DB,
    assignmentId: input.assignmentId,
    learnerId: context.learner.id,
  });
  const policy = await readPinnedSafeExamBrowserPolicy({
    db: input.env.HARBOR_DB,
    attemptCoordinator: input.env.ATTEMPT_COORDINATOR,
    assignmentId: assignment.id,
    learnerId: context.learner.id,
    initialPolicy: parseStoredAssignmentPolicySnapshot(assignment.policy_snapshot_json),
  });
  requireGeneratedSafeExamBrowserPolicy(policy);
  await requireLaunchableStudentAssignment({
    db: input.env.HARBOR_DB,
    assignment,
    policy,
    learnerId: context.learner.id,
  });

  const urls = buildStudentSafeExamBrowserUrls({
    requestUrl: input.request.url,
    assignmentId: input.assignmentId,
    launchToken: token,
  });
  const settings = buildGeneratedSafeExamBrowserSettings({
    urls: {
      startUrl: urls.startUrl,
      quitUrl: urls.quitUrl,
    },
    allowQuit: policy.safeExamBrowser?.generatedConfig?.allowQuit,
  });
  const config = await buildSafeExamBrowserConfigFile(settings);

  return new Response(toArrayBuffer(config), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${urls.configFileName}"`,
      "content-type": "application/seb",
    },
  });
}

function buildStudentSafeExamBrowserUrls(input: {
  requestUrl: string;
  assignmentId: string;
  launchToken: string;
}): StudentSafeExamBrowserLaunchResponse {
  const generatedUrls = buildGeneratedSafeExamBrowserUrls({
    requestUrl: input.requestUrl,
    assignmentId: input.assignmentId,
    launchToken: input.launchToken,
  });
  const configFileName = `${sanitizeFilePart(input.assignmentId)}.seb`;
  const configDownload = new URL(
    `/api/student/assignments/${encodeURIComponent(
      input.assignmentId,
    )}/safe-exam-browser/config.seb`,
    input.requestUrl,
  );
  configDownload.searchParams.set("token", input.launchToken);

  return {
    assignmentId: input.assignmentId,
    configDownloadUrl: configDownload.toString(),
    configLaunchUrl: toSebLaunchUrl(configDownload),
    configFileName,
    startUrl: generatedUrls.startUrl,
    quitUrl: generatedUrls.quitUrl,
    expiresAt: "",
  };
}

async function readTargetedAssignment(input: {
  db: D1Database;
  assignmentId: string;
  learnerId: string;
}): Promise<StudentAssignmentRow> {
  const direct = await input.db
    .prepare(
      "SELECT assignments.id, assignments.assessment_id, assignments.assessment_version_id, assignments.title, assignments.status, assignments.policy_snapshot_json FROM assignments INNER JOIN assignment_learner_targets targets ON targets.assignment_id = assignments.id WHERE assignments.id = ? AND targets.learner_id = ? LIMIT 1",
    )
    .bind(input.assignmentId, input.learnerId)
    .first<StudentAssignmentRow>();
  if (direct) {
    return direct;
  }

  const section = await input.db
    .prepare(
      "SELECT assignments.id, assignments.assessment_id, assignments.assessment_version_id, assignments.title, assignments.status, assignments.policy_snapshot_json FROM assignments INNER JOIN assignment_section_targets targets ON targets.assignment_id = assignments.id INNER JOIN section_memberships memberships ON memberships.section_id = targets.section_id WHERE assignments.id = ? AND memberships.learner_id = ? AND memberships.status = ? LIMIT 1",
    )
    .bind(input.assignmentId, input.learnerId, "active")
    .first<StudentAssignmentRow>();
  if (section) {
    return section;
  }

  throw new LaunchRequestError(403, "Learner is not eligible for the requested assignment");
}

async function requireLaunchableStudentAssignment(input: {
  db: D1Database;
  assignment: StudentAssignmentRow;
  policy: AssignmentPolicySnapshot;
  learnerId: string;
}): Promise<void> {
  const attempts = await input.db
    .prepare(
      "SELECT id FROM attempt_entries WHERE assignment_id = ? AND actor_kind = ? AND actor_id = ? ORDER BY created_at DESC",
    )
    .bind(input.assignment.id, "student-learner", input.learnerId)
    .all<AttemptProjectionRow>();
  const submittedAttemptIds = await readSubmittedAttemptIds(
    input.db,
    attempts.results.map((attempt) => attempt.id),
  );
  const latestAttempt = attempts.results[0] ?? null;
  const hasInProgressAttempt = latestAttempt !== null && !submittedAttemptIds.has(latestAttempt.id);
  if (hasInProgressAttempt) {
    return;
  }

  if (input.assignment.status !== "active") {
    throw new LaunchRequestError(403, "Assignment is not active");
  }

  const now = Date.now();
  if (input.policy.availableFrom && Date.parse(input.policy.availableFrom) > now) {
    throw new LaunchRequestError(403, "Assignment is not yet available");
  }
  if (input.policy.availableUntil && Date.parse(input.policy.availableUntil) < now) {
    throw new LaunchRequestError(403, "Assignment is no longer available");
  }
  if (attempts.results.length >= input.policy.maxAttempts) {
    throw new LaunchRequestError(403, "No remaining attempts are available for this assignment");
  }
}

async function readSubmittedAttemptIds(db: D1Database, attemptIds: string[]): Promise<Set<string>> {
  const submittedAttemptIds = new Set<string>();

  for (const chunk of chunkArray(attemptIds, 80)) {
    const submitted = await db
      .prepare(
        `SELECT attempt_id FROM attempt_results WHERE attempt_id IN (${chunk
          .map(() => "?")
          .join(", ")})`,
      )
      .bind(...chunk)
      .all<{ attempt_id: string }>();

    for (const row of submitted.results) {
      submittedAttemptIds.add(row.attempt_id);
    }
  }

  return submittedAttemptIds;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function requireGeneratedSafeExamBrowserPolicy(policy: AssignmentPolicySnapshot): void {
  if (!policy.secureBrowserRequired) {
    throw new LaunchRequestError(409, "Assignment does not require Safe Exam Browser");
  }

  if (!isGeneratedSafeExamBrowserConfigEnabled(policy.safeExamBrowser)) {
    throw new LaunchRequestError(
      409,
      "QFlowLearn Delivery Safe Exam Browser config is not enabled for this assignment",
    );
  }
}

async function issueSafeExamBrowserLaunchToken(input: {
  secret: string;
  claims: SafeExamBrowserLaunchTokenClaims;
}): Promise<string> {
  const encodedHeader = encodeJson({
    alg: "HS256",
    typ: "JWT",
  });
  const encodedClaims = encodeJson(input.claims);
  const payload = `${encodedHeader}.${encodedClaims}`;
  const signingKey = await importSigningKey(input.secret);
  const signature = await crypto.subtle.sign("HMAC", signingKey, textEncoder.encode(payload));

  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  if (!secret.trim()) {
    throw new LaunchRequestError(500, "Bootstrap signing secret is not configured");
  }

  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
}

function parseJsonTokenPart<T>(value: string, errorMessage: string): T {
  try {
    return JSON.parse(textDecoder.decode(decodeBase64Url(value))) as T;
  } catch {
    throw new LaunchRequestError(401, errorMessage);
  }
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(textEncoder.encode(JSON.stringify(value)));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }

  return mismatch === 0;
}

function isSafeExamBrowserLaunchTokenClaims(
  value: unknown,
): value is SafeExamBrowserLaunchTokenClaims {
  if (!value || typeof value !== "object") {
    return false;
  }

  const claims = value as Record<string, unknown>;
  return (
    claims.typ === "harbor-seb-launch" &&
    typeof claims.assignmentId === "string" &&
    typeof claims.learnerId === "string" &&
    typeof claims.sessionId === "string" &&
    typeof claims.iat === "number" &&
    typeof claims.exp === "number" &&
    typeof claims.jti === "string"
  );
}

function readRequiredToken(url: URL): string {
  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    throw new LaunchRequestError(401, "Safe Exam Browser launch token is required");
  }
  return token;
}

function toSebLaunchUrl(configDownload: URL): string {
  const scheme = configDownload.protocol === "https:" ? "sebs:" : "seb:";
  return `${scheme}//${configDownload.host}${configDownload.pathname}${configDownload.search}`;
}

function sanitizeFilePart(value: string): string {
  return `harbor-${value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "assessment"}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
