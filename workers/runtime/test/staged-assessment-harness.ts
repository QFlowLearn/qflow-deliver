import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { expect } from "vitest";
import type {
  AttemptEventEnvelope,
  BootstrapEnvelope,
  BootstrapPayload,
  CurrentItemRef,
} from "@harbor/attempt-protocol";
import { stagedPackage } from "../../../tests/fixtures/staged-package";
import testXml from "../../../tests/fixtures/qti/staged-assessment/test.xml?raw";

export async function setupStagedTests() {
  // The worker test harness supplies these bindings through vitest.config.ts.
  const bindings = env as unknown as {
    HARBOR_DB: D1Database;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
  await applyD1Migrations(bindings.HARBOR_DB, bindings.TEST_MIGRATIONS);
}

export function request(path: string, body?: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(
      `https://harbor.local${path}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    ),
  );
}

export async function publishTestPackage(bytes: Uint8Array): Promise<string> {
  const published = await workerExports.default.fetch(
    new Request("https://harbor.local/internal/publish?assessmentSlug=staged", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "staged.zip",
        "x-harbor-tenant-id": crypto.randomUUID(),
      },
      body: new Uint8Array(bytes).buffer,
    }),
  );
  expect(published.status, await published.clone().text()).toBe(201);
  const { assessmentVersionId } = await published.json<{ assessmentVersionId: string }>();
  return assessmentVersionId;
}

export async function launch() {
  return launchPublished(await publishTestPackage(await stagedPackage(testXml)));
}

export async function launchPublished(
  assessmentVersionId: string,
): Promise<BootstrapPayload & { bootstrapToken: string }> {
  const launched = await request("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId,
    actor: { kind: "preview-operator", id: "staged_test", displayName: "Staged test" },
  });
  expect(launched.status, await launched.clone().text()).toBe(201);
  const envelope = await launched.json<BootstrapEnvelope>();
  const bootstrap = await request("/api/bootstrap", { bootstrapToken: envelope.bootstrapToken });
  expect(bootstrap.status, await bootstrap.clone().text()).toBe(200);
  return { ...(await bootstrap.json<BootstrapPayload>()), bootstrapToken: envelope.bootstrapToken };
}

export function answer(
  attemptId: string,
  itemRef: CurrentItemRef,
  sequenceNumber: number,
  choice: string,
): AttemptEventEnvelope<"item.submit-requested"> {
  return {
    attemptId,
    itemRef,
    sequenceNumber,
    eventId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    clientSessionId: "staged_client",
    clientTimestamp: new Date().toISOString(),
    type: "item.submit-requested",
    payload: {
      responseKey: itemRef.itemId,
      responseState: {
        itemState: {
          responseVariables: [{ identifier: "RESPONSE", value: choice }],
          outcomeVariables: [{ identifier: "SCORE", value: 999 }],
        },
      },
    },
  };
}
