import {
  HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
  type HarborShellAccommodationState,
  resolveHarborPnpPolicy,
} from "@harbor/attempt-protocol";
import type { RendererConfiguration, RendererHostHandle } from "@harbor/renderer-adapter";
import { isQtiAttemptStateV1 } from "@longsightgroup/qti3-core";

import { formatError } from "./formatting";
import { createDeliverySessionRuntime } from "./delivery-session";
import type { DeliverySessionLifecycle } from "./delivery-session-context";
import type { DeliverySessionRuntime } from "./delivery-session";
import { createInstructorWorkspaceRuntime } from "./instructor-workspace";
import type { MutableRef } from "./ref-like";
import {
  createRendererLifecycleRuntime,
  type RendererLifecycleRuntime,
} from "./renderer-lifecycle";
import { createStudentLaunchRuntime } from "./student-launch";
import { computed, ref } from "../preact-reactivity";
import { resolveRendererPnp, resolveRendererSessionControl } from "../runtime-session";

export interface HarborRuntimeWiring {
  deliverySession: DeliverySessionRuntime;
  deliveryLifecycle: DeliverySessionLifecycle;
  studentLaunch: ReturnType<typeof createStudentLaunchRuntime>;
  instructorWorkspace: ReturnType<typeof createInstructorWorkspaceRuntime>;
  rendererLifecycle: RendererLifecycleRuntime;
  rendererHost: ReturnType<typeof ref<RendererHostHandle | null>>;
  rendererAccommodationStatusLabel: ReturnType<typeof computed<string>>;
  shellAccommodationTools: ReturnType<typeof computed<HarborShellAccommodationState>>;
  pnpPolicy: ReturnType<typeof computed<ReturnType<typeof resolveHarborPnpPolicy>>>;
  runtimeBanner: ReturnType<typeof computed<string>>;
  rendererConfiguration: ReturnType<typeof computed<RendererConfiguration | null>>;
}

const deliveryFacadeKeys = [
  "assessmentHistory",
  "attemptClient",
  "attemptEditingLocked",
  "submissionState",
  "authoritativeCurrentItemRef",
  "bootstrappedSession",
  "canNavigateBackward",
  "canNavigateForward",
  "capturedItemStates",
  "currentAssetCount",
  "currentClientSessionId",
  "currentItemBlocksNavigation",
  "currentItemId",
  "currentItemPayload",
  "currentItemPositionLabel",
  "currentItemTitle",
  "currentItemValidationMessageCount",
  "deliveryBusy",
  "deliveryContextBlockedMessage",
  "deliveryContextState",
  "deliveryContextStatusLabel",
  "deliveryContextSupportLabel",
  "deliveryState",
  "deliveryStateLabel",
  "entryMode",
  "errorMessage",
  "highestCommittedSequence",
  "historyErrorMessage",
  "historyFocusAttemptId",
  "historyLoading",
  "itemLifecycleState",
  "itemReady",
  "launchActorLabel",
  "latestSubmittedAttempt",
  "latestSubmittedOutcomeMessage",
  "latestSubmittedScoreLabel",
  "loading",
  "manifestItemCount",
  "navigateItem",
  "navigateToItem",
  "nextSequenceNumber",
  "openAttemptHistory",
  "pendingReplayCount",
  "persistAuthoritativeSessionState",
  "policyOverlayStatusLabel",
  "policyRefreshStatus",
  "policyState",
  "queueDraftResponse",
  "refreshAssessmentHistory",
  "refreshAttemptPolicy",
  "remainingTimeLabel",
  "rendererRestoreState",
  "lastConfirmedSaveAt",
  "responseSaveStatus",
  "replayStatus",
  "retryPendingWork",
  "runtimeManifest",
  "sessionIsStale",
  "sessionTitle",
  "submitAttempt",
  "submitStatusLabel",
] as const satisfies readonly (keyof DeliverySessionRuntime)[];

const studentFacadeKeys = [
  "accessCodeForm",
  "institutionalSession",
  "launchAccessCode",
  "launchPreview",
  "launchStudentAssignment",
  "openStudentSafeExamBrowser",
  "previewForm",
  "refreshInstitutionalSession",
  "refreshStudentAssignments",
  "signedInLearnerEmail",
  "signedInLearnerLabel",
  "signOutInstitutionalSession",
  "startInstitutionalLogin",
  "studentAssignments",
  "studentAssignmentsError",
  "studentAssignmentsLoading",
  "studentSafeExamBrowserLaunches",
] as const satisfies readonly (keyof ReturnType<typeof createStudentLaunchRuntime>)[];

const instructorFacadeKeys = [
  "activateInstructorAssignment",
  "accommodationProfiles",
  "accommodationProfilesError",
  "accommodationProfilesLoading",
  "applyInstructorAttemptAction",
  "applyOneRosterZipImport",
  "applyRosterCsvImport",
  "buildInstructorLmsEvidenceReportUrl",
  "closeInstructorAssignment",
  "createAccommodationProfile",
  "createInstructorAssignment",
  "createScoreAmendment",
  "deactivateScoreAmendment",
  "exportInstructorAssignmentBundle",
  "exportInstructorAssignmentReport",
  "exportInstructorLearnerReport",
  "exportInstructorLearnerReportBundle",
  "exportReportDataDictionary",
  "exportScoreAmendmentEvidence",
  "finalizeManualScoringAttempt",
  "instructorActor",
  "instructorAssignmentCapabilities",
  "instructorAssignmentCount",
  "instructorAssignmentError",
  "instructorAssignmentLoading",
  "instructorAssignmentReport",
  "instructorAssignments",
  "instructorAssignmentsError",
  "instructorAssignmentsLoading",
  "instructorAttemptEvidence",
  "instructorAttemptEvidenceError",
  "instructorAttemptEvidenceLoading",
  "instructorAttemptTimeline",
  "instructorAttemptTimelineError",
  "instructorAttemptTimelineLoading",
  "instructorLearnerReport",
  "instructorLearnerReportError",
  "instructorLearnerReportLoading",
  "instructorLearnerSearchError",
  "instructorLearnerSearchLoading",
  "instructorLearnerSearchResults",
  "instructorLmsError",
  "instructorLmsIntegration",
  "instructorLmsLoading",
  "instructorLmsSchedulingResourceLinkId",
  "instructorLmsStatus",
  "instructorLmsSyncingAttemptId",
  "instructorPublishedAssessmentVersions",
  "instructorPublishedAssessmentVersionsError",
  "instructorPublishedAssessmentVersionsLoading",
  "instructorReportingError",
  "instructorReportingLoading",
  "instructorResults",
  "instructorRoster",
  "instructorRosterError",
  "instructorRosterLoading",
  "instructorRosterRows",
  "instructorSections",
  "instructorSectionsError",
  "instructorSectionsLoading",
  "instructorWorkspaceBusy",
  "instructorWorkspaceStatus",
  "learnerAccommodationAssignments",
  "learnerAccommodationAssignmentsLoading",
  "manualScoringAttempt",
  "manualScoringError",
  "manualScoringLoading",
  "manualScoringQueue",
  "manualScoringSaving",
  "manualScoringStatus",
  "openManualScoringAttempt",
  "previewOneRosterZipImport",
  "previewRosterCsvImport",
  "previewScoreAmendment",
  "provisioningRuns",
  "refreshAccommodationProfiles",
  "refreshInstructorAssignments",
  "refreshInstructorAttemptTimeline",
  "refreshInstructorLearnerReport",
  "refreshInstructorLmsIntegrations",
  "refreshInstructorPublishedAssessmentVersions",
  "refreshInstructorSections",
  "refreshInstructorWorkspace",
  "refreshLearnerAccommodationAssignments",
  "refreshManualScoringQueue",
  "refreshProvisioningRuns",
  "refreshReportExportCatalog",
  "refreshResultsOps",
  "reportExportCatalog",
  "reportExportError",
  "reportExportLoading",
  "requestResultsOpsRetry",
  "resultsOpsBusyAttemptId",
  "resultsOpsError",
  "resultsOpsFilterOptions",
  "resultsOpsLoading",
  "resultsOpsRows",
  "resultsOpsStatus",
  "resultsOpsSummary",
  "rosterCsvImportError",
  "rosterCsvImportLoading",
  "rosterCsvImportPreview",
  "saveAssignmentLearnerOverride",
  "saveLearnerAccommodationProfile",
  "saveManualScore",
  "scheduleInstructorLmsNrps",
  "scoreAmendments",
  "scoreAmendmentsError",
  "scoreAmendmentsLoading",
  "searchInstructorLearners",
  "selectInstructorAssignment",
  "selectedInstructorAssignment",
  "selectedInstructorAssignmentId",
  "selectedInstructorAssignmentTitle",
  "selectedInstructorAttemptId",
  "syncInstructorLmsNrps",
  "updateInstructorAssignment",
] as const satisfies readonly (keyof ReturnType<typeof createInstructorWorkspaceRuntime>)[];

function pickFacadeProperties<T extends object, const Keys extends readonly (keyof T)[]>(
  source: T,
  keys: Keys,
): Pick<T, Keys[number]> {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<T, Keys[number]>;
}

export function createHarborRuntimeWiring(): HarborRuntimeWiring {
  const rendererHost = ref<RendererHostHandle | null>(null);
  const rendererLifecycleRef: MutableRef<RendererLifecycleRuntime> = { current: null };
  const studentLaunchRef: MutableRef<ReturnType<typeof createStudentLaunchRuntime>> = {
    current: null,
  };

  const [deliverySession, deliveryLifecycle] = createDeliverySessionRuntime({
    rendererLifecycle: rendererLifecycleRef,
    clearStudentSessionState() {
      studentLaunchRef.current?.clearSessionState();
    },
    refreshStudentAssignments() {
      return studentLaunchRef.current?.refreshStudentAssignments();
    },
  });

  const studentLaunch = createStudentLaunchRuntime({
    runLaunch: deliverySession.runLaunch,
    readOrCreateClientSessionId: deliveryLifecycle.recoveryCache.readOrCreateClientSessionId,
    setCurrentClientSessionId(value) {
      deliverySession.currentClientSessionId.value = value;
    },
    applyBootstrappedSession: deliverySession.applyBootstrappedSession,
    formatError,
  });
  studentLaunchRef.current = studentLaunch;

  const instructorWorkspace = createInstructorWorkspaceRuntime({
    refreshStudentAssignments: studentLaunch.refreshStudentAssignments,
    getCurrentAttemptId: () => deliverySession.bootstrappedSession.value?.payload.attemptId ?? null,
    applyActiveAttemptPolicyProjection: deliverySession.applyPolicyProjection,
  });

  const rendererLifecycle = createRendererLifecycleRuntime({
    rendererHost,
    itemReady: deliverySession.itemReady,
    currentItemId: deliverySession.currentItemId,
    runtimeManifest: deliverySession.runtimeManifest,
    capturedItemStates: deliverySession.capturedItemStates,
    itemLifecycleState: deliverySession.itemLifecycleState,
    rendererRestoreState: deliverySession.rendererRestoreState,
    replayStatus: deliverySession.replayStatus,
    errorMessage: deliverySession.errorMessage,
    writeCachedItemStates: deliveryLifecycle.recoveryCache.writeCachedItemStates,
    onResponseDirty: deliverySession.markResponseDirty,
    onResponseCheckpoint: deliverySession.autosaveResponse,
    getCurrentAttemptId: () => deliverySession.bootstrappedSession.value?.payload.attemptId ?? null,
    getDeliveryState: () => deliverySession.deliveryState.value,
    getSubmissionLocked: () =>
      deliverySession.finishCaptureInProgress.value ||
      deliverySession.submissionState.value.status !== "none",
    getSessionIsStale: () => deliverySession.sessionIsStale.value,
    projectedDeliveryTiming: deliverySession.projectedDeliveryTiming,
    formatError,
  });
  rendererLifecycleRef.current = rendererLifecycle;

  const rendererAccommodationStatusLabel = computed(() => {
    const rendererPnp = resolveRendererPnp(deliverySession.policyState.value);
    const sessionControl = resolveRendererSessionControl(deliverySession.policyState.value);
    const parts = [
      `single-column ${rendererPnp.layoutSingleColumn ? "on" : "off"}`,
      `glossary ${rendererPnp.glossaryOnScreen ? "on" : "off"}`,
      sessionControl.allow_review ? "review open" : "review locked",
      sessionControl.allow_skipping ? "skipping open" : "skipping locked",
    ];

    if (sessionControl.time_limits.max_time !== null) {
      parts.push(`max ${sessionControl.time_limits.max_time}s`);
    }

    return parts.join(" · ");
  });
  const shellAccommodationTools = computed(() => {
    return deliverySession.policyState.value.accommodations.shellTools ?? {};
  });
  const pnpPolicy = computed(() =>
    resolveHarborPnpPolicy({
      rendererPnp: deliverySession.policyState.value.accommodations.rendererPnp,
      shellTools: deliverySession.policyState.value.accommodations.shellTools ?? {},
      pnpEntitlement: deliverySession.policyState.value.accommodations.pnpEntitlement,
    }),
  );
  const runtimeBanner = computed(() => {
    if (
      studentLaunch.institutionalSession.value &&
      studentLaunch.studentAssignments.value.length > 0
    ) {
      return "Institutional sign-in, targeted assessment discovery, and student start or resume now share the same QFlowLearn Delivery shell before any attempt work begins.";
    }

    if (studentLaunch.institutionalSession.value) {
      return "Institutional sign-in is active. QFlowLearn Delivery can now resolve targeted assessments for this learner before launch.";
    }

    if (!deliverySession.bootstrappedSession.value) {
      return "Preview and access-code entry converge here before any renderer work begins.";
    }

    if (deliverySession.currentItemPayload.value) {
      return "Signed bootstrap, manifest hydration, and item delivery now flow through the QFlowLearn Delivery shell before the renderer receives XML.";
    }

    return deliverySession.bootstrappedSession.value.launchedFromQuery
      ? "Entered through query-driven launch and signed bootstrap exchange."
      : "Entered through in-shell launch and signed bootstrap exchange.";
  });
  const rendererConfiguration = computed<RendererConfiguration | null>(() => {
    if (!deliverySession.currentItemPayload.value) {
      return null;
    }

    const catalogRequestSupports = [
      HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
      "keyword-translation",
    ].filter((support) => pnpPolicy.value.catalogSupports.includes(support));
    const configuration: RendererConfiguration = {
      guid: deliverySession.currentItemPayload.value.item.id,
      itemHref: deliverySession.currentItemPayload.value.item.href,
      assets: deliverySession.currentItemPayload.value.item.assets,
      ...(catalogRequestSupports.length > 0
        ? {
            catalogRequestPolicy: {
              supports: catalogRequestSupports,
              includeDefaultFallback: true,
            },
          }
        : {}),
      pnp: resolveRendererPnp(deliverySession.policyState.value),
      sessionControl: resolveRendererSessionControl(deliverySession.policyState.value),
      keywordEmphasisEnabled: pnpPolicy.value.keywordEmphasisEnabled,
      builtIns: rendererLifecycle.buildRendererBuiltIns(),
    };

    if (isQtiAttemptStateV1(deliverySession.rendererRestoreState.value)) {
      configuration.state = deliverySession.rendererRestoreState.value;
    }

    return configuration;
  });

  return {
    deliverySession,
    deliveryLifecycle,
    studentLaunch,
    instructorWorkspace,
    rendererLifecycle,
    rendererHost,
    rendererAccommodationStatusLabel,
    shellAccommodationTools,
    pnpPolicy,
    runtimeBanner,
    rendererConfiguration,
  };
}

export function buildHarborRuntimeFacade(input: HarborRuntimeWiring) {
  const renderer = input.rendererLifecycle;

  return {
    ...pickFacadeProperties(input.deliverySession, deliveryFacadeKeys),
    ...pickFacadeProperties(input.studentLaunch, studentFacadeKeys),
    ...pickFacadeProperties(input.instructorWorkspace, instructorFacadeKeys),
    deliveryTiming: input.deliverySession.projectedDeliveryTiming,
    handleEndAttemptCompleted: renderer.handleEndAttemptCompleted,
    handleItemReady: renderer.handleItemReady,
    handleRendererInteractionObserved: renderer.handleRendererInteractionObserved,
    handleScoreAttemptCompleted: renderer.handleScoreAttemptCompleted,
    handleSuspendAttemptCompleted: renderer.handleSuspendAttemptCompleted,
    pnpPolicy: input.pnpPolicy,
    rendererAccommodationStatusLabel: input.rendererAccommodationStatusLabel,
    rendererConfiguration: input.rendererConfiguration,
    rendererHost: input.rendererHost,
    rendererStatus: input.deliverySession.replayStatus,
    requestEndAttempt: renderer.requestEndAttempt,
    requestSuspendAttempt: renderer.requestSuspendAttempt,
    runtimeBanner: input.runtimeBanner,
    shellAccommodationTools: input.shellAccommodationTools,
  };
}
