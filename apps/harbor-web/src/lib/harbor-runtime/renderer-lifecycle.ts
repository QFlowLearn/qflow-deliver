import type { AuthoritativeAttemptSessionState } from "@harbor/attempt-protocol";
import type { RendererConfiguration, RendererHostHandle } from "@harbor/renderer-adapter";

import type { RuntimeManifestSummary } from "../runtime-session";
import type { DeliveryTimingState } from "./timing";
import type { ReadonlyRefLike, RefLike } from "./ref-like";

const RENDERER_PREFLUSH_DEBOUNCE_MS = 800;
const RENDERER_MAX_DIRTY_MS = 4_000;

type RendererCaptureCommand = "snapshot" | "suspend" | "end" | "score";

interface RendererCaptureResult {
  readonly state: unknown;
  readonly persistence: Promise<void>;
}

export interface RendererLifecycleRuntime {
  buildRendererBuiltIns(this: void): NonNullable<RendererConfiguration["builtIns"]>;
  resetCaptureState(this: void): void;
  requestSuspendAttempt(this: void): void;
  requestEndAttempt(this: void): void;
  handleItemReady(this: void): void;
  handleSuspendAttemptCompleted(this: void, payload: unknown): void;
  handleSnapshotAttemptCompleted(this: void, payload: unknown): void;
  handleEndAttemptCompleted(this: void, payload: unknown): void;
  handleScoreAttemptCompleted(this: void, payload: unknown): void;
  handleRendererInteractionObserved(this: void): void;
  clearRendererPreflushTimer(this: void): void;
  captureLifecycleItemState(this: void, reason: string): Promise<void>;
  captureCurrentItemState(
    this: void,
    command: RendererCaptureCommand,
    target: string,
  ): Promise<unknown>;
}

export function createRendererLifecycleRuntime(input: {
  rendererHost: RefLike<RendererHostHandle | null>;
  itemReady: RefLike<boolean>;
  currentItemId: ReadonlyRefLike<string | null>;
  runtimeManifest: RefLike<RuntimeManifestSummary | null>;
  capturedItemStates: RefLike<Record<string, unknown>>;
  itemLifecycleState: RefLike<unknown>;
  rendererRestoreState: RefLike<unknown>;
  replayStatus: RefLike<string>;
  errorMessage: RefLike<string>;
  writeCachedItemStates(attemptId: string, states: Record<string, unknown>): Promise<void>;
  getCurrentAttemptId(): string | null;
  getDeliveryState(): AuthoritativeAttemptSessionState["attemptStatus"];
  getSessionIsStale(): boolean;
  getSubmissionLocked(): boolean;
  projectedDeliveryTiming: ReadonlyRefLike<DeliveryTimingState>;
  formatError(error: unknown): string;
  onResponseDirty(): number;
  onResponseCheckpoint(checkpoint: {
    attemptId: string;
    itemId: string;
    itemState: unknown;
    editRevision: number;
  }): Promise<void>;
}): RendererLifecycleRuntime {
  let pendingRendererCapture: {
    command: RendererCaptureCommand;
    resolve: (result: RendererCaptureResult) => void;
    reject: (error: Error) => void;
  } | null = null;
  let rendererPreflushTimer: ReturnType<typeof setTimeout> | null = null;
  let responseDirty = false;
  let editRevision = 0;
  let rendererMaxDirtyTimer: ReturnType<typeof setTimeout> | null = null;
  let captureTail: Promise<unknown> | null = null;

  function buildRendererBuiltIns(): NonNullable<RendererConfiguration["builtIns"]> {
    return {
      duration: input.projectedDeliveryTiming.value.currentItemDurationSeconds ?? 0,
      numAttempts: 1,
      completionStatus: "unknown",
    };
  }

  function resetCaptureState(): void {
    pendingRendererCapture = null;
    responseDirty = false;
    clearRendererPreflushTimer();
  }

  function requestSuspendAttempt(): void {
    input.rendererHost.value?.suspendAttempt("harborSuspendItem");
  }

  function requestEndAttempt(): void {
    input.rendererHost.value?.endAttempt("harborEndItem");
  }

  function handleItemReady(): void {
    input.itemReady.value = true;
    void captureLifecycleItemState("item-ready-validation").catch(handleLocalPersistenceError);
  }

  function handleSnapshotAttemptCompleted(payload: unknown): void {
    handleRendererCaptureCompleted("snapshot", payload);
  }

  function handleSuspendAttemptCompleted(payload: unknown): void {
    handleRendererCaptureCompleted("suspend", payload);
  }

  function handleEndAttemptCompleted(payload: unknown): void {
    handleRendererCaptureCompleted("end", payload);
  }

  function handleScoreAttemptCompleted(payload: unknown): void {
    handleRendererCaptureCompleted("score", payload);
  }

  function handleRendererInteractionObserved(): void {
    if (
      !input.getCurrentAttemptId() ||
      !input.currentItemId.value ||
      input.getDeliveryState() === "submitted" ||
      input.getSubmissionLocked() ||
      input.getSessionIsStale()
    ) {
      return;
    }

    responseDirty = true;
    editRevision = input.onResponseDirty();
    if (rendererPreflushTimer) clearTimeout(rendererPreflushTimer);
    if (!rendererMaxDirtyTimer)
      rendererMaxDirtyTimer = setTimeout(() => {
        void captureLifecycleItemState("renderer-interaction").catch(handleLocalPersistenceError);
      }, RENDERER_MAX_DIRTY_MS);
    rendererPreflushTimer = setTimeout(() => {
      void captureLifecycleItemState("renderer-interaction").catch(handleLocalPersistenceError);
    }, RENDERER_PREFLUSH_DEBOUNCE_MS);
  }

  function clearRendererPreflushTimer(): void {
    if (rendererMaxDirtyTimer) {
      clearTimeout(rendererMaxDirtyTimer);
      rendererMaxDirtyTimer = null;
    }
    if (rendererPreflushTimer) {
      clearTimeout(rendererPreflushTimer);
      rendererPreflushTimer = null;
    }
  }

  async function captureLifecycleItemState(reason: string): Promise<void> {
    // Initialization must not consume an edit made as the new item becomes ready.
    if (reason === "item-ready-validation" && responseDirty) return;
    if (
      !input.getCurrentAttemptId() ||
      !input.currentItemId.value ||
      input.getSessionIsStale() ||
      input.getSubmissionLocked() ||
      input.getDeliveryState() === "submitted"
    ) {
      return;
    }

    try {
      clearRendererPreflushTimer();
      const wasDirty = responseDirty;
      const capturedRevision = editRevision;
      responseDirty = false;
      const attemptId = input.getCurrentAttemptId();
      const itemId = input.currentItemId.value;
      const itemState = await enqueueCapture("snapshot", `harborLifecycle:${reason}`);
      if (wasDirty && attemptId && itemId && reason !== "item-ready-validation")
        await input.onResponseCheckpoint({
          attemptId,
          itemId,
          itemState,
          editRevision: capturedRevision,
        });
    } catch (error) {
      handleLocalPersistenceError(error);
    }
  }

  function captureCurrentItemState(
    command: RendererCaptureCommand,
    target: string,
  ): Promise<unknown> {
    responseDirty = false;
    clearRendererPreflushTimer();
    return enqueueCapture(command, target);
  }

  function enqueueCapture(command: RendererCaptureCommand, target: string): Promise<unknown> {
    const capture = captureTail
      ? captureTail.then(() => captureItemState(command, target))
      : captureItemState(command, target);
    const clearTail = () => {
      if (captureTail === tail) captureTail = null;
    };
    const tail = capture.then(clearTail, clearTail);
    captureTail = tail;
    return capture;
  }

  async function captureItemState(
    command: RendererCaptureCommand,
    target: string,
  ): Promise<unknown> {
    if (!input.currentItemId.value) {
      return input.itemLifecycleState.value;
    }

    if (input.rendererHost.value && !input.itemReady.value) {
      await waitForRendererReady();
    }

    if (!input.rendererHost.value || !input.itemReady.value) {
      const fallbackState =
        input.capturedItemStates.value[input.currentItemId.value] ?? input.itemLifecycleState.value;
      await persistCurrentItemState(fallbackState);
      return fallbackState;
    }

    if (command === "score") {
      const syncCapture = await captureRendererCommand("snapshot", `${target}:sync`);
      const recoveryPersistence = syncCapture.persistence.catch(handleLocalPersistenceError);
      const capture = await captureRendererCommand(command, target);
      await recoveryPersistence;
      return capture.state;
    }

    const capture = await captureRendererCommand(command, target);
    await capture.persistence;
    return capture.state;
  }

  async function waitForRendererReady(timeoutMs = 1500): Promise<void> {
    if (input.itemReady.value) {
      return;
    }

    const startedAt = Date.now();
    while (!input.itemReady.value && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function captureRendererCommand(
    command: RendererCaptureCommand,
    target: string,
  ): Promise<RendererCaptureResult> {
    if (pendingRendererCapture) {
      throw new Error("QFlowLearn Delivery is already waiting on a renderer snapshot.");
    }

    input.rendererHost.value?.updateBuiltIns(buildRendererBuiltIns());

    return new Promise((resolve, reject) => {
      pendingRendererCapture = {
        command,
        resolve,
        reject,
      };

      switch (command) {
        case "snapshot":
          input.rendererHost.value?.snapshotAttempt(target);
          break;
        case "suspend":
          input.rendererHost.value?.suspendAttempt(target);
          break;
        case "score":
          input.rendererHost.value?.scoreAttempt(target);
          break;
        default:
          input.rendererHost.value?.endAttempt(target);
          break;
      }
    });
  }

  function handleRendererCaptureCompleted(command: RendererCaptureCommand, payload: unknown): void {
    const state = commitRendererPayload(payload);
    const persistence = command === "score" ? Promise.resolve() : persistCurrentItemState(state);
    if (resolvePendingRendererCapture(command, { state, persistence })) {
      return;
    }

    void persistence.catch(handleLocalPersistenceError);
  }

  function commitRendererPayload(payload: unknown): unknown {
    const state = readRendererState(payload);
    input.itemLifecycleState.value = state;
    return state;
  }

  async function persistCurrentItemState(state: unknown): Promise<void> {
    const itemId = resolveItemStateStorageKey(state);
    const attemptId = input.getCurrentAttemptId();
    if (!attemptId || !itemId || state === null) {
      return;
    }

    input.capturedItemStates.value = {
      ...input.capturedItemStates.value,
      [itemId]: state,
    };
    await input.writeCachedItemStates(attemptId, input.capturedItemStates.value);
  }

  function resolveItemStateStorageKey(state: unknown): string | null {
    if (
      state &&
      typeof state === "object" &&
      !Array.isArray(state) &&
      typeof (state as { itemIdentifier?: unknown }).itemIdentifier === "string"
    ) {
      const itemIdentifier = (state as { itemIdentifier: string }).itemIdentifier.trim();
      if (itemIdentifier && input.runtimeManifest.value?.itemOrder.includes(itemIdentifier)) {
        return itemIdentifier;
      }
    }

    return input.currentItemId.value;
  }

  function handleLocalPersistenceError(error: unknown): void {
    const message = `Local recovery storage failed: ${input.formatError(error)}`;
    input.errorMessage.value = message;
    input.replayStatus.value = message;
  }

  function resolvePendingRendererCapture(
    command: RendererCaptureCommand,
    result: RendererCaptureResult,
  ): boolean {
    const pendingCapture = pendingRendererCapture;
    if (!pendingCapture) {
      return false;
    }
    pendingRendererCapture = null;

    if (pendingCapture.command !== command) {
      pendingCapture.reject(
        new Error("QFlowLearn Delivery received an unexpected renderer capture response."),
      );
      return false;
    }

    pendingCapture.resolve(result);
    return true;
  }

  function readRendererState(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const state = (payload as { state?: unknown }).state;
    return state === undefined ? null : state;
  }

  return {
    buildRendererBuiltIns,
    resetCaptureState,
    requestSuspendAttempt,
    requestEndAttempt,
    handleItemReady,
    handleSuspendAttemptCompleted,
    handleSnapshotAttemptCompleted,
    handleEndAttemptCompleted,
    handleScoreAttemptCompleted,
    handleRendererInteractionObserved,
    clearRendererPreflushTimer,
    captureLifecycleItemState,
    captureCurrentItemState,
  };
}
