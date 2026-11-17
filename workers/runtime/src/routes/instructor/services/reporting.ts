import {
  type InstructorAssignmentDistractorSignal,
  type InstructorAssignmentReportingItemRow,
  type InstructorAssignmentReportingResponse,
  type InstructorAssignmentReportingRosterRow,
  type InstructorAssignmentReportingSummary,
  type InstructorAssignmentRosterResponse,
  type InstructorAssignmentStandardWeaknessSignal,
} from "@harbor/attempt-protocol";
import { readInstructorAssignmentRoster } from "./assignments";
import {
  average,
  averageReportingMetric,
  calculatePercentScore,
  isScoredResultStatus,
  maxTimestamp,
  roundReportingMetric,
} from "./reporting-metrics";
import { readAttemptResultsByAttempt } from "./roster-data";
import type {
  AttemptResultRow,
  ReportingItemEvidenceRow,
  ReportingItemResultRow,
  ReportingStandardRow,
} from "./types";

export async function readInstructorAssignmentReporting(input: {
  db: D1Database;
  attemptCoordinator: DurableObjectNamespace;
  assignmentId: string;
}): Promise<InstructorAssignmentReportingResponse> {
  const roster = await readInstructorAssignmentRoster(input);
  const latestAttemptIds = roster.rows
    .map((row) => (row.latestAttempt.status === "not-started" ? null : row.latestAttempt.attemptId))
    .filter((attemptId): attemptId is string => Boolean(attemptId));
  const resultByAttempt = await readAttemptResultsByAttempt(input.db, latestAttemptIds);
  const scoredResultIds = [...resultByAttempt.values()]
    .filter((result) => isScoredResultStatus(result.status) && result.is_sequenced !== 1)
    .map((result) => result.attempt_result_id);
  const itemAnalysis = await readAssignmentItemAnalysis(input.db, scoredResultIds);
  const standardsMastery = await readAssignmentStandardsMastery({
    db: input.db,
    assessmentVersionId: roster.assignment.assessmentVersionId,
    attemptResultIds: scoredResultIds,
  });
  const rosterSummary = buildAssignmentReportingRosterSummary(roster.rows, resultByAttempt);

  return {
    assignment: roster.assignment,
    summary: buildAssignmentReportingSummary(rosterSummary),
    rosterSummary,
    itemAnalysis,
    standardsMastery,
  };
}

function buildAssignmentReportingRosterSummary(
  rows: InstructorAssignmentRosterResponse["rows"],
  resultByAttempt: Map<string, AttemptResultRow>,
): InstructorAssignmentReportingRosterRow[] {
  return rows.map((row) => {
    const latestAttemptId =
      row.latestAttempt.status === "not-started" ? null : row.latestAttempt.attemptId;
    const result = latestAttemptId ? (resultByAttempt.get(latestAttemptId) ?? null) : null;

    return {
      learner: row.learner,
      targetSource: row.targetSource,
      latestAttemptId,
      resultStatus: row.latestResultStatus,
      totalScore: row.latestScore?.totalScore ?? null,
      maxScore: row.latestScore?.maxScore ?? null,
      percentScore:
        result?.is_sequenced === 1
          ? null
          : calculatePercentScore(
              row.latestScore?.totalScore ?? null,
              row.latestScore?.maxScore ?? null,
            ),
      submittedAt: row.latestAttempt.submittedAt,
      finalizedAt: result?.finalized_at ?? null,
      scoreAmended: row.latestResultStatus === "rescored" || Boolean(row.latestScoreRevision),
    };
  });
}

function buildAssignmentReportingSummary(
  rosterSummary: InstructorAssignmentReportingRosterRow[],
): InstructorAssignmentReportingSummary {
  const scoredRows = rosterSummary.filter((row) => isScoredResultStatus(row.resultStatus));
  const rowsWithNumericScores = scoredRows.filter(
    (row) => row.totalScore !== null && row.maxScore !== null && row.percentScore !== null,
  );
  const percentages = rowsWithNumericScores
    .map((row) => row.percentScore)
    .filter((value): value is number => value !== null);

  return {
    targetedLearnerCount: rosterSummary.length,
    submittedAttemptCount: rosterSummary.filter((row) => row.submittedAt !== null).length,
    scoredAttemptCount: scoredRows.length,
    pendingCount: rosterSummary.filter((row) => row.resultStatus === "pending").length,
    failedCount: rosterSummary.filter((row) => row.resultStatus === "failed").length,
    rescoredCount: rosterSummary.filter((row) => row.resultStatus === "rescored").length,
    amendedResultCount: rosterSummary.filter((row) => row.scoreAmended).length,
    averageScore: averageReportingMetric(rowsWithNumericScores.map((row) => row.totalScore)),
    averageMaxScore: averageReportingMetric(rowsWithNumericScores.map((row) => row.maxScore)),
    averagePercent: averageReportingMetric(percentages),
    minPercent: percentages.length > 0 ? Math.min(...percentages) : null,
    maxPercent: percentages.length > 0 ? Math.max(...percentages) : null,
    latestSubmittedAt: maxTimestamp(rosterSummary.map((row) => row.submittedAt)),
    latestFinalizedAt: maxTimestamp(rosterSummary.map((row) => row.finalizedAt)),
  };
}

async function readAssignmentItemAnalysis(
  db: D1Database,
  attemptResultIds: string[],
): Promise<InstructorAssignmentReportingItemRow[]> {
  if (attemptResultIds.length === 0) {
    return [];
  }

  const rows = await db
    .prepare(
      `SELECT result_items.attempt_result_id,
              results.attempt_id,
              results.total_score AS result_total_score,
              results.max_score AS result_max_score,
              result_items.item_id,
              result_items.item_identifier,
              result_items.item_title,
              result_items.item_position,
              result_items.answered,
              result_items.response_summary_text,
              result_items.score,
              result_items.max_score,
              result_items.score_amended
         FROM attempt_result_items result_items
         INNER JOIN attempt_results results
           ON results.id = result_items.attempt_result_id
        WHERE result_items.attempt_result_id IN (${attemptResultIds.map(() => "?").join(", ")})
        ORDER BY result_items.item_position ASC,
                 result_items.created_at ASC,
                 result_items.item_id ASC`,
    )
    .bind(...attemptResultIds)
    .all<ReportingItemResultRow>();

  const attemptIds = [...new Set(rows.results.map((row) => row.attempt_id).filter(Boolean))];
  const evidenceByItem = await readAssignmentItemEvidenceMetrics(db, attemptIds);
  const aggregateByItem = new Map<
    string,
    {
      itemId: string;
      itemIdentifier: string | null;
      itemTitle: string | null;
      itemPosition: number | null;
      answeredCount: number;
      skippedCount: number;
      scoredCount: number;
      fullCreditCount: number;
      amendedCount: number;
      totalScore: number;
      totalMaxScore: number;
      maxScore: number | null;
      itemScoreFractions: number[];
      discriminationPairs: Array<{
        itemFraction: number;
        totalFraction: number;
      }>;
      responseDistribution: Map<
        string,
        {
          responseSummary: string;
          responseCount: number;
          totalScore: number;
          totalMaxScore: number;
          scoredCount: number;
          fullCreditCount: number;
        }
      >;
    }
  >();

  for (const row of rows.results) {
    const current = aggregateByItem.get(row.item_id) ?? {
      itemId: row.item_id,
      itemIdentifier: row.item_identifier,
      itemTitle: row.item_title,
      itemPosition: row.item_position,
      answeredCount: 0,
      skippedCount: 0,
      scoredCount: 0,
      fullCreditCount: 0,
      amendedCount: 0,
      totalScore: 0,
      totalMaxScore: 0,
      maxScore: null,
      itemScoreFractions: [] as number[],
      discriminationPairs: [] as Array<{
        itemFraction: number;
        totalFraction: number;
      }>,
      responseDistribution: new Map(),
    };

    current.itemIdentifier ??= row.item_identifier;
    current.itemTitle ??= row.item_title;
    current.itemPosition ??= row.item_position;

    if (row.answered === 1) {
      current.answeredCount += 1;
    } else {
      current.skippedCount += 1;
    }

    if (row.score_amended === 1) {
      current.amendedCount += 1;
    }

    if (row.score !== null && row.max_score !== null) {
      current.scoredCount += 1;
      current.totalScore += row.score;
      current.totalMaxScore += row.max_score;
      current.maxScore =
        current.maxScore === null ? row.max_score : Math.max(current.maxScore, row.max_score);
      if (row.max_score > 0 && row.score >= row.max_score) {
        current.fullCreditCount += 1;
      }
      if (row.max_score > 0) {
        const itemFraction = row.score / row.max_score;
        current.itemScoreFractions.push(itemFraction);
        const totalFraction = calculateDiscriminationTotalFraction(row);
        if (totalFraction !== null) {
          current.discriminationPairs.push({
            itemFraction,
            totalFraction,
          });
        }
      }
    }

    const responseSummary = normalizeResponseDistributionLabel(row);
    const distribution = current.responseDistribution.get(responseSummary) ?? {
      responseSummary,
      responseCount: 0,
      totalScore: 0,
      totalMaxScore: 0,
      scoredCount: 0,
      fullCreditCount: 0,
    };
    distribution.responseCount += 1;
    if (row.score !== null && row.max_score !== null) {
      distribution.scoredCount += 1;
      distribution.totalScore += row.score;
      distribution.totalMaxScore += row.max_score;
      if (row.max_score > 0 && row.score >= row.max_score) {
        distribution.fullCreditCount += 1;
      }
    }
    current.responseDistribution.set(responseSummary, distribution);

    aggregateByItem.set(row.item_id, current);
  }

  return [...aggregateByItem.values()]
    .map((row) => {
      const evidence = evidenceByItem.get(row.itemId);
      return {
        itemId: row.itemId,
        itemIdentifier: row.itemIdentifier,
        itemTitle: row.itemTitle,
        itemPosition: row.itemPosition,
        answeredCount: row.answeredCount,
        skippedCount: row.skippedCount,
        scoredCount: row.scoredCount,
        fullCreditCount: row.fullCreditCount,
        amendedCount: row.amendedCount,
        averageScore:
          row.scoredCount > 0 ? roundReportingMetric(row.totalScore / row.scoredCount) : null,
        maxScore: row.maxScore,
        averagePercent:
          row.totalMaxScore > 0
            ? roundReportingMetric((row.totalScore / row.totalMaxScore) * 100)
            : null,
        pValue:
          row.itemScoreFractions.length > 0
            ? roundReportingMetric(average(row.itemScoreFractions))
            : null,
        discriminationIndex: calculateDiscriminationIndex(row.discriminationPairs),
        responseDistribution: buildResponseDistributionRows(row),
        averageTimeOnItemSeconds:
          evidence && evidence.timeOnItemSampleCount > 0
            ? roundReportingMetric(evidence.totalTimeOnItemSeconds / evidence.timeOnItemSampleCount)
            : null,
        timeOnItemSampleCount: evidence?.timeOnItemSampleCount ?? 0,
        changedAnswerCount: evidence?.changedAnswerCount ?? 0,
        averageResponseChangeCount:
          evidence && evidence.responseChangeSampleCount > 0
            ? roundReportingMetric(
                evidence.totalResponseChangeCount / evidence.responseChangeSampleCount,
              )
            : null,
      };
    })
    .sort(compareItemAnalysisRows);
}

async function readAssignmentItemEvidenceMetrics(
  db: D1Database,
  attemptIds: string[],
): Promise<
  Map<
    string,
    {
      totalTimeOnItemSeconds: number;
      timeOnItemSampleCount: number;
      changedAnswerCount: number;
      totalResponseChangeCount: number;
      responseChangeSampleCount: number;
    }
  >
> {
  const uniqueAttemptIds = [...new Set(attemptIds)];
  if (uniqueAttemptIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT attempt_id,
              item_id,
              evidence_kind,
              event_type,
              sequence_number,
              client_timestamp,
              server_timestamp
         FROM attempt_evidence_events
        WHERE attempt_id IN (${uniqueAttemptIds.map(() => "?").join(", ")})
          AND item_id IS NOT NULL
          AND evidence_kind IN (?, ?, ?)
        ORDER BY attempt_id ASC,
                 item_id ASC,
                 sequence_number ASC,
                 created_at ASC,
                 id ASC`,
    )
    .bind(...uniqueAttemptIds, "item-presentation", "response", "item-lifecycle")
    .all<ReportingItemEvidenceRow>();

  const byAttemptItem = new Map<
    string,
    {
      itemId: string;
      firstTimestampMs: number | null;
      latestTimestampMs: number | null;
      responseChangeCount: number;
    }
  >();

  for (const row of rows.results) {
    const timestampMs =
      parseEvidenceTimestamp(row.client_timestamp) ?? parseEvidenceTimestamp(row.server_timestamp);
    const key = `${row.attempt_id}\u0000${row.item_id}`;
    const current = byAttemptItem.get(key) ?? {
      itemId: row.item_id,
      firstTimestampMs: null,
      latestTimestampMs: null,
      responseChangeCount: 0,
    };

    if (timestampMs !== null) {
      current.firstTimestampMs =
        current.firstTimestampMs === null
          ? timestampMs
          : Math.min(current.firstTimestampMs, timestampMs);
      current.latestTimestampMs =
        current.latestTimestampMs === null
          ? timestampMs
          : Math.max(current.latestTimestampMs, timestampMs);
    }

    if (row.evidence_kind === "response" || row.event_type === "response.changed") {
      current.responseChangeCount += 1;
    }

    byAttemptItem.set(key, current);
  }

  const byItem = new Map<
    string,
    {
      totalTimeOnItemSeconds: number;
      timeOnItemSampleCount: number;
      changedAnswerCount: number;
      totalResponseChangeCount: number;
      responseChangeSampleCount: number;
    }
  >();

  for (const attemptItem of byAttemptItem.values()) {
    const current = byItem.get(attemptItem.itemId) ?? {
      totalTimeOnItemSeconds: 0,
      timeOnItemSampleCount: 0,
      changedAnswerCount: 0,
      totalResponseChangeCount: 0,
      responseChangeSampleCount: 0,
    };

    if (
      attemptItem.firstTimestampMs !== null &&
      attemptItem.latestTimestampMs !== null &&
      attemptItem.latestTimestampMs > attemptItem.firstTimestampMs
    ) {
      current.totalTimeOnItemSeconds +=
        (attemptItem.latestTimestampMs - attemptItem.firstTimestampMs) / 1000;
      current.timeOnItemSampleCount += 1;
    }

    if (attemptItem.responseChangeCount > 0) {
      current.totalResponseChangeCount += attemptItem.responseChangeCount;
      current.responseChangeSampleCount += 1;
      if (attemptItem.responseChangeCount > 1) {
        current.changedAnswerCount += 1;
      }
    }

    byItem.set(attemptItem.itemId, current);
  }

  return byItem;
}

function calculateDiscriminationTotalFraction(row: ReportingItemResultRow): number | null {
  if (row.result_total_score === null || row.result_max_score === null) {
    return null;
  }

  const itemScore = row.score ?? 0;
  const itemMaxScore = row.max_score ?? 0;
  const adjustedScore = row.result_total_score - itemScore;
  const adjustedMaxScore = row.result_max_score - itemMaxScore;

  if (adjustedMaxScore > 0) {
    return adjustedScore / adjustedMaxScore;
  }

  return row.result_max_score > 0 ? row.result_total_score / row.result_max_score : null;
}

function calculateDiscriminationIndex(
  pairs: Array<{ itemFraction: number; totalFraction: number }>,
): number | null {
  if (pairs.length < 2) {
    return null;
  }

  const sorted = [...pairs].sort((left, right) => right.totalFraction - left.totalFraction);
  const groupSize = Math.max(1, Math.ceil(sorted.length * 0.27));
  const upper = sorted.slice(0, groupSize).map((pair) => pair.itemFraction);
  const lower = sorted.slice(-groupSize).map((pair) => pair.itemFraction);

  return roundReportingMetric(average(upper) - average(lower));
}

function buildResponseDistributionRows(row: {
  answeredCount: number;
  skippedCount: number;
  responseDistribution: Map<
    string,
    {
      responseSummary: string;
      responseCount: number;
      totalScore: number;
      totalMaxScore: number;
      scoredCount: number;
      fullCreditCount: number;
    }
  >;
}): InstructorAssignmentReportingItemRow["responseDistribution"] {
  const totalResponses = row.answeredCount + row.skippedCount;
  return [...row.responseDistribution.values()]
    .map((entry) => {
      const averagePercent =
        entry.totalMaxScore > 0
          ? roundReportingMetric((entry.totalScore / entry.totalMaxScore) * 100)
          : null;
      const responsePercent =
        totalResponses > 0 ? roundReportingMetric((entry.responseCount / totalResponses) * 100) : 0;
      return {
        responseSummary: entry.responseSummary,
        responseCount: entry.responseCount,
        responsePercent,
        averageScore:
          entry.scoredCount > 0 ? roundReportingMetric(entry.totalScore / entry.scoredCount) : null,
        averagePercent,
        fullCreditCount: entry.fullCreditCount,
        distractorSignal: readDistractorSignal({
          responsePercent,
          averagePercent,
          fullCreditCount: entry.fullCreditCount,
          scoredCount: entry.scoredCount,
        }),
      };
    })
    .sort((left, right) => {
      if (left.responseCount !== right.responseCount) {
        return right.responseCount - left.responseCount;
      }
      return left.responseSummary.localeCompare(right.responseSummary);
    });
}

function readDistractorSignal(input: {
  responsePercent: number;
  averagePercent: number | null;
  fullCreditCount: number;
  scoredCount: number;
}): InstructorAssignmentDistractorSignal {
  if (input.scoredCount === 0 || input.averagePercent === null) {
    return "unscored";
  }
  if (input.fullCreditCount > 0 && input.averagePercent >= 95) {
    return "full-credit";
  }
  if (input.responsePercent >= 20 && input.averagePercent < 50) {
    return "attractive-distractor";
  }
  if (input.responsePercent < 10) {
    return "low-frequency";
  }
  return "mixed";
}

function normalizeResponseDistributionLabel(row: ReportingItemResultRow): string {
  if (row.answered !== 1) {
    return "(skipped)";
  }

  const summary = row.response_summary_text?.trim();
  return summary ? summary : "(blank)";
}

function parseEvidenceTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

async function readAssignmentStandardsMastery(input: {
  db: D1Database;
  assessmentVersionId: string;
  attemptResultIds: string[];
}): Promise<InstructorAssignmentReportingResponse["standardsMastery"]> {
  const resultFilter =
    input.attemptResultIds.length > 0
      ? `AND result_items.attempt_result_id IN (${input.attemptResultIds.map(() => "?").join(", ")})`
      : "AND 1 = 0";

  const rows = await input.db
    .prepare(
      `WITH aligned_result_items AS (
         SELECT alignments.standard_id,
                alignments.standard_code,
                alignments.standard_label,
                alignments.item_id,
                result_items.attempt_result_id,
                CASE
                  WHEN result_items.max_score > 0 AND result_items.score IS NOT NULL
                    THEN (result_items.score / result_items.max_score) * 100
                  ELSE NULL
                END AS item_percent
           FROM assessment_item_standard_alignments alignments
           LEFT JOIN attempt_result_items result_items
             ON result_items.item_id = alignments.item_id
            ${resultFilter}
          WHERE alignments.assessment_version_id = ?
       ),
       item_scores AS (
         SELECT standard_id,
                item_id,
                AVG(item_percent) AS item_average_percent
           FROM aligned_result_items
          GROUP BY standard_id, item_id
       ),
       standard_scores AS (
         SELECT standard_id,
                standard_code,
                standard_label,
                COUNT(DISTINCT item_id) AS item_count,
                COUNT(DISTINCT attempt_result_id) AS scored_attempt_count,
                AVG(item_percent) AS average_percent
           FROM aligned_result_items
          GROUP BY standard_id, standard_code, standard_label
       ),
       weakness AS (
         SELECT standard_id,
                COUNT(
                  CASE
                    WHEN item_average_percent < 60 THEN 1
                    ELSE NULL
                  END
                ) AS weak_item_count,
                MIN(item_average_percent) AS weakest_item_average_percent
           FROM item_scores
          GROUP BY standard_id
       )
       SELECT standard_scores.standard_id,
              standard_scores.standard_code,
              standard_scores.standard_label,
              standard_scores.item_count,
              standard_scores.scored_attempt_count,
              standard_scores.average_percent,
              COALESCE(weakness.weak_item_count, 0) AS weak_item_count,
              weakness.weakest_item_average_percent
         FROM standard_scores
         LEFT JOIN weakness
           ON weakness.standard_id = standard_scores.standard_id
        ORDER BY COALESCE(standard_scores.standard_code, standard_scores.standard_id) ASC`,
    )
    .bind(...input.attemptResultIds, input.assessmentVersionId)
    .all<ReportingStandardRow>();

  return {
    metadataAvailable: rows.results.length > 0,
    rows: rows.results.map((row) => ({
      standardId: row.standard_id,
      label: row.standard_label ?? row.standard_code ?? row.standard_id,
      itemCount: row.item_count,
      scoredAttemptCount: row.scored_attempt_count,
      averagePercent:
        row.average_percent === null ? null : roundReportingMetric(row.average_percent),
      weakItemCount: row.weak_item_count,
      weakestItemAveragePercent:
        row.weakest_item_average_percent === null
          ? null
          : roundReportingMetric(row.weakest_item_average_percent),
      weaknessSignal: readStandardWeaknessSignal(row.average_percent),
    })),
  };
}

function readStandardWeaknessSignal(
  averagePercent: number | null,
): InstructorAssignmentStandardWeaknessSignal {
  if (averagePercent === null) {
    return "insufficient-data";
  }
  if (averagePercent < 60) {
    return "weak";
  }
  if (averagePercent < 75) {
    return "watch";
  }
  return "ok";
}

function compareItemAnalysisRows(
  left: InstructorAssignmentReportingItemRow,
  right: InstructorAssignmentReportingItemRow,
): number {
  if (left.itemPosition !== right.itemPosition) {
    if (left.itemPosition === null) {
      return 1;
    }
    if (right.itemPosition === null) {
      return -1;
    }
    return left.itemPosition - right.itemPosition;
  }

  return left.itemId.localeCompare(right.itemId);
}
