import type { StoredTimingScope } from "./attempt-timing";
import { STATE_KEY, type StoredAttemptState } from "./attempt-state-bootstrap";

/** Recovery wake-up retained before background delivery leaves the alarm callback. */
export const OUTBOX_RECOVERY_DELAY_MS = 60_000;

const OUTBOX_AT_KEY = "attempt-alarm-outbox-at";
type AlarmStorage = Pick<
  DurableObjectStorage,
  "get" | "put" | "delete" | "getAlarm" | "setAlarm" | "deleteAlarm"
>;

/** Select the next eligible server submission, preserving grace and minimum-time policy. */
export function findAttemptDeadlineAlarm(
  state: Pick<StoredAttemptState, "attemptStatus" | "scopedTiming" | "timing" | "deliveryPolicy">,
): { readonly at: number; readonly scope: StoredTimingScope } | null {
  if (state.attemptStatus === "submitted") return null;
  let minimumReady = -Infinity;
  for (const scope of state.scopedTiming.scopes) {
    if (
      (scope.scopeType === "assessment-test" || scope.scopeType === "test-part") &&
      (scope.status === "interacting" || scope.status === "suspended") &&
      scope.minTimeSeconds !== null
    ) {
      const remaining = scope.minTimeSeconds * 1_000 - scope.elapsedMilliseconds;
      if (remaining > 0)
        minimumReady = Math.max(
          minimumReady,
          scope.activeSince ? Date.parse(scope.activeSince) + remaining : Infinity,
        );
    }
  }
  const assessmentGrace =
    state.timing.acceptUntil && state.timing.softCloseAt
      ? Math.max(0, Date.parse(state.timing.acceptUntil) - Date.parse(state.timing.softCloseAt))
      : 0;
  let next: { at: number; scope: StoredTimingScope } | null = null;
  for (const scope of state.scopedTiming.scopes) {
    if (
      !scope.deadlineAt ||
      scope.unlimited ||
      scope.status === "closed" ||
      scope.status === "initial"
    )
      continue;
    const deadline = Date.parse(scope.deadlineAt);
    if (!Number.isFinite(deadline)) throw new Error("Invalid stored attempt deadline");
    const grace = scope.allowLateSubmission
      ? scope.scopeType === "assessment-test"
        ? assessmentGrace
        : Math.max(0, state.deliveryPolicy.gracePeriodSeconds ?? 0) * 1_000
      : 0;
    // Existing write/deadline checks use a strict `now > deadline` boundary.
    const at = scope.allowLateSubmission
      ? Math.max(deadline + grace + 1, minimumReady)
      : deadline + 1;
    if (Number.isFinite(at) && (!next || at < next.at)) next = { at, scope };
  }
  return next;
}

/** Read the persisted delivery wake-up; absence means no outbox work is scheduled. */
export async function getOutboxWakeup(storage: Pick<AlarmStorage, "get">): Promise<number | null> {
  const value = await storage.get<unknown>(OUTBOX_AT_KEY);
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Invalid stored outbox wake-up");
  return value;
}

/** Reconcile the single physical alarm from current attempt authority and delivery intent. Call under a local transaction. */
export async function reconcileAttemptAlarm(storage: AlarmStorage): Promise<void> {
  const state = await storage.get<StoredAttemptState>(STATE_KEY);
  const deadline = state ? (findAttemptDeadlineAlarm(state)?.at ?? null) : null;
  const delivery = await getOutboxWakeup(storage);
  const next = Math.min(deadline ?? Infinity, delivery ?? Infinity);
  if (!Number.isFinite(next)) await storage.deleteAlarm();
  else if ((await storage.getAlarm()) !== next) await storage.setAlarm(next);
}

/** Change only delivery intent, retaining the current deadline in the same local transaction. */
export async function setOutboxWakeup(storage: AlarmStorage, at: number | null): Promise<void> {
  if (at === null) await storage.delete(OUTBOX_AT_KEY);
  else await storage.put(OUTBOX_AT_KEY, at);
  await reconcileAttemptAlarm(storage);
}
