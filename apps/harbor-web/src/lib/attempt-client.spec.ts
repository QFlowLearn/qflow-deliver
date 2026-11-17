import { expect, it } from "vitest";
import type { AuthoritativeAttemptSessionState } from "@harbor/attempt-protocol";
import { AttemptClientRequestError, createAttemptClient } from "./attempt-client";
import { createAttemptJournal, createMemoryAttemptJournalStore } from "./attempt-journal";

const initialSession: AuthoritativeAttemptSessionState = {
  currentItemRef: { itemId: "one", itemHref: "items/one.xml" },
  sequence: { lastAcceptedSequence: null, nextSequence: 1 },
  attemptStatus: "active",
  timing: {
    startedAt: null,
    expiresAt: null,
    softCloseAt: null,
    acceptUntil: null,
    remainingTimeSeconds: null,
  },
  deliveryPreferences: { keywordTranslationLanguage: null },
};

it("publishes Finish intent only after the final batch is durable and before transport starts", async () => {
  const journal = createAttemptJournal({ store: createMemoryAttemptJournalStore() });
  let notified = false;
  const client = createAttemptClient({
    attemptId: "attempt",
    clientSessionId: "session",
    initialSession,
    journal,
    onEventsJournaled(events) {
      expect(events.map((event) => event.type)).toEqual(["response.changed", "submit.requested"]);
      notified = true;
    },
    transport: {
      async commit() {
        expect(notified).toBe(true);
        expect((await journal.list("attempt")).map(({ event }) => event.type)).toEqual([
          "response.changed",
          "submit.requested",
        ]);
        throw new Error("Network disconnected");
      },
    },
  });
  await expect(
    client.queueAndSendBatch([
      {
        type: "response.changed",
        payload: { responseKey: "one", responseState: { value: "final" } },
      },
      { type: "submit.requested", payload: { requestedAt: "2026-11-01T12:00:00Z" } },
    ]),
  ).rejects.toThrow("Network disconnected");
  expect(notified).toBe(true);
});

it("does not announce saved Finish when local persistence fails", async () => {
  const journal = createAttemptJournal({
    store: {
      async read() {
        return [];
      },
      async write() {
        throw new Error("Local storage unavailable");
      },
    },
  });
  let notified = false;
  let sent = false;
  const client = createAttemptClient({
    attemptId: "attempt",
    clientSessionId: "session",
    initialSession,
    journal,
    onEventsJournaled() {
      notified = true;
    },
    transport: {
      async commit() {
        sent = true;
        throw new Error("Unexpected send");
      },
    },
  });
  await expect(
    client.queueAndSendBatch([
      { type: "submit.requested", payload: { requestedAt: "2026-11-01T12:00:00Z" } },
    ]),
  ).rejects.toThrow("Local storage unavailable");
  expect(notified).toBe(false);
  expect(sent).toBe(false);
});

it("retains the same Finish intent when an authoritative policy rejection requires supervision", async () => {
  const journal = createAttemptJournal({ store: createMemoryAttemptJournalStore() });
  const client = createAttemptClient({
    attemptId: "attempt",
    clientSessionId: "session",
    initialSession,
    journal,
    transport: {
      async commit() {
        throw new AttemptClientRequestError("Minimum time has not elapsed", 409, {
          highestCommittedSequence: 0,
          nextSequenceNumber: 1,
          deliveryPreferences: { keywordTranslationLanguage: null },
        });
      },
    },
  });
  await expect(
    client.queueAndSend({
      type: "submit.requested",
      eventId: "frozen-finish",
      idempotencyKey: "frozen-key",
      payload: { requestedAt: "2026-11-01T12:00:00Z" },
    }),
  ).rejects.toThrow("Minimum time has not elapsed");
  expect(await journal.list("attempt")).toMatchObject([
    { event: { type: "submit.requested", eventId: "frozen-finish", idempotencyKey: "frozen-key" } },
  ]);
});
