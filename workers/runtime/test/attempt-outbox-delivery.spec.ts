import { beforeAll, describe, expect, it } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext,
  abortAllDurableObjects,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  AttemptEventEnvelope,
  BootstrapPayload,
  CommitAttemptEventReceipt,
} from "@harbor/attempt-protocol";
import type { Env } from "../src/env";
import { commitAttemptEvent } from "../src/routes/attempt-events";
import {
  setupStagedTests,
  launch,
  publishTestPackage,
  launchPublished,
} from "./staged-assessment-harness";
import { stagedPackage } from "../../../tests/fixtures/staged-package";
import testXml from "../../../tests/fixtures/qti/staged-assessment/test.xml?raw";
import { runOutboxAlarm } from "./outbox-alarm";

beforeAll(setupStagedTests);
// SAFETY: the workerd test config provides the real runtime bindings used by production handlers.
const bindings = env as unknown as Env;

function coordinator(attemptId: string): DurableObjectStub {
  return bindings.ATTEMPT_COORDINATOR.get(bindings.ATTEMPT_COORDINATOR.idFromName(attemptId));
}

function save(boot: BootstrapPayload, sequence: number): AttemptEventEnvelope<"response.changed"> {
  return {
    attemptId: boot.attemptId,
    eventId: `evt_slow_${sequence}`,
    idempotencyKey: `idem_slow_${sequence}`,
    sequenceNumber: sequence,
    clientTimestamp: new Date().toISOString(),
    clientSessionId: "outbox_delivery_session",
    itemRef: boot.session.currentItemRef,
    type: "response.changed",
    payload: {
      responseKey: "RESPONSE",
      responseState: {
        itemState: {
          responseVariables: [{ identifier: "RESPONSE", value: `answer-${sequence}` }],
        },
      },
    },
  };
}

function throughRoute(event: AttemptEventEnvelope, ctx: ExecutionContext): Promise<Response> {
  return commitAttemptEvent({
    request: new Request(`https://harbor.local/api/attempts/${event.attemptId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
    env: bindings,
    attemptId: event.attemptId,
    ctx,
  });
}

function directSave(stub: DurableObjectStub, event: AttemptEventEnvelope): Promise<Response> {
  return stub.fetch("https://harbor-attempt.local/commit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harbor-attempt-id": event.attemptId,
      "x-harbor-delivery-context-url": "https://harbor.local/api/attempts/events",
    },
    body: JSON.stringify(event),
  });
}

function control(stub: DurableObjectStub, command: string): Promise<Response> {
  return stub.fetch(`https://harbor-attempt.local/__test/outbox/${command}`);
}

async function queryCount(stub: DurableObjectStub): Promise<number> {
  return (await (await control(stub, "status")).json<{ queryCount: number }>()).queryCount;
}

async function retryStatus(stub: DurableObjectStub) {
  return runInDurableObject(stub, async (_instance, state) => ({
    retry: await state.storage.get("commit-outbox-retry"),
    alarm: (await state.storage.get<number>("attempt-alarm-outbox-at")) ?? null,
    pending: (await state.storage.list({ prefix: "commit-outbox:" })).size,
  }));
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Save or control request waited on paused D1 delivery")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("outbox delivery isolation", () => {
  it.each(["request", "alarm"] as const)(
    "confirms another save while %s-triggered D1 delivery is paused",
    async (source) => {
      const boot = await launch();
      const stub = coordinator(boot.attemptId);
      await control(stub, "freeze-clock");
      const baseline = await queryCount(stub);
      await control(stub, "hold");
      const firstCtx = createExecutionContext();
      const secondCtx = createExecutionContext();
      let alarm: Promise<boolean> | undefined;
      try {
        const first =
          source === "request"
            ? await throughRoute(save(boot, 1), firstCtx)
            : await directSave(stub, save(boot, 1));
        expect(first.status, await first.clone().text()).toBe(200);
        if (source === "alarm") alarm = runOutboxAlarm(stub);
        await promptly(control(stub, "wait-for-query"));
        const second = await promptly(throughRoute(save(boot, 2), secondCtx));
        expect(second.status, await second.clone().text()).toBe(200);
        await expect(second.json<CommitAttemptEventReceipt>()).resolves.toMatchObject({
          outcome: "accepted",
          acceptedSequenceNumber: 2,
          highestCommittedSequence: 2,
        });
        // Both request wake-ups share the paused delivery owner.
        expect(await promptly(queryCount(stub))).toBe(baseline + 1);
        expect((await retryStatus(stub)).pending).toBe(2);
      } finally {
        await control(stub, "release");
        await Promise.all([
          waitOnExecutionContext(firstCtx),
          waitOnExecutionContext(secondCtx),
          alarm,
        ]);
      }
      await runOutboxAlarm(stub);
      await expect
        .poll(() => retryStatus(stub))
        .toEqual({ retry: undefined, alarm: null, pending: 0 });
      expect(await queryCount(stub)).toBe(baseline + 2);
      const evidence = await bindings.HARBOR_DB.prepare(
        "SELECT sequence_number FROM attempt_evidence_events WHERE attempt_id = ? AND event_type = 'response.changed' ORDER BY sequence_number",
      )
        .bind(boot.attemptId)
        .all<{ sequence_number: number }>();
      expect(evidence.results).toEqual([{ sequence_number: 1 }, { sequence_number: 2 }]);
      const session = await stub.fetch("https://harbor-attempt.local/session", {
        headers: { "x-harbor-attempt-id": boot.attemptId },
      });
      await expect(session.json()).resolves.toMatchObject({
        sequence: { lastAcceptedSequence: 2, nextSequence: 3 },
      });
    },
  );

  it("projects a time extension made during older D1 delivery without losing the newer deadline marker", async () => {
    const version = await publishTestPackage(await stagedPackage(testXml));
    await bindings.HARBOR_DB.prepare(
      "UPDATE assessment_versions SET delivery_policy_snapshot = ? WHERE id = ?",
    )
      .bind(
        JSON.stringify({
          launchMode: "preview",
          navigationMode: "linear",
          maxAttempts: 1,
          timeLimitSeconds: 60,
          gracePeriodSeconds: 30,
        }),
        version,
      )
      .run();
    const boot = await launchPublished(version);
    const stub = coordinator(boot.attemptId);
    await control(stub, "freeze-clock");
    await control(stub, "hold");
    const ctx = createExecutionContext();
    try {
      expect((await throughRoute(save(boot, 1), ctx)).status).toBe(200);
      await promptly(control(stub, "wait-for-query"));
      const issuedAt = new Date().toISOString();
      const extended = await promptly(
        stub.fetch("https://harbor-attempt.local/policy", {
          method: "POST",
          headers: { "content-type": "application/json", "x-harbor-attempt-id": boot.attemptId },
          body: JSON.stringify({
            commandId: "cmd_outbox_during_delivery",
            type: "extend-time",
            actor: { role: "operator", actorId: "operator_outbox", displayName: "Operator" },
            reason: "Approved extension",
            issuedAt,
            effectiveAt: issuedAt,
            additionalTimeSeconds: 120,
          }),
        }),
      );
      expect(extended.status, await extended.clone().text()).toBe(200);
    } finally {
      await control(stub, "release");
      await waitOnExecutionContext(ctx);
    }
    await runOutboxAlarm(stub);
    await expect
      .poll(() => retryStatus(stub))
      .toEqual({ retry: undefined, alarm: null, pending: 0 });
    const jobs = await bindings.HARBOR_DB.prepare(
      "SELECT policy_version, deadline_at FROM attempt_deadline_jobs WHERE attempt_id = ? AND status = 'pending'",
    )
      .bind(boot.attemptId)
      .all<{ policy_version: number; deadline_at: string }>();
    expect(jobs.results.length).toBeGreaterThan(0);
    expect(jobs.results.every((row) => row.policy_version === 1)).toBe(true);
    await expect
      .poll(() => retryStatus(stub))
      .toEqual({ retry: undefined, alarm: null, pending: 0 });
  });

  it("enforces durable backoff for saves, duplicates and premature alarm delivery", async () => {
    const boot = await launch();
    let stub = coordinator(boot.attemptId);
    await control(stub, "freeze-clock");
    const baseline = await queryCount(stub);
    const db = bindings.HARBOR_DB;
    await db.exec("ALTER TABLE attempt_deadline_jobs RENAME TO unavailable_deadline_jobs");
    try {
      const firstCtx = createExecutionContext();
      const first = await throughRoute(save(boot, 1), firstCtx);
      expect(first.status).toBe(200);
      await waitOnExecutionContext(firstCtx);
      const failed = await retryStatus(stub);
      expect(failed).toMatchObject({
        retry: { failures: 1, nextDeliveryAt: expect.any(Number) },
        pending: 1,
      });
      expect(await queryCount(stub)).toBe(baseline + 1);

      for (const event of [save(boot, 2), save(boot, 2), save(boot, 3)]) {
        const ctx = createExecutionContext();
        const response = await promptly(throughRoute(event, ctx));
        expect(response.status).toBe(200);
        await waitOnExecutionContext(ctx);
      }
      const deferred = await retryStatus(stub);
      expect(deferred).toEqual({ ...failed, pending: 3 });
      expect(await queryCount(stub)).toBe(baseline + 1);

      await abortAllDurableObjects();
      stub = coordinator(boot.attemptId);
      const duplicateCtx = createExecutionContext();
      const duplicate = await throughRoute(save(boot, 3), duplicateCtx);
      await expect(duplicate.json()).resolves.toMatchObject({ outcome: "duplicate" });
      await waitOnExecutionContext(duplicateCtx);
      expect(await queryCount(stub)).toBe(0); // the persisted retry survives a fresh instance
      expect(await retryStatus(stub)).toEqual(deferred);

      // A manually dispatched early alarm must also observe the persisted retry time.
      const { runDurableObjectAlarm } = await import("cloudflare:test");
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await queryCount(stub)).toBe(0);
      expect(await retryStatus(stub)).toEqual(deferred);
    } finally {
      await db.exec("ALTER TABLE unavailable_deadline_jobs RENAME TO attempt_deadline_jobs");
    }
    expect(await runOutboxAlarm(stub)).toBe(true);
    await expect
      .poll(() => retryStatus(stub))
      .toEqual({ retry: undefined, alarm: null, pending: 0 });
    expect(await queryCount(stub)).toBe(1);
    const evidence = await db
      .prepare(
        "SELECT sequence_number FROM attempt_evidence_events WHERE attempt_id = ? AND outcome = 'accepted' ORDER BY sequence_number",
      )
      .bind(boot.attemptId)
      .all<{ sequence_number: number }>();
    expect(evidence.results).toEqual([
      { sequence_number: 1 },
      { sequence_number: 2 },
      { sequence_number: 3 },
    ]);
  });
  it("does not retry finalization writes through duplicate submit handoffs during backoff", async () => {
    const boot = await launch();
    const stub = coordinator(boot.attemptId);
    await control(stub, "freeze-clock");
    const db = bindings.HARBOR_DB;
    await db.exec(
      "CREATE TRIGGER fail_submit_backoff BEFORE INSERT ON result_finalizations BEGIN SELECT RAISE(ABORT, 'D1 unavailable'); END",
    );
    const submitted: AttemptEventEnvelope<"submit.requested"> = {
      ...save(boot, 1),
      type: "submit.requested",
      payload: { requestedAt: new Date().toISOString() },
    };
    const finalizationCount = async () =>
      (await (await control(stub, "status")).json<{ finalizationCount: number }>())
        .finalizationCount;
    try {
      const firstCtx = createExecutionContext();
      const first = await throughRoute(submitted, firstCtx);
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({
        outcome: "accepted",
        attemptStatus: "submitted",
      });
      await waitOnExecutionContext(firstCtx);
      expect(await finalizationCount()).toBe(1);
      const failed = await retryStatus(stub);
      for (let replay = 0; replay < 2; replay++) {
        const ctx = createExecutionContext();
        const response = await throughRoute(submitted, ctx);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ outcome: "duplicate" });
        await waitOnExecutionContext(ctx);
      }
      expect(await finalizationCount()).toBe(1);
      expect(await retryStatus(stub)).toEqual(failed);
    } finally {
      await db.exec("DROP TRIGGER fail_submit_backoff");
    }
    expect(await runOutboxAlarm(stub)).toBe(true);
    await expect
      .poll(() => retryStatus(stub))
      .toEqual({ retry: undefined, alarm: null, pending: 0 });
    expect(await finalizationCount()).toBe(2);
    const finalizations = await db
      .prepare("SELECT status FROM result_finalizations WHERE attempt_id = ?")
      .bind(boot.attemptId)
      .all<{ status: string }>();
    expect(finalizations.results).toEqual([{ status: "pending" }]);
  });
});
