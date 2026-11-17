import type { AttemptJournalEntry, AttemptReplayReceiptRecord } from "./attempt-journal";

/** Local Finish intent is separate from the server's authoritative attempt status. */
export type SubmissionState =
  | { readonly status: "none" }
  | { readonly status: "pending" }
  | { readonly status: "confirmed"; readonly receiptId: string }
  | { readonly status: "review_required" };

export function isSubmissionEvent(type: string): boolean {
  return type === "submit.requested" || type === "timing.auto-submit.requested";
}

/** Journal and durable receipts retain the lock even when the cached bootstrap is older. */
export function recoverSubmissionState(
  pending: readonly AttemptJournalEntry[],
  receipts: readonly AttemptReplayReceiptRecord[],
  reopenedAt: string | null,
): SubmissionState {
  const finalIntent = pending.find(({ event }) => isSubmissionEvent(event.type));
  // A late-preserved final response is evidence, not accepted exam work. Its
  // following Finish may report a sequence gap because preservation advances no sequence.
  if (
    finalIntent &&
    receipts.some(
      (receipt) =>
        receipt.eventType === "response.changed" &&
        receipt.sequenceNumber === finalIntent.event.sequenceNumber - 1 &&
        receipt.outcome === "late_preserved",
    )
  )
    return { status: "review_required" };
  const receipt = receipts
    .filter(
      (entry) =>
        isSubmissionEvent(entry.eventType) &&
        (!reopenedAt || !entry.serverTimestamp || entry.serverTimestamp >= reopenedAt),
    )
    .sort((a, b) => b.sequenceNumber - a.sequenceNumber)[0];
  if (receipt) {
    if ((receipt.outcome === "accepted" || receipt.outcome === "duplicate") && receipt.receiptId)
      return { status: "confirmed", receiptId: receipt.receiptId };
    if (receipt.outcome !== "gap") return { status: "review_required" };
  }
  return finalIntent ? { status: "pending" } : { status: "none" };
}
