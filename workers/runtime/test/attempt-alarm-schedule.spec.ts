import { describe, expect, it } from "vitest";
import { findAttemptDeadlineAlarm } from "../src/attempts/attempt-alarm-schedule";
import type { StoredAttemptState } from "../src/attempts/attempt-state-bootstrap";
import type { StoredTimingScope } from "../src/attempts/attempt-timing";

const start = Date.parse("2030-01-01T00:00:00.000Z");
function scope(patch: Partial<StoredTimingScope> = {}): StoredTimingScope {
  return {
    key: "test",
    scopeType: "assessment-test",
    identifier: "test",
    itemId: null,
    status: "interacting",
    enteredAt: new Date(start).toISOString(),
    exitedAt: null,
    activeSince: new Date(start).toISOString(),
    elapsedMilliseconds: 0,
    minTimeSeconds: null,
    maxTimeSeconds: 10,
    allowLateSubmission: true,
    deadlineAt: new Date(start + 10_000).toISOString(),
    unlimited: false,
    ...patch,
  };
}
function state(
  scopes: StoredTimingScope[],
  grace = 0,
): Pick<StoredAttemptState, "attemptStatus" | "scopedTiming" | "timing" | "deliveryPolicy"> {
  return {
    attemptStatus: "active",
    scopedTiming: { policyVersion: 0, scopes },
    timing: {
      startedAt: new Date(start).toISOString(),
      softCloseAt: new Date(start + 10_000).toISOString(),
      expiresAt: new Date(start + 10_000).toISOString(),
      acceptUntil: new Date(start + 10_000 + grace * 1_000).toISOString(),
      remainingTimeSeconds: 10,
    },
    deliveryPolicy: {
      launchMode: "preview",
      navigationMode: "linear",
      maxAttempts: 1,
      timeLimitSeconds: 10,
      gracePeriodSeconds: grace,
    },
  };
}

describe("next automatic submission alarm", () => {
  it("respects grace for a soft deadline", () => {
    expect(findAttemptDeadlineAlarm(state([scope()], 30))?.at).toBe(start + 40_001);
  });
  it("waits for minimum time on a soft deadline", () => {
    expect(findAttemptDeadlineAlarm(state([scope({ minTimeSeconds: 60 })]))?.at).toBe(
      start + 60_000,
    );
  });
  it("lets a hard maximum override minimum time and selects that exact scope", () => {
    const hard = scope({
      key: "hard-item",
      scopeType: "item-session",
      allowLateSubmission: false,
      deadlineAt: new Date(start + 20_000).toISOString(),
    });
    expect(findAttemptDeadlineAlarm(state([scope({ minTimeSeconds: 60 }), hard], 30))).toEqual({
      at: start + 20_001,
      scope: hard,
    });
  });
  it("does not repeatedly wake for a paused minimum that cannot accrue", () => {
    expect(
      findAttemptDeadlineAlarm(
        state([scope({ status: "suspended", activeSince: null, minTimeSeconds: 60 })]),
      ),
    ).toBeNull();
  });
  it("ignores closed, initial and unlimited scopes", () => {
    expect(
      findAttemptDeadlineAlarm(
        state([
          scope({ status: "closed" }),
          scope({ status: "initial" }),
          scope({ unlimited: true }),
        ]),
      ),
    ).toBeNull();
  });
  it("cancels deadline work after submission", () => {
    expect(
      findAttemptDeadlineAlarm({ ...state([scope()]), attemptStatus: "submitted" }),
    ).toBeNull();
  });
});
