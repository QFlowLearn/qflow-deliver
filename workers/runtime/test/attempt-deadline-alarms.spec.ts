import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyD1Migrations,
  abortAllDurableObjects,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import type { BootstrapEnvelope, BootstrapPayload } from "@harbor/attempt-protocol";
import type { Env } from "../src/env";
import { STATE_KEY, type StoredAttemptState } from "../src/attempts/attempt-state-bootstrap";
import { runOutboxAlarm } from "./outbox-alarm";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

// SAFETY: these bindings are supplied by the real workerd configuration in vitest.config.ts.
const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
};
beforeAll(() => applyD1Migrations(bindings.HARBOR_DB, bindings.TEST_MIGRATIONS));

async function post(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function coordinator(attemptId: string): DurableObjectStub {
  return bindings.ATTEMPT_COORDINATOR.get(bindings.ATTEMPT_COORDINATOR.idFromName(attemptId));
}

async function launch(seconds: number | null = 60, grace = 0) {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifestXml);
  zip.file("items/item-1.xml", itemXml);
  zip.file("assets/stimulus.svg", stimulusSvg);
  const published = await workerExports.default.fetch(
    new Request("https://harbor.local/internal/publish?assessmentSlug=deadline-alarms", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "deadline.zip",
        "x-harbor-tenant-id": crypto.randomUUID(),
      },
      body: new Uint8Array(await zip.generateAsync({ type: "uint8array" })).buffer,
    }),
  );
  expect(published.status).toBe(201);
  const { assessmentVersionId } = await published.json<{ assessmentVersionId: string }>();
  await bindings.HARBOR_DB.prepare(
    "UPDATE assessment_versions SET delivery_policy_snapshot = ? WHERE id = ?",
  )
    .bind(
      JSON.stringify({
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: seconds,
        gracePeriodSeconds: grace,
      }),
      assessmentVersionId,
    )
    .run();
  const launched = await post("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId,
    actor: { kind: "preview-operator", id: "deadline_operator", displayName: "Deadline Operator" },
  });
  expect(launched.status).toBe(201);
  const envelope = await launched.json<BootstrapEnvelope>();
  const bootstrap = await post("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: "deadline_alarm_session",
  });
  expect(bootstrap.status).toBe(200);
  const boot = await bootstrap.json<BootstrapPayload>();
  return { boot, stub: coordinator(boot.attemptId) };
}

async function snapshot(stub: DurableObjectStub) {
  return runInDurableObject(stub, async (_instance, runtime) => {
    const state = await runtime.storage.get<StoredAttemptState>(STATE_KEY);
    if (!state) throw new Error("Attempt was not initialized");
    return {
      state,
      alarm: await runtime.storage.getAlarm(),
      delivery: await runtime.storage.get<number>("attempt-alarm-outbox-at"),
    };
  });
}

async function clock(stub: DurableObjectStub, now: number): Promise<void> {
  const response = await stub.fetch("https://harbor-attempt.local/__test/outbox/set-clock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ now }),
  });
  expect(response.status).toBe(204);
}

async function alarmAt(stub: DurableObjectStub, now: number): Promise<boolean> {
  await clock(stub, now);
  return runDurableObjectAlarm(stub);
}

async function settledAlarmAt(stub: DurableObjectStub, now: number): Promise<boolean> {
  const ran = await alarmAt(stub, now);
  await flush(stub);
  return ran;
}

async function flush(stub: DurableObjectStub): Promise<void> {
  const response = await stub.fetch("https://harbor-attempt.local/deliver-outbox", {
    method: "POST",
    headers: { "x-harbor-attempt-id": "scoped" },
  });
  expect(response.status).toBe(200);
}

function deadline(state: StoredAttemptState): number {
  if (!state.timing.softCloseAt) throw new Error("Fixture has no deadline");
  return Date.parse(state.timing.softCloseAt);
}

async function save(boot: BootstrapPayload, sequence: number, answer = "B") {
  const response = await post(`/api/attempts/${boot.attemptId}/events`, {
    attemptId: boot.attemptId,
    eventId: `evt_alarm_save_${sequence}`,
    idempotencyKey: `idem_alarm_save_${sequence}`,
    sequenceNumber: sequence,
    clientSessionId: "deadline_alarm_session",
    clientTimestamp: new Date().toISOString(),
    itemRef: boot.session.currentItemRef,
    type: "response.changed",
    payload: {
      responseKey: "RESPONSE",
      intent: "checkpoint",
      responseState: {
        itemState: {
          schema: "qti3.attempt-state.v1",
          itemIdentifier: "item-1",
          status: "suspended",
          responses: { RESPONSE: answer },
          outcomes: {},
          validationMessages: [],
        },
      },
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    outcome: "accepted",
    acceptedSequenceNumber: sequence,
  });
}

async function policy(
  boot: BootstrapPayload,
  stub: DurableObjectStub,
  body: Record<string, unknown>,
): Promise<void> {
  const issuedAt = new Date().toISOString();
  const response = await post(`/internal/attempts/${boot.attemptId}/policy`, {
    commandId: crypto.randomUUID(),
    actor: { role: "operator", actorId: "deadline_operator", displayName: "Operator" },
    reason: "Approved timing intervention",
    issuedAt,
    effectiveAt: issuedAt,
    ...body,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await flush(stub);
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Alarm handler waited for D1 delivery")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("shared attempt alarms", () => {
  it("schedules at initialization, survives eviction and closes without browser traffic or D1 deadline jobs", async () => {
    const launched = await launch();
    let stub = launched.stub;
    const initial = await snapshot(stub);
    const at = deadline(initial.state);
    expect(initial.alarm).toBe(at + 1);
    await bindings.HARBOR_DB.prepare("DELETE FROM attempt_deadline_jobs WHERE attempt_id = ?")
      .bind(launched.boot.attemptId)
      .run();
    await abortAllDurableObjects();
    stub = coordinator(launched.boot.attemptId);
    // The existing contract permits writes exactly at the deadline; alarm closes one ms later.
    expect(await settledAlarmAt(stub, at)).toBe(true);
    expect((await snapshot(stub)).state.attemptStatus).toBe("active");
    expect((await snapshot(stub)).alarm).toBe(at + 1);
    expect(await settledAlarmAt(stub, at + 1)).toBe(true);
    const submitted = await snapshot(stub);
    expect(submitted.state.attemptStatus).toBe("submitted");
    expect(submitted.state.submissionReceipt).toMatchObject({
      acceptedSequenceNumber: 1,
      serverTimestamp: new Date(at + 1).toISOString(),
    });
    expect(submitted.alarm).toBeNull();
  });

  it("moves the deadline after an extension and ignores a stale wake-up at the old deadline", async () => {
    const { boot, stub } = await launch();
    const old = deadline((await snapshot(stub)).state);
    await policy(boot, stub, { type: "extend-time", additionalTimeSeconds: 120 });
    const extended = deadline((await snapshot(stub)).state);
    expect(extended).toBe(old + 120_000);
    expect((await snapshot(stub)).alarm).toBe(extended + 1);
    await settledAlarmAt(stub, old + 1);
    expect((await snapshot(stub)).state.attemptStatus).toBe("active");
    expect((await snapshot(stub)).alarm).toBe(extended + 1);
    await settledAlarmAt(stub, extended + 1);
    expect((await snapshot(stub)).state.submissionReceipt?.acceptedSequenceNumber).toBe(1);
  });

  it("reopens an automatically submitted attempt, preserves answers/ownership and submits once at its new deadline", async () => {
    const { boot, stub } = await launch();
    await save(boot, 1);
    await flush(stub);
    const original = deadline((await snapshot(stub)).state);
    await settledAlarmAt(stub, original + 1);
    const first = (await snapshot(stub)).state.submissionReceipt;
    expect(first?.acceptedSequenceNumber).toBe(2);
    const until = original + 120_000;
    await policy(boot, stub, {
      type: "reopen-attempt",
      reopenUntil: new Date(until).toISOString(),
    });
    const reopened = await snapshot(stub);
    expect(reopened.state.attemptStatus).toBe("reopened");
    expect(reopened.state.responseCheckpoint?.items["item-1"]?.responses).toEqual({
      RESPONSE: "B",
    });
    expect(reopened.state.currentClientSessionId).toBe("deadline_alarm_session");
    expect(reopened.alarm).toBe(until + 1);
    await settledAlarmAt(stub, original + 2);
    expect((await snapshot(stub)).state.attemptStatus).toBe("reopened");
    await save(boot, 3, "C");
    await flush(stub);
    await settledAlarmAt(stub, until + 1);
    const second = (await snapshot(stub)).state.submissionReceipt;
    expect(second?.acceptedSequenceNumber).toBe(4);
    expect(second?.receiptId).not.toBe(first?.receiptId);
    // Model at-least-once redelivery of the same alarm after its successful completion.
    await runInDurableObject(stub, (_instance, runtime) => runtime.storage.setAlarm(until + 1));
    await settledAlarmAt(stub, until + 1);
    expect((await snapshot(stub)).state.submissionReceipt).toEqual(second);
    await expect.poll(async () => (await snapshot(stub)).alarm).toBeNull();
    const finalizations = await bindings.HARBOR_DB.prepare(
      "SELECT source_sequence_number FROM result_finalizations WHERE attempt_id = ? ORDER BY source_sequence_number",
    )
      .bind(boot.attemptId)
      .all<{ source_sequence_number: number }>();
    expect(finalizations.results).toEqual([
      { source_sequence_number: 2 },
      { source_sequence_number: 4 },
    ]);
  });

  it("does not let D1 retry backoff postpone the deadline or lose either wake-up", async () => {
    const { boot, stub } = await launch();
    const at = deadline((await snapshot(stub)).state);
    await clock(stub, at - 500);
    const db = bindings.HARBOR_DB;
    await db.exec("ALTER TABLE attempt_deadline_jobs RENAME TO unavailable_deadline_jobs");
    try {
      await save(boot, 1);
      await flush(stub);
      const deferred = await snapshot(stub);
      expect(deferred.delivery).toBeGreaterThan(at + 1);
      expect(deferred.alarm).toBe(at + 1);
      await settledAlarmAt(stub, at + 1);
      const submitted = await snapshot(stub);
      expect(submitted.state.submissionReceipt?.acceptedSequenceNumber).toBe(2);
      expect(submitted.alarm).toBe(deferred.delivery);
      expect(submitted.delivery).toBe(deferred.delivery);
    } finally {
      await db.exec("ALTER TABLE unavailable_deadline_jobs RENAME TO attempt_deadline_jobs");
    }
    await runOutboxAlarm(stub);
    await expect.poll(async () => (await snapshot(stub)).alarm).toBeNull();
    const finalization = await db
      .prepare("SELECT source_sequence_number FROM result_finalizations WHERE attempt_id = ?")
      .bind(boot.attemptId)
      .first<{ source_sequence_number: number }>();
    expect(finalization?.source_sequence_number).toBe(2);
  });

  it("retains a later deadline when an earlier outbox retry finishes", async () => {
    const { boot, stub } = await launch();
    await save(boot, 1);
    await flush(stub);
    const state = await snapshot(stub);
    expect(state.delivery).toBeUndefined();
    expect(state.alarm).toBe(deadline(state.state) + 1);
    expect(await runOutboxAlarm(stub)).toBe(false);
  });

  it.each(["request", "alarm"] as const)(
    "commits a deadline while %s-started outbox delivery is paused in D1",
    async (source) => {
      const { boot, stub } = await launch();
      const at = deadline((await snapshot(stub)).state);
      await stub.fetch("https://harbor-attempt.local/__test/outbox/hold");
      // Direct commit leaves delivery to this test, rather than starting worker background work.
      const saveResponse = await stub.fetch("https://harbor-attempt.local/commit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-harbor-attempt-id": boot.attemptId,
          "x-harbor-delivery-context-url": "https://harbor.local/api/attempts/events",
        },
        body: JSON.stringify({
          attemptId: boot.attemptId,
          eventId: "paused_heartbeat",
          idempotencyKey: "paused_heartbeat",
          sequenceNumber: 1,
          clientSessionId: "deadline_alarm_session",
          clientTimestamp: new Date().toISOString(),
          itemRef: boot.session.currentItemRef,
          type: "heartbeat",
          payload: {},
        }),
      });
      expect(saveResponse.status).toBe(200);
      const delivery: Promise<unknown> =
        source === "alarm" ? runDurableObjectAlarm(stub) : flush(stub);
      let alarm: Promise<boolean> | undefined;
      try {
        await stub.fetch("https://harbor-attempt.local/__test/outbox/wait-for-query");
        if (source === "alarm") {
          // This must finish while D1 is still held; native alarms cannot overlap one another.
          await promptly(delivery);
        }
        alarm = alarmAt(stub, at + 1);
        await promptly(alarm);
        await expect
          .poll(async () => (await snapshot(stub)).state.attemptStatus, { timeout: 1_000 })
          .toBe("submitted");
        expect((await snapshot(stub)).state.submissionReceipt?.acceptedSequenceNumber).toBe(2);
      } finally {
        await stub.fetch("https://harbor-attempt.local/__test/outbox/release");
        await Promise.all([delivery, alarm]);
      }
      await runOutboxAlarm(stub);
      await expect.poll(async () => (await snapshot(stub)).alarm).toBeNull();
    },
  );

  it("does not schedule an exam wake-up for an unlimited attempt", async () => {
    const { stub } = await launch(null);
    await expect.poll(async () => (await snapshot(stub)).alarm).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
  it("keeps the configured grace window open before server closure", async () => {
    const { boot, stub } = await launch(60, 30);
    const soft = deadline((await snapshot(stub)).state);
    expect((await snapshot(stub)).alarm).toBe(soft + 30_001);
    await settledAlarmAt(stub, soft + 1);
    expect((await snapshot(stub)).state.attemptStatus).toBe("active");
    await save(boot, 1);
    await flush(stub);
    expect((await snapshot(stub)).alarm).toBe(soft + 30_001);
    await settledAlarmAt(stub, soft + 30_001);
    expect((await snapshot(stub)).state.submissionReceipt?.acceptedSequenceNumber).toBe(2);
  });

  it("cancels the deadline after manual submission and does not create a second receipt on redelivery", async () => {
    const { boot, stub } = await launch();
    const at = deadline((await snapshot(stub)).state);
    const response = await post(`/api/attempts/${boot.attemptId}/events`, {
      attemptId: boot.attemptId,
      eventId: "manual_finish",
      idempotencyKey: "manual_finish",
      sequenceNumber: 1,
      clientSessionId: "deadline_alarm_session",
      clientTimestamp: new Date().toISOString(),
      itemRef: boot.session.currentItemRef,
      type: "submit.requested",
      payload: { requestedAt: new Date().toISOString() },
    });
    expect(response.status).toBe(200);
    await flush(stub);
    const manual = await snapshot(stub);
    expect(manual.alarm).toBeNull();
    await runInDurableObject(stub, (_instance, runtime) => runtime.storage.setAlarm(at + 1));
    await settledAlarmAt(stub, at + 1);
    expect((await snapshot(stub)).state.submissionReceipt).toEqual(manual.state.submissionReceipt);
    expect((await snapshot(stub)).state.highestCommittedSequence).toBe(1);
    await expect.poll(async () => (await snapshot(stub)).alarm).toBeNull();
  });

  it("honors a finite reopening window even when the original attempt had unlimited time", async () => {
    const { boot, stub } = await launch(null);
    const until = Date.now() + 60_000;
    await policy(boot, stub, {
      type: "reopen-attempt",
      reopenUntil: new Date(until).toISOString(),
    });
    expect((await snapshot(stub)).alarm).toBe(until + 1);
    await settledAlarmAt(stub, until + 1);
    expect((await snapshot(stub)).state.attemptStatus).toBe("submitted");
    await expect.poll(async () => (await snapshot(stub)).alarm).toBeNull();
  });
  it("preserves elapsed assessment time when reopening a still-active window", async () => {
    const { boot, stub } = await launch();
    const initial = (await snapshot(stub)).state;
    if (!initial.timing.startedAt) throw new Error("Fixture has no start time");
    const effectiveAt = Date.parse(initial.timing.startedAt) + 15_000;
    const until = effectiveAt + 120_000;
    await policy(boot, stub, {
      type: "reopen-attempt",
      effectiveAt: new Date(effectiveAt).toISOString(),
      reopenUntil: new Date(until).toISOString(),
    });
    const reopened = await snapshot(stub);
    const assessment = reopened.state.scopedTiming.scopes.find(
      (scope) => scope.scopeType === "assessment-test",
    );
    expect(assessment?.elapsedMilliseconds).toBe(15_000);
    expect(assessment?.activeSince).toBe(new Date(effectiveAt).toISOString());
    expect(reopened.alarm).toBe(until + 1);
  });
});
