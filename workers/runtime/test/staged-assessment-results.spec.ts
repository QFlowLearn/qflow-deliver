import { reconcileAttemptAlarm } from "../src/attempts/attempt-alarm-schedule";
import { readStagedResultSummary } from "../src/results/staged-assessment-results";
import { readAttemptResultsByAttempt } from "../src/routes/instructor/services/roster-data";
import { STATE_KEY, type StoredAttemptState } from "../src/attempts/attempt-state-bootstrap";
import { TestSessionRuntime } from "../src/attempts/test-session-runtime";
import { advanceTestSequenceAnswer } from "../src/attempts/test-session-delivery";
import { abortAllDurableObjects, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import type {
  AssignmentHistoryResponse,
  CommitAttemptEventReceipt,
} from "@harbor/attempt-protocol";
import {
  buildSubmitFinalizationEnvelope,
  processSubmitFinalizationEnvelope,
} from "../src/queues/submit-finalization";
import { setupStagedTests, launch, request, answer } from "./staged-assessment-harness";
import type { Env } from "../src/index";

beforeAll(setupStagedTests);
// Bindings are supplied by the actual workerd integration harness in vitest.config.ts.
const runtime = env as unknown as Env;

it("reports only the completed 15-question route with frozen difficulty labels", async () => {
  const boot = await launch();
  let current = boot.session.currentItemRef;
  let final: CommitAttemptEventReceipt | undefined;
  for (let index = 0; index < 15; index++) {
    const response = await request(
      `/api/attempts/${boot.attemptId}/events`,
      answer(boot.attemptId, current, index + 1, "A"),
    );
    expect(response.status).toBe(200);
    const receipt = await response.json<CommitAttemptEventReceipt>();
    current = receipt.currentItemRef;
    final = receipt;
  }
  if (!final) throw new Error("No final receipt.");
  const pending = await (
    await request(`/api/attempts/${boot.attemptId}/history`)
  ).json<AssignmentHistoryResponse>();
  expect(pending.attempts[0]).toMatchObject({
    resultStatus: "pending",
    answeredItemCount: 15,
    itemCount: 15,
  });
  await processSubmitFinalizationEnvelope(
    buildSubmitFinalizationEnvelope({ eventType: "submit.requested", receipt: final }),
    runtime,
  );
  const historyResponse = await request(`/api/attempts/${boot.attemptId}/history`);
  expect(historyResponse.status, await historyResponse.clone().text()).toBe(200);
  const history = await historyResponse.json<AssignmentHistoryResponse>();
  const result = history.attempts[0];
  const records = await readAttemptResultsByAttempt(runtime.HARBOR_DB, [boot.attemptId]);
  const storedResult = records.get(boot.attemptId);
  expect(storedResult?.is_sequenced).toBe(1);
  if (!storedResult) throw new Error("Missing finalized result.");
  expect(await readStagedResultSummary(runtime.HARBOR_DB, storedResult.attempt_result_id)).toEqual(
    result?.stagedAssessment,
  );
  expect(result?.maxScore).toBe(15);
  expect(result?.totalScore).toBe(15);
  expect(result?.items).toHaveLength(15);
  expect(result?.stagedAssessment).toEqual({
    target: 15,
    answered: 15,
    complete: true,
    audience: "Synthetic grade 6 science",
    levels: [
      { id: "easy", label: "Easy", answered: 5, correct: 5 },
      { id: "moderate", label: "Moderate", answered: 5, correct: 5 },
      { id: "hard", label: "Hard", answered: 5, correct: 5 },
    ],
    route: ["Easy", "Moderate", "Hard"],
  });
});

it("early finish counts committed answers and the current unanswered question, excluding alternatives", async () => {
  const boot = await launch();
  const first = await request(
    `/api/attempts/${boot.attemptId}/events`,
    answer(boot.attemptId, boot.session.currentItemRef, 1, "A"),
  );
  const accepted = await first.json<CommitAttemptEventReceipt>();
  const event = answer(boot.attemptId, accepted.currentItemRef, 2, "A");
  const response = await request(`/api/attempts/${boot.attemptId}/events`, {
    ...event,
    type: "submit.requested",
    payload: {},
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const final = await response.json<CommitAttemptEventReceipt>();
  await processSubmitFinalizationEnvelope(
    buildSubmitFinalizationEnvelope({ eventType: "submit.requested", receipt: final }),
    runtime,
  );
  const history = await (
    await request(`/api/attempts/${boot.attemptId}/history`)
  ).json<AssignmentHistoryResponse>();
  expect(history.attempts[0]?.stagedAssessment).toMatchObject({
    target: 15,
    answered: 1,
    complete: false,
    route: ["Easy"],
  });
  expect(history.attempts[0]?.items.map((item) => item.answered)).toEqual([true, false]);
  expect(history.attempts[0]?.maxScore).toBe(2);
});

it("a hard deadline alarm after promotion ends the delivered route without accepting the next answer", async () => {
  const boot = await launch();
  let current = boot.session.currentItemRef;
  for (let index = 0; index < 5; index++) {
    const accepted = await (
      await request(
        `/api/attempts/${boot.attemptId}/events`,
        answer(boot.attemptId, current, index + 1, "A"),
      )
    ).json<CommitAttemptEventReceipt>();
    current = accepted.currentItemRef;
  }
  expect(current.itemId).toBe("stage1_level1_0");
  const stub = runtime.ATTEMPT_COORDINATOR.get(
    runtime.ATTEMPT_COORDINATOR.idFromName(boot.attemptId),
  );
  const scopeKey = await runInDurableObject(stub, async (_instance, durable) => {
    const stored = await durable.storage.get<StoredAttemptState>(STATE_KEY);
    if (!stored) throw new Error("Missing stored attempt.");
    const scope = stored.scopedTiming.scopes.find((entry) => entry.scopeType === "assessment-test");
    if (!scope) throw new Error("Missing assessment timing scope.");
    // Advance the real stored deadline, avoiding wall-clock sleeps or a mocked coordinator.
    scope.deadlineAt = new Date(Date.now() - 1000).toISOString();
    scope.allowLateSubmission = false;
    scope.unlimited = false;
    await durable.storage.transaction(async (txn) => {
      await txn.put(STATE_KEY, stored);
      await reconcileAttemptAlarm(txn);
    });
    return scope.key;
  });
  // The server now closes the route independently of a browser auto-submit request.
  await runDurableObjectAlarm(stub);
  await expect
    .poll(async () =>
      runInDurableObject(
        stub,
        async (_instance, durable) =>
          (await durable.storage.get<StoredAttemptState>(STATE_KEY))?.attemptStatus,
      ),
    )
    .toBe("submitted");
  const nextAnswer = answer(boot.attemptId, current, 6, "A");
  const rejected = await request(`/api/attempts/${boot.attemptId}/events`, nextAnswer);
  expect(rejected.status).toBe(200);
  await expect(rejected.json()).resolves.toMatchObject({
    outcome: "late_preserved",
    attemptStatus: "submitted",
  });
  const automatic = {
    ...nextAnswer,
    type: "timing.auto-submit.requested",
    payload: {
      requestedAt: new Date().toISOString(),
      reason: "max-time-reached",
      scopeKey,
    },
  };
  const submitted = await request(`/api/attempts/${boot.attemptId}/events`, automatic);
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  const replay = await submitted.json<{
    outcome: "duplicate";
    storedReceipt: CommitAttemptEventReceipt;
  }>();
  expect(replay.outcome).toBe("duplicate");
  const receipt = replay.storedReceipt;
  expect(receipt.attemptStatus).toBe("submitted");
  expect(receipt.currentItemRef).toEqual(current);
  await processSubmitFinalizationEnvelope(
    buildSubmitFinalizationEnvelope({ eventType: "timing.auto-submit.requested", receipt }),
    runtime,
  );
  const history = await (
    await request(`/api/attempts/${boot.attemptId}/history`)
  ).json<AssignmentHistoryResponse>();
  expect(history.attempts[0]?.stagedAssessment).toMatchObject({
    answered: 5,
    target: 15,
    complete: false,
    route: ["Easy", "Moderate"],
  });
  expect(history.attempts[0]?.items.map((item) => item.answered)).toEqual([
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  expect(history.attempts[0]?.maxScore).toBe(6);
});

it("concurrent stale tabs commit one answer, and a lost receipt can be recovered without advancing twice", async () => {
  const boot = await launch();
  const command = answer(boot.attemptId, boot.session.currentItemRef, 1, "A");
  const responses = await Promise.all([
    request(`/api/attempts/${boot.attemptId}/events`, command),
    request(`/api/attempts/${boot.attemptId}/events`, {
      ...answer(boot.attemptId, boot.session.currentItemRef, 1, "B"),
      clientSessionId: "other_tab",
    }),
  ]);
  const outcomes = await Promise.all(
    responses.map((response) => response.json<{ outcome: string }>()),
  );
  expect(outcomes.filter((result) => result.outcome === "accepted")).toHaveLength(1);
  expect(outcomes.filter((result) => result.outcome === "stale_session")).toHaveLength(1);
  await abortAllDurableObjects();
  const manifest = await (
    await request(`/api/content/manifest?attemptId=${boot.attemptId}`)
  ).json<{ testSequence: { answered: number } }>();
  expect(manifest.testSequence.answered).toBe(1);
  if (outcomes[0]?.outcome === "accepted") {
    const retry = await request(`/api/attempts/${boot.attemptId}/events`, command);
    expect((await retry.json<{ outcome: string }>()).outcome).toBe("duplicate");
  }
});

it("an interruption after routing but before persistence retains the previous frontier", async () => {
  const boot = await launch();
  let current = boot.session.currentItemRef;
  for (let index = 0; index < 4; index++) {
    const accepted = await (
      await request(
        `/api/attempts/${boot.attemptId}/events`,
        answer(boot.attemptId, current, index + 1, "A"),
      )
    ).json<CommitAttemptEventReceipt>();
    current = accepted.currentItemRef;
  }
  const command = answer(boot.attemptId, current, 5, "A");
  const stub = runtime.ATTEMPT_COORDINATOR.get(
    runtime.ATTEMPT_COORDINATOR.idFromName(boot.attemptId),
  );
  await runInDurableObject(stub, async (_instance, durable) => {
    const stored = await durable.storage.get<StoredAttemptState>(STATE_KEY);
    if (!stored?.testSequence) throw new Error("Missing stored test.");
    const executor = new TestSessionRuntime(runtime.CONTENT_BUCKET);
    const computed = await advanceTestSequenceAnswer({
      bucket: runtime.CONTENT_BUCKET,
      runtime: executor,
      state: stored,
      event: command,
      at: new Date().toISOString(),
    });
    expect(computed.currentItemRef.itemId).toBe("stage1_level1_0");
    // Leave the computed transition uncommitted, as an interruption before storage.put would.
    const stillStored = await durable.storage.get<StoredAttemptState>(STATE_KEY);
    expect(stillStored?.highestCommittedSequence).toBe(4);
    const recovered = await executor.restore(
      stored.testSequence.descriptor.objectKey,
      stored.testSequence.snapshot,
    );
    expect(recovered.session.status === "active" && recovered.session.currentItemRef).toBe(
      "stage0_level0_item4",
    );
  });
  await abortAllDurableObjects();
  const committed = await (
    await request(`/api/attempts/${boot.attemptId}/events`, command)
  ).json<CommitAttemptEventReceipt>();
  expect(committed.outcome).toBe("accepted");
  expect(committed.currentItemRef.itemId).toBe("stage1_level1_0");
  expect(
    (
      await (
        await request(`/api/attempts/${boot.attemptId}/events`, command)
      ).json<{ outcome: string }>()
    ).outcome,
  ).toBe("duplicate");
});
