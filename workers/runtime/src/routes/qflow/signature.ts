import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { signHmacSha256Hex, verifyHmacSha256Hex } from "../../security/hmac-signed-value";

export { decodeBase64Url, encodeBase64Url } from "../../security/hmac-signed-value";

export const QFLOW_SIGNATURE_HEADER = "x-harbor-qflow-signature";

export interface QflowSignedRequestEnv {
  QFLOW_HANDOFF_SECRET?: string;
}

export async function requireSignedQflowRequest(input: {
  request: Request;
  env: QflowSignedRequestEnv;
  rawBody: string;
}): Promise<void> {
  const providedSignature = input.request.headers.get(QFLOW_SIGNATURE_HEADER);
  if (!providedSignature) {
    throw new LaunchRequestError(401, "Missing qflow handoff signature");
  }

  const valid = await verifyHmacSha256Hex(
    readQflowHandoffSecret(input.env),
    input.rawBody,
    providedSignature,
  );
  if (!valid) {
    throw new LaunchRequestError(401, "Invalid qflow handoff signature");
  }
}

export function readQflowHandoffSecret(env: QflowSignedRequestEnv): string {
  const secret = env.QFLOW_HANDOFF_SECRET?.trim();
  if (!secret) {
    throw new LaunchRequestError(500, "QFLOW_HANDOFF_SECRET is not configured");
  }

  return secret;
}

export async function signQflowValue(value: string, secret: string): Promise<string> {
  return signHmacSha256Hex(secret, value);
}
