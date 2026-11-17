import {
  createAttemptJournal,
  createIndexedDbAttemptItemStateStore,
  createIndexedDbAttemptJournalStore,
  createIndexedDbAttemptRecoveryMetadataStore,
  createIndexedDbAttemptReplayReceiptStore,
} from "../attempt-journal";

export const attemptJournal = createAttemptJournal({
  store: createIndexedDbAttemptJournalStore(),
});
export const attemptItemStateStore = createIndexedDbAttemptItemStateStore();
export const attemptReplayReceiptStore = createIndexedDbAttemptReplayReceiptStore();
export const attemptRecoveryMetadataStore = createIndexedDbAttemptRecoveryMetadataStore();
