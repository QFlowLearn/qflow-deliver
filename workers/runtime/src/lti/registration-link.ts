import {
  decodeBase64Url,
  encodeBase64Url,
  signHmacSha256Base64Url,
  verifyHmacSha256Base64Url,
} from "../security/hmac-signed-value";
import { readHarborLtiRegistrationLinkSecret } from "./config";

const REGISTRATION_LINK_CONTEXT = "harbor:lti-registration:v1:";

export interface HarborLtiRegistrationLinkEnv {
  readonly LTI_REGISTRATION_LINK_SECRET?: string;
}

/** Creates the signed public path an LMS administrator uses to register one Harbor tenant. */
export async function createHarborLtiRegistrationPath(
  env: HarborLtiRegistrationLinkEnv,
  tenantId: string,
): Promise<string> {
  const normalizedTenantId = parseTenantId(tenantId);
  const payload = encodeBase64Url(new TextEncoder().encode(normalizedTenantId));
  const signature = await signHmacSha256Base64Url(
    readHarborLtiRegistrationLinkSecret(env),
    `${REGISTRATION_LINK_CONTEXT}${normalizedTenantId}`,
  );
  return `/api/lti/register/${payload}.${signature}`;
}

/** Verifies a signed registration code and returns the tenant it was issued for. */
export async function readHarborLtiRegistrationTenantId(
  env: HarborLtiRegistrationLinkEnv,
  registrationCode: string,
): Promise<string | null> {
  const secret = readHarborLtiRegistrationLinkSecret(env);
  const parts = registrationCode.split(".");
  if (parts.length !== 2) {
    return null;
  }

  try {
    const tenantId = parseTenantId(new TextDecoder().decode(decodeBase64Url(parts[0])));
    const valid = await verifyHmacSha256Base64Url(
      secret,
      `${REGISTRATION_LINK_CONTEXT}${tenantId}`,
      parts[1],
    );
    return valid ? tenantId : null;
  } catch {
    return null;
  }
}

function parseTenantId(value: string): string {
  const tenantId = value.trim();
  if (!tenantId || tenantId.length > 200) {
    throw new Error("Invalid QFlowLearn Delivery tenant id");
  }
  for (const character of tenantId) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) throw new Error("Invalid QFlowLearn Delivery tenant id");
  }
  return tenantId;
}
