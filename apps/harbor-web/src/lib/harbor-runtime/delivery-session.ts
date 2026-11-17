import { createDeliverySessionBootstrapActions } from "./delivery-session-bootstrap";
import {
  type DeliverySessionActions,
  type DeliverySessionContext,
  type DeliverySessionInput,
  type DeliverySessionLifecycle,
} from "./delivery-session-context";
import { createDeliverySessionNavigationActions } from "./delivery-session-navigation";
import { createDeliverySessionRecoveryActions } from "./delivery-session-recovery";
import { createDeliverySessionState } from "./delivery-session-state";

export type { DeliverySessionLifecycle } from "./delivery-session-context";

function composeDeliverySessionActions(
  bootstrap: ReturnType<typeof createDeliverySessionBootstrapActions>,
  recovery: ReturnType<typeof createDeliverySessionRecoveryActions>,
  navigation: ReturnType<typeof createDeliverySessionNavigationActions>,
): DeliverySessionActions {
  return {
    applyBootstrappedSession: bootstrap.applyBootstrappedSession,
    applyPolicyProjection: bootstrap.applyPolicyProjection,
    buildReceiptStatusMessage: recovery.buildReceiptStatusMessage,
    clearHistoryRefreshTimer: recovery.clearHistoryRefreshTimer,
    handleCommitResponse: navigation.handleCommitResponse,
    ensureRuntimeContentLoaded: bootstrap.ensureRuntimeContentLoaded,
    maybeHandleDeadlineAutomation: navigation.maybeHandleDeadlineAutomation,
    maybeProjectDeliveryContextError: bootstrap.maybeProjectDeliveryContextError,
    persistAuthoritativeSessionState: bootstrap.persistAuthoritativeSessionState,
    purgeExpiredRecoveryRecords: recovery.purgeExpiredRecoveryRecords,
    recordCurrentItemPresented: navigation.recordCurrentItemPresented,
    refreshAssessmentHistory: bootstrap.refreshAssessmentHistory,
    replayPendingWork: recovery.replayPendingWork,
    scheduleHistoryRefreshIfPending: recovery.scheduleHistoryRefreshIfPending,
    startRecoveryHeartbeat: recovery.startRecoveryHeartbeat,
    syncRecoveryState: recovery.syncRecoveryState,
    toAuthoritativeSessionState: bootstrap.toAuthoritativeSessionState,
  };
}

export function createDeliverySessionRuntime(input: DeliverySessionInput) {
  const state = createDeliverySessionState({
    getLocationHref: () => window.location.href,
  });

  let actions: DeliverySessionActions;
  const actionProxy = new Proxy({} as DeliverySessionActions, {
    get(_target, property: keyof DeliverySessionActions) {
      const value = actions?.[property];
      if (typeof value !== "function") {
        throw new Error(`Delivery session action ${String(property)} is not initialized.`);
      }
      return value;
    },
  });
  const ctx: DeliverySessionContext = {
    input,
    state,
    get actions(): DeliverySessionActions {
      return actionProxy;
    },
  };

  const bootstrapActions = createDeliverySessionBootstrapActions(ctx);
  const recoveryActions = createDeliverySessionRecoveryActions(ctx);
  const navigationActions = createDeliverySessionNavigationActions(ctx);
  actions = composeDeliverySessionActions(bootstrapActions, recoveryActions, navigationActions);
  const {
    autoSubmittedDeadlineKeys: _autoSubmittedDeadlineKeys,
    currentItemHasUnansweredRequiredResponse: _currentItemHasUnansweredRequiredResponse,
    currentItemIndex: _currentItemIndex,
    deadlineAutomationInFlight: _deadlineAutomationInFlight,
    deliveryTiming: _deliveryTiming,
    deliveryTimingObservedAtMs: _deliveryTimingObservedAtMs,
    hasNextItem: _hasNextItem,
    hasPreviousItem: _hasPreviousItem,
    historyRefreshTimer: _historyRefreshTimer,
    itemPresentationEvidenceKeys: _itemPresentationEvidenceKeys,
    recoveryCache: _recoveryCache,
    recoveryHeartbeatTimer: _recoveryHeartbeatTimer,
    timingClockTimer: _timingClockTimer,
    timingClockTickMs: _timingClockTickMs,
    warnedDeadlineKeys: _warnedDeadlineKeys,
    ...publicState
  } = state;

  const session = {
    ...publicState,
    applyBootstrappedSession: bootstrapActions.applyBootstrappedSession,
    applyPolicyProjection: bootstrapActions.applyPolicyProjection,
    navigateItem: navigationActions.navigateItem,
    navigateToItem: navigationActions.navigateToItem,
    openAttemptHistory: bootstrapActions.openAttemptHistory,
    persistAuthoritativeSessionState: bootstrapActions.persistAuthoritativeSessionState,
    markResponseDirty: navigationActions.markResponseDirty,
    autosaveResponse: navigationActions.autosaveResponse,
    queueDraftResponse: navigationActions.queueDraftResponse,
    refreshAssessmentHistory: bootstrapActions.refreshAssessmentHistory,
    refreshAttemptPolicy: bootstrapActions.refreshAttemptPolicy,
    retryPendingWork: recoveryActions.retryPendingWork,
    runLaunch: bootstrapActions.runLaunch,
    submitAttempt: navigationActions.submitAttempt,
  };

  const lifecycle: DeliverySessionLifecycle = {
    recoveryCache: state.recoveryCache,
    handleBrowserOnline: recoveryActions.handleBrowserOnline,
    handleVisibilityChange: recoveryActions.handleVisibilityChange,
    handlePageHide: recoveryActions.handlePageHide,
    handlePageFreeze: recoveryActions.handlePageFreeze,
    startTimingClock: recoveryActions.startTimingClock,
    stopTimingClock: recoveryActions.stopTimingClock,
    stopRecoveryHeartbeat: recoveryActions.stopRecoveryHeartbeat,
    clearHistoryRefreshTimer: recoveryActions.clearHistoryRefreshTimer,
    maybeProjectDeliveryContextError: bootstrapActions.maybeProjectDeliveryContextError,
  };

  return [session, lifecycle] as const;
}

export type DeliverySessionRuntime = ReturnType<typeof createDeliverySessionRuntime>[0];
