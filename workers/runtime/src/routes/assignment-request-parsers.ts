import type {
  AssignmentPolicySnapshot,
  AssignmentStatus,
  AssignmentTarget,
  CreateAssignmentRequest,
  LtiAssignmentLinkage,
  UpdateAssignmentRequest,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../launch/create-preview-attempt";
import {
  readAssignmentActor,
  readBoolean,
  readJsonObject,
  readOptionalString,
  readRequiredString,
} from "./route-request-utils";
import { readSafeExamBrowserPolicy } from "./safe-exam-browser-policy";

export async function readCreateAssignmentRequest(
  request: Request,
  options: {
    allowUnsafeUserAgentFallback?: boolean;
  } = {},
): Promise<CreateAssignmentRequest> {
  const body = await readJsonObject(request);
  return {
    assignmentId: readRequiredString(body.assignmentId, "assignmentId is required"),
    assessmentId: readRequiredString(body.assessmentId, "assessmentId is required"),
    assessmentVersionId: readRequiredString(
      body.assessmentVersionId,
      "assessmentVersionId is required",
    ),
    title: readRequiredString(body.title, "title is required"),
    status: readOptionalAssignmentStatus(body.status),
    actor: readAssignmentActor(body.actor),
    policySnapshot: readAssignmentPolicySnapshot(body.policySnapshot, options),
    targets: readAssignmentTargetsInput(body.targets),
    ltiLinkages: readLtiLinkages(body.ltiLinkages),
  };
}

export async function readUpdateAssignmentRequest(
  request: Request,
  options: {
    allowUnsafeUserAgentFallback?: boolean;
  } = {},
): Promise<UpdateAssignmentRequest> {
  const body = await readJsonObject(request);
  return {
    title: readRequiredString(body.title, "title is required"),
    status: readOptionalAssignmentStatus(body.status),
    actor: readAssignmentActor(body.actor),
    policySnapshot: readAssignmentPolicySnapshot(body.policySnapshot, options),
    targets: readAssignmentTargetsInput(body.targets),
    ltiLinkages: readLtiLinkages(body.ltiLinkages),
  };
}

export function readAssignmentPolicySnapshot(
  value: unknown,
  options: {
    allowUnsafeUserAgentFallback?: boolean;
  } = {},
): AssignmentPolicySnapshot {
  const policy = readRecord(value, "policySnapshot is required");

  return {
    availableFrom: readOptionalString(policy.availableFrom),
    availableUntil: readOptionalString(policy.availableUntil),
    reportingTimezone: readRequiredString(
      policy.reportingTimezone,
      "policySnapshot.reportingTimezone is required",
    ),
    maxAttempts: readPositiveInteger(
      policy.maxAttempts,
      "policySnapshot.maxAttempts must be a positive integer",
    ),
    timeLimitSeconds: readOptionalNonNegativeInteger(policy.timeLimitSeconds),
    gracePeriodSeconds: readOptionalNonNegativeInteger(policy.gracePeriodSeconds),
    navigationMode: readRequiredString(
      policy.navigationMode,
      "policySnapshot.navigationMode is required",
    ) as "linear" | "free",
    standaloneAllowed: readBoolean(
      policy.standaloneAllowed,
      "policySnapshot.standaloneAllowed is required",
    ),
    iframeAllowed: readBoolean(policy.iframeAllowed, "policySnapshot.iframeAllowed is required"),
    allowedEmbedOrigins: readStringArray(policy.allowedEmbedOrigins),
    secureBrowserRequired: readBoolean(
      policy.secureBrowserRequired,
      "policySnapshot.secureBrowserRequired is required",
    ),
    secureBrowserProviderHint: readOptionalString(policy.secureBrowserProviderHint),
    safeExamBrowser: readSafeExamBrowserPolicy(policy.safeExamBrowser, {
      allowUnsafeUserAgentFallback: options.allowUnsafeUserAgentFallback,
    }),
    proctoringProvider: readOptionalString(policy.proctoringProvider),
  };
}

export function readAssignmentTargetsInput(value: unknown): AssignmentTarget[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new LaunchRequestError(400, "targets must be an array");
  }

  return value.map((entry) => {
    const record = readRecord(entry, "targets must contain objects");
    const kind = readRequiredString(record.kind, "target kind is required") as
      | "learner"
      | "section";

    if (kind === "learner") {
      return {
        kind,
        learnerId: readRequiredString(record.learnerId, "targets[].learnerId is required"),
      };
    }

    return {
      kind,
      sectionId: readRequiredString(record.sectionId, "targets[].sectionId is required"),
    };
  });
}

export function readLtiLinkages(value: unknown): LtiAssignmentLinkage[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new LaunchRequestError(400, "ltiLinkages must be an array");
  }

  return value.map((entry) => {
    const record = readRecord(entry, "ltiLinkages must contain objects");
    return {
      registrationId: readRequiredString(
        record.registrationId,
        "ltiLinkages[].registrationId is required",
      ),
      resourceLinkId: readRequiredString(
        record.resourceLinkId,
        "ltiLinkages[].resourceLinkId is required",
      ),
      contextId: readOptionalString(record.contextId),
      sectionId: readOptionalString(record.sectionId),
    };
  });
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(400, message);
  }

  return value as Record<string, unknown>;
}

function readOptionalAssignmentStatus(value: unknown): AssignmentStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value !== "draft" && value !== "active" && value !== "closed") {
    throw new LaunchRequestError(400, "status must be draft, active, or closed");
  }

  return value;
}

function readPositiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LaunchRequestError(400, message);
  }

  return value;
}

function readOptionalNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LaunchRequestError(400, "Optional numeric value must be a non-negative integer");
  }

  return value;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new LaunchRequestError(400, "Value must be an array of strings");
  }

  return value.map((entry) => readRequiredString(entry, "Array entries must be non-empty strings"));
}

export function parseStoredAssignmentPolicySnapshot(value: string): AssignmentPolicySnapshot {
  try {
    const parsed = readAssignmentPolicySnapshot(JSON.parse(value));
    return {
      ...parsed,
      safeExamBrowser: parsed.safeExamBrowser ?? null,
    };
  } catch {
    throw new LaunchRequestError(500, "Assignment contains an invalid policy snapshot");
  }
}

export function parseStoredAssignmentPolicySnapshotOrNull(
  value: string | null,
): AssignmentPolicySnapshot | null {
  if (!value) {
    return null;
  }

  return parseStoredAssignmentPolicySnapshot(value);
}

export function parseStoredAssignmentPolicySnapshotRequired(
  value: string | null,
  message = "Assignment contains an invalid policy snapshot",
): AssignmentPolicySnapshot {
  if (!value) {
    throw new LaunchRequestError(500, message);
  }

  return parseStoredAssignmentPolicySnapshot(value);
}
