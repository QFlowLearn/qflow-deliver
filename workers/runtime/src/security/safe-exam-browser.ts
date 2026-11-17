import type { SafeExamBrowserPolicySnapshot } from "@harbor/content-model";

export const SAFE_EXAM_BROWSER_CONFIG_KEY_HASH_HEADER = "x-safeexambrowser-configkeyhash";
export const SAFE_EXAM_BROWSER_REQUEST_HASH_HEADER = "x-safeexambrowser-requesthash";
export const HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER = "x-harbor-seb-js-configkeyhash";
export const HARBOR_SAFE_EXAM_BROWSER_JS_REQUEST_HASH_HEADER = "x-harbor-seb-js-requesthash";
export const HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER = "x-harbor-seb-js-proof-url";

export type SafeExamBrowserProofMethod =
  | "config-key-header"
  | "browser-exam-key-header"
  | "config-key-js-api"
  | "browser-exam-key-js-api"
  | "config-key-and-browser-exam-key"
  | "user-agent-demo";

export interface SafeExamBrowserProofResult {
  provider: "safe-exam-browser" | null;
  present: boolean;
  verified: boolean;
  method: SafeExamBrowserProofMethod | null;
  mismatch: boolean;
}

export async function evaluateSafeExamBrowserProof(input: {
  request: Request;
  policy: SafeExamBrowserPolicySnapshot | null | undefined;
  userAgentProvider: string | null;
  allowUnsafeUserAgentFallback?: boolean;
}): Promise<SafeExamBrowserProofResult> {
  const configKeyHash = normalizeHash(input.policy?.configKeyHash);
  const browserExamKeys = normalizeBrowserExamKeys(input.policy);
  const configKeyHeader = normalizeHash(
    input.request.headers.get(SAFE_EXAM_BROWSER_CONFIG_KEY_HASH_HEADER),
  );
  const browserExamKeyHeader = normalizeHash(
    input.request.headers.get(SAFE_EXAM_BROWSER_REQUEST_HASH_HEADER),
  );
  const jsConfigKeyHeader = normalizeHash(
    input.request.headers.get(HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER),
  );
  const jsBrowserExamKeyHeader = normalizeHash(
    input.request.headers.get(HARBOR_SAFE_EXAM_BROWSER_JS_REQUEST_HASH_HEADER),
  );
  const jsProofUrl = normalizeJsProofUrl({
    requestUrl: input.request.url,
    proofUrl: input.request.headers.get(HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER),
  });
  const hasKeyPolicy = configKeyHash !== null || browserExamKeys.length > 0;
  const hasHeader =
    configKeyHeader !== null ||
    browserExamKeyHeader !== null ||
    jsConfigKeyHeader !== null ||
    jsBrowserExamKeyHeader !== null;

  let configMethod: SafeExamBrowserProofMethod | null = null;
  let browserMethod: SafeExamBrowserProofMethod | null = null;
  if (configKeyHash && configKeyHeader) {
    const expected = await createSafeExamBrowserConfigKeyRequestHash({
      requestUrl: input.request.url,
      configKeyHash,
    });
    if (constantTimeEqualHex(expected, configKeyHeader)) {
      configMethod = "config-key-header";
    }
  }

  if (configKeyHash && jsConfigKeyHeader && jsProofUrl) {
    const expected = await createSafeExamBrowserConfigKeyRequestHash({
      requestUrl: jsProofUrl,
      configKeyHash,
    });
    if (constantTimeEqualHex(expected, jsConfigKeyHeader)) {
      configMethod = "config-key-js-api";
    }
  }

  if (browserExamKeyHeader && browserExamKeys.length > 0) {
    for (const keyHash of browserExamKeys) {
      const expectedHashes = await createSafeExamBrowserBrowserExamKeyRequestHashes({
        requestUrl: input.request.url,
        browserExamKey: keyHash,
      });
      if (expectedHashes.some((expected) => constantTimeEqualHex(expected, browserExamKeyHeader))) {
        browserMethod = "browser-exam-key-header";
        break;
      }
    }
  }

  if (jsBrowserExamKeyHeader && jsProofUrl && browserExamKeys.length > 0) {
    for (const keyHash of browserExamKeys) {
      const expectedHashes = await createSafeExamBrowserBrowserExamKeyRequestHashes({
        requestUrl: jsProofUrl,
        browserExamKey: keyHash,
      });
      if (
        expectedHashes.some((expected) => constantTimeEqualHex(expected, jsBrowserExamKeyHeader))
      ) {
        browserMethod = "browser-exam-key-js-api";
        break;
      }
    }
  }

  let method: SafeExamBrowserProofMethod | null = null;
  switch (input.policy?.verificationMode) {
    case "config-key":
      method = configMethod;
      break;
    case "browser-exam-key":
      method = browserMethod;
      break;
    case "config-key-and-browser-exam-key":
      if (configMethod && browserMethod) method = "config-key-and-browser-exam-key";
      break;
  }
  if (method) {
    return {
      provider: "safe-exam-browser",
      present: true,
      verified: true,
      method,
      mismatch: false,
    };
  }

  if (
    !hasKeyPolicy &&
    input.policy?.verificationMode === "config-key" &&
    ["localhost", "127.0.0.1", "[::1]", "harbor.local"].includes(
      new URL(input.request.url).hostname,
    ) &&
    input.allowUnsafeUserAgentFallback === true &&
    input.policy?.allowUserAgentFallback &&
    normalizeSafeExamBrowserProvider(input.userAgentProvider)
  ) {
    return {
      provider: "safe-exam-browser",
      present: true,
      verified: false,
      method: "user-agent-demo",
      mismatch: false,
    };
  }

  return {
    provider: hasHeader || hasKeyPolicy ? "safe-exam-browser" : null,
    present: normalizeSafeExamBrowserProvider(input.userAgentProvider) !== null || hasHeader,
    verified: false,
    method: null,
    mismatch: hasHeader,
  };
}

export function normalizeSafeExamBrowserProvider(
  value: string | null | undefined,
): "safe-exam-browser" | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  const compact = normalized.replace(/[\s_-]+/g, "");
  return compact === "safeexambrowser" || compact === "seb" ? "safe-exam-browser" : null;
}

export function isSafeExamBrowserProvider(value: string | null | undefined): boolean {
  return normalizeSafeExamBrowserProvider(value) !== null;
}

export function isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
  value: string | null | undefined,
): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export async function createSafeExamBrowserConfigKeyRequestHash(input: {
  requestUrl: string;
  configKeyHash: string;
}): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      `${canonicalizeSafeExamBrowserRequestUrl(input.requestUrl)}${normalizeRequiredHash(
        input.configKeyHash,
      )}`,
    ),
  );
}

export async function createSafeExamBrowserBrowserExamKeyRequestHashes(input: {
  requestUrl: string;
  browserExamKey: string;
}): Promise<string[]> {
  const canonicalUrl = canonicalizeSafeExamBrowserRequestUrl(input.requestUrl);
  const normalizedKey = normalizeRequiredHash(input.browserExamKey);
  const encodedUrl = new TextEncoder().encode(canonicalUrl);
  const textEncoded = await sha256Hex(new TextEncoder().encode(`${canonicalUrl}${normalizedKey}`));
  const keyBytes = decodeHex(normalizedKey);
  const combined = new Uint8Array(encodedUrl.length + keyBytes.length);
  combined.set(encodedUrl, 0);
  combined.set(keyBytes, encodedUrl.length);

  return [textEncoded, await sha256Hex(combined)];
}

export function canonicalizeSafeExamBrowserRequestUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.hash = "";
  return url.toString();
}

function normalizeJsProofUrl(input: {
  requestUrl: string;
  proofUrl: string | null;
}): string | null {
  if (!input.proofUrl) {
    return null;
  }

  try {
    const requestUrl = new URL(input.requestUrl);
    const proofUrl = new URL(input.proofUrl, requestUrl);
    if (requestUrl.origin !== proofUrl.origin) {
      return null;
    }
    proofUrl.hash = "";
    return proofUrl.toString();
  } catch {
    return null;
  }
}

export function normalizeHash(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function normalizeRequiredHash(value: string): string {
  const normalized = normalizeHash(value);
  if (!normalized) {
    throw new Error("Safe Exam Browser key hash must be 64 lowercase hex chars");
  }
  return normalized;
}

function normalizeBrowserExamKeys(
  policy: SafeExamBrowserPolicySnapshot | null | undefined,
): string[] {
  return (policy?.browserExamKeys ?? [])
    .map((entry) => normalizeHash(entry.keyHash))
    .filter((entry): entry is string => entry !== null);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function constantTimeEqualHex(left: string, right: string): boolean {
  const normalizedLeft = normalizeHash(left);
  const normalizedRight = normalizeHash(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    diff |= normalizedLeft.charCodeAt(index) ^ normalizedRight.charCodeAt(index);
  }
  return diff === 0;
}
