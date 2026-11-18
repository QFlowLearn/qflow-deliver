import { reportUiError } from "../ui-errors";
import type { AuthoritativeAttemptSessionState } from "@harbor/attempt-protocol";
import type { AttemptClient } from "../attempt-client";
import { createEmptyAttemptPolicyState } from "@harbor/attempt-protocol";

import { ATTEMPT_RECOVERY_SCHEMA_VERSION, type AttemptJournalEntry } from "../attempt-journal";
import {
  ATTEMPT_RECOVERY_RETENTION_MS,
  RECOVERY_HEARTBEAT_INTERVAL_MS,
  TIMING_CLOCK_INTERVAL_MS,
  type DeliverySessionContext,
} from "./delivery-session-context";
import {
  attemptItemStateStore,
  attemptJournal,
  attemptRecoveryMetadataStore,
  attemptReplayReceiptStore,
} from "./delivery-stores";
import { requireRendererLifecycle } from "./delivery-mutation";
import { formatError } from "./formatting";
import { createHistoryRefreshScheduler } from "./history-refresh";
import { recoverSubmissionState } from "../submission-state";

export function createDeliverySessionRecoveryActions(ctx: DeliverySessionContext) {
  const { input, state, actions } = ctx;
  type RecoveryRequest = {
    readonly client: AttemptClient;
    readonly attemptId: string;
    readonly reason: string;
    readonly controller: AbortController;
  };
  let requestedRecovery: RecoveryRequest | null = null;
  let recoveryInFlight: Promise<void> | null = null;

  async function syncRecoveryState(): Promise<void> {
    if (!state.attemptClient.value || !state.bootstrappedSession.value) {
      state.pendingReplayCount.value = 0;
      state.highestCommittedSequence.value = 0;
      state.nextSequenceNumber.value = 1;
      state.deliveryState.value = "active";
      setAuthoritativeDeliveryTiming({
        startedAt: null,
        expiresAt: null,
        softCloseAt: null,
        acceptUntil: null,
        remainingTimeSeconds: null,
      });
      state.policyState.value = createEmptyAttemptPolicyState();
      state.deliveryContextState.value = null;
      state.capturedItemStates.value = {};
      state.rendererRestoreState.value = null;
      state.assessmentHistory.value = null;
      state.historyErrorMessage.value = "";
      state.historyFocusAttemptId.value = null;
      input.clearStudentSessionState();
      state.policyRefreshStatus.value =
        "Pinned policy defaults remain active until an operator overlay is applied.";
      return;
    }

    const clientState = state.attemptClient.value.getState();
    state.authoritativeCurrentItemRef.value = clientState.currentItemRef;
    state.highestCommittedSequence.value = clientState.highestCommittedSequence;
    state.nextSequenceNumber.value = clientState.nextSequenceNumber;
    state.deliveryState.value = clientState.attemptStatus;
    setAuthoritativeDeliveryTiming(clientState.timing);
    actions.persistAuthoritativeSessionState(clientState);
    const attemptId = state.bootstrappedSession.value.payload.attemptId;
    const pending = await attemptJournal.list(attemptId);
    state.pendingReplayCount.value = pending.length;
    state.submissionState.value = recoverSubmissionState(
      pending,
      await attemptReplayReceiptStore.list(attemptId),
      state.policyState.value.reopen.reopenedAt,
    );
    await writeAttemptRecoveryMetadata();
    await purgeSubmittedItemSnapshots();
  }

  function setAuthoritativeDeliveryTiming(
    timing: AuthoritativeAttemptSessionState["timing"],
  ): void {
    state.deliveryTiming.value = timing;
    state.deliveryTimingObservedAtMs.value = Date.now();
    state.timingClockTickMs.value = state.deliveryTimingObservedAtMs.value;
  }

  function buildReceiptStatusMessage(): string {
    if (state.sessionIsStale.value) {
      return state.replayStatus.value;
    }

    if (state.submissionState.value.status !== "none") return state.submitStatusLabel.value;

    if (state.deliveryState.value === "expired_pending_recovery") {
      return "The acceptance window has ended. Keep this tab open while recovery or instructor action is pending.";
    }

    if (state.deliveryState.value === "submitted") {
      return "Your assessment has been durably submitted.";
    }

    if (state.deliveryState.value === "accepting_late_within_grace") {
      return "Your work is still being saved during the grace period.";
    }

    if (state.pendingReplayCount.value > 0) {
      return `${state.pendingReplayCount.value} saved update(s) will sync when the connection is available.`;
    }

    if (state.highestCommittedSequence.value === 0) {
      return "Responses are saved automatically as you move through the assessment.";
    }

    return `Durable receipts now cover sequence ${state.highestCommittedSequence.value}.`;
  }

  async function writeAttemptRecoveryMetadata(): Promise<void> {
    if (!state.bootstrappedSession.value) {
      return;
    }

    const now = new Date().toISOString();
    const purgeAfter =
      state.pendingReplayCount.value === 0 && state.deliveryState.value === "submitted"
        ? new Date(Date.parse(now) + ATTEMPT_RECOVERY_RETENTION_MS).toISOString()
        : null;
    await attemptRecoveryMetadataStore.write({
      attemptId: state.bootstrappedSession.value.payload.attemptId,
      schemaVersion: ATTEMPT_RECOVERY_SCHEMA_VERSION,
      pendingEventCount: state.pendingReplayCount.value,
      highestCommittedSequence: state.highestCommittedSequence.value,
      lastQueueMutationAt: now,
      purgeAfter,
    });
  }

  async function purgeSubmittedItemSnapshots(): Promise<void> {
    if (
      !state.bootstrappedSession.value ||
      state.submissionState.value.status === "review_required" ||
      state.deliveryState.value !== "submitted" ||
      state.pendingReplayCount.value > 0 ||
      Object.keys(state.capturedItemStates.value).length === 0
    ) {
      return;
    }

    state.capturedItemStates.value = {};
    state.rendererRestoreState.value = null;
    state.itemLifecycleState.value = null;
    await attemptItemStateStore.write(state.bootstrappedSession.value.payload.attemptId, {});
  }

  async function purgeExpiredRecoveryRecords(): Promise<void> {
    const now = new Date().toISOString();
    await Promise.all([
      attemptReplayReceiptStore.purgeExpired(now),
      attemptRecoveryMetadataStore.purgeExpired(now),
    ]);
  }

  function replayPendingWork(reason: string): Promise<void> {
    const client = state.attemptClient.value;
    const attemptId = state.bootstrappedSession.value?.payload.attemptId;
    if (!client || !attemptId) return Promise.resolve();
    if (reason === "bootstrap" && recoveryInFlight && requestedRecovery?.client === client)
      return recoveryInFlight;

    requestedRecovery?.controller.abort();
    requestedRecovery?.client.interruptPendingSend();
    if (reason !== "bootstrap") client.interruptPendingSend();
    requestedRecovery = { client, attemptId, reason, controller: new AbortController() };
    if (recoveryInFlight) return recoveryInFlight;

    // Publish the shared completion before starting work, including an empty queue.
    recoveryInFlight = Promise.resolve().then(runRecoveryRequests);
    return recoveryInFlight;
  }

  async function runRecoveryRequests(): Promise<void> {
    state.deliveryBusy.value = true;
    try {
      let completed: RecoveryRequest | null = null;
      while (requestedRecovery && requestedRecovery !== completed) {
        const request: RecoveryRequest = requestedRecovery;
        await recoverRequestedSession(request);
        completed = request;
      }
    } catch (error: unknown) {
      actions.maybeProjectDeliveryContextError(error);
      state.errorMessage.value = formatError(error);
    } finally {
      requestedRecovery = null;
      recoveryInFlight = null;
      state.deliveryBusy.value = false;
    }
  }

  async function recoverRequestedSession(request: RecoveryRequest): Promise<void> {
    const signal = request.controller.signal;
    const ownsSession = () =>
      state.attemptClient.value === request.client &&
      state.bootstrappedSession.value?.payload.attemptId === request.attemptId;
    let pending: AttemptJournalEntry[] = [];
    try {
      pending = await attemptJournal.list(request.attemptId);
      if (signal.aborted || !ownsSession()) return;
      state.replayStatus.value = `Syncing ${pending.length} saved update(s) after ${request.reason}.`;
      const responses = pending.length > 0 ? await request.client.replayPending() : [];
      if (signal.aborted || !ownsSession()) return;
      const lastResponse = responses.at(-1);
      if (lastResponse) await actions.handleCommitResponse(lastResponse, { signal });
    } catch (error: unknown) {
      if (!signal.aborted && ownsSession()) {
        actions.maybeProjectDeliveryContextError(error);
        state.replayStatus.value = `Saved updates will sync when the connection is available: ${formatError(error)}`;
      }
    } finally {
      if (ownsSession()) {
        await syncRecoveryState();
        await confirmReplayedResponses(pending);
      }
    }
    if (signal.aborted || !ownsSession() || state.sessionIsStale.value) return;

    try {
      // Recovery includes a question that failed to load; an empty journal does
      // not mean a cached session has finished recovering.
      await actions.ensureRuntimeContentLoaded({ signal });
      if (signal.aborted || !ownsSession()) return;
      await actions.recordCurrentItemPresented(
        request.reason === "bootstrap" ? "bootstrap" : "replay",
        { signal },
      );
      await syncRecoveryState();
      if (!signal.aborted && ownsSession() && !state.sessionIsStale.value) {
        state.errorMessage.value = "";
        state.replayStatus.value = buildReceiptStatusMessage();
      }
    } catch (error: unknown) {
      if (!signal.aborted && ownsSession()) {
        actions.maybeProjectDeliveryContextError(error);
        state.errorMessage.value = formatError(error);
        state.replayStatus.value =
          "Your saved work is retained. Retry loading the question when the connection is available.";
      }
    }
  }

  async function confirmReplayedResponses(pending: readonly AttemptJournalEntry[]): Promise<void> {
    const attemptId = state.bootstrappedSession.value?.payload.attemptId;
    if (!attemptId) return;
    const responses = new Map(
      pending
        .filter(({ event }) => event.type === "response.changed")
        .map(({ event }) => [event.eventId, event]),
    );
    // Replay can persist a response receipt and then be interrupted on a later
    // evidence event. Its returned response array is not the durable truth.
    const saved = (await attemptReplayReceiptStore.list(attemptId))
      .filter(
        (receipt) =>
          responses.has(receipt.eventId) &&
          (receipt.outcome === "accepted" || receipt.outcome === "duplicate") &&
          receipt.serverTimestamp !== null,
      )
      .at(-1);
    if (!saved?.serverTimestamp) return;
    const event = responses.get(saved.eventId);
    const revision =
      event && "clientEditRevision" in event.payload ? event.payload.clientEditRevision : null;
    if (!state.lastConfirmedSaveAt.value || saved.serverTimestamp > state.lastConfirmedSaveAt.value)
      state.lastConfirmedSaveAt.value = saved.serverTimestamp;
    if (
      revision === state.responseEditRevision.value &&
      state.responseSaveStatus.value === "Saved locally; server confirmation pending"
    )
      state.responseSaveStatus.value = `Server confirmed at ${new Date(saved.serverTimestamp).toLocaleTimeString()}`;
  }

  async function retryPendingWork(): Promise<void> {
    await replayPendingWork("manual retry");
  }

  function handleBrowserOnline(): void {
    replayPendingWork("connectivity return").catch(reportUiError);
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      requireRendererLifecycle(input.rendererLifecycle)
        .captureLifecycleItemState("visibilitychange")
        .catch(reportUiError);
    }
  }

  function handlePageHide(): void {
    state.recoveryCache.markRecoverySessionClosed();
    requireRendererLifecycle(input.rendererLifecycle)
      .captureLifecycleItemState("pagehide")
      .catch(reportUiError);
  }

  function handlePageFreeze(): void {
    requireRendererLifecycle(input.rendererLifecycle)
      .captureLifecycleItemState("freeze")
      .catch(reportUiError);
  }

  function startTimingClock(): void {
    stopTimingClock();
    state.timingClockTimer = setInterval(() => {
      state.timingClockTickMs.value = Date.now();
      actions.maybeHandleDeadlineAutomation().catch(reportUiError);
    }, TIMING_CLOCK_INTERVAL_MS);
  }

  function stopTimingClock(): void {
    if (state.timingClockTimer) {
      clearInterval(state.timingClockTimer);
      state.timingClockTimer = null;
    }
  }

  function startRecoveryHeartbeat(): void {
    stopRecoveryHeartbeat();
    state.recoveryHeartbeatTimer = setInterval(() => {
      if (state.bootstrappedSession.value) {
        state.recoveryCache.writeRecoverySession(state.bootstrappedSession.value, null);
      }
    }, RECOVERY_HEARTBEAT_INTERVAL_MS);
  }

  function stopRecoveryHeartbeat(): void {
    if (state.recoveryHeartbeatTimer) {
      clearInterval(state.recoveryHeartbeatTimer);
      state.recoveryHeartbeatTimer = null;
    }
  }

  return {
    syncRecoveryState,
    buildReceiptStatusMessage,
    purgeExpiredRecoveryRecords,
    replayPendingWork,
    retryPendingWork,
    handleBrowserOnline,
    handleVisibilityChange,
    handlePageHide,
    handlePageFreeze,
    startTimingClock,
    stopTimingClock,
    startRecoveryHeartbeat,
    stopRecoveryHeartbeat,
    ...createHistoryRefreshScheduler(state, (attemptId) =>
      actions.refreshAssessmentHistory(attemptId),
    ),
  };
}
