import type {
  AttemptPolicyState,
  AttemptStatus,
  AttemptTimingState,
} from "@harbor/attempt-protocol";

export interface AttemptStatusState {
  attemptStatus: AttemptStatus;
  timing: AttemptTimingState;
  policy: AttemptPolicyState;
}

export function resolveAttemptStatus(
  storedState: AttemptStatusState,
  now = new Date().toISOString(),
): AttemptStatus {
  if (storedState.attemptStatus === "submitted") {
    return storedState.attemptStatus;
  }

  if (storedState.attemptStatus === "reopened") {
    const reopenUntil =
      storedState.policy.reopen.reopenUntil ??
      storedState.timing.acceptUntil ??
      storedState.timing.softCloseAt;
    if (!reopenUntil) {
      return "reopened";
    }

    const reopenUntilMs = Date.parse(reopenUntil);
    const nowMs = Date.parse(now);
    if (!Number.isNaN(reopenUntilMs) && !Number.isNaN(nowMs) && nowMs > reopenUntilMs) {
      return "expired_pending_recovery";
    }

    return "reopened";
  }

  const softCloseAt = storedState.timing.softCloseAt ?? storedState.timing.expiresAt;
  if (!softCloseAt) {
    return storedState.attemptStatus;
  }

  const softCloseAtMs = Date.parse(softCloseAt);
  const acceptUntilMs = Date.parse(
    storedState.timing.acceptUntil ?? storedState.timing.expiresAt ?? softCloseAt,
  );
  const nowMs = Date.parse(now);

  if (Number.isNaN(softCloseAtMs) || Number.isNaN(acceptUntilMs)) {
    return storedState.attemptStatus;
  }

  if (nowMs < softCloseAtMs) {
    return "active";
  }

  if (nowMs < acceptUntilMs) {
    return "accepting_late_within_grace";
  }

  return "expired_pending_recovery";
}
