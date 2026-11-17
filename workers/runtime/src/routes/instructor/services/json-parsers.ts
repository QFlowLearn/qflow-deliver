import {
  createDefaultAccommodationTimingEvidence,
  createEmptyAttemptPolicyState,
  isHarborQti3ColorTheme,
  readHarborAfaPnpSupport,
  type AssignmentActorSnapshot,
  type AssignmentLearnerPolicyOverrides,
  type AssignmentPolicySnapshot,
  type AssignmentStatus,
  type AssignmentTarget,
  type AttemptAccommodationState,
  type AttemptAccommodationTimingEvidence,
  type AttemptSyncHealthSignal,
  type HarborAccommodationProfileDefinition,
  type HarborAdditionalTestingTimeAccommodation,
  type HarborShellAccommodationState,
  type HarborTestingTimeAllocationPolicy,
  type LtiAssignmentLinkage,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../../launch/create-preview-attempt";
import {
  readBoolean,
  readOptionalPositiveInteger,
  readRequiredString,
} from "../../route-request-utils";
import { readAssignmentPolicySnapshot } from "../../assignment-request-parsers";
import { readSafeExamBrowserPolicy } from "../../safe-exam-browser-policy";

export async function requireLearnerRecord(
  db: D1Database,
  learnerId: string,
): Promise<{ id: string; tenant_id: string }> {
  const row = await db
    .prepare("SELECT id, tenant_id FROM harbor_learners WHERE id = ?")
    .bind(learnerId)
    .first<{ id: string; tenant_id: string }>();
  if (!row) {
    throw new LaunchRequestError(404, "Learner not found");
  }

  return row;
}

export function readAssignmentLearnerPolicyOverrides(
  value: unknown,
): AssignmentLearnerPolicyOverrides {
  const overrides = readRecord(value, "policyOverrides is required");
  return {
    additionalTimeSeconds:
      readOptionalNonNegativeInteger(overrides.additionalTimeSeconds) ?? undefined,
    maxAttempts: readOptionalPositiveInteger(overrides.maxAttempts),
    timeLimitSeconds: readOptionalNullableNonNegativeInteger(overrides.timeLimitSeconds),
    gracePeriodSeconds: readOptionalNullableNonNegativeInteger(overrides.gracePeriodSeconds),
    navigationMode: readOptionalNavigationMode(overrides.navigationMode),
    standaloneAllowed: readOptionalBoolean(overrides.standaloneAllowed),
    iframeAllowed: readOptionalBoolean(overrides.iframeAllowed),
    allowedEmbedOrigins:
      overrides.allowedEmbedOrigins === undefined
        ? undefined
        : readStringArray(overrides.allowedEmbedOrigins),
    secureBrowserRequired: readOptionalBoolean(overrides.secureBrowserRequired),
    secureBrowserProviderHint: readOptionalString(overrides.secureBrowserProviderHint),
    safeExamBrowser:
      overrides.safeExamBrowser === undefined
        ? undefined
        : readSafeExamBrowserPolicy(overrides.safeExamBrowser),
    proctoringProvider: readOptionalString(overrides.proctoringProvider),
  };
}

export function readAttemptAccommodations(value: unknown): AttemptAccommodationState {
  const accommodations = readRecord(value, "accommodations must be a JSON object");
  const rendererPnp = accommodations.rendererPnp
    ? readRecord(accommodations.rendererPnp, "accommodations.rendererPnp must be a JSON object")
    : {};
  const sessionControl = accommodations.sessionControl
    ? readRecord(
        accommodations.sessionControl,
        "accommodations.sessionControl must be a JSON object",
      )
    : {};
  const shellTools = accommodations.shellTools
    ? readRecord(accommodations.shellTools, "accommodations.shellTools must be a JSON object")
    : {};
  const pnpEntitlement = accommodations.pnpEntitlement
    ? readRecord(
        accommodations.pnpEntitlement,
        "accommodations.pnpEntitlement must be a JSON object",
      )
    : null;
  const additionalTestingTime = accommodations.additionalTestingTime
    ? readRecord(
        accommodations.additionalTestingTime,
        "accommodations.additionalTestingTime must be a JSON object",
      )
    : null;

  return {
    rendererPnp: {
      ...(rendererPnp.textAppearance
        ? {
            textAppearance: readRendererPnpTextAppearance(rendererPnp.textAppearance),
          }
        : {}),
      ...(rendererPnp.glossaryOnScreen !== undefined
        ? {
            glossaryOnScreen: readBoolean(
              rendererPnp.glossaryOnScreen,
              "accommodations.rendererPnp.glossaryOnScreen must be a boolean",
            ),
          }
        : {}),
      ...(rendererPnp.keywordTranslationLanguage !== undefined
        ? {
            keywordTranslationLanguage: readRequiredString(
              rendererPnp.keywordTranslationLanguage,
              "accommodations.rendererPnp.keywordTranslationLanguage must be a string",
            ),
          }
        : {}),
      ...(rendererPnp.extSbacGlossaryIllustration !== undefined
        ? {
            extSbacGlossaryIllustration: readBoolean(
              rendererPnp.extSbacGlossaryIllustration,
              "accommodations.rendererPnp.extSbacGlossaryIllustration must be a boolean",
            ),
          }
        : {}),
      ...(rendererPnp.layoutSingleColumn !== undefined
        ? {
            layoutSingleColumn: readBoolean(
              rendererPnp.layoutSingleColumn,
              "accommodations.rendererPnp.layoutSingleColumn must be a boolean",
            ),
          }
        : {}),
    },
    sessionControl: {
      ...(sessionControl.allow_comment !== undefined
        ? {
            allow_comment: readBoolean(
              sessionControl.allow_comment,
              "accommodations.sessionControl.allow_comment must be a boolean",
            ),
          }
        : {}),
      ...(sessionControl.allow_review !== undefined
        ? {
            allow_review: readBoolean(
              sessionControl.allow_review,
              "accommodations.sessionControl.allow_review must be a boolean",
            ),
          }
        : {}),
      ...(sessionControl.allow_skipping !== undefined
        ? {
            allow_skipping: readBoolean(
              sessionControl.allow_skipping,
              "accommodations.sessionControl.allow_skipping must be a boolean",
            ),
          }
        : {}),
      ...(sessionControl.max_attempts !== undefined
        ? {
            max_attempts: readPositiveInteger(
              sessionControl.max_attempts,
              "accommodations.sessionControl.max_attempts must be a positive integer",
            ),
          }
        : {}),
      ...(sessionControl.show_feedback !== undefined
        ? {
            show_feedback: readBoolean(
              sessionControl.show_feedback,
              "accommodations.sessionControl.show_feedback must be a boolean",
            ),
          }
        : {}),
      ...(sessionControl.show_solution !== undefined
        ? {
            show_solution: readBoolean(
              sessionControl.show_solution,
              "accommodations.sessionControl.show_solution must be a boolean",
            ),
          }
        : {}),
      ...(sessionControl.validate_responses !== undefined
        ? {
            validate_responses: readBoolean(
              sessionControl.validate_responses,
              "accommodations.sessionControl.validate_responses must be a boolean",
            ),
          }
        : {}),
      ...(sessionControl.time_limits
        ? {
            time_limits: readRecord(
              sessionControl.time_limits,
              "accommodations.sessionControl.time_limits must be a JSON object",
            ) as AttemptAccommodationState["sessionControl"]["time_limits"],
          }
        : {}),
    },
    shellTools: readShellToolsAccommodation(shellTools),
    ...(pnpEntitlement ? { pnpEntitlement: readPnpEntitlement(pnpEntitlement) } : {}),
    ...(additionalTestingTime
      ? {
          additionalTestingTime: readAdditionalTestingTime(additionalTestingTime),
        }
      : {}),
  };
}

export function readAccommodationProfileDefinition(
  value: unknown,
): HarborAccommodationProfileDefinition {
  const profile = readRecord(value, "profile must be a JSON object");
  return {
    ...(profile.rendererPnp !== undefined
      ? {
          rendererPnp: readAttemptAccommodations({
            rendererPnp: profile.rendererPnp,
          }).rendererPnp,
        }
      : {}),
    ...(profile.sessionControl !== undefined
      ? {
          sessionControl: readAttemptAccommodations({
            sessionControl: profile.sessionControl,
          }).sessionControl,
        }
      : {}),
    ...(profile.shellTools !== undefined
      ? {
          shellTools: readShellToolsAccommodation(
            readRecord(profile.shellTools, "profile.shellTools must be a JSON object"),
          ),
        }
      : {}),
    ...(profile.pnpEntitlement !== undefined
      ? {
          pnpEntitlement: readPnpEntitlement(
            readRecord(profile.pnpEntitlement, "profile.pnpEntitlement must be a JSON object"),
          ),
        }
      : {}),
    ...(profile.additionalTestingTime !== undefined
      ? {
          additionalTestingTime: readAdditionalTestingTime(
            readRecord(
              profile.additionalTestingTime,
              "profile.additionalTestingTime must be a JSON object",
            ),
          ),
        }
      : {}),
  };
}

function readRendererPnpTextAppearance(
  value: unknown,
): AttemptAccommodationState["rendererPnp"]["textAppearance"] {
  const textAppearance = readRecord(
    value,
    "accommodations.rendererPnp.textAppearance must be a JSON object",
  );
  const colorStyle = textAppearance.colorStyle;
  return {
    ...(colorStyle !== undefined
      ? {
          colorStyle: readHarborQti3ColorTheme(
            colorStyle,
            "accommodations.rendererPnp.textAppearance.colorStyle must be one of QFlowLearn Delivery's supported qti3 color themes",
          ),
        }
      : {}),
  };
}

function readShellToolsAccommodation(
  value: Record<string, unknown>,
): HarborShellAccommodationState {
  const calculator = value.calculator;
  if (
    calculator !== undefined &&
    calculator !== "none" &&
    calculator !== "basic" &&
    calculator !== "scientific"
  ) {
    throw new LaunchRequestError(
      400,
      "accommodations.shellTools.calculator must be none, basic, or scientific",
    );
  }

  return {
    ...(value.textToSpeech !== undefined
      ? {
          textToSpeech: readBoolean(
            value.textToSpeech,
            "accommodations.shellTools.textToSpeech must be a boolean",
          ),
        }
      : {}),
    ...(value.lineReader !== undefined
      ? {
          lineReader: readBoolean(
            value.lineReader,
            "accommodations.shellTools.lineReader must be a boolean",
          ),
        }
      : {}),
    ...(value.answerMasking !== undefined
      ? {
          answerMasking: readBoolean(
            value.answerMasking,
            "accommodations.shellTools.answerMasking must be a boolean",
          ),
        }
      : {}),
    ...(calculator !== undefined ? { calculator } : {}),
    ...(value.notepad !== undefined
      ? {
          notepad: readBoolean(
            value.notepad,
            "accommodations.shellTools.notepad must be a boolean",
          ),
        }
      : {}),
    ...(value.captions !== undefined
      ? {
          captions: readBoolean(
            value.captions,
            "accommodations.shellTools.captions must be a boolean",
          ),
        }
      : {}),
    ...(value.transcripts !== undefined
      ? {
          transcripts: readBoolean(
            value.transcripts,
            "accommodations.shellTools.transcripts must be a boolean",
          ),
        }
      : {}),
  };
}

function readPnpEntitlement(
  value: Record<string, unknown>,
): NonNullable<AttemptAccommodationState["pnpEntitlement"]> {
  return {
    ...readPnpSupportSet(value.supports, "supports"),
    ...readPnpSupportSet(value.activateAtInitializationSet, "activateAtInitializationSet"),
    ...readPnpSupportSet(value.activateAsOptionSet, "activateAsOptionSet"),
    ...readPnpSupportSet(value.prohibitSet, "prohibitSet"),
    ...(value.languages !== undefined ? { languages: readStringArray(value.languages) } : {}),
  };
}

function readAdditionalTestingTime(
  value: Record<string, unknown>,
): HarborAdditionalTestingTimeAccommodation {
  const mode = value.mode;
  if (
    mode !== "none" &&
    mode !== "time-multiplier" &&
    mode !== "fixed-minutes" &&
    mode !== "unlimited"
  ) {
    throw new LaunchRequestError(
      400,
      "accommodations.additionalTestingTime.mode must be none, time-multiplier, fixed-minutes, or unlimited",
    );
  }

  return {
    mode,
    ...(mode === "time-multiplier"
      ? {
          multiplier: readMinimumNumber(
            value.multiplier,
            1,
            "accommodations.additionalTestingTime.multiplier must be a number greater than or equal to 1",
          ),
        }
      : {}),
    ...(mode === "fixed-minutes"
      ? {
          fixedMinutes: readMinimumNumber(
            value.fixedMinutes,
            0,
            "accommodations.additionalTestingTime.fixedMinutes must be a non-negative number",
          ),
        }
      : {}),
    ...(value.allocationPolicy !== undefined
      ? {
          allocationPolicy: readTestingTimeAllocationPolicy(value.allocationPolicy),
        }
      : {}),
  };
}

function readTestingTimeAllocationPolicy(value: unknown): HarborTestingTimeAllocationPolicy {
  if (value !== "whole-assessment" && value !== "even-split" && value !== "proportional-split") {
    throw new LaunchRequestError(
      400,
      "accommodations.additionalTestingTime.allocationPolicy must be whole-assessment, even-split, or proportional-split",
    );
  }

  return value;
}

function readPnpSupportSet<
  TKey extends "supports" | "activateAtInitializationSet" | "activateAsOptionSet" | "prohibitSet",
>(
  value: unknown,
  key: TKey,
): Pick<NonNullable<AttemptAccommodationState["pnpEntitlement"]>, TKey> | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    throw new LaunchRequestError(400, `accommodations.pnpEntitlement.${key} must be an array`);
  }

  return {
    [key]: value.map((entry) => {
      const support = readHarborAfaPnpSupport(entry);
      if (!support) {
        throw new LaunchRequestError(
          400,
          `accommodations.pnpEntitlement.${key} contains an unsupported support`,
        );
      }
      return support;
    }),
  } as Pick<NonNullable<AttemptAccommodationState["pnpEntitlement"]>, TKey>;
}

export function parsePolicyOverrides(value: string): AssignmentLearnerPolicyOverrides {
  try {
    return readAssignmentLearnerPolicyOverrides(JSON.parse(value));
  } catch {
    throw new LaunchRequestError(500, "Assignment learner override contains invalid policy JSON");
  }
}

export function parseAccommodations(value: string): AttemptAccommodationState {
  try {
    return readAttemptAccommodations(JSON.parse(value));
  } catch {
    throw new LaunchRequestError(
      500,
      "Assignment learner override contains invalid accommodations JSON",
    );
  }
}

export function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readSyncSignals(flagsJson: string): AttemptSyncHealthSignal[] {
  const flags = parseJsonRecord(flagsJson);
  if (!Array.isArray(flags.syncSignals)) {
    return [];
  }

  return flags.syncSignals.filter(
    (signal): signal is AttemptSyncHealthSignal =>
      signal === "queued_locally" ||
      signal === "replayed" ||
      signal === "stale_tab_reconciled" ||
      signal === "receipt_confirmed" ||
      signal === "sync_failed",
  );
}

export function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function parseSectionStaff(value: string): Array<{
  sourcedId: string;
  displayName: string;
  email: string | null;
  role: string;
}> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record.sourcedId !== "string" ||
        typeof record.displayName !== "string" ||
        typeof record.role !== "string"
      ) {
        return [];
      }

      return [
        {
          sourcedId: record.sourcedId,
          displayName: record.displayName,
          email: typeof record.email === "string" ? record.email : null,
          role: record.role,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function parseAccommodationTiming(value: string): AttemptAccommodationTimingEvidence {
  const fallback = createDefaultAccommodationTimingEvidence();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }
    const record = parsed as Record<string, unknown>;
    return {
      additionalTimeSeconds:
        typeof record.additionalTimeSeconds === "number" &&
        Number.isFinite(record.additionalTimeSeconds)
          ? Math.max(0, Math.round(record.additionalTimeSeconds))
          : fallback.additionalTimeSeconds,
      effectiveTimeLimitSeconds:
        typeof record.effectiveTimeLimitSeconds === "number" &&
        Number.isFinite(record.effectiveTimeLimitSeconds)
          ? Math.max(0, Math.round(record.effectiveTimeLimitSeconds))
          : null,
      unlimited: typeof record.unlimited === "boolean" ? record.unlimited : fallback.unlimited,
      additionalTestingTime:
        record.additionalTestingTime &&
        typeof record.additionalTestingTime === "object" &&
        !Array.isArray(record.additionalTestingTime)
          ? (record.additionalTestingTime as HarborAdditionalTestingTimeAccommodation)
          : fallback.additionalTestingTime,
      allocationPolicy:
        record.allocationPolicy === "whole-assessment" ||
        record.allocationPolicy === "even-split" ||
        record.allocationPolicy === "proportional-split"
          ? record.allocationPolicy
          : fallback.allocationPolicy,
    };
  } catch {
    return fallback;
  }
}

export function parseAccommodationProfileDefinition(
  value: string,
): HarborAccommodationProfileDefinition {
  try {
    const parsed = JSON.parse(value) as HarborAccommodationProfileDefinition;
    return {
      rendererPnp: parsed.rendererPnp ?? {},
      sessionControl: parsed.sessionControl ?? {},
      shellTools: parsed.shellTools ?? {},
      pnpEntitlement: parsed.pnpEntitlement ?? {},
    };
  } catch {
    return {};
  }
}

export function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(400, message);
  }

  return value as Record<string, unknown>;
}

export function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new LaunchRequestError(400, "Optional string value must be a string");
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new LaunchRequestError(400, "Optional boolean value must be a boolean");
  }

  return value;
}

export function readOptionalAssignmentStatus(value: unknown): AssignmentStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value !== "draft" && value !== "active" && value !== "closed") {
    throw new LaunchRequestError(400, "status must be draft, active, or closed");
  }

  return value;
}

export function readOptionalProfileStatus(
  value: unknown,
): "draft" | "active" | "inactive" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "draft" && value !== "active" && value !== "inactive") {
    throw new LaunchRequestError(400, "status must be draft, active, or inactive");
  }

  return value;
}

export function readOptionalLearnerAccommodationStatus(
  value: unknown,
): "active" | "inactive" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "active" && value !== "inactive") {
    throw new LaunchRequestError(400, "status must be active or inactive");
  }

  return value;
}

export function readHarborQti3ColorTheme(value: unknown, message: string) {
  if (typeof value !== "string" || !isHarborQti3ColorTheme(value)) {
    throw new LaunchRequestError(400, message);
  }

  return value;
}

export function readPositiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LaunchRequestError(400, message);
  }

  return value;
}

export function readMinimumNumber(value: unknown, minimum: number, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new LaunchRequestError(400, message);
  }

  return value;
}

export function readOptionalNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LaunchRequestError(400, "Optional numeric value must be a non-negative integer");
  }

  return value;
}

export function readOptionalNullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  return readOptionalNonNegativeInteger(value);
}

export function readOptionalNavigationMode(value: unknown): "linear" | "free" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "linear" && value !== "free") {
    throw new LaunchRequestError(400, "navigationMode must be linear or free");
  }

  return value;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new LaunchRequestError(400, "Value must be an array of strings");
  }

  return value.map((entry) => readRequiredString(entry, "Array entries must be non-empty strings"));
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
