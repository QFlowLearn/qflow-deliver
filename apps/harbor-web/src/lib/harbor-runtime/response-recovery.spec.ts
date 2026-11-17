import { describe, expect, it } from "vitest";
import { projectCandidateItemState } from "@harbor/attempt-protocol";
import { recoverResponseStates } from "./response-recovery";

const accepted = projectCandidateItemState({
  schema: "qti3.attempt-state.v1",
  itemIdentifier: "question",
  status: "suspended",
  responses: { RESPONSE: "B" },
  outcomes: { SCORE: 1 },
  validationMessages: [],
});
if (!accepted) throw new Error("Invalid test state");
const checkpoint = {
  acceptedSequenceNumber: 3,
  serverTimestamp: "2026-11-01T12:00:00Z",
  items: { question: accepted },
};

describe("accepted response restoration", () => {
  it("restores a clean workstation without processing outcomes", () => {
    expect(
      recoverResponseStates({ checkpoint, localStates: {}, pending: [], clientSessionId: "b" }),
    ).toEqual({ states: { question: accepted }, conflicts: [] });
    expect(accepted.outcomes).toEqual({});
  });
  it("preserves a newer local journal response instead of replacing it with the accepted baseline", () => {
    const pendingState = { ...accepted, responses: { RESPONSE: "C" } };
    const result = recoverResponseStates({
      checkpoint,
      localStates: { question: pendingState },
      clientSessionId: "a",
      pending: [
        {
          queuedAt: "2026-11-01T12:01:00Z",
          event: {
            attemptId: "attempt",
            eventId: "event",
            idempotencyKey: "key",
            clientSessionId: "a",
            sequenceNumber: 4,
            clientTimestamp: "2026-11-01T12:01:00Z",
            itemRef: { itemId: "question", itemHref: "question.xml" },
            type: "response.changed",
            payload: { responseKey: "question", responseState: { itemState: pendingState } },
          },
        },
      ],
    });
    expect(result.states.question).toMatchObject({ responses: { RESPONSE: "C" } });
    expect(result.conflicts).toEqual([]);
  });
  it("identifies an unjournaled conflict without mutating the local copy", () => {
    const local = { ...accepted, responses: { RESPONSE: "C" } };
    const states = { question: local };
    const result = recoverResponseStates({
      checkpoint,
      localStates: states,
      pending: [],
      clientSessionId: "a",
    });
    expect(result.conflicts).toEqual(["question"]);
    expect(states.question.responses).toEqual({ RESPONSE: "C" });
    expect(result.states.question).toMatchObject({ responses: { RESPONSE: "B" } });
  });
});
