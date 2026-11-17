import { renderAttemptClientTiming } from "./attempt-client-timing";
import type {
  AttemptEventCommitResponse,
  AttemptEventEnvelope,
  AttemptLatePreserved,
  AttemptStatus,
  AttemptSyncHealthSignal,
  AttemptTimingDecision,
  AttemptTimingState,
  CurrentItemRef,
  AttemptPolicyState,
} from "@harbor/attempt-protocol";
import { findExceededDeadlineScope, type StoredScopedTimingState } from "./attempt-timing";
import { insertAttemptEvidenceEvent } from "../routes/attempt-evidence";

export interface LateEvidenceAttemptState {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  highestCommittedSequence: number;
  currentItemRef: CurrentItemRef;
  timing: AttemptTimingState;
  scopedTiming: StoredScopedTimingState;
  policy: AttemptPolicyState;
}

interface ExistingLateEvidenceRow {
  server_timestamp: string;
}

export async function preserveLateAttemptEvent(input: {
  db: D1Database;
  state: LateEvidenceAttemptState;
  event: AttemptEventEnvelope;
  attemptStatus: AttemptStatus;
  serverTimestamp: string;
}): Promise<AttemptEventCommitResponse> {
  const response = buildLatePreservedResponse({
    state: input.state,
    event: input.event,
    attemptStatus: input.attemptStatus,
    serverTimestamp: input.serverTimestamp,
  });
  const existing = await input.db
    .prepare(
      "SELECT server_timestamp FROM attempt_evidence_events WHERE attempt_id = ? AND idempotency_key = ? AND outcome = 'late_preserved' LIMIT 1",
    )
    .bind(input.state.attemptId, input.event.idempotencyKey)
    .first<ExistingLateEvidenceRow>();

  if (existing) {
    return {
      ...response,
      serverTimestamp: existing.server_timestamp,
    };
  }

  await insertAttemptEvidenceEvent({
    db: input.db,
    context: {
      id: input.state.attemptId,
      assessment_version_id: input.state.assessmentVersionId,
      assignment_id: input.state.assignmentId,
    },
    event: input.event as unknown as Record<string, unknown>,
    eventType: input.event.type,
    itemRef: input.event.itemRef,
    payload: readPayloadRecord(input.event.payload),
    receivedAt: input.serverTimestamp,
    outcome: "late_preserved",
    receiptId: null,
    eventSource: readEventSource(input.event),
    flags: buildLateEvidenceFlags(response, input.event),
    ignoreDuplicate: true,
  });

  return response;
}

export function buildLatePreservedResponse(input: {
  state: LateEvidenceAttemptState;
  event: AttemptEventEnvelope;
  attemptStatus: AttemptStatus;
  serverTimestamp: string;
}): AttemptLatePreserved {
  const timingDecision = buildLatePreservedTimingDecision(input.state, input.serverTimestamp);

  return {
    outcome: "late_preserved",
    attemptId: input.state.attemptId,
    highestCommittedSequence: input.state.highestCommittedSequence,
    expectedNextSequence: input.state.highestCommittedSequence + 1,
    attemptStatus: input.attemptStatus,
    currentItemRef: input.state.currentItemRef,
    timing: renderAttemptClientTiming(input.state, input.serverTimestamp),
    policy: input.state.policy,
    requestedSequenceNumber: input.event.sequenceNumber,
    ...(timingDecision ? { timingDecision } : {}),
    serverTimestamp: input.serverTimestamp,
  };
}

function buildLatePreservedTimingDecision(
  state: LateEvidenceAttemptState,
  serverTimestamp: string,
): AttemptTimingDecision | null {
  const deadlineScope = findExceededDeadlineScope(state.scopedTiming, serverTimestamp);
  if (!deadlineScope) {
    return null;
  }

  return {
    classification: "late-preserved",
    scopeKey: deadlineScope.key,
    scopeType: deadlineScope.scopeType,
    identifier: deadlineScope.identifier,
    deadlineAt: deadlineScope.deadlineAt,
    serverTimestamp,
    allowLateSubmission: deadlineScope.allowLateSubmission,
  };
}

function buildLateEvidenceFlags(
  response: AttemptLatePreserved,
  event: AttemptEventEnvelope,
): Record<string, unknown> {
  return {
    attemptStatus: response.attemptStatus,
    currentItemRef: response.currentItemRef,
    highestCommittedSequence: response.highestCommittedSequence,
    timing: response.timing,
    ...(response.timingDecision ? { timingDecision: response.timingDecision } : {}),
    requestedSequenceNumber: response.requestedSequenceNumber,
    expectedNextSequence: response.expectedNextSequence,
    syncSignals: deriveSyncSignals(event),
  };
}

function deriveSyncSignals(event: AttemptEventEnvelope): AttemptSyncHealthSignal[] {
  if (!event.syncTrace) {
    return [];
  }

  return event.syncTrace.sendReason === "replay"
    ? ["queued_locally", "replayed"]
    : ["queued_locally"];
}

function readEventSource(event: AttemptEventEnvelope): string {
  return event.clientSessionId.startsWith("server_") ? "server" : "client";
}

function readPayloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as Record<string, unknown>;
}
