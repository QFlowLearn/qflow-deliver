import { isQtiAttemptStateV1, type QtiAttemptStateV1 } from "@longsightgroup/qti3-core";

/** Candidate-owned resumable work at a server-accepted response frontier. */
export interface CandidateResponseCheckpoint {
  readonly acceptedSequenceNumber: number;
  readonly serverTimestamp: string;
  readonly items: Readonly<Record<string, QtiAttemptStateV1>>;
}

/** Exclude processing results and diagnostics while retaining the candidate's generated presentation. */
export function projectCandidateItemState(value: unknown): QtiAttemptStateV1 | null {
  if (!isQtiAttemptStateV1(value)) return null;
  return {
    schema: "qti3.attempt-state.v1",
    itemIdentifier: value.itemIdentifier,
    status: "suspended",
    responses: structuredClone(value.responses),
    outcomes: {},
    validationMessages: [],
    ...(value.templateProcessing
      ? { templateProcessing: structuredClone(value.templateProcessing) }
      : {}),
    ...(value.templateValues ? { templateValues: structuredClone(value.templateValues) } : {}),
    ...(value.presentation ? { presentation: structuredClone(value.presentation) } : {}),
    ...(value.interactionStates
      ? { interactionStates: structuredClone(value.interactionStates) }
      : {}),
  };
}

/** Parse a received checkpoint; callers distinguish absence from a malformed supplied checkpoint. */
export function parseCandidateResponseCheckpoint(
  value: unknown,
): CandidateResponseCheckpoint | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("acceptedSequenceNumber" in value) ||
    typeof value.acceptedSequenceNumber !== "number" ||
    !Number.isSafeInteger(value.acceptedSequenceNumber) ||
    value.acceptedSequenceNumber < 1 ||
    !("serverTimestamp" in value) ||
    typeof value.serverTimestamp !== "string" ||
    !Number.isFinite(Date.parse(value.serverTimestamp)) ||
    !("items" in value) ||
    !value.items ||
    typeof value.items !== "object" ||
    Array.isArray(value.items)
  )
    return null;
  const items: Record<string, QtiAttemptStateV1> = {};
  for (const [itemId, state] of Object.entries(value.items)) {
    const parsed = projectCandidateItemState(state);
    if (!itemId || !parsed) return null;
    items[itemId] = parsed;
  }
  return {
    acceptedSequenceNumber: value.acceptedSequenceNumber,
    serverTimestamp: value.serverTimestamp,
    items,
  };
}
