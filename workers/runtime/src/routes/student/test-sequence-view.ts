import type { CurrentItemRef } from "@harbor/attempt-protocol";
import { ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER } from "../../attempts/attempt-durable-object";
import { LaunchRequestError } from "../../launch/create-preview-attempt";

/** Candidate-safe progress, read from the attempt authority rather than a D1 projection. */
export interface TestSequenceView {
  readonly currentItemRef: CurrentItemRef;
  readonly answered: number;
  readonly target: number;
  readonly status: string;
}

/** Load the current test frontier without revealing future branches or scores. */
export async function readTestSequenceView(
  coordinator: DurableObjectNamespace,
  attemptId: string,
): Promise<TestSequenceView> {
  const response = await coordinator
    .get(coordinator.idFromName(attemptId))
    .fetch("https://harbor-attempt.local/test-sequence", {
      headers: { [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: attemptId },
    });
  const value: unknown = await response.json();
  if (
    !response.ok ||
    typeof value !== "object" ||
    value === null ||
    !("currentItemRef" in value) ||
    !("answered" in value) ||
    !("target" in value) ||
    !("status" in value) ||
    typeof value.answered !== "number" ||
    typeof value.target !== "number" ||
    typeof value.status !== "string"
  )
    throw new LaunchRequestError(409, "Assessment progress is unavailable");
  const ref = value.currentItemRef;
  if (
    typeof ref !== "object" ||
    ref === null ||
    !("itemId" in ref) ||
    !("itemHref" in ref) ||
    typeof ref.itemId !== "string" ||
    typeof ref.itemHref !== "string"
  )
    throw new LaunchRequestError(409, "Current question is unavailable");
  return {
    currentItemRef: { itemId: ref.itemId, itemHref: ref.itemHref },
    answered: value.answered,
    target: value.target,
    status: value.status,
  };
}
