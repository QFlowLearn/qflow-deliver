import type { AttemptEventCommitResponse, AttemptEventEnvelope } from "@harbor/attempt-protocol";

export interface AttemptJournalEntry {
  event: AttemptEventEnvelope;
  queuedAt: string;
}

export interface AttemptJournalStore {
  read(attemptId: string): Promise<AttemptJournalEntry[]>;
  write(attemptId: string, entries: AttemptJournalEntry[]): Promise<void>;
}

export interface AttemptItemStateStore {
  read(attemptId: string): Promise<Record<string, unknown>>;
  write(attemptId: string, itemStates: Record<string, unknown>): Promise<void>;
}

export interface AttemptReplayReceiptRecord {
  receiptKey: string;
  attemptId: string;
  eventId: string;
  idempotencyKey: string;
  sequenceNumber: number;
  eventType: string;
  outcome: AttemptEventCommitResponse["outcome"];
  receiptId: string | null;
  serverTimestamp: string | null;
  highestCommittedSequence: number;
  confirmedAt: string;
  purgeAfter: string | null;
}

export interface AttemptReplayReceiptStore {
  list(attemptId: string): Promise<AttemptReplayReceiptRecord[]>;
  write(record: AttemptReplayReceiptRecord): Promise<void>;
  purgeExpired(now: string): Promise<number>;
}

export interface AttemptRecoveryMetadataRecord {
  attemptId: string;
  schemaVersion: number;
  pendingEventCount: number;
  highestCommittedSequence: number;
  lastQueueMutationAt: string;
  purgeAfter: string | null;
}

export interface AttemptRecoveryMetadataStore {
  read(attemptId: string): Promise<AttemptRecoveryMetadataRecord | null>;
  write(record: AttemptRecoveryMetadataRecord): Promise<void>;
  purgeExpired(now: string): Promise<number>;
}

export interface AttemptJournal {
  append(event: AttemptEventEnvelope): Promise<AttemptJournalEntry[]>;
  appendMany(events: AttemptEventEnvelope[]): Promise<AttemptJournalEntry[]>;
  list(attemptId: string): Promise<AttemptJournalEntry[]>;
  pruneCovered(input: {
    attemptId: string;
    highestCommittedSequence: number;
  }): Promise<AttemptJournalEntry[]>;
  replace(input: { attemptId: string; entries: AttemptJournalEntry[] }): Promise<void>;
}

export function createAttemptJournal(input: {
  store: AttemptJournalStore;
  now?: () => string;
}): AttemptJournal {
  const now = input.now ?? (() => new Date().toISOString());

  async function appendEvents(events: AttemptEventEnvelope[]): Promise<AttemptJournalEntry[]> {
    if (events.length === 0) {
      return [];
    }

    const attemptId = events[0]?.attemptId;
    if (!attemptId || events.some((event) => event.attemptId !== attemptId)) {
      throw new Error("Attempt journal batches must target one attempt.");
    }

    const entries = await readSortedEntries(input.store, attemptId);
    const existingKeys = new Set(entries.map((entry) => entry.event.idempotencyKey));
    const nextEventEntries = events
      .filter((event) => !existingKeys.has(event.idempotencyKey))
      .map((event) => ({
        event,
        queuedAt: now(),
      }));

    const nextEntries = sortEntries([...entries, ...nextEventEntries]);

    await input.store.write(attemptId, nextEntries);
    return nextEntries;
  }

  return {
    async append(event) {
      return appendEvents([event]);
    },

    async appendMany(events) {
      return appendEvents(events);
    },

    async list(attemptId) {
      return readSortedEntries(input.store, attemptId);
    },

    async pruneCovered({ attemptId, highestCommittedSequence }) {
      const entries = await readSortedEntries(input.store, attemptId);
      const nextEntries = entries.filter(
        (entry) => entry.event.sequenceNumber > highestCommittedSequence,
      );

      await input.store.write(attemptId, nextEntries);
      return nextEntries;
    },

    async replace({ attemptId, entries }) {
      await input.store.write(attemptId, sortEntries(entries));
    },
  };
}

export function createMemoryAttemptJournalStore(
  seed = new Map<string, AttemptJournalEntry[]>(),
): AttemptJournalStore {
  return {
    async read(attemptId) {
      return cloneEntries(seed.get(attemptId) ?? []);
    },

    async write(attemptId, entries) {
      seed.set(attemptId, cloneEntries(entries));
    },
  };
}

export function createMemoryAttemptReplayReceiptStore(
  seed = new Map<string, AttemptReplayReceiptRecord>(),
): AttemptReplayReceiptStore {
  return {
    async list(attemptId) {
      return sortReceiptRecords(
        [...seed.values()]
          .filter((record) => record.attemptId === attemptId)
          .map((record) => structuredClone(record)),
      );
    },

    async write(record) {
      seed.set(record.receiptKey, structuredClone(record));
    },

    async purgeExpired(now) {
      let deletedCount = 0;
      for (const [key, record] of seed.entries()) {
        if (record.purgeAfter && record.purgeAfter <= now) {
          seed.delete(key);
          deletedCount += 1;
        }
      }
      return deletedCount;
    },
  };
}

export function createBrowserAttemptJournalStore(
  storage: Storage = window.localStorage,
): AttemptJournalStore {
  return {
    async read(attemptId) {
      const raw = storage.getItem(storageKey(attemptId));
      if (!raw) {
        return [];
      }

      try {
        const parsed = JSON.parse(raw) as AttemptJournalEntry[];
        return cloneEntries(Array.isArray(parsed) ? parsed : []);
      } catch {
        storage.removeItem(storageKey(attemptId));
        return [];
      }
    },

    async write(attemptId, entries) {
      if (entries.length === 0) {
        storage.removeItem(storageKey(attemptId));
        return;
      }

      storage.setItem(storageKey(attemptId), JSON.stringify(entries));
    },
  };
}

export function createIndexedDbAttemptJournalStore(
  indexedDb: IDBFactory = window.indexedDB,
  legacyStorage: Storage | null = window.localStorage,
): AttemptJournalStore {
  const dbPromise = openAttemptRecoveryDatabase(indexedDb);

  return {
    async read(attemptId) {
      const record = await readIndexedDbRecord<AttemptJournalRecord>(
        dbPromise,
        ATTEMPT_JOURNAL_STORE,
        attemptId,
      );

      if (record) {
        return cloneEntries(record.entries);
      }

      const legacyEntries = readLegacyEntries(legacyStorage, attemptId);
      if (legacyEntries.length > 0) {
        await writeIndexedDbRecord(dbPromise, ATTEMPT_JOURNAL_STORE, {
          attemptId,
          entries: cloneForRecovery(legacyEntries),
        });
        legacyStorage?.removeItem(storageKey(attemptId));
      }

      return legacyEntries;
    },

    async write(attemptId, entries) {
      if (entries.length === 0) {
        await deleteIndexedDbRecord(dbPromise, ATTEMPT_JOURNAL_STORE, attemptId);
        legacyStorage?.removeItem(storageKey(attemptId));
        return;
      }

      await writeIndexedDbRecord(dbPromise, ATTEMPT_JOURNAL_STORE, {
        attemptId,
        entries: cloneForRecovery(entries),
      });
      legacyStorage?.removeItem(storageKey(attemptId));
    },
  };
}

export function createIndexedDbAttemptItemStateStore(
  indexedDb: IDBFactory = window.indexedDB,
): AttemptItemStateStore {
  const dbPromise = openAttemptRecoveryDatabase(indexedDb);
  const pendingWrites = new Map<string, Promise<void>>();

  return {
    async read(attemptId) {
      const pendingWrite = pendingWrites.get(attemptId);
      if (pendingWrite) {
        try {
          await pendingWrite;
        } catch {
          // Read the last durable snapshot when the newest write failed.
        }
      }

      const record = await readIndexedDbRecord<AttemptItemStateRecord>(
        dbPromise,
        ATTEMPT_ITEM_STATES_STORE,
        attemptId,
      );

      return record?.itemStates && typeof record.itemStates === "object"
        ? cloneForRecovery(record.itemStates)
        : {};
    },

    async write(attemptId, itemStates) {
      const snapshot = cloneForRecovery(itemStates);
      const previousWrite = pendingWrites.get(attemptId);
      const persistence = (async () => {
        if (previousWrite) {
          try {
            await previousWrite;
          } catch {
            // A failed checkpoint must not prevent a newer snapshot from being persisted.
          }
        }

        if (Object.keys(snapshot).length === 0) {
          await deleteIndexedDbRecord(dbPromise, ATTEMPT_ITEM_STATES_STORE, attemptId);
          return;
        }

        await writeIndexedDbRecord(dbPromise, ATTEMPT_ITEM_STATES_STORE, {
          attemptId,
          itemStates: snapshot,
        });
      })();
      pendingWrites.set(attemptId, persistence);

      return persistence.then(
        () => clearCompletedItemStateWrite(attemptId, persistence),
        (error: unknown) => {
          clearCompletedItemStateWrite(attemptId, persistence);
          throw error;
        },
      );
    },
  };

  function clearCompletedItemStateWrite(attemptId: string, persistence: Promise<void>): void {
    if (pendingWrites.get(attemptId) === persistence) {
      pendingWrites.delete(attemptId);
    }
  }
}

export function createIndexedDbAttemptReplayReceiptStore(
  indexedDb: IDBFactory = window.indexedDB,
): AttemptReplayReceiptStore {
  const dbPromise = openAttemptRecoveryDatabase(indexedDb);

  return {
    async list(attemptId) {
      return sortReceiptRecords(
        await readIndexedDbRecordsByIndex<AttemptReplayReceiptRecord>(
          dbPromise,
          ATTEMPT_REPLAY_RECEIPTS_STORE,
          ATTEMPT_ID_INDEX,
          attemptId,
        ),
      );
    },

    async write(record) {
      await writeIndexedDbRecord(
        dbPromise,
        ATTEMPT_REPLAY_RECEIPTS_STORE,
        cloneForRecovery(record),
      );
    },

    async purgeExpired(now) {
      return deleteExpiredIndexedDbRecords(
        dbPromise,
        ATTEMPT_REPLAY_RECEIPTS_STORE,
        PURGE_AFTER_INDEX,
        now,
      );
    },
  };
}

export function createIndexedDbAttemptRecoveryMetadataStore(
  indexedDb: IDBFactory = window.indexedDB,
): AttemptRecoveryMetadataStore {
  const dbPromise = openAttemptRecoveryDatabase(indexedDb);

  return {
    async read(attemptId) {
      return readIndexedDbRecord<AttemptRecoveryMetadataRecord>(
        dbPromise,
        ATTEMPT_METADATA_STORE,
        attemptId,
      );
    },

    async write(record) {
      await writeIndexedDbRecord(dbPromise, ATTEMPT_METADATA_STORE, cloneForRecovery(record));
    },

    async purgeExpired(now) {
      return deleteExpiredIndexedDbRecords(
        dbPromise,
        ATTEMPT_METADATA_STORE,
        PURGE_AFTER_INDEX,
        now,
      );
    },
  };
}

async function readSortedEntries(
  store: AttemptJournalStore,
  attemptId: string,
): Promise<AttemptJournalEntry[]> {
  return sortEntries(await store.read(attemptId));
}

function sortEntries(entries: AttemptJournalEntry[]): AttemptJournalEntry[] {
  return [...entries].sort((left, right) => {
    if (left.event.sequenceNumber !== right.event.sequenceNumber) {
      return left.event.sequenceNumber - right.event.sequenceNumber;
    }

    return left.queuedAt.localeCompare(right.queuedAt);
  });
}

function cloneEntries(entries: AttemptJournalEntry[]): AttemptJournalEntry[] {
  return entries.map((entry) => ({
    queuedAt: entry.queuedAt,
    event: structuredClone(entry.event),
  }));
}

function sortReceiptRecords(records: AttemptReplayReceiptRecord[]): AttemptReplayReceiptRecord[] {
  return [...records].sort((left, right) => {
    if (left.sequenceNumber !== right.sequenceNumber) {
      return left.sequenceNumber - right.sequenceNumber;
    }

    return left.confirmedAt.localeCompare(right.confirmedAt);
  });
}

function storageKey(attemptId: string): string {
  return `harbor.attemptJournal.${attemptId}`;
}

interface AttemptJournalRecord {
  attemptId: string;
  entries: AttemptJournalEntry[];
}

interface AttemptItemStateRecord {
  attemptId: string;
  itemStates: Record<string, unknown>;
}

const ATTEMPT_RECOVERY_DB_NAME = "harbor-attempt-recovery";
export const ATTEMPT_RECOVERY_SCHEMA_VERSION = 3;
const ATTEMPT_RECOVERY_DB_VERSION = ATTEMPT_RECOVERY_SCHEMA_VERSION;
const ATTEMPT_JOURNAL_STORE = "attempt-journal";
const ATTEMPT_ITEM_STATES_STORE = "item-states";
const ATTEMPT_REPLAY_RECEIPTS_STORE = "replay-receipts";
const ATTEMPT_METADATA_STORE = "attempt-metadata";
const ATTEMPT_ID_INDEX = "attemptId";
const PURGE_AFTER_INDEX = "purgeAfter";

function openAttemptRecoveryDatabase(indexedDb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(ATTEMPT_RECOVERY_DB_NAME, ATTEMPT_RECOVERY_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ATTEMPT_JOURNAL_STORE)) {
        db.createObjectStore(ATTEMPT_JOURNAL_STORE, { keyPath: "attemptId" });
      }
      if (!db.objectStoreNames.contains(ATTEMPT_ITEM_STATES_STORE)) {
        db.createObjectStore(ATTEMPT_ITEM_STATES_STORE, { keyPath: "attemptId" });
      }
      if (!db.objectStoreNames.contains(ATTEMPT_REPLAY_RECEIPTS_STORE)) {
        const store = db.createObjectStore(ATTEMPT_REPLAY_RECEIPTS_STORE, {
          keyPath: "receiptKey",
        });
        store.createIndex(ATTEMPT_ID_INDEX, "attemptId", { unique: false });
        store.createIndex(PURGE_AFTER_INDEX, "purgeAfter", { unique: false });
      }
      if (!db.objectStoreNames.contains(ATTEMPT_METADATA_STORE)) {
        const store = db.createObjectStore(ATTEMPT_METADATA_STORE, {
          keyPath: "attemptId",
        });
        store.createIndex(PURGE_AFTER_INDEX, "purgeAfter", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to open attempt recovery DB."));
    request.onblocked = () =>
      reject(new Error("Attempt recovery DB upgrade is blocked by another tab."));
  });
}

function readIndexedDbRecord<TRecord>(
  dbPromise: Promise<IDBDatabase>,
  storeName: string,
  key: string,
): Promise<TRecord | null> {
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get(key);
        request.onsuccess = () => resolve((request.result as TRecord) ?? null);
        request.onerror = () =>
          reject(request.error ?? new Error("Unable to read attempt recovery DB."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Attempt recovery read aborted."));
      }),
  );
}

function readIndexedDbRecordsByIndex<TRecord>(
  dbPromise: Promise<IDBDatabase>,
  storeName: string,
  indexName: string,
  key: string,
): Promise<TRecord[]> {
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).index(indexName).getAll(key);
        request.onsuccess = () => resolve(cloneForRecovery((request.result as TRecord[]) ?? []));
        request.onerror = () =>
          reject(request.error ?? new Error("Unable to read attempt recovery DB."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Attempt recovery read aborted."));
      }),
  );
}

function writeIndexedDbRecord<TRecord>(
  dbPromise: Promise<IDBDatabase>,
  storeName: string,
  record: TRecord,
): Promise<void> {
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(record);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Unable to write attempt recovery DB."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Attempt recovery write aborted."));
      }),
  );
}

function deleteIndexedDbRecord(
  dbPromise: Promise<IDBDatabase>,
  storeName: string,
  key: string,
): Promise<void> {
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Unable to prune attempt recovery DB."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Attempt recovery prune aborted."));
      }),
  );
}

function deleteExpiredIndexedDbRecords(
  dbPromise: Promise<IDBDatabase>,
  storeName: string,
  indexName: string,
  now: string,
): Promise<number> {
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        let deletedCount = 0;
        const transaction = db.transaction(storeName, "readwrite");
        const request = transaction
          .objectStore(storeName)
          .index(indexName)
          .openCursor(IDBKeyRange.upperBound(now));

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }

          if (typeof cursor.value?.purgeAfter === "string") {
            cursor.delete();
            deletedCount += 1;
          }
          cursor.continue();
        };
        request.onerror = () =>
          reject(request.error ?? new Error("Unable to purge attempt recovery DB."));
        transaction.oncomplete = () => resolve(deletedCount);
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Unable to purge attempt recovery DB."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Attempt recovery purge aborted."));
      }),
  );
}

function readLegacyEntries(storage: Storage | null, attemptId: string): AttemptJournalEntry[] {
  const raw = storage?.getItem(storageKey(attemptId));
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as AttemptJournalEntry[];
    return cloneEntries(Array.isArray(parsed) ? parsed : []);
  } catch {
    storage?.removeItem(storageKey(attemptId));
    return [];
  }
}

function cloneForRecovery<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue) =>
      nestedValue instanceof Map
        ? {
            __harborMap: true,
            entries: [...nestedValue.entries()],
          }
        : nestedValue,
    ),
    (_key, nestedValue) => {
      if (
        nestedValue &&
        typeof nestedValue === "object" &&
        "__harborMap" in nestedValue &&
        Array.isArray((nestedValue as { entries?: unknown }).entries)
      ) {
        return new Map((nestedValue as { entries: Array<[string, unknown]> }).entries);
      }

      return nestedValue;
    },
  ) as T;
}
