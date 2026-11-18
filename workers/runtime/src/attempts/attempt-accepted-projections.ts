import {
  SERVER_PROJECTED_ATTEMPT_EVIDENCE_OUTCOME,
  type AttemptEventEnvelope,
  type CommitAttemptEventReceipt,
  type CurrentItemRef,
} from "@harbor/attempt-protocol";
import type { StoredScopedTimingState } from "./attempt-timing";
import { readSubmitLikePayload } from "./attempt-materialization";
import { appendAttemptTimelineEvent } from "../routes/operator-actions";

/** Metadata for projections; the outbox retains the accepted event separately. */
export interface AcceptedProjectionAttemptState {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  currentItemRef: CurrentItemRef;
  scopedTiming: Pick<StoredScopedTimingState, "policyVersion">;
}

export async function projectAcceptedAttemptProjections(input: {
  db: D1Database;
  attemptId: string;
  previousState: AcceptedProjectionAttemptState;
  nextState: AcceptedProjectionAttemptState;
  event: AttemptEventEnvelope;
  receipt: CommitAttemptEventReceipt;
  serverAutoSubmitClientSessionId: string;
}): Promise<void> {
  await projectAcceptedTimelineEvent(input);
  await projectAcceptedTimingEvents(input);
}

export async function insertTimingEvidenceEvent(input: {
  db: D1Database;
  storedState: AcceptedProjectionAttemptState;
  eventType: string;
  sequenceNumber: number | null;
  itemRef: CurrentItemRef | null;
  payload: Record<string, unknown>;
  createdAt: string;
  id?: string;
}): Promise<void> {
  await input.db
    .prepare(
      "INSERT INTO attempt_evidence_events (id, attempt_id, assessment_version_id, assignment_id, event_id, event_type, evidence_kind, sequence_number, idempotency_key, client_session_id, item_id, item_href, response_key, client_timestamp, server_timestamp, outcome, receipt_id, event_source, flags_json, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(
      input.id ? `${input.id}:${input.eventType}` : createId("aev"),
      input.storedState.attemptId,
      input.storedState.assessmentVersionId,
      input.storedState.assignmentId,
      null,
      input.eventType,
      "timing",
      input.sequenceNumber,
      null,
      null,
      input.itemRef?.itemId ?? null,
      input.itemRef?.itemHref ?? null,
      null,
      null,
      input.createdAt,
      SERVER_PROJECTED_ATTEMPT_EVIDENCE_OUTCOME,
      null,
      "server",
      JSON.stringify({
        effectiveTimingPolicyVersion: input.storedState.scopedTiming.policyVersion,
      }),
      JSON.stringify(input.payload),
      input.createdAt,
    )
    .run();
}

async function projectAcceptedTimelineEvent(input: {
  db: D1Database;
  attemptId: string;
  event: AttemptEventEnvelope;
  receipt: CommitAttemptEventReceipt;
}): Promise<void> {
  if (input.event.type === "response.changed" || input.event.type === "heartbeat") {
    return;
  }

  if (
    input.event.type === "submit.requested" ||
    input.event.type === "timing.auto-submit.requested"
  ) {
    const submitPayload = readSubmitLikePayload(input.event);
    await appendAttemptTimelineEvent({
      id: `atline:${input.receipt.receiptId}`,
      db: input.db,
      attemptId: input.attemptId,
      eventType: "submit",
      sequenceNumber: input.receipt.acceptedSequenceNumber,
      summary: {
        sourceEventType: input.event.type,
        attemptStatus: input.receipt.attemptStatus,
        totalScore: submitPayload?.submissionSummary?.totalScore ?? null,
        maxScore: submitPayload?.submissionSummary?.maxScore ?? null,
        answeredItemCount: submitPayload?.submissionSummary?.answeredItemCount ?? null,
      },
      createdAt: input.receipt.serverTimestamp,
    });
    return;
  }

  if (input.event.type === "item.completed" || input.event.type === "navigation.requested") {
    await appendAttemptTimelineEvent({
      id: `atline:${input.receipt.receiptId}`,
      db: input.db,
      attemptId: input.attemptId,
      eventType: "accepted-checkpoint",
      sequenceNumber: input.receipt.acceptedSequenceNumber,
      summary: {
        sourceEventType: input.event.type,
        attemptStatus: input.receipt.attemptStatus,
        currentItemId: input.receipt.currentItemRef.itemId,
      },
      createdAt: input.receipt.serverTimestamp,
    });
  }
}

async function projectAcceptedTimingEvents(input: {
  db: D1Database;
  previousState: AcceptedProjectionAttemptState;
  nextState: AcceptedProjectionAttemptState;
  event: AttemptEventEnvelope;
  receipt: CommitAttemptEventReceipt;
  serverAutoSubmitClientSessionId: string;
}): Promise<void> {
  if (input.event.type === "timing.auto-submit.requested") {
    const autoSubmitEvent = input.event as AttemptEventEnvelope<"timing.auto-submit.requested">;
    const source = resolveTimingAutoSubmitSource(
      autoSubmitEvent,
      input.serverAutoSubmitClientSessionId,
    );
    await insertTimingEvidenceEvent({
      id: `aev:${input.receipt.receiptId}`,
      db: input.db,
      storedState: input.nextState,
      eventType: "timing.deadline.reached",
      sequenceNumber: input.receipt.acceptedSequenceNumber,
      itemRef: input.event.itemRef,
      payload: {
        ...input.receipt.timingDecision,
        effectiveTimingPolicyVersion: input.nextState.scopedTiming.policyVersion,
        source,
      },
      createdAt: input.receipt.serverTimestamp,
    });
    await insertTimingEvidenceEvent({
      id: `aev:${input.receipt.receiptId}`,
      db: input.db,
      storedState: input.nextState,
      eventType: "timing.auto-submit.accepted",
      sequenceNumber: input.receipt.acceptedSequenceNumber,
      itemRef: input.event.itemRef,
      payload: {
        reason: autoSubmitEvent.payload.reason,
        scopeKey:
          autoSubmitEvent.payload.scopeKey ?? input.receipt.timingDecision?.scopeKey ?? null,
        effectiveTimingPolicyVersion: input.nextState.scopedTiming.policyVersion,
        source,
      },
      createdAt: input.receipt.serverTimestamp,
    });
  }

  if (input.event.type === "navigation.requested") {
    await insertTimingEvidenceEvent({
      id: `aev:${input.receipt.receiptId}`,
      db: input.db,
      storedState: input.nextState,
      eventType: "timing.scope.suspended",
      sequenceNumber: input.receipt.acceptedSequenceNumber,
      itemRef: input.event.itemRef,
      payload: {
        scopeType: "item-session",
        itemId: input.previousState.currentItemRef.itemId,
        effectiveTimingPolicyVersion: input.nextState.scopedTiming.policyVersion,
        source: "server",
      },
      createdAt: input.receipt.serverTimestamp,
    });
    await insertTimingEvidenceEvent({
      id: `aev:${input.receipt.receiptId}`,
      db: input.db,
      storedState: input.nextState,
      eventType: "timing.scope.resumed",
      sequenceNumber: input.receipt.acceptedSequenceNumber,
      itemRef: input.receipt.currentItemRef,
      payload: {
        scopeType: "item-session",
        itemId: input.receipt.currentItemRef.itemId,
        effectiveTimingPolicyVersion: input.nextState.scopedTiming.policyVersion,
        source: "server",
      },
      createdAt: input.receipt.serverTimestamp,
    });
  }

  if (input.event.type === "item.suspended" || input.event.type === "item.completed") {
    await insertTimingEvidenceEvent({
      id: `aev:${input.receipt.receiptId}`,
      db: input.db,
      storedState: input.nextState,
      eventType:
        input.event.type === "item.suspended" ? "timing.scope.suspended" : "timing.scope.exited",
      sequenceNumber: input.receipt.acceptedSequenceNumber,
      itemRef: input.event.itemRef,
      payload: {
        scopeType: "item-session",
        itemId: input.event.itemRef.itemId,
        effectiveTimingPolicyVersion: input.nextState.scopedTiming.policyVersion,
        source: "server",
      },
      createdAt: input.receipt.serverTimestamp,
    });
  }

  if (input.receipt.timingDecision?.classification === "late-accepted") {
    await insertTimingEvidenceEvent({
      id: `aev:${input.receipt.receiptId}`,
      db: input.db,
      storedState: input.nextState,
      eventType: "submit.late-accepted",
      sequenceNumber: input.receipt.acceptedSequenceNumber,
      itemRef: input.event.itemRef,
      payload: { ...input.receipt.timingDecision },
      createdAt: input.receipt.serverTimestamp,
    });
  }
}

function resolveTimingAutoSubmitSource(
  event: AttemptEventEnvelope<"timing.auto-submit.requested">,
  serverAutoSubmitClientSessionId: string,
): "browser" | "server" {
  return event.clientSessionId === serverAutoSubmitClientSessionId ? "server" : "browser";
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
