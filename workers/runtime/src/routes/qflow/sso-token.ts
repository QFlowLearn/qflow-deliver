import {
  QFLOW_SSO_LAUNCH_TOKEN_AUDIENCE,
  QFLOW_SSO_LAUNCH_TOKEN_ISSUER,
  QFLOW_SSO_LAUNCH_TOKEN_TTL_SECONDS,
  type QflowSsoLaunchTokenClaims,
  type QflowSsoLaunchTokenLearnerClaims,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { decodeBase64Url, signQflowValue } from "./signature";

export async function verifyQflowSsoLaunchToken(input: {
  token: string;
  secret: string;
}): Promise<QflowSsoLaunchTokenClaims> {
  const [payloadPart, signature] = input.token.split(".", 2);
  if (!payloadPart || !signature) {
    throw new LaunchRequestError(401, "QFlow launch token is malformed");
  }

  const expected = await signQflowValue(payloadPart, input.secret);
  if (signature !== expected) {
    throw new LaunchRequestError(401, "QFlow launch token signature is invalid");
  }

  return validateClaims(parseRawClaims(payloadPart));
}

function parseRawClaims(payloadPart: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadPart)));
  } catch {
    throw new LaunchRequestError(401, "QFlow launch token payload is invalid");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LaunchRequestError(401, "QFlow launch token payload is invalid");
  }

  return parsed as Record<string, unknown>;
}

function validateClaims(body: Record<string, unknown>): QflowSsoLaunchTokenClaims {
  const issuer = readRequiredString(body.iss, "QFlow launch token issuer is required");
  if (issuer !== QFLOW_SSO_LAUNCH_TOKEN_ISSUER) {
    throw new LaunchRequestError(401, "QFlow launch token issuer is invalid");
  }

  const audience = readRequiredString(body.aud, "QFlow launch token audience is required");
  if (audience !== QFLOW_SSO_LAUNCH_TOKEN_AUDIENCE) {
    throw new LaunchRequestError(401, "QFlow launch token audience is invalid");
  }

  const learner = readLearnerClaims(body.learner);
  const subject = readRequiredString(body.sub, "QFlow launch token subject is required");
  if (subject !== learner.subject) {
    throw new LaunchRequestError(401, "QFlow launch token subject does not match learner");
  }

  const claims: QflowSsoLaunchTokenClaims = {
    iss: issuer,
    aud: audience,
    sub: subject,
    jti: readRequiredString(body.jti, "QFlow launch token id is required"),
    iat: readRequiredInteger(body.iat, "QFlow launch token issued-at is required"),
    exp: readRequiredInteger(body.exp, "QFlow launch token expiry is required"),
    qflowTenantId: readRequiredString(body.qflowTenantId, "QFlow launch token tenant is required"),
    assignmentId: readRequiredString(
      body.assignmentId,
      "QFlow launch token assignment is required",
    ),
    learner,
  };

  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now + 60) {
    throw new LaunchRequestError(401, "QFlow launch token is not valid yet");
  }
  if (claims.exp <= now) {
    throw new LaunchRequestError(401, "QFlow launch token has expired");
  }
  if (claims.exp - claims.iat > QFLOW_SSO_LAUNCH_TOKEN_TTL_SECONDS) {
    throw new LaunchRequestError(401, "QFlow launch token lifetime is too long");
  }

  return claims;
}

function readLearnerClaims(value: unknown): QflowSsoLaunchTokenLearnerClaims {
  const learner = readRecord(value, "QFlow launch token learner is invalid");
  return {
    subject: readRequiredString(learner.subject, "QFlow launch token learner subject is required"),
    displayName: readRequiredString(
      learner.displayName,
      "QFlow launch token learner display name is required",
    ),
    email: readOptionalString(learner.email),
  };
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(401, message);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LaunchRequestError(401, message);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new LaunchRequestError(401, "QFlow launch token optional string is invalid");
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readRequiredInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value)) {
    throw new LaunchRequestError(401, message);
  }
  return value as number;
}
