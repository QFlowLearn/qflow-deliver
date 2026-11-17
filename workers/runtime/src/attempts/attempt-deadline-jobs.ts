import type { AttemptStatus } from "@harbor/attempt-protocol";
import type { StoredScopedTimingState, StoredTimingScope } from "./attempt-timing";

export type AttemptDeadlineJobStatus = "pending" | "fired" | "canceled" | "superseded";

export interface AttemptDeadlineJobProjectionState {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  scopedTiming: StoredScopedTimingState;
  attemptStatus: AttemptStatus;
}

interface PendingDeadlineJobRow {
  id: string;
  scope_key: string;
  policy_version: number;
  deadline_at: string;
}

interface DeadlineJobProjection {
  id: string;
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  scopeKey: string;
  scopeType: string;
  identifier: string;
  policyVersion: number;
  deadlineAt: string;
}

export async function syncAttemptDeadlineJobs(input: {
  db: D1Database;
  state: AttemptDeadlineJobProjectionState;
  now: string;
}): Promise<void> {
  if (input.state.attemptStatus === "submitted") {
    await closeAttemptDeadlineJobs({
      db: input.db,
      attemptId: input.state.attemptId,
      status: "canceled",
      receiptId: null,
      now: input.now,
    });
    return;
  }

  const nextJobs = buildDeadlineJobProjections(input.state);
  const nextKeys = new Set(nextJobs.map(readDeadlineJobKey));
  const existing = await input.db
    .prepare(
      "SELECT id, scope_key, policy_version, deadline_at FROM attempt_deadline_jobs WHERE attempt_id = ? AND status = 'pending'",
    )
    .bind(input.state.attemptId)
    .all<PendingDeadlineJobRow>();
  const existingKeys = new Set(existing.results.map(readPendingDeadlineJobKey));
  const statements: D1PreparedStatement[] = [];

  for (const row of existing.results) {
    if (!nextKeys.has(readPendingDeadlineJobKey(row))) {
      statements.push(
        input.db
          .prepare(
            "UPDATE attempt_deadline_jobs SET status = 'superseded', updated_at = ? WHERE id = ?",
          )
          .bind(input.now, row.id),
      );
    }
  }

  for (const job of nextJobs) {
    if (existingKeys.has(readDeadlineJobKey(job))) {
      continue;
    }

    statements.push(
      input.db
        .prepare(
          "INSERT INTO attempt_deadline_jobs (id, attempt_id, assessment_version_id, assignment_id, scope_key, scope_type, identifier, policy_version, deadline_at, status, auto_submit_receipt_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)",
        )
        .bind(
          job.id,
          job.attemptId,
          job.assessmentVersionId,
          job.assignmentId,
          job.scopeKey,
          job.scopeType,
          job.identifier,
          job.policyVersion,
          job.deadlineAt,
          input.now,
          input.now,
        ),
    );
  }

  if (statements.length > 0) {
    await input.db.batch(statements);
  }
}

export async function closeAttemptDeadlineJobs(input: {
  db: D1Database;
  attemptId: string;
  status: Exclude<AttemptDeadlineJobStatus, "pending">;
  receiptId: string | null;
  now: string;
}): Promise<void> {
  await input.db
    .prepare(
      "UPDATE attempt_deadline_jobs SET status = ?, auto_submit_receipt_id = COALESCE(?, auto_submit_receipt_id), updated_at = ? WHERE attempt_id = ? AND status = 'pending'",
    )
    .bind(input.status, input.receiptId, input.now, input.attemptId)
    .run();
}

function buildDeadlineJobProjections(
  state: AttemptDeadlineJobProjectionState,
): DeadlineJobProjection[] {
  return state.scopedTiming.scopes.filter(isDeadlineJobScope).map((scope) => ({
    id: buildDeadlineJobId(state.attemptId, state.scopedTiming.policyVersion, scope),
    attemptId: state.attemptId,
    assessmentVersionId: state.assessmentVersionId,
    assignmentId: state.assignmentId,
    scopeKey: scope.key,
    scopeType: scope.scopeType,
    identifier: scope.identifier,
    policyVersion: state.scopedTiming.policyVersion,
    deadlineAt: scope.deadlineAt!,
  }));
}

function isDeadlineJobScope(scope: StoredTimingScope): boolean {
  return Boolean(scope.deadlineAt && !scope.unlimited);
}

function readDeadlineJobKey(job: DeadlineJobProjection): string {
  return `${job.scopeKey}\u0000${job.policyVersion}\u0000${job.deadlineAt}`;
}

function readPendingDeadlineJobKey(row: PendingDeadlineJobRow): string {
  return `${row.scope_key}\u0000${row.policy_version}\u0000${row.deadline_at}`;
}

function buildDeadlineJobId(
  attemptId: string,
  policyVersion: number,
  scope: StoredTimingScope,
): string {
  return [
    "adj",
    attemptId,
    String(policyVersion),
    sanitizeIdPart(scope.key),
    String(Date.parse(scope.deadlineAt ?? "")),
  ].join("_");
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
