import { readStagedResultSummary } from "../../../results/staged-assessment-results";
import {
  applyAccommodationSupportCounts,
  buildAttemptAccommodationEvidenceSummary,
  readAccommodationEvidenceLanguage,
  SERVER_PROJECTED_ATTEMPT_EVIDENCE_OUTCOME,
  type AttemptAccommodationSnapshotEvidence,
  type AttemptAccommodationState,
  type InstructorLearnerReportEvidenceSummary,
  type InstructorLearnerReportResponse,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../../launch/create-preview-attempt";
import {
  readLatestScoreRevisionsByResultId,
  readScoreRevisionsByResultId,
} from "../../../results/score-amendments";
import { readAssignment } from "../../assignments";
import {
  parseAccommodationTiming,
  parseJsonRecord,
  parseJsonStringArray,
  readSyncSignals,
} from "./json-parsers";
import {
  calculatePercentScore,
  createEmptyEvidenceSummary,
  roundReportingMetric,
} from "./reporting-metrics";
import {
  buildRosterAttemptProjection,
  readAssignmentAttempts,
  readAttemptResultsByAttempt,
  readLatestFinalizationsByAttempt,
  readLiveAttemptStatuses,
  readOverridesByLearner,
  readTargetedLearners,
} from "./roster-data";
import type {
  AttemptAccommodationSnapshotRow,
  AttemptAccommodationEvidenceCountRow,
  AttemptEvidenceEventRow,
  AttemptEvidenceSummaryRow,
  AttemptResultRow,
  LearnerReportItemResultRow,
  LearnerReportStandardRow,
} from "./types";

export async function readInstructorLearnerReport(input: {
  db: D1Database;
  attemptCoordinator: DurableObjectNamespace;
  assignmentId: string;
  learnerId: string;
}): Promise<InstructorLearnerReportResponse> {
  const assignment = await readAssignment(input.db, input.assignmentId);
  const targetedLearners = await readTargetedLearners(input.db, input.assignmentId);
  const targetedLearner = targetedLearners.find(
    (learner) => learner.learner_id === input.learnerId,
  );
  if (!targetedLearner) {
    throw new LaunchRequestError(403, "Learner is not targeted for the requested assignment");
  }

  const attempts = await readAssignmentAttempts(input.db, input.assignmentId, [input.learnerId]);
  const attemptIds = attempts.map((attempt) => attempt.attempt_id);
  const resultByAttempt = await readAttemptResultsByAttempt(input.db, attemptIds);
  const resultIds = [...resultByAttempt.values()].map((result) => result.attempt_result_id);
  const latestRevisionByResultId = await readLatestScoreRevisionsByResultId(input.db, resultIds);
  const finalizationByAttempt = await readLatestFinalizationsByAttempt(input.db, attemptIds);
  const liveStatuses = await readLiveAttemptStatuses(
    input.attemptCoordinator,
    attemptIds.filter((attemptId) => !finalizationByAttempt.has(attemptId)),
  );
  const accommodationSnapshotByAttempt = await readAccommodationSnapshotsByAttempt(
    input.db,
    attemptIds,
  );
  const evidenceSummaryByAttempt = await readEvidenceSummariesByAttempt(input.db, attemptIds);
  const scoreHistory = await readScoreRevisionsByResultId(input.db, resultIds);
  const overrideByLearner = await readOverridesByLearner(input.db, input.assignmentId, [
    input.learnerId,
  ]);

  const latestAttempt = attempts[0] ?? null;
  const latestFinalization = latestAttempt
    ? (finalizationByAttempt.get(latestAttempt.attempt_id) ?? null)
    : null;
  const latestResult = latestAttempt
    ? (resultByAttempt.get(latestAttempt.attempt_id) ?? null)
    : null;
  const latestAttemptProjection = buildRosterAttemptProjection(
    latestAttempt,
    latestFinalization,
    liveStatuses.get(latestAttempt?.attempt_id ?? ""),
  );
  const latestAccommodationSnapshot = latestAttempt
    ? (accommodationSnapshotByAttempt.get(latestAttempt.attempt_id) ?? null)
    : null;
  const latestEvidenceSummary = latestAttempt
    ? (evidenceSummaryByAttempt.get(latestAttempt.attempt_id) ?? createEmptyEvidenceSummary())
    : createEmptyEvidenceSummary();

  const stagedAssessment = latestResult
    ? await readStagedResultSummary(input.db, latestResult.attempt_result_id)
    : null;
  return {
    stagedAssessment,
    assignment,
    learner: {
      id: targetedLearner.learner_id,
      tenantId: targetedLearner.tenant_id,
      displayName: targetedLearner.display_name,
      email: targetedLearner.email,
      createdAt: "",
      updatedAt: "",
    },
    targetSource: targetedLearner.target_source,
    activeOverride: overrideByLearner.get(input.learnerId) ?? null,
    attemptCount: attempts.length,
    latestAttempt: latestAttemptProjection,
    latestResult: latestResult
      ? {
          ...buildLearnerReportResultProjection(latestResult),
          ...(stagedAssessment ? { percentScore: null } : {}),
        }
      : null,
    attempts: attempts.map((attempt) => {
      const result = resultByAttempt.get(attempt.attempt_id) ?? null;
      const finalization = finalizationByAttempt.get(attempt.attempt_id) ?? null;
      const attemptProjection = buildRosterAttemptProjection(
        attempt,
        finalization,
        liveStatuses.get(attempt.attempt_id),
      );
      return {
        attemptId: attempt.attempt_id,
        status: attemptProjection.status === "not-started" ? "active" : attemptProjection.status,
        launchedAt: attempt.created_at,
        submittedAt: finalization?.submitted_at ?? null,
        finalizedAt: result?.finalized_at ?? null,
        resultStatus: result?.status ?? finalization?.status ?? null,
        totalScore: result?.total_score ?? null,
        maxScore: result?.max_score ?? null,
        percentScore: stagedAssessment
          ? null
          : calculatePercentScore(result?.total_score ?? null, result?.max_score ?? null),
        finalization: finalization
          ? {
              status: finalization.status,
              errorMessage: finalization.error_message,
              updatedAt: finalization.updated_at,
            }
          : null,
        latestScoreRevision: result
          ? (latestRevisionByResultId.get(result.attempt_result_id) ?? null)
          : null,
        accommodationSnapshot: accommodationSnapshotByAttempt.get(attempt.attempt_id) ?? null,
        evidenceSummary:
          evidenceSummaryByAttempt.get(attempt.attempt_id) ?? createEmptyEvidenceSummary(),
      };
    }),
    itemResults: latestResult
      ? await readLearnerReportItemResults({
          db: input.db,
          assessmentVersionId: assignment.assessmentVersionId,
          attemptResultId: latestResult.attempt_result_id,
        })
      : [],
    standardsMastery: await readLearnerStandardsMastery({
      db: input.db,
      assessmentVersionId: assignment.assessmentVersionId,
      attemptResultId: latestResult?.attempt_result_id ?? null,
    }),
    scoreHistory,
    accommodationSnapshot: latestAccommodationSnapshot,
    evidence: {
      summary: latestEvidenceSummary,
      events: latestAttempt
        ? await readLearnerReportEvidenceEvents(input.db, latestAttempt.attempt_id)
        : [],
    },
    generatedAt: new Date().toISOString(),
  };
}

function buildLearnerReportResultProjection(
  result: AttemptResultRow,
): NonNullable<InstructorLearnerReportResponse["latestResult"]> {
  return {
    attemptResultId: result.attempt_result_id,
    attemptId: result.attempt_id,
    status: result.status,
    totalScore: result.total_score,
    maxScore: result.max_score,
    percentScore:
      result.is_sequenced === 1
        ? null
        : calculatePercentScore(result.total_score, result.max_score),
    submittedAt: result.submitted_at,
    finalizedAt: result.finalized_at,
  };
}

async function readLearnerReportItemResults(input: {
  db: D1Database;
  assessmentVersionId: string;
  attemptResultId: string;
}): Promise<InstructorLearnerReportResponse["itemResults"]> {
  const rows = await input.db
    .prepare(
      `SELECT result_items.item_id,
              result_items.item_identifier,
              result_items.item_title,
              result_items.item_position,
              result_items.answered,
              result_items.response_summary_text,
              result_items.score,
              result_items.max_score,
              result_items.base_score,
              result_items.base_max_score,
              result_items.score_amended,
              result_items.score_amendment_ids_json,
              alignments.standard_id,
              alignments.standard_code,
              alignments.standard_label
         FROM attempt_result_items result_items
         LEFT JOIN assessment_item_standard_alignments alignments
           ON alignments.assessment_version_id = ?
          AND alignments.item_id = result_items.item_id
        WHERE result_items.attempt_result_id = ?
        ORDER BY result_items.item_position ASC,
                 result_items.created_at ASC,
                 result_items.item_id ASC,
                 alignments.standard_code ASC,
                 alignments.standard_id ASC`,
    )
    .bind(input.assessmentVersionId, input.attemptResultId)
    .all<LearnerReportItemResultRow>();

  const byItem = new Map<string, InstructorLearnerReportResponse["itemResults"][number]>();

  for (const row of rows.results) {
    const current = byItem.get(row.item_id) ?? {
      itemId: row.item_id,
      itemIdentifier: row.item_identifier,
      itemTitle: row.item_title,
      itemPosition: row.item_position,
      answered: row.answered === 1,
      responseSummary: row.response_summary_text,
      score: row.score,
      maxScore: row.max_score,
      baseScore: row.base_score,
      baseMaxScore: row.base_max_score,
      percentScore: calculatePercentScore(row.score, row.max_score),
      scoreAmended: row.score_amended === 1,
      scoreAmendmentIds: parseJsonStringArray(row.score_amendment_ids_json),
      standards: [],
    };

    if (
      row.standard_id &&
      !current.standards.some((standard) => standard.standardId === row.standard_id)
    ) {
      current.standards.push({
        standardId: row.standard_id,
        code: row.standard_code,
        label: row.standard_label ?? row.standard_code ?? row.standard_id,
      });
    }

    byItem.set(row.item_id, current);
  }

  return [...byItem.values()];
}

async function readLearnerStandardsMastery(input: {
  db: D1Database;
  assessmentVersionId: string;
  attemptResultId: string | null;
}): Promise<InstructorLearnerReportResponse["standardsMastery"]> {
  const resultFilter = input.attemptResultId
    ? "AND result_items.attempt_result_id = ?"
    : "AND 1 = 0";
  const bindings = input.attemptResultId
    ? [input.attemptResultId, input.assessmentVersionId]
    : [input.assessmentVersionId];
  const rows = await input.db
    .prepare(
      `SELECT alignments.standard_id,
              alignments.standard_code,
              alignments.standard_label,
              COUNT(DISTINCT alignments.item_id) AS item_count,
              COUNT(
                DISTINCT CASE
                  WHEN result_items.score IS NOT NULL
                   AND result_items.max_score IS NOT NULL
                    THEN result_items.item_id
                  ELSE NULL
                END
              ) AS scored_item_count,
              AVG(
                CASE
                  WHEN result_items.max_score > 0
                   AND result_items.score IS NOT NULL
                    THEN (result_items.score / result_items.max_score) * 100
                  ELSE NULL
                END
              ) AS average_percent
         FROM assessment_item_standard_alignments alignments
         LEFT JOIN attempt_result_items result_items
           ON result_items.item_id = alignments.item_id
          ${resultFilter}
        WHERE alignments.assessment_version_id = ?
        GROUP BY alignments.standard_id,
                 alignments.standard_code,
                 alignments.standard_label
        ORDER BY COALESCE(alignments.standard_code, alignments.standard_id) ASC`,
    )
    .bind(...bindings)
    .all<LearnerReportStandardRow>();

  return {
    metadataAvailable: rows.results.length > 0,
    rows: rows.results.map((row) => ({
      standardId: row.standard_id,
      label: row.standard_label ?? row.standard_code ?? row.standard_id,
      itemCount: row.item_count,
      scoredItemCount: row.scored_item_count,
      averagePercent:
        row.average_percent === null ? null : roundReportingMetric(row.average_percent),
    })),
  };
}

async function readAccommodationSnapshotsByAttempt(
  db: D1Database,
  attemptIds: string[],
): Promise<Map<string, AttemptAccommodationSnapshotEvidence>> {
  if (attemptIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT attempt_id,
              profile_ids_json,
              learner_assignment_ids_json,
              assignment_override_id,
              accommodations_json,
              shell_tools_json,
              timing_json,
              created_at
         FROM attempt_accommodation_snapshots
        WHERE attempt_id IN (${attemptIds.map(() => "?").join(", ")})`,
    )
    .bind(...attemptIds)
    .all<AttemptAccommodationSnapshotRow>();

  return new Map(
    rows.results.map((row) => {
      const profileIds = parseJsonStringArray(row.profile_ids_json);
      const learnerProfileAssignmentIds = parseJsonStringArray(row.learner_assignment_ids_json);
      const accommodations = parseJsonRecord(
        row.accommodations_json,
      ) as unknown as AttemptAccommodationState;
      const shellTools = parseJsonRecord(
        row.shell_tools_json,
      ) as AttemptAccommodationSnapshotEvidence["shellTools"];
      const timing = parseAccommodationTiming(row.timing_json);
      return [
        row.attempt_id,
        {
          profileIds,
          learnerProfileAssignmentIds,
          assignmentOverrideId: row.assignment_override_id,
          accommodations,
          shellTools,
          timing,
          summary: buildAttemptAccommodationEvidenceSummary({
            profileIds,
            learnerProfileAssignmentIds,
            assignmentOverrideId: row.assignment_override_id,
            accommodations,
            shellTools,
            timing,
          }),
          createdAt: row.created_at,
        } as AttemptAccommodationSnapshotEvidence,
      ];
    }),
  );
}

async function readEvidenceSummariesByAttempt(
  db: D1Database,
  attemptIds: string[],
): Promise<Map<string, InstructorLearnerReportEvidenceSummary>> {
  if (attemptIds.length === 0) {
    return new Map();
  }

  const placeholders = attemptIds.map(() => "?").join(", ");

  const rows = await db
    .prepare(
      `SELECT attempt_id,
              SUM(CASE WHEN evidence_kind = 'item-presentation' THEN 1 ELSE 0 END)
                AS item_presentation_count,
              SUM(CASE WHEN evidence_kind = 'response' THEN 1 ELSE 0 END)
                AS response_count,
              SUM(CASE WHEN evidence_kind = 'submit' THEN 1 ELSE 0 END)
                AS submit_count,
              SUM(
                CASE
                  WHEN outcome NOT IN ('accepted', '${SERVER_PROJECTED_ATTEMPT_EVIDENCE_OUTCOME}') THEN 1
                  ELSE 0
                END
              ) AS flagged_count,
              SUM(CASE WHEN flags_json LIKE '%"queued_locally"%' THEN 1 ELSE 0 END)
                AS queued_locally_count,
              SUM(CASE WHEN flags_json LIKE '%"replayed"%' THEN 1 ELSE 0 END)
                AS replayed_count,
              SUM(CASE WHEN flags_json LIKE '%"stale_tab_reconciled"%' THEN 1 ELSE 0 END)
                AS stale_tab_reconciled_count,
              SUM(CASE WHEN flags_json LIKE '%"receipt_confirmed"%' THEN 1 ELSE 0 END)
                AS receipt_confirmed_count,
              SUM(CASE WHEN flags_json LIKE '%"sync_failed"%' THEN 1 ELSE 0 END)
                AS sync_failed_count,
              MIN(server_timestamp) AS first_event_at,
              MAX(server_timestamp) AS latest_event_at,
              MAX(
                CASE
                  WHEN evidence_kind = 'submit' THEN server_timestamp
                  ELSE NULL
                END
              ) AS latest_submit_at
         FROM attempt_evidence_events
        WHERE attempt_id IN (${placeholders})
        GROUP BY attempt_id`,
    )
    .bind(...attemptIds)
    .all<AttemptEvidenceSummaryRow>();

  const accommodationRows = await db
    .prepare(
      `SELECT attempt_id,
              json_extract(payload_json, '$.support') AS support,
              json_extract(payload_json, '$.state') AS state,
              COUNT(*) AS count
         FROM attempt_evidence_events
        WHERE attempt_id IN (${placeholders})
          AND evidence_kind = 'accommodation-support'
          AND json_extract(payload_json, '$.support') IS NOT NULL
          AND json_extract(payload_json, '$.state') IS NOT NULL
        GROUP BY attempt_id, support, state`,
    )
    .bind(...attemptIds)
    .all<AttemptAccommodationEvidenceCountRow>();

  const accommodationCountsByAttempt = new Map<string, Map<string, Map<string, number>>>();
  for (const row of accommodationRows.results) {
    const attemptCounts =
      accommodationCountsByAttempt.get(row.attempt_id) ?? new Map<string, Map<string, number>>();
    const supportCounts = attemptCounts.get(row.support) ?? new Map<string, number>();
    supportCounts.set(row.state, row.count);
    attemptCounts.set(row.support, supportCounts);
    accommodationCountsByAttempt.set(row.attempt_id, attemptCounts);
  }

  const summaries = new Map<string, InstructorLearnerReportEvidenceSummary>(
    rows.results.map((row) => {
      const summary = createEmptyEvidenceSummary();
      summary.itemPresentationCount = row.item_presentation_count;
      summary.responseCount = row.response_count;
      summary.submitCount = row.submit_count;
      summary.flaggedCount = row.flagged_count;
      summary.queuedLocallyCount = row.queued_locally_count;
      summary.replayedCount = row.replayed_count;
      summary.staleTabReconciledCount = row.stale_tab_reconciled_count;
      summary.receiptConfirmedCount = row.receipt_confirmed_count;
      summary.syncFailedCount = row.sync_failed_count;
      summary.firstEventAt = row.first_event_at;
      summary.latestEventAt = row.latest_event_at;
      summary.latestSubmitAt = row.latest_submit_at;
      applyAccommodationSupportCounts(
        summary,
        accommodationCountsByAttempt.get(row.attempt_id) ?? new Map(),
      );
      return [row.attempt_id, summary];
    }),
  );

  const languageRows = await db
    .prepare(
      `SELECT attempt_id, payload_json
         FROM attempt_evidence_events
        WHERE attempt_id IN (${placeholders})
          AND evidence_kind = 'accommodation-support'
          AND json_extract(payload_json, '$.support') = 'keyword-translation'
        ORDER BY server_timestamp DESC, id DESC`,
    )
    .bind(...attemptIds)
    .all<{ attempt_id: string; payload_json: string }>();

  const attemptsWithRequestedLanguage = new Set<string>();
  const attemptsWithResolvedLanguage = new Set<string>();
  for (const row of languageRows.results) {
    if (
      attemptsWithRequestedLanguage.has(row.attempt_id) &&
      attemptsWithResolvedLanguage.has(row.attempt_id)
    ) {
      continue;
    }
    const summary = summaries.get(row.attempt_id);
    if (!summary) continue;
    const payload = parseJsonRecord(row.payload_json);
    const requestedLanguage = readAccommodationEvidenceLanguage(payload, "requestedLanguage");
    const resolvedLanguage = readAccommodationEvidenceLanguage(payload, "resolvedLanguage");
    if (requestedLanguage && !attemptsWithRequestedLanguage.has(row.attempt_id)) {
      summary.latestKeywordTranslationRequestedLanguage = requestedLanguage;
      attemptsWithRequestedLanguage.add(row.attempt_id);
    }
    if (resolvedLanguage && !attemptsWithResolvedLanguage.has(row.attempt_id)) {
      summary.latestKeywordTranslationResolvedLanguage = resolvedLanguage;
      attemptsWithResolvedLanguage.add(row.attempt_id);
    }
  }

  return summaries;
}

async function readLearnerReportEvidenceEvents(
  db: D1Database,
  attemptId: string,
): Promise<InstructorLearnerReportResponse["evidence"]["events"]> {
  const rows = await db
    .prepare(
      `SELECT id,
              attempt_id,
              event_type,
              evidence_kind,
              outcome,
              sequence_number,
              item_id,
              response_key,
              client_timestamp,
              server_timestamp,
              receipt_id,
              event_source,
              flags_json,
              payload_json
         FROM attempt_evidence_events
        WHERE attempt_id = ?
        ORDER BY server_timestamp ASC, id ASC`,
    )
    .bind(attemptId)
    .all<AttemptEvidenceEventRow>();

  return rows.results.map((row) => {
    const payload = parseJsonRecord(row.payload_json);
    return {
      id: row.id,
      attemptId: row.attempt_id,
      eventType: row.event_type,
      evidenceKind: row.evidence_kind,
      outcome: row.outcome,
      sequenceNumber: row.sequence_number,
      itemId: row.item_id,
      responseKey: row.response_key,
      clientTimestamp: row.client_timestamp,
      serverTimestamp: row.server_timestamp,
      receiptId: row.receipt_id,
      eventSource: row.event_source,
      syncSignals: readSyncSignals(row.flags_json),
      support: readEvidenceString(payload, "support"),
      supportState: readEvidenceString(payload, "state"),
      requestedLanguage: readAccommodationEvidenceLanguage(payload, "requestedLanguage"),
      resolvedLanguage: readAccommodationEvidenceLanguage(payload, "resolvedLanguage"),
      selectionReason:
        readEvidenceString(payload, "selectionReason") ??
        readFirstEvidenceListValue(payload, "selectionReasons"),
      catalogIds: readEvidenceStringList(payload, "catalogIds"),
      assetReferences: readEvidenceStringList(payload, "assetReferences"),
      mediaTypes: readEvidenceStringList(payload, "mediaTypes"),
      control: readEvidenceString(payload, "control"),
      reason: readEvidenceString(payload, "reason"),
    };
  });
}

function readEvidenceString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readFirstEvidenceListValue(payload: Record<string, unknown>, key: string): string | null {
  return readEvidenceStringList(payload, key)[0] ?? null;
}

function readEvidenceStringList(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}
