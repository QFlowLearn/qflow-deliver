import type { DeliverySessionState } from "./delivery-session-state";

const HISTORY_REFRESH_INTERVAL_MS = 30_000;

/** Schedules background refreshes only while the requested attempt is processing. */
export function createHistoryRefreshScheduler(
  state: Pick<DeliverySessionState, "assessmentHistory" | "historyRefreshTimer">,
  refreshAssessmentHistory: (attemptId: string) => Promise<void>,
) {
  function clearHistoryRefreshTimer(): void {
    if (state.historyRefreshTimer !== null) {
      clearTimeout(state.historyRefreshTimer);
      state.historyRefreshTimer = null;
    }
  }

  function scheduleHistoryRefreshIfPending(attemptId: string): void {
    clearHistoryRefreshTimer();
    if (!state.assessmentHistory.value) {
      return;
    }

    const trackedAttempt = state.assessmentHistory.value.attempts.find(
      (attempt) => attempt.attemptId === attemptId,
    );

    if (!trackedAttempt) {
      return;
    }

    // A pending result can await human review long after processing has finished.
    if (trackedAttempt.finalization?.status !== "pending") {
      return;
    }

    state.historyRefreshTimer = setTimeout(() => {
      state.historyRefreshTimer = null;
      void refreshAssessmentHistory(attemptId);
    }, HISTORY_REFRESH_INTERVAL_MS);
  }

  return { clearHistoryRefreshTimer, scheduleHistoryRefreshIfPending };
}
