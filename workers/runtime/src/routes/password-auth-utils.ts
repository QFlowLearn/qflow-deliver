import { LaunchRequestError } from "../launch/create-preview-attempt";

export const DEFAULT_PASSWORD_TENANT_ID = "tenant_local_demo";
export const PASSWORD_RESET_TTL_SECONDS = 30 * 60;

const MIN_PASSWORD_LENGTH = 12;
const PASSWORD_ISSUER_PREFIX = "harbor:password";

export function readRequiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LaunchRequestError(400, `${key} is required`);
  }
  return value.trim();
}

export function readTenantId(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_PASSWORD_TENANT_ID;
  }
  return readRequiredString(value, "tenantId");
}

export function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeEmail(value: string): string {
  const email = normalizeIdentifier(value);
  if (!email.includes("@")) {
    throw new LaunchRequestError(400, "email must be a valid email address");
  }
  return email;
}

export function ensurePasswordAccepted(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new LaunchRequestError(
      400,
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
}

export function throwInvalidCredentials(): never {
  throw new LaunchRequestError(401, "Invalid username or password");
}

export function buildPasswordIssuer(tenantId: string): string {
  return `${PASSWORD_ISSUER_PREFIX}:${tenantId}`;
}

export function createPasswordAuthId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
