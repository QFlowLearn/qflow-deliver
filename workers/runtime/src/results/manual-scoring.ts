import type {
  AssignmentActorSnapshot,
  AssignmentStatus,
  AttemptResultStatus,
  AttemptVariableSnapshot,
  FinalizeManualScoringRequest,
  FinalizeManualScoringResponse,
  ManualScoringAttemptResponse,
  ManualScoringEntrySnapshot,
  ManualScoringEntryStatus,
  ManualScoringQueueResponse,
  SaveManualScoreRequest,
  SaveManualScoreResponse,
} from "@harbor/attempt-protocol";
import {
  HARBOR_MANUAL_FEEDBACK_OUTCOME_IDENTIFIER,
  HARBOR_MANUAL_SCORING_COMPLETE_STATUS,
  HARBOR_SCORING_STATUS_OUTCOME_IDENTIFIER,
  hasPendingManualScoringOutcome,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../launch/create-preview-attempt";
import { buildPendingLtiOutcomeDeliveryIntentStatement } from "../lti/outcomes";
import {
  buildInitialResultExportIntentStatement,
  type ResultExportProducerEnv,
} from "../queues/result-export";
import { scheduleManualFinalizationSideEffects } from "./manual-scoring-side-effects";
import { applyActiveScoreAmendmentsForAttemptResult } from "./score-amendments";

interface ManualScoringEnv extends ResultExportProducerEnv {
  HARBOR_DB: D1Database;
  LTI_STATE_SECRET?: string;
  LTI_TOOL_PRIVATE_KEY_JWK?: string;
}

interface ManualQueueRow {
  attempt_id: string;
  attempt_result_id: string;
  assignment_id: string | null;
  assignment_title: string | null;
  assessment_version_id: string;
  assessment_title: string;
  submitted_at: string;
  learner_id: string | null;
  learner_tenant_id: string | null;
  learner_display_name: string | null;
  learner_email: string | null;
  learner_created_at: string | null;
  learner_updated_at: string | null;
  pending_item_count: number;
  scored_item_count: number;
  latest_reviewer_role: AssignmentActorSnapshot["role"] | null;
  latest_reviewer_id: string | null;
  latest_reviewer_display_name: string | null;
  latest_updated_at: string | null;
}

interface ManualQueueCandidateRow {
  attempt_id: string;
  attempt_result_id: string;
  assignment_id: string | null;
  assignment_title: string | null;
  assessment_version_id: string;
  assessment_title: string;
  submitted_at: string;
  learner_id: string | null;
  learner_tenant_id: string | null;
  learner_display_name: string | null;
  learner_email: string | null;
  learner_created_at: string | null;
  learner_updated_at: string | null;
  outcome_variables_json: string;
  manual_score_id: string | null;
  latest_reviewer_role: AssignmentActorSnapshot["role"] | null;
  latest_reviewer_id: string | null;
  latest_reviewer_display_name: string | null;
  latest_updated_at: string | null;
}

interface ManualAttemptRow {
  attempt_id: string;
  attempt_result_id: string;
  result_finalization_id: string;
  assignment_id: string | null;
  assessment_version_id: string;
  assessment_title: string;
  result_status: AttemptResultStatus;
  source_receipt_id: string;
  submitted_at: string;
  finalized_at: string;
  total_score: number | null;
  max_score: number | null;
  test_outcome_variables_json: string;
  learner_id: string | null;
  learner_tenant_id: string | null;
  learner_display_name: string | null;
  learner_email: string | null;
  learner_created_at: string | null;
  learner_updated_at: string | null;
  assignment_title: string | null;
  assignment_status: string | null;
  assignment_policy_snapshot_json: string | null;
  assignment_created_by_role: AssignmentActorSnapshot["role"] | null;
  assignment_created_by_id: string | null;
  assignment_created_by_display_name: string | null;
  assignment_created_at: string | null;
  assignment_updated_at: string | null;
}

interface ManualAttemptItemRow {
  attempt_result_item_id: string;
  item_id: string;
  item_identifier: string | null;
  item_title: string | null;
  item_position: number | null;
  answered: number;
  response_summary_text: string | null;
  response_variables_json: string;
  outcome_variables_json: string;
  score: number | null;
  max_score: number | null;
}

interface ManualScoreEntryRow {
  id: string;
  attempt_result_item_id: string;
  item_id: string;
  status: ManualScoringEntryStatus;
  score: number;
  max_score: number;
  student_feedback: string | null;
  private_note: string | null;
  scored_by_role: AssignmentActorSnapshot["role"];
  scored_by_id: string;
  scored_by_display_name: string | null;
  scored_at: string;
  released_at: string | null;
  updated_at: string;
}

interface FinalizedAttemptResultRow {
  status: AttemptResultStatus;
  total_score: number | null;
  max_score: number | null;
  finalized_at: string;
}

export async function readManualScoringQueue(input: {
  db: D1Database;
  tenantId: string;
  assignmentId?: string | null;
}): Promise<ManualScoringQueueResponse> {
  const bindings: string[] = [input.tenantId];
  const filters = ["assessments.tenant_id = ?", "results.status = 'pending'"];
  if (input.assignmentId) {
    filters.push("results.assignment_id = ?");
    bindings.push(input.assignmentId);
  }

  const rows = await input.db
    .prepare(
      `SELECT results.attempt_id,
              results.id AS attempt_result_id,
              results.assignment_id,
              assignments.title AS assignment_title,
              results.assessment_version_id,
              assessments.title AS assessment_title,
              results.submitted_at,
              learners.id AS learner_id,
              learners.tenant_id AS learner_tenant_id,
              learners.display_name AS learner_display_name,
              learners.email AS learner_email,
              learners.created_at AS learner_created_at,
              learners.updated_at AS learner_updated_at,
              result_items.outcome_variables_json,
              manual_scores.id AS manual_score_id,
              latest_manual.scored_by_role AS latest_reviewer_role,
              latest_manual.scored_by_id AS latest_reviewer_id,
              latest_manual.scored_by_display_name AS latest_reviewer_display_name,
              latest_manual.updated_at AS latest_updated_at
         FROM attempt_results results
         INNER JOIN assessment_versions versions
           ON versions.id = results.assessment_version_id
         INNER JOIN assessments
           ON assessments.id = versions.assessment_id
         INNER JOIN attempt_result_items result_items
           ON result_items.attempt_result_id = results.id
         INNER JOIN attempt_entries attempts
           ON attempts.id = results.attempt_id
         LEFT JOIN assignments
           ON assignments.id = results.assignment_id
         LEFT JOIN harbor_learners learners
           ON learners.id = attempts.actor_id
          AND attempts.actor_kind = 'student-learner'
         LEFT JOIN manual_score_entries manual_scores
           ON manual_scores.attempt_result_item_id = result_items.id
         LEFT JOIN manual_score_entries latest_manual
           ON latest_manual.id = (
             SELECT latest.id
               FROM manual_score_entries latest
              WHERE latest.attempt_result_id = results.id
              ORDER BY latest.updated_at DESC, latest.id DESC
              LIMIT 1
           )
        WHERE ${filters.join(" AND ")}
        ORDER BY COALESCE(latest_manual.updated_at, results.submitted_at) DESC,
                 results.submitted_at DESC,
                 COALESCE(result_items.item_position, 0) ASC,
                 result_items.id ASC`,
    )
    .bind(...bindings)
    .all<ManualQueueCandidateRow>();

  const queueRows = groupManualQueueRows(
    rows.results.filter((row) =>
      hasPendingManualScoringOutcome(parseVariables(row.outcome_variables_json)),
    ),
  );

  return {
    generatedAt: new Date().toISOString(),
    rows: queueRows.map((row) => {
      return {
        attemptId: row.attempt_id,
        attemptResultId: row.attempt_result_id,
        assignmentId: row.assignment_id,
        assignmentTitle: row.assignment_title,
        assessmentVersionId: row.assessment_version_id,
        assessmentTitle: row.assessment_title,
        learner: row.learner_id
          ? {
              id: row.learner_id,
              tenantId: row.learner_tenant_id ?? "",
              displayName: row.learner_display_name ?? row.learner_id,
              email: row.learner_email,
              createdAt: row.learner_created_at ?? "",
              updatedAt: row.learner_updated_at ?? "",
            }
          : null,
        submittedAt: row.submitted_at,
        pendingItemCount: row.pending_item_count,
        scoredItemCount: row.scored_item_count,
        latestReviewer:
          row.latest_reviewer_role && row.latest_reviewer_id
            ? {
                role: row.latest_reviewer_role,
                actorId: row.latest_reviewer_id,
                displayName: row.latest_reviewer_display_name,
              }
            : null,
        latestUpdatedAt: row.latest_updated_at,
        status:
          row.scored_item_count === 0
            ? "needs-review"
            : row.scored_item_count >= row.pending_item_count
              ? "ready-to-finalize"
              : "in-progress",
      };
    }),
  };
}

function groupManualQueueRows(rows: ManualQueueCandidateRow[]): ManualQueueRow[] {
  const grouped = new Map<string, ManualQueueRow>();

  for (const row of rows) {
    const existing = grouped.get(row.attempt_result_id);
    if (existing) {
      existing.pending_item_count += 1;
      existing.scored_item_count += row.manual_score_id ? 1 : 0;
      continue;
    }

    grouped.set(row.attempt_result_id, {
      attempt_id: row.attempt_id,
      attempt_result_id: row.attempt_result_id,
      assignment_id: row.assignment_id,
      assignment_title: row.assignment_title,
      assessment_version_id: row.assessment_version_id,
      assessment_title: row.assessment_title,
      submitted_at: row.submitted_at,
      learner_id: row.learner_id,
      learner_tenant_id: row.learner_tenant_id,
      learner_display_name: row.learner_display_name,
      learner_email: row.learner_email,
      learner_created_at: row.learner_created_at,
      learner_updated_at: row.learner_updated_at,
      pending_item_count: 1,
      scored_item_count: row.manual_score_id ? 1 : 0,
      latest_reviewer_role: row.latest_reviewer_role,
      latest_reviewer_id: row.latest_reviewer_id,
      latest_reviewer_display_name: row.latest_reviewer_display_name,
      latest_updated_at: row.latest_updated_at,
    });
  }

  return [...grouped.values()];
}

export async function readManualScoringAttempt(input: {
  db: D1Database;
  attemptId: string;
}): Promise<ManualScoringAttemptResponse> {
  const context = await readManualAttemptContext(input.db, input.attemptId);
  const [items, entries] = await Promise.all([
    readManualAttemptItems(input.db, context.attempt_result_id),
    readManualScoreEntries(input.db, context.attempt_result_id),
  ]);
  const entriesByItemId = new Map(entries.map((entry) => [entry.item_id, entry]));

  return buildManualAttemptResponse({ context, items, entriesByItemId });
}

export async function saveManualScore(input: {
  db: D1Database;
  attemptId: string;
  itemId: string;
  request: SaveManualScoreRequest;
}): Promise<SaveManualScoreResponse> {
  const context = await readManualAttemptContext(input.db, input.attemptId);
  const item = await readManualAttemptItem(input.db, context.attempt_result_id, input.itemId);
  assertPendingManualItem(item);
  const request = normalizeSaveRequest(input.request);
  assertManualMaxScore(item, request.maxScore);
  const now = new Date().toISOString();
  const existing = await input.db
    .prepare("SELECT id FROM manual_score_entries WHERE attempt_result_item_id = ?")
    .bind(item.attempt_result_item_id)
    .first<{ id: string }>();
  const entryId = existing?.id ?? createId("mscore");

  await input.db.batch([
    input.db
      .prepare(
        `INSERT INTO manual_score_entries
          (id, attempt_result_id, attempt_result_item_id, attempt_id, assignment_id, assessment_version_id, item_id, status, score, max_score, student_feedback, private_note, scored_by_role, scored_by_id, scored_by_display_name, scored_at, released_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(attempt_result_item_id) DO UPDATE SET
           status = excluded.status,
           score = excluded.score,
           max_score = excluded.max_score,
           student_feedback = excluded.student_feedback,
           private_note = excluded.private_note,
           scored_by_role = excluded.scored_by_role,
           scored_by_id = excluded.scored_by_id,
           scored_by_display_name = excluded.scored_by_display_name,
           scored_at = excluded.scored_at,
           released_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(
        entryId,
        context.attempt_result_id,
        item.attempt_result_item_id,
        context.attempt_id,
        context.assignment_id,
        context.assessment_version_id,
        item.item_id,
        "draft",
        request.score,
        request.maxScore,
        request.studentFeedback,
        request.privateNote,
        request.actor.role,
        request.actor.actorId,
        request.actor.displayName ?? null,
        now,
        now,
        now,
      ),
    buildManualScoreEventStatement(input.db, {
      context,
      item,
      eventType: "draft-saved",
      score: request.score,
      maxScore: request.maxScore,
      studentFeedback: request.studentFeedback ?? null,
      privateNote: request.privateNote ?? null,
      actor: request.actor,
      now,
    }),
  ]);

  const entry = mapManualScoreEntry(await readManualScoreEntry(input.db, entryId));
  if (!entry) {
    throw new LaunchRequestError(500, "Manual score draft was not saved");
  }

  return { entry };
}

export async function finalizeManualScoring(input: {
  db: D1Database;
  env: ManualScoringEnv;
  attemptId: string;
  request: FinalizeManualScoringRequest;
}): Promise<FinalizeManualScoringResponse> {
  const context = await readManualAttemptContext(input.db, input.attemptId);
  if (context.result_status !== "pending") {
    if (context.result_status === "complete" || context.result_status === "rescored") {
      const finalizedResult = await readFinalizedAttemptResult(input.db, context.attempt_result_id);
      await scheduleManualFinalizationSideEffects({
        db: input.db,
        env: input.env,
        context,
      });
      return buildFinalizeManualScoringResponse(context, finalizedResult);
    }
    throw new LaunchRequestError(409, "Attempt result is not awaiting manual scoring");
  }

  const [items, entries] = await Promise.all([
    readManualAttemptItems(input.db, context.attempt_result_id),
    readManualScoreEntries(input.db, context.attempt_result_id),
  ]);
  const manualItems = items.filter(isPendingManualItem);
  const entriesByItemId = new Map(entries.map((entry) => [entry.item_id, entry]));
  const missing = manualItems.filter((item) => !entriesByItemId.has(item.item_id));
  if (missing.length > 0) {
    throw new LaunchRequestError(
      409,
      `Manual scoring is incomplete for ${missing.length} item${missing.length === 1 ? "" : "s"}`,
    );
  }

  const now = new Date().toISOString();
  const updatedItems = items.map((item) => {
    const entry = entriesByItemId.get(item.item_id);
    if (!entry || !isPendingManualItem(item)) {
      return {
        ...item,
        score: item.score,
        max_score: item.max_score,
        outcome_variables_json: item.outcome_variables_json,
      };
    }

    return {
      ...item,
      score: entry.score,
      max_score: entry.max_score,
      outcome_variables_json: JSON.stringify(
        finalizeOutcomeVariables(
          parseVariables(item.outcome_variables_json),
          entry.student_feedback,
        ),
      ),
    };
  });
  const totalScore = sumNullable(updatedItems.map((item) => item.score));
  const maxScore = sumNullable(updatedItems.map((item) => item.max_score));

  const batchResults = await input.db.batch([
    ...updatedItems.map((item) =>
      input.db
        .prepare(
          "UPDATE attempt_result_items SET score = ?, max_score = ?, base_score = ?, base_max_score = ?, outcome_variables_json = ? WHERE id = ?",
        )
        .bind(
          item.score,
          item.max_score,
          item.score,
          item.max_score,
          item.outcome_variables_json,
          item.attempt_result_item_id,
        ),
    ),
    input.db
      .prepare(
        "UPDATE attempt_results SET status = ?, total_score = ?, max_score = ?, passed = ?, finalized_at = ?, updated_at = ? WHERE id = ? AND status = ?",
      )
      .bind("complete", totalScore, maxScore, null, now, now, context.attempt_result_id, "pending"),
    input.db
      .prepare(
        "UPDATE manual_score_entries SET status = ?, released_at = ?, updated_at = ? WHERE attempt_result_id = ?",
      )
      .bind("released", now, now, context.attempt_result_id),
    buildManualScoreEventStatement(input.db, {
      context,
      item: null,
      eventType: "attempt-finalized",
      score: totalScore,
      maxScore,
      studentFeedback: null,
      privateNote: null,
      actor: input.request.actor,
      now,
    }),
    buildInitialResultExportIntentStatement({
      db: input.db,
      attemptId: context.attempt_id,
      attemptResultId: context.attempt_result_id,
      resultFinalizationId: context.result_finalization_id,
      assignmentId: context.assignment_id,
      assessmentVersionId: context.assessment_version_id,
      sourceReceiptId: context.source_receipt_id,
      now,
    }),
    buildPendingLtiOutcomeDeliveryIntentStatement({
      db: input.db,
      attemptId: context.attempt_id,
      attemptResultId: context.attempt_result_id,
      resultFinalizationId: context.result_finalization_id,
      totalScore,
      maxScore,
      finalizedAt: now,
      now,
    }),
  ]);
  const resultUpdate = batchResults[updatedItems.length];
  if (resultUpdate.meta.changes !== 1) {
    throw new LaunchRequestError(409, "Attempt result is not awaiting manual scoring");
  }

  await applyActiveScoreAmendmentsForAttemptResult({
    db: input.db,
    attemptResultId: context.attempt_result_id,
  });
  const finalizedResult = await readFinalizedAttemptResult(input.db, context.attempt_result_id);

  await scheduleManualFinalizationSideEffects({
    db: input.db,
    env: input.env,
    context,
  });

  return buildFinalizeManualScoringResponse(context, finalizedResult);
}

function buildFinalizeManualScoringResponse(
  context: ManualAttemptRow,
  finalizedResult: FinalizedAttemptResultRow,
): FinalizeManualScoringResponse {
  return {
    attemptResultId: context.attempt_result_id,
    attemptId: context.attempt_id,
    status: finalizedResult.status,
    totalScore: finalizedResult.total_score,
    maxScore: finalizedResult.max_score,
    finalizedAt: finalizedResult.finalized_at,
  };
}

async function readFinalizedAttemptResult(
  db: D1Database,
  attemptResultId: string,
): Promise<FinalizedAttemptResultRow> {
  const row = await db
    .prepare(
      "SELECT status, total_score, max_score, finalized_at FROM attempt_results WHERE id = ?",
    )
    .bind(attemptResultId)
    .first<FinalizedAttemptResultRow>();
  if (!row) {
    throw new LaunchRequestError(500, "Manual scoring result was not finalized");
  }

  return row;
}

function buildManualAttemptResponse(input: {
  context: ManualAttemptRow;
  items: ManualAttemptItemRow[];
  entriesByItemId: Map<string, ManualScoreEntryRow>;
}): ManualScoringAttemptResponse {
  const pendingItems = input.items.filter(isPendingManualItem);
  const canFinalize =
    input.context.result_status === "pending" &&
    pendingItems.length > 0 &&
    pendingItems.every((item) => input.entriesByItemId.has(item.item_id));

  return {
    attemptId: input.context.attempt_id,
    attemptResultId: input.context.attempt_result_id,
    assignment:
      input.context.assignment_id &&
      input.context.assignment_title &&
      input.context.assignment_status &&
      input.context.assignment_policy_snapshot_json
        ? {
            id: input.context.assignment_id,
            title: input.context.assignment_title,
            status: input.context.assignment_status as AssignmentStatus,
          }
        : null,
    assessment: {
      assessmentVersionId: input.context.assessment_version_id,
      title: input.context.assessment_title,
    },
    learner: input.context.learner_id
      ? {
          id: input.context.learner_id,
          tenantId: input.context.learner_tenant_id ?? "",
          displayName: input.context.learner_display_name ?? input.context.learner_id,
          email: input.context.learner_email,
          createdAt: input.context.learner_created_at ?? "",
          updatedAt: input.context.learner_updated_at ?? "",
        }
      : null,
    resultStatus: input.context.result_status,
    submittedAt: input.context.submitted_at,
    finalizedAt: input.context.finalized_at,
    items: input.items.map((item) => ({
      attemptResultItemId: item.attempt_result_item_id,
      itemId: item.item_id,
      itemIdentifier: item.item_identifier,
      itemTitle: item.item_title,
      itemPosition: item.item_position,
      answered: item.answered === 1,
      responseSummary: item.response_summary_text,
      responseVariables: parseVariables(item.response_variables_json),
      outcomeVariables: parseVariables(item.outcome_variables_json),
      authoredMaxScore: item.max_score,
      pendingManualScoring: isPendingManualItem(item),
      manualScore: mapManualScoreEntry(input.entriesByItemId.get(item.item_id)),
    })),
    canFinalize,
    generatedAt: new Date().toISOString(),
  };
}

async function readManualAttemptContext(
  db: D1Database,
  attemptId: string,
): Promise<ManualAttemptRow> {
  const row = await db
    .prepare(
      `SELECT attempts.id AS attempt_id,
              results.id AS attempt_result_id,
              results.result_finalization_id,
              results.assignment_id,
              results.assessment_version_id,
              assessments.title AS assessment_title,
              results.status AS result_status,
              results.source_receipt_id,
              results.submitted_at,
              results.finalized_at,
              results.total_score,
              results.max_score,
              results.test_outcome_variables_json,
              learners.id AS learner_id,
              learners.tenant_id AS learner_tenant_id,
              learners.display_name AS learner_display_name,
              learners.email AS learner_email,
              learners.created_at AS learner_created_at,
              learners.updated_at AS learner_updated_at,
              assignments.title AS assignment_title,
              assignments.status AS assignment_status,
              assignments.policy_snapshot_json AS assignment_policy_snapshot_json,
              assignments.created_by_role AS assignment_created_by_role,
              assignments.created_by_id AS assignment_created_by_id,
              assignments.created_by_display_name AS assignment_created_by_display_name,
              assignments.created_at AS assignment_created_at,
              assignments.updated_at AS assignment_updated_at
         FROM attempt_results results
         INNER JOIN attempt_entries attempts
           ON attempts.id = results.attempt_id
         INNER JOIN assessment_versions versions
           ON versions.id = results.assessment_version_id
         INNER JOIN assessments
           ON assessments.id = versions.assessment_id
         LEFT JOIN assignments
           ON assignments.id = results.assignment_id
         LEFT JOIN harbor_learners learners
           ON learners.id = attempts.actor_id
          AND attempts.actor_kind = 'student-learner'
        WHERE attempts.id = ?`,
    )
    .bind(attemptId)
    .first<ManualAttemptRow>();

  if (!row) {
    throw new LaunchRequestError(404, "Attempt result not found");
  }
  return row;
}

async function readManualAttemptItems(
  db: D1Database,
  attemptResultId: string,
): Promise<ManualAttemptItemRow[]> {
  const rows = await db
    .prepare(
      `SELECT id AS attempt_result_item_id,
              item_id,
              item_identifier,
              item_title,
              item_position,
              answered,
              response_summary_text,
              response_variables_json,
              outcome_variables_json,
              score,
              max_score
         FROM attempt_result_items
        WHERE attempt_result_id = ?
        ORDER BY item_position ASC, created_at ASC, id ASC`,
    )
    .bind(attemptResultId)
    .all<ManualAttemptItemRow>();
  return rows.results;
}

async function readManualAttemptItem(
  db: D1Database,
  attemptResultId: string,
  itemId: string,
): Promise<ManualAttemptItemRow> {
  const row = await db
    .prepare(
      `SELECT id AS attempt_result_item_id,
              item_id,
              item_identifier,
              item_title,
              item_position,
              answered,
              response_summary_text,
              response_variables_json,
              outcome_variables_json,
              score,
              max_score
         FROM attempt_result_items
        WHERE attempt_result_id = ?
          AND item_id = ?`,
    )
    .bind(attemptResultId, itemId)
    .first<ManualAttemptItemRow>();
  if (!row) {
    throw new LaunchRequestError(404, "Manual scoring item not found");
  }
  return row;
}

async function readManualScoreEntries(
  db: D1Database,
  attemptResultId: string,
): Promise<ManualScoreEntryRow[]> {
  const rows = await db
    .prepare(
      `SELECT id,
              attempt_result_item_id,
              item_id,
              status,
              score,
              max_score,
              student_feedback,
              private_note,
              scored_by_role,
              scored_by_id,
              scored_by_display_name,
              scored_at,
              released_at,
              updated_at
         FROM manual_score_entries
        WHERE attempt_result_id = ?`,
    )
    .bind(attemptResultId)
    .all<ManualScoreEntryRow>();
  return rows.results;
}

async function readManualScoreEntry(
  db: D1Database,
  entryId: string,
): Promise<ManualScoreEntryRow | null> {
  return db
    .prepare(
      `SELECT id,
              attempt_result_item_id,
              item_id,
              status,
              score,
              max_score,
              student_feedback,
              private_note,
              scored_by_role,
              scored_by_id,
              scored_by_display_name,
              scored_at,
              released_at,
              updated_at
         FROM manual_score_entries
        WHERE id = ?`,
    )
    .bind(entryId)
    .first<ManualScoreEntryRow>();
}

function normalizeSaveRequest(request: SaveManualScoreRequest): SaveManualScoreRequest {
  const score = readFiniteNumber(request.score, "score");
  const maxScore = readFiniteNumber(request.maxScore, "maxScore");
  if (maxScore <= 0) {
    throw new LaunchRequestError(400, "maxScore must be greater than zero");
  }
  if (score < 0) {
    throw new LaunchRequestError(400, "score must be greater than or equal to zero");
  }
  if (score > maxScore) {
    throw new LaunchRequestError(400, "score cannot be greater than maxScore");
  }
  if (!request.actor?.role || !request.actor.actorId) {
    throw new LaunchRequestError(400, "actor is required");
  }
  return {
    actor: request.actor,
    score,
    maxScore,
    studentFeedback: normalizeOptionalText(request.studentFeedback),
    privateNote: normalizeOptionalText(request.privateNote),
  };
}

function assertManualMaxScore(item: ManualAttemptItemRow, maxScore: number): void {
  if (item.max_score !== null && maxScore > item.max_score) {
    throw new LaunchRequestError(
      400,
      "maxScore cannot exceed the authored max score for this item",
    );
  }
}

function buildManualScoreEventStatement(
  db: D1Database,
  input: {
    context: ManualAttemptRow;
    item: ManualAttemptItemRow | null;
    eventType: "draft-saved" | "attempt-finalized";
    score: number | null;
    maxScore: number | null;
    studentFeedback: string | null;
    privateNote: string | null;
    actor: AssignmentActorSnapshot;
    now: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO manual_score_events (id, attempt_result_id, attempt_result_item_id, attempt_id, assignment_id, assessment_version_id, item_id, event_type, score, max_score, student_feedback, private_note, actor_role, actor_id, actor_display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      createId("mscevt"),
      input.context.attempt_result_id,
      input.item?.attempt_result_item_id ?? null,
      input.context.attempt_id,
      input.context.assignment_id,
      input.context.assessment_version_id,
      input.item?.item_id ?? null,
      input.eventType,
      input.score,
      input.maxScore,
      input.studentFeedback,
      input.privateNote,
      input.actor.role,
      input.actor.actorId,
      input.actor.displayName ?? null,
      input.now,
    );
}

function readFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LaunchRequestError(400, `${label} must be a finite number`);
  }
  return value;
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertPendingManualItem(item: ManualAttemptItemRow): void {
  if (!isPendingManualItem(item)) {
    throw new LaunchRequestError(409, "Item is not awaiting manual scoring");
  }
}

function isPendingManualItem(item: ManualAttemptItemRow): boolean {
  return hasPendingManualScoringOutcome(parseVariables(item.outcome_variables_json));
}

function finalizeOutcomeVariables(
  variables: AttemptVariableSnapshot[],
  studentFeedback: string | null,
): AttemptVariableSnapshot[] {
  const next = variables.filter(
    (variable) =>
      variable.identifier !== HARBOR_SCORING_STATUS_OUTCOME_IDENTIFIER &&
      variable.identifier !== HARBOR_MANUAL_FEEDBACK_OUTCOME_IDENTIFIER,
  );
  next.push({
    identifier: HARBOR_SCORING_STATUS_OUTCOME_IDENTIFIER,
    value: HARBOR_MANUAL_SCORING_COMPLETE_STATUS,
  });
  if (studentFeedback) {
    next.push({
      identifier: HARBOR_MANUAL_FEEDBACK_OUTCOME_IDENTIFIER,
      value: studentFeedback,
    });
  }
  return next;
}

function parseVariables(value: string): AttemptVariableSnapshot[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry) => {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { identifier?: unknown }).identifier === "string"
      ) {
        return [
          {
            identifier: (entry as { identifier: string }).identifier,
            value: (entry as { value?: unknown }).value,
          },
        ];
      }
      return [];
    });
  } catch {
    return [];
  }
}

function mapManualScoreEntry(
  entry: ManualScoreEntryRow | null | undefined,
): ManualScoringEntrySnapshot | null {
  if (!entry) {
    return null;
  }
  return {
    id: entry.id,
    attemptResultItemId: entry.attempt_result_item_id,
    itemId: entry.item_id,
    status: entry.status,
    score: entry.score,
    maxScore: entry.max_score,
    studentFeedback: entry.student_feedback,
    privateNote: entry.private_note,
    scoredBy: {
      role: entry.scored_by_role,
      actorId: entry.scored_by_id,
      displayName: entry.scored_by_display_name,
    },
    scoredAt: entry.scored_at,
    releasedAt: entry.released_at,
    updatedAt: entry.updated_at,
  };
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
