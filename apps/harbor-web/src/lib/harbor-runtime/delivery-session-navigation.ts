import type {
  AttemptEventCommitResponse,
  AttemptSubmissionMaterializationInput,
  AttemptSubmissionSummary,
} from "@harbor/attempt-protocol";
import {
  readQtiOutcomeSnapshots,
  readQtiResponseSnapshots,
  readQtiValidationSnapshots,
} from "@harbor/attempt-protocol";

import { buildAttemptSubmissionSummary, readValidationMessageCount } from "../attempt-scoring";
import {
  loadRuntimeItem,
  loadRuntimeManifest,
  resolveRendererSessionControl,
} from "../runtime-session";
import {
  DEADLINE_WARNING_THRESHOLD_SECONDS,
  type DeliverySessionContext,
} from "./delivery-session-context";
import {
  deliveryMutationErrorReplayStatus,
  finishDeliveryMutationSuccess,
  requireRendererLifecycle,
  runDeliveryBusyMutation,
  type DeliveryMutationContext,
} from "./delivery-mutation";
import { formatError } from "./formatting";
import { findActiveDeadlineScope } from "./timing";
import {
  isItemReadyForNavigation,
  shouldBlockNavigationForValidation as shouldBlockNavigationForValidationRequest,
  shouldBlockSubmitForValidation as shouldBlockSubmitForValidationRequest,
} from "./validation";

export function createDeliverySessionNavigationActions(ctx: DeliverySessionContext) {
  const { input, state, actions } = ctx;

  function markResponseDirty(): number {
    state.responseEditRevision.value += 1;
    state.responseSaveStatus.value = "Changes on this workstation";
    return state.responseEditRevision.value;
  }

  async function autosaveResponse(checkpoint: {
    attemptId: string;
    itemId: string;
    itemState: unknown;
    editRevision: number;
  }): Promise<void> {
    const client = state.attemptClient.value;
    if (
      !client ||
      checkpoint.attemptId !== state.bootstrappedSession.value?.payload.attemptId ||
      state.attemptEditingLocked.value
    )
      return;
    const item = state.runtimeManifest.value?.items[checkpoint.itemId];
    if (!item) return;
    const revision = checkpoint.editRevision;
    state.responseSaveStatus.value = "Saving to server";
    try {
      const response = await client.queueAndSend({
        type: "response.changed",
        itemRef: { itemId: checkpoint.itemId, itemHref: item.itemHref },
        payload: {
          intent: "checkpoint",
          clientEditRevision: revision,
          responseKey: checkpoint.itemId,
          responseState: { capturedAt: new Date().toISOString(), itemState: checkpoint.itemState },
        },
      });
      await handleCommitResponse(response);
      recordResponseReceipt(response, revision);
    } catch (error: unknown) {
      actions.maybeProjectDeliveryContextError(error);
      state.responseSaveStatus.value = "Saved locally; server confirmation pending";
    } finally {
      await actions.syncRecoveryState();
    }
  }

  function recordResponseReceipt(response: AttemptEventCommitResponse, revision: number): void {
    if (response.outcome !== "accepted" && response.outcome !== "duplicate") {
      state.responseSaveStatus.value =
        response.outcome === "gap" || response.outcome === "stale_sequence"
          ? "Saved locally; server confirmation pending"
          : "Needs supervised recovery";
      return;
    }
    const timestamp =
      response.outcome === "accepted"
        ? response.serverTimestamp
        : response.storedReceipt.serverTimestamp;
    state.lastConfirmedSaveAt.value = timestamp;
    if (revision === state.responseEditRevision.value)
      state.responseSaveStatus.value = `Server confirmed at ${new Date(timestamp).toLocaleTimeString()}`;
  }

  async function queueDraftResponse(): Promise<void> {
    if (state.attemptEditingLocked.value || state.deliveryBusy.value) return;
    if (!state.attemptClient.value || !state.currentItemId.value) {
      return;
    }

    await runDeliveryBusyMutation(getMutationContext(), getMutationSetters(), {
      initialReplayStatus: "Writing work locally before send.",
      run: async () => {
        const revision = state.responseEditRevision.value;
        const itemState = await requireRendererLifecycle(
          input.rendererLifecycle,
        ).captureCurrentItemState("score", "harborSaveDraft");
        const response = await state.attemptClient.value!.queueAndSend({
          type: "response.changed",
          payload: {
            clientEditRevision: revision,
            responseKey: state.currentItemId.value!,
            responseState: {
              capturedAt: new Date().toISOString(),
              itemState,
            },
          },
        });

        await handleCommitResponse(response);
        recordResponseReceipt(response, revision);
        await actions.syncRecoveryState();
      },
      onSuccess: () => finishDeliveryMutationSuccess(getMutationContext(), getMutationSetters()),
      errorReplayStatus: (error) => deliveryMutationErrorReplayStatus(getMutationContext(), error),
    });
  }

  async function navigateItem(direction: "previous" | "next"): Promise<void> {
    if (state.attemptEditingLocked.value || state.deliveryBusy.value) return;
    if (!state.runtimeManifest.value) {
      return;
    }

    if (state.runtimeManifest.value.testSequence) {
      if (direction === "next") await submitCurrentTestAnswer();
      return;
    }

    const currentIndex = state.currentItemIndex.value;
    if (currentIndex < 0) {
      return;
    }

    const targetIndex = direction === "previous" ? currentIndex - 1 : currentIndex + 1;
    const targetItemId = state.runtimeManifest.value.itemOrder[targetIndex];
    if (!targetItemId) {
      return;
    }

    await navigateToManifestItem(
      targetItemId,
      `Requesting ${direction} item navigation through the durable attempt frontier.`,
      direction === "previous" ? "harborNavigatePrevious" : "harborNavigateNext",
    );
  }

  async function submitCurrentTestAnswer(): Promise<void> {
    const client = state.attemptClient.value;
    const itemId = state.currentItemId.value;
    if (!client || !itemId || state.deliveryBusy.value || state.attemptEditingLocked.value) return;
    await runDeliveryBusyMutation(getMutationContext(), getMutationSetters(), {
      initialReplayStatus: "Saving your answer.",
      run: async () => {
        const itemState = await requireRendererLifecycle(
          input.rendererLifecycle,
        ).captureCurrentItemState("score", "harborSubmitAnswer");
        // Publication guarantees one identifier response. Validate before journaling an immutable submit command.
        if (
          !readQtiResponseSnapshots(itemState).some(
            (response) => typeof response.value === "string" && response.value.length > 0,
          ) ||
          readValidationMessageCount(itemState) > 0
        ) {
          throw new Error("Choose an answer before continuing.");
        }
        const response = await client.queueAndSend({
          type: "item.submit-requested",
          payload: {
            responseKey: itemId,
            responseState: { capturedAt: new Date().toISOString(), itemState },
          },
        });
        await handleCommitResponse(response);
        await actions.syncRecoveryState();
      },
      onSuccess: () => finishDeliveryMutationSuccess(getMutationContext(), getMutationSetters()),
      errorReplayStatus: (error) => deliveryMutationErrorReplayStatus(getMutationContext(), error),
    });
  }

  async function navigateToItem(targetItemId: string): Promise<void> {
    if (state.attemptEditingLocked.value || state.deliveryBusy.value) return;
    if (!state.runtimeManifest.value) {
      return;
    }

    if (state.bootstrappedSession.value?.payload.deliveryPolicy.navigationMode === "linear") {
      state.replayStatus.value =
        "Linear delivery is active. QFlowLearn Delivery will only accept adjacent navigation.";
      return;
    }

    await navigateToManifestItem(
      targetItemId,
      "Requesting selected item navigation through the durable attempt frontier.",
      "harborNavigateSelected",
    );
  }

  async function navigateToManifestItem(
    targetItemId: string,
    statusMessage: string,
    captureTarget: string,
  ): Promise<void> {
    if (
      !state.attemptClient.value ||
      !state.runtimeManifest.value ||
      !state.authoritativeCurrentItemRef.value
    ) {
      return;
    }

    const targetItem = state.runtimeManifest.value.items[targetItemId];
    if (!targetItem) {
      state.errorMessage.value = `Pinned manifest entry ${targetItemId} is unavailable in the current shell state.`;
      return;
    }

    const activeItemId = state.currentItemId.value;
    if (!activeItemId) {
      return;
    }

    if (activeItemId === targetItem.id) {
      return;
    }

    await runDeliveryBusyMutation(getMutationContext(), getMutationSetters(), {
      initialReplayStatus: statusMessage,
      run: async () => {
        const responseRevision = state.responseEditRevision.value;
        const activeXml = state.currentItemPayload.value?.item.xml ?? "";
        const lifecycleState = state.itemLifecycleState.value;
        const lifecycleReadyForSelectedNavigation =
          captureTarget === "harborNavigateSelected" &&
          isItemReadyForNavigation(activeXml, lifecycleState);
        const itemState = lifecycleReadyForSelectedNavigation
          ? lifecycleState
          : await requireRendererLifecycle(input.rendererLifecycle).captureCurrentItemState(
              "score",
              captureTarget,
            );
        if (
          shouldBlockNavigationForValidationRequest({
            captureTarget,
            itemState,
            allowSkipping:
              resolveRendererSessionControl(state.policyState.value).allow_skipping !== false,
          })
        ) {
          state.replayStatus.value =
            "Current item still has validation messages. Resolve them before moving to another question.";
          return;
        }

        const saveResponse = await state.attemptClient.value!.queueAndSend({
          type: "response.changed",
          payload: {
            clientEditRevision: responseRevision,
            responseKey: activeItemId,
            responseState: {
              capturedAt: new Date().toISOString(),
              itemState,
            },
          },
        });

        await handleCommitResponse(saveResponse);
        recordResponseReceipt(saveResponse, responseRevision);

        const response = await state.attemptClient.value!.queueAndSend({
          type: "navigation.requested",
          payload: {
            targetItemRef: {
              itemId: targetItem.id,
              itemHref: targetItem.itemHref,
            },
          },
        });

        await handleCommitResponse(response);
        await actions.syncRecoveryState();
      },
      onSuccess: () => finishDeliveryMutationSuccess(getMutationContext(), getMutationSetters()),
    });
  }

  async function submitAttempt(): Promise<void> {
    if (state.attemptEditingLocked.value || state.deliveryBusy.value) return;
    if (!state.attemptClient.value || !state.runtimeManifest.value) {
      return;
    }

    state.finishCaptureInProgress.value = true;
    await runDeliveryBusyMutation(getMutationContext(), getMutationSetters(), {
      run: async () => {
        const activeItemId =
          state.currentItemId.value ?? state.runtimeManifest.value!.currentItemId;
        if (!activeItemId) {
          return;
        }

        const itemState = await requireRendererLifecycle(
          input.rendererLifecycle,
        ).captureCurrentItemState("score", "harborSubmitAttempt");
        if (
          shouldBlockSubmitForValidationRequest({
            itemState,
            allowSkipping:
              resolveRendererSessionControl(state.policyState.value).allow_skipping !== false,
          })
        ) {
          state.errorMessage.value =
            "Current item still has validation messages. Resolve them before submitting.";
          return;
        }

        const capturedAt = new Date().toISOString();
        const submissionSummary = buildCurrentSubmissionSummary();
        const responses = await state.attemptClient.value!.queueAndSendBatch([
          {
            type: "response.changed",
            payload: {
              responseKey: activeItemId,
              responseState: {
                capturedAt,
                itemState,
              },
            },
          },
          {
            type: "submit.requested",
            payload: {
              requestedAt: new Date().toISOString(),
              submissionSummary,
              submissionMaterialization: buildCurrentSubmissionMaterialization(),
            },
          },
        ]);

        for (const response of responses) {
          await handleCommitResponse(response);
        }
        await actions.syncRecoveryState();
        await actions.refreshAssessmentHistory();
      },
      onSuccess: () => finishDeliveryMutationSuccess(getMutationContext(), getMutationSetters()),
      onFinally: () => {
        state.finishCaptureInProgress.value = false;
      },
    });
  }

  async function maybeHandleDeadlineAutomation(): Promise<void> {
    if (state.attemptEditingLocked.value) return;
    if (
      state.deadlineAutomationInFlight ||
      !state.attemptClient.value ||
      !state.bootstrappedSession.value ||
      !state.runtimeManifest.value ||
      !state.currentItemId.value ||
      state.sessionIsStale.value ||
      state.deliveryBusy.value ||
      state.deliveryState.value === "submitted" ||
      state.deliveryState.value === "expired_pending_recovery"
    ) {
      return;
    }

    const timing = state.projectedDeliveryTiming.value;
    const deadlineScope = findActiveDeadlineScope(timing);
    if (!deadlineScope || !deadlineScope.deadlineAt) {
      return;
    }

    const remainingSeconds = Math.max(
      0,
      Math.ceil((Date.parse(deadlineScope.deadlineAt) - Date.now()) / 1000),
    );
    const deadlineKey = [
      state.bootstrappedSession.value.payload.attemptId,
      timing.effectivePolicyVersion ?? 0,
      deadlineScope.key,
      deadlineScope.deadlineAt,
    ].join(":");

    if (
      remainingSeconds > 0 &&
      remainingSeconds <= DEADLINE_WARNING_THRESHOLD_SECONDS &&
      !state.warnedDeadlineKeys.has(deadlineKey)
    ) {
      state.warnedDeadlineKeys.add(deadlineKey);
      await recordTimingEvidence("timing.deadline.warned", deadlineScope, {
        remainingTimeSeconds: remainingSeconds,
      });
      return;
    }

    if (remainingSeconds > 0 || state.autoSubmittedDeadlineKeys.has(deadlineKey)) {
      return;
    }

    state.autoSubmittedDeadlineKeys.add(deadlineKey);
    await autoSubmitAtDeadline(deadlineScope, deadlineKey);
  }

  async function autoSubmitAtDeadline(
    deadlineScope: NonNullable<ReturnType<typeof findActiveDeadlineScope>>,
    deadlineKey: string,
  ): Promise<void> {
    if (!state.attemptClient.value || !state.runtimeManifest.value || !state.currentItemId.value) {
      return;
    }

    state.deadlineAutomationInFlight = true;

    try {
      await runDeliveryBusyMutation(getMutationContext(), getMutationSetters(), {
        initialReplayStatus: "Time is up. Submitting the current saved work.",
        run: async () => {
          await recordTimingEvidence("timing.deadline.reached", deadlineScope, {
            remainingTimeSeconds: 0,
          });
          const activeItemId = state.currentItemId.value!;
          const itemState = await requireRendererLifecycle(
            input.rendererLifecycle,
          ).captureCurrentItemState("score", "harborDeadlineAutoSubmit");
          state.capturedItemStates.value = {
            ...state.capturedItemStates.value,
            [activeItemId]: itemState,
          };
          const responses = await state.attemptClient.value!.queueAndSendBatch([
            {
              type: "timing.auto-submit.requested",
              idempotencyKey: `timing-auto-submit:${deadlineKey}`,
              payload: {
                requestedAt: new Date().toISOString(),
                reason: "max-time-reached",
                scopeKey: deadlineScope.key,
                submissionSummary: buildCurrentSubmissionSummary(),
                submissionMaterialization: buildCurrentSubmissionMaterialization(),
              },
            },
          ]);

          for (const response of responses) {
            await handleCommitResponse(response);
          }
          await actions.syncRecoveryState();
          await actions.refreshAssessmentHistory();
        },
        onSuccess: () => finishDeliveryMutationSuccess(getMutationContext(), getMutationSetters()),
        onError: () => {
          state.autoSubmittedDeadlineKeys.delete(deadlineKey);
        },
      });
    } finally {
      state.deadlineAutomationInFlight = false;
    }
  }

  async function recordTimingEvidence(
    eventType: "timing.deadline.warned" | "timing.deadline.reached",
    deadlineScope: NonNullable<ReturnType<typeof findActiveDeadlineScope>>,
    details: { readonly remainingTimeSeconds: number },
  ): Promise<void> {
    const client = state.attemptClient.value;
    if (
      !client ||
      !state.currentItemId.value ||
      !state.runtimeManifest.value ||
      !deadlineScope.deadlineAt
    ) {
      return;
    }

    const itemDescriptor = state.runtimeManifest.value.items[state.currentItemId.value];
    if (!itemDescriptor) {
      return;
    }

    try {
      await client.queueAndSend({
        type: eventType,
        itemRef: {
          itemId: state.currentItemId.value,
          itemHref: itemDescriptor.itemHref,
        },
        payload: {
          eventSource: "browser",
          scopeKey: deadlineScope.key,
          scopeType: deadlineScope.scopeType,
          identifier: deadlineScope.identifier,
          deadlineAt: deadlineScope.deadlineAt,
          effectiveTimingPolicyVersion:
            state.projectedDeliveryTiming.value.effectivePolicyVersion ?? null,
          remainingTimeSeconds: details.remainingTimeSeconds,
        },
      });
    } catch {
      // AttemptClient keeps the event in its durable journal for replay.
    }
  }

  function buildCurrentSubmissionSummary(): AttemptSubmissionSummary {
    if (!state.runtimeManifest.value) {
      return {
        itemCount: 0,
        answeredItemCount: 0,
        scoredItemCount: 0,
        totalScore: null,
        maxScore: null,
        items: [],
      };
    }

    return buildAttemptSubmissionSummary({
      itemOrder: state.runtimeManifest.value.itemOrder,
      itemDescriptors: Object.fromEntries(
        Object.entries(state.runtimeManifest.value.items).map(([itemId, item]) => [
          itemId,
          {
            identifier: item.identifier,
            title: item.title,
            maxScore: item.maxScore,
          },
        ]),
      ),
      itemStates: state.capturedItemStates.value,
    });
  }

  function buildCurrentSubmissionMaterialization(): AttemptSubmissionMaterializationInput {
    if (!state.runtimeManifest.value) {
      return {
        itemOrder: [],
        testState: null,
        partStates: {},
        sectionStates: {},
        items: {},
      };
    }

    return {
      itemOrder: state.runtimeManifest.value.itemOrder,
      testState: null,
      partStates: {},
      sectionStates: {},
      items: Object.fromEntries(
        state.runtimeManifest.value.itemOrder.flatMap((itemId) => {
          const itemState = state.capturedItemStates.value[itemId];
          const itemDescriptor = state.runtimeManifest.value?.items[itemId];

          if (!itemState || !itemDescriptor || typeof itemState !== "object") {
            return [];
          }

          const record = itemState as Record<string, unknown>;
          return [
            [
              itemId,
              {
                itemId,
                itemIdentifier: itemDescriptor.identifier,
                itemTitle: itemDescriptor.title,
                capturedAt: readCapturedAt(record),
                responseVariables: readQtiResponseSnapshots(itemState),
                outcomeVariables: readQtiOutcomeSnapshots(itemState),
                validationMessages: readQtiValidationSnapshots(itemState),
                stateJson: itemState,
              },
            ],
          ];
        }),
      ),
    };
  }

  function readCapturedAt(value: Record<string, unknown>): string | null {
    return typeof value.capturedAt === "string" && value.capturedAt ? value.capturedAt : null;
  }

  async function handleCommitResponse(
    response: AttemptEventCommitResponse,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    if (
      state.runtimeManifest.value?.testSequence &&
      (state.runtimeManifest.value.currentItemId !== response.currentItemRef.itemId ||
        response.attemptStatus === "submitted")
    ) {
      if (state.runtimeManifest.value.currentItemId !== response.currentItemRef.itemId)
        state.itemReady.value = false;
      state.runtimeManifest.value = await loadRuntimeManifest(response.attemptId, options);
    }
    options.signal?.throwIfAborted();
    state.authoritativeCurrentItemRef.value = response.currentItemRef;
    await syncDisplayedCurrentItem(response.currentItemRef.itemId, options);
    options.signal?.throwIfAborted();
    await actions.applyPolicyProjection(
      {
        attemptId: state.bootstrappedSession.value?.payload.attemptId ?? response.attemptId,
        attemptStatus: response.attemptStatus,
        timing: response.timing,
        policy: response.policy,
      },
      "Accepted receipts now carry the latest authoritative policy overlay.",
    );

    if (response.attemptStatus === "submitted") {
      await actions.refreshAssessmentHistory(response.attemptId, options);
    }

    if (response.outcome !== "stale_session") {
      return;
    }

    state.sessionIsStale.value = true;
    state.replayStatus.value = `This tab is no longer current. QFlowLearn Delivery restored the authoritative frontier at sequence ${response.highestCommittedSequence}.`;
  }

  async function syncDisplayedCurrentItem(
    itemId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    if (!state.bootstrappedSession.value || !state.runtimeManifest.value) {
      return;
    }

    if (state.runtimeManifest.value.currentItemId !== itemId) {
      state.runtimeManifest.value = {
        ...state.runtimeManifest.value,
        currentItemId: itemId,
      };
    }

    if (state.currentItemPayload.value?.item.id === itemId) {
      return;
    }

    state.itemReady.value = false;
    const restoredItemState = state.capturedItemStates.value[itemId] ?? null;
    state.itemLifecycleState.value = restoredItemState;
    state.rendererRestoreState.value = restoredItemState;
    const item = await loadRuntimeItem(
      {
        attemptId: state.bootstrappedSession.value.payload.attemptId,
        itemId,
      },
      options,
    );
    options.signal?.throwIfAborted();
    state.currentItemPayload.value = item;
    if (!options.signal) void recordCurrentItemPresented("navigation");
  }

  async function recordCurrentItemPresented(
    presentationSource: "bootstrap" | "resume" | "navigation" | "replay",
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    if (state.attemptEditingLocked.value) return;
    const client = state.attemptClient.value;
    if (
      !client ||
      !state.bootstrappedSession.value ||
      !state.runtimeManifest.value ||
      !state.currentItemPayload.value
    ) {
      return;
    }

    const manifestItem = state.runtimeManifest.value.items[state.currentItemPayload.value.item.id];
    if (!manifestItem) {
      return;
    }

    const itemRef = {
      itemId: state.currentItemPayload.value.item.id,
      itemHref: manifestItem.itemHref,
    };
    const evidenceKey = [
      state.bootstrappedSession.value.payload.attemptId,
      itemRef.itemId,
      itemRef.itemHref,
    ].join(":");

    if (state.itemPresentationEvidenceKeys.has(evidenceKey)) {
      return;
    }

    state.itemPresentationEvidenceKeys.add(evidenceKey);

    let response: AttemptEventCommitResponse;
    try {
      response = await client.queueAndSend({
        type: "item.presented",
        itemRef,
        idempotencyKey: `item-presented:${evidenceKey}`,
        payload: {
          presentedAt: new Date().toISOString(),
          presentationSource,
        },
      });
    } catch {
      // AttemptClient keeps the event in its durable journal for replay.
      return;
    }
    await handleCommitResponse(response, options);
    await actions.syncRecoveryState();
  }

  function getMutationContext(): DeliveryMutationContext {
    return {
      rendererLifecycle: input.rendererLifecycle,
      handleCommitResponse,
      syncRecoveryState: actions.syncRecoveryState,
      maybeProjectDeliveryContextError: actions.maybeProjectDeliveryContextError,
      buildReceiptStatusMessage: actions.buildReceiptStatusMessage,
      formatError,
      sessionIsStale: state.sessionIsStale,
      pendingReplayCount: state.pendingReplayCount,
    };
  }

  function getMutationSetters() {
    return {
      deliveryBusy: state.deliveryBusy,
      errorMessage: state.errorMessage,
      replayStatus: state.replayStatus,
    };
  }

  return {
    markResponseDirty,
    autosaveResponse,
    queueDraftResponse,
    navigateItem,
    navigateToItem,
    submitAttempt,
    maybeHandleDeadlineAutomation,
    handleCommitResponse,
    recordCurrentItemPresented,
  };
}
