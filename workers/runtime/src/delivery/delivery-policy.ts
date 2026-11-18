import type { DeliveryPolicySnapshot } from "@harbor/attempt-protocol";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import { readSafeExamBrowserPolicy } from "../routes/safe-exam-browser-policy";

const INVALID_SNAPSHOT = "Stored delivery policy snapshot is invalid";

export function parseStoredDeliveryPolicy(value: string): DeliveryPolicySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LaunchRequestError(500, INVALID_SNAPSHOT);
  }

  const record = readRecord(parsed, INVALID_SNAPSHOT);
  const deliveryPolicy: DeliveryPolicySnapshot = {
    launchMode: readLaunchMode(record.launchMode),
    navigationMode: readNavigationMode(record.navigationMode),
    maxAttempts: readPositiveInteger(record.maxAttempts, "deliveryPolicy.maxAttempts"),
    timeLimitSeconds: readNullableNonNegativeNumber(
      record.timeLimitSeconds,
      "deliveryPolicy.timeLimitSeconds",
    ),
  };

  const submissionMode = readOptionalPayloadString(record, "submissionMode");
  if (submissionMode !== undefined) {
    if (submissionMode !== "individual" && submissionMode !== "simultaneous") {
      throw new LaunchRequestError(500, "deliveryPolicy.submissionMode is invalid");
    }
    deliveryPolicy.submissionMode = submissionMode;
  }
  const gracePeriodSeconds = readNullableOptionalNumber(
    record.gracePeriodSeconds,
    "deliveryPolicy.gracePeriodSeconds",
  );
  if (gracePeriodSeconds !== undefined) {
    deliveryPolicy.gracePeriodSeconds = gracePeriodSeconds;
  }
  const standaloneAllowed = readOptionalBoolean(
    record.standaloneAllowed,
    "deliveryPolicy.standaloneAllowed",
  );
  if (standaloneAllowed !== undefined) {
    deliveryPolicy.standaloneAllowed = standaloneAllowed;
  }
  const iframeAllowed = readOptionalBoolean(record.iframeAllowed, "deliveryPolicy.iframeAllowed");
  if (iframeAllowed !== undefined) {
    deliveryPolicy.iframeAllowed = iframeAllowed;
  }
  if (record.allowedEmbedOrigins !== undefined) {
    deliveryPolicy.allowedEmbedOrigins = readStringArray(
      record.allowedEmbedOrigins,
      "deliveryPolicy.allowedEmbedOrigins",
    );
  }
  const secureBrowserRequired = readOptionalBoolean(
    record.secureBrowserRequired,
    "deliveryPolicy.secureBrowserRequired",
  );
  if (secureBrowserRequired !== undefined) {
    deliveryPolicy.secureBrowserRequired = secureBrowserRequired;
  }
  const secureBrowserProviderHint = readNullableOptionalString(
    record.secureBrowserProviderHint,
    "deliveryPolicy.secureBrowserProviderHint",
  );
  if (secureBrowserProviderHint !== undefined) {
    deliveryPolicy.secureBrowserProviderHint = secureBrowserProviderHint;
  }
  if (record.safeExamBrowser !== undefined) {
    deliveryPolicy.safeExamBrowser =
      record.safeExamBrowser === null
        ? null
        : readSafeExamBrowserPolicy(record.safeExamBrowser, {
            allowUnsafeUserAgentFallback: true,
          });
  }
  if (record.qtiTiming !== undefined) {
    deliveryPolicy.qtiTiming = record.qtiTiming === null ? null : readQtiTiming(record.qtiTiming);
  }

  return deliveryPolicy;
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(502, message);
  }

  return value as Record<string, unknown>;
}

function readRequiredPayloadString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new LaunchRequestError(502, `${key} must be a non-empty string`);
  }

  return value.trim();
}

function readOptionalPayloadString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new LaunchRequestError(502, `${key} must be a string`);
  }

  return value.trim() ? value.trim() : undefined;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new LaunchRequestError(502, `${label} must be a string or null`);
  }

  return value;
}

function readNullableOptionalString(value: unknown, label: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readNullableString(value, label);
}

function readNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LaunchRequestError(502, `${label} must be a finite number`);
  }

  return value;
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LaunchRequestError(500, `${label} must be a positive integer`);
  }

  return value;
}

function readNullableNumber(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }

  return readNumber(value, label);
}

function readNullableNonNegativeNumber(value: unknown, label: string): number | null {
  const number = readNullableNumber(value, label);
  if (number !== null && number < 0) {
    throw new LaunchRequestError(500, `${label} must be non-negative`);
  }

  return number;
}

function readNullableOptionalNumber(value: unknown, label: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readNullableNumber(value, label);
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new LaunchRequestError(502, `${label} must be a boolean`);
  }

  return value;
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readBoolean(value, label);
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new LaunchRequestError(500, `${label} must be an array of strings`);
  }

  return value;
}

function readLaunchMode(value: unknown): DeliveryPolicySnapshot["launchMode"] {
  if (
    value !== "preview" &&
    value !== "access-code" &&
    value !== "institutional-sso" &&
    value !== "lti"
  ) {
    throw new LaunchRequestError(500, "deliveryPolicy.launchMode is invalid");
  }

  return value;
}

function readNavigationMode(value: unknown): DeliveryPolicySnapshot["navigationMode"] {
  if (value !== "linear" && value !== "free") {
    throw new LaunchRequestError(500, "deliveryPolicy.navigationMode is invalid");
  }

  return value;
}

function readQtiTiming(value: unknown): NonNullable<DeliveryPolicySnapshot["qtiTiming"]> {
  const record = readRecord(value, "deliveryPolicy.qtiTiming must be a JSON object");
  return {
    assessmentTest:
      record.assessmentTest === null ? null : readQtiAssessmentTest(record.assessmentTest),
    testParts: readQtiArray(record.testParts, readQtiTestPart, "qtiTiming.testParts"),
    sections: readQtiArray(record.sections, readQtiSection, "qtiTiming.sections"),
    itemRefs: readQtiArray(record.itemRefs, readQtiItemRef, "qtiTiming.itemRefs"),
  };
}

function readQtiAssessmentTest(
  value: unknown,
): NonNullable<DeliveryPolicySnapshot["qtiTiming"]>["assessmentTest"] {
  const record = readRecord(value, "qtiTiming.assessmentTest must be a JSON object");
  return {
    identifier: readRequiredPayloadString(record, "identifier"),
    title: readNullableString(record.title, "qtiTiming.assessmentTest.title"),
    timeLimits: readQtiTimeLimits(record.timeLimits, "qtiTiming.assessmentTest.timeLimits"),
  };
}

function readQtiTestPart(
  value: unknown,
): NonNullable<DeliveryPolicySnapshot["qtiTiming"]>["testParts"][number] {
  const record = readRecord(value, "qtiTiming.testParts entries must be JSON objects");
  return {
    identifier: readRequiredPayloadString(record, "identifier"),
    navigationMode: readQtiNavigationMode(record.navigationMode),
    submissionMode: readQtiSubmissionMode(record.submissionMode),
    timeLimits: readQtiTimeLimits(record.timeLimits, "qtiTiming.testParts.timeLimits"),
    sectionIds: readStringArray(record.sectionIds, "qtiTiming.testParts.sectionIds"),
  };
}

function readQtiSection(
  value: unknown,
): NonNullable<DeliveryPolicySnapshot["qtiTiming"]>["sections"][number] {
  const record = readRecord(value, "qtiTiming.sections entries must be JSON objects");
  return {
    identifier: readRequiredPayloadString(record, "identifier"),
    title: readNullableString(record.title, "qtiTiming.sections.title"),
    visible: readNullableBoolean(record.visible, "qtiTiming.sections.visible"),
    testPartId: readRequiredPayloadString(record, "testPartId"),
    timeLimits: readQtiTimeLimits(record.timeLimits, "qtiTiming.sections.timeLimits"),
    itemRefIds: readStringArray(record.itemRefIds, "qtiTiming.sections.itemRefIds"),
  };
}

function readQtiItemRef(
  value: unknown,
): NonNullable<DeliveryPolicySnapshot["qtiTiming"]>["itemRefs"][number] {
  const record = readRecord(value, "qtiTiming.itemRefs entries must be JSON objects");
  return {
    identifier: readRequiredPayloadString(record, "identifier"),
    href: readRequiredPayloadString(record, "href"),
    itemId: readNullableString(record.itemId, "qtiTiming.itemRefs.itemId"),
    testPartId: readRequiredPayloadString(record, "testPartId"),
    sectionId: readRequiredPayloadString(record, "sectionId"),
    timeLimits: readQtiTimeLimits(record.timeLimits, "qtiTiming.itemRefs.timeLimits"),
    itemSessionControl: readQtiItemSessionControl(record.itemSessionControl),
  };
}

function readQtiArray<TOutput>(
  value: unknown,
  readEntry: (entry: unknown) => TOutput,
  label: string,
): TOutput[] {
  if (!Array.isArray(value)) {
    throw new LaunchRequestError(500, `${label} must be an array`);
  }

  return value.map(readEntry);
}

function readQtiTimeLimits(
  value: unknown,
  label: string,
): NonNullable<DeliveryPolicySnapshot["qtiTiming"]>["testParts"][number]["timeLimits"] {
  if (value === null) {
    return null;
  }

  const record = readRecord(value, `${label} must be a JSON object or null`);
  return {
    scopeType: readQtiTimingScopeType(record.scopeType),
    identifier: readRequiredPayloadString(record, "identifier"),
    minTimeSeconds: readNullableNumber(record.minTimeSeconds, `${label}.minTimeSeconds`),
    maxTimeSeconds: readNullableNumber(record.maxTimeSeconds, `${label}.maxTimeSeconds`),
    allowLateSubmission: readBoolean(record.allowLateSubmission, `${label}.allowLateSubmission`),
    rawAttributes: readStringNullRecord(record.rawAttributes, `${label}.rawAttributes`),
  };
}

function readQtiItemSessionControl(
  value: unknown,
): NonNullable<DeliveryPolicySnapshot["qtiTiming"]>["itemRefs"][number]["itemSessionControl"] {
  if (value === null) {
    return null;
  }

  const record = readRecord(
    value,
    "qtiTiming.itemRefs.itemSessionControl must be an object or null",
  );
  return {
    maxAttempts: readNullableNumber(record.maxAttempts, "itemSessionControl.maxAttempts"),
    showFeedback: readNullableBoolean(record.showFeedback, "itemSessionControl.showFeedback"),
    allowReview: readNullableBoolean(record.allowReview, "itemSessionControl.allowReview"),
    showSolution: readNullableBoolean(record.showSolution, "itemSessionControl.showSolution"),
    allowComment: readNullableBoolean(record.allowComment, "itemSessionControl.allowComment"),
    allowSkipping: readNullableBoolean(record.allowSkipping, "itemSessionControl.allowSkipping"),
    validateResponses: readNullableBoolean(
      record.validateResponses,
      "itemSessionControl.validateResponses",
    ),
    rawAttributes: readStringNullRecord(record.rawAttributes, "itemSessionControl.rawAttributes"),
  };
}

function readQtiNavigationMode(
  value: unknown,
): NonNullable<DeliveryPolicySnapshot["qtiTiming"]>["testParts"][number]["navigationMode"] {
  if (value !== "linear" && value !== "nonlinear") {
    throw new LaunchRequestError(500, "QTI navigation mode is invalid");
  }

  return value;
}

function readQtiSubmissionMode(
  value: unknown,
): NonNullable<DeliveryPolicySnapshot["submissionMode"]> {
  if (value !== "individual" && value !== "simultaneous") {
    throw new LaunchRequestError(500, "QTI submission mode is invalid");
  }

  return value;
}

function readQtiTimingScopeType(
  value: unknown,
): NonNullable<
  NonNullable<DeliveryPolicySnapshot["qtiTiming"]>["testParts"][number]["timeLimits"]
>["scopeType"] {
  if (
    value !== "assessment-test" &&
    value !== "test-part" &&
    value !== "assessment-section" &&
    value !== "assessment-item-ref" &&
    value !== "item-session"
  ) {
    throw new LaunchRequestError(500, "QTI timing scope type is invalid");
  }

  return value;
}

export function deliveryPoliciesEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonValue(left) === canonicalJsonValue(right);
}

/** Bind a launch to the complete server policy without disclosing verification keys. */
export async function fingerprintDeliveryPolicy(policy: DeliveryPolicySnapshot): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJsonValue(policy)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJsonValue(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function readNullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null) {
    return null;
  }

  return readBoolean(value, label);
}

function readStringNullRecord(value: unknown, label: string): Record<string, string | null> {
  const record = readRecord(value, `${label} must be a JSON object`);
  const output: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (entry !== null && typeof entry !== "string") {
      throw new LaunchRequestError(500, `${label} values must be strings or null`);
    }
    output[key] = entry;
  }

  return output;
}
