import JSZip from "jszip";
import { applyD1Migrations, env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { expect, it } from "vitest";
import type {
  AttemptSubmissionMaterializationInput,
  BootstrapEnvelope,
  BootstrapPayload,
} from "@harbor/attempt-protocol";
import { mergeSubmissionMaterialization } from "../src/attempts/attempt-materialization";
import { ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER } from "../src/attempts/attempt-durable-object";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

function materialization(itemOrder: string[]): AttemptSubmissionMaterializationInput {
  return { itemOrder, testState: null, partStates: {}, sectionStates: {}, items: {} };
}

it.each([
  ["reversed", ["three", "two", "one"]],
  ["shortened", ["one"]],
  ["foreign", ["unknown"]],
  ["duplicated", ["one", "one", "three"]],
  ["empty", []],
] as const)("retains the server order when the client sends a %s inventory", (_name, order) => {
  const existing = materialization(["three", "one", "two"]);
  const incoming = materialization([...order]);
  incoming.items.one = {
    itemId: "one",
    itemIdentifier: "one",
    itemTitle: "One",
    capturedAt: null,
    responseVariables: [{ identifier: "RESPONSE", value: "C" }],
    outcomeVariables: [{ identifier: "SCORE", value: 999 }],
    validationMessages: [],
  };
  const before = JSON.stringify({ existing, incoming });
  const merged = mergeSubmissionMaterialization(existing, incoming);
  expect(merged.itemOrder).toEqual(["three", "one", "two"]);
  expect(merged.items.one?.responseVariables).toEqual([{ identifier: "RESPONSE", value: "C" }]);
  expect(merged.items.one?.outcomeVariables).toEqual([]);
  expect(JSON.stringify({ existing, incoming })).toBe(before);
});

async function post(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

it.each([
  ["reversed", ["item-3", "item-2", "item-1"]],
  ["shortened", ["item-1"]],
] as const)(
  "durably submits all published questions after a %s client inventory",
  async (name, order) => {
    await applyD1Migrations(env.HARBOR_DB, env.TEST_MIGRATIONS);
    const zip = new JSZip();
    zip.file(
      "imsmanifest.xml",
      `<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="order-authority"><resources>${[1, 2, 3].map((n) => `<resource identifier="item-${n}" type="imsqti_item_xmlv3p0" href="items/item-${n}.xml"><file href="items/item-${n}.xml"/></resource>`).join("")}</resources></manifest>`,
    );
    for (const n of [1, 2, 3])
      zip.file(
        `items/item-${n}.xml`,
        itemXml.replace('identifier="item-1"', `identifier="item-${n}"`),
      );
    zip.file("assets/stimulus.svg", stimulusSvg);
    const published = await workerExports.default.fetch(
      new Request(`https://harbor.local/internal/publish?assessmentSlug=order-${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-harbor-package-name": "order.zip",
          "x-harbor-tenant-id": `tenant_order_${name}`,
        },
        body: await zip.generateAsync({ type: "arraybuffer" }),
      }),
    );
    expect(published.status, await published.clone().text()).toBe(201);
    const version = await published.json<{ assessmentVersionId: string }>();
    const launch = await post("/api/launch/preview", {
      mode: "preview",
      assessmentVersionId: version.assessmentVersionId,
      actor: { kind: "preview-operator", id: "order-reader", displayName: "Reader" },
    });
    expect(launch.status).toBe(201);
    const envelope = await launch.json<BootstrapEnvelope>();
    const bootstrap = await post("/api/bootstrap", {
      bootstrapToken: envelope.bootstrapToken,
      clientSessionId: "order_client",
    });
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();
    const submitted = await post(`/api/attempts/${payload.attemptId}/events`, {
      attemptId: payload.attemptId,
      eventId: "submit_order",
      idempotencyKey: "submit_order",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "order_client",
      itemRef: payload.session.currentItemRef,
      type: "submit.requested",
      payload: { submissionMaterialization: materialization([...order]) },
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect(await submitted.json()).toMatchObject({
      outcome: "accepted",
      highestCommittedSequence: 1,
      attemptStatus: "submitted",
    });
    const stub = env.ATTEMPT_COORDINATOR.get(env.ATTEMPT_COORDINATOR.idFromName(payload.attemptId));
    for (let read = 0; read < 2; read++) {
      const result = await stub.fetch("https://harbor-attempt.local/result-materialization", {
        headers: { [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: payload.attemptId },
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        submissionMaterialization: { itemOrder: ["item-1", "item-2", "item-3"] },
      });
    }
  },
);
