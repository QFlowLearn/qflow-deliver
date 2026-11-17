import {
  createEmptyAttemptPolicyState,
  type AssignmentLearnerOverrideRecord,
  type AssignmentRecord,
  type AssignmentStatus,
  type InstructorAssignmentResultsResponse,
  type InstructorAssignmentResultsSummary,
  type InstructorAssignmentRosterResponse,
  type UpsertAssignmentLearnerOverrideRequest,
  type UpdateAssignmentRequest,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../../launch/create-preview-attempt";
import { readLatestScoreRevisionsByResultId } from "../../../results/score-amendments";
import { persistAssignment, readAssignment } from "../../assignments";
import { createId } from "./json-parsers";
import {
  applyAssignmentLearnerPolicyOverrides,
  readAssignmentLearnerOverride,
} from "./policy-overrides";
import {
  buildRosterAttemptProjection,
  readAssignmentAttempts,
  readAttemptResultsByAttempt,
  readLatestFinalizationsByAttempt,
  readLiveAttemptStatuses,
  readOverridesByLearner,
  readTargetedLearners,
  requireLearnerExists,
  requireTargetedLearner,
} from "./roster-data";
import type { AttemptRow } from "./types";

export async function updateAssignment(input: {
  db: D1Database;
  assignmentId: string;
  request: UpdateAssignmentRequest;
  allowUnsafeSafeExamBrowserUserAgentFallback?: boolean;
}): Promise<AssignmentRecord> {
  const existing = await readAssignment(input.db, input.assignmentId);
  return persistAssignment({
    db: input.db,
    mode: "upsert",
    allowUnsafeSafeExamBrowserUserAgentFallback: input.allowUnsafeSafeExamBrowserUserAgentFallback,
    request: {
      assignmentId: existing.id,
      assessmentId: existing.assessmentId,
      assessmentVersionId: existing.assessmentVersionId,
      title: input.request.title,
      status: input.request.status ?? existing.status,
      actor: input.request.actor,
      policySnapshot: input.request.policySnapshot,
      targets: input.request.targets ?? existing.targets,
      ltiLinkages: input.request.ltiLinkages ?? existing.ltiLinkages,
    },
  });
}

export async function updateAssignmentStatus(input: {
  db: D1Database;
  assignmentId: string;
  status: AssignmentStatus;
  allowUnsafeSafeExamBrowserUserAgentFallback?: boolean;
}): Promise<AssignmentRecord> {
  const existing = await readAssignment(input.db, input.assignmentId);
  return persistAssignment({
    db: input.db,
    mode: "upsert",
    allowUnsafeSafeExamBrowserUserAgentFallback: input.allowUnsafeSafeExamBrowserUserAgentFallback,
    request: {
      assignmentId: existing.id,
      assessmentId: existing.assessmentId,
      assessmentVersionId: existing.assessmentVersionId,
      title: existing.title,
      status: input.status,
      actor: existing.createdBy,
      policySnapshot: existing.policySnapshot,
      targets: existing.targets,
      ltiLinkages: existing.ltiLinkages,
    },
  });
}

export async function upsertAssignmentLearnerOverride(input: {
  db: D1Database;
  assignmentId: string;
  learnerId: string;
  request: UpsertAssignmentLearnerOverrideRequest;
}): Promise<AssignmentLearnerOverrideRecord> {
  await readAssignment(input.db, input.assignmentId);
  await requireTargetedLearner({
    db: input.db,
    assignmentId: input.assignmentId,
    learnerId: input.learnerId,
  });
  await requireLearnerExists(input.db, input.learnerId);

  const existing = await readAssignmentLearnerOverride(
    input.db,
    input.assignmentId,
    input.learnerId,
  );
  const now = new Date().toISOString();
  const createdBy = existing?.createdBy ?? input.request.actor;

  await input.db
    .prepare(
      "INSERT INTO assignment_learner_overrides (id, assignment_id, learner_id, policy_overrides_json, accommodations_json, created_by_role, created_by_id, created_by_display_name, updated_by_role, updated_by_id, updated_by_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(assignment_id, learner_id) DO UPDATE SET policy_overrides_json = excluded.policy_overrides_json, accommodations_json = excluded.accommodations_json, updated_by_role = excluded.updated_by_role, updated_by_id = excluded.updated_by_id, updated_by_display_name = excluded.updated_by_display_name, updated_at = excluded.updated_at",
    )
    .bind(
      existing?.id ?? createId("aover"),
      input.assignmentId,
      input.learnerId,
      JSON.stringify(input.request.policyOverrides),
      JSON.stringify(
        input.request.accommodations ?? createEmptyAttemptPolicyState().accommodations,
      ),
      createdBy.role,
      createdBy.actorId,
      createdBy.displayName,
      input.request.actor.role,
      input.request.actor.actorId,
      input.request.actor.displayName,
      existing?.createdAt ?? now,
      now,
    )
    .run();

  const override = await readAssignmentLearnerOverride(
    input.db,
    input.assignmentId,
    input.learnerId,
  );
  if (!override) {
    throw new LaunchRequestError(500, "Assignment learner override was not saved");
  }

  return override;
}

export async function readInstructorAssignmentRoster(input: {
  db: D1Database;
  attemptCoordinator: DurableObjectNamespace;
  assignmentId: string;
}): Promise<InstructorAssignmentRosterResponse> {
  const assignment = await readAssignment(input.db, input.assignmentId);
  const targetedLearners = await readTargetedLearners(input.db, input.assignmentId);
  const learnerIds = targetedLearners.map((row) => row.learner_id);
  const attempts = await readAssignmentAttempts(input.db, input.assignmentId, learnerIds);
  const latestAttempts = new Map<string, AttemptRow>();
  const attemptsByLearner = new Map<string, AttemptRow[]>();

  for (const attempt of attempts) {
    if (!latestAttempts.has(attempt.learner_id)) {
      latestAttempts.set(attempt.learner_id, attempt);
    }
    const bucket = attemptsByLearner.get(attempt.learner_id) ?? [];
    bucket.push(attempt);
    attemptsByLearner.set(attempt.learner_id, bucket);
  }

  const latestAttemptIds = [...latestAttempts.values()].map((attempt) => attempt.attempt_id);
  const resultByAttempt = await readAttemptResultsByAttempt(input.db, latestAttemptIds);
  const revisionByResultId = await readLatestScoreRevisionsByResultId(
    input.db,
    [...resultByAttempt.values()].map((result) => result.attempt_result_id),
  );
  const finalizationByAttempt = await readLatestFinalizationsByAttempt(input.db, latestAttemptIds);
  const overrideByLearner = await readOverridesByLearner(input.db, input.assignmentId, learnerIds);
  const liveStatuses = await readLiveAttemptStatuses(
    input.attemptCoordinator,
    latestAttemptIds.filter((attemptId) => !finalizationByAttempt.has(attemptId)),
  );

  const rows = targetedLearners.map((learner) => {
    const latestAttempt = latestAttempts.get(learner.learner_id) ?? null;
    const latestResult = latestAttempt
      ? (resultByAttempt.get(latestAttempt.attempt_id) ?? null)
      : null;
    const latestFinalization = latestAttempt
      ? (finalizationByAttempt.get(latestAttempt.attempt_id) ?? null)
      : null;
    const effectivePolicy = applyAssignmentLearnerPolicyOverrides(
      assignment.policySnapshot,
      overrideByLearner.get(learner.learner_id)?.policyOverrides ?? {},
    );

    return {
      learner: {
        id: learner.learner_id,
        tenantId: learner.tenant_id,
        displayName: learner.display_name,
        email: learner.email,
        createdAt: "",
        updatedAt: "",
      },
      targetSource: learner.target_source,
      attemptCount: attemptsByLearner.get(learner.learner_id)?.length ?? 0,
      remainingAttempts: Math.max(
        effectivePolicy.maxAttempts - (attemptsByLearner.get(learner.learner_id)?.length ?? 0),
        0,
      ),
      latestAttempt: buildRosterAttemptProjection(
        latestAttempt,
        latestFinalization,
        liveStatuses.get(latestAttempt?.attempt_id ?? ""),
      ),
      latestResultStatus: latestResult?.status ?? latestFinalization?.status ?? null,
      latestScore: latestResult
        ? {
            totalScore: latestResult.total_score,
            maxScore: latestResult.max_score,
          }
        : null,
      latestFinalization: latestFinalization
        ? {
            status: latestFinalization.status,
            errorMessage: latestFinalization.error_message,
            updatedAt: latestFinalization.updated_at,
          }
        : null,
      latestScoreRevision: latestResult
        ? (revisionByResultId.get(latestResult.attempt_result_id) ?? null)
        : null,
      activeOverride: overrideByLearner.get(learner.learner_id) ?? null,
    };
  });

  return {
    assignment,
    rows,
  };
}

export async function readInstructorAssignmentResults(input: {
  db: D1Database;
  attemptCoordinator: DurableObjectNamespace;
  assignmentId: string;
}): Promise<InstructorAssignmentResultsResponse> {
  const roster = await readInstructorAssignmentRoster(input);
  const summary = roster.rows.reduce<InstructorAssignmentResultsSummary>(
    (state, row) => {
      state.targetedLearnerCount += 1;
      if (row.latestAttempt.status === "not-started") {
        state.notStartedCount += 1;
        return state;
      }

      if (row.latestResultStatus === "pending") {
        state.pendingCount += 1;
        return state;
      }

      if (row.latestResultStatus === "complete") {
        state.completeCount += 1;
        return state;
      }

      if (row.latestResultStatus === "failed") {
        state.failedCount += 1;
        return state;
      }

      if (row.latestResultStatus === "rescored") {
        state.rescoredCount += 1;
        return state;
      }

      state.inProgressCount += 1;
      return state;
    },
    {
      targetedLearnerCount: 0,
      notStartedCount: 0,
      inProgressCount: 0,
      pendingCount: 0,
      completeCount: 0,
      failedCount: 0,
      rescoredCount: 0,
    },
  );

  return {
    assignment: roster.assignment,
    summary,
    rows: roster.rows.map((row) => ({
      learner: row.learner,
      latestAttemptId:
        row.latestAttempt.status === "not-started" ? null : row.latestAttempt.attemptId,
      latestResultStatus: row.latestResultStatus,
      latestScore: row.latestScore,
      latestFinalization: row.latestFinalization,
      latestScoreRevision: row.latestScoreRevision,
    })),
  };
}
