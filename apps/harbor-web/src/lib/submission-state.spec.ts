import { expect, it } from "vitest";
import type { AttemptJournalEntry, AttemptReplayReceiptRecord } from "./attempt-journal";
import { recoverSubmissionState } from "./submission-state";

const finish: AttemptJournalEntry = {
  queuedAt: "2026-11-01T12:00:00.000Z",
  event: {
    attemptId: "attempt",
    eventId: "finish",
    idempotencyKey: "finish",
    sequenceNumber: 2,
    clientTimestamp: "2026-11-01T12:00:00.000Z",
    clientMonotonicElapsedTimeMs: 0,
    clientSessionId: "session",
    itemRef: { itemId: "one", itemHref: "one.xml" },
    type: "submit.requested",
    payload: { requestedAt: "2026-11-01T12:00:00.000Z" },
  },
};
const receipt: AttemptReplayReceiptRecord = {
  receiptKey: "attempt:finish",
  attemptId: "attempt",
  eventId: "finish",
  idempotencyKey: "finish",
  sequenceNumber: 2,
  eventType: "submit.requested",
  outcome: "accepted",
  receiptId: "original-receipt",
  serverTimestamp: "2026-11-01T12:00:01.000Z",
  highestCommittedSequence: 2,
  confirmedAt: "2026-11-01T12:00:02.000Z",
  purgeAfter: null,
};

it("restores a pending Finish lock without pretending the server accepted it", () => {
  expect(recoverSubmissionState([finish], [], null)).toEqual({ status: "pending" });
});
it("keeps confirmation after accepted Finish has been pruned from the journal", () => {
  expect(recoverSubmissionState([], [receipt], null)).toEqual({
    status: "confirmed",
    receiptId: "original-receipt",
  });
});
it("requires supervision for preserved final responses followed by a sequence gap", () => {
  expect(
    recoverSubmissionState(
      [finish],
      [
        {
          ...receipt,
          eventType: "response.changed",
          sequenceNumber: 1,
          outcome: "late_preserved",
          receiptId: null,
        },
        { ...receipt, outcome: "gap", receiptId: null },
      ],
      null,
    ),
  ).toEqual({ status: "review_required" });
});
it("does not confuse late preservation with submission acceptance", () => {
  expect(
    recoverSubmissionState(
      [finish],
      [{ ...receipt, outcome: "late_preserved", receiptId: null }],
      null,
    ),
  ).toEqual({ status: "review_required" });
});
it("allows an explicitly reopened attempt after an earlier confirmed Finish", () => {
  expect(recoverSubmissionState([], [receipt], "2026-11-01T12:05:00.000Z")).toEqual({
    status: "none",
  });
});
it("a reopen does not silently cancel still-pending final intent", () => {
  expect(recoverSubmissionState([finish], [], "2026-11-01T12:05:00.000Z")).toEqual({
    status: "pending",
  });
});
