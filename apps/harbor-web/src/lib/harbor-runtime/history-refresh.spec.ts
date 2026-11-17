import type { AssignmentHistoryAttemptSummary } from "@harbor/attempt-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ref } from "../preact-reactivity";
import type { RuntimeAssessmentHistory } from "../runtime-session";
import { createHistoryRefreshScheduler } from "./history-refresh";

function createHarness(finalizationStatus: "pending" | "complete" | "failed" | null) {
  const state: {
    assessmentHistory: ReturnType<typeof ref<RuntimeAssessmentHistory | null>>;
    historyRefreshTimer: ReturnType<typeof setTimeout> | null;
  } = { assessmentHistory: ref<RuntimeAssessmentHistory | null>(null), historyRefreshTimer: null };
  const attempt: AssignmentHistoryAttemptSummary = {
    attemptId: "attempt-1",
    assignmentId: null,
    assessmentVersionId: "version-1",
    createdAt: "2026-09-24T20:50:00Z",
    submittedAt: "2026-09-24T20:51:00Z",
    totalScore: null,
    maxScore: null,
    answeredItemCount: 1,
    scoredItemCount: 0,
    itemCount: 1,
    resultStatus: "pending",
    finalization:
      finalizationStatus === null
        ? null
        : {
            status: finalizationStatus,
            errorMessage: null,
            updatedAt: "2026-09-24T20:52:00Z",
          },
    latestScoreRevision: null,
    items: [],
  };
  state.assessmentHistory.value = {
    attemptId: attempt.attemptId,
    assignmentId: null,
    assessment: {
      id: "assessment-1",
      title: "History",
      assessmentVersionId: "version-1",
      assignmentTitle: null,
    },
    actor: { kind: "preview-operator", id: "preview", displayName: "Preview", learnerId: null },
    attempts: [attempt],
  };
  const refreshedAttempts: string[] = [];
  const recovery = createHistoryRefreshScheduler(state, async (attemptId) => {
    refreshedAttempts.push(attemptId);
  });
  return { state, refreshedAttempts, recovery };
}

describe("history polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits 30 seconds before refreshing unfinished processing", async () => {
    const harness = createHarness("pending");
    harness.recovery.scheduleHistoryRefreshIfPending("attempt-1");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(harness.refreshedAttempts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.refreshedAttempts).toEqual(["attempt-1"]);
  });

  it.each(["complete", "failed", null] as const)(
    "does not poll pending results when finalization is %s",
    async (status) => {
      const harness = createHarness(status);
      harness.recovery.scheduleHistoryRefreshIfPending("attempt-1");
      await vi.advanceTimersByTimeAsync(300_000);
      expect(harness.refreshedAttempts).toEqual([]);
    },
  );

  it("does not poll a different attempt when the requested attempt is absent", async () => {
    const harness = createHarness("pending");
    harness.recovery.scheduleHistoryRefreshIfPending("missing-attempt");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.refreshedAttempts).toEqual([]);
  });

  it("cancels the scheduled refresh when processing completes", async () => {
    const harness = createHarness("pending");
    harness.recovery.scheduleHistoryRefreshIfPending("attempt-1");
    const history = harness.state.assessmentHistory.value;
    if (!history) throw new Error("Expected history");
    harness.state.assessmentHistory.value = {
      ...history,
      attempts: history.attempts.map((attempt) => ({
        ...attempt,
        finalization: {
          status: "complete",
          errorMessage: null,
          updatedAt: "2026-09-24T20:53:00Z",
        },
      })),
    };
    harness.recovery.scheduleHistoryRefreshIfPending("attempt-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.refreshedAttempts).toEqual([]);
  });

  it("clears pending refreshes on cleanup", async () => {
    const harness = createHarness("pending");
    harness.recovery.scheduleHistoryRefreshIfPending("attempt-1");
    harness.recovery.clearHistoryRefreshTimer();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.refreshedAttempts).toEqual([]);
  });
});
