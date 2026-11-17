import type {
  AttemptPolicyReadResponse,
  CreateAssignmentRequest,
  OperatorAttemptActionRequest,
  ResultOpsFilterOptionsSnapshot,
  ResultOpsSummarySnapshot,
  InstructorLmsWorkspaceResponse,
  AssignmentStaffCapabilities,
} from "@harbor/attempt-protocol";
import { computed, reactive, ref } from "../preact-reactivity";
import type {
  RuntimeAccommodationProfile,
  RuntimeInstructorAssignment,
  RuntimeInstructorAssignmentReport,
  RuntimeInstructorAssignments,
  RuntimeInstructorLearnerReport,
  RuntimeInstructorLearners,
  RuntimeInstructorPublishedAssessmentVersions,
  RuntimeInstructorResults,
  RuntimeInstructorRoster,
  RuntimeInstructorSections,
  RuntimeLearnerAccommodationAssignment,
  RuntimeManualScoringAttempt,
  RuntimeManualScoringQueue,
  RuntimeProvisioningRuns,
  RuntimeReportExportCatalog,
  RuntimeResultsOpsRow,
  RuntimeRosterCsvImportResponse,
  RuntimeScoreAmendmentsResponse,
  RuntimeAttemptEvidence,
  RuntimeAttemptTimeline,
} from "../runtime-session";

export type InstructorAttemptActionInput =
  | Omit<Extract<OperatorAttemptActionRequest, { type: "transfer-workstation" }>, "actor">
  | Omit<Extract<OperatorAttemptActionRequest, { type: "extend-time" }>, "actor">
  | Omit<Extract<OperatorAttemptActionRequest, { type: "reopen-attempt" }>, "actor">
  | Omit<Extract<OperatorAttemptActionRequest, { type: "post-operator-message" }>, "actor">;

export type InstructorWorkspaceDependencies = {
  refreshStudentAssignments(): Promise<void>;
  getCurrentAttemptId(): string | null;
  applyActiveAttemptPolicyProjection(
    projection: AttemptPolicyReadResponse,
    statusMessage: string,
  ): Promise<void>;
};

export function createEmptyResultsOpsSummary(): ResultOpsSummarySnapshot {
  return {
    finalization: {
      pendingCount: 0,
      failedCount: 0,
    },
    exports: {
      pendingCount: 0,
      failedCount: 0,
      completeCount: 0,
      retryPendingCount: 0,
      retryFailedCount: 0,
      retryCompleteCount: 0,
      latestUpdatedAt: null,
    },
    remediation: {
      pendingCount: 0,
      failedCount: 0,
      completeCount: 0,
      exportPendingCount: 0,
      exportFailedCount: 0,
      exportCompleteCount: 0,
      latestRequest: null,
    },
  };
}

export function createEmptyResultsOpsFilterOptions(): ResultOpsFilterOptionsSnapshot {
  return {
    tenants: [],
    assignments: [],
  };
}

export function createInstructorWorkspaceState() {
  const instructorActor = reactive({
    actorId: "inst_local_demo",
    displayName: "Local Instructor",
  });
  const instructorAssignments = ref<RuntimeInstructorAssignments["assignments"]>([]);
  const instructorAssignmentsLoading = ref(false);
  const instructorAssignmentsError = ref("");
  const instructorPublishedAssessmentVersions = ref<
    RuntimeInstructorPublishedAssessmentVersions["versions"]
  >([]);
  const instructorPublishedAssessmentVersionsLoading = ref(false);
  const instructorPublishedAssessmentVersionsError = ref("");
  const selectedInstructorAssignmentId = ref("");
  const selectedInstructorAssignment = ref<RuntimeInstructorAssignment | null>(null);
  const instructorAssignmentLoading = ref(false);
  const instructorAssignmentError = ref("");
  const instructorSections = ref<RuntimeInstructorSections["sections"]>([]);
  const instructorSectionsLoading = ref(false);
  const instructorSectionsError = ref("");
  const instructorLearnerSearchResults = ref<RuntimeInstructorLearners["learners"]>([]);
  const instructorLearnerSearchLoading = ref(false);
  const instructorLearnerSearchError = ref("");
  const instructorRoster = ref<RuntimeInstructorRoster | null>(null);
  const instructorAssignmentCapabilities = ref<AssignmentStaffCapabilities | null>(null);
  const instructorResults = ref<RuntimeInstructorResults | null>(null);
  const instructorAssignmentReport = ref<RuntimeInstructorAssignmentReport | null>(null);
  const instructorLearnerReport = ref<RuntimeInstructorLearnerReport | null>(null);
  const reportExportCatalog = ref<RuntimeReportExportCatalog | null>(null);
  const reportExportLoading = ref(false);
  const reportExportError = ref("");
  const accommodationProfiles = ref<RuntimeAccommodationProfile[]>([]);
  const learnerAccommodationAssignments = ref<RuntimeLearnerAccommodationAssignment[]>([]);
  const accommodationProfilesLoading = ref(false);
  const learnerAccommodationAssignmentsLoading = ref(false);
  const accommodationProfilesError = ref("");
  const instructorRosterLoading = ref(false);
  const instructorRosterError = ref("");
  const instructorReportingLoading = ref(false);
  const instructorReportingError = ref("");
  const instructorLearnerReportLoading = ref(false);
  const instructorLearnerReportError = ref("");
  const instructorWorkspaceBusy = ref(false);
  const instructorWorkspaceStatus = ref(
    "Assessments, roster state, and learner interventions are available from dedicated instructor pages.",
  );
  const resultsOpsRows = ref<RuntimeResultsOpsRow[]>([]);
  const resultsOpsSummary = ref<ResultOpsSummarySnapshot>(createEmptyResultsOpsSummary());
  const resultsOpsFilterOptions = ref(createEmptyResultsOpsFilterOptions());
  const resultsOpsLoading = ref(false);
  const resultsOpsBusyAttemptId = ref<string | null>(null);
  const resultsOpsError = ref("");
  const resultsOpsStatus = ref(
    "QFlowLearn Delivery reads pending or failed result-processing work from its authoritative finalization, export, and remediation ledgers.",
  );
  const instructorLmsIntegration = ref<InstructorLmsWorkspaceResponse | null>(null);
  const instructorLmsLoading = ref(false);
  const instructorLmsSyncingAttemptId = ref<string | null>(null);
  const instructorLmsSchedulingResourceLinkId = ref<string | null>(null);
  const instructorLmsError = ref("");
  const instructorLmsStatus = ref(
    "LTI launch, Deep Linking, AGS, and NRPS protocol behavior is delegated to lti-tool; QFlowLearn Delivery tracks assignment mappings and LMS evidence.",
  );
  const instructorAttemptTimeline = ref<RuntimeAttemptTimeline | null>(null);
  const instructorAttemptTimelineLoading = ref(false);
  const instructorAttemptTimelineError = ref("");
  const instructorAttemptEvidence = ref<RuntimeAttemptEvidence | null>(null);
  const instructorAttemptEvidenceLoading = ref(false);
  const instructorAttemptEvidenceError = ref("");
  const scoreAmendments = ref<RuntimeScoreAmendmentsResponse["amendments"]>([]);
  const scoreAmendmentsLoading = ref(false);
  const scoreAmendmentsError = ref("");
  const manualScoringQueue = ref<RuntimeManualScoringQueue["rows"]>([]);
  const manualScoringAttempt = ref<RuntimeManualScoringAttempt | null>(null);
  const manualScoringLoading = ref(false);
  const manualScoringSaving = ref(false);
  const manualScoringError = ref("");
  const manualScoringStatus = ref(
    "Manual scoring drafts stay private until an instructor finalizes the attempt.",
  );
  const provisioningRuns = ref<RuntimeProvisioningRuns["runs"]>([]);
  const rosterCsvImportPreview = ref<RuntimeRosterCsvImportResponse | null>(null);
  const rosterCsvImportLoading = ref(false);
  const rosterCsvImportError = ref("");

  const instructorAssignmentCount = computed(() => instructorAssignments.value.length);
  const instructorRosterRows = computed(() => instructorRoster.value?.rows ?? []);
  const selectedInstructorAssignmentTitle = computed(
    () =>
      selectedInstructorAssignment.value?.title ??
      instructorAssignments.value.find(
        (assignment) => assignment.assignmentId === selectedInstructorAssignmentId.value,
      )?.title ??
      "No assessment selected",
  );
  const selectedInstructorAttemptId = computed(
    () => instructorAttemptTimeline.value?.attemptId ?? null,
  );

  function buildInstructorAssignmentActor(): CreateAssignmentRequest["actor"] {
    return {
      role: "instructor",
      actorId: instructorActor.actorId.trim() || "inst_local_demo",
      displayName: instructorActor.displayName.trim() || "Local Instructor",
    };
  }

  function buildInstructorPolicyActor(): OperatorAttemptActionRequest["actor"] {
    return {
      role: "instructor",
      actorId: instructorActor.actorId.trim() || "inst_local_demo",
      displayName: instructorActor.displayName.trim() || "Local Instructor",
    };
  }

  function clearInstructorWorkspace(): void {
    instructorAssignmentCapabilities.value = null;
    selectedInstructorAssignmentId.value = "";
    selectedInstructorAssignment.value = null;
    instructorAssignmentError.value = "";
    instructorRoster.value = null;
    instructorResults.value = null;
    instructorAssignmentReport.value = null;
    instructorLearnerReport.value = null;
    instructorRosterError.value = "";
    instructorReportingError.value = "";
    instructorLearnerReportError.value = "";
    instructorAttemptTimeline.value = null;
    instructorAttemptTimelineError.value = "";
    instructorAttemptEvidence.value = null;
    instructorAttemptEvidenceError.value = "";
    scoreAmendments.value = [];
    scoreAmendmentsError.value = "";
    manualScoringError.value = "";
  }

  return {
    instructorAssignmentCapabilities,
    accommodationProfiles,
    accommodationProfilesError,
    accommodationProfilesLoading,
    buildInstructorAssignmentActor,
    buildInstructorPolicyActor,
    clearInstructorWorkspace,
    instructorActor,
    instructorAssignmentCount,
    instructorAssignmentError,
    instructorAssignmentLoading,
    instructorAssignmentReport,
    instructorAssignments,
    instructorAssignmentsError,
    instructorAssignmentsLoading,
    instructorAttemptEvidence,
    instructorAttemptEvidenceError,
    instructorAttemptEvidenceLoading,
    instructorAttemptTimeline,
    instructorAttemptTimelineError,
    instructorAttemptTimelineLoading,
    instructorLearnerReport,
    instructorLearnerReportError,
    instructorLearnerReportLoading,
    instructorLearnerSearchError,
    instructorLearnerSearchLoading,
    instructorLearnerSearchResults,
    instructorLmsError,
    instructorLmsIntegration,
    instructorLmsLoading,
    instructorLmsSchedulingResourceLinkId,
    instructorLmsStatus,
    instructorLmsSyncingAttemptId,
    instructorPublishedAssessmentVersions,
    instructorPublishedAssessmentVersionsError,
    instructorPublishedAssessmentVersionsLoading,
    instructorReportingError,
    instructorReportingLoading,
    instructorResults,
    instructorRoster,
    instructorRosterError,
    instructorRosterLoading,
    instructorRosterRows,
    instructorSections,
    instructorSectionsError,
    instructorSectionsLoading,
    instructorWorkspaceBusy,
    instructorWorkspaceStatus,
    learnerAccommodationAssignments,
    learnerAccommodationAssignmentsLoading,
    manualScoringAttempt,
    manualScoringError,
    manualScoringLoading,
    manualScoringQueue,
    manualScoringSaving,
    manualScoringStatus,
    provisioningRuns,
    reportExportCatalog,
    reportExportError,
    reportExportLoading,
    resultsOpsBusyAttemptId,
    resultsOpsError,
    resultsOpsFilterOptions,
    resultsOpsLoading,
    resultsOpsRows,
    resultsOpsStatus,
    resultsOpsSummary,
    rosterCsvImportError,
    rosterCsvImportLoading,
    rosterCsvImportPreview,
    scoreAmendments,
    scoreAmendmentsError,
    scoreAmendmentsLoading,
    selectedInstructorAssignment,
    selectedInstructorAssignmentId,
    selectedInstructorAssignmentTitle,
    selectedInstructorAttemptId,
  };
}

export type InstructorWorkspaceState = ReturnType<typeof createInstructorWorkspaceState>;
