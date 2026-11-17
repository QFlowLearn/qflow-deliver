import type {
  SafeExamBrowserPlatform,
  SafeExamBrowserPolicySnapshot,
  SafeExamBrowserVerificationMode,
} from "@harbor/content-model";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import { normalizeHash } from "../security/safe-exam-browser";

const SAFE_EXAM_BROWSER_PLATFORMS = new Set<SafeExamBrowserPlatform>([
  "windows",
  "macos",
  "ios",
  "unknown",
]);

export interface SafeExamBrowserPolicyReadOptions {
  allowUnsafeUserAgentFallback?: boolean;
}

export function readSafeExamBrowserPolicy(
  value: unknown,
  options: SafeExamBrowserPolicyReadOptions = {},
): SafeExamBrowserPolicySnapshot | null {
  if (value === undefined || value === null) {
    return null;
  }

  const policy = readRecord(value, "policySnapshot.safeExamBrowser must be an object");
  for (const field of Object.keys(policy)) {
    if (
      ![
        "verificationMode",
        "configKeyHash",
        "browserExamKeys",
        "generatedConfig",
        "allowUserAgentFallback",
      ].includes(field)
    ) {
      throw new LaunchRequestError(
        400,
        "policySnapshot.safeExamBrowser contains an unsupported field",
      );
    }
  }
  const verificationMode = readVerificationMode(policy.verificationMode);
  const configKeyHash = readOptionalHash(
    policy.configKeyHash,
    "policySnapshot.safeExamBrowser.configKeyHash must be a 64-character hex hash",
  );
  const browserExamKeys = readSafeExamBrowserKeys(policy.browserExamKeys);
  const generatedConfig = readGeneratedSafeExamBrowserConfig(policy.generatedConfig);
  const allowUserAgentFallback = readOptionalBoolean(
    policy.allowUserAgentFallback,
    "policySnapshot.safeExamBrowser.allowUserAgentFallback must be a boolean",
  );

  if (allowUserAgentFallback && !options.allowUnsafeUserAgentFallback) {
    throw new LaunchRequestError(
      400,
      "policySnapshot.safeExamBrowser.allowUserAgentFallback is disabled by server configuration",
    );
  }

  if (
    !configKeyHash &&
    browserExamKeys.length === 0 &&
    !allowUserAgentFallback &&
    !generatedConfig
  ) {
    throw new LaunchRequestError(
      400,
      "policySnapshot.safeExamBrowser must include configKeyHash, browserExamKeys, or generatedConfig",
    );
  }

  if (
    verificationMode !== "browser-exam-key" &&
    !configKeyHash &&
    !generatedConfig &&
    !allowUserAgentFallback
  ) {
    throw new LaunchRequestError(400, "The configured SEB verification mode requires a Config Key");
  }
  if (verificationMode !== "config-key" && browserExamKeys.length === 0) {
    throw new LaunchRequestError(
      400,
      "The configured SEB verification mode requires an approved Browser Exam Key",
    );
  }

  return {
    verificationMode,
    configKeyHash,
    browserExamKeys,
    allowUserAgentFallback,
    generatedConfig,
  };
}

function readVerificationMode(value: unknown): SafeExamBrowserVerificationMode {
  if (
    value === "config-key" ||
    value === "browser-exam-key" ||
    value === "config-key-and-browser-exam-key"
  )
    return value;
  throw new LaunchRequestError(
    400,
    "policySnapshot.safeExamBrowser.verificationMode must explicitly select config-key, browser-exam-key, or config-key-and-browser-exam-key",
  );
}

function readSafeExamBrowserKeys(
  value: unknown,
): NonNullable<SafeExamBrowserPolicySnapshot["browserExamKeys"]> {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new LaunchRequestError(
      400,
      "policySnapshot.safeExamBrowser.browserExamKeys must be an array",
    );
  }

  return value.map((entry) => {
    const record = readRecord(
      entry,
      "policySnapshot.safeExamBrowser.browserExamKeys must contain objects",
    );
    return {
      keyHash: readRequiredHash(
        record.keyHash,
        "policySnapshot.safeExamBrowser.browserExamKeys[].keyHash must be a 64-character hex hash",
      ),
      platform: readSafeExamBrowserPlatform(record.platform),
      sebVersion: readOptionalString(record.sebVersion),
      label: readOptionalString(record.label),
    };
  });
}

function readSafeExamBrowserPlatform(value: unknown): SafeExamBrowserPlatform | null {
  const platform = readOptionalString(value);
  if (platform === null) {
    return null;
  }

  if (!SAFE_EXAM_BROWSER_PLATFORMS.has(platform as SafeExamBrowserPlatform)) {
    throw new LaunchRequestError(
      400,
      "policySnapshot.safeExamBrowser.browserExamKeys[].platform must be windows, macos, ios, or unknown",
    );
  }

  return platform as SafeExamBrowserPlatform;
}

function readGeneratedSafeExamBrowserConfig(
  value: unknown,
): SafeExamBrowserPolicySnapshot["generatedConfig"] {
  if (value === undefined || value === null) {
    return null;
  }

  const generatedConfig = readRecord(
    value,
    "policySnapshot.safeExamBrowser.generatedConfig must be an object",
  );
  const enabled = readOptionalBoolean(
    generatedConfig.enabled,
    "policySnapshot.safeExamBrowser.generatedConfig.enabled must be a boolean",
  );
  const allowQuit = readOptionalNullableBoolean(
    generatedConfig.allowQuit,
    "policySnapshot.safeExamBrowser.generatedConfig.allowQuit must be a boolean",
  );

  if (!enabled) {
    return null;
  }

  return {
    enabled: true,
    allowQuit,
  };
}

function readOptionalHash(value: unknown, message: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new LaunchRequestError(400, message);
  }

  const normalized = normalizeHash(value);
  if (!normalized) {
    throw new LaunchRequestError(400, message);
  }

  return normalized;
}

function readRequiredHash(value: unknown, message: string): string {
  const normalized = readOptionalHash(value, message);
  if (!normalized) {
    throw new LaunchRequestError(400, message);
  }

  return normalized;
}

function readOptionalBoolean(value: unknown, message: string): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new LaunchRequestError(400, message);
  }

  return value;
}

function readOptionalNullableBoolean(value: unknown, message: string): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "boolean") {
    throw new LaunchRequestError(400, message);
  }

  return value;
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(400, message);
  }

  return value as Record<string, unknown>;
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new LaunchRequestError(400, "Optional string value must be a string");
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
