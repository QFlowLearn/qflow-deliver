import type {
  AssignmentLearnerOverrideRecord,
  AttemptPolicyReadResponse,
  CreateAssignmentRequest,
  OperatorAttemptActionRequest,
  UpdateAssignmentRequest,
} from "@harbor/attempt-protocol";
import {
  activateInstructorAssignment as activateInstructorAssignmentRequest,
  applyInstructorAttemptAction as applyInstructorAttemptActionRequest,
  applyOneRosterZipImport as applyOneRosterZipImportRequest,
  applyRosterCsvImport as applyRosterCsvImportRequest,
  closeInstructorAssignment as closeInstructorAssignmentRequest,
  createAccommodationProfile as createAccommodationProfileRequest,
  createInstructorAssignment as createInstructorAssignmentRequest,
  loadAccommodationProfiles,
  loadInstructorAssignment,
  loadInstructorAssignmentCapabilities,
  loadInstructorAssignmentReport,
  loadInstructorAssignments as loadInstructorAssignmentsRequest,
  loadInstructorAttemptEvidence,
  loadInstructorAttemptTimeline,
  loadInstructorLearners,
  loadInstructorPublishedAssessmentVersions as loadInstructorPublishedAssessmentVersionsRequest,
  loadInstructorResults,
  loadInstructorRoster,
  loadInstructorSections,
  loadLearnerAccommodationAssignments,
  loadManualScoringQueue,
  loadProvisioningRuns,
  loadScoreAmendments,
  previewOneRosterZipImport as previewOneRosterZipImportRequest,
  previewRosterCsvImport as previewRosterCsvImportRequest,
  saveAssignmentLearnerOverride as saveAssignmentLearnerOverrideRequest,
  saveLearnerAccommodationProfile as saveLearnerAccommodationProfileRequest,
  updateInstructorAssignment as updateInstructorAssignmentRequest,
  type RuntimeAccommodationProfile,
  type RuntimeAssignmentLearnerOverride,
  type RuntimeInstructorAssignment,
  type RuntimeLearnerAccommodationAssignment,
  type RuntimeRosterCsvImportResponse,
} from "../runtime-session";
import { runInstructorRequest } from "./instructor-request";
import type {
  InstructorAttemptActionInput,
  InstructorWorkspaceDependencies,
  InstructorWorkspaceState,
} from "./instructor-workspace-state";

export function createInstructorAssignmentActions(input: {
  state: InstructorWorkspaceState;
  dependencies: InstructorWorkspaceDependencies;
  formatError(this: void, error: unknown): string;
}) {
  const { state, dependencies, formatError } = input;

  async function refreshInstructorAttemptTimeline(attemptId?: string): Promise<void> {
    const scopedAttemptId = attemptId ?? state.selectedInstructorAttemptId.value;
    if (!scopedAttemptId) {
      state.instructorAttemptTimeline.value = null;
      state.instructorAttemptTimelineError.value = "";
      state.instructorAttemptEvidence.value = null;
      state.instructorAttemptEvidenceError.value = "";
      return;
    }

    state.instructorAttemptTimelineLoading.value = true;
    state.instructorAttemptEvidenceLoading.value = true;
    state.instructorAttemptTimelineError.value = "";
    state.instructorAttemptEvidenceError.value = "";

    try {
      const [timeline, evidence] = await Promise.all([
        loadInstructorAttemptTimeline(scopedAttemptId),
        loadInstructorAttemptEvidence(scopedAttemptId),
      ]);
      state.instructorAttemptTimeline.value = timeline;
      state.instructorAttemptEvidence.value = evidence;
    } catch (error) {
      state.instructorAttemptTimeline.value = null;
      state.instructorAttemptEvidence.value = null;
      state.instructorAttemptTimelineError.value = formatError(error);
      state.instructorAttemptEvidenceError.value = formatError(error);
    } finally {
      state.instructorAttemptTimelineLoading.value = false;
      state.instructorAttemptEvidenceLoading.value = false;
    }
  }

  async function refreshInstructorWorkspace(assignmentId?: string): Promise<void> {
    const scopedAssignmentId = assignmentId ?? state.selectedInstructorAssignmentId.value;
    if (!scopedAssignmentId) {
      state.instructorAssignmentCapabilities.value = null;
      state.instructorRoster.value = null;
      state.instructorResults.value = null;
      state.instructorAssignmentReport.value = null;
      state.instructorLearnerReport.value = null;
      state.instructorRosterError.value = "";
      state.instructorReportingError.value = "";
      state.instructorLearnerReportError.value = "";
      state.instructorAttemptTimeline.value = null;
      state.instructorAttemptTimelineError.value = "";
      state.instructorAttemptEvidence.value = null;
      state.instructorAttemptEvidenceError.value = "";
      state.scoreAmendments.value = [];
      state.scoreAmendmentsError.value = "";
      state.manualScoringError.value = "";
      return;
    }

    state.instructorRosterLoading.value = true;
    state.instructorAssignmentCapabilities.value = null;
    state.instructorReportingLoading.value = true;
    state.scoreAmendmentsLoading.value = true;
    state.manualScoringLoading.value = true;
    state.instructorRosterError.value = "";
    state.instructorReportingError.value = "";
    state.instructorLearnerReport.value = null;
    state.instructorLearnerReportError.value = "";
    state.scoreAmendmentsError.value = "";
    state.manualScoringError.value = "";

    try {
      const capabilities = await loadInstructorAssignmentCapabilities(scopedAssignmentId);
      state.instructorAssignmentCapabilities.value = capabilities;
      const [roster, results, report, amendments, manualQueue] = await Promise.all([
        loadInstructorRoster(scopedAssignmentId),
        capabilities.canReadResults ? loadInstructorResults(scopedAssignmentId) : null,
        capabilities.canReadResults ? loadInstructorAssignmentReport(scopedAssignmentId) : null,
        capabilities.canReadResults ? loadScoreAmendments(scopedAssignmentId) : null,
        capabilities.canScoreResults
          ? loadManualScoringQueue({ assignmentId: scopedAssignmentId })
          : null,
      ]);
      state.instructorRoster.value = roster;
      state.instructorResults.value = results;
      state.instructorAssignmentReport.value = report;
      state.scoreAmendments.value = amendments?.amendments ?? [];
      state.manualScoringQueue.value = manualQueue?.rows ?? [];
      state.instructorWorkspaceStatus.value =
        "Instructor workspace is reading QFlowLearn Delivery's authoritative assessment, roster, result, and reporting ledgers.";

      if (
        state.selectedInstructorAttemptId.value &&
        roster.rows.some(
          (row) => row.latestAttempt.attemptId === state.selectedInstructorAttemptId.value,
        )
      ) {
        await refreshInstructorAttemptTimeline(state.selectedInstructorAttemptId.value);
      } else {
        state.instructorAttemptTimeline.value = null;
        state.instructorAttemptTimelineError.value = "";
        state.instructorAttemptEvidence.value = null;
        state.instructorAttemptEvidenceError.value = "";
      }
    } catch (error) {
      state.instructorRoster.value = null;
      state.instructorResults.value = null;
      state.instructorAssignmentReport.value = null;
      state.instructorLearnerReport.value = null;
      state.scoreAmendments.value = [];
      state.manualScoringQueue.value = [];
      state.manualScoringAttempt.value = null;
      state.instructorRosterError.value = formatError(error);
      state.instructorReportingError.value = formatError(error);
      state.instructorLearnerReportError.value = formatError(error);
      state.scoreAmendmentsError.value = formatError(error);
      state.manualScoringError.value = formatError(error);
    } finally {
      state.instructorRosterLoading.value = false;
      state.instructorReportingLoading.value = false;
      state.scoreAmendmentsLoading.value = false;
      state.manualScoringLoading.value = false;
    }
  }

  async function loadSelectedInstructorAssignment(
    assignmentId: string,
    options?: {
      refreshWorkspace?: boolean;
    },
  ): Promise<void> {
    state.selectedInstructorAssignmentId.value = assignmentId;
    state.instructorAssignmentLoading.value = true;
    state.instructorAssignmentError.value = "";

    try {
      state.selectedInstructorAssignment.value = await loadInstructorAssignment(assignmentId);
      if (options?.refreshWorkspace ?? true) {
        await refreshInstructorWorkspace(assignmentId);
      }
    } catch (error) {
      state.selectedInstructorAssignment.value = null;
      state.instructorAssignmentError.value = formatError(error);
      throw error;
    } finally {
      state.instructorAssignmentLoading.value = false;
    }
  }

  async function refreshInstructorAssignments(): Promise<void> {
    state.instructorAssignmentsLoading.value = true;
    state.instructorAssignmentsError.value = "";

    try {
      const payload = await loadInstructorAssignmentsRequest();
      state.instructorAssignments.value = payload.assignments;

      const currentSelectionStillExists = payload.assignments.some(
        (assignment) => assignment.assignmentId === state.selectedInstructorAssignmentId.value,
      );
      const nextAssignmentId =
        (currentSelectionStillExists
          ? state.selectedInstructorAssignmentId.value
          : payload.assignments[0]?.assignmentId) ?? "";

      if (nextAssignmentId) {
        await loadSelectedInstructorAssignment(nextAssignmentId, {
          refreshWorkspace: true,
        });
      } else {
        state.clearInstructorWorkspace();
      }
    } catch (error) {
      state.instructorAssignments.value = [];
      state.instructorAssignmentsError.value = formatError(error);
      state.clearInstructorWorkspace();
    } finally {
      state.instructorAssignmentsLoading.value = false;
    }
  }

  async function refreshInstructorPublishedAssessmentVersions(): Promise<void> {
    state.instructorPublishedAssessmentVersionsLoading.value = true;
    state.instructorPublishedAssessmentVersionsError.value = "";

    try {
      const payload = await loadInstructorPublishedAssessmentVersionsRequest();
      state.instructorPublishedAssessmentVersions.value = payload.versions;
    } catch (error) {
      state.instructorPublishedAssessmentVersions.value = [];
      state.instructorPublishedAssessmentVersionsError.value = formatError(error);
    } finally {
      state.instructorPublishedAssessmentVersionsLoading.value = false;
    }
  }

  async function refreshInstructorSections(): Promise<void> {
    await runInstructorRequest({
      busy: state.instructorSectionsLoading,
      error: state.instructorSectionsError,
      formatError,
      run: async () => {
        const payload = await loadInstructorSections();
        state.instructorSections.value = payload.sections;
      },
      onError: () => {
        state.instructorSections.value = [];
      },
    });
  }

  async function searchInstructorLearners(searchInput: {
    search?: string;
    learnerIds?: string[];
  }): Promise<void> {
    state.instructorLearnerSearchLoading.value = true;
    state.instructorLearnerSearchError.value = "";

    try {
      const payload = await loadInstructorLearners(searchInput);
      const existingById = new Map(
        state.instructorLearnerSearchResults.value.map((learner) => [learner.id, learner]),
      );
      for (const learner of payload.learners) {
        existingById.set(learner.id, learner);
      }
      state.instructorLearnerSearchResults.value = [...existingById.values()].sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      );
    } catch (error) {
      state.instructorLearnerSearchError.value = formatError(error);
    } finally {
      state.instructorLearnerSearchLoading.value = false;
    }
  }

  async function selectInstructorAssignment(assignmentId: string): Promise<void> {
    await loadSelectedInstructorAssignment(assignmentId, {
      refreshWorkspace: true,
    });
  }

  function buildInstructorAttemptAction(
    action: InstructorAttemptActionInput,
  ): OperatorAttemptActionRequest {
    const actor = state.buildInstructorPolicyActor();

    switch (action.type) {
      case "transfer-workstation":
        return { ...action, actor };
      case "extend-time":
        return {
          ...action,
          actor,
        };
      case "reopen-attempt":
        return {
          ...action,
          actor,
        };
      case "post-operator-message":
        return {
          ...action,
          actor,
        };
    }
  }

  async function refreshAccommodationProfiles(): Promise<void> {
    await runInstructorRequest({
      busy: state.accommodationProfilesLoading,
      error: state.accommodationProfilesError,
      formatError,
      run: async () => {
        const assignmentId = state.selectedInstructorAssignmentId.value;
        if (assignmentId) {
          const capabilities = await loadInstructorAssignmentCapabilities(assignmentId);
          if (!capabilities.canManageAccommodations) {
            state.accommodationProfiles.value = [];
            return;
          }
        }
        const payload = await loadAccommodationProfiles();
        state.accommodationProfiles.value = payload.profiles;
      },
      onError: () => {
        state.accommodationProfiles.value = [];
      },
    });
  }

  async function createAccommodationProfile(input: {
    tenantId: string;
    name: string;
    description?: string | null;
    profile: RuntimeAccommodationProfile["profile"];
  }): Promise<RuntimeAccommodationProfile> {
    return runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.accommodationProfilesError,
      formatError,
      run: async () => {
        const profile = await createAccommodationProfileRequest({
          tenantId: input.tenantId,
          name: input.name,
          description: input.description ?? null,
          status: "active",
          profile: input.profile,
          actor: state.buildInstructorAssignmentActor(),
        });
        state.accommodationProfiles.value = [
          profile,
          ...state.accommodationProfiles.value.filter((entry) => entry.id !== profile.id),
        ];
        state.instructorWorkspaceStatus.value =
          "Accommodation profile created. It is available for learner assignment.";
        return profile;
      },
    });
  }

  async function refreshLearnerAccommodationAssignments(learnerId?: string): Promise<void> {
    if (!learnerId) {
      state.learnerAccommodationAssignments.value = [];
      return;
    }

    await runInstructorRequest({
      busy: state.learnerAccommodationAssignmentsLoading,
      error: state.accommodationProfilesError,
      formatError,
      run: async () => {
        const assignmentId = state.selectedInstructorAssignmentId.value;
        if (assignmentId) {
          const capabilities = await loadInstructorAssignmentCapabilities(assignmentId);
          if (!capabilities.canManageAccommodations) {
            state.learnerAccommodationAssignments.value = [];
            return;
          }
        }
        const payload = await loadLearnerAccommodationAssignments(learnerId);
        state.learnerAccommodationAssignments.value = payload.assignments;
      },
      onError: () => {
        state.learnerAccommodationAssignments.value = [];
      },
    });
  }

  async function refreshProvisioningRuns(): Promise<void> {
    await runInstructorRequest({
      busy: state.rosterCsvImportLoading,
      error: state.rosterCsvImportError,
      formatError,
      run: async () => {
        const payload = await loadProvisioningRuns();
        state.provisioningRuns.value = payload.runs;
      },
      onError: () => {
        state.provisioningRuns.value = [];
      },
    });
  }

  function mergeProvisioningRun(result: RuntimeRosterCsvImportResponse): void {
    state.rosterCsvImportPreview.value = result;
    state.provisioningRuns.value = [
      result.run,
      ...state.provisioningRuns.value.filter((run) => run.id !== result.run.id),
    ].slice(0, 10);
  }

  async function previewRosterCsvImport(input: {
    sourceName?: string | null;
    csvText: string;
  }): Promise<RuntimeRosterCsvImportResponse> {
    return runInstructorRequest({
      busy: state.rosterCsvImportLoading,
      error: state.rosterCsvImportError,
      formatError,
      run: async () => {
        const result = await previewRosterCsvImportRequest({
          ...input,
          actor: state.buildInstructorAssignmentActor(),
        });
        mergeProvisioningRun(result);
        state.instructorWorkspaceStatus.value =
          "Roster import dry run completed. QFlowLearn Delivery has not changed learner or section records yet.";
        return result;
      },
    });
  }

  async function applyRosterCsvImport(input: {
    sourceName?: string | null;
    csvText: string;
  }): Promise<RuntimeRosterCsvImportResponse> {
    return runInstructorRequest({
      busy: state.rosterCsvImportLoading,
      error: state.rosterCsvImportError,
      formatError,
      run: async () => {
        const result = await applyRosterCsvImportRequest({
          ...input,
          actor: state.buildInstructorAssignmentActor(),
        });
        mergeProvisioningRun(result);
        state.instructorWorkspaceStatus.value =
          "Roster CSV applied. QFlowLearn Delivery refreshed provisioning logs and can target imported sections from assessments.";
        await refreshInstructorSections();
        await refreshInstructorWorkspace();
        return result;
      },
    });
  }

  async function previewOneRosterZipImport(input: {
    sourceName?: string | null;
    zipFile: File;
  }): Promise<RuntimeRosterCsvImportResponse> {
    return runInstructorRequest({
      busy: state.rosterCsvImportLoading,
      error: state.rosterCsvImportError,
      formatError,
      run: async () => {
        const result = await previewOneRosterZipImportRequest({
          ...input,
          actor: state.buildInstructorAssignmentActor(),
        });
        mergeProvisioningRun(result);
        state.instructorWorkspaceStatus.value =
          "OneRoster ZIP dry run completed. QFlowLearn Delivery has not changed learner or section records yet.";
        return result;
      },
    });
  }

  async function applyOneRosterZipImport(input: {
    sourceName?: string | null;
    zipFile: File;
  }): Promise<RuntimeRosterCsvImportResponse> {
    return runInstructorRequest({
      busy: state.rosterCsvImportLoading,
      error: state.rosterCsvImportError,
      formatError,
      run: async () => {
        const result = await applyOneRosterZipImportRequest({
          ...input,
          actor: state.buildInstructorAssignmentActor(),
        });
        mergeProvisioningRun(result);
        state.instructorWorkspaceStatus.value =
          "OneRoster ZIP applied. QFlowLearn Delivery refreshed provisioning logs and hierarchy-aware section targeting.";
        await refreshInstructorSections();
        await refreshInstructorWorkspace();
        return result;
      },
    });
  }

  async function createInstructorAssignment(input: {
    assignmentId: string;
    assessmentId: string;
    assessmentVersionId: string;
    title: string;
    status?: CreateAssignmentRequest["status"];
    policySnapshot: CreateAssignmentRequest["policySnapshot"];
    targets?: CreateAssignmentRequest["targets"];
    ltiLinkages?: CreateAssignmentRequest["ltiLinkages"];
  }): Promise<RuntimeInstructorAssignment> {
    return runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.instructorAssignmentError,
      formatError,
      run: async () => {
        const assignment = await createInstructorAssignmentRequest({
          ...input,
          actor: state.buildInstructorAssignmentActor(),
        });
        state.selectedInstructorAssignmentId.value = assignment.id;
        state.instructorWorkspaceStatus.value =
          "Assessment created. QFlowLearn Delivery can now activate it, target learners, and drive roster state from this record.";
        await refreshInstructorAssignments();
        await dependencies.refreshStudentAssignments();
        return assignment;
      },
    });
  }

  async function updateInstructorAssignment(input: {
    assignmentId: string;
    request: Omit<UpdateAssignmentRequest, "actor">;
  }): Promise<RuntimeInstructorAssignment> {
    return runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.instructorAssignmentError,
      formatError,
      run: async () => {
        const assignment = await updateInstructorAssignmentRequest({
          assignmentId: input.assignmentId,
          request: {
            ...input.request,
            actor: state.buildInstructorAssignmentActor(),
          },
        });
        state.selectedInstructorAssignmentId.value = assignment.id;
        state.instructorWorkspaceStatus.value =
          "Assessment changes are saved. Future launches stay pinned to the updated delivery record.";
        await refreshInstructorAssignments();
        await dependencies.refreshStudentAssignments();
        return assignment;
      },
    });
  }

  async function activateInstructorAssignment(
    assignmentId = state.selectedInstructorAssignmentId.value,
  ): Promise<void> {
    if (!assignmentId) {
      return;
    }

    await runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.instructorAssignmentError,
      formatError,
      run: async () => {
        await activateInstructorAssignmentRequest(assignmentId);
        state.instructorWorkspaceStatus.value =
          "Assessment is active. QFlowLearn Delivery can now surface it in the student list and LTI entry paths.";
        await refreshInstructorAssignments();
        await dependencies.refreshStudentAssignments();
      },
    });
  }

  async function closeInstructorAssignment(
    assignmentId = state.selectedInstructorAssignmentId.value,
  ): Promise<void> {
    if (!assignmentId) {
      return;
    }

    await runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.instructorAssignmentError,
      formatError,
      run: async () => {
        await closeInstructorAssignmentRequest(assignmentId);
        state.instructorWorkspaceStatus.value =
          "Assessment is closed. Student launches stop while historical results remain available.";
        await refreshInstructorAssignments();
        await dependencies.refreshStudentAssignments();
      },
    });
  }

  async function saveAssignmentLearnerOverride(input: {
    assignmentId: string;
    learnerId: string;
    policyOverrides: AssignmentLearnerOverrideRecord["policyOverrides"];
    accommodations?: AssignmentLearnerOverrideRecord["accommodations"];
  }): Promise<RuntimeAssignmentLearnerOverride> {
    return runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.instructorRosterError,
      formatError,
      run: async () => {
        const override = await saveAssignmentLearnerOverrideRequest({
          assignmentId: input.assignmentId,
          learnerId: input.learnerId,
          request: {
            actor: state.buildInstructorAssignmentActor(),
            policyOverrides: input.policyOverrides,
            accommodations: input.accommodations,
          },
        });
        state.instructorWorkspaceStatus.value =
          "Learner override saved. Future attempts for this learner inherit the updated policy before launch.";
        await refreshInstructorWorkspace(input.assignmentId);
        return override;
      },
    });
  }

  async function saveLearnerAccommodationProfile(input: {
    learnerId: string;
    profileId: string;
    status?: "active" | "inactive";
  }): Promise<RuntimeLearnerAccommodationAssignment> {
    return runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.accommodationProfilesError,
      formatError,
      run: async () => {
        const assignment = await saveLearnerAccommodationProfileRequest(input);
        state.instructorWorkspaceStatus.value =
          "Accommodation profile assignment saved. Future launches snapshot the effective profile onto each attempt.";
        await refreshLearnerAccommodationAssignments(input.learnerId);
        await refreshInstructorWorkspace();
        return assignment;
      },
    });
  }

  async function applyInstructorAttemptAction(input: {
    attemptId: string;
    action: InstructorAttemptActionInput;
  }): Promise<AttemptPolicyReadResponse> {
    return runInstructorRequest({
      busy: state.instructorWorkspaceBusy,
      error: state.instructorRosterError,
      formatError,
      run: async () => {
        const projection = await applyInstructorAttemptActionRequest({
          attemptId: input.attemptId,
          action: buildInstructorAttemptAction(input.action),
        });

        if (input.attemptId === dependencies.getCurrentAttemptId()) {
          await dependencies.applyActiveAttemptPolicyProjection(
            projection,
            "Instructor intervention changed the authoritative live attempt policy.",
          );
        }

        state.instructorWorkspaceStatus.value =
          "Live intervention accepted. QFlowLearn Delivery kept the durable attempt overlay path and refreshed the roster projection.";
        await refreshInstructorWorkspace();
        await refreshInstructorAttemptTimeline(input.attemptId);
        return projection;
      },
    });
  }

  return {
    activateInstructorAssignment,
    applyInstructorAttemptAction,
    applyOneRosterZipImport,
    applyRosterCsvImport,
    closeInstructorAssignment,
    createAccommodationProfile,
    createInstructorAssignment,
    previewOneRosterZipImport,
    previewRosterCsvImport,
    refreshAccommodationProfiles,
    refreshInstructorAssignments,
    refreshInstructorAttemptTimeline,
    refreshInstructorPublishedAssessmentVersions,
    refreshInstructorSections,
    refreshInstructorWorkspace,
    refreshLearnerAccommodationAssignments,
    refreshProvisioningRuns,
    saveAssignmentLearnerOverride,
    saveLearnerAccommodationProfile,
    searchInstructorLearners,
    selectInstructorAssignment,
    updateInstructorAssignment,
  };
}

export type InstructorAssignmentActions = ReturnType<typeof createInstructorAssignmentActions>;
