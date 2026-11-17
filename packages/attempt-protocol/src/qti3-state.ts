import {
  isQtiAttemptStateV1 as isValidQtiAttemptStateV1,
  type QtiAttemptStateV1,
  type QtiDiagnostic,
  type QtiValue,
} from "@longsightgroup/qti3-core";
import type { AttemptValidationMessageSnapshot, AttemptVariableSnapshot } from "./results";

export function isQtiAttemptStateV1(value: unknown): value is QtiAttemptStateV1 {
  return isValidQtiAttemptStateV1(value);
}

export function readQtiResponseSnapshots(state: unknown): AttemptVariableSnapshot[] {
  if (isQtiAttemptStateV1(state)) {
    return recordToSnapshots(state.responses);
  }

  return readLegacyVariableSnapshots(readRecordProperty(state, "responseVariables"));
}

export function readQtiOutcomeSnapshots(state: unknown): AttemptVariableSnapshot[] {
  if (isQtiAttemptStateV1(state)) {
    return recordToSnapshots(state.outcomes);
  }

  return readLegacyVariableSnapshots(readRecordProperty(state, "outcomeVariables"));
}

export function readQtiValidationSnapshots(state: unknown): AttemptValidationMessageSnapshot[] {
  if (isQtiAttemptStateV1(state)) {
    return state.validationMessages
      .map((message) => qtiDiagnosticToValidationSnapshot(message))
      .filter((entry): entry is AttemptValidationMessageSnapshot => entry !== null);
  }

  return readLegacyValidationSnapshots(readRecordProperty(state, "validationMessages"));
}

export function readQtiValidationMessageCount(state: unknown): number {
  return readQtiValidationSnapshots(state).length;
}

function recordToSnapshots(record: Record<string, QtiValue>): AttemptVariableSnapshot[] {
  return Object.entries(record)
    .filter(([identifier]) => identifier.trim().length > 0)
    .map(([identifier, value]) => ({
      identifier: identifier.trim(),
      value,
    }));
}

function qtiDiagnosticToValidationSnapshot(
  message: QtiDiagnostic,
): AttemptValidationMessageSnapshot | null {
  if (typeof message.message !== "string" || !message.message.trim()) {
    return null;
  }

  const identifier = message.path?.trim() || message.code?.trim() || null;
  return {
    identifier,
    message: message.message.trim(),
  };
}

function readRecordProperty(value: unknown, property: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return (value as Record<string, unknown>)[property];
}

function readLegacyVariableSnapshots(value: unknown): AttemptVariableSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const variable = entry as Record<string, unknown>;
      if (typeof variable.identifier !== "string" || !variable.identifier.trim()) {
        return null;
      }

      return {
        identifier: variable.identifier.trim(),
        value: variable.value,
      };
    })
    .filter((entry): entry is AttemptVariableSnapshot => entry !== null);
}

function readLegacyValidationSnapshots(value: unknown): AttemptValidationMessageSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const validation = entry as Record<string, unknown>;
      if (typeof validation.message !== "string" || !validation.message.trim()) {
        return null;
      }

      return {
        identifier:
          typeof validation.identifier === "string" && validation.identifier.trim()
            ? validation.identifier.trim()
            : null,
        message: validation.message.trim(),
      };
    })
    .filter((entry): entry is AttemptValidationMessageSnapshot => entry !== null);
}
