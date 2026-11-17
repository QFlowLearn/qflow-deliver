import { computed, onMounted, ref, useSetup } from "@/lib/preact-reactivity";
import type { HarborPage } from "@/App";
import { useHarborRuntime } from "@/lib/harbor-runtime";
import type { RuntimeResultsOpsRow } from "@/lib/runtime-session";

export default function HarborResultsOpsPage(_props: { navigateTo: (page: HarborPage) => void }) {
  const {
    refreshResultsOps,
    requestResultsOpsRetry,
    resultsOpsBusyAttemptId,
    resultsOpsError,
    resultsOpsFilterOptions,
    resultsOpsLoading,
    resultsOpsRows,
    resultsOpsSummary,
  } = useHarborRuntime();

  const state = useSetup(() => {
    const selectedTenantId = ref("");
    const selectedAssignmentId = ref("");
    const selectedStatus = ref<"all" | "pending" | "failed">("all");

    const assignmentOptions = computed(() =>
      resultsOpsFilterOptions.value.assignments.filter(
        (assignment) => !selectedTenantId.value || assignment.tenantId === selectedTenantId.value,
      ),
    );

    const scopedRows = computed(() =>
      resultsOpsRows.value.filter((row) => {
        if (selectedStatus.value === "failed") {
          return row.finalization.status === "failed" || row.export?.status === "failed";
        }
        if (selectedStatus.value === "pending") {
          return row.finalization.status === "pending" || row.export?.status === "pending";
        }

        return true;
      }),
    );

    const prioritizedRows = computed(() =>
      [...scopedRows.value].sort((left, right) => {
        const leftSeverity =
          left.finalization.status === "failed" || left.export?.status === "failed";
        const rightSeverity =
          right.finalization.status === "failed" || right.export?.status === "failed";

        if (leftSeverity !== rightSeverity) return leftSeverity ? -1 : 1;
        return right.finalization.updatedAt.localeCompare(left.finalization.updatedAt);
      }),
    );

    const failedRowCount = computed(
      () =>
        scopedRows.value.filter(
          (row) => row.finalization.status === "failed" || row.export?.status === "failed",
        ).length,
    );

    const pendingRowCount = computed(
      () =>
        scopedRows.value.filter(
          (row) => row.finalization.status === "pending" || row.export?.status === "pending",
        ).length,
    );

    onMounted(() => {
      void refreshFilteredResults();
    });

    async function refreshFilteredResults(): Promise<void> {
      await refreshResultsOps({
        tenantId: selectedTenantId.value || undefined,
        assignmentId: selectedAssignmentId.value || undefined,
      });
    }

    async function selectTenant(): Promise<void> {
      selectedAssignmentId.value = "";
      await refreshFilteredResults();
    }

    function clearFilters(): void {
      selectedTenantId.value = "";
      selectedAssignmentId.value = "";
      selectedStatus.value = "all";
      void refreshFilteredResults();
    }

    return {
      assignmentOptions,
      clearFilters,
      failedRowCount,
      pendingRowCount,
      prioritizedRows,
      refreshFilteredResults,
      selectTenant,
      selectedAssignmentId,
      selectedStatus,
      selectedTenantId,
    };
  });

  return (
    <section class="results-ops-page" data-testid="results-ops-page">
      <section class="results-ops-hero">
        <div>
          <h1 data-testid="results-ops-page-title">Score processing</h1>
          <div class="detail-summary">
            <span class="summary-pill">
              <strong>{state.pendingRowCount.value}</strong> pending
            </span>
            <span class="summary-pill">
              <strong>{state.failedRowCount.value}</strong> failed
            </span>
            <span class="summary-pill">
              <strong>{resultsOpsSummary.value.exports.pendingCount}</strong> pending exports
            </span>
            <span class="summary-pill">
              <strong>{resultsOpsSummary.value.exports.failedCount}</strong> failed exports
            </span>
            <span class="summary-pill" data-testid="results-ops-resend-summary">
              <strong>{resultsOpsSummary.value.exports.retryCompleteCount}</strong> completed retry
              exports
            </span>
          </div>
        </div>

        <div class="hero-actions">
          <button
            class="primary-action"
            type="button"
            data-testid="results-ops-refresh-button"
            disabled={resultsOpsLoading.value}
            onClick={() => void state.refreshFilteredResults()}
          >
            {resultsOpsLoading.value ? "Refreshing" : "Refresh"}
          </button>
        </div>

        <div class="results-ops-filters">
          <label class="filter-control">
            <span>Tenant</span>
            <select
              value={state.selectedTenantId.value}
              data-testid="results-ops-filter-tenant"
              onChange={(event) => {
                state.selectedTenantId.value = event.currentTarget.value;
                void state.selectTenant();
              }}
            >
              <option value="">All tenants</option>
              {resultsOpsFilterOptions.value.tenants.map((tenant) => (
                <option key={tenant.tenantId} value={tenant.tenantId}>
                  {tenant.tenantId} ({tenant.rowCount})
                </option>
              ))}
            </select>
          </label>

          <label class="filter-control">
            <span>Assessment</span>
            <select
              value={state.selectedAssignmentId.value}
              data-testid="results-ops-filter-assessment"
              onChange={(event) => {
                state.selectedAssignmentId.value = event.currentTarget.value;
                void state.refreshFilteredResults();
              }}
            >
              <option value="">All assessments</option>
              {state.assignmentOptions.value.map((assignment) => (
                <option key={assignment.assignmentId} value={assignment.assignmentId}>
                  {assignment.title} ({assignment.rowCount})
                </option>
              ))}
            </select>
          </label>

          <label class="filter-control">
            <span>Status</span>
            <select
              value={state.selectedStatus.value}
              data-testid="results-ops-filter-status"
              onChange={(event) => {
                state.selectedStatus.value = event.currentTarget.value as
                  | "all"
                  | "pending"
                  | "failed";
              }}
            >
              <option value="all">All statuses</option>
              <option value="failed">Failed</option>
              <option value="pending">Pending</option>
            </select>
          </label>

          <button
            class="secondary-action"
            type="button"
            data-testid="results-ops-clear-filters"
            onClick={state.clearFilters}
          >
            Clear
          </button>
        </div>
      </section>

      {resultsOpsError.value ? (
        <section class="results-ops-empty results-ops-empty--error" role="alert">
          <strong>Results unavailable</strong>
          <p>{resultsOpsError.value}</p>
        </section>
      ) : resultsOpsLoading.value && state.prioritizedRows.value.length === 0 ? (
        <section class="results-ops-empty">
          <strong>Loading</strong>
        </section>
      ) : state.prioritizedRows.value.length === 0 ? (
        <section class="results-ops-empty">
          <strong>All clear</strong>
        </section>
      ) : (
        <section class="results-ops-list">
          {state.prioritizedRows.value.map((row) => (
            <article
              key={row.attemptId}
              class="results-ops-row"
              data-scope={readPrimaryScope(row)}
              data-status={row.finalization.status}
              data-export-status={row.export?.status ?? "none"}
              data-testid={`results-ops-row-${row.attemptId}`}
            >
              <div class="row-main">
                <div class="row-heading">
                  <div>
                    <h2>{formatRowHeading(row)}</h2>
                    <p class="context-line" data-testid={`results-ops-context-${row.attemptId}`}>
                      {formatContextLine(row)}
                    </p>
                  </div>

                  <div class="row-badges">
                    <span class="status-pill" data-tone={row.finalization.status}>
                      Finalization {formatStatus(row.finalization.status)}
                    </span>
                    <span class="status-pill" data-tone={row.export?.status ?? "none"}>
                      Export {row.export ? formatStatus(row.export.status) : "not created"}
                    </span>
                  </div>
                </div>

                <p class="row-copy">{readSummaryLabel(row)}</p>
                <p class="meta-line">
                  {formatScore(row)} · updated{" "}
                  {formatTimestamp(row.export?.updatedAt ?? row.finalization.updatedAt)}
                </p>
              </div>

              <aside class="row-side">
                <div class="side-card">
                  <p class="meta-line">{formatLatestRemediation(row)}</p>
                  {canRetry(row) ? (
                    <button
                      class="primary-action row-action"
                      type="button"
                      data-testid={`retry-button-${row.attemptId}`}
                      disabled={resultsOpsBusyAttemptId.value === row.attemptId}
                      onClick={() => void retryRow(row)}
                    >
                      {resultsOpsBusyAttemptId.value === row.attemptId
                        ? "Retrying..."
                        : buildRetryLabel(row)}
                    </button>
                  ) : (
                    <p class="meta-line">
                      {row.remediation.latestRequest ? "Retry in progress" : "No action needed"}
                    </p>
                  )}
                </div>
              </aside>
            </article>
          ))}
        </section>
      )}
    </section>
  );

  async function retryRow(row: RuntimeResultsOpsRow): Promise<void> {
    await requestResultsOpsRetry({
      attemptId: row.attemptId,
      scope: readPrimaryScope(row),
      reason: buildRetryReason(row),
    });
  }
}

function readPrimaryScope(row: RuntimeResultsOpsRow): "result-finalization" | "result-export" {
  if (row.finalization.status !== "complete") return "result-finalization";
  return "result-export";
}

function formatStatus(value: string): string {
  return value.replaceAll("-", " ").replaceAll("_", " ");
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not yet";
}

function formatScore(row: RuntimeResultsOpsRow): string {
  if (!row.result) return "Score pending";
  return `${row.result.totalScore ?? "?"} / ${row.result.maxScore ?? "?"}`;
}

function formatRowHeading(row: RuntimeResultsOpsRow): string {
  return `Submitted ${formatTimestamp(row.finalization.submittedAt)}`;
}

function formatContextLine(row: RuntimeResultsOpsRow): string {
  const assignment = row.context.assignmentTitle
    ? `${row.context.assignmentTitle} (${row.assignmentId})`
    : "Unassigned delivery";

  return `${row.context.tenantId} · ${assignment} · ${row.context.assessmentTitle}`;
}

function readSummaryLabel(row: RuntimeResultsOpsRow): string {
  const scope = readPrimaryScope(row);

  if (scope === "result-finalization") {
    return row.finalization.errorMessage ?? "Score processing is still pending.";
  }

  return row.export?.errorMessage ?? `Export ${row.export?.format ?? "artifact"} is still pending.`;
}

function canRetry(row: RuntimeResultsOpsRow): boolean {
  const scope = readPrimaryScope(row);

  if (row.remediation.latestRequest?.status === "pending") return false;
  if (scope === "result-finalization") return row.finalization.status === "failed";
  return row.export?.status === "failed";
}

function buildRetryLabel(row: RuntimeResultsOpsRow): string {
  return readPrimaryScope(row) === "result-finalization" ? "Retry Finalization" : "Retry Export";
}

function buildRetryReason(row: RuntimeResultsOpsRow): string {
  return readPrimaryScope(row) === "result-finalization"
    ? "Retry failed result finalization"
    : "Retry failed result export";
}

function formatLatestRemediation(row: RuntimeResultsOpsRow): string {
  const latest = row.remediation.latestRequest;
  if (!latest) return "No resend activity";
  return `${formatStatus(latest.scope)} ${formatStatus(latest.status)} · ${formatTimestamp(latest.requestedAt)}`;
}
