import type { AuthoritativeAttemptSessionState } from "@harbor/attempt-protocol";

export type DeliveryTimingState = AuthoritativeAttemptSessionState["timing"];
export type DeliveryTimingScope = NonNullable<DeliveryTimingState["scopes"]>[number];

export function projectTimingForDisplay(
  timing: DeliveryTimingState,
  nowMs: number,
  observedAtMs: number,
): DeliveryTimingState {
  const scopes = timing.scopes?.map((scope) => projectTimingScope(scope, nowMs, observedAtMs));
  const softDeadline = timing.softCloseAt ?? timing.expiresAt;
  const currentItemDurationSeconds =
    scopes?.find((scope) => scope.scopeType === "item-session" && scope.status === "interacting")
      ?.elapsedTimeSeconds ??
    scopes?.find(
      (scope) => scope.scopeType === "assessment-item-ref" && scope.status === "interacting",
    )?.elapsedTimeSeconds ??
    timing.currentItemDurationSeconds ??
    null;

  return {
    ...timing,
    remainingTimeSeconds: softDeadline
      ? Math.max(0, Math.ceil((Date.parse(softDeadline) - nowMs) / 1000))
      : null,
    currentItemDurationSeconds,
    ...(scopes ? { scopes } : {}),
  };
}

function projectTimingScope(
  scope: DeliveryTimingScope,
  nowMs: number,
  observedAtMs: number,
): DeliveryTimingScope {
  if (scope.status !== "interacting") {
    return scope;
  }

  const elapsedTimeSeconds =
    Math.trunc(Math.max(0, (scope.elapsedTimeSeconds + (nowMs - observedAtMs) / 1000) * 10)) / 10;

  return {
    ...scope,
    elapsedTimeSeconds,
  };
}

export function findActiveDeadlineScope(timing: DeliveryTimingState): DeliveryTimingScope | null {
  const scopes = timing.scopes ?? [];
  const activeScopes = scopes
    .filter((scope) => scope.status === "interacting" && scope.deadlineAt && !scope.unlimited)
    .sort((left, right) => Date.parse(left.deadlineAt ?? "") - Date.parse(right.deadlineAt ?? ""));

  return activeScopes[0] ?? null;
}
