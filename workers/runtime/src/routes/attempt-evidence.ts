import {
  projectAttemptEventAccommodationEvidence,
  type AttemptEvidenceEvent,
  type AttemptEvidenceKind,
  type AttemptEvidenceOutcome,
  type AttemptEvidenceResponse,
  type AttemptEventCommitResponse,
  type AttemptSyncHealthSignal,
  type CurrentItemRef,
} from "@harbor/attempt-protocol";

import type { AppContext } from "./hono-utils";
import { readAttemptIdParam } from "./route-params";

interface AttemptEvidenceEnv {
  HARBOR_DB: D1Database;
}

export interface AttemptEvidenceProjectionContext {
  id: string;
  assessment_version_id: string;
  assignment_id: string | null;
}

interface AttemptEvidenceRow {
  id: string;
  attempt_id: string;
  assessment_version_id: string;
  assignment_id: string | null;
  event_id: string | null;
  event_type: string;
  evidence_kind: AttemptEvidenceKind;
  sequence_number: number | null;
  idempotency_key: string | null;
  client_session_id: string | null;
  item_id: string | null;
  item_href: string | null;
  response_key: string | null;
  client_timestamp: string | null;
  server_timestamp: string;
  outcome: AttemptEvidenceOutcome;
  receipt_id: string | null;
  event_source: string;
  flags_json: string;
  payload_json: string;
  created_at: string;
}

export async function projectAttemptEvidenceEvent(input: {
  db: D1Database;
  attemptId: string;
  requestBody: string;
  commitResponse: AttemptEventCommitResponse;
  receivedAt: string;
}): Promise<void> {
  const event = parseEventRecord(input.requestBody);
  if (!event) {
    return;
  }

  const eventType = readOptionalString(event.type);
  if (!eventType) {
    return;
  }

  const context = await input.db
    .prepare("SELECT id, assessment_version_id, assignment_id FROM attempt_entries WHERE id = ?")
    .bind(input.attemptId)
    .first<AttemptEvidenceProjectionContext>();

  if (!context) {
    return;
  }

  const itemRef = readItemRef(event.itemRef);
  const rawPayload = readRecord(event.payload) ?? {};
  const projectedPayload = projectAttemptEventAccommodationEvidence(
    eventType,
    rawPayload,
    readCommittedKeywordTranslationLanguage(input.commitResponse),
  );
  const payload = projectedPayload ?? rawPayload;
  await insertAttemptEvidenceEvent({
    db: input.db,
    context,
    event,
    eventType,
    itemRef,
    payload,
    receivedAt: input.receivedAt,
    outcome: input.commitResponse.outcome,
    receiptId: readReceiptId(input.commitResponse),
    flags: buildEvidenceFlags(input.commitResponse, event),
    ignoreDuplicate: true,
    ...(input.commitResponse.outcome === "accepted"
      ? { id: `aev:accepted:${input.commitResponse.receiptId}` }
      : {}),
  });
}

export async function handleGetInternalAttemptEvidenceRequest(c: AppContext): Promise<Response> {
  return getInternalAttemptEvidence({
    env: c.env,
    attemptId: readAttemptIdParam(c),
  });
}

export async function getInternalAttemptEvidence(input: {
  env: AttemptEvidenceEnv;
  attemptId: string;
}): Promise<Response> {
  return Response.json(await readAttemptEvidence(input.env.HARBOR_DB, input.attemptId), {
    status: 200,
  });
}

export async function readAttemptEvidence(
  db: D1Database,
  attemptId: string,
): Promise<AttemptEvidenceResponse> {
  const result = await db
    .prepare(
      "SELECT id, attempt_id, assessment_version_id, assignment_id, event_id, event_type, evidence_kind, sequence_number, idempotency_key, client_session_id, item_id, item_href, response_key, client_timestamp, server_timestamp, outcome, receipt_id, event_source, flags_json, payload_json, created_at FROM attempt_evidence_events WHERE attempt_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(attemptId)
    .all<AttemptEvidenceRow>();

  return {
    attemptId,
    events: result.results.map(mapAttemptEvidenceRow),
  };
}

export async function insertAttemptEvidenceEvent(input: {
  db: D1Database;
  context: AttemptEvidenceProjectionContext;
  event: Record<string, unknown>;
  eventType: string;
  itemRef: CurrentItemRef | null;
  payload: Record<string, unknown>;
  receivedAt: string;
  outcome: AttemptEvidenceOutcome;
  receiptId: string | null;
  flags: Record<string, unknown>;
  eventSource?: string | null;
  ignoreDuplicate?: boolean;
  id?: string;
}): Promise<void> {
  await input.db
    .prepare(
      `${input.ignoreDuplicate ? "INSERT OR IGNORE" : "INSERT"} INTO attempt_evidence_events (id, attempt_id, assessment_version_id, assignment_id, event_id, event_type, evidence_kind, sequence_number, idempotency_key, client_session_id, item_id, item_href, response_key, client_timestamp, server_timestamp, outcome, receipt_id, event_source, flags_json, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id ?? createId("aev"),
      input.context.id,
      input.context.assessment_version_id,
      input.context.assignment_id,
      readOptionalString(input.event.eventId),
      input.eventType,
      classifyEvidenceKind(input.eventType),
      readOptionalInteger(input.event.sequenceNumber),
      readOptionalString(input.event.idempotencyKey),
      readOptionalString(input.event.clientSessionId),
      input.itemRef?.itemId ?? null,
      input.itemRef?.itemHref ?? null,
      readResponseKey(input.payload),
      readOptionalString(input.event.clientTimestamp),
      input.receivedAt,
      input.outcome,
      input.receiptId,
      input.eventSource ?? readEventSource(input.event, input.payload),
      JSON.stringify(input.flags),
      JSON.stringify(input.payload),
      input.receivedAt,
    )
    .run();
}

function mapAttemptEvidenceRow(row: AttemptEvidenceRow): AttemptEvidenceEvent {
  const flags = parseJsonRecord(row.flags_json);

  return {
    id: row.id,
    attemptId: row.attempt_id,
    assessmentVersionId: row.assessment_version_id,
    assignmentId: row.assignment_id,
    eventId: row.event_id,
    eventType: row.event_type,
    evidenceKind: row.evidence_kind,
    sequenceNumber: row.sequence_number,
    idempotencyKey: row.idempotency_key,
    clientSessionId: row.client_session_id,
    itemRef:
      row.item_id && row.item_href
        ? {
            itemId: row.item_id,
            itemHref: row.item_href,
          }
        : null,
    responseKey: row.response_key,
    clientTimestamp: row.client_timestamp,
    serverTimestamp: row.server_timestamp,
    outcome: row.outcome,
    receiptId: row.receipt_id,
    eventSource: row.event_source,
    syncSignals: readSyncSignals(flags),
    flags,
    payload: parseJsonRecord(row.payload_json),
    createdAt: row.created_at,
  };
}

function classifyEvidenceKind(eventType: string): AttemptEvidenceKind {
  if (eventType === "item.presented") {
    return "item-presentation";
  }

  if (eventType === "accommodation.support") {
    return "accommodation-support";
  }

  if (eventType === "keyword-translation.language.selected") {
    return "accommodation-support";
  }

  if (eventType === "response.changed") {
    return "response";
  }

  if (eventType === "navigation.requested") {
    return "navigation";
  }

  if (eventType === "heartbeat") {
    return "heartbeat";
  }

  if (eventType === "submit.requested") {
    return "submit";
  }

  if (eventType.startsWith("timing.") || eventType.startsWith("submit.late-")) {
    return "timing";
  }

  return "item-lifecycle";
}

function buildEvidenceFlags(
  response: AttemptEventCommitResponse,
  event: Record<string, unknown>,
): Record<string, unknown> {
  const clientSyncTrace = readClientSyncTrace(event.syncTrace);

  return {
    attemptStatus: response.attemptStatus,
    currentItemRef: response.currentItemRef,
    highestCommittedSequence: response.highestCommittedSequence,
    timing: response.timing,
    ...(clientSyncTrace ? { clientSyncTrace } : {}),
    ...(readOptionalNumber(event.clientMonotonicElapsedTimeMs) !== null
      ? {
          clientMonotonicElapsedTimeMs: readOptionalNumber(event.clientMonotonicElapsedTimeMs),
        }
      : {}),
    ...("timingDecision" in response && response.timingDecision
      ? { timingDecision: response.timingDecision }
      : {}),
    syncSignals: deriveSyncSignals(response, clientSyncTrace),
    ...(response.outcome !== "accepted"
      ? { requestedSequenceNumber: response.requestedSequenceNumber }
      : {}),
    ...("expectedNextSequence" in response
      ? { expectedNextSequence: response.expectedNextSequence }
      : {}),
    ...("replayFromSequenceNumber" in response
      ? { replayFromSequenceNumber: response.replayFromSequenceNumber }
      : {}),
    ...("currentClientSessionId" in response
      ? { currentClientSessionId: response.currentClientSessionId }
      : {}),
    ...("requestedClientSessionId" in response
      ? { requestedClientSessionId: response.requestedClientSessionId }
      : {}),
  };
}

function deriveSyncSignals(
  response: AttemptEventCommitResponse,
  clientSyncTrace: Record<string, unknown> | null,
): AttemptSyncHealthSignal[] {
  const signals = new Set<AttemptSyncHealthSignal>();

  if (clientSyncTrace) {
    signals.add("queued_locally");
    if (clientSyncTrace.sendReason === "replay") {
      signals.add("replayed");
    }
  }

  if (readReceiptId(response)) {
    signals.add("receipt_confirmed");
  }

  if (response.outcome === "stale_session") {
    signals.add("stale_tab_reconciled");
  }

  if (response.outcome === "gap" || response.outcome === "stale_sequence") {
    signals.add("sync_failed");
  }

  return [...signals];
}

function readClientSyncTrace(value: unknown): Record<string, unknown> | null {
  const trace = readRecord(value);
  if (!trace) {
    return null;
  }

  const queuedAt = readOptionalString(trace.queuedAt);
  const sentAt = readOptionalString(trace.sentAt);
  const sendReason = readOptionalString(trace.sendReason);
  const queueDepthAtSend = readOptionalInteger(trace.queueDepthAtSend);
  const replayAttempt = readOptionalInteger(trace.replayAttempt);

  if (
    !queuedAt ||
    !sentAt ||
    (sendReason !== "initial" && sendReason !== "replay") ||
    queueDepthAtSend === null ||
    replayAttempt === null
  ) {
    return null;
  }

  return {
    queuedAt,
    sentAt,
    sendReason,
    queueDepthAtSend,
    replayAttempt,
  };
}

function readSyncSignals(flags: Record<string, unknown>): AttemptSyncHealthSignal[] {
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

function readReceiptId(response: AttemptEventCommitResponse): string | null {
  if (response.outcome === "accepted") {
    return response.receiptId;
  }

  if (response.outcome === "duplicate") {
    return response.storedReceipt.receiptId;
  }

  return null;
}

function readCommittedKeywordTranslationLanguage(
  response: AttemptEventCommitResponse,
): string | null {
  if (response.deliveryPreferences?.keywordTranslationLanguage) {
    return response.deliveryPreferences.keywordTranslationLanguage;
  }
  if (response.outcome === "duplicate") {
    return response.storedReceipt.deliveryPreferences?.keywordTranslationLanguage ?? null;
  }
  return null;
}

function readEventSource(event: Record<string, unknown>, payload: Record<string, unknown>): string {
  return (
    readOptionalString(event.eventSource) ??
    readOptionalString(event.deliverySource) ??
    readOptionalString(payload.eventSource) ??
    readOptionalString(payload.presentationSource) ??
    "client"
  );
}

function readResponseKey(payload: Record<string, unknown>): string | null {
  return readOptionalString(payload.responseKey);
}

function readItemRef(value: unknown): CurrentItemRef | null {
  const itemRef = readRecord(value);
  if (!itemRef) {
    return null;
  }

  const itemId = readOptionalString(itemRef.itemId);
  const itemHref = readOptionalString(itemRef.itemHref);
  if (!itemId || !itemHref) {
    return null;
  }

  return {
    itemId,
    itemHref,
  };
}

function parseEventRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return readRecord(parsed);
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return readRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readOptionalInteger(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
