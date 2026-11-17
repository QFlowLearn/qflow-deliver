import { recoverResponseStates } from "./response-recovery";
import { isSubmissionEvent, recoverSubmissionState } from "../submission-state";
import type {
  AttemptPolicyReadResponse,
  AttemptPolicyState,
  AuthoritativeAttemptSessionState,
} from "@harbor/attempt-protocol";
import { createEmptyAttemptPolicyState } from "@harbor/attempt-protocol";

import {
  createAttemptClient,
  createFetchAttemptTransport,
  type AttemptClientState,
} from "../attempt-client";
import type { BootstrappedSession } from "../bootstrap-client";
import {
  loadAssessmentHistory,
  loadAttemptPolicy,
  loadRuntimeShellContent,
  RuntimeSessionError,
} from "../runtime-session";
import {
  ATTEMPT_RECOVERY_RETENTION_MS,
  type DeliverySessionContext,
} from "./delivery-session-context";
import { attemptJournal, attemptReplayReceiptStore } from "./delivery-stores";
import { requireRendererLifecycle, runDeliveryBusyMutation } from "./delivery-mutation";
import { formatError } from "./formatting";

export function createDeliverySessionBootstrapActions(ctx: DeliverySessionContext) {
  const { input, state, actions } = ctx;

  async function openAttemptHistory(attemptId: string): Promise<void> {
    await refreshAssessmentHistory(attemptId);
  }

  async function runLaunch(action: () => Promise<void>): Promise<void> {
    state.loading.value = true;
    state.errorMessage.value = "";
    state.deliveryContextState.value = null;
    actions.clearHistoryRefreshTimer();

    try {
      await action();
    } catch (error) {
      maybeProjectDeliveryContextError(error);
      state.errorMessage.value = formatError(error);
    } finally {
      state.loading.value = false;
    }
  }

  async function applyBootstrappedSession(session: BootstrappedSession): Promise<void> {
    actions.clearHistoryRefreshTimer();
    state.bootstrappedSession.value = session;
    state.lastConfirmedSaveAt.value =
      session.payload.session.responseCheckpoint?.serverTimestamp ?? null;
    state.responseSaveStatus.value = state.lastConfirmedSaveAt.value
      ? `Server confirmed at ${new Date(state.lastConfirmedSaveAt.value).toLocaleTimeString()}`
      : "No response changes yet";
    state.historyFocusAttemptId.value = session.payload.attemptId;
    state.policyState.value = normalizePolicyState(session.payload.policy);
    state.deliveryContextState.value = session.payload.deliveryContext ?? null;
    state.runtimeManifest.value = null;
    state.currentItemPayload.value = null;
    state.authoritativeCurrentItemRef.value = session.payload.session.currentItemRef;
    const pending = await attemptJournal.list(session.payload.attemptId);
    const receipts = await attemptReplayReceiptStore.list(session.payload.attemptId);
    state.submissionState.value = recoverSubmissionState(
      pending,
      receipts,
      state.policyState.value.reopen.reopenedAt,
    );
    state.responseEditRevision.value = pending.reduce((revision, { event }) => {
      return "clientEditRevision" in event.payload &&
        typeof event.payload.clientEditRevision === "number"
        ? Math.max(revision, event.payload.clientEditRevision)
        : revision;
    }, 0);
    if (pending.some(({ event }) => event.type === "response.changed"))
      state.responseSaveStatus.value = "Saved locally; server confirmation pending";
    const recovery = recoverResponseStates({
      checkpoint: session.payload.session.responseCheckpoint,
      localStates: await state.recoveryCache.readCachedItemStates(session.payload.attemptId),
      pending,
      clientSessionId:
        state.currentClientSessionId.value || state.recoveryCache.readOrCreateClientSessionId(),
    });
    state.capturedItemStates.value = recovery.states;
    state.itemLifecycleState.value = null;
    state.rendererRestoreState.value = null;
    state.itemReady.value = false;
    state.itemPresentationEvidenceKeys.clear();
    // A reload must not create another presentation behind a pending answer.
    // Restore both confirmed and still-journaled evidence using its original key.
    for (const event of [
      ...receipts.filter(({ outcome }) => outcome === "accepted" || outcome === "duplicate"),
      ...pending.map(({ event }) => ({
        eventType: event.type,
        idempotencyKey: event.idempotencyKey,
      })),
    ]) {
      if (
        event.eventType === "item.presented" &&
        event.idempotencyKey.startsWith("item-presented:")
      )
        state.itemPresentationEvidenceKeys.add(
          event.idempotencyKey.slice("item-presented:".length),
        );
    }
    requireRendererLifecycle(input.rendererLifecycle).resetCaptureState();
    state.sessionIsStale.value = recovery.conflicts.length > 0;
    if (recovery.conflicts.length)
      state.errorMessage.value =
        "This workstation has a conflicting local draft. Ask an invigilator to reconcile it before continuing. The original local copy has been retained.";
    if (recovery.conflicts.length) {
      state.attemptClient.value = null;
      return;
    }
    state.assessmentHistory.value = null;
    state.historyErrorMessage.value = "";
    state.policyRefreshStatus.value =
      state.policyState.value.overlayRevision === 0
        ? "Pinned policy defaults remain active until an operator overlay is applied."
        : "Bootstrap hydrated the current authoritative policy overlay state.";
    state.recoveryCache.writeCachedBootstrappedSession(session);
    state.currentClientSessionId.value =
      state.currentClientSessionId.value || state.recoveryCache.readOrCreateClientSessionId();
    state.recoveryCache.writeRecoverySession(session, null);
    actions.startRecoveryHeartbeat();
    state.attemptClient.value = createAttemptClient({
      attemptId: session.payload.attemptId,
      clientSessionId: state.currentClientSessionId.value,
      initialSession: actions.toAuthoritativeSessionState(session),
      journal: attemptJournal,
      receiptStore: attemptReplayReceiptStore,
      transport: createFetchAttemptTransport(),
      receiptRetentionMs: ATTEMPT_RECOVERY_RETENTION_MS,
      onEventsJournaled(events) {
        if (events.some((event) => isSubmissionEvent(event.type)))
          state.submissionState.value = { status: "pending" };
      },
    });

    await actions.purgeExpiredRecoveryRecords();
    await actions.syncRecoveryState();

    await actions.replayPendingWork("bootstrap");
    if (state.bootstrappedSession.value?.payload.attemptId !== session.payload.attemptId) return;
    void refreshAssessmentHistory(session.payload.attemptId);
    void input.refreshStudentAssignments();
  }

  async function ensureRuntimeContentLoaded(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const attemptId = state.bootstrappedSession.value?.payload.attemptId;
    if (!attemptId || (state.runtimeManifest.value && state.currentItemPayload.value)) return;
    const shellContent = await loadRuntimeShellContent({ attemptId }, options);
    options.signal?.throwIfAborted();
    if (state.bootstrappedSession.value?.payload.attemptId !== attemptId) return;

    state.runtimeManifest.value = shellContent.manifest;
    // Recovery may start from an older bootstrap. Restore only the question
    // that the server actually returned, never the cached bootstrap's question.
    const restoredCurrentItemState =
      state.capturedItemStates.value[shellContent.currentItem.item.id] ?? null;
    state.itemLifecycleState.value = restoredCurrentItemState;
    state.rendererRestoreState.value = restoredCurrentItemState;
    state.currentItemPayload.value = shellContent.currentItem;
  }

  async function refreshAssessmentHistory(
    attemptId?: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const scopedAttemptId =
      attemptId ??
      state.historyFocusAttemptId.value ??
      state.bootstrappedSession.value?.payload.attemptId ??
      null;

    actions.clearHistoryRefreshTimer();

    if (!scopedAttemptId) {
      state.assessmentHistory.value = null;
      state.historyErrorMessage.value = "";
      return;
    }

    state.historyLoading.value = true;
    state.historyErrorMessage.value = "";
    state.historyFocusAttemptId.value = scopedAttemptId;

    try {
      const history = await loadAssessmentHistory(
        {
          attemptId: scopedAttemptId,
        },
        options,
      );
      options.signal?.throwIfAborted();
      state.assessmentHistory.value = history;
      actions.scheduleHistoryRefreshIfPending(scopedAttemptId);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      state.historyErrorMessage.value = formatError(error);
    } finally {
      state.historyLoading.value = false;
    }
  }

  async function refreshAttemptPolicy(): Promise<void> {
    if (!state.bootstrappedSession.value) {
      return;
    }

    await runDeliveryBusyMutation(
      {
        rendererLifecycle: input.rendererLifecycle,
        handleCommitResponse: actions.handleCommitResponse,
        syncRecoveryState: actions.syncRecoveryState,
        maybeProjectDeliveryContextError,
        buildReceiptStatusMessage: actions.buildReceiptStatusMessage,
        formatError,
        sessionIsStale: state.sessionIsStale,
        pendingReplayCount: state.pendingReplayCount,
      },
      {
        deliveryBusy: state.deliveryBusy,
        errorMessage: state.errorMessage,
        replayStatus: state.replayStatus,
      },
      {
        run: async () => {
          const policy = await loadAttemptPolicy({
            attemptId: state.bootstrappedSession.value!.payload.attemptId,
          });
          await applyPolicyProjection(
            policy,
            "Authoritative policy refresh applied to the current shell state.",
          );
        },
      },
    );
  }

  function maybeProjectDeliveryContextError(error: unknown): void {
    if (error instanceof RuntimeSessionError && error.deliveryContext) {
      state.deliveryContextState.value = error.deliveryContext;
    }
  }

  function persistAuthoritativeSessionState(clientState: AttemptClientState): void {
    if (!state.bootstrappedSession.value) {
      return;
    }

    const updatedSession: BootstrappedSession = {
      ...state.bootstrappedSession.value,
      payload: {
        ...state.bootstrappedSession.value.payload,
        policy: state.policyState.value,
        session: {
          ...state.bootstrappedSession.value.payload.session,
          currentItemRef: clientState.currentItemRef,
          sequence: {
            lastAcceptedSequence:
              clientState.highestCommittedSequence === 0
                ? null
                : clientState.highestCommittedSequence,
            nextSequence: clientState.nextSequenceNumber,
          },
          timing: clientState.timing,
          attemptStatus: clientState.attemptStatus,
          deliveryPreferences: clientState.deliveryPreferences,
        },
      },
    };

    state.bootstrappedSession.value = updatedSession;
    state.recoveryCache.writeCachedBootstrappedSession(updatedSession);
  }

  function toAuthoritativeSessionState(
    session: BootstrappedSession,
  ): AuthoritativeAttemptSessionState {
    return {
      currentItemRef: session.payload.session.currentItemRef,
      sequence: session.payload.session.sequence ?? {
        lastAcceptedSequence: null,
        nextSequence: 1,
      },
      timing: session.payload.session.timing ?? {
        startedAt: null,
        expiresAt: null,
        softCloseAt: null,
        acceptUntil: null,
        remainingTimeSeconds: null,
      },
      attemptStatus: session.payload.session.attemptStatus ?? "active",
      deliveryPreferences: session.payload.session.deliveryPreferences ?? {
        keywordTranslationLanguage: null,
      },
    };
  }

  async function applyPolicyProjection(
    projection: Omit<AttemptPolicyReadResponse, "policy"> & {
      policy?: AttemptPolicyState;
    },
    statusMessage: string,
  ): Promise<void> {
    state.policyState.value = normalizePolicyState(projection.policy);
    state.policyRefreshStatus.value = statusMessage;
    state.deliveryState.value = projection.attemptStatus;
    setAuthoritativeDeliveryTiming(projection.timing);

    if (state.attemptClient.value) {
      const clientState = state.attemptClient.value.getState();
      await state.attemptClient.value.applyAuthoritativeSession({
        currentItemRef: clientState.currentItemRef,
        sequence: {
          lastAcceptedSequence:
            clientState.highestCommittedSequence === 0
              ? null
              : clientState.highestCommittedSequence,
          nextSequence: clientState.nextSequenceNumber,
        },
        timing: projection.timing,
        attemptStatus: projection.attemptStatus,
        deliveryPreferences: clientState.deliveryPreferences,
      });
      persistAuthoritativeSessionState(state.attemptClient.value.getState());
      await actions.syncRecoveryState();
      return;
    }

    if (state.bootstrappedSession.value) {
      persistAuthoritativeSessionState({
        currentItemRef:
          state.authoritativeCurrentItemRef.value ??
          state.bootstrappedSession.value.payload.session.currentItemRef,
        highestCommittedSequence:
          state.bootstrappedSession.value.payload.session.sequence?.lastAcceptedSequence ?? 0,
        nextSequenceNumber:
          state.bootstrappedSession.value.payload.session.sequence?.nextSequence ?? 1,
        attemptStatus: projection.attemptStatus,
        timing: projection.timing,
        deliveryPreferences: state.bootstrappedSession.value.payload.session
          .deliveryPreferences ?? {
          keywordTranslationLanguage: null,
        },
      });
    }
  }

  function setAuthoritativeDeliveryTiming(
    timing: AuthoritativeAttemptSessionState["timing"],
  ): void {
    state.deliveryTiming.value = timing;
    state.deliveryTimingObservedAtMs.value = Date.now();
    state.timingClockTickMs.value = state.deliveryTimingObservedAtMs.value;
  }

  function normalizePolicyState(policy: AttemptPolicyState | undefined): AttemptPolicyState {
    return policy
      ? {
          ...createEmptyAttemptPolicyState(),
          ...policy,
          timing: {
            ...createEmptyAttemptPolicyState().timing,
            ...policy.timing,
          },
          reopen: {
            ...createEmptyAttemptPolicyState().reopen,
            ...policy.reopen,
          },
          operatorMessage: policy.operatorMessage
            ? {
                ...policy.operatorMessage,
              }
            : null,
          accommodations: {
            rendererPnp: {
              ...(policy.accommodations?.rendererPnp ?? {}),
            },
            sessionControl: {
              ...(policy.accommodations?.sessionControl ?? {}),
              ...(policy.accommodations?.sessionControl?.time_limits
                ? {
                    time_limits: {
                      ...policy.accommodations.sessionControl.time_limits,
                    },
                  }
                : {}),
            },
            shellTools: {
              ...(policy.accommodations?.shellTools ?? {}),
            },
            ...(policy.accommodations?.pnpEntitlement
              ? {
                  pnpEntitlement: {
                    ...(policy.accommodations.pnpEntitlement.supports
                      ? {
                          supports: [...policy.accommodations.pnpEntitlement.supports],
                        }
                      : {}),
                    ...(policy.accommodations.pnpEntitlement.activateAtInitializationSet
                      ? {
                          activateAtInitializationSet: [
                            ...policy.accommodations.pnpEntitlement.activateAtInitializationSet,
                          ],
                        }
                      : {}),
                    ...(policy.accommodations.pnpEntitlement.activateAsOptionSet
                      ? {
                          activateAsOptionSet: [
                            ...policy.accommodations.pnpEntitlement.activateAsOptionSet,
                          ],
                        }
                      : {}),
                    ...(policy.accommodations.pnpEntitlement.prohibitSet
                      ? {
                          prohibitSet: [...policy.accommodations.pnpEntitlement.prohibitSet],
                        }
                      : {}),
                    ...(policy.accommodations.pnpEntitlement.languages
                      ? {
                          languages: [...policy.accommodations.pnpEntitlement.languages],
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : createEmptyAttemptPolicyState();
  }

  return {
    openAttemptHistory,
    runLaunch,
    applyBootstrappedSession,
    ensureRuntimeContentLoaded,
    refreshAssessmentHistory,
    refreshAttemptPolicy,
    maybeProjectDeliveryContextError,
    persistAuthoritativeSessionState,
    toAuthoritativeSessionState,
    applyPolicyProjection,
  };
}
