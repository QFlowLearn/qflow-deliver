import type { StoredAttemptState } from "./attempt-state-bootstrap";
import { renderTimingState } from "./attempt-timing";

/** Candidate timing exposes only scopes already visited in a sequenced assessment. */
export function renderAttemptClientTiming(
  state: Pick<StoredAttemptState, "timing" | "scopedTiming" | "testSequence">,
  at?: string,
) {
  const timing = renderTimingState(state.timing, at, state.scopedTiming);
  return state.testSequence
    ? { ...timing, scopes: timing.scopes?.filter((scope) => scope.status !== "initial") }
    : timing;
}
