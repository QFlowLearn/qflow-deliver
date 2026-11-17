import {
  type AssignmentLearnerOverrideRecord,
  type InstructorRosterAttemptProjection,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../../launch/create-preview-attempt";
import { mapOverrideRow } from "./policy-overrides";
import { requireLearnerRecord } from "./json-parsers";
import type {
  AttemptResultRow,
  AttemptRow,
  OverrideRow,
  ResultFinalizationRow,
  TargetedLearnerRow,
} from "./types";

export async function readTargetedLearners(
  db: D1Database,
  assignmentId: string,
): Promise<TargetedLearnerRow[]> {
  const explicit = await db
    .prepare(
      "SELECT learners.id AS learner_id, learners.tenant_id, learners.display_name, learners.email, 'explicit' AS target_source FROM assignment_learner_targets targets INNER JOIN harbor_learners learners ON learners.id = targets.learner_id WHERE targets.assignment_id = ?",
    )
    .bind(assignmentId)
    .all<TargetedLearnerRow>();
  const section = await db
    .prepare(
      "SELECT DISTINCT learners.id AS learner_id, learners.tenant_id, learners.display_name, learners.email, 'section' AS target_source FROM assignment_section_targets targets INNER JOIN section_memberships memberships ON memberships.section_id = targets.section_id AND memberships.status = ? INNER JOIN harbor_learners learners ON learners.id = memberships.learner_id WHERE targets.assignment_id = ?",
    )
    .bind("active", assignmentId)
    .all<TargetedLearnerRow>();

  const learnerMap = new Map<string, TargetedLearnerRow>();
  for (const row of section.results) {
    learnerMap.set(row.learner_id, row);
  }
  for (const row of explicit.results) {
    learnerMap.set(row.learner_id, row);
  }

  return [...learnerMap.values()].sort((left, right) =>
    left.display_name.localeCompare(right.display_name),
  );
}

export async function readAssignmentAttempts(
  db: D1Database,
  assignmentId: string,
  learnerIds: string[],
): Promise<AttemptRow[]> {
  if (learnerIds.length === 0) {
    return [];
  }

  const rows = await db
    .prepare(
      `SELECT id AS attempt_id, actor_id AS learner_id, assessment_version_id, created_at
       FROM attempt_entries
       WHERE assignment_id = ?
         AND actor_kind = ?
         AND actor_id IN (${learnerIds.map(() => "?").join(", ")})
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(assignmentId, "student-learner", ...learnerIds)
    .all<AttemptRow>();

  return rows.results;
}

export async function readAttemptResultsByAttempt(
  db: D1Database,
  attemptIds: string[],
): Promise<Map<string, AttemptResultRow>> {
  if (attemptIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT id AS attempt_result_id, attempt_id, status, total_score, max_score, submitted_at, finalized_at,
       EXISTS (SELECT 1 FROM json_each(attempt_results.test_outcome_variables_json) WHERE json_extract(value, '$.identifier') = 'HARBOR_SEQUENCE_TARGET') AS is_sequenced
       FROM attempt_results
       WHERE attempt_id IN (${attemptIds.map(() => "?").join(", ")})`,
    )
    .bind(...attemptIds)
    .all<AttemptResultRow>();

  return new Map(rows.results.map((row) => [row.attempt_id, row]));
}

export async function readLatestFinalizationsByAttempt(
  db: D1Database,
  attemptIds: string[],
): Promise<Map<string, ResultFinalizationRow>> {
  if (attemptIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT attempt_id, status, error_message, updated_at, submitted_at
       FROM result_finalizations
       WHERE attempt_id IN (${attemptIds.map(() => "?").join(", ")})
       ORDER BY submitted_at DESC, id DESC`,
    )
    .bind(...attemptIds)
    .all<ResultFinalizationRow>();

  const latest = new Map<string, ResultFinalizationRow>();
  for (const row of rows.results) {
    if (!latest.has(row.attempt_id)) {
      latest.set(row.attempt_id, row);
    }
  }

  return latest;
}

export async function readOverridesByLearner(
  db: D1Database,
  assignmentId: string,
  learnerIds: string[],
): Promise<Map<string, AssignmentLearnerOverrideRecord>> {
  if (learnerIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT id, assignment_id, learner_id, policy_overrides_json, accommodations_json, created_by_role, created_by_id, created_by_display_name, updated_by_role, updated_by_id, updated_by_display_name, created_at, updated_at
       FROM assignment_learner_overrides
       WHERE assignment_id = ?
         AND learner_id IN (${learnerIds.map(() => "?").join(", ")})`,
    )
    .bind(assignmentId, ...learnerIds)
    .all<OverrideRow>();

  return new Map(rows.results.map((row) => [row.learner_id, mapOverrideRow(row)]));
}

export async function readLiveAttemptStatuses(
  coordinator: DurableObjectNamespace,
  attemptIds: string[],
): Promise<Map<string, InstructorRosterAttemptProjection["status"]>> {
  const statuses = new Map<string, InstructorRosterAttemptProjection["status"]>();
  await Promise.all(
    attemptIds.map(async (attemptId) => {
      const stub = coordinator.get(coordinator.idFromName(attemptId));
      const response = await stub.fetch("https://harbor-attempt.local/session", {
        method: "GET",
        headers: {
          "x-harbor-attempt-id": attemptId,
        },
      });
      if (!response.ok) {
        statuses.set(attemptId, "active");
        return;
      }
      const payload = await response.json<{
        attemptStatus: InstructorRosterAttemptProjection["status"];
      }>();
      statuses.set(attemptId, payload.attemptStatus);
    }),
  );

  return statuses;
}

export function buildRosterAttemptProjection(
  attempt: AttemptRow | null,
  finalization: ResultFinalizationRow | null,
  liveStatus: InstructorRosterAttemptProjection["status"] | undefined,
): InstructorRosterAttemptProjection {
  if (!attempt) {
    return {
      attemptId: "",
      status: "not-started",
      launchedAt: null,
      submittedAt: null,
    };
  }

  return {
    attemptId: attempt.attempt_id,
    status: finalization ? "submitted" : (liveStatus ?? "active"),
    launchedAt: attempt.created_at,
    submittedAt: finalization?.submitted_at ?? null,
  };
}

export async function requireTargetedLearner(input: {
  db: D1Database;
  assignmentId: string;
  learnerId: string;
}): Promise<void> {
  const explicit = await input.db
    .prepare(
      "SELECT 1 AS matched FROM assignment_learner_targets WHERE assignment_id = ? AND learner_id = ? LIMIT 1",
    )
    .bind(input.assignmentId, input.learnerId)
    .first<{ matched: number }>();
  if (explicit?.matched === 1) {
    return;
  }

  const section = await input.db
    .prepare(
      "SELECT 1 AS matched FROM assignment_section_targets targets INNER JOIN section_memberships memberships ON memberships.section_id = targets.section_id WHERE targets.assignment_id = ? AND memberships.learner_id = ? AND memberships.status = ? LIMIT 1",
    )
    .bind(input.assignmentId, input.learnerId, "active")
    .first<{ matched: number }>();
  if (section?.matched === 1) {
    return;
  }

  throw new LaunchRequestError(403, "Learner is not targeted for the requested assignment");
}

export async function requireLearnerExists(db: D1Database, learnerId: string): Promise<void> {
  await requireLearnerRecord(db, learnerId);
}
