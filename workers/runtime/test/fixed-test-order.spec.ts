import { ids, xml, createFixedOrderPackage } from "../../../tests/fixtures/qti/fixed-order-fixture";
import { applyD1Migrations, env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { parseQtiFixedTestOrdering, prepareQtiFixedTestOrder } from "@longsightgroup/qti3-core";
import { parseFixedTestOrderDescriptor, type DeliveryManifest } from "@harbor/content-model";
import type { BootstrapEnvelope, BootstrapPayload } from "@harbor/attempt-protocol";
import { FixedTestOrderRuntime } from "../src/attempts/fixed-test-order-runtime";
import { ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER } from "../src/attempts/attempt-durable-object";
import { scoreSubmissionWithAuthoritativeQti } from "../src/results/qti-server-scoring";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const descriptor = {
  objectKey: "fixed-ordering/test.xml",
  testHref: "test.xml",
  itemIdsByRef: Object.fromEntries(ids.map((id) => [`ref_${id}`, id])),
};
const itemRefs = ids.map((id) => ({ itemId: id, itemHref: `items/${id}.xml` }));

it("parses exact optional published descriptors and refuses corrupt bindings", () => {
  expect(parseFixedTestOrderDescriptor(undefined)).toEqual({ ok: true, value: undefined });
  expect(parseFixedTestOrderDescriptor(descriptor)).toEqual({ ok: true, value: descriptor });
  for (const input of [
    null,
    [],
    {},
    { ...descriptor, extra: 1 },
    { ...descriptor, objectKey: "" },
    { ...descriptor, testHref: "../foreign.xml" },
    { ...descriptor, testHref: "https://outside.test/test.xml" },
    { ...descriptor, itemIdsByRef: {} },
    { ...descriptor, itemIdsByRef: { one: "A", two: "A" } },
    { ...descriptor, itemIdsByRef: { one: 2 } },
  ]) {
    expect(parseFixedTestOrderDescriptor(input)).toMatchObject({ ok: false });
  }
});

it("generates shared section permutations and restores them with a fresh runtime, preserving fixed and authored slots", async () => {
  await env.CONTENT_BUCKET.put(descriptor.objectKey, xml);
  const runtime = new FixedTestOrderRuntime(env.CONTENT_BUCKET);
  const before = JSON.stringify({ descriptor, itemRefs });
  const variations = new Set<string>();
  for (let seed = 0; seed < 20; seed++) {
    const generated = await runtime.prepare(descriptor, itemRefs, { kind: "new", seed });
    const order = generated.itemRefs.map((item) => item.itemId);
    expect(order[1]).toBe("B");
    expect(order.slice(4, 6)).toEqual(["E", "F"]);
    expect(new Set(order.slice(0, 4))).toEqual(new Set(ids.slice(0, 4)));
    expect(new Set(order.slice(6))).toEqual(new Set(ids.slice(6)));
    variations.add(order.join(","));
    const saved: unknown = JSON.parse(
      JSON.stringify({ descriptor: generated.descriptor, order: generated.order }),
    );
    const restored = await new FixedTestOrderRuntime(env.CONTENT_BUCKET).restore(saved, itemRefs);
    expect(restored).toEqual(generated);
  }
  expect(variations.size).toBeGreaterThan(1);
  expect(JSON.stringify({ descriptor, itemRefs })).toBe(before);
  const generated = await runtime.prepare(descriptor, itemRefs, { kind: "new", seed: 42 });
  const movedFixed = {
    ...generated.order,
    sections: generated.order.sections.map((section, index) =>
      index ? section : { ...section, itemRefs: ["ref_B", "ref_A", "ref_C", "ref_D"] },
    ),
  };
  await expect(runtime.restore({ descriptor, order: movedFixed }, itemRefs)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    runtime.prepare(
      { ...descriptor, itemIdsByRef: { ...descriptor.itemIdsByRef, ref_A: "C", ref_C: "A" } },
      itemRefs,
      { kind: "restore", state: generated.order },
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    runtime.prepare(descriptor, itemRefs, { kind: "new", seed: undefined }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    runtime.restore({ descriptor, order: generated.order, extra: true }, itemRefs),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    runtime.restore({ descriptor, order: generated.order }, [null]),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    runtime.restore({ descriptor, order: generated.order }, { itemRefs }),
  ).rejects.toMatchObject({ status: 409 });
  const reorderedKeys = itemRefs.map((ref) => ({ itemHref: ref.itemHref, itemId: ref.itemId }));
  expect(
    (await runtime.restore({ descriptor, order: generated.order }, reorderedKeys)).order,
  ).toEqual(generated.order);
});

async function post(path: string, body: unknown) {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
async function content(attemptId: string) {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/api/content/manifest?attemptId=${attemptId}`),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<{
    itemOrder: string[];
    currentItemId: string;
    items: Record<string, { itemHref: string }>;
  }>();
}
async function bootstrap(accessCode: string, actorId: string, clientSessionId: string) {
  const launch = await post("/api/launch/access-code", {
    accessCode,
    actor: { kind: "access-code-candidate", id: actorId, displayName: "Reader" },
  });
  expect(launch.status, await launch.clone().text()).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const response = await post("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<BootstrapPayload>();
}

it("publishes immutable policy and preserves authoritative learner order, current item, timing and scoring through navigation and relaunch", async () => {
  await applyD1Migrations(env.HARBOR_DB, env.TEST_MIGRATIONS);
  const published = await workerExports.default.fetch(
    new Request("https://harbor.local/internal/publish?assessmentSlug=fixed-shuffle", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "shuffle.zip",
        "x-harbor-tenant-id": "tenant_fixed_shuffle",
      },
      body: await createFixedOrderPackage(itemXml, stimulusSvg, xml),
    }),
  );
  expect(published.status, await published.clone().text()).toBe(201);
  const version = await published.json<{
    assessmentVersionId: string;
    manifestObjectKey: string;
  }>();
  const manifestObject = await env.CONTENT_BUCKET.get(version.manifestObjectKey);
  expect(manifestObject).not.toBeNull();
  const frozen = await manifestObject?.text();
  const manifest = await (
    await env.CONTENT_BUCKET.get(version.manifestObjectKey)
  )?.json<DeliveryManifest>();
  if (!manifest?.fixedTestOrder) throw new Error("Published ordering descriptor missing");
  expect(manifest.itemOrder).toEqual(ids);
  const executionObject = await env.CONTENT_BUCKET.get(manifest.fixedTestOrder.objectKey);
  expect(await executionObject?.text()).toBe(xml);
  const issued = await post("/internal/access-codes", {
    assessmentVersionId: version.assessmentVersionId,
    code: "FIXED-SHUFFLE",
  });
  expect(issued.status).toBe(201);
  const { accessCode } = await issued.json<{ accessCode: string }>();
  const first = await bootstrap(accessCode, "reader_one", "shuffle_client");
  const initial = await content(first.attemptId);
  const parsed = parseQtiFixedTestOrdering(xml);
  if (!parsed.ok) throw new Error("Synthetic ordering is invalid");
  const expected = prepareQtiFixedTestOrder(parsed.value, { kind: "new", seed: first.attemptId });
  if (!expected.ok) throw new Error("Synthetic ordering did not generate");
  const expectedIds = expected.value.sections.flatMap((section) =>
    section.itemRefs.map((ref) => manifest.fixedTestOrder?.itemIdsByRef[ref]),
  );
  expect(initial.itemOrder).toEqual(expectedIds);
  expect(first.session.currentItemRef.itemId).toBe(initial.itemOrder[0]);
  expect(initial.currentItemId).toBe(first.session.currentItemRef.itemId);
  const activeItem = first.session.timing?.scopes?.find(
    (scope) => scope.scopeType === "assessment-item-ref" && scope.status === "interacting",
  );
  expect(activeItem?.itemId).toBe(first.session.currentItemRef.itemId);
  const nextId = initial.itemOrder[1];
  if (!nextId) throw new Error("Synthetic order has no second item");
  const navigation = await post(`/api/attempts/${first.attemptId}/events`, {
    attemptId: first.attemptId,
    eventId: "shuffle_nav",
    idempotencyKey: "shuffle_nav",
    sequenceNumber: 1,
    clientTimestamp: new Date().toISOString(),
    clientSessionId: "shuffle_client",
    itemRef: first.session.currentItemRef,
    type: "navigation.requested",
    payload: { targetItemRef: { itemId: nextId, itemHref: initial.items[nextId]?.itemHref } },
  });
  expect(navigation.status, await navigation.clone().text()).toBe(200);
  const transfer = await post(`/internal/attempts/${first.attemptId}/actions`, {
    actionId: "shuffle-transfer",
    type: "transfer-workstation",
    clientSessionId: "shuffle_client_2",
    actor: { role: "operator", actorId: "test-supervision" },
    reason: "Replace workstation",
    effectiveAt: new Date().toISOString(),
  });
  expect(transfer.status).toBe(200);
  const resumed = await bootstrap(accessCode, "reader_one", "shuffle_client_2");
  expect(resumed.attemptId).toBe(first.attemptId);
  expect(resumed.session.currentItemRef.itemId).toBe(nextId);
  expect(resumed.session.sequence?.nextSequence).toBe(2);
  const reloaded = await content(resumed.attemptId);
  expect(reloaded.itemOrder).toEqual(initial.itemOrder);
  expect(reloaded.currentItemId).toBe(nextId);
  const freshLaunch = await post("/api/launch/access-code", {
    accessCode,
    actor: { kind: "access-code-candidate", id: "reader_two", displayName: "Reader" },
  });
  expect(freshLaunch.status).toBe(201);
  const freshEnvelope = await freshLaunch.json<BootstrapEnvelope>();
  const seed = await env.HARBOR_DB.prepare(
    "SELECT id FROM attempt_entries WHERE assessment_version_id = ? AND actor_id = ?",
  )
    .bind(version.assessmentVersionId, "reader_two")
    .first<{ id: string }>();
  if (!seed) throw new Error("Fresh attempt seed missing");
  const [concurrentOne, concurrentTwo, freshBootstrap] = await Promise.all([
    content(seed.id),
    content(seed.id),
    post("/api/bootstrap", {
      bootstrapToken: freshEnvelope.bootstrapToken,
      clientSessionId: "shuffle_other",
    }),
  ]);
  expect(freshBootstrap.status, await freshBootstrap.clone().text()).toBe(200);
  const second = await freshBootstrap.json<BootstrapPayload>();
  expect(concurrentOne.itemOrder).toEqual(concurrentTwo.itemOrder);
  expect(second.session.currentItemRef.itemId).toBe(concurrentOne.currentItemId);
  expect(
    await env.HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM attempt_evidence_events WHERE attempt_id = ? AND event_type = ?",
    )
      .bind(second.attemptId, "timing.policy.created")
      .first<{ count: number }>(),
  ).toEqual({ count: 1 });
  expect(second.attemptId).not.toBe(first.attemptId);
  const secondContent = await content(second.attemptId);
  const secondExpected = prepareQtiFixedTestOrder(parsed.value, {
    kind: "new",
    seed: second.attemptId,
  });
  if (!secondExpected.ok) throw new Error("Second ordering did not generate");
  expect(secondContent.itemOrder).toEqual(
    secondExpected.value.sections.flatMap((section) =>
      section.itemRefs.map((ref) => manifest.fixedTestOrder?.itemIdsByRef[ref]),
    ),
  );
  const submitted = await post(`/api/attempts/${first.attemptId}/events`, {
    attemptId: first.attemptId,
    eventId: "shuffle_submit",
    idempotencyKey: "shuffle_submit",
    sequenceNumber: 2,
    clientTimestamp: new Date().toISOString(),
    clientSessionId: "shuffle_client_2",
    itemRef: resumed.session.currentItemRef,
    type: "submit.requested",
    payload: {
      submissionMaterialization: {
        itemOrder: [nextId],
        testState: null,
        partStates: {},
        sectionStates: {},
        items: {
          [nextId]: {
            itemId: nextId,
            itemIdentifier: nextId,
            itemTitle: "Question",
            capturedAt: null,
            responseVariables: [{ identifier: "RESPONSE", value: "B" }],
            outcomeVariables: [{ identifier: "SCORE", value: 999 }],
            validationMessages: [],
          },
        },
      },
    },
  });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  const stub = env.ATTEMPT_COORDINATOR.get(env.ATTEMPT_COORDINATOR.idFromName(first.attemptId));
  const result = await stub.fetch("https://harbor-attempt.local/result-materialization", {
    headers: { [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: first.attemptId },
  });
  expect(result.status).toBe(200);
  const saved = await result.json<{
    submissionMaterialization: Parameters<
      typeof scoreSubmissionWithAuthoritativeQti
    >[0]["materialization"];
  }>();
  expect(saved.submissionMaterialization.itemOrder).toEqual(initial.itemOrder);
  const scored = await scoreSubmissionWithAuthoritativeQti({
    bucket: env.CONTENT_BUCKET,
    manifest,
    materialization: saved.submissionMaterialization,
    scoredAt: new Date().toISOString(),
  });
  expect(scored.itemOrder).toEqual(initial.itemOrder);
  expect(new Set(Object.keys(scored.items))).toEqual(new Set(ids));
  expect(scored.items[nextId]?.responseVariables).toContainEqual({
    identifier: "RESPONSE",
    value: "B",
  });
  expect(scored.items[nextId]?.outcomeVariables).toContainEqual({ identifier: "SCORE", value: 1 });
  expect(scored.items[nextId]?.outcomeVariables).not.toContainEqual({
    identifier: "SCORE",
    value: 999,
  });
  expect(await (await env.CONTENT_BUCKET.get(version.manifestObjectKey))?.text()).toBe(frozen);
  expect(await (await env.CONTENT_BUCKET.get(manifest.fixedTestOrder.objectKey))?.text()).toBe(xml);
});

it.each([
  ["invalid-boolean", xml.replace('shuffle="true"', 'shuffle="invalid"')],
  [
    "nested-section",
    xml.replace(
      '<qti-ordering shuffle="true"/>',
      '<qti-ordering shuffle="true"/><qti-assessment-section identifier="nested" title="Nested" visible="true"/>',
    ),
  ],
  [
    "selection",
    xml.replace(
      '<qti-ordering shuffle="true"/>',
      '<qti-selection select="1"/><qti-ordering shuffle="true"/>',
    ),
  ],
  [
    "foreign-ordering",
    xml.replace(
      '<qti-ordering shuffle="true"/>',
      '<qti-ordering xmlns="urn:unsupported" shuffle="true"/>',
    ),
  ],
  [
    "branch-ordering",
    xml.replace(
      "</qti-assessment-section>",
      '<qti-branch-rule target="EXIT_TEST"><qti-base-value base-type="boolean">true</qti-base-value></qti-branch-rule></qti-assessment-section>',
    ),
  ],
] as const)(
  "refuses %s before publication writes without retrying another owner",
  async (name, testXml) => {
    await applyD1Migrations(env.HARBOR_DB, env.TEST_MIGRATIONS);
    const beforeVersions = await env.HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM assessment_versions",
    ).first<{ count: number }>();
    const beforeObjects = (await env.CONTENT_BUCKET.list()).objects
      .map((object) => object.key)
      .sort();
    const response = await workerExports.default.fetch(
      new Request(`https://harbor.local/internal/publish?assessmentSlug=unsupported-${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-harbor-package-name": "unsupported.zip",
          "x-harbor-tenant-id": "tenant_fixed_refusal",
        },
        body: await createFixedOrderPackage(itemXml, stimulusSvg, testXml),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(422);
    expect(
      await env.HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM assessment_versions").first<{
        count: number;
      }>(),
    ).toEqual(beforeVersions);
    expect((await env.CONTENT_BUCKET.list()).objects.map((object) => object.key).sort()).toEqual(
      beforeObjects,
    );
  },
);
