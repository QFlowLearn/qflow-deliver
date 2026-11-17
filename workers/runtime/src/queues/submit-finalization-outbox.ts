import type { AttemptEventType, CommitAttemptEventReceipt } from "@harbor/attempt-protocol";

export type SubmitFinalizationEventType = "submit.requested" | "timing.auto-submit.requested";

export interface SubmitFinalizationEnvelope {
  attemptId: string;
  eventType: SubmitFinalizationEventType;
  receiptId: string;
  acceptedSequenceNumber: number;
  submittedAt: string;
}

export interface AttemptResultContextRow {
  attempt_id: string;
  assessment_version_id: string;
  assignment_id: string | null;
  manifest_object_key: string;
}

export interface PersistedResultFinalization {
  id: string;
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  sourceReceiptId: string;
  sourceSequenceNumber: number;
  sourceEventType: SubmitFinalizationEventType;
  status: "pending" | "complete" | "failed";
  materializedFrom: "authoritative-qti-snapshot" | "compatibility-submission-summary";
  submittedAt: string;
  finalizedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PendingSubmitFinalizationRow {
  attemptId: string;
  eventType: SubmitFinalizationEventType;
  receiptId: string;
  acceptedSequenceNumber: number;
  submittedAt: string;
}

export function buildSubmitFinalizationEnvelope(input: {
  eventType: AttemptEventType;
  receipt: CommitAttemptEventReceipt;
}): SubmitFinalizationEnvelope {
  if (
    input.eventType !== "submit.requested" &&
    input.eventType !== "timing.auto-submit.requested"
  ) {
    throw new Error("Submit finalization queue only accepts submit receipts");
  }

  if (input.receipt.attemptStatus !== "submitted") {
    throw new Error("Submit finalization queue requires a submitted receipt");
  }

  return {
    attemptId: input.receipt.attemptId,
    eventType: input.eventType,
    receiptId: input.receipt.receiptId,
    acceptedSequenceNumber: input.receipt.acceptedSequenceNumber,
    submittedAt: input.receipt.serverTimestamp,
  };
}

export async function ensurePendingSubmitFinalization(input: {
  db: D1Database;
  envelope: SubmitFinalizationEnvelope;
  context?: AttemptResultContextRow;
}): Promise<PersistedResultFinalization> {
  const context =
    input.context ?? (await loadAttemptResultContext(input.db, input.envelope.attemptId));
  const createdAt = new Date().toISOString();

  await input.db
    .prepare(
      "INSERT OR IGNORE INTO result_finalizations (id, attempt_id, assessment_version_id, assignment_id, source_receipt_id, source_sequence_number, source_event_type, status, materialized_from, submitted_at, finalized_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      createId("rfinal"),
      context.attempt_id,
      context.assessment_version_id,
      context.assignment_id,
      input.envelope.receiptId,
      input.envelope.acceptedSequenceNumber,
      input.envelope.eventType,
      "pending",
      "authoritative-qti-snapshot",
      input.envelope.submittedAt,
      null,
      null,
      createdAt,
      createdAt,
    )
    .run();

  return readResultFinalizationByReceipt(input.db, input.envelope.receiptId);
}

export async function loadAttemptResultContext(
  db: D1Database,
  attemptId: string,
): Promise<AttemptResultContextRow> {
  const row = await db
    .prepare(
      "SELECT id AS attempt_id, assessment_version_id, assignment_id, manifest_object_key FROM attempt_entries WHERE id = ?",
    )
    .bind(attemptId)
    .first<AttemptResultContextRow>();

  if (!row) {
    throw new Error("Attempt entry not found for submit finalization");
  }

  return row;
}

export async function readPendingSubmitFinalizationEnvelopes(input: {
  db: D1Database;
  limit: number;
}): Promise<SubmitFinalizationEnvelope[]> {
  const result = await input.db
    .prepare(
      `SELECT attempt_id AS attemptId,
              COALESCE(source_event_type, 'submit.requested') AS eventType,
              source_receipt_id AS receiptId,
              source_sequence_number AS acceptedSequenceNumber,
              submitted_at AS submittedAt
         FROM result_finalizations
        WHERE status = 'pending'
        ORDER BY submitted_at ASC, created_at ASC
        LIMIT ?`,
    )
    .bind(Math.max(1, Math.floor(input.limit)))
    .all<PendingSubmitFinalizationRow>();

  return result.results.map((row) => ({
    attemptId: row.attemptId,
    eventType: row.eventType,
    receiptId: row.receiptId,
    acceptedSequenceNumber: row.acceptedSequenceNumber,
    submittedAt: row.submittedAt,
  }));
}

async function readResultFinalizationByReceipt(
  db: D1Database,
  receiptId: string,
): Promise<PersistedResultFinalization> {
  const row = await db
    .prepare(
      "SELECT id, attempt_id AS attemptId, assessment_version_id AS assessmentVersionId, assignment_id AS assignmentId, source_receipt_id AS sourceReceiptId, source_sequence_number AS sourceSequenceNumber, COALESCE(source_event_type, 'submit.requested') AS sourceEventType, status, materialized_from AS materializedFrom, submitted_at AS submittedAt, finalized_at AS finalizedAt, error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt FROM result_finalizations WHERE source_receipt_id = ?",
    )
    .bind(receiptId)
    .first<PersistedResultFinalization>();

  if (!row) {
    throw new Error("Pending submit finalization was not persisted");
  }

  return row;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
