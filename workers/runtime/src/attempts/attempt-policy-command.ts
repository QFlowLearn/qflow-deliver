import { parseStaffActorRole } from "@harbor/attempt-protocol";
import type {
  AttemptOperatorMessageLevel,
  AttemptPolicyActorRole,
  AttemptPolicyCommand,
  AttemptPolicyState,
} from "@harbor/attempt-protocol";
import { isHarborQti3ColorTheme, readHarborAfaPnpSupport } from "@harbor/attempt-protocol";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";
import {
  readJsonObject,
  readMinimumNumber,
  readNonNegativeInteger,
  readOptionalStringValue,
  readRecord,
  readRequiredString,
} from "./attempt-request-parsing";

export async function readAttemptPolicyCommand(request: Request): Promise<AttemptPolicyCommand> {
  const body = await readJsonObject(request);
  const type = readRequiredString(body.type, "Policy command type is required");
  const baseCommand = {
    commandId: readRequiredString(body.commandId, "commandId is required"),
    type,
    actor: readPolicyActor(body.actor),
    reason: readRequiredString(body.reason, "reason is required"),
    issuedAt: readRequiredString(body.issuedAt, "issuedAt is required"),
    effectiveAt: readRequiredString(body.effectiveAt, "effectiveAt is required"),
  };

  if (type === "transfer-workstation") {
    if (
      Object.keys(body).some(
        (key) =>
          ![
            "commandId",
            "type",
            "actor",
            "reason",
            "issuedAt",
            "effectiveAt",
            "clientSessionId",
          ].includes(key),
      )
    )
      throw new AttemptDurableObjectRequestError(400, "Unknown workstation transfer field");
    return {
      ...baseCommand,
      type,
      clientSessionId: readRequiredString(
        body.clientSessionId,
        "Replacement workstation code is required",
      ),
    };
  }

  if (type === "extend-time") {
    return {
      ...baseCommand,
      type,
      additionalTimeSeconds: readNonNegativeInteger(
        body.additionalTimeSeconds,
        "additionalTimeSeconds must be a non-negative integer",
      ),
    };
  }

  if (type === "reopen-attempt") {
    return {
      ...baseCommand,
      type,
      reopenUntil: readOptionalStringValue(body.reopenUntil),
    };
  }

  if (type === "post-operator-message") {
    const message = readRecord(body.message, "message payload must be a JSON object");
    return {
      ...baseCommand,
      type,
      message: {
        level: readOperatorMessageLevel(message.level),
        title: readRequiredString(message.title, "message.title is required"),
        body: readRequiredString(message.body, "message.body is required"),
        effectiveUntil: readOptionalStringValue(message.effectiveUntil),
      },
    };
  }

  if (type === "set-accommodations") {
    return {
      ...baseCommand,
      type,
      accommodations: readAttemptAccommodations(body.accommodations),
    };
  }

  throw new AttemptDurableObjectRequestError(400, "Policy command type is not supported");
}

function readPolicyActor(value: unknown): AttemptPolicyCommand["actor"] {
  const actor = readRecord(value, "actor must be a JSON object");
  return {
    role: readPolicyActorRole(actor.role),
    actorId: readRequiredString(actor.actorId, "actor.actorId is required"),
    displayName: readOptionalStringValue(actor.displayName),
  };
}

function readPolicyActorRole(value: unknown): AttemptPolicyActorRole {
  const staffRole = parseStaffActorRole(value);
  if (staffRole) return staffRole;
  if (value === "operator" || value === "instructor" || value === "system") {
    return value;
  }

  throw new AttemptDurableObjectRequestError(
    400,
    "actor.role must be operator, instructor, or system",
  );
}

function readOperatorMessageLevel(value: unknown): AttemptOperatorMessageLevel {
  if (value === "info" || value === "warning" || value === "critical") {
    return value;
  }

  throw new AttemptDurableObjectRequestError(
    400,
    "message.level must be info, warning, or critical",
  );
}

function readAttemptAccommodations(value: unknown): AttemptPolicyState["accommodations"] {
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
      ...(typeof rendererPnp.glossaryOnScreen === "boolean"
        ? { glossaryOnScreen: rendererPnp.glossaryOnScreen }
        : {}),
      ...(typeof rendererPnp.keywordTranslationLanguage === "string"
        ? {
            keywordTranslationLanguage: rendererPnp.keywordTranslationLanguage.trim(),
          }
        : {}),
      ...(typeof rendererPnp.extSbacGlossaryIllustration === "boolean"
        ? {
            extSbacGlossaryIllustration: rendererPnp.extSbacGlossaryIllustration,
          }
        : {}),
      ...(typeof rendererPnp.layoutSingleColumn === "boolean"
        ? { layoutSingleColumn: rendererPnp.layoutSingleColumn }
        : {}),
    },
    sessionControl: {
      ...(typeof sessionControl.allow_comment === "boolean"
        ? { allow_comment: sessionControl.allow_comment }
        : {}),
      ...(typeof sessionControl.allow_review === "boolean"
        ? { allow_review: sessionControl.allow_review }
        : {}),
      ...(typeof sessionControl.allow_skipping === "boolean"
        ? { allow_skipping: sessionControl.allow_skipping }
        : {}),
      ...(typeof sessionControl.max_attempts === "number"
        ? { max_attempts: sessionControl.max_attempts }
        : {}),
      ...(typeof sessionControl.show_feedback === "boolean"
        ? { show_feedback: sessionControl.show_feedback }
        : {}),
      ...(typeof sessionControl.show_solution === "boolean"
        ? { show_solution: sessionControl.show_solution }
        : {}),
      ...(typeof sessionControl.validate_responses === "boolean"
        ? { validate_responses: sessionControl.validate_responses }
        : {}),
      ...(sessionControl.time_limits
        ? {
            time_limits: readSessionControlTimeLimits(sessionControl.time_limits),
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

function readRendererPnpTextAppearance(
  value: unknown,
): AttemptPolicyState["accommodations"]["rendererPnp"]["textAppearance"] {
  const textAppearance = readRecord(value, "rendererPnp.textAppearance must be a JSON object");
  const colorStyle = textAppearance.colorStyle;
  if (colorStyle !== undefined && !isHarborQti3ColorTheme(colorStyle)) {
    throw new AttemptDurableObjectRequestError(
      400,
      "rendererPnp.textAppearance.colorStyle must be a supported qti3 color theme",
    );
  }

  return {
    ...(colorStyle !== undefined ? { colorStyle } : {}),
  };
}

function readSessionControlTimeLimits(
  value: unknown,
): NonNullable<AttemptPolicyState["accommodations"]["sessionControl"]["time_limits"]> {
  const timeLimits = readRecord(value, "sessionControl.time_limits must be a JSON object");
  return {
    ...(timeLimits.min_time !== undefined
      ? {
          min_time: readNullableNumber(
            timeLimits.min_time,
            "sessionControl.time_limits.min_time must be a number or null",
          ),
        }
      : {}),
    ...(timeLimits.max_time !== undefined
      ? {
          max_time: readNullableNumber(
            timeLimits.max_time,
            "sessionControl.time_limits.max_time must be a number or null",
          ),
        }
      : {}),
    ...(timeLimits.allow_late_submission !== undefined
      ? {
          allow_late_submission: readBoolean(
            timeLimits.allow_late_submission,
            "sessionControl.time_limits.allow_late_submission must be a boolean",
          ),
        }
      : {}),
  };
}

function readShellToolsAccommodation(
  shellTools: Record<string, unknown>,
): AttemptPolicyState["accommodations"]["shellTools"] {
  const calculator = shellTools.calculator;
  return {
    ...(typeof shellTools.textToSpeech === "boolean"
      ? { textToSpeech: shellTools.textToSpeech }
      : {}),
    ...(typeof shellTools.lineReader === "boolean" ? { lineReader: shellTools.lineReader } : {}),
    ...(typeof shellTools.answerMasking === "boolean"
      ? { answerMasking: shellTools.answerMasking }
      : {}),
    ...(calculator === "none" || calculator === "basic" || calculator === "scientific"
      ? { calculator }
      : {}),
    ...(typeof shellTools.notepad === "boolean" ? { notepad: shellTools.notepad } : {}),
    ...(typeof shellTools.captions === "boolean" ? { captions: shellTools.captions } : {}),
    ...(typeof shellTools.transcripts === "boolean" ? { transcripts: shellTools.transcripts } : {}),
  };
}

function readPnpEntitlement(
  value: Record<string, unknown>,
): NonNullable<AttemptPolicyState["accommodations"]["pnpEntitlement"]> {
  return {
    ...readPnpSupportSet(value.supports, "supports"),
    ...readPnpSupportSet(value.activateAtInitializationSet, "activateAtInitializationSet"),
    ...readPnpSupportSet(value.activateAsOptionSet, "activateAsOptionSet"),
    ...readPnpSupportSet(value.prohibitSet, "prohibitSet"),
    ...(value.languages !== undefined
      ? { languages: readStringArray(value.languages, "languages") }
      : {}),
  };
}

function readAdditionalTestingTime(
  value: Record<string, unknown>,
): NonNullable<AttemptPolicyState["accommodations"]["additionalTestingTime"]> {
  const mode = value.mode;
  if (
    mode !== "none" &&
    mode !== "time-multiplier" &&
    mode !== "fixed-minutes" &&
    mode !== "unlimited"
  ) {
    throw new AttemptDurableObjectRequestError(
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

function readTestingTimeAllocationPolicy(
  value: unknown,
): NonNullable<
  NonNullable<AttemptPolicyState["accommodations"]["additionalTestingTime"]>["allocationPolicy"]
> {
  if (value !== "whole-assessment" && value !== "even-split" && value !== "proportional-split") {
    throw new AttemptDurableObjectRequestError(
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
):
  | Pick<NonNullable<AttemptPolicyState["accommodations"]["pnpEntitlement"]>, TKey>
  | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    throw new AttemptDurableObjectRequestError(
      400,
      `accommodations.pnpEntitlement.${key} must be an array`,
    );
  }

  return {
    [key]: value.map((entry) => {
      const support = readHarborAfaPnpSupport(entry);
      if (!support) {
        throw new AttemptDurableObjectRequestError(
          400,
          `accommodations.pnpEntitlement.${key} contains an unsupported support`,
        );
      }
      return support;
    }),
  } as Pick<NonNullable<AttemptPolicyState["accommodations"]["pnpEntitlement"]>, TKey>;
}

function readStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new AttemptDurableObjectRequestError(
      400,
      `accommodations.pnpEntitlement.${key} must be an array`,
    );
  }

  return value.map((entry) =>
    readRequiredString(entry, `accommodations.pnpEntitlement.${key} entries must be strings`),
  );
}

function readNullableNumber(value: unknown, message: string): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new AttemptDurableObjectRequestError(400, message);
}

function readBoolean(value: unknown, message: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  throw new AttemptDurableObjectRequestError(400, message);
}
