import {
  OUTBOX_RECOVERY_DELAY_MS,
  getOutboxWakeup,
  reconcileAttemptAlarm,
  setOutboxWakeup,
} from "./attempt-alarm-schedule";
import type { AttemptEventEnvelope, CommitAttemptEventReceipt } from "@harbor/attempt-protocol";
import {
  projectAcceptedAttemptProjections,
  type AcceptedProjectionAttemptState,
} from "./attempt-accepted-projections";
import {
  closeAttemptDeadlineJobs,
  syncAttemptDeadlineJobs,
  type AttemptDeadlineJobProjectionState,
} from "./attempt-deadline-jobs";
import { STATE_KEY, type StoredAttemptState } from "./attempt-state-bootstrap";
import { projectAttemptEvidenceEvent } from "../routes/attempt-evidence";
import {
  buildSubmitFinalizationEnvelope,
  ensurePendingSubmitFinalization,
} from "../queues/submit-finalization-outbox";

const OUTBOX_PREFIX = "commit-outbox:";
const RETRY_KEY = "commit-outbox-retry";
const DEADLINE_KEY = "commit-outbox-deadline";
const DELIVERY_BATCH_SIZE = 25;
const FIRST_DELIVERY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

type DeliveryOutcome = "ready" | "deferred";

type Coordinate = <T>(operation: () => Promise<T>) => Promise<T>;

interface CommitDelivery {
  readonly event: AttemptEventEnvelope;
  readonly receipt: CommitAttemptEventReceipt;
  readonly previousState: AcceptedProjectionAttemptState;
  readonly nextState: AcceptedProjectionAttemptState;
}

interface PendingDeadlineProjection {
  readonly revision: number;
  readonly state: AttemptDeadlineJobProjectionState;
  readonly closeStatus: "fired" | "canceled";
  readonly receiptId: string | null;
}

interface DeliveryRetry {
  readonly failures: number;
  readonly nextDeliveryAt: number;
}

interface CommitOutboxEnv {
  readonly HARBOR_DB: D1Database;
}

/** Owns atomic acceptance, one external delivery at a time, and durable retry scheduling. */
export class AttemptCommitOutbox {
  private inFlight: Promise<DeliveryOutcome> | undefined;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: CommitOutboxEnv,
    private readonly coordinate: Coordinate,
    private readonly now: () => number,
  ) {}

  /** Called within the attempt gate; acceptance and delivery intent share one transaction. */
  async commit(input: {
    state: StoredAttemptState;
    previousState: StoredAttemptState;
    event: AttemptEventEnvelope;
    receipt: CommitAttemptEventReceipt;
    receiptStorageKey: string;
  }): Promise<void> {
    const delivery: CommitDelivery = {
      event: input.event,
      receipt: input.receipt,
      previousState: projectionState(input.previousState),
      nextState: projectionState(input.state),
    };
    const key = `${OUTBOX_PREFIX}${String(input.receipt.acceptedSequenceNumber).padStart(16, "0")}`;
    await this.storage.transaction(async (txn) => {
      await txn.put({
        [STATE_KEY]: input.state,
        [input.receiptStorageKey]: input.receipt,
        [key]: delivery,
      });
      await this.writeDeadlineProjection(
        txn,
        input.state,
        input.event.type === "timing.auto-submit.requested" ? "fired" : "canceled",
      );
    });
  }

  /** Persists a policy mutation and its deadline projection under the attempt gate. */
  async commitState(state: StoredAttemptState): Promise<void> {
    await this.storage.transaction(async (txn) => {
      await txn.put(STATE_KEY, state);
      await this.writeDeadlineProjection(txn, state, "canceled");
    });
  }

  private async writeDeadlineProjection(
    txn: DurableObjectTransaction,
    state: StoredAttemptState,
    closeStatus: PendingDeadlineProjection["closeStatus"],
  ): Promise<void> {
    const previous = await txn.get<PendingDeadlineProjection>(DEADLINE_KEY);
    const pending: PendingDeadlineProjection = {
      revision: (previous?.revision ?? 0) + 1,
      state: {
        attemptId: state.attemptId,
        assessmentVersionId: state.assessmentVersionId,
        assignmentId: state.assignmentId,
        scopedTiming: state.scopedTiming,
        attemptStatus: state.attemptStatus,
      },
      closeStatus,
      receiptId: state.submissionReceipt?.receiptId ?? null,
    };
    await txn.put(DEADLINE_KEY, pending);
    if ((await getOutboxWakeup(txn)) === null)
      await setOutboxWakeup(txn, this.now() + FIRST_DELIVERY_DELAY_MS);
    else await reconcileAttemptAlarm(txn);
  }

  /** Never holds the attempt gate across external I/O. Concurrent wake-ups share one owner. */
  async deliver(): Promise<DeliveryOutcome> {
    if (this.inFlight) return this.inFlight;
    const delivery = this.deliverBatch();
    this.inFlight = delivery;
    try {
      return await delivery;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async deliverBatch(): Promise<DeliveryOutcome> {
    const batch = await this.coordinate(() =>
      this.storage.transaction(async (txn) => {
        const retry = parseDeliveryRetry(await txn.get<unknown>(RETRY_KEY));
        if (retry && this.now() < retry.nextDeliveryAt) {
          await setOutboxWakeup(txn, retry.nextDeliveryAt);
          return { kind: "deferred" as const };
        }
        const pending = await txn.list<CommitDelivery>({
          prefix: OUTBOX_PREFIX,
          limit: DELIVERY_BATCH_SIZE,
        });
        const deadline = await txn.get<PendingDeadlineProjection>(DEADLINE_KEY);
        if (pending.size === 0 && !deadline) {
          await setOutboxWakeup(txn, null);
          await txn.delete(RETRY_KEY);
          return { kind: "idle" as const };
        }
        // An interrupted owner leaves both its work and a durable recovery wake-up.
        await setOutboxWakeup(txn, this.now() + OUTBOX_RECOVERY_DELAY_MS);
        return { kind: "batch" as const, pending, deadline, failures: retry?.failures ?? 0 };
      }),
    );
    if (batch.kind !== "batch") return batch.kind === "idle" ? "ready" : "deferred";

    let operation = "deadline-projection";
    try {
      if (batch.deadline) {
        const deadline = batch.deadline;
        if (deadline.state.attemptStatus === "submitted") {
          await closeAttemptDeadlineJobs({
            db: this.env.HARBOR_DB,
            attemptId: deadline.state.attemptId,
            status: deadline.closeStatus,
            receiptId: deadline.receiptId,
            now: new Date(this.now()).toISOString(),
          });
        } else {
          await syncAttemptDeadlineJobs({
            db: this.env.HARBOR_DB,
            state: deadline.state,
            now: new Date(this.now()).toISOString(),
          });
        }
        await this.coordinate(async () => {
          const latest = await this.storage.get<PendingDeadlineProjection>(DEADLINE_KEY);
          // Saves/policy changes made during delivery retain their newer projection.
          if (latest?.revision === deadline.revision) await this.storage.delete(DEADLINE_KEY);
        });
      }

      for (const [key, entry] of batch.pending) {
        operation = "event-projections";
        await projectAcceptedAttemptProjections({
          db: this.env.HARBOR_DB,
          attemptId: entry.receipt.attemptId,
          ...entry,
          serverAutoSubmitClientSessionId: "server_deadline_auto_submit",
        });
        operation = "accepted-evidence";
        await projectAttemptEvidenceEvent({
          db: this.env.HARBOR_DB,
          attemptId: entry.receipt.attemptId,
          requestBody: JSON.stringify(entry.event),
          commitResponse: entry.receipt,
          receivedAt: entry.receipt.serverTimestamp,
        });
        if (entry.receipt.attemptStatus === "submitted") {
          operation = "finalization";
          const envelope = buildSubmitFinalizationEnvelope({
            eventType:
              entry.event.type === "item.submit-requested" ? "submit.requested" : entry.event.type,
            receipt: entry.receipt,
          });
          // The existing D1 outbox/scheduled requeue owns durable queue handoff recovery.
          await ensurePendingSubmitFinalization({ db: this.env.HARBOR_DB, envelope });
        }
        await this.coordinate(() => this.storage.delete(key));
      }
      return await this.coordinate(() =>
        this.storage.transaction(async (txn): Promise<DeliveryOutcome> => {
          await txn.delete(RETRY_KEY);
          const remaining = await txn.list({ prefix: OUTBOX_PREFIX, limit: 1 });
          const deadline = await txn.get(DEADLINE_KEY);
          await setOutboxWakeup(
            txn,
            remaining.size > 0 || deadline ? this.now() + FIRST_DELIVERY_DELAY_MS : null,
          );
          return remaining.size > 0 || deadline ? "deferred" : "ready";
        }),
      );
    } catch {
      await this.coordinate(async () => {
        const retry: DeliveryRetry = {
          failures: batch.failures + 1,
          nextDeliveryAt:
            this.now() + Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(batch.failures + 1, 6)),
        };
        await this.storage.transaction(async (txn) => {
          await txn.put(RETRY_KEY, retry);
          await setOutboxWakeup(txn, retry.nextDeliveryAt);
        });
      });
      console.error("Attempt commit outbox delivery deferred", {
        attemptId:
          batch.deadline?.state.attemptId ?? batch.pending.values().next().value?.receipt.attemptId,
        operation,
        consecutiveFailures: batch.failures + 1,
      });
      return "deferred";
    }
  }
}

function parseDeliveryRetry(value: unknown): DeliveryRetry | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    !("failures" in value) ||
    typeof value.failures !== "number" ||
    !Number.isSafeInteger(value.failures) ||
    value.failures < 1 ||
    !("nextDeliveryAt" in value) ||
    typeof value.nextDeliveryAt !== "number" ||
    !Number.isFinite(value.nextDeliveryAt)
  ) {
    throw new Error("Invalid persisted commit delivery retry");
  }
  return { failures: value.failures, nextDeliveryAt: value.nextDeliveryAt };
}

function projectionState(state: StoredAttemptState): AcceptedProjectionAttemptState {
  return {
    attemptId: state.attemptId,
    assessmentVersionId: state.assessmentVersionId,
    assignmentId: state.assignmentId,
    currentItemRef: state.currentItemRef,
    scopedTiming: { policyVersion: state.scopedTiming.policyVersion },
  };
}
