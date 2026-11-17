import type { QtiAssessmentItemPlayerHandle } from "@longsightgroup/qti3-player-preact";
import {
  isQtiAttemptStateV1,
  type QtiAttemptStateV1,
  type QtiItemSession,
  type QtiValue,
} from "@longsightgroup/qti3-core";
import type { RendererConfiguration } from "./index";

const HARBOR_BUILT_IN_RESPONSE_IDENTIFIERS = new Set(["duration", "numAttempts"]);

type HarborBuiltIns = NonNullable<RendererConfiguration["builtIns"]>;

interface QtiPlayerSessionBridge {
  session?: Pick<QtiItemSession, "respond"> | null;
}

export function applyHarborBuiltInsToPlayer(
  playerHandle: QtiAssessmentItemPlayerHandle,
  builtIns: HarborBuiltIns,
): void {
  const session = (playerHandle.element as unknown as QtiPlayerSessionBridge).session;
  if (!session) {
    return;
  }

  for (const [identifier, value] of builtInResponses(builtIns)) {
    session.respond(identifier, value);
  }
}

export function stripHarborBuiltInsFromAttemptState(state: QtiAttemptStateV1): QtiAttemptStateV1 {
  const responses = stripHarborBuiltInsFromRecord(state.responses);
  if (responses === state.responses) {
    return state;
  }

  return {
    ...state,
    responses,
  };
}

export function stripHarborBuiltInsFromPlayerDetail<TDetail>(detail: TDetail): TDetail {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return detail;
  }

  const record = detail as Record<string, unknown>;
  if (!isQtiAttemptStateV1(record.state)) {
    return detail;
  }

  const state = stripHarborBuiltInsFromAttemptState(record.state);
  if (state === record.state) {
    return detail;
  }

  return {
    ...record,
    state,
  } as TDetail;
}

function builtInResponses(builtIns: HarborBuiltIns): Array<[string, QtiValue]> {
  const responses: Array<[string, QtiValue]> = [];

  if (typeof builtIns.duration === "number" && Number.isFinite(builtIns.duration)) {
    responses.push(["duration", formatDurationValue(builtIns.duration)]);
  }

  if (typeof builtIns.numAttempts === "number" && Number.isFinite(builtIns.numAttempts)) {
    responses.push(["numAttempts", Math.max(0, Math.trunc(builtIns.numAttempts))]);
  }

  return responses;
}

function stripHarborBuiltInsFromRecord(
  responses: Record<string, QtiValue>,
): Record<string, QtiValue> {
  let next: Record<string, QtiValue> | null = null;
  for (const identifier of HARBOR_BUILT_IN_RESPONSE_IDENTIFIERS) {
    if (Object.hasOwn(responses, identifier)) {
      next ??= { ...responses };
      delete next[identifier];
    }
  }

  return next ?? responses;
}

function formatDurationValue(seconds: number | undefined): string {
  const value = Math.max(0, seconds ?? 0);
  return `PT${Number.isInteger(value) ? value : value.toFixed(1)}S`;
}
