import JSZip from "jszip";
import { applyD1Migrations, env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { BootstrapEnvelope, BootstrapPayload } from "@harbor/attempt-protocol";
import {
  findMinimumSubmissionBlockingScope,
  findExceededAutoSubmitDeadlineScope,
  type StoredTimingScope,
} from "../src/attempts/attempt-timing";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const start = "2026-10-07T00:00:00.000Z";
function partScope(): StoredTimingScope {
  return {
    key: "test-part:P",
    scopeType: "test-part",
    identifier: "P",
    itemId: null,
    status: "interacting",
    enteredAt: start,
    exitedAt: null,
    activeSince: start,
    elapsedMilliseconds: 0,
    minTimeSeconds: 60,
    maxTimeSeconds: 300,
    allowLateSubmission: false,
    deadlineAt: "2026-10-07T00:05:00.000Z",
    unlimited: false,
  };
}

it("uses accumulated server time and the exact minimum boundary, retaining suspended limits", () => {
  const scope = partScope();
  expect(
    findMinimumSubmissionBlockingScope(
      { policyVersion: 1, scopes: [scope] },
      "2026-10-07T00:00:59.999Z",
    ),
  ).toEqual(scope);
  expect(
    findMinimumSubmissionBlockingScope(
      { policyVersion: 1, scopes: [scope] },
      "2026-10-07T00:01:00.000Z",
    ),
  ).toBeNull();
  const suspended = {
    ...scope,
    status: "suspended" as const,
    activeSince: null,
    elapsedMilliseconds: 59_000,
  };
  expect(
    findMinimumSubmissionBlockingScope(
      { policyVersion: 1, scopes: [suspended] },
      "2026-10-07T00:10:00.000Z",
    ),
  ).toBeNull();
  expect(
    findMinimumSubmissionBlockingScope(
      { policyVersion: 1, scopes: [suspended] },
      "2026-10-07T00:01:00.000Z",
    ),
  ).toEqual(suspended);
  expect(
    findMinimumSubmissionBlockingScope(
      { policyVersion: 1, scopes: [{ ...scope, status: "initial", activeSince: null }] },
      start,
    ),
  ).toBeNull();
});

it("lets an elapsed hard assessment deadline take precedence over a longer part minimum", () => {
  const part = partScope();
  const test: StoredTimingScope = {
    ...part,
    key: "assessment-test:T",
    scopeType: "assessment-test",
    identifier: "T",
    minTimeSeconds: null,
    maxTimeSeconds: 30,
    deadlineAt: "2026-10-07T00:00:30.000Z",
  };
  expect(
    findMinimumSubmissionBlockingScope(
      { policyVersion: 1, scopes: [part, test] },
      "2026-10-07T00:00:31.000Z",
    ),
  ).toBeNull();
  expect(
    findMinimumSubmissionBlockingScope(
      { policyVersion: 1, scopes: [{ ...test, minTimeSeconds: 20 }] },
      "2026-10-07T00:00:10.000Z",
    ),
  ).toMatchObject({ scopeType: "assessment-test" });
});

it("does not let an earlier permissive deadline hide another scope's hard deadline", () => {
  const hard = { ...partScope(), deadlineAt: "2026-10-07T00:00:30.000Z" };
  const late: StoredTimingScope = {
    ...hard,
    key: "assessment-test:T",
    scopeType: "assessment-test",
    allowLateSubmission: true,
  };
  const timing = { policyVersion: 1, scopes: [late, hard] };
  expect(findExceededAutoSubmitDeadlineScope(timing, "2026-10-07T00:00:31.000Z")).toEqual(hard);
  expect(findMinimumSubmissionBlockingScope(timing, "2026-10-07T00:00:31.000Z")).toBeNull();
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

it("rejects early final submission through the real coordinator without blocking within-part navigation or consuming sequence numbers", async () => {
  await applyD1Migrations(env.HARBOR_DB, env.TEST_MIGRATIONS);
  const zip = new JSZip();
  zip.file(
    "imsmanifest.xml",
    `<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="minimum">
    <resources><resource identifier="T" type="imsqti_test_xmlv3p0" href="test.xml"><file href="test.xml"/></resource>
    <resource identifier="one" type="imsqti_item_xmlv3p0" href="items/one.xml"><file href="items/one.xml"/></resource>
    <resource identifier="two" type="imsqti_item_xmlv3p0" href="items/two.xml"><file href="items/two.xml"/></resource></resources></manifest>`,
  );
  zip.file(
    "test.xml",
    `<qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="T" title="Minimum time">
    <qti-test-part identifier="P" navigation-mode="linear" submission-mode="simultaneous"><qti-time-limits min-time="60" max-time="300"/>
    <qti-assessment-section identifier="S" title="Questions" visible="true"><qti-assessment-item-ref identifier="one" href="items/one.xml"/>
    <qti-assessment-item-ref identifier="two" href="items/two.xml"/></qti-assessment-section></qti-test-part></qti-assessment-test>`,
  );
  zip.file("items/one.xml", itemXml);
  zip.file("items/two.xml", itemXml.replace('identifier="item-1"', 'identifier="item-2"'));
  zip.file("assets/stimulus.svg", stimulusSvg);
  const published = await workerExports.default.fetch(
    new Request("https://harbor.local/internal/publish?assessmentSlug=minimum-part", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "minimum.zip",
        "x-harbor-tenant-id": "tenant_minimum_part",
      },
      body: await zip.generateAsync({ type: "arraybuffer" }),
    }),
  );
  expect(published.status, await published.clone().text()).toBe(201);
  const version = await published.json<{ assessmentVersionId: string }>();
  const launch = await post("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: version.assessmentVersionId,
    actor: { kind: "preview-operator", id: "minimum-reader", displayName: "Reader" },
  });
  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const bootstrap = await post("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: "minimum_client",
  });
  expect(bootstrap.status).toBe(200);
  const payload = await bootstrap.json<BootstrapPayload>();
  const base = {
    attemptId: payload.attemptId,
    sequenceNumber: 1,
    clientTimestamp: "2099-01-01T00:00:00.000Z",
    clientSessionId: "minimum_client",
    itemRef: payload.session.currentItemRef,
  };
  const early = await post(`/api/attempts/${payload.attemptId}/events`, {
    ...base,
    eventId: "early",
    idempotencyKey: "early",
    type: "submit.requested",
    payload: {},
  });
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({
    timingBlock: { scopeType: "test-part", identifier: "P", minTimeSeconds: 60 },
  });
  const forgedDeadline = await post(`/api/attempts/${payload.attemptId}/events`, {
    ...base,
    eventId: "early_auto",
    idempotencyKey: "early_auto",
    type: "timing.auto-submit.requested",
    payload: {
      requestedAt: "2099-01-01T00:00:00.000Z",
      reason: "max-time-reached",
      scopeKey: "test-part:P",
    },
  });
  expect(forgedDeadline.status).toBe(409);
  const navigation = await post(`/api/attempts/${payload.attemptId}/events`, {
    ...base,
    eventId: "next",
    idempotencyKey: "next",
    type: "navigation.requested",
    payload: { targetItemRef: { itemId: "item-2", itemHref: "items/two.xml" } },
  });
  expect(navigation.status).toBe(200);
  expect(await navigation.json()).toMatchObject({
    outcome: "accepted",
    highestCommittedSequence: 1,
  });
  const resumed = await post("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: "minimum_client",
  });
  expect(await resumed.json()).toMatchObject({
    session: { sequence: { lastAcceptedSequence: 1, nextSequence: 2 }, attemptStatus: "active" },
  });
});
