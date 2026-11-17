import {
  BOOTSTRAP_EXCHANGE_PATH,
  BOOTSTRAP_TOKEN_AUDIENCE,
  BOOTSTRAP_TOKEN_ISSUER,
  BOOTSTRAP_TOKEN_TTL_SECONDS,
  type BootstrapClaims,
  type BootstrapEnvelope,
} from "@harbor/attempt-protocol";

import type { AttemptContext } from "./create-preview-attempt";
import { projectCandidateDeliveryPolicy } from "../delivery/candidate-delivery-policy";
import { fingerprintDeliveryPolicy } from "../delivery/delivery-policy";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class BootstrapTokenError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function issueBootstrapEnvelope(input: {
  attempt: AttemptContext;
  secret: string;
  now?: Date;
}): Promise<BootstrapEnvelope> {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + BOOTSTRAP_TOKEN_TTL_SECONDS;

  const token = await issueBootstrapToken({
    secret: input.secret,
    claims: {
      iss: BOOTSTRAP_TOKEN_ISSUER,
      aud: BOOTSTRAP_TOKEN_AUDIENCE,
      sub: `attempt:${input.attempt.attemptId}`,
      jti: createId("btok"),
      iat: issuedAt,
      exp: expiresAt,
      attemptId: input.attempt.attemptId,
      assessmentVersionId: input.attempt.assessmentVersionId,
      deliveryPolicy: input.attempt.deliveryPolicy,
      manifest: input.attempt.manifest,
      currentItemRef: input.attempt.currentItemRef,
      launch: input.attempt.launch,
    },
  });

  return {
    bootstrapToken: token,
    exchangeUrl: BOOTSTRAP_EXCHANGE_PATH,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    launch: input.attempt.launch,
  };
}

export async function issueBootstrapToken(input: {
  secret: string;
  claims: Omit<BootstrapClaims, "deliveryPolicyFingerprint">;
}): Promise<string> {
  const signingKey = await importSigningKey(input.secret);
  const encodedHeader = encodeJson({
    alg: "HS256",
    typ: "JWT",
  });
  const encodedClaims = encodeJson({
    ...input.claims,
    deliveryPolicy: projectCandidateDeliveryPolicy(input.claims.deliveryPolicy),
    deliveryPolicyFingerprint: await fingerprintDeliveryPolicy(input.claims.deliveryPolicy),
  });
  const payload = `${encodedHeader}.${encodedClaims}`;
  const signature = await crypto.subtle.sign("HMAC", signingKey, textEncoder.encode(payload));

  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyBootstrapToken(input: {
  secret: string;
  token: string;
}): Promise<BootstrapClaims> {
  const parts = input.token.split(".");
  if (parts.length !== 3) {
    throw new BootstrapTokenError(401, "Invalid bootstrap token");
  }

  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = parseJsonTokenPart<{ alg?: string; typ?: string }>(
    encodedHeader,
    "Invalid bootstrap token",
  );

  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new BootstrapTokenError(401, "Invalid bootstrap token");
  }

  const signingKey = await importSigningKey(input.secret);
  const expectedSignature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    textEncoder.encode(`${encodedHeader}.${encodedClaims}`),
  );

  if (!timingSafeEqual(new Uint8Array(expectedSignature), decodeBase64Url(encodedSignature))) {
    throw new BootstrapTokenError(401, "Invalid bootstrap token");
  }

  const claims = parseJsonTokenPart<BootstrapClaims>(encodedClaims, "Invalid bootstrap token");

  if (!isBootstrapClaims(claims)) {
    throw new BootstrapTokenError(401, "Invalid bootstrap token");
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new BootstrapTokenError(401, "Bootstrap token has expired");
  }

  if (claims.iss !== BOOTSTRAP_TOKEN_ISSUER || claims.aud !== BOOTSTRAP_TOKEN_AUDIENCE) {
    throw new BootstrapTokenError(401, "Invalid bootstrap token");
  }

  return claims;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  if (!secret.trim()) {
    throw new BootstrapTokenError(500, "Bootstrap signing secret is not configured");
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
    throw new BootstrapTokenError(401, errorMessage);
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

function isBootstrapClaims(value: unknown): value is BootstrapClaims {
  if (!value || typeof value !== "object") {
    return false;
  }

  const claims = value as Record<string, unknown>;
  return (
    typeof claims.iss === "string" &&
    typeof claims.aud === "string" &&
    typeof claims.sub === "string" &&
    typeof claims.jti === "string" &&
    typeof claims.iat === "number" &&
    typeof claims.exp === "number" &&
    typeof claims.attemptId === "string" &&
    typeof claims.assessmentVersionId === "string" &&
    typeof claims.deliveryPolicyFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(claims.deliveryPolicyFingerprint) &&
    typeof claims.deliveryPolicy === "object" &&
    claims.deliveryPolicy !== null &&
    typeof claims.manifest === "object" &&
    claims.manifest !== null &&
    typeof claims.currentItemRef === "object" &&
    claims.currentItemRef !== null &&
    typeof claims.launch === "object" &&
    claims.launch !== null
  );
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
