import type {
  AttemptDeliveryPreferences,
  AttemptClientSyncTrace,
  AttemptEventCommitResponse,
  AttemptEventEnvelope,
  AttemptEventPayloadByType,
  AttemptEventType,
  AuthoritativeAttemptSessionState,
  CurrentItemRef,
} from "@harbor/attempt-protocol";
import { applyOptimisticDeliveryPreferences } from "@harbor/attempt-protocol";
import { isSubmissionEvent } from "./submission-state";

import type {
  AttemptJournal,
  AttemptReplayReceiptRecord,
  AttemptReplayReceiptStore,
} from "./attempt-journal";

export interface AttemptClientTransport {
  /** Honor cancellation through the provided signal, including response-body reads. */
  commit(
    event: AttemptEventEnvelope,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AttemptEventCommitResponse>;
}

export interface AttemptClientState {
  currentItemRef: CurrentItemRef;
  nextSequenceNumber: number;
  highestCommittedSequence: number;
  attemptStatus: AuthoritativeAttemptSessionState["attemptStatus"];
  timing: AuthoritativeAttemptSessionState["timing"];
  deliveryPreferences: AttemptDeliveryPreferences;
}

/** Authoritative sequence and preference fields returned with a rejected attempt command. */
export interface AttemptClientAuthoritativeRejection {
  readonly highestCommittedSequence: number;
  readonly nextSequenceNumber: number;
  readonly deliveryPreferences: AttemptDeliveryPreferences;
}

export interface QueueAttemptEventInput<TType extends AttemptEventType> {
  type: TType;
  payload: AttemptEventPayloadByType[TType];
  itemRef?: CurrentItemRef;
  eventId?: string;
  idempotencyKey?: string;
  clientTimestamp?: string;
}

export type QueueAttemptEventBatchInput = {
  [TType in AttemptEventType]: QueueAttemptEventInput<TType>;
}[AttemptEventType];

export interface AttemptClient {
  getState(): AttemptClientState;
  applyAuthoritativeSession(session: AuthoritativeAttemptSessionState): Promise<void>;
  queueAndSend<TType extends AttemptEventType>(
    input: QueueAttemptEventInput<TType>,
  ): Promise<AttemptEventCommitResponse>;
  queueAndSendBatch(input: QueueAttemptEventBatchInput[]): Promise<AttemptEventCommitResponse[]>;
  replayPending(): Promise<AttemptEventCommitResponse[]>;
  /**
   * Interrupt only the unconfirmed transport; durable events/receipts remain available for replay.
   * The interrupted command rejects with AttemptClientSendInterruptedError.
   */
  interruptPendingSend(): void;
}

/** Expected transport interruption when recovery replaces a request on the previous connection. */
export class AttemptClientSendInterruptedError extends Error {
  readonly _tag = "AttemptClientSendInterrupted";

  constructor() {
    super("The connection changed. Saved work is awaiting replay.");
  }
}

/** HTTP transport failure with optional authoritative state for terminal reconciliation. */
export class AttemptClientRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly authoritativeState: AttemptClientAuthoritativeRejection | null = null,
  ) {
    super(message);
  }
}

export function createAttemptClient(input: {
  attemptId: string;
  clientSessionId: string;
  initialSession: AuthoritativeAttemptSessionState;
  journal: AttemptJournal;
  receiptStore?: AttemptReplayReceiptStore;
  transport: AttemptClientTransport;
  createId?: () => string;
  now?: () => string;
  receiptRetentionMs?: number;
  onEventsJournaled?(events: readonly AttemptEventEnvelope[]): void;
}): AttemptClient {
  const createId = input.createId ?? defaultIdFactory;
  const now = input.now ?? (() => new Date().toISOString());
  const receiptRetentionMs = input.receiptRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
  let state = stateFromSession(input.initialSession);
  let operationTail: Promise<void> | null = null;
  let pendingSend: AbortController | null = null;

  function runSerially<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = operationTail ? operationTail.then(operation, operation) : operation();
    const clearTail = () => {
      if (operationTail === nextTail) operationTail = null;
    };
    const nextTail = result.then(clearTail, clearTail);
    operationTail = nextTail;
    return result;
  }

  async function readQueueSequenceNumber(): Promise<number> {
    const pending = await input.journal.list(input.attemptId);
    return pending.reduce(
      (next, entry) => Math.max(next, entry.event.sequenceNumber + 1),
      state.nextSequenceNumber,
    );
  }

  async function commitQueuedEvent(
    event: AttemptEventEnvelope,
  ): Promise<AttemptEventCommitResponse> {
    // The client owns one transport lifetime at a time. Recovery can replace a
    // stalled send without waiting for the old connection or changing event identity.
    const controller = new AbortController();
    pendingSend = controller;
    try {
      return await input.transport.commit(event, { signal: controller.signal });
    } catch (cause: unknown) {
      if (controller.signal.aborted) throw new AttemptClientSendInterruptedError();
      if (
        cause instanceof AttemptClientRequestError &&
        cause.status === 409 &&
        cause.authoritativeState
      ) {
        state = {
          ...state,
          highestCommittedSequence: cause.authoritativeState.highestCommittedSequence,
          nextSequenceNumber: cause.authoritativeState.nextSequenceNumber,
          deliveryPreferences: cause.authoritativeState.deliveryPreferences,
        };
        // Finish remains final locally when a policy command rejects it. Retry the
        // same intent after supervision; never silently reopen editing on a 409.
        if (!isSubmissionEvent(event.type))
          await pruneEventByIdempotencyKey({
            journal: input.journal,
            attemptId: input.attemptId,
            event,
          });
      }
      throw cause;
    } finally {
      if (pendingSend === controller) pendingSend = null;
    }
  }

  return {
    interruptPendingSend() {
      pendingSend?.abort();
    },
    getState() {
      return {
        currentItemRef: state.currentItemRef,
        nextSequenceNumber: state.nextSequenceNumber,
        highestCommittedSequence: state.highestCommittedSequence,
        attemptStatus: state.attemptStatus,
        timing: state.timing,
        deliveryPreferences: state.deliveryPreferences,
      };
    },

    async applyAuthoritativeSession(session) {
      state = stateFromSession(session);
    },

    queueAndSend(eventInput) {
      return runSerially(async () => {
        const stateBeforeQueue = state;
        state = applyOptimisticEvent(state, eventInput);
        let sequenceNumber: number;
        try {
          sequenceNumber = await readQueueSequenceNumber();
        } catch (cause: unknown) {
          state = stateBeforeQueue;
          throw cause;
        }
        const event = buildAttemptEvent({
          attemptId: input.attemptId,
          clientSessionId: input.clientSessionId,
          currentItemRef: eventInput.itemRef ?? state.currentItemRef,
          sequenceNumber,
          type: eventInput.type,
          payload: eventInput.payload,
          eventId: eventInput.eventId ?? createId(),
          idempotencyKey: eventInput.idempotencyKey ?? createId(),
          clientTimestamp: eventInput.clientTimestamp ?? now(),
        });

        let entries: Awaited<ReturnType<AttemptJournal["append"]>>;
        try {
          entries = await input.journal.append(event);
        } catch (cause: unknown) {
          state = stateBeforeQueue;
          throw cause;
        }
        input.onEventsJournaled?.([event]);
        const response = await commitQueuedEvent(
          withSyncTrace({
            event,
            queuedAt:
              entries.find((entry) => entry.event.idempotencyKey === event.idempotencyKey)
                ?.queuedAt ?? event.clientTimestamp,
            sendReason: "initial",
            queueDepthAtSend: entries.length,
            replayAttempt: 0,
            sentAt: now(),
          }),
        );
        await applyCommitResponse({
          journal: input.journal,
          receiptStore: input.receiptStore,
          attemptId: input.attemptId,
          event,
          response,
          now,
          receiptRetentionMs,
          updateState(nextState) {
            state = nextState;
          },
        });

        return response;
      });
    },

    queueAndSendBatch(eventInputs) {
      return runSerially(async () => {
        const stateBeforeQueue = state;
        for (const eventInput of eventInputs) state = applyOptimisticEvent(state, eventInput);
        let sequenceNumber: number;
        try {
          sequenceNumber = await readQueueSequenceNumber();
        } catch (cause: unknown) {
          state = stateBeforeQueue;
          throw cause;
        }
        const events = eventInputs.map((eventInput, index) =>
          buildAttemptEvent({
            attemptId: input.attemptId,
            clientSessionId: input.clientSessionId,
            currentItemRef: eventInput.itemRef ?? state.currentItemRef,
            sequenceNumber: sequenceNumber + index,
            type: eventInput.type,
            payload: eventInput.payload,
            eventId: eventInput.eventId ?? createId(),
            idempotencyKey: eventInput.idempotencyKey ?? createId(),
            clientTimestamp: eventInput.clientTimestamp ?? now(),
          }),
        );

        let queuedEntries: Awaited<ReturnType<AttemptJournal["appendMany"]>>;
        try {
          queuedEntries = await input.journal.appendMany(events);
        } catch (cause: unknown) {
          state = stateBeforeQueue;
          throw cause;
        }

        input.onEventsJournaled?.(events);

        const responses: AttemptEventCommitResponse[] = [];
        for (const event of events) {
          const response = await commitQueuedEvent(
            withSyncTrace({
              event,
              queuedAt:
                queuedEntries.find((entry) => entry.event.idempotencyKey === event.idempotencyKey)
                  ?.queuedAt ?? event.clientTimestamp,
              sendReason: "initial",
              queueDepthAtSend: queuedEntries.length,
              replayAttempt: 0,
              sentAt: now(),
            }),
          );
          await applyCommitResponse({
            journal: input.journal,
            receiptStore: input.receiptStore,
            attemptId: input.attemptId,
            event,
            response,
            now,
            receiptRetentionMs,
            updateState(nextState) {
              state = nextState;
            },
          });
          responses.push(response);

          if (response.outcome !== "accepted" && response.outcome !== "duplicate") {
            break;
          }
        }

        return responses;
      });
    },

    replayPending() {
      return runSerially(async () => {
        const entries = await input.journal.list(input.attemptId);
        const responses: AttemptEventCommitResponse[] = [];

        for (const entry of entries) {
          const response = await commitQueuedEvent(
            withSyncTrace({
              event: entry.event,
              queuedAt: entry.queuedAt,
              sendReason: "replay",
              queueDepthAtSend: entries.length,
              replayAttempt: responses.length + 1,
              sentAt: now(),
            }),
          );
          await applyCommitResponse({
            journal: input.journal,
            receiptStore: input.receiptStore,
            attemptId: input.attemptId,
            event: entry.event,
            response,
            now,
            receiptRetentionMs,
            updateState(nextState) {
              state = nextState;
            },
          });
          responses.push(response);

          if (response.outcome === "stale_session") {
            break;
          }
        }

        return responses;
      });
    },
  };
}

function applyOptimisticEvent(
  state: AttemptClientState,
  event: Pick<AttemptEventEnvelope, "type" | "payload">,
): AttemptClientState {
  const deliveryPreferences = applyOptimisticDeliveryPreferences(state.deliveryPreferences, event);
  if (deliveryPreferences === state.deliveryPreferences) {
    return state;
  }

  return {
    ...state,
    deliveryPreferences,
  };
}

function withSyncTrace<TType extends AttemptEventType>(input: {
  event: AttemptEventEnvelope<TType>;
  queuedAt: string;
  sentAt: string;
  sendReason: AttemptClientSyncTrace["sendReason"];
  queueDepthAtSend: number;
  replayAttempt: number;
}): AttemptEventEnvelope<TType> {
  return {
    ...input.event,
    syncTrace: {
      queuedAt: input.queuedAt,
      sentAt: input.sentAt,
      sendReason: input.sendReason,
      queueDepthAtSend: input.queueDepthAtSend,
      replayAttempt: input.replayAttempt,
    },
  };
}

export function createFetchAttemptTransport(
  fetchImpl: typeof fetch = fetch,
): AttemptClientTransport {
  return {
    async commit(event, options) {
      const response = await fetchImpl(
        `/api/attempts/${encodeURIComponent(event.attemptId)}/events`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
          signal: options?.signal,
        },
      );

      if (!response.ok) {
        throw await readAttemptClientError(response);
      }

      return response.json() as Promise<AttemptEventCommitResponse>;
    },
  };
}

function buildAttemptEvent<TType extends AttemptEventType>(input: {
  attemptId: string;
  clientSessionId: string;
  currentItemRef: CurrentItemRef;
  sequenceNumber: number;
  type: TType;
  payload: AttemptEventPayloadByType[TType];
  eventId: string;
  idempotencyKey: string;
  clientTimestamp: string;
}): AttemptEventEnvelope<TType> {
  return {
    attemptId: input.attemptId,
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    sequenceNumber: input.sequenceNumber,
    clientTimestamp: input.clientTimestamp,
    clientSessionId: input.clientSessionId,
    itemRef: input.currentItemRef,
    type: input.type,
    payload: input.payload,
    clientMonotonicElapsedTimeMs: readClientMonotonicElapsedTime(),
  };
}

function readClientMonotonicElapsedTime(): number {
  if (typeof performance === "undefined" || typeof performance.now !== "function") {
    return 0;
  }

  return Math.max(0, Math.round(performance.now()));
}

async function applyCommitResponse(input: {
  journal: AttemptJournal;
  receiptStore?: AttemptReplayReceiptStore;
  attemptId: string;
  event: AttemptEventEnvelope;
  response: AttemptEventCommitResponse;
  now: () => string;
  receiptRetentionMs: number;
  updateState(nextState: AttemptClientState): void;
}): Promise<void> {
  input.updateState({
    currentItemRef: input.response.currentItemRef,
    highestCommittedSequence: input.response.highestCommittedSequence,
    nextSequenceNumber:
      "expectedNextSequence" in input.response
        ? input.response.expectedNextSequence
        : input.response.highestCommittedSequence + 1,
    attemptStatus: input.response.attemptStatus,
    timing: input.response.timing,
    deliveryPreferences: input.response.deliveryPreferences ??
      (input.response.outcome === "duplicate"
        ? input.response.storedReceipt.deliveryPreferences
        : undefined) ?? { keywordTranslationLanguage: null },
  });

  if (input.response.outcome === "accepted" || input.response.outcome === "duplicate") {
    await writeReceiptRecord(input);
    await input.journal.pruneCovered({
      attemptId: input.attemptId,
      highestCommittedSequence: input.response.highestCommittedSequence,
    });
    if (input.response.outcome === "duplicate") {
      // A resumed tab can resend the same logical event at a newer sequence.
      // Its stored receipt acknowledges that event even beyond the covered sequence.
      await pruneEventByIdempotencyKey(input);
    }
    return;
  }

  if (input.response.outcome === "late_preserved") {
    await writeReceiptRecord(input);
    const pending = await input.journal.list(input.attemptId);
    const belongsToFinalAnswerSet =
      isSubmissionEvent(input.event.type) ||
      (input.event.type === "response.changed" &&
        pending.some(
          ({ event }) =>
            isSubmissionEvent(event.type) &&
            event.sequenceNumber === input.event.sequenceNumber + 1,
        ));
    // Preserved evidence does not authorize final work. Retain the original
    // events so an explicit staff reopen can replay this same frozen answer set.
    if (!belongsToFinalAnswerSet) await pruneEventByIdempotencyKey(input);
    return;
  }

  await writeReceiptRecord(input);
  if (input.response.outcome === "stale_sequence") {
    await input.journal.pruneCovered({
      attemptId: input.attemptId,
      highestCommittedSequence: input.response.highestCommittedSequence,
    });
  }
}

async function pruneEventByIdempotencyKey(input: {
  journal: AttemptJournal;
  attemptId: string;
  event: AttemptEventEnvelope;
}): Promise<void> {
  const entries = await input.journal.list(input.attemptId);
  await input.journal.replace({
    attemptId: input.attemptId,
    entries: entries.filter((entry) => entry.event.idempotencyKey !== input.event.idempotencyKey),
  });
}

async function writeReceiptRecord(input: {
  receiptStore?: AttemptReplayReceiptStore;
  event: AttemptEventEnvelope;
  response: AttemptEventCommitResponse;
  now: () => string;
  receiptRetentionMs: number;
}): Promise<void> {
  if (!input.receiptStore) {
    return;
  }

  const confirmedAt = input.now();
  await input.receiptStore.write({
    receiptKey: `${input.event.attemptId}:${input.event.idempotencyKey}`,
    attemptId: input.event.attemptId,
    eventId: input.event.eventId,
    idempotencyKey: input.event.idempotencyKey,
    sequenceNumber: input.event.sequenceNumber,
    eventType: input.event.type,
    outcome: input.response.outcome,
    receiptId: readReceiptId(input.response),
    serverTimestamp: readServerTimestamp(input.response),
    highestCommittedSequence: input.response.highestCommittedSequence,
    confirmedAt,
    purgeAfter: new Date(Date.parse(confirmedAt) + input.receiptRetentionMs).toISOString(),
  } satisfies AttemptReplayReceiptRecord);
}

function readReceiptId(response: AttemptEventCommitResponse): string | null {
  if (response.outcome === "accepted") {
    return response.receiptId;
  }

  if (response.outcome === "duplicate") {
    return response.storedReceipt.receiptId;
  }

  return null;
}

function readServerTimestamp(response: AttemptEventCommitResponse): string | null {
  if (response.outcome === "accepted") {
    return response.serverTimestamp;
  }

  if (response.outcome === "duplicate") {
    return response.storedReceipt.serverTimestamp;
  }

  if (response.outcome === "late_preserved") {
    return response.serverTimestamp;
  }

  return null;
}

function stateFromSession(session: AuthoritativeAttemptSessionState): AttemptClientState {
  const nextSequenceNumber = session.sequence.nextSequence ?? 1;

  return {
    currentItemRef: session.currentItemRef,
    nextSequenceNumber,
    highestCommittedSequence: session.sequence.lastAcceptedSequence ?? 0,
    attemptStatus: session.attemptStatus,
    timing: session.timing,
    deliveryPreferences: session.deliveryPreferences ?? { keywordTranslationLanguage: null },
  };
}

function defaultIdFactory(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

async function readAttemptClientError(response: Response): Promise<AttemptClientRequestError> {
  let message = `${response.status} ${response.statusText}`;
  let authoritativeState: AttemptClientAuthoritativeRejection | null = null;

  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const error = Reflect.get(body, "error");
      if (typeof error === "string" && error.trim()) {
        message = error;
      }
      authoritativeState = parseAttemptClientAuthoritativeRejection(body);
    }
  } catch {
    // Fall back to the status line when the response body is unavailable.
  }

  return new AttemptClientRequestError(message, response.status, authoritativeState);
}

function parseAttemptClientAuthoritativeRejection(
  value: object,
): AttemptClientAuthoritativeRejection | null {
  const highestCommittedSequence = Reflect.get(value, "highestCommittedSequence");
  const nextSequenceNumber = Reflect.get(value, "expectedNextSequence");
  const rawDeliveryPreferences = Reflect.get(value, "deliveryPreferences");
  if (
    !Number.isInteger(highestCommittedSequence) ||
    typeof highestCommittedSequence !== "number" ||
    highestCommittedSequence < 0 ||
    !Number.isInteger(nextSequenceNumber) ||
    typeof nextSequenceNumber !== "number" ||
    nextSequenceNumber < 1 ||
    !rawDeliveryPreferences ||
    typeof rawDeliveryPreferences !== "object"
  ) {
    return null;
  }

  const keywordTranslationLanguage = Reflect.get(
    rawDeliveryPreferences,
    "keywordTranslationLanguage",
  );
  if (
    keywordTranslationLanguage !== null &&
    (typeof keywordTranslationLanguage !== "string" || !keywordTranslationLanguage.trim())
  ) {
    return null;
  }

  return {
    highestCommittedSequence,
    nextSequenceNumber,
    deliveryPreferences: { keywordTranslationLanguage },
  };
}
