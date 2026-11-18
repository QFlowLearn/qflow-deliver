import type { RendererConfiguration, RendererHostHandle } from "@harbor/renderer-adapter";
import { describe, expect, it } from "vitest";

import type { RefLike } from "./ref-like";
import { createRendererLifecycleRuntime } from "./renderer-lifecycle";

interface PersistenceWrite {
  readonly attemptId: string;
  readonly states: Record<string, unknown>;
}

class RecordingRendererHost implements RendererHostHandle {
  readonly commands: Array<{
    readonly command: "snapshot" | "suspend" | "end" | "score";
    readonly target: string;
  }> = [];

  loadItemFromXml(_xml: string, _configuration: RendererConfiguration): void {}

  updateBuiltIns(_builtIns: NonNullable<RendererConfiguration["builtIns"]>): void {}

  endAttempt(target: string): void {
    this.commands.push({ command: "end", target });
  }

  suspendAttempt(target: string): void {
    this.commands.push({ command: "suspend", target });
  }

  snapshotAttempt(target: string): void {
    this.commands.push({ command: "snapshot", target });
  }

  scoreAttempt(target: string): void {
    this.commands.push({ command: "score", target });
  }

  getRenderedText(): string {
    return "";
  }

  getAnswerMaskChoiceRegions(): [] {
    return [];
  }

  getCatalogSupportResolution(): undefined {
    return undefined;
  }

  getCatalogDeliveryResolution(): undefined {
    return undefined;
  }

  getTextToSpeechTraversal(): undefined {
    return undefined;
  }

  subscribeCatalogRequests(
    _listener: Parameters<RendererHostHandle["subscribeCatalogRequests"]>[0],
  ): () => void {
    return () => {};
  }
}

function ref<T>(value: T): RefLike<T> {
  return { value };
}

function createHarness(
  host: RendererHostHandle | null = new RecordingRendererHost(),
  persistWrite: (write: PersistenceWrite) => Promise<void> = async () => {},
) {
  const rendererHost = ref<RendererHostHandle | null>(host);
  const currentAttemptId = ref<string | null>("attempt-1");
  const currentItemId = ref<string | null>("item-1");
  const capturedItemStates = ref<Record<string, unknown>>({});
  const itemLifecycleState = ref<unknown>(null);
  const replayStatus = ref("");
  const errorMessage = ref("");
  const submissionLocked = ref(false);
  const writes: PersistenceWrite[] = [];
  const runtime = createRendererLifecycleRuntime({
    rendererHost,
    onResponseDirty() {
      return 0;
    },
    async onResponseCheckpoint() {},
    itemReady: ref(true),
    currentItemId,
    runtimeManifest: ref(null),
    capturedItemStates,
    itemLifecycleState,
    rendererRestoreState: ref<unknown>(null),
    replayStatus,
    errorMessage,
    async writeCachedItemStates(attemptId, states) {
      const write = { attemptId, states: structuredClone(states) };
      writes.push(write);
      await persistWrite(write);
    },
    getCurrentAttemptId: () => currentAttemptId.value,
    getDeliveryState: () => "active",
    getSessionIsStale: () => false,
    getSubmissionLocked: () => submissionLocked.value,
    projectedDeliveryTiming: ref({
      startedAt: null,
      expiresAt: null,
      remainingTimeSeconds: null,
    }),
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
  });

  return {
    runtime,
    host,
    currentAttemptId,
    currentItemId,
    capturedItemStates,
    itemLifecycleState,
    replayStatus,
    errorMessage,
    submissionLocked,
    writes,
  };
}

describe("renderer lifecycle persistence", () => {
  it("does not capture or persist new lifecycle work after Finish has locked the answers", async () => {
    const host = new RecordingRendererHost();
    const harness = createHarness(host);
    harness.submissionLocked.value = true;
    harness.runtime.handleRendererInteractionObserved();
    await harness.runtime.captureLifecycleItemState("pagehide");
    expect(host.commands).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it("persists the resumable live checkpoint once for an awaited score capture", async () => {
    const harness = createHarness();
    const host = harness.host;
    if (!(host instanceof RecordingRendererHost)) {
      throw new Error("Expected the recording renderer host.");
    }

    const capture = harness.runtime.captureCurrentItemState("score", "harborSaveDraft");
    expect(host.commands).toEqual([{ command: "snapshot", target: "harborSaveDraft:sync" }]);

    const checkpointState = { itemIdentifier: "item-1", response: "draft" };
    harness.runtime.handleSnapshotAttemptCompleted({ state: checkpointState });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.commands).toEqual([
      { command: "snapshot", target: "harborSaveDraft:sync" },
      { command: "score", target: "harborSaveDraft" },
    ]);

    const scoredState = { itemIdentifier: "item-1", response: "final", score: 1 };
    harness.runtime.handleScoreAttemptCompleted({ state: scoredState });

    await expect(capture).resolves.toEqual(scoredState);
    expect(harness.writes).toEqual([
      {
        attemptId: "attempt-1",
        states: { "item-1": checkpointState },
      },
    ]);
  });

  it("captures the attempt and item before persistence settles", async () => {
    const pendingWriteResolutions: Array<() => void> = [];
    const harness = createHarness(new RecordingRendererHost(), () => {
      return new Promise((resolve) => pendingWriteResolutions.push(resolve));
    });
    const checkpointState = { itemIdentifier: "item-1", response: "draft" };
    const endedState = { itemIdentifier: "item-1", response: "final" };

    harness.runtime.handleSnapshotAttemptCompleted({ state: checkpointState });
    harness.runtime.handleEndAttemptCompleted({ state: endedState });

    harness.currentAttemptId.value = "attempt-2";
    harness.currentItemId.value = "item-2";
    harness.capturedItemStates.value = {
      "item-2": { itemIdentifier: "item-2", response: "restored" },
    };

    expect(harness.writes).toEqual([
      {
        attemptId: "attempt-1",
        states: { "item-1": checkpointState },
      },
      {
        attemptId: "attempt-1",
        states: { "item-1": endedState },
      },
    ]);

    const finishSuspendWrite = pendingWriteResolutions.shift();
    if (!finishSuspendWrite) {
      throw new Error("Expected the live checkpoint write to be pending.");
    }
    finishSuspendWrite();

    const finishEndWrite = pendingWriteResolutions.shift();
    if (!finishEndWrite) {
      throw new Error("Expected the end checkpoint write to be pending.");
    }
    finishEndWrite();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("returns the scored state after a live checkpoint failure", async () => {
    let writeCount = 0;
    const harness = createHarness(new RecordingRendererHost(), async () => {
      writeCount += 1;
      if (writeCount === 1) {
        throw new Error("checkpoint unavailable");
      }
    });
    const capture = harness.runtime.captureCurrentItemState("score", "harborSaveDraft");
    const checkpointState = { itemIdentifier: "item-1", response: "draft" };
    const scoredState = { itemIdentifier: "item-1", response: "final", score: 1 };

    harness.runtime.handleSnapshotAttemptCompleted({ state: checkpointState });
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.runtime.handleScoreAttemptCompleted({ state: scoredState });

    await expect(capture).resolves.toEqual(scoredState);
    expect(harness.errorMessage.value).toBe(
      "Local recovery storage failed: checkpoint unavailable",
    );
    expect(harness.writes).toEqual([
      {
        attemptId: "attempt-1",
        states: { "item-1": checkpointState },
      },
    ]);
  });

  it("persists an unawaited completion for local recovery", async () => {
    let persistenceCompleted = false;
    const harness = createHarness(new RecordingRendererHost(), async () => {
      await Promise.resolve();
      persistenceCompleted = true;
    });
    const host = harness.host;
    if (!(host instanceof RecordingRendererHost)) {
      throw new Error("Expected the recording renderer host.");
    }

    harness.runtime.requestEndAttempt();
    const completedState = { itemIdentifier: "item-1", response: "recoverable" };
    harness.runtime.handleEndAttemptCompleted({ state: completedState });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.commands).toEqual([{ command: "end", target: "harborEndItem" }]);
    expect(harness.itemLifecycleState.value).toEqual(completedState);
    expect(persistenceCompleted).toBe(true);
    expect(harness.writes).toEqual([
      {
        attemptId: "attempt-1",
        states: { "item-1": completedState },
      },
    ]);
  });

  it("does not persist an unexpected scored state before rejecting the capture", async () => {
    const harness = createHarness();
    const capture = harness.runtime.captureCurrentItemState("score", "harborSaveDraft");
    const unexpectedState = { itemIdentifier: "item-1", response: "recoverable" };

    harness.runtime.handleScoreAttemptCompleted({ state: unexpectedState });

    await expect(capture).rejects.toThrow(
      "QFlowLearn Delivery received an unexpected renderer capture response.",
    );
    expect(harness.itemLifecycleState.value).toEqual(unexpectedState);
    expect(harness.writes).toEqual([]);
  });

  it("persists the fallback state once when the renderer is unavailable", async () => {
    const harness = createHarness(null);
    const fallbackState = { itemIdentifier: "item-1", response: "cached" };
    harness.capturedItemStates.value = { "item-1": fallbackState };

    await expect(
      harness.runtime.captureCurrentItemState("score", "harborSaveDraft"),
    ).resolves.toEqual(fallbackState);
    expect(harness.writes).toEqual([
      {
        attemptId: "attempt-1",
        states: { "item-1": fallbackState },
      },
    ]);
  });
});
