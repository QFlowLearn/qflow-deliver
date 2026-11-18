import type {
  AttemptPolicyState,
  AuthoritativeAttemptSessionState,
  CurrentItemRef,
  DeliveryContextEvaluation,
} from "@harbor/attempt-protocol";
import { createEmptyAttemptPolicyState } from "@harbor/attempt-protocol";

import { readValidationMessageCount } from "../attempt-scoring";
import type { AttemptClient } from "../attempt-client";
import type { BootstrappedSession } from "../bootstrap-client";
import { computed, ref } from "../preact-reactivity";
import type {
  RuntimeAssessmentHistory,
  RuntimeItemPayload,
  RuntimeManifestSummary,
} from "../runtime-session";
import { attemptItemStateStore } from "./delivery-stores";
import { createRuntimeRecoveryCache } from "./recovery-session-cache";
import { projectTimingForDisplay } from "./timing";
import { currentItemRequiresUnansweredResponse } from "./validation";
import type { SubmissionState } from "../submission-state";

export function createDeliverySessionState(input: { getLocationHref(this: void): string }) {
  const bootstrappedSession = ref<BootstrappedSession | null>(null);
  const runtimeManifest = ref<RuntimeManifestSummary | null>(null);
  const currentItemPayload = ref<RuntimeItemPayload | null>(null);
  const authoritativeCurrentItemRef = ref<CurrentItemRef | null>(null);
  const itemLifecycleState = ref<unknown>(null);
  const rendererRestoreState = ref<unknown>(null);
  const capturedItemStates = ref<Record<string, unknown>>({});
  const attemptClient = ref<AttemptClient | null>(null);
  const itemReady = ref(false);
  const loading = ref(false);
  const deliveryBusy = ref(false);
  const errorMessage = ref("");
  const responseEditRevision = ref(0);
  const responseSaveStatus = ref("No response changes yet");
  const lastConfirmedSaveAt = ref<string | null>(null);
  const replayStatus = ref("Responses are saved automatically as you move through the assessment.");
  const pendingReplayCount = ref(0);
  const highestCommittedSequence = ref(0);
  const nextSequenceNumber = ref(1);
  const currentClientSessionId = ref("");
  const sessionIsStale = ref(false);
  const submissionState = ref<SubmissionState>({ status: "none" });
  const finishCaptureInProgress = ref(false);
  const deliveryState = ref<AuthoritativeAttemptSessionState["attemptStatus"]>("active");
  const deliveryTiming = ref<AuthoritativeAttemptSessionState["timing"]>({
    startedAt: null,
    expiresAt: null,
    softCloseAt: null,
    acceptUntil: null,
    remainingTimeSeconds: null,
  });
  const deliveryTimingObservedAtMs = ref(Date.now());
  const timingClockTickMs = ref(Date.now());
  const policyState = ref<AttemptPolicyState>(createEmptyAttemptPolicyState());
  const deliveryContextState = ref<DeliveryContextEvaluation | null>(null);
  const assessmentHistory = ref<RuntimeAssessmentHistory | null>(null);
  const historyLoading = ref(false);
  const historyErrorMessage = ref("");
  const historyFocusAttemptId = ref<string | null>(null);
  const policyRefreshStatus = ref(
    "Pinned policy defaults remain active until an operator overlay is applied.",
  );
  const itemPresentationEvidenceKeys = new Set<string>();
  let historyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let timingClockTimer: ReturnType<typeof setInterval> | null = null;
  let deadlineAutomationInFlight = false;
  const warnedDeadlineKeys = new Set<string>();
  const autoSubmittedDeadlineKeys = new Set<string>();

  const recoveryCache = createRuntimeRecoveryCache({
    itemStateStore: attemptItemStateStore,
    currentClientSessionId,
    bootstrappedSession,
    getLocationHref: input.getLocationHref,
  });

  const entryMode = computed(() => bootstrappedSession.value?.mode ?? "idle");
  const sessionTitle = computed(() => runtimeManifest.value?.title ?? "QFlowLearn Delivery");
  const launchActorLabel = computed(() => {
    const actor = bootstrappedSession.value?.payload.launch.actor;
    if (!actor) {
      return "No launch context yet";
    }

    return actor.displayName || actor.id || actor.kind;
  });
  const currentItemId = computed(
    () =>
      authoritativeCurrentItemRef.value?.itemId ??
      currentItemPayload.value?.item.id ??
      bootstrappedSession.value?.payload.session.currentItemRef.itemId ??
      null,
  );
  const currentItemTitle = computed(
    () =>
      currentItemPayload.value?.item.title ??
      (currentItemId.value ? `Current item ${currentItemId.value}` : "No item loaded"),
  );
  const manifestItemCount = computed(() => runtimeManifest.value?.itemOrder.length ?? 0);
  const currentItemIndex = computed(() => {
    if (!runtimeManifest.value || !currentItemId.value) {
      return -1;
    }

    return runtimeManifest.value.itemOrder.findIndex((itemId) => itemId === currentItemId.value);
  });
  const currentItemPositionLabel = computed(() => {
    const sequence = runtimeManifest.value?.testSequence;
    if (sequence)
      return `Question ${Math.min(sequence.answered + 1, sequence.target)} of ${sequence.target}`;
    if (currentItemIndex.value < 0 || manifestItemCount.value === 0) {
      return "Question position unavailable";
    }

    return `Question ${currentItemIndex.value + 1} of ${manifestItemCount.value}`;
  });
  const hasPreviousItem = computed(() => currentItemIndex.value > 0);
  const hasNextItem = computed(() => {
    const sequence = runtimeManifest.value?.testSequence;
    if (sequence) return sequence.answered < sequence.target;
    if (currentItemIndex.value < 0 || !runtimeManifest.value) {
      return false;
    }

    return currentItemIndex.value < runtimeManifest.value.itemOrder.length - 1;
  });
  const canNavigateBackward = computed(
    () =>
      hasPreviousItem.value &&
      bootstrappedSession.value?.payload.deliveryPolicy.navigationMode !== "linear",
  );
  const canNavigateForward = computed(() => hasNextItem.value);
  const currentAssetCount = computed(() => currentItemPayload.value?.item.assets.length ?? 0);
  const currentItemValidationMessageCount = computed(() =>
    readValidationMessageCount(itemLifecycleState.value),
  );
  const currentItemHasUnansweredRequiredResponse = computed(() =>
    currentItemRequiresUnansweredResponse(
      currentItemPayload.value?.item.xml ?? "",
      itemLifecycleState.value,
    ),
  );
  const currentItemBlocksNavigation = computed(
    () =>
      currentItemValidationMessageCount.value > 0 || currentItemHasUnansweredRequiredResponse.value,
  );
  const latestSubmittedAttempt = computed(() => {
    if (!assessmentHistory.value) {
      return null;
    }

    const preferredAttemptId =
      historyFocusAttemptId.value ?? bootstrappedSession.value?.payload.attemptId ?? null;

    if (preferredAttemptId) {
      const matchingAttempt =
        assessmentHistory.value.attempts.find(
          (attempt) => attempt.attemptId === preferredAttemptId,
        ) ?? null;
      if (matchingAttempt) {
        return matchingAttempt;
      }
    }

    return assessmentHistory.value.attempts[0] ?? null;
  });
  const latestSubmittedScoreLabel = computed(() => {
    if (!latestSubmittedAttempt.value) {
      return "Processing";
    }

    if (
      latestSubmittedAttempt.value.resultStatus === "pending" ||
      latestSubmittedAttempt.value.finalization?.status === "pending"
    ) {
      return "Awaiting review";
    }

    if (
      latestSubmittedAttempt.value.resultStatus === "failed" ||
      latestSubmittedAttempt.value.finalization?.status === "failed"
    ) {
      return "Unavailable";
    }

    if (
      latestSubmittedAttempt.value.maxScore !== null &&
      latestSubmittedAttempt.value.maxScore > 0 &&
      latestSubmittedAttempt.value.totalScore !== null
    ) {
      return `${latestSubmittedAttempt.value.totalScore} / ${latestSubmittedAttempt.value.maxScore}`;
    }

    if (latestSubmittedAttempt.value.totalScore !== null) {
      return `${latestSubmittedAttempt.value.totalScore}`;
    }

    return "Submitted";
  });
  const latestSubmittedOutcomeMessage = computed(() => {
    if (!latestSubmittedAttempt.value) {
      return "Your submission was received.";
    }

    if (
      latestSubmittedAttempt.value.resultStatus === "pending" ||
      latestSubmittedAttempt.value.finalization?.status === "pending"
    ) {
      return "Your submission was received. Some responses require instructor review before a final score is available.";
    }

    if (
      latestSubmittedAttempt.value.resultStatus === "failed" ||
      latestSubmittedAttempt.value.finalization?.status === "failed"
    ) {
      return "Your submission was received. Scoring is taking longer than expected.";
    }

    if (
      latestSubmittedAttempt.value.maxScore !== null &&
      latestSubmittedAttempt.value.maxScore > 0 &&
      latestSubmittedAttempt.value.totalScore !== null
    ) {
      return `Your submission was received. Score ${latestSubmittedAttempt.value.totalScore} / ${latestSubmittedAttempt.value.maxScore}.`;
    }

    return "Your submission was received.";
  });
  const deliveryStateLabel = computed(() => deliveryState.value.replaceAll("_", " "));
  const projectedDeliveryTiming = computed(() =>
    projectTimingForDisplay(
      deliveryTiming.value,
      timingClockTickMs.value,
      deliveryTimingObservedAtMs.value,
    ),
  );
  const remainingTimeLabel = computed(() =>
    projectedDeliveryTiming.value.remainingTimeSeconds === null
      ? "unbounded"
      : `${projectedDeliveryTiming.value.remainingTimeSeconds}s`,
  );
  const policyOverlayStatusLabel = computed(() => {
    if (policyState.value.overlayRevision === 0) {
      return "Overlay revision 0. No active policy overrides.";
    }

    const parts = [`Overlay revision ${policyState.value.overlayRevision}`];
    parts.push(policyState.value.reopen.status);
    if (policyState.value.timing.additionalTimeSeconds > 0) {
      parts.push(`${policyState.value.timing.additionalTimeSeconds}s added`);
    }

    return parts.join(" · ");
  });
  const deliveryContextStatusLabel = computed(() => {
    if (!deliveryContextState.value) {
      return "No delivery context has been evaluated yet.";
    }

    const parts: string[] = [deliveryContextState.value.mode];
    if (deliveryContextState.value.mode === "iframe") {
      parts.push(deliveryContextState.value.embedOrigin ?? "origin unavailable");
    }

    if (deliveryContextState.value.secureBrowserRequired) {
      parts.push(
        deliveryContextState.value.secureBrowserVerified
          ? "secure browser verified"
          : deliveryContextState.value.secureBrowserPresent
            ? "secure browser detected"
            : "secure browser missing",
      );
    } else {
      parts.push(
        deliveryContextState.value.secureBrowserVerified
          ? "secure browser verified"
          : deliveryContextState.value.secureBrowserPresent
            ? "secure browser detected"
            : "secure browser optional",
      );
    }

    if (!deliveryContextState.value.allowed && deliveryContextState.value.blockedReason) {
      parts.push(deliveryContextState.value.blockedReason.replaceAll("_", " "));
    }

    return parts.join(" · ");
  });
  const deliveryContextSupportLabel = computed(() => {
    if (!deliveryContextState.value) {
      return "";
    }

    if (!deliveryContextState.value.allowed) {
      return "QFlowLearn Delivery blocked this context before manifest delivery and renderer hydration began.";
    }

    return deliveryContextState.value.mode === "iframe"
      ? "Embedded delivery stays server-checked while policy overlays and renderer accommodations remain visible in the shell."
      : "Standalone delivery stays server-checked while the same policy and accommodation state remains visible in the shell.";
  });
  const deliveryContextBlockedMessage = computed(() => {
    if (!deliveryContextState.value || deliveryContextState.value.allowed) {
      return "";
    }

    if (errorMessage.value) {
      return errorMessage.value;
    }

    switch (deliveryContextState.value.blockedReason) {
      case "standalone_disallowed":
        return "This assessment must be launched from an approved embedded context.";
      case "iframe_disallowed":
        return "This assessment must not be launched inside an embedded context.";
      case "embed_origin_not_allowed":
        return "The current embedding origin is not approved for this published version.";
      case "secure_browser_required":
        return deliveryContextState.value.secureBrowserProviderHint
          ? `This published version requires ${deliveryContextState.value.secureBrowserProviderHint}.`
          : "This published version requires a secure browser.";
      default:
        return "The current delivery context is not allowed for this published version.";
    }
  });
  const attemptEditingLocked = computed(
    () =>
      sessionIsStale.value ||
      finishCaptureInProgress.value ||
      submissionState.value.status !== "none" ||
      deliveryState.value === "submitted" ||
      deliveryState.value === "expired_pending_recovery",
  );
  const submitStatusLabel = computed(() => {
    if (submissionState.value.status === "review_required")
      return "Final work retained for invigilator review. Server acceptance is unresolved.";
    if (submissionState.value.status === "pending")
      return "Finish saved on this workstation. Answers are locked; awaiting server confirmation.";
    if (submissionState.value.status === "confirmed")
      return "Your assessment has been durably submitted.";
    if (deliveryState.value === "submitted") {
      return "Your assessment has been durably submitted.";
    }

    if (deliveryState.value === "expired_pending_recovery") {
      return "Responses are closed until recovery or instructor action.";
    }

    if (deliveryState.value === "accepting_late_within_grace") {
      return "Your work is still being saved during the grace period.";
    }

    return "Responses are saved automatically as you move through the assessment.";
  });

  return {
    bootstrappedSession,
    runtimeManifest,
    currentItemPayload,
    authoritativeCurrentItemRef,
    itemLifecycleState,
    rendererRestoreState,
    capturedItemStates,
    attemptClient,
    itemReady,
    loading,
    deliveryBusy,
    errorMessage,
    responseEditRevision,
    responseSaveStatus,
    lastConfirmedSaveAt,
    replayStatus,
    pendingReplayCount,
    highestCommittedSequence,
    nextSequenceNumber,
    currentClientSessionId,
    sessionIsStale,
    submissionState,
    finishCaptureInProgress,
    deliveryState,
    deliveryTiming,
    deliveryTimingObservedAtMs,
    timingClockTickMs,
    policyState,
    deliveryContextState,
    assessmentHistory,
    historyLoading,
    historyErrorMessage,
    historyFocusAttemptId,
    policyRefreshStatus,
    itemPresentationEvidenceKeys,
    get historyRefreshTimer() {
      return historyRefreshTimer;
    },
    set historyRefreshTimer(value) {
      historyRefreshTimer = value;
    },
    get recoveryHeartbeatTimer() {
      return recoveryHeartbeatTimer;
    },
    set recoveryHeartbeatTimer(value) {
      recoveryHeartbeatTimer = value;
    },
    get timingClockTimer() {
      return timingClockTimer;
    },
    set timingClockTimer(value) {
      timingClockTimer = value;
    },
    get deadlineAutomationInFlight() {
      return deadlineAutomationInFlight;
    },
    set deadlineAutomationInFlight(value) {
      deadlineAutomationInFlight = value;
    },
    warnedDeadlineKeys,
    autoSubmittedDeadlineKeys,
    recoveryCache,
    entryMode,
    sessionTitle,
    launchActorLabel,
    currentItemId,
    currentItemTitle,
    manifestItemCount,
    currentItemIndex,
    currentItemPositionLabel,
    hasPreviousItem,
    hasNextItem,
    canNavigateBackward,
    canNavigateForward,
    currentAssetCount,
    currentItemValidationMessageCount,
    currentItemHasUnansweredRequiredResponse,
    currentItemBlocksNavigation,
    latestSubmittedAttempt,
    latestSubmittedScoreLabel,
    latestSubmittedOutcomeMessage,
    deliveryStateLabel,
    projectedDeliveryTiming,
    remainingTimeLabel,
    policyOverlayStatusLabel,
    deliveryContextStatusLabel,
    deliveryContextSupportLabel,
    deliveryContextBlockedMessage,
    attemptEditingLocked,
    submitStatusLabel,
  };
}

export type DeliverySessionState = ReturnType<typeof createDeliverySessionState>;
