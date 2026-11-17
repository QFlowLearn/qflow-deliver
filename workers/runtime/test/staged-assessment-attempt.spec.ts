import { beforeAll, expect, it } from "vitest";
import type { BootstrapPayload, CommitAttemptEventReceipt } from "@harbor/attempt-protocol";
import { setupStagedTests, launch, request, answer } from "./staged-assessment-harness";
beforeAll(setupStagedTests);

it("scores 15 answers, promotes then demotes, resumes, and never delivers alternatives", async () => {
  const boot = await launch();
  let current = boot.session.currentItemRef;
  const visited: string[] = [];
  for (let index = 0; index < 15; index++) {
    visited.push(current.itemId);
    const manifestResponse = await request(`/api/content/manifest?attemptId=${boot.attemptId}`);
    expect(manifestResponse.status).toBe(200);
    const manifest = await manifestResponse.json<{
      itemOrder: string[];
      testSequence: { answered: number; target: number };
    }>();
    expect(manifest.itemOrder).toEqual([current.itemId]);
    expect(manifest.testSequence).toEqual({ answered: index, target: 15 });
    const event = answer(boot.attemptId, current, index + 1, index < 5 ? "A" : "B");
    const response = await request(`/api/attempts/${boot.attemptId}/events`, event);
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = await response.json<CommitAttemptEventReceipt>();
    expect(receipt.outcome).toBe("accepted");
    expect(receipt.attemptStatus).toBe(index === 14 ? "submitted" : "active");
    if (index === 4) {
      const duplicate = await request(`/api/attempts/${boot.attemptId}/events`, event);
      const replay = await duplicate.json<{
        outcome: string;
        storedReceipt: CommitAttemptEventReceipt;
      }>();
      expect(replay.outcome).toBe("duplicate");
      expect(replay.storedReceipt.receiptId).toBe(receipt.receiptId);
      const session = await request("/api/bootstrap", { bootstrapToken: boot.bootstrapToken });
      expect(session.status, await session.clone().text()).toBe(200);
      expect(await session.json()).toMatchObject({
        session: { currentItemRef: receipt.currentItemRef },
      });
    }
    current = receipt.currentItemRef;
  }
  expect(visited).toEqual(
    ["stage0_level0", "stage1_level1", "stage2_level0"].flatMap((block) =>
      Array.from({ length: 5 }, (_, index) => `${block}_${index}`),
    ),
  );
  expect(new Set(visited).size).toBe(15);
});

it("rejects invalid answers, arbitrary navigation and future item access without advancing", async () => {
  const boot = await launch();
  const event = answer(boot.attemptId, boot.session.currentItemRef, 1, "UNKNOWN");
  const invalid = await request(`/api/attempts/${boot.attemptId}/events`, event);
  expect(invalid.status).toBe(422);
  const future = await request(`/api/content/items/stage2_level2_0?attemptId=${boot.attemptId}`);
  expect(future.status).toBe(403);
  const navigation = await request(`/api/attempts/${boot.attemptId}/events`, {
    ...event,
    type: "navigation.requested",
    payload: {
      targetItemRef: { itemId: "stage2_level2_0", itemHref: "items/stage2_level2_0.xml" },
    },
  });
  expect(navigation.status).toBe(409);
  const valid = await request(
    `/api/attempts/${boot.attemptId}/events`,
    answer(boot.attemptId, boot.session.currentItemRef, 1, "A"),
  );
  expect(valid.status, await valid.clone().text()).toBe(200);
  expect(await valid.json()).toMatchObject({
    highestCommittedSequence: 1,
    currentItemRef: { itemId: "stage0_level0_1" },
  });
});
