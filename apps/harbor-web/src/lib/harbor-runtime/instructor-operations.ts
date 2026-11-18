import type { CreateScoreAmendmentRequest, SaveManualScoreRequest } from "@harbor/attempt-protocol";
import {
  buildInstructorLmsEvidenceReportUrl,
  createScoreAmendment as createScoreAmendmentRequest,
  deactivateScoreAmendment as deactivateScoreAmendmentRequest,
  finalizeManualScoringAttempt as finalizeManualScoringAttemptRequest,
  loadInstructorAssignmentReportBundle,
  loadInstructorAssignmentReportCsv,
  loadInstructorLearnerReport,
  loadInstructorLearnerReportBundle,
  loadInstructorLearnerReportCsv,
  loadInstructorLmsWorkspace,
  loadInstructorReportDataDictionaryCsv,
  loadInstructorReportExportCatalog,
  loadManualScoringAttempt,
  loadManualScoringQueue,
  loadResultsOpsRows,
  loadScoreAmendmentEvidenceCsv,
  loadScoreAmendmentEvidenceExport,
  previewScoreAmendment as previewScoreAmendmentRequest,
  requestResultsOpsRetry as requestResultsOpsRetryRequest,
  saveManualScore as saveManualScoreRequest,
  scheduleInstructorLmsNrps as scheduleInstructorLmsNrpsRequest,
  syncInstructorLmsNrps as syncInstructorLmsNrpsRequest,
  type RuntimeCreateScoreAmendmentResponse,
  type RuntimeDeactivateScoreAmendmentResponse,
  type RuntimeFinalizeManualScoringResponse,
  type RuntimeInstructorLmsNrpsSchedule,
  type RuntimeInstructorLmsNrpsSync,
  type RuntimeManualScoringAttempt,
  type RuntimeResultsOpsFilters,
  type RuntimeScoreAmendmentEvidenceExport,
  type RuntimeScoreAmendmentPreview,
} from "../runtime-session";
import { downloadBlobFile, downloadTextFile } from "./downloads";
import { formatScorePair } from "./formatting";
import { runInstructorRequest } from "./instructor-request";
import type { InstructorAssignmentActions } from "./instructor-assignments";
import {
  createEmptyResultsOpsFilterOptions,
  createEmptyResultsOpsSummary,
  type InstructorWorkspaceState,
} from "./instructor-workspace-state";

export function createInstructorOperationsActions(input: {
  state: InstructorWorkspaceState;
  assignmentActions: Pick<
    InstructorAssignmentActions,
    "refreshInstructorWorkspace" | "refreshInstructorSections"
  >;
  formatError(this: void, error: unknown): string;
}) {
  const { state, assignmentActions, formatError } = input;

  async function refreshResultsOps(filters: RuntimeResultsOpsFilters = {}): Promise<void> {
    state.resultsOpsLoading.value = true;
    state.resultsOpsError.value = "";

    try {
      const payload = await loadResultsOpsRows(filters);
      state.resultsOpsRows.value = payload.rows;
      state.resultsOpsSummary.value = payload.summary;
      state.resultsOpsFilterOptions.value = payload.filters;
      state.resultsOpsStatus.value =
        payload.rows.length === 0
          ? "No pending or failed result-processing work is waiting for operator follow-through."
          : `QFlowLearn Delivery is tracking ${payload.rows.length} pending or failed result-processing item(s), including ${payload.summary.exports.pendingCount} pending export(s) and ${payload.summary.exports.failedCount} failed export(s).`;
    } catch (error) {
      state.resultsOpsRows.value = [];
      state.resultsOpsSummary.value = createEmptyResultsOpsSummary();
      state.resultsOpsFilterOptions.value = createEmptyResultsOpsFilterOptions();
      state.resultsOpsError.value = formatError(error);
      state.resultsOpsStatus.value =
        "QFlowLearn Delivery could not read result-processing state from the authoritative ledgers.";
    } finally {
      state.resultsOpsLoading.value = false;
    }
  }

  async function requestResultsOpsRetry(input: {
    attemptId: string;
    scope: "result-finalization" | "result-export";
    reason: string;
  }): Promise<void> {
    state.resultsOpsBusyAttemptId.value = input.attemptId;
    state.resultsOpsError.value = "";

    try {
      const response = await requestResultsOpsRetryRequest({
        attemptId: input.attemptId,
        request: {
          scope: input.scope,
          actor: state.buildInstructorAssignmentActor(),
          reason: input.reason,
        },
      });

      state.resultsOpsRows.value = state.resultsOpsRows.value.map((row) => {
        if (row.attemptId !== input.attemptId) {
          return row;
        }

        return {
          ...row,
          remediation: {
            ...row.remediation,
            pendingCount:
              response.request.status === "pending"
                ? Math.max(row.remediation.pendingCount, 1)
                : row.remediation.pendingCount,
            failedCount: response.request.status === "pending" ? 0 : row.remediation.failedCount,
            latestRequest: {
              requestId: response.request.requestId,
              scope: response.request.scope,
              status: response.request.status,
              retryOfRequestId: response.request.retryOfRequestId,
              requestedAt: response.request.createdAt,
              completedAt: response.request.completedAt,
              errorMessage: response.request.errorMessage,
            },
          },
        };
      });
      state.resultsOpsSummary.value = {
        ...state.resultsOpsSummary.value,
        remediation: {
          ...state.resultsOpsSummary.value.remediation,
          pendingCount:
            response.request.status === "pending"
              ? Math.max(state.resultsOpsSummary.value.remediation.pendingCount, 1)
              : state.resultsOpsSummary.value.remediation.pendingCount,
          exportPendingCount:
            input.scope === "result-export" && response.request.status === "pending"
              ? Math.max(state.resultsOpsSummary.value.remediation.exportPendingCount, 1)
              : state.resultsOpsSummary.value.remediation.exportPendingCount,
          latestRequest: {
            requestId: response.request.requestId,
            scope: response.request.scope,
            status: response.request.status,
            retryOfRequestId: response.request.retryOfRequestId,
            requestedAt: response.request.createdAt,
            completedAt: response.request.completedAt,
            errorMessage: response.request.errorMessage,
          },
        },
      };
      state.resultsOpsStatus.value = response.existing
        ? `QFlowLearn Delivery already has a pending ${input.scope.replace("-", " ")} remediation request for ${input.attemptId}.`
        : `QFlowLearn Delivery accepted a ${input.scope.replace("-", " ")} remediation request for ${input.attemptId}. Authoritative results remain unchanged while bounded downstream work is re-driven.`;
    } catch (error) {
      state.resultsOpsError.value = formatError(error);
      throw error;
    } finally {
      state.resultsOpsBusyAttemptId.value = null;
    }
  }

  async function refreshInstructorLmsIntegrations(): Promise<void> {
    state.instructorLmsLoading.value = true;
    state.instructorLmsError.value = "";

    try {
      const payload = await loadInstructorLmsWorkspace();
      state.instructorLmsIntegration.value = payload;
      state.instructorLmsStatus.value =
        payload.registrations.length === 0
          ? "No LTI registrations are configured yet."
          : `QFlowLearn Delivery is tracking ${payload.registrations.length} LTI registration(s), ${payload.resourceLinks.length} resource link mapping(s), and ${payload.deepLinkPlacements.length} Deep Linking placement(s).`;
    } catch (error) {
      state.instructorLmsIntegration.value = null;
      state.instructorLmsError.value = formatError(error);
      state.instructorLmsStatus.value =
        "QFlowLearn Delivery could not read LMS integration evidence from the runtime ledgers.";
    } finally {
      state.instructorLmsLoading.value = false;
    }
  }

  async function syncInstructorLmsNrps(input: {
    attemptId: string;
  }): Promise<RuntimeInstructorLmsNrpsSync> {
    state.instructorLmsSyncingAttemptId.value = input.attemptId;
    state.instructorLmsError.value = "";

    try {
      const response = await syncInstructorLmsNrpsRequest(input);
      state.instructorLmsStatus.value = `NRPS sync complete: ${response.run.learnerMembershipsUpserted} learner membership(s) upserted, ${response.run.skippedMembers} member(s) skipped.`;
      await refreshInstructorLmsIntegrations();
      await assignmentActions.refreshInstructorSections();
      return response;
    } catch (error) {
      state.instructorLmsError.value = formatError(error);
      throw error;
    } finally {
      state.instructorLmsSyncingAttemptId.value = null;
    }
  }

  async function scheduleInstructorLmsNrps(input: {
    resourceLinkId: string;
    enabled: boolean;
    intervalMinutes?: number;
    reconciliationPolicy?: "additive-only" | "mark-inactive";
  }): Promise<RuntimeInstructorLmsNrpsSchedule> {
    state.instructorLmsSchedulingResourceLinkId.value = input.resourceLinkId;
    state.instructorLmsError.value = "";

    try {
      const response = await scheduleInstructorLmsNrpsRequest(input);
      state.instructorLmsStatus.value = response.schedule.enabled
        ? `Scheduled NRPS sync every ${response.schedule.intervalMinutes} minute(s).`
        : "Scheduled NRPS sync paused for this resource link.";
      await refreshInstructorLmsIntegrations();
      return response;
    } catch (error) {
      state.instructorLmsError.value = formatError(error);
      throw error;
    } finally {
      state.instructorLmsSchedulingResourceLinkId.value = null;
    }
  }

  async function refreshManualScoringQueue(input?: { assignmentId?: string }): Promise<void> {
    const assignmentId = input?.assignmentId ?? state.selectedInstructorAssignmentId.value;
    await runInstructorRequest({
      busy: state.manualScoringLoading,
      error: state.manualScoringError,
      formatError,
      run: async () => {
        const payload = await loadManualScoringQueue({
          assignmentId: assignmentId || undefined,
        });
        state.manualScoringQueue.value = payload.rows;
        state.manualScoringStatus.value =
          payload.rows.length === 0
            ? "No submitted attempts are awaiting manual scoring."
            : `${payload.rows.length} attempt${payload.rows.length === 1 ? "" : "s"} awaiting manual scoring.`;
      },
      onError: () => {
        state.manualScoringQueue.value = [];
      },
    });
  }

  async function openManualScoringAttempt(attemptId: string): Promise<RuntimeManualScoringAttempt> {
    return runInstructorRequest({
      busy: state.manualScoringLoading,
      error: state.manualScoringError,
      formatError,
      run: async () => {
        const payload = await loadManualScoringAttempt(attemptId);
        state.manualScoringAttempt.value = payload;
        return payload;
      },
    });
  }

  async function saveManualScore(input: {
    attemptId: string;
    itemId: string;
    score: number;
    maxScore: number;
    studentFeedback?: string | null;
    privateNote?: string | null;
  }): Promise<void> {
    state.manualScoringSaving.value = true;
    state.manualScoringError.value = "";

    const request: SaveManualScoreRequest = {
      actor: state.buildInstructorAssignmentActor(),
      score: input.score,
      maxScore: input.maxScore,
      studentFeedback: input.studentFeedback ?? null,
      privateNote: input.privateNote ?? null,
    };

    try {
      const response = await saveManualScoreRequest({
        attemptId: input.attemptId,
        itemId: input.itemId,
        request,
      });
      if (state.manualScoringAttempt.value?.attemptId === input.attemptId) {
        const items = state.manualScoringAttempt.value.items.map((item) =>
          item.itemId === input.itemId ? { ...item, manualScore: response.entry } : item,
        );
        state.manualScoringAttempt.value = {
          ...state.manualScoringAttempt.value,
          items,
          canFinalize:
            state.manualScoringAttempt.value.resultStatus === "pending" &&
            items.some((item) => item.pendingManualScoring) &&
            items
              .filter((item) => item.pendingManualScoring)
              .every((item) => item.manualScore !== null),
        };
      }
      await refreshManualScoringQueue();
    } catch (error) {
      state.manualScoringError.value = formatError(error);
      throw error;
    } finally {
      state.manualScoringSaving.value = false;
    }
  }

  async function finalizeManualScoringAttempt(input: {
    attemptId: string;
  }): Promise<RuntimeFinalizeManualScoringResponse> {
    state.manualScoringSaving.value = true;
    state.manualScoringError.value = "";

    try {
      const response = await finalizeManualScoringAttemptRequest({
        attemptId: input.attemptId,
        request: {
          actor: state.buildInstructorAssignmentActor(),
        },
      });
      state.manualScoringStatus.value = `Manual scoring finalized: ${formatScorePair(
        response.totalScore,
        response.maxScore,
      )}.`;
      await Promise.all([
        refreshManualScoringQueue(),
        assignmentActions.refreshInstructorWorkspace(state.selectedInstructorAssignmentId.value),
      ]);
      if (state.manualScoringAttempt.value?.attemptId === input.attemptId) {
        state.manualScoringAttempt.value = await loadManualScoringAttempt(input.attemptId);
      }
      return response;
    } catch (error) {
      state.manualScoringError.value = formatError(error);
      throw error;
    } finally {
      state.manualScoringSaving.value = false;
    }
  }

  async function createScoreAmendment(input: {
    assignmentId?: string;
    itemId: string;
    action: CreateScoreAmendmentRequest["action"];
    responseMatchText?: string | null;
    reason: string;
  }): Promise<RuntimeCreateScoreAmendmentResponse> {
    const assignmentId = input.assignmentId ?? state.selectedInstructorAssignmentId.value;
    if (!assignmentId) {
      throw new Error("Select an assessment before creating a score amendment.");
    }

    return runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.scoreAmendmentsError,
      formatError,
      run: async () => {
        const response = await createScoreAmendmentRequest({
          assignmentId,
          request: {
            actor: state.buildInstructorAssignmentActor(),
            itemId: input.itemId,
            action: input.action,
            responseMatchText: input.responseMatchText ?? null,
            reason: input.reason,
          },
        });
        await assignmentActions.refreshInstructorWorkspace(assignmentId);
        return response;
      },
    });
  }

  async function previewScoreAmendment(input: {
    assignmentId?: string;
    itemId: string;
    action: CreateScoreAmendmentRequest["action"];
    responseMatchText?: string | null;
    reason: string;
  }): Promise<RuntimeScoreAmendmentPreview> {
    const assignmentId = input.assignmentId ?? state.selectedInstructorAssignmentId.value;
    if (!assignmentId) {
      throw new Error("Select an assessment before previewing a score amendment.");
    }

    return runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.scoreAmendmentsError,
      formatError,
      run: async () =>
        previewScoreAmendmentRequest({
          assignmentId,
          request: {
            actor: state.buildInstructorAssignmentActor(),
            itemId: input.itemId,
            action: input.action,
            responseMatchText: input.responseMatchText ?? null,
            reason: input.reason,
          },
        }),
    });
  }

  async function deactivateScoreAmendment(input: {
    assignmentId?: string;
    amendmentId: string;
    reason: string;
  }): Promise<RuntimeDeactivateScoreAmendmentResponse> {
    const assignmentId = input.assignmentId ?? state.selectedInstructorAssignmentId.value;
    if (!assignmentId) {
      throw new Error("Select an assessment before deactivating a score amendment.");
    }

    return runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.scoreAmendmentsError,
      formatError,
      run: async () => {
        const response = await deactivateScoreAmendmentRequest({
          assignmentId,
          amendmentId: input.amendmentId,
          request: {
            actor: state.buildInstructorAssignmentActor(),
            reason: input.reason,
          },
        });
        await assignmentActions.refreshInstructorWorkspace(assignmentId);
        return response;
      },
    });
  }

  async function exportScoreAmendmentEvidence(input: {
    assignmentId?: string;
    format: "json" | "csv";
  }): Promise<void> {
    const assignmentId = input.assignmentId ?? state.selectedInstructorAssignmentId.value;
    if (!assignmentId) {
      throw new Error("Select an assessment before exporting score amendments.");
    }

    try {
      if (input.format === "csv") {
        const csv = await loadScoreAmendmentEvidenceCsv(assignmentId);
        downloadTextFile({
          filename: `${assignmentId}-score-amendments.csv`,
          content: csv,
          contentType: "text/csv;charset=utf-8",
        });
        return;
      }

      const evidence: RuntimeScoreAmendmentEvidenceExport =
        await loadScoreAmendmentEvidenceExport(assignmentId);
      downloadTextFile({
        filename: `${assignmentId}-score-amendments.json`,
        content: JSON.stringify(evidence, null, 2),
        contentType: "application/json;charset=utf-8",
      });
    } catch (error) {
      state.scoreAmendmentsError.value = formatError(error);
      throw error;
    }
  }

  async function exportInstructorAssignmentReport(input: {
    assignmentId?: string;
    type: "roster" | "items" | "standards";
  }): Promise<void> {
    const assignmentId = input.assignmentId ?? state.selectedInstructorAssignmentId.value;
    if (!assignmentId) {
      throw new Error("Select an assessment before exporting reporting data.");
    }

    try {
      const csv = await loadInstructorAssignmentReportCsv(assignmentId, input.type);
      downloadTextFile({
        filename: `${assignmentId}-${input.type}-report.csv`,
        content: csv,
        contentType: "text/csv;charset=utf-8",
      });
    } catch (error) {
      state.instructorReportingError.value = formatError(error);
      throw error;
    }
  }

  async function refreshReportExportCatalog(): Promise<void> {
    await runInstructorRequest({
      busy: state.reportExportLoading,
      error: state.reportExportError,
      formatError,
      run: async () => {
        state.reportExportCatalog.value = await loadInstructorReportExportCatalog();
      },
      onError: () => {
        state.reportExportCatalog.value = null;
      },
    });
  }

  async function exportReportDataDictionary(): Promise<void> {
    await runInstructorRequest({
      busy: state.reportExportLoading,
      error: state.reportExportError,
      formatError,
      run: async () => {
        const csv = await loadInstructorReportDataDictionaryCsv();
        downloadTextFile({
          filename: "data_dictionary.csv",
          content: csv,
          contentType: "text/csv;charset=utf-8",
        });
      },
    });
  }

  async function exportInstructorAssignmentBundle(input?: {
    assignmentId?: string;
  }): Promise<void> {
    const assignmentId = input?.assignmentId ?? state.selectedInstructorAssignmentId.value;
    if (!assignmentId) {
      throw new Error("Select an assessment before exporting a result bundle.");
    }

    await runInstructorRequest({
      busy: state.reportExportLoading,
      error: state.reportExportError,
      formatError,
      run: async () => {
        const bundle = await loadInstructorAssignmentReportBundle(assignmentId);
        downloadBlobFile({
          filename: `${assignmentId}-result-export-bundle.zip`,
          blob: bundle,
        });
      },
    });
  }

  async function refreshInstructorLearnerReport(input?: {
    assignmentId?: string;
    learnerId?: string;
  }): Promise<void> {
    const assignmentId = input?.assignmentId ?? state.selectedInstructorAssignmentId.value;
    const learnerId = input?.learnerId;
    if (
      !assignmentId ||
      !learnerId ||
      !state.instructorAssignmentCapabilities.value?.canReadResults
    ) {
      state.instructorLearnerReport.value = null;
      state.instructorLearnerReportError.value = "";
      return;
    }

    await runInstructorRequest({
      busy: state.instructorLearnerReportLoading,
      error: state.instructorLearnerReportError,
      formatError,
      run: async () => {
        state.instructorLearnerReport.value = await loadInstructorLearnerReport(
          assignmentId,
          learnerId,
        );
      },
      onError: () => {
        state.instructorLearnerReport.value = null;
      },
    });
  }

  async function exportInstructorLearnerReport(input: {
    assignmentId?: string;
    learnerId: string;
    type: "items" | "evidence" | "attempts";
  }): Promise<void> {
    const assignmentId = input.assignmentId ?? state.selectedInstructorAssignmentId.value;
    if (!assignmentId) {
      throw new Error("Select an assessment before exporting learner reporting data.");
    }

    try {
      const csv = await loadInstructorLearnerReportCsv(assignmentId, input.learnerId, input.type);
      downloadTextFile({
        filename: `${assignmentId}-${input.learnerId}-${input.type}-report.csv`,
        content: csv,
        contentType: "text/csv;charset=utf-8",
      });
    } catch (error) {
      state.instructorLearnerReportError.value = formatError(error);
      throw error;
    }
  }

  async function exportInstructorLearnerReportBundle(input: {
    assignmentId?: string;
    learnerId: string;
  }): Promise<void> {
    const assignmentId = input.assignmentId ?? state.selectedInstructorAssignmentId.value;
    if (!assignmentId) {
      throw new Error("Select an assessment before exporting a learner report bundle.");
    }

    await runInstructorRequest({
      busy: state.reportExportLoading,
      error: state.reportExportError,
      formatError,
      run: async () => {
        const bundle = await loadInstructorLearnerReportBundle(assignmentId, input.learnerId);
        downloadBlobFile({
          filename: `${assignmentId}-${input.learnerId}-learner-report-bundle.zip`,
          blob: bundle,
        });
      },
    });
  }

  return {
    buildInstructorLmsEvidenceReportUrl,
    createScoreAmendment,
    deactivateScoreAmendment,
    exportInstructorAssignmentBundle,
    exportInstructorAssignmentReport,
    exportInstructorLearnerReport,
    exportInstructorLearnerReportBundle,
    exportReportDataDictionary,
    exportScoreAmendmentEvidence,
    finalizeManualScoringAttempt,
    openManualScoringAttempt,
    previewScoreAmendment,
    refreshInstructorLearnerReport,
    refreshInstructorLmsIntegrations,
    refreshManualScoringQueue,
    refreshReportExportCatalog,
    refreshResultsOps,
    requestResultsOpsRetry,
    saveManualScore,
    scheduleInstructorLmsNrps,
    syncInstructorLmsNrps,
  };
}

export type InstructorOperationsActions = ReturnType<typeof createInstructorOperationsActions>;
