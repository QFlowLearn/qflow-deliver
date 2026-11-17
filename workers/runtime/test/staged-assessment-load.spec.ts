import { beforeAll, expect, it } from "vitest";
import { abortAllDurableObjects } from "cloudflare:test";
import type { CommitAttemptEventReceipt } from "@harbor/attempt-protocol";
import qflowPackage from "../../../tests/fixtures/qti/staged-assessment/qflow-100.zip.b64?raw";
import {
  setupStagedTests,
  publishTestPackage,
  launchPublished,
  request,
  answer,
} from "./staged-assessment-harness";

beforeAll(setupStagedTests);

it("routes 25 concurrent attempts through two groups without repeated questions", async () => {
  const version = await publishTestPackage(
    Uint8Array.from(atob(qflowPackage), (c) => c.charCodeAt(0)),
  );
  const boots = await Promise.all(Array.from({ length: 25 }, () => launchPublished(version)));
  await abortAllDurableObjects();
  const timings: number[] = [],
    cold: number[] = [],
    boundaries: number[] = [];
  await Promise.all(
    boots.map(async (boot, learner) => {
      let current = boot.session.currentItemRef;
      const seen = new Set<string>();
      for (let index = 0; index < 10; index++) {
        expect(seen.has(current.itemId)).toBe(false);
        seen.add(current.itemId);
        const start = performance.now();
        const response = await request(
          `/api/attempts/${boot.attemptId}/events`,
          answer(boot.attemptId, current, index + 1, learner % 2 ? "b" : "a"),
        );
        expect(response.status, await response.clone().text()).toBe(200);
        const receipt = await response.json<CommitAttemptEventReceipt>();
        const elapsed = performance.now() - start;
        timings.push(elapsed);
        if (index === 0) cold.push(elapsed);
        if (index % 5 === 4) boundaries.push(elapsed);
        expect(receipt.outcome).toBe("accepted");
        expect(receipt.attemptStatus).toBe("active");
        current = receipt.currentItemRef;
      }
      expect(seen.size).toBe(10);
    }),
  );
  const stats = (samples: number[]) => {
    samples.sort((a, b) => a - b);
    return {
      count: samples.length,
      p50: Math.round(samples[Math.floor(samples.length * 0.5)]!),
      p95: Math.round(samples[Math.floor(samples.length * 0.95)]!),
    };
  };
  console.log(
    JSON.stringify({
      environment:
        "local workerd; 25 concurrent 100-question attempts, 10 answers each; milliseconds including test HTTP and durable receipt",
      all: stats(timings),
      cold: stats(cold),
      boundaries: stats(boundaries),
    }),
  );
}, 180000);
