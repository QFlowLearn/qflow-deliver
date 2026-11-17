import type {
  AttemptEventEnvelope,
  AttemptClientSyncTrace,
  CurrentItemRef,
  ItemPresentedPayload,
} from "@harbor/attempt-protocol";
import {
  ATTEMPT_EVENT_TYPES,
  parseAccommodationSupportEvidencePayload,
} from "@harbor/attempt-protocol";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";

const ITEM_PRESENTATION_SOURCES = [
  "bootstrap",
  "resume",
  "navigation",
  "replay",
  "manual-refresh",
  "unknown",
] as const satisfies readonly NonNullable<ItemPresentedPayload["presentationSource"]>[];

export async function readAttemptEvent(request: Request): Promise<AttemptEventEnvelope> {
  const body = await readJsonObject(request);
  const type = readRequiredString(body.type, "Attempt event type is required");

  if (!ATTEMPT_EVENT_TYPES.includes(type as (typeof ATTEMPT_EVENT_TYPES)[number])) {
    throw new AttemptDurableObjectRequestError(400, "Attempt event type is not supported");
  }

  const itemRef = readCurrentItemRef(body.itemRef, "itemRef is required");
  const payload = readPayload(body.payload, type as (typeof ATTEMPT_EVENT_TYPES)[number]);

  const syncTrace = parseClientSyncTrace(body.syncTrace);
  return {
    ...(syncTrace ? { syncTrace } : {}),
    attemptId: readRequiredString(body.attemptId, "attemptId is required"),
    eventId: readRequiredString(body.eventId, "eventId is required"),
    idempotencyKey: readRequiredString(body.idempotencyKey, "idempotencyKey is required"),
    sequenceNumber: readRequiredPositiveInteger(
      body.sequenceNumber,
      "sequenceNumber must be a positive integer",
    ),
    clientTimestamp: readRequiredString(body.clientTimestamp, "clientTimestamp is required"),
    clientSessionId: readRequiredString(body.clientSessionId, "clientSessionId is required"),
    itemRef,
    type: type as (typeof ATTEMPT_EVENT_TYPES)[number],
    payload,
    ...(typeof body.clientMonotonicElapsedTimeMs === "number" &&
    Number.isFinite(body.clientMonotonicElapsedTimeMs)
      ? { clientMonotonicElapsedTimeMs: body.clientMonotonicElapsedTimeMs }
      : {}),
  };
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AttemptDurableObjectRequestError(400, "Request body must be valid JSON");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AttemptDurableObjectRequestError(400, "Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
}

export function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AttemptDurableObjectRequestError(400, message);
  }

  return value.trim();
}

export function readOptionalStringValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AttemptDurableObjectRequestError(
      400,
      "Optional string value must be a string when present",
    );
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AttemptDurableObjectRequestError(400, message);
  }

  return value as Record<string, unknown>;
}

export function readNonNegativeInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new AttemptDurableObjectRequestError(400, message);
  }

  return value as number;
}

export function readMinimumNumber(value: unknown, minimum: number, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new AttemptDurableObjectRequestError(400, message);
  }

  return value;
}

export function nullableHeaderValue(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readPayload(
  payload: unknown,
  type: (typeof ATTEMPT_EVENT_TYPES)[number],
): AttemptEventEnvelope["payload"] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AttemptDurableObjectRequestError(400, "Attempt event payload must be a JSON object");
  }

  if (type === "navigation.requested") {
    const navigationPayload = payload as Record<string, unknown>;
    return {
      targetItemRef: readCurrentItemRef(
        navigationPayload.targetItemRef,
        "navigation.requested payload must include targetItemRef",
      ),
    };
  }

  if (type === "response.changed") {
    if (
      !("responseKey" in payload) ||
      typeof payload.responseKey !== "string" ||
      !payload.responseKey.trim() ||
      !("responseState" in payload) ||
      Object.keys(payload).some(
        (key) => !["responseKey", "responseState", "intent", "clientEditRevision"].includes(key),
      )
    )
      throw new AttemptDurableObjectRequestError(400, "Invalid response checkpoint payload");
    if ("intent" in payload && payload.intent !== "checkpoint")
      throw new AttemptDurableObjectRequestError(400, "Invalid response checkpoint intent");
    if (
      "clientEditRevision" in payload &&
      (typeof payload.clientEditRevision !== "number" ||
        !Number.isSafeInteger(payload.clientEditRevision) ||
        payload.clientEditRevision < 0)
    )
      throw new AttemptDurableObjectRequestError(400, "Invalid client edit revision");
    return {
      ...("clientEditRevision" in payload && typeof payload.clientEditRevision === "number"
        ? { clientEditRevision: payload.clientEditRevision }
        : {}),
      responseKey: payload.responseKey,
      responseState: payload.responseState,
      ...("intent" in payload ? { intent: "checkpoint" } : {}),
    };
  }

  if (type === "item.submit-requested") {
    if (
      !("responseKey" in payload) ||
      typeof payload.responseKey !== "string" ||
      !("responseState" in payload) ||
      Object.keys(payload).some((key) => key !== "responseKey" && key !== "responseState")
    ) {
      throw new AttemptDurableObjectRequestError(
        400,
        "Answer submission requires responseKey and responseState only",
      );
    }
    return { responseKey: payload.responseKey, responseState: payload.responseState };
  }

  if (type === "keyword-translation.language.selected") {
    const languagePayload = payload as Record<string, unknown>;
    return {
      requestedLanguage: readRequiredString(
        languagePayload.requestedLanguage,
        "keyword translation language selection requires requestedLanguage",
      ),
    };
  }

  if (type === "accommodation.support") {
    const evidencePayload = parseAccommodationSupportEvidencePayload(payload);
    if (!evidencePayload) {
      throw new AttemptDurableObjectRequestError(400, "accommodation.support payload is invalid");
    }
    return evidencePayload;
  }

  if (type === "item.presented") {
    return readItemPresentedPayload(payload as Record<string, unknown>);
  }

  if (type === "timing.deadline.warned" || type === "timing.deadline.reached") {
    return readTimingDeadlineEvidencePayload(payload as Record<string, unknown>);
  }

  return payload as AttemptEventEnvelope["payload"];
}

function readItemPresentedPayload(payload: Record<string, unknown>): ItemPresentedPayload {
  const presentedAt = readOptionalNullableString(
    payload.presentedAt,
    "presentedAt must be a string",
  );
  const presentationSource = readOptionalNullableString(
    payload.presentationSource,
    "presentationSource must be a string",
  );
  if (presentationSource !== null && !isItemPresentationSource(presentationSource)) {
    throw new AttemptDurableObjectRequestError(400, "presentationSource is invalid");
  }
  return {
    presentedAt,
    ...(presentationSource ? { presentationSource } : {}),
  };
}

function isItemPresentationSource(
  value: string,
): value is NonNullable<ItemPresentedPayload["presentationSource"]> {
  return ITEM_PRESENTATION_SOURCES.some((source) => source === value);
}

function readTimingDeadlineEvidencePayload(payload: Record<string, unknown>) {
  if (payload.eventSource !== "browser") {
    throw new AttemptDurableObjectRequestError(400, "timing evidence eventSource must be browser");
  }
  const effectiveTimingPolicyVersion = payload.effectiveTimingPolicyVersion;
  if (
    effectiveTimingPolicyVersion !== null &&
    (!Number.isInteger(effectiveTimingPolicyVersion) ||
      (effectiveTimingPolicyVersion as number) < 0)
  ) {
    throw new AttemptDurableObjectRequestError(
      400,
      "effectiveTimingPolicyVersion must be a non-negative integer or null",
    );
  }
  return {
    eventSource: "browser" as const,
    scopeKey: readRequiredString(payload.scopeKey, "timing evidence scopeKey is required"),
    scopeType: readRequiredString(payload.scopeType, "timing evidence scopeType is required"),
    identifier: readRequiredString(payload.identifier, "timing evidence identifier is required"),
    deadlineAt: readRequiredString(payload.deadlineAt, "timing evidence deadlineAt is required"),
    effectiveTimingPolicyVersion: effectiveTimingPolicyVersion as number | null,
    remainingTimeSeconds: readNonNegativeInteger(
      payload.remainingTimeSeconds,
      "remainingTimeSeconds must be a non-negative integer",
    ),
  };
}

function readOptionalNullableString(value: unknown, message: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AttemptDurableObjectRequestError(400, message);
  return value;
}

function readCurrentItemRef(value: unknown, message: string): CurrentItemRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AttemptDurableObjectRequestError(400, message);
  }

  const itemRef = value as Record<string, unknown>;
  return {
    itemId: readRequiredString(itemRef.itemId, "itemRef.itemId is required"),
    itemHref: readRequiredString(itemRef.itemHref, "itemRef.itemHref is required"),
  };
}

function readRequiredPositiveInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new AttemptDurableObjectRequestError(400, message);
  }

  return value as number;
}

function parseClientSyncTrace(value: unknown): AttemptClientSyncTrace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    !("queuedAt" in value) ||
    typeof value.queuedAt !== "string" ||
    !("sentAt" in value) ||
    typeof value.sentAt !== "string" ||
    !("sendReason" in value) ||
    (value.sendReason !== "initial" && value.sendReason !== "replay") ||
    !("queueDepthAtSend" in value) ||
    typeof value.queueDepthAtSend !== "number" ||
    !Number.isInteger(value.queueDepthAtSend) ||
    !("replayAttempt" in value) ||
    typeof value.replayAttempt !== "number" ||
    !Number.isInteger(value.replayAttempt)
  )
    return null;
  return {
    queuedAt: value.queuedAt,
    sentAt: value.sentAt,
    sendReason: value.sendReason,
    queueDepthAtSend: value.queueDepthAtSend,
    replayAttempt: value.replayAttempt,
  };
}
