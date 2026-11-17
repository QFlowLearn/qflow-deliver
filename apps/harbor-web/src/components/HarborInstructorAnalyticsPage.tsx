import { computed, onMounted, ref, useSetup, watch } from "@/lib/preact-reactivity";
import type { HarborPage } from "@/App";
import { useHarborRuntime } from "@/lib/harbor-runtime";
import type {
  RuntimeInstructorAssignmentReport,
  RuntimeResultsOpsRow,
} from "@/lib/runtime-session";

type ReportRosterRow = RuntimeInstructorAssignmentReport["rosterSummary"][number];
type ReportItemRow = RuntimeInstructorAssignmentReport["itemAnalysis"][number];
type MetricTone = "primary" | "secondary" | "warning" | "success" | "danger";

type MetricCard = {
  label: string;
  value: string;
  detail: string;
  signal: string;
  tone: MetricTone;
};

type ScoreDistributionBin = {
  label: string;
  count: number;
  height: string;
};

type EngagementRow = {
  id: string;
  title: string;
  value: string;
  detail: string;
  width: string;
  tone: "normal" | "warning";
};

export default function HarborInstructorAnalyticsPage(props: {
  navigateTo: (page: HarborPage) => void;
}) {
  const runtime = useHarborRuntime();
  const {
    exportInstructorAssignmentBundle,
    exportInstructorAssignmentReport,
    exportReportDataDictionary,
    instructorAssignmentReport,
    instructorReportingError,
    instructorReportingLoading,
    instructorResults,
    instructorRosterError,
    instructorRosterLoading,
    refreshInstructorWorkspace,
    refreshReportExportCatalog,
    refreshResultsOps,
    reportExportCatalog,
    reportExportError,
    reportExportLoading,
    resultsOpsError,
    resultsOpsLoading,
    resultsOpsRows,
    resultsOpsSummary,
    selectedInstructorAssignmentId,
    selectedInstructorAssignmentTitle,
  } = runtime;

  const state = useSetup(() => {
    const learnerSearch = ref("");
    const exportBusy = ref<"" | "roster" | "items" | "standards" | "bundle" | "dictionary">("");
    const selectedReport = computed(() => instructorAssignmentReport.value);
    const reportingSummary = computed(() => selectedReport.value?.summary ?? null);
    const totalLearners = computed(
      () =>
        reportingSummary.value?.targetedLearnerCount ??
        instructorResults.value?.summary.targetedLearnerCount ??
        0,
    );
    const submittedCount = computed(() => reportingSummary.value?.submittedAttemptCount ?? 0);
    const scoredCount = computed(
      () =>
        reportingSummary.value?.scoredAttemptCount ??
        instructorResults.value?.summary.completeCount ??
        0,
    );
    const activeLearnerCount = computed(
      () => instructorResults.value?.summary.inProgressCount ?? 0,
    );
    const completionPercent = computed(() =>
      totalLearners.value > 0 ? (submittedCount.value / totalLearners.value) * 100 : null,
    );
    const certificationReadyCount = computed(
      () =>
        selectedReport.value?.rosterSummary.filter(
          (row) => row.percentScore !== null && row.percentScore >= 70,
        ).length ?? 0,
    );
    const openDeliveryWorkCount = computed(
      () =>
        resultsOpsSummary.value.finalization.pendingCount +
        resultsOpsSummary.value.finalization.failedCount +
        resultsOpsSummary.value.exports.pendingCount +
        resultsOpsSummary.value.exports.failedCount +
        resultsOpsSummary.value.remediation.pendingCount +
        resultsOpsSummary.value.remediation.failedCount,
    );

    const executiveMetrics = computed<MetricCard[]>(() => [
      {
        label: "Active learners",
        value: formatNumber(activeLearnerCount.value),
        detail: `${formatNumber(totalLearners.value)} targeted`,
        signal: activeLearnerCount.value > 0 ? "Live attempts" : "No active attempts",
        tone: "secondary",
      },
      {
        label: "Average score",
        value: formatPercent(reportingSummary.value?.averagePercent ?? null),
        detail: `${formatNumber(scoredCount.value)} scored`,
        signal: readScoreSignal(reportingSummary.value?.averagePercent ?? null),
        tone: "primary",
      },
      {
        label: "Completion rate",
        value: formatPercent(completionPercent.value),
        detail: `${formatNumber(submittedCount.value)} of ${formatNumber(totalLearners.value)} submitted`,
        signal:
          completionPercent.value !== null && completionPercent.value >= 90
            ? "On track"
            : "Monitor",
        tone:
          completionPercent.value !== null && completionPercent.value >= 90 ? "success" : "warning",
      },
      {
        label: "Certification ready",
        value: formatNumber(certificationReadyCount.value),
        detail: ">= 70% threshold",
        signal:
          certificationReadyCount.value > 0
            ? `${formatPercent((certificationReadyCount.value / Math.max(totalLearners.value, 1)) * 100)} ready`
            : "No ready learners yet",
        tone: "success",
      },
    ]);

    const deliveryHealthCards = computed<MetricCard[]>(() => [
      {
        label: "Durable submissions",
        value: formatNumber(submittedCount.value),
        detail: `Latest ${formatTimestamp(reportingSummary.value?.latestSubmittedAt ?? null)}`,
        signal: "Receipt path",
        tone: "secondary",
      },
      {
        label: "Scoring queue",
        value: formatNumber(
          resultsOpsSummary.value.finalization.pendingCount +
            resultsOpsSummary.value.finalization.failedCount,
        ),
        detail: `${resultsOpsSummary.value.finalization.pendingCount} pending, ${resultsOpsSummary.value.finalization.failedCount} failed`,
        signal:
          resultsOpsSummary.value.finalization.failedCount > 0 ? "Needs action" : "Controlled",
        tone: resultsOpsSummary.value.finalization.failedCount > 0 ? "danger" : "primary",
      },
      {
        label: "Export queue",
        value: formatNumber(
          resultsOpsSummary.value.exports.pendingCount +
            resultsOpsSummary.value.exports.failedCount,
        ),
        detail: `${resultsOpsSummary.value.exports.pendingCount} pending, ${resultsOpsSummary.value.exports.failedCount} failed`,
        signal: resultsOpsSummary.value.exports.failedCount > 0 ? "Retry exports" : "Stable",
        tone: resultsOpsSummary.value.exports.failedCount > 0 ? "danger" : "primary",
      },
      {
        label: "Recovery work",
        value: formatNumber(
          resultsOpsSummary.value.remediation.pendingCount +
            resultsOpsSummary.value.remediation.failedCount,
        ),
        detail: `${resultsOpsSummary.value.remediation.completeCount} completed remediations`,
        signal: openDeliveryWorkCount.value > 0 ? "Open work" : "All clear",
        tone: openDeliveryWorkCount.value > 0 ? "warning" : "success",
      },
    ]);

    const scoreDistributionBins = computed<ScoreDistributionBin[]>(() => {
      const bins = [
        { label: "0-59", count: 0 },
        { label: "60-69", count: 0 },
        { label: "70-79", count: 0 },
        { label: "80-89", count: 0 },
        { label: "90-100", count: 0 },
      ];

      for (const row of selectedReport.value?.rosterSummary ?? []) {
        if (row.percentScore === null) continue;
        const percent = clampPercent(row.percentScore);
        const binIndex =
          percent < 60 ? 0 : percent < 70 ? 1 : percent < 80 ? 2 : percent < 90 ? 3 : 4;
        bins[binIndex].count += 1;
      }

      const maxCount = Math.max(...bins.map((bin) => bin.count), 0);
      return bins.map((bin) => ({
        ...bin,
        height: maxCount > 0 ? `${Math.max(10, (bin.count / maxCount) * 100)}%` : "0%",
      }));
    });

    const itemEngagementRows = computed<EngagementRow[]>(() => {
      const denominator = Math.max(submittedCount.value, 1);
      return [...(selectedReport.value?.itemAnalysis ?? [])]
        .sort((left, right) => right.answeredCount - left.answeredCount)
        .slice(0, 5)
        .map((item) => {
          const percent = clampPercent((item.answeredCount / denominator) * 100);
          return {
            id: item.itemId,
            title: formatItemTitle(item),
            value: `${percent}%`,
            detail: `${item.answeredCount} answered, ${item.skippedCount} skipped, p ${formatDecimal(item.pValue)}, D ${formatDecimal(item.discriminationIndex)}, ${formatSeconds(item.averageTimeOnItemSeconds)} avg`,
            width: `${percent}%`,
            tone: percent < 60 ? "warning" : "normal",
          };
        });
    });

    const recoveryRiskRows = computed(() =>
      [...resultsOpsRows.value]
        .filter((row) => hasOpenRisk(row))
        .sort((left, right) => {
          const leftSeverity = readRiskSeverity(left);
          const rightSeverity = readRiskSeverity(right);
          if (leftSeverity !== rightSeverity) return rightSeverity - leftSeverity;
          return readRiskUpdatedAt(right).localeCompare(readRiskUpdatedAt(left));
        })
        .slice(0, 4),
    );

    const filteredLearnerRows = computed(() => {
      const query = learnerSearch.value.trim().toLowerCase();
      return [...(selectedReport.value?.rosterSummary ?? [])]
        .filter((row) => {
          if (!query) return true;
          return [row.learner.displayName, row.learner.email ?? "", row.learner.id].some((value) =>
            value.toLowerCase().includes(query),
          );
        })
        .sort(sortLearnerRows)
        .slice(0, 10);
    });

    const analyticsUnavailable = computed(
      () =>
        instructorRosterError.value ||
        instructorReportingError.value ||
        resultsOpsError.value ||
        reportExportError.value,
    );
    const analyticsLoading = computed(
      () =>
        instructorRosterLoading.value ||
        instructorReportingLoading.value ||
        resultsOpsLoading.value ||
        reportExportLoading.value,
    );
    const exportCatalogEntries = computed(
      () =>
        reportExportCatalog.value?.entries.filter(
          (entry) => entry.scopeKind === "assessment-administration",
        ) ?? [],
    );
    const dictionaryRowCount = computed(
      () => reportExportCatalog.value?.dataDictionary.length ?? 0,
    );

    onMounted(() => {
      void refreshAnalytics();
    });

    watch(
      () => selectedInstructorAssignmentId.value,
      () => {
        void refreshAnalytics();
      },
    );

    async function refreshAnalytics(): Promise<void> {
      if (selectedInstructorAssignmentId.value) {
        await Promise.all([
          refreshInstructorWorkspace(),
          refreshReportExportCatalog(),
          refreshResultsOps({ assignmentId: selectedInstructorAssignmentId.value }),
        ]);
        return;
      }

      await Promise.all([refreshResultsOps(), refreshReportExportCatalog()]);
    }

    return {
      analyticsLoading,
      analyticsUnavailable,
      deliveryHealthCards,
      dictionaryRowCount,
      executiveMetrics,
      exportBusy,
      exportCatalogEntries,
      filteredLearnerRows,
      itemEngagementRows,
      learnerSearch,
      recoveryRiskRows,
      refreshAnalytics,
      scoreDistributionBins,
      scoredCount,
      selectedReport,
    };
  });

  async function exportReport(type: "roster" | "items" | "standards"): Promise<void> {
    state.exportBusy.value = type;
    try {
      await exportInstructorAssignmentReport({ type });
    } finally {
      state.exportBusy.value = "";
    }
  }

  async function exportBundle(): Promise<void> {
    state.exportBusy.value = "bundle";
    try {
      await exportInstructorAssignmentBundle();
    } finally {
      state.exportBusy.value = "";
    }
  }

  async function exportDictionary(): Promise<void> {
    state.exportBusy.value = "dictionary";
    try {
      await exportReportDataDictionary();
    } finally {
      state.exportBusy.value = "";
    }
  }

  return (
    <section class="analytics-page" data-testid="analytics-page">
      <section class="analytics-hero">
        <div class="analytics-hero__copy">
          <p class="page-kicker">Performance Analytics</p>
          <h1 data-testid="analytics-page-title">Delivery and outcome signals</h1>
          <p>
            Assessment operations, learner performance, and recovery risk for{" "}
            {selectedInstructorAssignmentTitle.value || "the selected assessment"}.
          </p>
        </div>

        <div class="analytics-actions">
          <span class="range-chip">Current Assignment</span>
          <button
            class="secondary-action"
            type="button"
            disabled={Boolean(state.analyticsLoading.value)}
            data-testid="analytics-refresh-button"
            onClick={() => void state.refreshAnalytics()}
          >
            {state.analyticsLoading.value ? "Refreshing" : "Refresh"}
          </button>
          <button
            class="primary-action"
            type="button"
            disabled={!selectedInstructorAssignmentId.value || state.exportBusy.value !== ""}
            data-testid="analytics-export-roster"
            onClick={() => void exportReport("roster")}
          >
            {state.exportBusy.value === "roster" ? "Exporting" : "Export Learners CSV"}
          </button>
        </div>
      </section>

      {state.analyticsUnavailable.value ? (
        <section class="analytics-empty analytics-empty--error" role="alert">
          <strong>Analytics unavailable</strong>
          <p>{state.analyticsUnavailable.value}</p>
        </section>
      ) : !selectedInstructorAssignmentId.value ? (
        <section class="analytics-empty">
          <strong>Select an assessment</strong>
          <p>Choose an assessment before reviewing learner outcomes and delivery health.</p>
          <button
            class="primary-action"
            type="button"
            onClick={() => props.navigateTo("assessments")}
          >
            Open Assessments
          </button>
        </section>
      ) : (
        <>
          <section class="metric-grid" aria-label="Analytics summary">
            {state.executiveMetrics.value.map((metric) => (
              <article key={metric.label} class="metric-card" data-tone={metric.tone}>
                <div class="metric-card__top">
                  <span class="metric-mark" aria-hidden="true">
                    {metric.label.slice(0, 2)}
                  </span>
                  <span class="metric-signal">{metric.signal}</span>
                </div>
                <p class="metric-label">{metric.label}</p>
                <strong>{metric.value}</strong>
                <span>{metric.detail}</span>
              </article>
            ))}
          </section>

          <section class="analytics-layout">
            <article class="analytics-panel analytics-panel--wide">
              <div class="panel-heading">
                <div>
                  <h2>Score distribution</h2>
                  <p>Distribution of finalized learner percentages.</p>
                </div>
                <span>{formatNumber(state.scoredCount.value)} scored</span>
              </div>

              <div class="score-chart" role="img" aria-label="Score distribution by percent band">
                {state.scoreDistributionBins.value.map((bin) => (
                  <div key={bin.label} class="score-bin">
                    <div class="score-bin__track">
                      <span style={{ height: bin.height }} />
                    </div>
                    <strong>{bin.count}</strong>
                    <small>{bin.label}</small>
                  </div>
                ))}
              </div>
            </article>

            <article class="analytics-panel">
              <div class="panel-heading">
                <div>
                  <h2>Item engagement</h2>
                  <p>Answered share across submitted attempts.</p>
                </div>
              </div>

              <div class="engagement-list">
                {state.itemEngagementRows.value.map((item) => (
                  <article key={item.id} class="engagement-row" data-tone={item.tone}>
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.value}</span>
                    </div>
                    <div class="engagement-track">
                      <span style={{ width: item.width }} />
                    </div>
                    <p>{item.detail}</p>
                  </article>
                ))}
                {state.itemEngagementRows.value.length === 0 && (
                  <p class="empty-copy">Engagement appears after learners submit attempts.</p>
                )}
              </div>
            </article>

            <article class="analytics-panel analytics-panel--wide">
              <div class="panel-heading">
                <div>
                  <h2>Delivery health</h2>
                  <p>Operational signals from receipts, scoring, exports, and remediations.</p>
                </div>
                <button
                  class="secondary-action"
                  type="button"
                  onClick={() => props.navigateTo("results-ops")}
                >
                  Open Results
                </button>
              </div>

              <div class="health-grid">
                {state.deliveryHealthCards.value.map((metric) => (
                  <article key={metric.label} class="health-card" data-tone={metric.tone}>
                    <span>{metric.signal}</span>
                    <strong>{metric.value}</strong>
                    <p>{metric.label}</p>
                    <small>{metric.detail}</small>
                  </article>
                ))}
              </div>
            </article>

            <article class="analytics-panel">
              <div class="panel-heading">
                <div>
                  <h2>Recovery risk</h2>
                  <p>Attempts needing scoring, export, or remediation attention.</p>
                </div>
              </div>

              <div class="risk-list">
                {state.recoveryRiskRows.value.map((row) => (
                  <article key={row.attemptId} class="risk-row" data-tone={readRiskTone(row)}>
                    <strong>{readRiskLabel(row)}</strong>
                    <span>{row.context.assignmentTitle ?? row.context.assessmentTitle}</span>
                    <p>
                      {formatTimestamp(readRiskUpdatedAt(row))} · {row.attemptId}
                    </p>
                  </article>
                ))}
                {state.recoveryRiskRows.value.length === 0 && (
                  <p class="empty-copy">No open recovery risk for this assessment.</p>
                )}
              </div>
            </article>
          </section>

          <section class="export-center" data-testid="analytics-export-center">
            <div class="panel-heading">
              <div>
                <h2>Export center</h2>
                <p>
                  Downloadable artifacts for procurement review, instructor analysis, and evidence
                  handoff.
                </p>
              </div>
              <div class="export-center__actions">
                <button
                  class="secondary-action"
                  type="button"
                  disabled={state.exportBusy.value !== ""}
                  data-testid="analytics-export-dictionary"
                  onClick={() => void exportDictionary()}
                >
                  {state.exportBusy.value === "dictionary" ? "Exporting" : "Data Dictionary"}
                </button>
                <button
                  class="primary-action"
                  type="button"
                  disabled={!selectedInstructorAssignmentId.value || state.exportBusy.value !== ""}
                  data-testid="analytics-export-bundle"
                  onClick={() => void exportBundle()}
                >
                  {state.exportBusy.value === "bundle" ? "Building" : "Result Bundle"}
                </button>
              </div>
            </div>

            <div class="export-summary">
              <article>
                <span>Catalog</span>
                <strong>{formatNumber(state.exportCatalogEntries.value.length)}</strong>
                <p>Assessment-administration artifacts</p>
              </article>
              <article>
                <span>Dictionary</span>
                <strong>{formatNumber(state.dictionaryRowCount.value)}</strong>
                <p>Documented columns</p>
              </article>
              <article>
                <span>Bundle</span>
                <strong>ZIP</strong>
                <p>Manifest, CSVs, evidence, and lineage</p>
              </article>
            </div>

            <div class="export-grid">
              {state.exportCatalogEntries.value.map((entry) => (
                <article key={entry.artifactType} class="export-artifact">
                  <div>
                    <strong>{entry.label}</strong>
                    <span>{entry.filename}</span>
                  </div>
                  <p>{entry.description}</p>
                  {renderExportAction(entry.artifactType)}
                </article>
              ))}
            </div>
          </section>

          <section class="learner-panel">
            <div class="panel-heading">
              <div>
                <h2>Individual student performance</h2>
                <p>Sorted by scoring risk and performance threshold.</p>
              </div>
              <div class="learner-tools">
                <input
                  value={state.learnerSearch.value}
                  type="search"
                  placeholder="Filter by learner..."
                  aria-label="Filter learners"
                  data-testid="analytics-learner-filter"
                  onInput={(event) => {
                    state.learnerSearch.value = event.currentTarget.value;
                  }}
                />
                <button
                  class="secondary-action"
                  type="button"
                  disabled={!selectedInstructorAssignmentId.value || state.exportBusy.value !== ""}
                  onClick={() => void exportReport("items")}
                >
                  {state.exportBusy.value === "items" ? "Exporting" : "Export Items CSV"}
                </button>
              </div>
            </div>

            <div class="learner-table-wrap">
              <table class="learner-table">
                <thead>
                  <tr>
                    <th>Learner</th>
                    <th>Status</th>
                    <th>Score</th>
                    <th>Submitted</th>
                    <th>Finalized</th>
                    <th>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {state.filteredLearnerRows.value.map((row) => (
                    <tr key={row.learner.id}>
                      <td data-label="Learner">
                        <strong>{row.learner.displayName}</strong>
                        <span>{row.learner.email ?? row.learner.id}</span>
                      </td>
                      <td data-label="Status">{formatStatus(row.resultStatus)}</td>
                      <td data-label="Score">{formatScore(row)}</td>
                      <td data-label="Submitted">{formatTimestamp(row.submittedAt)}</td>
                      <td data-label="Finalized">{formatTimestamp(row.finalizedAt)}</td>
                      <td data-label="Signal">
                        <span class="signal-pill" data-tone={readLearnerTone(row)}>
                          {readLearnerSignal(row)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {state.filteredLearnerRows.value.length === 0 && (
                <p class="empty-copy">No learners match this filter.</p>
              )}
            </div>
          </section>
        </>
      )}
    </section>
  );

  function renderExportAction(artifactType: string) {
    switch (artifactType) {
      case "roster-csv":
        return (
          <button
            class="text-action"
            type="button"
            disabled={state.exportBusy.value !== ""}
            onClick={() => void exportReport("roster")}
          >
            Download
          </button>
        );
      case "item-analysis-csv":
        return (
          <button
            class="text-action"
            type="button"
            disabled={state.exportBusy.value !== ""}
            onClick={() => void exportReport("items")}
          >
            Download
          </button>
        );
      case "standards-mastery-csv":
        return (
          <button
            class="text-action"
            type="button"
            disabled={state.exportBusy.value !== ""}
            onClick={() => void exportReport("standards")}
          >
            Download
          </button>
        );
      case "data-dictionary-csv":
        return (
          <button
            class="text-action"
            type="button"
            disabled={state.exportBusy.value !== ""}
            onClick={() => void exportDictionary()}
          >
            Download
          </button>
        );
      case "result-export-bundle":
        return (
          <button
            class="text-action"
            type="button"
            disabled={!selectedInstructorAssignmentId.value || state.exportBusy.value !== ""}
            onClick={() => void exportBundle()}
          >
            Build
          </button>
        );
      default:
        return <span class="export-artifact__status">Bundle item</span>;
    }
  }
}

function sortLearnerRows(left: ReportRosterRow, right: ReportRosterRow): number {
  const leftRisk = readLearnerRiskRank(left);
  const rightRisk = readLearnerRiskRank(right);
  if (leftRisk !== rightRisk) return rightRisk - leftRisk;

  const leftPercent = left.percentScore ?? -1;
  const rightPercent = right.percentScore ?? -1;
  if (leftPercent !== rightPercent) return rightPercent - leftPercent;
  return left.learner.displayName.localeCompare(right.learner.displayName);
}

function readLearnerRiskRank(row: ReportRosterRow): number {
  if (row.resultStatus === "failed") return 3;
  if (row.resultStatus === "pending") return 2;
  if (!row.latestAttemptId) return 1;
  return 0;
}

function readLearnerSignal(row: ReportRosterRow): string {
  if (row.resultStatus === "failed") return "Scoring issue";
  if (row.resultStatus === "pending") return "Scoring pending";
  if (row.percentScore !== null && row.percentScore < 70) return "Below threshold";
  if (row.percentScore !== null) return "Ready";
  if (row.latestAttemptId) return "Attempt open";
  return "Not started";
}

function readLearnerTone(row: ReportRosterRow): MetricTone {
  const signal = readLearnerSignal(row);
  if (signal === "Scoring issue") return "danger";
  if (signal === "Scoring pending" || signal === "Below threshold") return "warning";
  if (signal === "Ready") return "success";
  return "primary";
}

function hasOpenRisk(row: RuntimeResultsOpsRow): boolean {
  return (
    row.finalization.status === "pending" ||
    row.finalization.status === "failed" ||
    row.export?.status === "pending" ||
    row.export?.status === "failed" ||
    row.remediation.pendingCount > 0 ||
    row.remediation.failedCount > 0
  );
}

function readRiskSeverity(row: RuntimeResultsOpsRow): number {
  if (
    row.finalization.status === "failed" ||
    row.export?.status === "failed" ||
    row.remediation.failedCount > 0
  ) {
    return 2;
  }
  if (
    row.finalization.status === "pending" ||
    row.export?.status === "pending" ||
    row.remediation.pendingCount > 0
  ) {
    return 1;
  }
  return 0;
}

function readRiskUpdatedAt(row: RuntimeResultsOpsRow): string {
  return row.export?.updatedAt ?? row.finalization.updatedAt;
}

function readRiskLabel(row: RuntimeResultsOpsRow): string {
  if (row.finalization.status === "failed") return "Scoring failed";
  if (row.export?.status === "failed") return "Export failed";
  if (row.remediation.failedCount > 0) return "Recovery failed";
  if (row.finalization.status === "pending") return "Scoring pending";
  if (row.export?.status === "pending") return "Export pending";
  return "Recovery pending";
}

function readRiskTone(row: RuntimeResultsOpsRow): MetricTone {
  return readRiskSeverity(row) > 1 ? "danger" : "warning";
}

function formatItemTitle(item: ReportItemRow): string {
  return item.itemTitle || item.itemIdentifier || `Item ${item.itemPosition ?? item.itemId}`;
}

function formatScore(row: ReportRosterRow): string {
  if (row.percentScore !== null) return `${clampPercent(row.percentScore)}%`;
  if (row.totalScore !== null || row.maxScore !== null) {
    return `${row.totalScore ?? "?"} / ${row.maxScore ?? "?"}`;
  }
  return "Not scored";
}

function formatStatus(value: string | null): string {
  return value ? value.replaceAll("-", " ").replaceAll("_", " ") : "Not started";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "not yet";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${clampPercent(value)}%`;
}

function formatDecimal(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value * 100) / 100);
}

function formatSeconds(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)}s`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function readScoreSignal(value: number | null): string {
  if (value === null) return "Awaiting results";
  if (value >= 85) return "Strong";
  if (value >= 70) return "Passing";
  return "Review needed";
}
