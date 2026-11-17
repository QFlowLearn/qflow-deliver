import JSZip from "jszip";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import type {
  AttemptSubmissionMaterializationInput,
  BootstrapEnvelope,
  BootstrapPayload,
  CommitAttemptEventReceipt,
} from "@harbor/attempt-protocol";
import type { DeliveryManifest } from "@harbor/content-model";
import runtimeWorker from "../src/index";
import {
  consumeSubmitFinalizationBatch,
  SUBMIT_FINALIZATION_QUEUE_NAME,
  type SubmitFinalizationEnvelope,
} from "../src/queues/submit-finalization";
import { createQueueMock } from "./queue-mock";
import singleXml from "../../../tests/fixtures/qti/choice-points/single.xml?raw";
import multipleXml from "../../../tests/fixtures/qti/choice-points/multiple.xml?raw";
import practiceXml from "../../../tests/fixtures/qti/choice-points/practice.xml?raw";

// Synthetic canonical writer output: 3-point matching, 2.5-point mapping and
// zero-point practice. Literal expectations retain the authored no-wrong-penalty policy.
const items = ["single", "multiple", "practice"] as const;

async function post(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function launch(name: string): Promise<BootstrapPayload> {
  const zip = new JSZip();
  zip.file(
    "imsmanifest.xml",
    `<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="choice-points"><resources>${items.map((id) => `<resource identifier="${id}" type="imsqti_item_xmlv3p0" href="items/${id}.xml"><file href="items/${id}.xml"/></resource>`).join("")}</resources></manifest>`,
  );
  zip.file("items/single.xml", singleXml);
  zip.file("items/multiple.xml", multipleXml);
  zip.file("items/practice.xml", practiceXml);
  const published = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=points-${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "points.zip",
        "x-harbor-tenant-id": `tenant_points_${name}`,
      },
      body: await zip.generateAsync({ type: "arraybuffer" }),
    }),
  );
  expect(published.status, await published.clone().text()).toBe(201);
  const version = await published.json<{ assessmentVersionId: string }>();
  const launched = await post("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: version.assessmentVersionId,
    actor: { kind: "preview-operator", id: "points-reader", displayName: "Reader" },
  });
  expect(launched.status).toBe(201);
  const envelope = await launched.json<BootstrapEnvelope>();
  const bootstrapped = await post("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: "points_client",
  });
  expect(bootstrapped.status).toBe(200);
  return bootstrapped.json<BootstrapPayload>();
}

beforeEach(async () => {
  await applyD1Migrations(env.HARBOR_DB, env.TEST_MIGRATIONS);
});

it.each([
  { name: "full", single: "A", multiple: ["A", "B"], scores: [3, 2.5, 0], total: 5.5 },
  { name: "mixed", single: "A", multiple: ["A", "C"], scores: [3, 1.25, 0], total: 4.25 },
  { name: "all-selected", single: "C", multiple: ["A", "B", "C"], scores: [0, 2.5, 0], total: 2.5 },
  { name: "wrong", single: "C", multiple: ["C"], scores: [0, 0, 0], total: 0 },
  { name: "unanswered", single: null, multiple: [], scores: [0, 0, 0], total: 0 },
])(
  "preserves published points and authoritative $name grades through result retries",
  async (test) => {
    const payload = await launch(test.name);
    const attempt = await env.HARBOR_DB.prepare(
      "SELECT manifest_object_key FROM attempt_entries WHERE id = ?",
    )
      .bind(payload.attemptId)
      .first<{ manifest_object_key: string }>();
    if (!attempt) throw new Error("Expected the published attempt.");
    const object = await env.CONTENT_BUCKET.get(attempt.manifest_object_key);
    if (!object) throw new Error("Expected the immutable manifest.");
    const manifest = await object.json<DeliveryManifest>();
    expect(manifest.itemOrder).toEqual(["single", "multiple", "practice"]);
    expect(items.map((id) => manifest.items[id]?.maxScore)).toEqual([3, 2.5, 0]);

    const values = [test.single, test.multiple, "A"];
    const materialization: AttemptSubmissionMaterializationInput = {
      itemOrder: ["practice"],
      testState: {
        identifier: "test",
        responseVariables: [],
        outcomeVariables: [{ identifier: "SCORE", value: 999 }],
      },
      partStates: {},
      sectionStates: {},
      items: Object.fromEntries(
        items.map((id, index) => [
          id,
          {
            itemId: id,
            itemIdentifier: id,
            itemTitle: id,
            capturedAt: null,
            responseVariables: [{ identifier: "RESPONSE", value: values[index] ?? null }],
            outcomeVariables: [
              { identifier: "SCORE", value: 999 },
              { identifier: "MAXSCORE", value: 999 },
            ],
            validationMessages: [],
          },
        ]),
      ),
    };
    const queued: SubmitFinalizationEnvelope[] = [];
    const runtimeEnv = {
      ...env,
      SUBMIT_FINALIZATION_QUEUE: createQueueMock<SubmitFinalizationEnvelope>({
        send: async (message) => {
          queued.push(message);
        },
      }),
    };
    const ctx = createExecutionContext();
    const submitted = await runtimeWorker.fetch(
      new Request(`https://harbor.local/api/attempts/${payload.attemptId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: payload.attemptId,
          eventId: "submit_points",
          idempotencyKey: "submit_points",
          sequenceNumber: 1,
          clientTimestamp: new Date().toISOString(),
          clientSessionId: "points_client",
          itemRef: payload.session.currentItemRef,
          type: "submit.requested",
          payload: { submissionMaterialization: materialization },
        }),
      }),
      runtimeEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const receipt = await submitted.json<CommitAttemptEventReceipt>();
    expect(receipt).toMatchObject({ outcome: "accepted", attemptStatus: "submitted" });
    expect(queued).toHaveLength(1);
    const message = queued[0];
    if (!message) throw new Error("Expected durable submit finalization.");
    for (const delivery of [1, 2]) {
      await consumeSubmitFinalizationBatch(
        createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
          {
            id: `points_${delivery}`,
            timestamp: new Date(receipt.serverTimestamp),
            attempts: delivery,
            body: message,
          },
        ]),
        runtimeEnv,
      );
      const result = await env.HARBOR_DB.prepare(
        "SELECT id, summary_source, total_score, max_score FROM attempt_results WHERE attempt_id = ?",
      )
        .bind(payload.attemptId)
        .all();
      expect(result.results).toEqual([
        expect.objectContaining({
          summary_source: "authoritative-qti-snapshot",
          total_score: test.total,
          max_score: 5.5,
        }),
      ]);
      const saved = await env.HARBOR_DB.prepare(
        "SELECT i.item_id, i.score, i.max_score FROM attempt_result_items i JOIN attempt_results r ON r.id = i.attempt_result_id WHERE r.attempt_id = ? ORDER BY i.item_id",
      )
        .bind(payload.attemptId)
        .all();
      expect(saved.results).toEqual([
        { item_id: "multiple", score: test.scores[1], max_score: 2.5 },
        { item_id: "practice", score: 0, max_score: 0 },
        { item_id: "single", score: test.scores[0], max_score: 3 },
      ]);
    }
  },
);
