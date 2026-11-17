import { projectCandidateItemState, type AttemptEventEnvelope } from "@harbor/attempt-protocol";
import type { StoredAttemptState } from "./attempt-state-bootstrap";

/** Retain candidate work for response saves and explicit sequenced answer submissions alike. */
export function withAcceptedResponseCheckpoint(
  state: StoredAttemptState,
  event: AttemptEventEnvelope,
  serverTimestamp: string,
):
  | { readonly ok: true; readonly state: StoredAttemptState }
  | { readonly ok: false; readonly status: 400 | 409; readonly message: string } {
  if (
    (event.type !== "response.changed" && event.type !== "item.submit-requested") ||
    !("responseState" in event.payload)
  )
    return { ok: true, state };
  const value = event.payload.responseState;
  const candidate = projectCandidateItemState(
    value && typeof value === "object" && "itemState" in value ? value.itemState : null,
  );
  if (!candidate)
    return "intent" in event.payload && event.payload.intent === "checkpoint"
      ? { ok: false, status: 400, message: "Autosave requires a resumable QTI response checkpoint" }
      : { ok: true, state };
  const expectedIdentifier = state.manifestItems[event.itemRef.itemId]?.itemIdentifier;
  if (expectedIdentifier && expectedIdentifier !== candidate.itemIdentifier)
    return {
      ok: false,
      status: 409,
      message: "Response checkpoint does not match the delivered question",
    };
  return {
    ok: true,
    state: {
      ...state,
      responseCheckpoint: {
        acceptedSequenceNumber: event.sequenceNumber,
        serverTimestamp,
        items: { ...state.responseCheckpoint?.items, [event.itemRef.itemId]: candidate },
      },
    },
  };
}
