import {
  parseCandidateResponseCheckpoint,
  projectCandidateItemState,
  type CandidateResponseCheckpoint,
} from "@harbor/attempt-protocol";
import type { AttemptJournalEntry } from "../attempt-journal";

/** Restore the accepted baseline, retaining newer local response events for ordinary journal replay. */
export function recoverResponseStates(input: {
  readonly checkpoint: CandidateResponseCheckpoint | undefined;
  readonly localStates: Record<string, unknown>;
  readonly pending: readonly AttemptJournalEntry[];
  readonly clientSessionId: string;
}): { readonly states: Record<string, unknown>; readonly conflicts: readonly string[] } {
  const checkpoint = parseCandidateResponseCheckpoint(input.checkpoint);
  if (input.checkpoint !== undefined && !checkpoint)
    throw new Error("Invalid server response checkpoint");
  const states: Record<string, unknown> = { ...checkpoint?.items };
  const pendingItems = new Set<string>();
  for (const { event } of input.pending) {
    if (
      event.type !== "response.changed" ||
      !("responseState" in event.payload) ||
      event.clientSessionId !== input.clientSessionId ||
      event.sequenceNumber <= (checkpoint?.acceptedSequenceNumber ?? 0)
    )
      continue;
    const value = event.payload.responseState;
    const state = projectCandidateItemState(
      value && typeof value === "object" && "itemState" in value ? value.itemState : null,
    );
    if (!state) continue;
    states[event.itemRef.itemId] = state;
    pendingItems.add(event.itemRef.itemId);
  }
  const conflicts: string[] = [];
  for (const [itemId, local] of Object.entries(input.localStates)) {
    if (pendingItems.has(itemId)) continue;
    const accepted = checkpoint?.items[itemId];
    if (!accepted) {
      states[itemId] = local;
      continue;
    }
    const localState = projectCandidateItemState(local);
    if (localState && JSON.stringify(localState.responses) !== JSON.stringify(accepted.responses))
      conflicts.push(itemId);
  }
  return { states, conflicts };
}
