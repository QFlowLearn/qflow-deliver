import type {
  InstructorAssignmentReportingResponse,
  InstructorAssignmentReportingItemRow,
  InstructorAssignmentReportingRosterRow,
  InstructorLearnerReportResponse,
  ReportDataDictionaryRow,
  ReportExportCatalogEntry,
} from "@harbor/attempt-protocol";
import { INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS } from "@harbor/attempt-protocol";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import { buildCsv, formatCsvNumber } from "./csv";

export const REPORT_DATA_DICTIONARY_VERSION = "2026-07-21";

export const ROSTER_CSV_HEADERS = [
  "learner_id",
  "display_name",
  "email",
  "target_source",
  "attempt_id",
  "result_status",
  "total_score",
  "max_score",
  "percent_score",
  "submitted_at",
  "finalized_at",
  "score_amended",
] as const;

export const ITEM_ANALYSIS_CSV_HEADERS = [
  "item_id",
  "item_identifier",
  "item_title",
  "item_position",
  "answered_count",
  "skipped_count",
  "scored_count",
  "full_credit_count",
  "amended_count",
  "average_score",
  "max_score",
  "average_percent",
  "p_value",
  "discrimination_index",
  "response_distribution",
  "top_response",
  "top_response_percent",
  "average_time_on_item_seconds",
  "time_on_item_sample_count",
  "changed_answer_count",
  "average_response_change_count",
] as const;

export const STANDARDS_MASTERY_CSV_HEADERS = [
  "standard_id",
  "label",
  "item_count",
  "scored_attempt_count",
  "average_percent",
  "weak_item_count",
  "weakest_item_average_percent",
  "weakness_signal",
] as const;

export const LEARNER_ITEMS_CSV_HEADERS = [
  "learner_id",
  "display_name",
  "attempt_id",
  "item_id",
  "item_identifier",
  "item_title",
  "item_position",
  "answered",
  "response_summary",
  "score",
  "max_score",
  "percent_score",
  "score_amended",
  "standards",
] as const;

export const LEARNER_EVIDENCE_CSV_HEADERS = [
  "learner_id",
  "display_name",
  "attempt_id",
  "event_type",
  "evidence_kind",
  "outcome",
  "sequence_number",
  "item_id",
  "response_key",
  "client_timestamp",
  "server_timestamp",
  "receipt_id",
  "event_source",
  "sync_signals",
  "support",
  "support_state",
  "requested_language",
  "resolved_language",
  "selection_reason",
  "catalog_ids",
  "asset_references",
  "media_types",
  "control",
  "reason",
] as const;

export const LEARNER_ATTEMPTS_CSV_HEADERS = [
  "learner_id",
  "display_name",
  "attempt_id",
  "status",
  "result_status",
  "total_score",
  "max_score",
  "percent_score",
  "launched_at",
  "submitted_at",
  "finalized_at",
  "item_presentations",
  "responses",
  "submits",
  "flagged_events",
  "queued_locally_events",
  "replayed_events",
  "stale_tab_reconciled_events",
  "receipt_confirmed_events",
  "sync_failed_events",
  ...INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS.map(({ csvColumn }) => csvColumn),
  "latest_keyword_translation_requested_language",
  "latest_keyword_translation_resolved_language",
  "accommodation_profiles",
  "accommodation_profile_assignments",
  "accommodation_assignment_override_id",
  "accommodation_pnp",
  "accommodation_shell_tools",
  "accommodation_extra_time_seconds",
  "accommodation_effective_time_limit_seconds",
  "accommodation_color_theme",
  "accommodation_masking",
  "accommodation_tts_read_aloud",
  "accommodation_captions",
  "accommodation_transcripts",
  "accommodation_calculator",
  "accommodation_notes",
  "score_revision",
] as const;

export const SCORE_HISTORY_CSV_HEADERS = [
  "learner_id",
  "display_name",
  "attempt_id",
  "revision_id",
  "revision_number",
  "previous_total_score",
  "previous_max_score",
  "amended_total_score",
  "amended_max_score",
  "reason",
  "created_by",
  "created_at",
  "application_count",
  "amendment_ids",
] as const;

export const SCORE_AMENDMENT_EVIDENCE_CSV_HEADERS = [
  "assignment_id",
  "amendment_id",
  "amendment_status",
  "amendment_action",
  "item_id",
  "response_match_text",
  "revision_id",
  "revision_number",
  "attempt_id",
  "response_summary",
  "response_evidence_event_id",
  "response_evidence_sequence_number",
  "response_evidence_server_timestamp",
  "base_score",
  "base_max_score",
  "previous_score",
  "previous_max_score",
  "amended_score",
  "amended_max_score",
  "reason",
  "created_by",
  "created_at",
  "applied_at",
] as const;

export const DATA_DICTIONARY_CSV_HEADERS = [
  "artifact_name",
  "column_name",
  "display_label",
  "type",
  "nullable",
  "definition",
  "source",
  "sensitivity",
  "example",
  "version_introduced",
] as const;

export const REPORT_EXPORT_CATALOG: ReportExportCatalogEntry[] = [
  {
    artifactType: "roster-csv",
    scopeKind: "assessment-administration",
    label: "Roster CSV",
    description: "Latest learner roster, attempt, result, and score status.",
    filename: "roster.csv",
    contentType: "text/csv;charset=utf-8",
    directDownload: true,
    bundled: true,
  },
  {
    artifactType: "item-analysis-csv",
    scopeKind: "assessment-administration",
    label: "Item Analysis CSV",
    description:
      "Classical item analytics: response distribution, p-value, discrimination, timing, skipped, changed, score, and amendment counts by item.",
    filename: "item_analysis.csv",
    contentType: "text/csv;charset=utf-8",
    directDownload: true,
    bundled: true,
  },
  {
    artifactType: "standards-mastery-csv",
    scopeKind: "assessment-administration",
    label: "Standards Mastery CSV",
    description: "Average mastery by imported standard alignment.",
    filename: "standards_mastery.csv",
    contentType: "text/csv;charset=utf-8",
    directDownload: true,
    bundled: true,
  },
  {
    artifactType: "learner-report-json",
    scopeKind: "learner",
    label: "Learner Report",
    description: "Ledger-backed individual learner report projection.",
    filename: "learner_report.json",
    contentType: "application/json;charset=utf-8",
    directDownload: false,
    bundled: true,
  },
  {
    artifactType: "learner-items-csv",
    scopeKind: "learner",
    label: "Learner Item Results CSV",
    description: "Latest item-level learner results with standards labels.",
    filename: "learner_items.csv",
    contentType: "text/csv;charset=utf-8",
    directDownload: true,
    bundled: true,
  },
  {
    artifactType: "learner-evidence-csv",
    scopeKind: "learner",
    label: "Learner Evidence CSV",
    description: "Attempt evidence events for the selected learner.",
    filename: "learner_evidence.csv",
    contentType: "text/csv;charset=utf-8",
    directDownload: true,
    bundled: true,
  },
  {
    artifactType: "result-export-bundle",
    scopeKind: "assessment-administration",
    label: "Result Export Bundle",
    description:
      "ZIP bundle with manifest, roster, analysis, learner rows, evidence, and dictionary.",
    filename: "result_export_bundle.zip",
    contentType: "application/zip",
    directDownload: true,
    bundled: false,
  },
  {
    artifactType: "data-dictionary-csv",
    scopeKind: "assessment-administration",
    label: "Data Dictionary",
    description: "Column definitions, lineage, and sensitivity labels for export artifacts.",
    filename: "data_dictionary.csv",
    contentType: "text/csv;charset=utf-8",
    directDownload: true,
    bundled: true,
  },
];

export const REPORT_DATA_DICTIONARY_ROWS: ReportDataDictionaryRow[] = [
  ...defineDictionaryRows(
    "roster.csv",
    ROSTER_CSV_HEADERS,
    "assignment roster and reporting projections",
  ),
  ...defineDictionaryRows(
    "item_analysis.csv",
    ITEM_ANALYSIS_CSV_HEADERS,
    "attempt_result_items and assessment item metadata",
  ),
  ...defineDictionaryRows(
    "standards_mastery.csv",
    STANDARDS_MASTERY_CSV_HEADERS,
    "assessment item standards alignments and scored result rows",
  ),
  ...defineDictionaryRows(
    "learner_items.csv",
    LEARNER_ITEMS_CSV_HEADERS,
    "learner report item result projection",
  ),
  ...defineDictionaryRows(
    "learner_evidence.csv",
    LEARNER_EVIDENCE_CSV_HEADERS,
    "attempt evidence events",
  ),
  ...defineDictionaryRows(
    "learner_attempts.csv",
    LEARNER_ATTEMPTS_CSV_HEADERS,
    "attempt, finalization, result, evidence, and accommodation projections",
  ),
  ...defineDictionaryRows(
    "attempts.csv",
    LEARNER_ATTEMPTS_CSV_HEADERS,
    "assignment-level learner attempt projections",
  ),
  ...defineDictionaryRows(
    "item_results.csv",
    LEARNER_ITEMS_CSV_HEADERS,
    "assignment-level learner item result projections",
  ),
  ...defineDictionaryRows(
    "evidence.csv",
    LEARNER_EVIDENCE_CSV_HEADERS,
    "assignment-level attempt evidence events",
  ),
  ...defineDictionaryRows("score_history.csv", SCORE_HISTORY_CSV_HEADERS, "score revision ledger"),
  ...defineDictionaryRows(
    "score_amendments.csv",
    SCORE_AMENDMENT_EVIDENCE_CSV_HEADERS,
    "score amendment and application ledgers",
  ),
  ...defineDictionaryRows(
    "data_dictionary.csv",
    DATA_DICTIONARY_CSV_HEADERS,
    "report export dictionary registry",
  ),
];

export function buildAssignmentReportingCsv(
  report: InstructorAssignmentReportingResponse,
  exportType: string,
): string {
  if (exportType === "items" || exportType === "item-analysis") {
    return buildAssignmentItemAnalysisCsv(report.itemAnalysis);
  }

  if (exportType === "standards" || exportType === "standards-mastery") {
    return buildAssignmentStandardsMasteryCsv(report.standardsMastery.rows);
  }

  if (exportType === "roster") {
    return buildAssignmentRosterSummaryCsv(report.rosterSummary);
  }

  throw new LaunchRequestError(400, "reporting CSV type must be roster, items, or standards");
}

export function buildAssignmentRosterSummaryCsv(
  rows: InstructorAssignmentReportingRosterRow[],
): string {
  return buildCsv([
    [...ROSTER_CSV_HEADERS],
    ...rows.map((row) => [
      row.learner.id,
      row.learner.displayName,
      row.learner.email ?? "",
      row.targetSource,
      row.latestAttemptId ?? "",
      row.resultStatus ?? "",
      formatCsvNumber(row.totalScore),
      formatCsvNumber(row.maxScore),
      formatCsvNumber(row.percentScore),
      row.submittedAt ?? "",
      row.finalizedAt ?? "",
      row.scoreAmended ? "true" : "false",
    ]),
  ]);
}

export function buildAssignmentItemAnalysisCsv(
  rows: InstructorAssignmentReportingItemRow[],
): string {
  return buildCsv([
    [...ITEM_ANALYSIS_CSV_HEADERS],
    ...rows.map((row) => [
      row.itemId,
      row.itemIdentifier ?? "",
      row.itemTitle ?? "",
      formatCsvNumber(row.itemPosition),
      String(row.answeredCount),
      String(row.skippedCount),
      String(row.scoredCount),
      String(row.fullCreditCount),
      String(row.amendedCount),
      formatCsvNumber(row.averageScore),
      formatCsvNumber(row.maxScore),
      formatCsvNumber(row.averagePercent),
      formatCsvNumber(row.pValue),
      formatCsvNumber(row.discriminationIndex),
      formatResponseDistribution(row),
      row.responseDistribution[0]?.responseSummary ?? "",
      formatCsvNumber(row.responseDistribution[0]?.responsePercent ?? null),
      formatCsvNumber(row.averageTimeOnItemSeconds),
      String(row.timeOnItemSampleCount),
      String(row.changedAnswerCount),
      formatCsvNumber(row.averageResponseChangeCount),
    ]),
  ]);
}

export function buildAssignmentStandardsMasteryCsv(
  rows: InstructorAssignmentReportingResponse["standardsMastery"]["rows"],
): string {
  return buildCsv([
    [...STANDARDS_MASTERY_CSV_HEADERS],
    ...rows.map((row) => [
      row.standardId,
      row.label,
      String(row.itemCount),
      String(row.scoredAttemptCount),
      formatCsvNumber(row.averagePercent),
      String(row.weakItemCount),
      formatCsvNumber(row.weakestItemAveragePercent),
      row.weaknessSignal,
    ]),
  ]);
}

function formatResponseDistribution(row: InstructorAssignmentReportingItemRow): string {
  return row.responseDistribution
    .map(
      (entry) =>
        `${entry.responseSummary}: ${entry.responseCount} (${formatCsvNumber(entry.responsePercent)}%, ${entry.distractorSignal})`,
    )
    .join("; ");
}

export function buildLearnerReportCsv(
  report: InstructorLearnerReportResponse,
  exportType: string,
): string {
  if (exportType === "items" || exportType === "item-results") {
    return buildLearnerReportItemsCsv(report);
  }

  if (exportType === "evidence") {
    return buildLearnerReportEvidenceCsv(report);
  }

  if (exportType === "attempts") {
    return buildLearnerReportAttemptsCsv(report);
  }

  throw new LaunchRequestError(400, "learner report CSV type must be items, evidence, or attempts");
}

export function buildLearnerReportItemsCsv(report: InstructorLearnerReportResponse): string {
  return buildCsv([[...LEARNER_ITEMS_CSV_HEADERS], ...buildLearnerReportItemRows(report)]);
}

export function buildLearnerReportEvidenceCsv(report: InstructorLearnerReportResponse): string {
  return buildCsv([[...LEARNER_EVIDENCE_CSV_HEADERS], ...buildLearnerReportEvidenceRows(report)]);
}

export function buildLearnerReportAttemptsCsv(report: InstructorLearnerReportResponse): string {
  return buildCsv([[...LEARNER_ATTEMPTS_CSV_HEADERS], ...buildLearnerReportAttemptRows(report)]);
}

export function buildAssignmentItemResultsCsv(reports: InstructorLearnerReportResponse[]): string {
  return buildCsv([
    [...LEARNER_ITEMS_CSV_HEADERS],
    ...reports.flatMap((report) => buildLearnerReportItemRows(report)),
  ]);
}

export function buildAssignmentEvidenceCsv(reports: InstructorLearnerReportResponse[]): string {
  return buildCsv([
    [...LEARNER_EVIDENCE_CSV_HEADERS],
    ...reports.flatMap((report) => buildLearnerReportEvidenceRows(report)),
  ]);
}

export function buildAssignmentAttemptsCsv(reports: InstructorLearnerReportResponse[]): string {
  return buildCsv([
    [...LEARNER_ATTEMPTS_CSV_HEADERS],
    ...reports.flatMap((report) => buildLearnerReportAttemptRows(report)),
  ]);
}

export function buildAssignmentScoreHistoryCsv(reports: InstructorLearnerReportResponse[]): string {
  return buildCsv([
    [...SCORE_HISTORY_CSV_HEADERS],
    ...reports.flatMap((report) =>
      report.scoreHistory.map((revision) => [
        report.learner.id,
        report.learner.displayName,
        revision.attemptId,
        revision.revisionId,
        String(revision.revisionNumber),
        formatCsvNumber(revision.previousTotalScore),
        formatCsvNumber(revision.previousMaxScore),
        formatCsvNumber(revision.amendedTotalScore),
        formatCsvNumber(revision.amendedMaxScore),
        revision.reason,
        revision.createdBy.displayName ?? revision.createdBy.actorId,
        revision.createdAt,
        String(revision.applications.length),
        revision.amendmentIds.join("; "),
      ]),
    ),
  ]);
}

export function buildDataDictionaryCsv(
  rows: ReportDataDictionaryRow[] = REPORT_DATA_DICTIONARY_ROWS,
): string {
  return buildCsv([
    [...DATA_DICTIONARY_CSV_HEADERS],
    ...rows.map((row) => [
      row.artifactName,
      row.columnName,
      row.displayLabel,
      row.fieldType,
      row.nullable ? "true" : "false",
      row.definition,
      row.source,
      row.sensitivity,
      row.example,
      row.introducedIn,
    ]),
  ]);
}

function buildLearnerReportItemRows(report: InstructorLearnerReportResponse) {
  return report.itemResults.map((row) => [
    report.learner.id,
    report.learner.displayName,
    report.latestResult?.attemptId ?? "",
    row.itemId,
    row.itemIdentifier ?? "",
    row.itemTitle ?? "",
    formatCsvNumber(row.itemPosition),
    row.answered ? "true" : "false",
    row.responseSummary ?? "",
    formatCsvNumber(row.score),
    formatCsvNumber(row.maxScore),
    formatCsvNumber(row.percentScore),
    row.scoreAmended ? "true" : "false",
    row.standards.map((standard) => standard.label).join("; "),
  ]);
}

function buildLearnerReportEvidenceRows(report: InstructorLearnerReportResponse) {
  return report.evidence.events.map((event) => [
    report.learner.id,
    report.learner.displayName,
    event.attemptId,
    event.eventType,
    event.evidenceKind,
    event.outcome,
    formatCsvNumber(event.sequenceNumber),
    event.itemId ?? "",
    event.responseKey ?? "",
    event.clientTimestamp ?? "",
    event.serverTimestamp,
    event.receiptId ?? "",
    event.eventSource,
    event.syncSignals.join("; "),
    event.support ?? "",
    event.supportState ?? "",
    event.requestedLanguage ?? "",
    event.resolvedLanguage ?? "",
    event.selectionReason ?? "",
    event.catalogIds.join("; "),
    event.assetReferences.join("; "),
    event.mediaTypes.join("; "),
    event.control ?? "",
    event.reason ?? "",
  ]);
}

function buildLearnerReportAttemptRows(report: InstructorLearnerReportResponse) {
  return report.attempts.map((attempt) => [
    report.learner.id,
    report.learner.displayName,
    attempt.attemptId,
    attempt.status,
    attempt.resultStatus ?? "",
    formatCsvNumber(attempt.totalScore),
    formatCsvNumber(attempt.maxScore),
    formatCsvNumber(attempt.percentScore),
    attempt.launchedAt,
    attempt.submittedAt ?? "",
    attempt.finalizedAt ?? "",
    String(attempt.evidenceSummary.itemPresentationCount),
    String(attempt.evidenceSummary.responseCount),
    String(attempt.evidenceSummary.submitCount),
    String(attempt.evidenceSummary.flaggedCount),
    String(attempt.evidenceSummary.queuedLocallyCount),
    String(attempt.evidenceSummary.replayedCount),
    String(attempt.evidenceSummary.staleTabReconciledCount),
    String(attempt.evidenceSummary.receiptConfirmedCount),
    String(attempt.evidenceSummary.syncFailedCount),
    ...INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS.map(({ summaryField }) =>
      String(attempt.evidenceSummary[summaryField]),
    ),
    attempt.evidenceSummary.latestKeywordTranslationRequestedLanguage ?? "",
    attempt.evidenceSummary.latestKeywordTranslationResolvedLanguage ?? "",
    ...buildAccommodationAttemptCsvFields(attempt.accommodationSnapshot),
    attempt.latestScoreRevision?.revisionNumber.toString() ?? "",
  ]);
}

function buildAccommodationAttemptCsvFields(
  snapshot: InstructorLearnerReportResponse["attempts"][number]["accommodationSnapshot"],
): string[] {
  const summary = snapshot?.summary;
  return [
    snapshot?.profileIds.join("; ") ?? "",
    snapshot?.learnerProfileAssignmentIds.join("; ") ?? "",
    snapshot?.assignmentOverrideId ?? "",
    summary?.pnp.join("; ") ?? "",
    summary?.shellTools.join("; ") ?? "",
    formatCsvNumber(summary?.extraTimeSeconds ?? null),
    formatCsvNumber(summary?.effectiveTimeLimitSeconds ?? null),
    summary?.colorTheme ?? "",
    formatCsvBoolean(summary?.masking),
    formatCsvBoolean(summary?.ttsReadAloud),
    formatCsvBoolean(summary?.captions),
    formatCsvBoolean(summary?.transcripts),
    summary?.calculator ?? "",
    formatCsvBoolean(summary?.notes),
  ];
}

function defineDictionaryRows(
  artifactName: string,
  columns: readonly string[],
  source: string,
): ReportDataDictionaryRow[] {
  return columns.map((columnName) => {
    const evidenceProjection = INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS.find(
      (projection) => projection.csvColumn === columnName,
    );
    return {
      artifactName,
      columnName,
      displayLabel: evidenceProjection?.displayLabel ?? formatColumnLabel(columnName),
      fieldType: evidenceProjection ? "number" : inferFieldType(columnName),
      nullable:
        !columnName.endsWith("_id") ||
        columnName === "attempt_id" ||
        columnName.startsWith("accommodation_"),
      definition: evidenceProjection?.definition ?? defineColumn(columnName),
      source,
      sensitivity: evidenceProjection ? "sensitive" : inferSensitivity(columnName),
      example: exampleValue(columnName),
      introducedIn: REPORT_DATA_DICTIONARY_VERSION,
    };
  });
}

function formatColumnLabel(columnName: string): string {
  return columnName
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferFieldType(columnName: string): ReportDataDictionaryRow["fieldType"] {
  if (
    columnName.endsWith("_at") ||
    columnName.endsWith("_timestamp") ||
    columnName === "client_timestamp" ||
    columnName === "server_timestamp"
  ) {
    return "datetime";
  }
  if (
    columnName.endsWith("_count") ||
    columnName.endsWith("_score") ||
    columnName.endsWith("_percent") ||
    columnName.endsWith("_seconds") ||
    columnName === "revision_number" ||
    columnName === "sequence_number" ||
    columnName === "item_position" ||
    columnName === "p_value" ||
    columnName === "discrimination_index"
  ) {
    return "number";
  }
  if (
    columnName === "answered" ||
    columnName === "score_amended" ||
    columnName === "nullable" ||
    columnName === "accommodation_masking" ||
    columnName === "accommodation_tts_read_aloud" ||
    columnName === "accommodation_captions" ||
    columnName === "accommodation_transcripts" ||
    columnName === "accommodation_notes"
  ) {
    return "boolean";
  }
  return "string";
}

function inferSensitivity(columnName: string): ReportDataDictionaryRow["sensitivity"] {
  if (columnName === "display_name" || columnName === "email") {
    return "pii";
  }
  if (
    columnName.includes("response") ||
    columnName.includes("evidence") ||
    columnName.includes("accommodation")
  ) {
    return "sensitive";
  }
  return "none";
}

function defineColumn(columnName: string): string {
  const definitions: Record<string, string> = {
    learner_id: "QFlowLearn Delivery learner identifier scoped to the tenant.",
    display_name: "Learner display name from the roster identity record.",
    email: "Learner email address when present in roster data.",
    target_source: "Whether the learner was targeted directly or through section membership.",
    attempt_id: "QFlowLearn Delivery attempt identifier.",
    result_status: "Latest authoritative result state for the attempt.",
    total_score: "Total awarded score after active score revisions.",
    max_score: "Maximum score for the result or item.",
    percent_score: "Score divided by maximum score, expressed as a percentage.",
    submitted_at: "Timestamp when the attempt was submitted.",
    finalized_at: "Timestamp when result finalization completed.",
    score_amended: "Whether active score amendment logic affected the row.",
    accommodation_profiles:
      "Semicolon-delimited accommodation profile identifiers snapshotted at attempt launch.",
    accommodation_profile_assignments:
      "Semicolon-delimited learner accommodation assignment identifiers included in the launch snapshot.",
    accommodation_assignment_override_id:
      "Assignment learner override identifier included in the launch snapshot when present.",
    accommodation_pnp:
      "Semicolon-delimited renderer PNP and session-control evidence active for the attempt.",
    accommodation_shell_tools:
      "Semicolon-delimited shell accommodation tools active for the attempt.",
    accommodation_extra_time_seconds: "Additional time, in seconds, snapshotted for the attempt.",
    accommodation_effective_time_limit_seconds:
      "Effective attempt time limit, in seconds, after launch-time extra time was applied.",
    accommodation_color_theme: "qti3 color theme active in the renderer PNP snapshot.",
    accommodation_masking: "Whether answer masking was active in the attempt shell.",
    accommodation_tts_read_aloud:
      "Whether spoken (text-to-speech) read-aloud support was active in the attempt shell.",
    accommodation_captions: "Whether captions were active in the attempt shell.",
    accommodation_transcripts: "Whether transcripts were active in the attempt shell.",
    accommodation_calculator: "Calculator accommodation active in the attempt shell.",
    accommodation_notes: "Whether notes were active in the attempt shell.",
    item_id: "QFlowLearn Delivery item identifier from the immutable assessment version.",
    item_identifier: "Original item identifier when imported from package metadata.",
    item_title: "Item title from imported package or result metadata.",
    item_position: "Item position in the delivered assessment manifest.",
    p_value: "Average item score fraction across scored attempts, from 0 to 1.",
    discrimination_index: "Upper-minus-lower group item performance based on total score bands.",
    response_distribution:
      "Semicolon-delimited response counts, percentages, and distractor signals for the item.",
    top_response: "Most frequent response summary for the item.",
    top_response_percent: "Share of item responses represented by the top response.",
    average_time_on_item_seconds:
      "Average evidence-derived time between first and latest item event.",
    time_on_item_sample_count: "Number of attempt-item evidence spans used for time-on-item.",
    changed_answer_count: "Number of attempt-item records with more than one response event.",
    average_response_change_count:
      "Average response event count for attempts with item response evidence.",
    response_summary: "Display-safe summary of the learner response.",
    standards: "Semicolon-delimited standards labels aligned to the item.",
    standard_id: "Imported standard identifier.",
    label: "Human-readable standards label.",
    weak_item_count: "Count of aligned items with low-scoring evidence under the standard.",
    weakest_item_average_percent:
      "Lowest observed item percent contributing to the standard weakness signal.",
    weakness_signal: "Standard-level signal: insufficient-data, weak, watch, or ok.",
    event_type: "Attempt event type recorded by QFlowLearn Delivery.",
    evidence_kind: "Evidence category used for audit and reporting.",
    outcome: "Accepted, rejected, flagged, or observed event outcome.",
    receipt_id: "Durable receipt identifier when one was issued.",
    event_source: "Source that produced the evidence event.",
    sync_signals:
      "Semicolon-delimited delivery sync-health signals derived from local queue, replay, receipt, and reconciliation evidence.",
    support: "Accessibility support associated with an accommodation-support evidence event.",
    support_state: "Availability, learner action, or translated-media playback state.",
    requested_language: "Learner-requested keyword-translation language, when applicable.",
    resolved_language: "Catalog language resolved for delivered keyword-translation content.",
    selection_reason: "Catalog language resolution step, such as exact or primary-language.",
    catalog_ids: "Semicolon-delimited stable accessibility catalog identifiers.",
    asset_references:
      "Semicolon-delimited normalized package asset references; signed delivery URLs are excluded.",
    media_types: "Semicolon-delimited MIME types for referenced catalog assets.",
    control: "Learner control associated with the accessibility evidence event.",
    latest_keyword_translation_requested_language:
      "Most recently evidenced requested keyword-translation language.",
    latest_keyword_translation_resolved_language:
      "Most recently evidenced resolved keyword-translation language.",
    queued_locally_events: "Count of evidence events carrying a queued-locally sync-health signal.",
    replayed_events: "Count of evidence events replayed from local recovery storage.",
    stale_tab_reconciled_events:
      "Count of stale-tab reconciliation events recorded for the attempt.",
    receipt_confirmed_events: "Count of evidence events with confirmed durable receipts.",
    sync_failed_events:
      "Count of evidence events with terminal sync failure or sequence-gap signals.",
    revision_id: "Score revision identifier.",
    revision_number: "Monotonic revision number for the attempt result.",
    reason: "Instructor or system reason recorded for a scoring change.",
    created_by: "Actor display label that created the record.",
  };

  return (
    definitions[columnName] ??
    `${formatColumnLabel(columnName)} value emitted by the QFlowLearn Delivery report projection.`
  );
}

function exampleValue(columnName: string): string {
  if (columnName.endsWith("_at") || columnName.endsWith("_timestamp")) {
    return "2026-03-28T12:15:00.000Z";
  }
  if (columnName.endsWith("_count") || columnName.endsWith("_seconds")) {
    return "2";
  }
  if (columnName.endsWith("_percent")) {
    return "85";
  }
  if (columnName === "email") {
    return "learner@example.edu";
  }
  if (
    columnName === "score_amended" ||
    columnName === "answered" ||
    columnName === "accommodation_masking" ||
    columnName === "accommodation_tts_read_aloud" ||
    columnName === "accommodation_captions" ||
    columnName === "accommodation_transcripts" ||
    columnName === "accommodation_notes"
  ) {
    return "true";
  }
  return "";
}

function formatCsvBoolean(value: boolean | undefined): string {
  return value === undefined ? "" : String(value);
}
