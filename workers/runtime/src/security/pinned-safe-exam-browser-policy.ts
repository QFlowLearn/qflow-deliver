import type { AssignmentPolicySnapshot } from "@harbor/attempt-protocol";
import { parseStoredAssignmentPolicySnapshot } from "../routes/assignment-request-parsers";
import { LaunchRequestError } from "../launch/create-preview-attempt";

/** Generate resumed exam settings from the attempt snapshot, never edited assignment settings. */
export async function readPinnedSafeExamBrowserPolicy(input: {
  readonly db: D1Database;
  readonly attemptCoordinator: DurableObjectNamespace;
  readonly assignmentId: string;
  readonly learnerId: string;
  readonly initialPolicy: AssignmentPolicySnapshot;
}): Promise<AssignmentPolicySnapshot> {
  const attempts = await input.db
    .prepare(
      "SELECT id, assignment_policy_snapshot FROM attempt_entries WHERE assignment_id = ? AND actor_kind = 'student-learner' AND actor_id = ? ORDER BY created_at DESC LIMIT 5",
    )
    .bind(input.assignmentId, input.learnerId)
    .all<{ id: string; assignment_policy_snapshot: string | null }>();
  for (const attempt of attempts.results) {
    const stub = input.attemptCoordinator.get(input.attemptCoordinator.idFromName(attempt.id));
    const response = await stub.fetch("https://harbor-attempt.local/session", {
      headers: { "x-harbor-attempt-id": attempt.id },
    });
    if (!response.ok)
      throw new LaunchRequestError(response.status, "Unable to inspect the pinned SEB attempt");
    const session: unknown = await response.json();
    if (!session || typeof session !== "object" || !("attemptStatus" in session))
      throw new LaunchRequestError(500, "Invalid pinned SEB session state");
    if (
      session.attemptStatus === "submitted" ||
      session.attemptStatus === "expired_pending_recovery"
    )
      continue;
    if (
      session.attemptStatus !== "active" &&
      session.attemptStatus !== "soft_closed" &&
      session.attemptStatus !== "accepting_late_within_grace" &&
      session.attemptStatus !== "reopened"
    )
      throw new LaunchRequestError(500, "Unknown pinned SEB session status");
    if (!attempt.assignment_policy_snapshot)
      throw new LaunchRequestError(409, "Pinned assignment policy is required for SEB settings");
    return parseStoredAssignmentPolicySnapshot(attempt.assignment_policy_snapshot);
  }
  return input.initialPolicy;
}
