import {
  SCORE_AMENDMENT_ACTIONS,
  type AssignmentActorSnapshot,
  type CreateScoreAmendmentRequest,
  type CreateScoreAmendmentResponse,
  type DeactivateScoreAmendmentRequest,
  type DeactivateScoreAmendmentResponse,
  type ScoreAmendmentEvidenceExportResponse,
  type ScoreAmendmentPreviewResponse,
  type ScoreAmendmentAction,
  type ScoreAmendmentRecord,
  type ScoreAmendmentsResponse,
  type ScoreAmendmentStatus,
  type ScoreRevisionSnapshot,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../launch/create-preview-attempt";
import {
  requeueCompletedResultExportsForAttemptResult,
  type ResultExportProducerEnv,
} from "../queues/result-export";
import { buildCsv, formatCsvNumber } from "../reports/csv";
import { SCORE_AMENDMENT_EVIDENCE_CSV_HEADERS } from "../reports/instructor-report-exports";

interface AssignmentRow {
  id: string;
  assessment_version_id: string;
}

interface ScoreAmendmentRow {
  id: string;
  assignment_id: string;
  assessment_version_id: string;
  item_id: string;
  action: ScoreAmendmentAction;
  response_match_text: string | null;
  reason: string;
  status: ScoreAmendmentStatus;
  created_by_role: AssignmentActorSnapshot["role"];
  created_by_id: string;
  created_by_display_name: string | null;
  superseded_by_id: string | null;
  superseded_at: string | null;
  deactivated_by_role: AssignmentActorSnapshot["role"] | null;
  deactivated_by_id: string | null;
  deactivated_by_display_name: string | null;
  deactivated_reason: string | null;
  deactivated_at: string | null;
  applied_attempt_count: number | null;
  created_at: string;
  updated_at: string;
}

interface AttemptResultRow {
  id: string;
  attempt_id: string;
  assignment_id: string | null;
  total_score: number | null;
  max_score: number | null;
  test_outcome_variables_json: string;
}

interface AttemptResultItemRow {
  id: string;
  item_id: string;
  answered: number;
  response_summary_text: string | null;
  score: number | null;
  max_score: number | null;
  base_score: number | null;
  base_max_score: number | null;
  outcome_variables_json: string;
  score_amended: number;
  score_amendment_ids_json: string;
}

interface AppliedItemProjection {
  item: AttemptResultItemRow;
  amendment: ScoreAmendmentRow;
  responseEvidence: ResponseEvidenceRow | null;
  baseScore: number | null;
  baseMaxScore: number | null;
  amendedScore: number | null;
  amendedMaxScore: number | null;
  nextScoreAmended: boolean;
  nextAmendmentIds: string[];
}

interface ProjectedItemProjection {
  item: AttemptResultItemRow;
  score: number | null;
  maxScore: number | null;
}

interface ScoreAmendmentResultProjection {
  projectedItems: ProjectedItemProjection[];
  appliedItems: AppliedItemProjection[];
  amendedTotalScore: number | null;
  amendedMaxScore: number | null;
}

interface ScoreAmendmentApplyResult {
  appliedAttemptCount: number;
  revisionCount: number;
}

interface ScoreRevisionRow {
  id: string;
  attempt_result_id: string;
  attempt_id: string;
  assignment_id: string | null;
  revision_number: number;
  amendment_ids_json: string;
  previous_total_score: number | null;
  previous_max_score: number | null;
  amended_total_score: number | null;
  amended_max_score: number | null;
  reason: string;
  created_by_role: AssignmentActorSnapshot["role"];
  created_by_id: string;
  created_by_display_name: string | null;
  created_at: string;
}

interface ScoreRevisionApplicationRow {
  score_revision_id: string;
  amendment_id: string;
  attempt_id: string;
  item_id: string;
  response_summary_text: string | null;
  response_evidence_event_id: string | null;
  response_evidence_sequence_number: number | null;
  response_evidence_server_timestamp: string | null;
  base_score: number | null;
  base_max_score: number | null;
  previous_score: number | null;
  previous_max_score: number | null;
  amended_score: number | null;
  amended_max_score: number | null;
  applied_at: string;
}

interface ResponseEvidenceRow {
  id: string;
  attempt_id: string;
  item_id: string;
  sequence_number: number | null;
  server_timestamp: string | null;
}

const SYSTEM_RESCORE_ACTOR: AssignmentActorSnapshot = {
  role: "system",
  actorId: "score-amendments",
  displayName: "QFlowLearn Delivery score amendments",
};

export async function readScoreAmendments(input: {
  db: D1Database;
  assignmentId: string;
}): Promise<ScoreAmendmentsResponse> {
  await requireAssignment(input.db, input.assignmentId);
  const rows = await input.db
    .prepare(
      `SELECT score_amendments.id,
              score_amendments.assignment_id,
              score_amendments.assessment_version_id,
              score_amendments.item_id,
              score_amendments.action,
              score_amendments.response_match_text,
              score_amendments.reason,
              score_amendments.status,
              score_amendments.created_by_role,
              score_amendments.created_by_id,
              score_amendments.created_by_display_name,
              score_amendments.superseded_by_id,
              score_amendments.superseded_at,
              score_amendments.deactivated_by_role,
              score_amendments.deactivated_by_id,
              score_amendments.deactivated_by_display_name,
              score_amendments.deactivated_reason,
              score_amendments.deactivated_at,
              score_amendments.created_at,
              score_amendments.updated_at,
              COUNT(DISTINCT score_amendment_applications.attempt_id) AS applied_attempt_count
         FROM score_amendments
         LEFT JOIN score_amendment_applications
           ON score_amendment_applications.amendment_id = score_amendments.id
        WHERE score_amendments.assignment_id = ?
        GROUP BY score_amendments.id
        ORDER BY score_amendments.updated_at DESC, score_amendments.id DESC`,
    )
    .bind(input.assignmentId)
    .all<ScoreAmendmentRow>();

  return {
    amendments: rows.results.map(mapScoreAmendmentRow),
  };
}

export async function previewScoreAmendment(input: {
  db: D1Database;
  assignmentId: string;
  request: CreateScoreAmendmentRequest;
}): Promise<ScoreAmendmentPreviewResponse> {
  const assignment = await requireAssignment(input.db, input.assignmentId);
  const request = normalizeCreateScoreAmendmentRequest(input.request);
  const activeAmendments = await readActiveScoreAmendmentRows(input.db, input.assignmentId);
  const supersededAmendmentIds = activeAmendments
    .filter((amendment) => amendment.item_id === request.itemId)
    .map((amendment) => amendment.id);
  const prospectiveAmendments = buildProspectiveActiveScoreAmendments({
    activeAmendments,
    assignment,
    assignmentId: input.assignmentId,
    request,
  });
  const rows = await readCompletedAttemptResultsForAssignment(input.db, input.assignmentId);
  const attempts: ScoreAmendmentPreviewResponse["attempts"] = [];

  for (const result of rows) {
    const projection = await projectScoreAmendmentsToResult({
      db: input.db,
      result,
      amendments: prospectiveAmendments,
    });
    if (projection.appliedItems.length === 0) {
      continue;
    }

    attempts.push({
      attemptResultId: result.id,
      attemptId: result.attempt_id,
      currentTotalScore: result.total_score,
      currentMaxScore: result.max_score,
      amendedTotalScore: projection.amendedTotalScore,
      amendedMaxScore: projection.amendedMaxScore,
      applications: projection.appliedItems.map((applied) => ({
        itemId: applied.item.item_id,
        responseSummary: applied.item.response_summary_text,
        responseEvidenceEventId: applied.responseEvidence?.id ?? null,
        responseEvidenceSequenceNumber: applied.responseEvidence?.sequence_number ?? null,
        responseEvidenceServerTimestamp: applied.responseEvidence?.server_timestamp ?? null,
        baseScore: applied.baseScore,
        baseMaxScore: applied.baseMaxScore,
        currentScore: applied.item.score,
        currentMaxScore: applied.item.max_score,
        amendedScore: applied.amendedScore,
        amendedMaxScore: applied.amendedMaxScore,
      })),
    });
  }

  return {
    assignmentId: input.assignmentId,
    generatedAt: new Date().toISOString(),
    itemId: request.itemId,
    action: request.action,
    responseMatchText: request.responseMatchText,
    reason: request.reason,
    totalScoredAttemptCount: rows.length,
    affectedAttemptCount: attempts.length,
    affectedApplicationCount: attempts.reduce(
      (count, attempt) => count + attempt.applications.length,
      0,
    ),
    supersededAmendmentIds,
    attempts,
  };
}

export async function createScoreAmendment(input: {
  db: D1Database;
  env?: ResultExportProducerEnv;
  assignmentId: string;
  request: CreateScoreAmendmentRequest;
}): Promise<CreateScoreAmendmentResponse> {
  const assignment = await requireAssignment(input.db, input.assignmentId);
  const request = normalizeCreateScoreAmendmentRequest(input.request);
  const now = new Date().toISOString();
  const amendmentId = createId("samend");

  await input.db.batch([
    input.db
      .prepare(
        "UPDATE score_amendments SET status = ?, superseded_by_id = ?, superseded_at = ?, updated_at = ? WHERE assignment_id = ? AND item_id = ? AND status = ?",
      )
      .bind("superseded", amendmentId, now, now, input.assignmentId, request.itemId, "active"),
    input.db
      .prepare(
        "INSERT INTO score_amendments (id, assignment_id, assessment_version_id, item_id, action, response_match_text, reason, status, created_by_role, created_by_id, created_by_display_name, superseded_by_id, superseded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        amendmentId,
        input.assignmentId,
        assignment.assessment_version_id,
        request.itemId,
        request.action,
        request.responseMatchText,
        request.reason,
        "active",
        request.actor.role,
        request.actor.actorId,
        request.actor.displayName,
        null,
        null,
        now,
        now,
      ),
  ]);

  const applyResult = await applyActiveScoreAmendmentsForAssignment({
    db: input.db,
    env: input.env,
    assignmentId: input.assignmentId,
    actor: request.actor,
    reason: request.reason,
  });
  const amendment = await readScoreAmendment(input.db, amendmentId);
  if (!amendment) {
    throw new LaunchRequestError(500, "Score amendment was not saved");
  }

  return {
    amendment,
    appliedAttemptCount: applyResult.appliedAttemptCount,
    revisionCount: applyResult.revisionCount,
  };
}

export async function deactivateScoreAmendment(input: {
  db: D1Database;
  env?: ResultExportProducerEnv;
  assignmentId: string;
  amendmentId: string;
  request: DeactivateScoreAmendmentRequest;
}): Promise<DeactivateScoreAmendmentResponse> {
  await requireAssignment(input.db, input.assignmentId);
  const request = normalizeDeactivateScoreAmendmentRequest(input.request);
  const amendment = await readScoreAmendmentPolicyRow(input.db, input.amendmentId);
  if (!amendment || amendment.assignment_id !== input.assignmentId) {
    throw new LaunchRequestError(404, "Score amendment not found");
  }

  if (amendment.status !== "active") {
    throw new LaunchRequestError(409, "Only active score amendments can be deactivated");
  }

  const now = new Date().toISOString();
  await input.db
    .prepare(
      "UPDATE score_amendments SET status = ?, deactivated_by_role = ?, deactivated_by_id = ?, deactivated_by_display_name = ?, deactivated_reason = ?, deactivated_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(
      "inactive",
      request.actor.role,
      request.actor.actorId,
      request.actor.displayName,
      request.reason,
      now,
      now,
      input.amendmentId,
    )
    .run();

  const activeAmendments = await readActiveScoreAmendmentRows(input.db, input.assignmentId);
  const revertResult = await reconcileScoreAmendmentsForAssignment({
    db: input.db,
    env: input.env,
    assignmentId: input.assignmentId,
    amendments: activeAmendments,
    actor: request.actor,
    reason: `Score amendment deactivated: ${request.reason}`,
    revertAmendment: {
      ...amendment,
      status: "inactive",
      deactivated_by_role: request.actor.role,
      deactivated_by_id: request.actor.actorId,
      deactivated_by_display_name: request.actor.displayName,
      deactivated_reason: request.reason,
      deactivated_at: now,
      updated_at: now,
    },
  });
  const updatedAmendment = await readScoreAmendment(input.db, input.amendmentId);
  if (!updatedAmendment) {
    throw new LaunchRequestError(500, "Score amendment was not updated");
  }

  return {
    amendment: updatedAmendment,
    revertedAttemptCount: revertResult.appliedAttemptCount,
    revisionCount: revertResult.revisionCount,
  };
}

export async function readScoreAmendmentEvidenceExport(input: {
  db: D1Database;
  assignmentId: string;
}): Promise<ScoreAmendmentEvidenceExportResponse> {
  await requireAssignment(input.db, input.assignmentId);
  const [amendments, revisions] = await Promise.all([
    readScoreAmendments(input),
    readScoreRevisionsForAssignment(input.db, input.assignmentId),
  ]);

  return {
    assignmentId: input.assignmentId,
    generatedAt: new Date().toISOString(),
    amendments: amendments.amendments,
    revisions,
  };
}

export function buildScoreAmendmentEvidenceCsv(
  evidence: ScoreAmendmentEvidenceExportResponse,
): string {
  const amendmentById = new Map(evidence.amendments.map((amendment) => [amendment.id, amendment]));
  const applicationRows = evidence.revisions.flatMap((revision) =>
    revision.applications.map((application) => {
      const amendment = amendmentById.get(application.amendmentId);
      return [
        evidence.assignmentId,
        application.amendmentId,
        amendment?.status ?? "",
        amendment?.action ?? "",
        application.itemId,
        amendment?.responseMatchText ?? "",
        revision.revisionId,
        revision.revisionNumber.toString(),
        revision.attemptId,
        application.responseSummary ?? "",
        application.responseEvidenceEventId ?? "",
        application.responseEvidenceSequenceNumber?.toString() ?? "",
        application.responseEvidenceServerTimestamp ?? "",
        formatCsvNumber(application.baseScore),
        formatCsvNumber(application.baseMaxScore),
        formatCsvNumber(application.previousScore),
        formatCsvNumber(application.previousMaxScore),
        formatCsvNumber(application.amendedScore),
        formatCsvNumber(application.amendedMaxScore),
        revision.reason,
        revision.createdBy.displayName ?? revision.createdBy.actorId,
        revision.createdAt,
        application.appliedAt,
      ];
    }),
  );
  const appliedAmendmentIds = new Set(
    evidence.revisions.flatMap((revision) =>
      revision.applications.map((application) => application.amendmentId),
    ),
  );
  const unappliedRows = evidence.amendments
    .filter((amendment) => !appliedAmendmentIds.has(amendment.id))
    .map((amendment) => [
      evidence.assignmentId,
      amendment.id,
      amendment.status,
      amendment.action,
      amendment.itemId,
      amendment.responseMatchText ?? "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      amendment.reason,
      amendment.createdBy.displayName ?? amendment.createdBy.actorId,
      amendment.createdAt,
      "",
    ]);

  return buildCsv([
    [...SCORE_AMENDMENT_EVIDENCE_CSV_HEADERS],
    ...applicationRows,
    ...unappliedRows,
  ]);
}

export async function readLatestScoreRevisionsByResultId(
  db: D1Database,
  attemptResultIds: string[],
): Promise<Map<string, ScoreRevisionSnapshot>> {
  if (attemptResultIds.length === 0) {
    return new Map();
  }

  const revisions = await readScoreRevisionRows(
    db,
    `attempt_result_id IN (${attemptResultIds.map(() => "?").join(", ")})`,
    attemptResultIds,
  );
  const revisionIds = revisions.map((revision) => revision.id);
  const applicationsByRevisionId = await readApplicationsByRevisionId(db, revisionIds);
  const latest = new Map<string, ScoreRevisionSnapshot>();

  for (const row of revisions.sort((left, right) => right.revision_number - left.revision_number)) {
    if (latest.has(row.attempt_result_id)) {
      continue;
    }
    latest.set(
      row.attempt_result_id,
      mapScoreRevisionRow(row, applicationsByRevisionId.get(row.id) ?? []),
    );
  }

  return latest;
}

export async function readScoreRevisionsByResultId(
  db: D1Database,
  attemptResultIds: string[],
): Promise<ScoreRevisionSnapshot[]> {
  if (attemptResultIds.length === 0) {
    return [];
  }

  const revisions = await readScoreRevisionRows(
    db,
    `attempt_result_id IN (${attemptResultIds.map(() => "?").join(", ")})`,
    attemptResultIds,
  );
  const applicationsByRevisionId = await readApplicationsByRevisionId(
    db,
    revisions.map((revision) => revision.id),
  );

  return revisions.map((revision) =>
    mapScoreRevisionRow(revision, applicationsByRevisionId.get(revision.id) ?? []),
  );
}

export async function applyActiveScoreAmendmentsForAssignment(input: {
  db: D1Database;
  env?: ResultExportProducerEnv;
  assignmentId: string;
  actor?: AssignmentActorSnapshot;
  reason?: string;
}): Promise<ScoreAmendmentApplyResult> {
  const amendments = await readActiveScoreAmendmentRows(input.db, input.assignmentId);
  if (amendments.length === 0) {
    return {
      appliedAttemptCount: 0,
      revisionCount: 0,
    };
  }

  const rows = await readCompletedAttemptResultsForAssignment(input.db, input.assignmentId);

  let appliedAttemptCount = 0;
  let revisionCount = 0;
  for (const result of rows) {
    const applied = await applyScoreAmendmentsToResult({
      db: input.db,
      env: input.env,
      result,
      amendments,
      actor: input.actor ?? SYSTEM_RESCORE_ACTOR,
      reason: input.reason ?? "Active score amendments applied",
    });
    appliedAttemptCount += applied.appliedAttemptCount;
    revisionCount += applied.revisionCount;
  }

  return {
    appliedAttemptCount,
    revisionCount,
  };
}

async function reconcileScoreAmendmentsForAssignment(input: {
  db: D1Database;
  env?: ResultExportProducerEnv;
  assignmentId: string;
  amendments: ScoreAmendmentRow[];
  actor: AssignmentActorSnapshot;
  reason: string;
  revertAmendment?: ScoreAmendmentRow;
}): Promise<ScoreAmendmentApplyResult> {
  const rows = await readCompletedAttemptResultsForAssignment(input.db, input.assignmentId);

  let appliedAttemptCount = 0;
  let revisionCount = 0;
  for (const result of rows) {
    const applied = await applyScoreAmendmentsToResult({
      db: input.db,
      env: input.env,
      result,
      amendments: input.amendments,
      actor: input.actor,
      reason: input.reason,
      revertAmendment: input.revertAmendment,
    });
    appliedAttemptCount += applied.appliedAttemptCount;
    revisionCount += applied.revisionCount;
  }

  return {
    appliedAttemptCount,
    revisionCount,
  };
}

export async function applyActiveScoreAmendmentsForAttemptResult(input: {
  db: D1Database;
  attemptResultId: string;
}): Promise<ScoreAmendmentApplyResult> {
  const result = await input.db
    .prepare(
      "SELECT id, attempt_id, assignment_id, total_score, max_score, test_outcome_variables_json FROM attempt_results WHERE id = ?",
    )
    .bind(input.attemptResultId)
    .first<AttemptResultRow>();
  if (!result?.assignment_id) {
    return {
      appliedAttemptCount: 0,
      revisionCount: 0,
    };
  }

  const amendments = await readActiveScoreAmendmentRows(input.db, result.assignment_id);
  if (amendments.length === 0) {
    return {
      appliedAttemptCount: 0,
      revisionCount: 0,
    };
  }

  return applyScoreAmendmentsToResult({
    db: input.db,
    result,
    amendments,
    actor: SYSTEM_RESCORE_ACTOR,
    reason: "Active score amendments applied during result finalization",
  });
}

async function applyScoreAmendmentsToResult(input: {
  db: D1Database;
  env?: ResultExportProducerEnv;
  result: AttemptResultRow;
  amendments: ScoreAmendmentRow[];
  actor: AssignmentActorSnapshot;
  reason: string;
  revertAmendment?: ScoreAmendmentRow;
}): Promise<ScoreAmendmentApplyResult> {
  const projection = await projectScoreAmendmentsToResult({
    db: input.db,
    result: input.result,
    amendments: input.amendments,
    revertAmendment: input.revertAmendment,
  });

  if (projection.appliedItems.length === 0) {
    return {
      appliedAttemptCount: 0,
      revisionCount: 0,
    };
  }

  const now = new Date().toISOString();
  const revisionId = createId("srev");
  const nextRevisionNumber = await readNextRevisionNumber(input.db, input.result.id);
  const amendmentIds = uniqueStrings(projection.appliedItems.map((entry) => entry.amendment.id));
  const testOutcomeVariables = replaceScoreOutcomeVariables(
    parseOutcomeVariables(input.result.test_outcome_variables_json),
    projection.amendedTotalScore,
    projection.amendedMaxScore,
  );

  const statements = [
    input.db
      .prepare(
        "INSERT INTO result_score_revisions (id, attempt_result_id, attempt_id, assignment_id, revision_number, amendment_ids_json, previous_total_score, previous_max_score, amended_total_score, amended_max_score, reason, created_by_role, created_by_id, created_by_display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        revisionId,
        input.result.id,
        input.result.attempt_id,
        input.result.assignment_id,
        nextRevisionNumber,
        JSON.stringify(amendmentIds),
        input.result.total_score,
        input.result.max_score,
        projection.amendedTotalScore,
        projection.amendedMaxScore,
        input.reason,
        input.actor.role,
        input.actor.actorId,
        input.actor.displayName,
        now,
      ),
    input.db
      .prepare(
        "UPDATE attempt_results SET status = ?, total_score = ?, max_score = ?, passed = NULL, test_outcome_variables_json = ?, updated_at = ? WHERE id = ?",
      )
      .bind(
        "rescored",
        projection.amendedTotalScore,
        projection.amendedMaxScore,
        JSON.stringify(testOutcomeVariables),
        now,
        input.result.id,
      ),
  ];

  for (const applied of projection.appliedItems) {
    const outcomeVariables = replaceScoreOutcomeVariables(
      parseOutcomeVariables(applied.item.outcome_variables_json),
      applied.amendedScore,
      applied.amendedMaxScore,
    );
    statements.push(
      input.db
        .prepare(
          "UPDATE attempt_result_items SET score = ?, max_score = ?, base_score = ?, base_max_score = ?, outcome_variables_json = ?, score_amended = ?, score_amendment_ids_json = ? WHERE id = ?",
        )
        .bind(
          applied.amendedScore,
          applied.amendedMaxScore,
          applied.baseScore,
          applied.baseMaxScore,
          JSON.stringify(outcomeVariables),
          applied.nextScoreAmended ? 1 : 0,
          JSON.stringify(applied.nextAmendmentIds),
          applied.item.id,
        ),
      input.db
        .prepare(
          "INSERT INTO score_amendment_applications (id, score_revision_id, amendment_id, attempt_result_id, attempt_id, item_id, response_summary_text, response_evidence_event_id, base_score, base_max_score, previous_score, previous_max_score, amended_score, amended_max_score, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          createId("sapp"),
          revisionId,
          applied.amendment.id,
          input.result.id,
          input.result.attempt_id,
          applied.item.item_id,
          applied.item.response_summary_text,
          applied.responseEvidence?.id ?? null,
          applied.baseScore,
          applied.baseMaxScore,
          applied.item.score,
          applied.item.max_score,
          applied.amendedScore,
          applied.amendedMaxScore,
          now,
        ),
    );
  }

  await input.db.batch(statements);
  await requeueCompletedResultExportsForAttemptResult({
    db: input.db,
    env: input.env,
    attemptResultId: input.result.id,
  });

  return {
    appliedAttemptCount: 1,
    revisionCount: 1,
  };
}

async function projectScoreAmendmentsToResult(input: {
  db: D1Database;
  result: AttemptResultRow;
  amendments: ScoreAmendmentRow[];
  revertAmendment?: ScoreAmendmentRow;
}): Promise<ScoreAmendmentResultProjection> {
  const items = await input.db
    .prepare(
      "SELECT id, item_id, answered, response_summary_text, score, max_score, base_score, base_max_score, outcome_variables_json, score_amended, score_amendment_ids_json FROM attempt_result_items WHERE attempt_result_id = ? ORDER BY COALESCE(item_position, 0), created_at, item_id",
    )
    .bind(input.result.id)
    .all<AttemptResultItemRow>();
  const evidenceByItemId = await readLatestResponseEvidenceByItemId({
    db: input.db,
    attemptId: input.result.attempt_id,
    itemIds: uniqueStrings(items.results.map((item) => item.item_id)),
  });
  const amendmentsByItem = groupAmendmentsByItem(input.amendments);
  const appliedItems: AppliedItemProjection[] = [];
  const projectedItems = items.results.map((item) => {
    const baseScore = item.base_score ?? item.score;
    const baseMaxScore = item.base_max_score ?? item.max_score;
    const currentAmendmentIds = parseStringArray(item.score_amendment_ids_json);
    const itemAmendments = amendmentsByItem.get(item.item_id) ?? [];
    if (itemAmendments.length === 0) {
      if (
        input.revertAmendment &&
        item.score_amended === 1 &&
        currentAmendmentIds.includes(input.revertAmendment.id)
      ) {
        const restoredScore = baseScore;
        const restoredMaxScore = baseMaxScore;
        if (
          !sameNullableNumber(item.score, restoredScore) ||
          !sameNullableNumber(item.max_score, restoredMaxScore) ||
          currentAmendmentIds.length > 0
        ) {
          appliedItems.push({
            item,
            amendment: input.revertAmendment,
            responseEvidence: evidenceByItemId.get(item.item_id) ?? null,
            baseScore,
            baseMaxScore,
            amendedScore: restoredScore,
            amendedMaxScore: restoredMaxScore,
            nextScoreAmended: false,
            nextAmendmentIds: [],
          });
        }

        return {
          item,
          score: restoredScore,
          maxScore: restoredMaxScore,
        };
      }

      return {
        item,
        score: item.score,
        maxScore: item.max_score,
      };
    }

    const amendment = itemAmendments[itemAmendments.length - 1];
    const amended = applyScoreAmendmentToItem({
      amendment,
      item,
      baseScore,
      baseMaxScore,
    });
    const nextAmendmentIds = [amendment.id];

    if (
      !sameNullableNumber(item.score, amended.score) ||
      !sameNullableNumber(item.max_score, amended.maxScore) ||
      !sameStringArray(currentAmendmentIds, nextAmendmentIds) ||
      item.score_amended !== 1
    ) {
      appliedItems.push({
        item,
        amendment,
        responseEvidence: evidenceByItemId.get(item.item_id) ?? null,
        baseScore,
        baseMaxScore,
        amendedScore: amended.score,
        amendedMaxScore: amended.maxScore,
        nextScoreAmended: true,
        nextAmendmentIds,
      });
    }

    return {
      item,
      score: amended.score,
      maxScore: amended.maxScore,
    };
  });

  return {
    projectedItems,
    appliedItems,
    amendedTotalScore: sumNullableNumbers(projectedItems.map((entry) => entry.score)),
    amendedMaxScore: sumNullableNumbers(projectedItems.map((entry) => entry.maxScore)),
  };
}

async function readScoreAmendment(
  db: D1Database,
  amendmentId: string,
): Promise<ScoreAmendmentRecord | null> {
  const row = await db
    .prepare(
      `SELECT score_amendments.id,
              score_amendments.assignment_id,
              score_amendments.assessment_version_id,
              score_amendments.item_id,
              score_amendments.action,
              score_amendments.response_match_text,
              score_amendments.reason,
              score_amendments.status,
              score_amendments.created_by_role,
              score_amendments.created_by_id,
              score_amendments.created_by_display_name,
              score_amendments.superseded_by_id,
              score_amendments.superseded_at,
              score_amendments.deactivated_by_role,
              score_amendments.deactivated_by_id,
              score_amendments.deactivated_by_display_name,
              score_amendments.deactivated_reason,
              score_amendments.deactivated_at,
              score_amendments.created_at,
              score_amendments.updated_at,
              COUNT(DISTINCT score_amendment_applications.attempt_id) AS applied_attempt_count
         FROM score_amendments
         LEFT JOIN score_amendment_applications
           ON score_amendment_applications.amendment_id = score_amendments.id
        WHERE score_amendments.id = ?
        GROUP BY score_amendments.id`,
    )
    .bind(amendmentId)
    .first<ScoreAmendmentRow>();

  return row ? mapScoreAmendmentRow(row) : null;
}

async function readScoreAmendmentPolicyRow(
  db: D1Database,
  amendmentId: string,
): Promise<ScoreAmendmentRow | null> {
  return db
    .prepare(
      "SELECT id, assignment_id, assessment_version_id, item_id, action, response_match_text, reason, status, created_by_role, created_by_id, created_by_display_name, superseded_by_id, superseded_at, deactivated_by_role, deactivated_by_id, deactivated_by_display_name, deactivated_reason, deactivated_at, 0 AS applied_attempt_count, created_at, updated_at FROM score_amendments WHERE id = ?",
    )
    .bind(amendmentId)
    .first<ScoreAmendmentRow>();
}

async function readScoreRevisionsForAssignment(
  db: D1Database,
  assignmentId: string,
): Promise<ScoreRevisionSnapshot[]> {
  const revisions = await readScoreRevisionRows(db, "assignment_id = ?", [assignmentId]);
  const applicationsByRevisionId = await readApplicationsByRevisionId(
    db,
    revisions.map((revision) => revision.id),
  );

  return revisions.map((revision) =>
    mapScoreRevisionRow(revision, applicationsByRevisionId.get(revision.id) ?? []),
  );
}

async function readScoreRevisionRows(
  db: D1Database,
  whereClause: string,
  bindings: string[],
): Promise<ScoreRevisionRow[]> {
  const rows = await db
    .prepare(
      `SELECT id,
              attempt_result_id,
              attempt_id,
              assignment_id,
              revision_number,
              amendment_ids_json,
              previous_total_score,
              previous_max_score,
              amended_total_score,
              amended_max_score,
              reason,
              created_by_role,
              created_by_id,
              created_by_display_name,
              created_at
         FROM result_score_revisions
        WHERE ${whereClause}
        ORDER BY created_at DESC, revision_number DESC, id DESC`,
    )
    .bind(...bindings)
    .all<ScoreRevisionRow>();

  return rows.results;
}

async function readApplicationsByRevisionId(
  db: D1Database,
  revisionIds: string[],
): Promise<Map<string, ScoreRevisionApplicationRow[]>> {
  if (revisionIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT applications.score_revision_id,
              applications.amendment_id,
              applications.attempt_id,
              applications.item_id,
              applications.response_summary_text,
              applications.response_evidence_event_id,
              evidence.sequence_number AS response_evidence_sequence_number,
              evidence.server_timestamp AS response_evidence_server_timestamp,
              applications.base_score,
              applications.base_max_score,
              applications.previous_score,
              applications.previous_max_score,
              applications.amended_score,
              applications.amended_max_score,
              applications.applied_at
         FROM score_amendment_applications applications
         LEFT JOIN attempt_evidence_events evidence
           ON evidence.id = applications.response_evidence_event_id
        WHERE applications.score_revision_id IN (${revisionIds.map(() => "?").join(", ")})
        ORDER BY applications.applied_at ASC, applications.item_id ASC`,
    )
    .bind(...revisionIds)
    .all<ScoreRevisionApplicationRow>();

  const byRevisionId = new Map<string, ScoreRevisionApplicationRow[]>();
  for (const row of rows.results) {
    const bucket = byRevisionId.get(row.score_revision_id) ?? [];
    bucket.push(row);
    byRevisionId.set(row.score_revision_id, bucket);
  }

  return byRevisionId;
}

async function readLatestResponseEvidenceByItemId(input: {
  db: D1Database;
  attemptId: string;
  itemIds: string[];
}): Promise<Map<string, ResponseEvidenceRow>> {
  if (input.itemIds.length === 0) {
    return new Map();
  }

  const rows = await input.db
    .prepare(
      `SELECT id, attempt_id, item_id, sequence_number, server_timestamp
         FROM attempt_evidence_events
        WHERE attempt_id = ?
          AND item_id IN (${input.itemIds.map(() => "?").join(", ")})
          AND event_type = ?
          AND evidence_kind = ?
          AND outcome IN (?, ?)
        ORDER BY COALESCE(sequence_number, 0) DESC,
                 server_timestamp DESC,
                 created_at DESC,
                 id DESC`,
    )
    .bind(
      input.attemptId,
      ...input.itemIds,
      "response.changed",
      "response",
      "accepted",
      "duplicate",
    )
    .all<ResponseEvidenceRow>();

  const byItemId = new Map<string, ResponseEvidenceRow>();
  for (const row of rows.results) {
    if (!byItemId.has(row.item_id)) {
      byItemId.set(row.item_id, row);
    }
  }

  return byItemId;
}

async function readCompletedAttemptResultsForAssignment(
  db: D1Database,
  assignmentId: string,
): Promise<AttemptResultRow[]> {
  const rows = await db
    .prepare(
      "SELECT id, attempt_id, assignment_id, total_score, max_score, test_outcome_variables_json FROM attempt_results WHERE assignment_id = ? AND status IN (?, ?)",
    )
    .bind(assignmentId, "complete", "rescored")
    .all<AttemptResultRow>();

  return rows.results;
}

async function readActiveScoreAmendmentRows(
  db: D1Database,
  assignmentId: string,
): Promise<ScoreAmendmentRow[]> {
  const rows = await db
    .prepare(
      "SELECT id, assignment_id, assessment_version_id, item_id, action, response_match_text, reason, status, created_by_role, created_by_id, created_by_display_name, superseded_by_id, superseded_at, deactivated_by_role, deactivated_by_id, deactivated_by_display_name, deactivated_reason, deactivated_at, 0 AS applied_attempt_count, created_at, updated_at FROM score_amendments WHERE assignment_id = ? AND status = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(assignmentId, "active")
    .all<ScoreAmendmentRow>();

  return rows.results;
}

function buildProspectiveActiveScoreAmendments(input: {
  activeAmendments: ScoreAmendmentRow[];
  assignment: AssignmentRow;
  assignmentId: string;
  request: Required<CreateScoreAmendmentRequest>;
}): ScoreAmendmentRow[] {
  const now = new Date().toISOString();
  const prospectiveAmendment: ScoreAmendmentRow = {
    id: "preview_score_amendment",
    assignment_id: input.assignmentId,
    assessment_version_id: input.assignment.assessment_version_id,
    item_id: input.request.itemId,
    action: input.request.action,
    response_match_text: input.request.responseMatchText,
    reason: input.request.reason,
    status: "active",
    created_by_role: input.request.actor.role,
    created_by_id: input.request.actor.actorId,
    created_by_display_name: input.request.actor.displayName,
    superseded_by_id: null,
    superseded_at: null,
    deactivated_by_role: null,
    deactivated_by_id: null,
    deactivated_by_display_name: null,
    deactivated_reason: null,
    deactivated_at: null,
    applied_attempt_count: 0,
    created_at: now,
    updated_at: now,
  };

  return [
    ...input.activeAmendments.filter((amendment) => amendment.item_id !== input.request.itemId),
    prospectiveAmendment,
  ];
}

async function requireAssignment(db: D1Database, assignmentId: string): Promise<AssignmentRow> {
  const row = await db
    .prepare("SELECT id, assessment_version_id FROM assignments WHERE id = ?")
    .bind(assignmentId)
    .first<AssignmentRow>();
  if (!row) {
    throw new LaunchRequestError(404, "Assignment not found");
  }

  return row;
}

async function readNextRevisionNumber(db: D1Database, attemptResultId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number FROM result_score_revisions WHERE attempt_result_id = ?",
    )
    .bind(attemptResultId)
    .first<{ revision_number: number }>();

  return row?.revision_number ?? 1;
}

function normalizeCreateScoreAmendmentRequest(
  request: CreateScoreAmendmentRequest,
): Required<CreateScoreAmendmentRequest> {
  const itemId = request.itemId.trim();
  const reason = request.reason.trim();
  const responseMatchText = request.responseMatchText?.trim() ?? "";

  if (!itemId) {
    throw new LaunchRequestError(400, "Score amendment itemId is required");
  }

  if (!SCORE_AMENDMENT_ACTIONS.includes(request.action)) {
    throw new LaunchRequestError(400, "Score amendment action is not supported");
  }

  if (request.action === "set-correct-response" && !responseMatchText) {
    throw new LaunchRequestError(400, "Correct-response amendments require responseMatchText");
  }

  if (!reason) {
    throw new LaunchRequestError(400, "Score amendment reason is required");
  }

  if (!request.actor.actorId.trim()) {
    throw new LaunchRequestError(400, "Score amendment actor is required");
  }

  return {
    actor: request.actor,
    itemId,
    action: request.action,
    responseMatchText: responseMatchText || null,
    reason,
  };
}

function normalizeDeactivateScoreAmendmentRequest(
  request: DeactivateScoreAmendmentRequest,
): DeactivateScoreAmendmentRequest {
  const reason = request.reason.trim();
  if (!reason) {
    throw new LaunchRequestError(400, "Deactivate reason is required");
  }

  if (!request.actor.actorId.trim()) {
    throw new LaunchRequestError(400, "Score amendment actor is required");
  }

  return {
    actor: request.actor,
    reason,
  };
}

function applyScoreAmendmentToItem(input: {
  amendment: ScoreAmendmentRow;
  item: AttemptResultItemRow;
  baseScore: number | null;
  baseMaxScore: number | null;
}): { score: number | null; maxScore: number | null } {
  if (input.amendment.action === "exclude-from-score") {
    return {
      score: 0,
      maxScore: 0,
    };
  }

  if (input.amendment.action === "award-full-credit") {
    return {
      score: input.baseMaxScore ?? input.baseScore ?? 1,
      maxScore: input.baseMaxScore,
    };
  }

  const maxScore = input.baseMaxScore;
  if (!input.amendment.response_match_text) {
    return {
      score: input.baseScore,
      maxScore,
    };
  }

  return {
    score: responseMatches(input.item.response_summary_text, input.amendment.response_match_text)
      ? maxScore
      : maxScore === null
        ? null
        : 0,
    maxScore,
  };
}

function groupAmendmentsByItem(amendments: ScoreAmendmentRow[]): Map<string, ScoreAmendmentRow[]> {
  const byItem = new Map<string, ScoreAmendmentRow[]>();
  for (const amendment of amendments) {
    const bucket = byItem.get(amendment.item_id) ?? [];
    bucket.push(amendment);
    byItem.set(amendment.item_id, bucket);
  }

  return byItem;
}

function responseMatches(responseSummary: string | null, expected: string): boolean {
  if (!responseSummary) {
    return false;
  }

  const normalizedExpected = normalizeResponseText(expected);
  const normalizedSummary = normalizeResponseText(responseSummary);
  if (normalizedSummary === normalizedExpected) {
    return true;
  }

  return responseSummary
    .split(/[·,]/)
    .map((part) => normalizeResponseText(part))
    .some((part) => part === normalizedExpected || part.endsWith(`: ${normalizedExpected}`));
}

function normalizeResponseText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function replaceScoreOutcomeVariables(
  variables: AttemptVariableSnapshotLike[],
  score: number | null,
  maxScore: number | null,
): AttemptVariableSnapshotLike[] {
  const filtered = variables.filter(
    (variable) =>
      variable.identifier !== "SCORE" &&
      variable.identifier !== "MAXSCORE" &&
      variable.identifier !== "PASSED",
  );

  if (score !== null) {
    filtered.push({
      identifier: "SCORE",
      value: score,
    });
  }

  if (maxScore !== null) {
    filtered.push({
      identifier: "MAXSCORE",
      value: maxScore,
    });
  }

  return filtered;
}

interface AttemptVariableSnapshotLike {
  identifier: string;
  value: unknown;
}

function parseOutcomeVariables(value: string): AttemptVariableSnapshotLike[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
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

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function sumNullableNumbers(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  return left === right;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function mapScoreAmendmentRow(row: ScoreAmendmentRow): ScoreAmendmentRecord {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    assessmentVersionId: row.assessment_version_id,
    itemId: row.item_id,
    action: row.action,
    responseMatchText: row.response_match_text,
    reason: row.reason,
    status: row.status,
    createdBy: {
      role: row.created_by_role,
      actorId: row.created_by_id,
      displayName: row.created_by_display_name,
    },
    supersededById: row.superseded_by_id,
    supersededAt: row.superseded_at,
    deactivatedBy:
      row.deactivated_by_role && row.deactivated_by_id
        ? {
            role: row.deactivated_by_role,
            actorId: row.deactivated_by_id,
            displayName: row.deactivated_by_display_name,
          }
        : null,
    deactivatedReason: row.deactivated_reason,
    deactivatedAt: row.deactivated_at,
    appliedAttemptCount: row.applied_attempt_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapScoreRevisionRow(
  row: ScoreRevisionRow,
  applications: ScoreRevisionApplicationRow[],
): ScoreRevisionSnapshot {
  return {
    revisionId: row.id,
    attemptResultId: row.attempt_result_id,
    attemptId: row.attempt_id,
    assignmentId: row.assignment_id,
    revisionNumber: row.revision_number,
    amendmentIds: parseStringArray(row.amendment_ids_json),
    previousTotalScore: row.previous_total_score,
    previousMaxScore: row.previous_max_score,
    amendedTotalScore: row.amended_total_score,
    amendedMaxScore: row.amended_max_score,
    reason: row.reason,
    createdBy: {
      role: row.created_by_role,
      actorId: row.created_by_id,
      displayName: row.created_by_display_name,
    },
    createdAt: row.created_at,
    applications: applications.map((application) => ({
      amendmentId: application.amendment_id,
      itemId: application.item_id,
      responseSummary: application.response_summary_text,
      responseEvidenceEventId: application.response_evidence_event_id,
      responseEvidenceSequenceNumber: application.response_evidence_sequence_number,
      responseEvidenceServerTimestamp: application.response_evidence_server_timestamp,
      baseScore: application.base_score,
      baseMaxScore: application.base_max_score,
      previousScore: application.previous_score,
      previousMaxScore: application.previous_max_score,
      amendedScore: application.amended_score,
      amendedMaxScore: application.amended_max_score,
      appliedAt: application.applied_at,
    })),
  };
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
