import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  BootstrapEnvelope,
  BootstrapPayload,
  DeliveryContextEvaluation,
  DeliveryContextMode,
  DeliveryPolicySnapshot,
} from "@harbor/attempt-protocol";
import { DELIVERY_CONTEXT_BLOCKED_REASONS, DELIVERY_CONTEXT_MODES } from "@harbor/attempt-protocol";
import { DEFAULT_DELIVERY_POLICY_SNAPSHOT } from "@harbor/content-model";
import { verifyBootstrapToken } from "../src/launch/sign-bootstrap";
import {
  createSafeExamBrowserBrowserExamKeyRequestHashes,
  createSafeExamBrowserConfigKeyRequestHash,
  HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER,
  HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER,
  SAFE_EXAM_BROWSER_CONFIG_KEY_HASH_HEADER,
  SAFE_EXAM_BROWSER_REQUEST_HASH_HEADER,
} from "../src/security/safe-exam-browser";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "attempt_timeline_events",
    "assessment_version_activations",
    "attempt_policy_commands",
    "attempt_policy_overlays",
    "attempt_entries",
    "access_codes",
    "delivery_artifacts",
    "assessment_versions",
    "assessments",
  ];

  const tables = await HARBOR_DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${knownTables
      .map(() => "?")
      .join(", ")})`,
  )
    .bind(...knownTables)
    .all<{ name: string }>();

  const deleteStatements = knownTables
    .filter((tableName) => tables.results.some((table) => table.name === tableName))
    .map((tableName) => `DELETE FROM ${tableName}`);

  if (deleteStatements.length > 0) {
    await HARBOR_DB.exec(`${deleteStatements.join("; ")};`);
  }

  let cursor: string | undefined;
  do {
    const listed = await CONTENT_BUCKET.list({ cursor });
    await Promise.all(listed.objects.map((object) => CONTENT_BUCKET.delete(object.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function createFixturePackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifestXml);
  zip.file("items/item-1.xml", itemXml);
  zip.file("assets/stimulus.svg", stimulusSvg);
  return zip.generateAsync({ type: "uint8array" });
}

async function publishFixture(input: { tenantId: string; assessmentSlug: string }): Promise<{
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "basic-assessment.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function updatePublishedDeliveryPolicy(input: {
  assessmentVersionId: string;
  deliveryPolicy: DeliveryPolicySnapshot;
}): Promise<void> {
  const { HARBOR_DB } = getTestEnv();
  await HARBOR_DB.prepare(
    "UPDATE assessment_versions SET delivery_policy_snapshot = ? WHERE id = ?",
  )
    .bind(JSON.stringify(input.deliveryPolicy), input.assessmentVersionId)
    .run();
}

async function readLatestAttemptId(): Promise<string> {
  const { HARBOR_DB } = getTestEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT id FROM attempt_entries ORDER BY created_at DESC LIMIT 1",
  ).first<{ id: string }>();

  expect(attempt?.id).toBeTruthy();
  return attempt!.id;
}

function buildContextHeaders(
  input: {
    mode?: "standalone" | "iframe";
    embedOrigin?: string;
    userAgent?: string;
  } = {},
): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("x-harbor-frame-mode", input.mode ?? "standalone");
  if (input.embedOrigin) {
    headers.set("x-harbor-embed-origin", input.embedOrigin);
  }
  if (input.userAgent) {
    headers.set("user-agent", input.userAgent);
  }

  return headers;
}

async function postJson(path: string, body: unknown, headers?: Headers): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function getRequest(path: string, headers?: Headers): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
      headers,
    }),
  );
}

const SEB_CONFIG_KEY_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SEB_BROWSER_EXAM_KEY = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

async function buildSafeExamBrowserConfigKeyHeaders(
  path: string,
  input: {
    mode?: "standalone" | "iframe";
    embedOrigin?: string;
    userAgent?: string;
    configKeyHash?: string;
  } = {},
): Promise<Headers> {
  const headers = buildContextHeaders(input);
  headers.set(
    SAFE_EXAM_BROWSER_CONFIG_KEY_HASH_HEADER,
    await createSafeExamBrowserConfigKeyRequestHash({
      requestUrl: `https://harbor.local${path}`,
      configKeyHash: input.configKeyHash ?? SEB_CONFIG_KEY_HASH,
    }),
  );
  return headers;
}

async function buildSafeExamBrowserBrowserExamKeyHeaders(
  path: string,
  input: {
    mode?: "standalone" | "iframe";
    embedOrigin?: string;
    userAgent?: string;
    browserExamKey?: string;
  } = {},
): Promise<Headers> {
  const headers = buildContextHeaders(input);
  const [requestHash] = await createSafeExamBrowserBrowserExamKeyRequestHashes({
    requestUrl: `https://harbor.local${path}`,
    browserExamKey: input.browserExamKey ?? SEB_BROWSER_EXAM_KEY,
  });
  headers.set(SAFE_EXAM_BROWSER_REQUEST_HASH_HEADER, requestHash);
  return headers;
}

async function buildSafeExamBrowserJsConfigKeyHeaders(input: {
  proofUrl: string;
  mode?: "standalone" | "iframe";
  embedOrigin?: string;
  configKeyHash?: string;
}): Promise<Headers> {
  const headers = buildContextHeaders(input);
  headers.set(
    HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER,
    await createSafeExamBrowserConfigKeyRequestHash({
      requestUrl: input.proofUrl,
      configKeyHash: input.configKeyHash ?? SEB_CONFIG_KEY_HASH,
    }),
  );
  headers.set(HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER, input.proofUrl);
  return headers;
}

async function launchPreviewAttempt(input: {
  assessmentVersionId: string;
  headers?: Headers;
}): Promise<{
  attemptId: string;
  envelope: BootstrapEnvelope;
}> {
  const response = await postJson(
    "/api/launch/preview",
    {
      mode: "preview",
      assessmentVersionId: input.assessmentVersionId,
      actor: {
        kind: "preview-operator",
        id: "preview_context_operator",
        displayName: "Context Preview",
      },
    },
    input.headers,
  );
  expect(response.status).toBe(201);
  const envelope = await response.json<BootstrapEnvelope>();

  return {
    attemptId: await readLatestAttemptId(),
    envelope,
  };
}

async function exchangeBootstrap(bootstrapToken: string, headers?: Headers): Promise<Response> {
  return postJson(
    "/api/bootstrap",
    {
      bootstrapToken,
      clientSessionId: "context_session_01",
    },
    headers,
  );
}

beforeEach(async () => {
  await resetBindings();
});

describe("delivery-context contracts", () => {
  it("extends immutable delivery policy with additive embed and secure-browser fields", () => {
    expectTypeOf<DeliveryPolicySnapshot>().toMatchTypeOf<{
      standaloneAllowed?: boolean;
      iframeAllowed?: boolean;
      allowedEmbedOrigins?: string[];
      secureBrowserRequired?: boolean;
      secureBrowserProviderHint?: string | null;
      safeExamBrowser?: DeliveryPolicySnapshot["safeExamBrowser"];
    }>();
  });

  it("projects normalized evaluated delivery-context state through bootstrap", () => {
    expect(DELIVERY_CONTEXT_MODES).toEqual([
      "standalone",
      "iframe",
    ] satisfies DeliveryContextMode[]);
    expect(DELIVERY_CONTEXT_BLOCKED_REASONS).toEqual([
      "standalone_disallowed",
      "iframe_disallowed",
      "embed_origin_not_allowed",
      "secure_browser_required",
      "secure_browser_key_mismatch",
    ]);

    expectTypeOf<Pick<BootstrapPayload, "deliveryContext">>().toMatchTypeOf<{
      deliveryContext?: DeliveryContextEvaluation;
    }>();
  });

  it("models allowed and blocked context outcomes without mutating accommodations or content", () => {
    expectTypeOf<DeliveryContextEvaluation>().toMatchTypeOf<{
      mode: "standalone" | "iframe";
      allowed: boolean;
      embedOrigin: string | null;
      secureBrowserRequired: boolean;
      secureBrowserPresent: boolean;
      secureBrowserVerified: boolean;
      secureBrowserVerificationMethod: string | null;
      secureBrowserProviderHint: string | null;
      blockedReason:
        | "standalone_disallowed"
        | "iframe_disallowed"
        | "embed_origin_not_allowed"
        | "secure_browser_required"
        | "secure_browser_key_mismatch"
        | null;
    }>();
  });
});

describe("delivery-context runtime behavior", () => {
  it("allows configured iframe delivery and blocks disallowed embed origins or missing secure-browser context at launch/bootstrap", async () => {
    const published = await publishFixture({
      tenantId: "tenant_context_launch",
      assessmentSlug: "context-launch",
    });
    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        standaloneAllowed: true,
        iframeAllowed: true,
        allowedEmbedOrigins: ["https://allowed.example"],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
      },
    });

    const allowedHeaders = buildContextHeaders({
      mode: "iframe",
      embedOrigin: "https://allowed.example",
    });
    const allowedLaunch = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      headers: allowedHeaders,
    });
    const allowedBootstrap = await exchangeBootstrap(
      allowedLaunch.envelope.bootstrapToken,
      allowedHeaders,
    );
    expect(allowedBootstrap.status).toBe(200);
    expect(await allowedBootstrap.json<BootstrapPayload>()).toMatchObject({
      deliveryContext: {
        mode: "iframe",
        allowed: true,
        embedOrigin: "https://allowed.example",
      },
    });

    const blockedLaunch = await postJson(
      "/api/launch/preview",
      {
        mode: "preview",
        assessmentVersionId: published.assessmentVersionId,
        actor: {
          kind: "preview-operator",
          id: "preview_blocked_operator",
          displayName: "Blocked Preview",
        },
      },
      buildContextHeaders({
        mode: "iframe",
        embedOrigin: "https://blocked.example",
      }),
    );
    expect(blockedLaunch.status).toBe(403);
    expect(
      await blockedLaunch.json<{ deliveryContext: DeliveryContextEvaluation }>(),
    ).toMatchObject({
      deliveryContext: {
        allowed: false,
        blockedReason: "embed_origin_not_allowed",
      },
    });

    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: true,
        secureBrowserProviderHint: "safe-exam-browser",
      },
    });

    const secureRequiredLaunch = await postJson(
      "/api/launch/preview",
      {
        mode: "preview",
        assessmentVersionId: published.assessmentVersionId,
        actor: {
          kind: "preview-operator",
          id: "preview_secure_operator",
          displayName: "Secure Preview",
        },
      },
      buildContextHeaders({
        mode: "standalone",
      }),
    );
    expect(secureRequiredLaunch.status).toBe(403);
    expect(
      await secureRequiredLaunch.json<{ deliveryContext: DeliveryContextEvaluation }>(),
    ).toMatchObject({
      deliveryContext: {
        allowed: false,
        blockedReason: "secure_browser_required",
      },
    });
  });

  it("enforces the same context rules on manifest, item, and asset reads after launch", async () => {
    const published = await publishFixture({
      tenantId: "tenant_context_content",
      assessmentSlug: "context-content",
    });
    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        standaloneAllowed: true,
        iframeAllowed: true,
        allowedEmbedOrigins: ["https://allowed.example"],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
      },
    });

    const allowedHeaders = buildContextHeaders({
      mode: "iframe",
      embedOrigin: "https://allowed.example",
    });
    const launched = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      headers: allowedHeaders,
    });
    const bootstrap = await exchangeBootstrap(launched.envelope.bootstrapToken, allowedHeaders);
    expect(bootstrap.status).toBe(200);

    const manifestResponse = await getRequest(
      `/api/content/manifest?attemptId=${encodeURIComponent(launched.attemptId)}`,
      buildContextHeaders({
        mode: "iframe",
        embedOrigin: "https://blocked.example",
      }),
    );
    expect(manifestResponse.status).toBe(403);

    const allowedManifest = await getRequest(
      `/api/content/manifest?attemptId=${encodeURIComponent(launched.attemptId)}`,
      allowedHeaders,
    );
    expect(allowedManifest.status).toBe(200);
    const manifest = await allowedManifest.json<{
      currentItemId: string;
    }>();

    const allowedItem = await getRequest(
      `/api/content/items/${manifest.currentItemId}?attemptId=${encodeURIComponent(launched.attemptId)}`,
      allowedHeaders,
    );
    expect(allowedItem.status).toBe(200);
    const item = await allowedItem.json<{
      item: {
        assets: Array<{ url: string }>;
      };
    }>();

    const blockedItem = await getRequest(
      `/api/content/items/${manifest.currentItemId}?attemptId=${encodeURIComponent(launched.attemptId)}`,
      buildContextHeaders({
        mode: "iframe",
        embedOrigin: "https://blocked.example",
      }),
    );
    expect(blockedItem.status).toBe(403);

    const blockedAsset = await getRequest(
      item.item.assets[0].url,
      buildContextHeaders({
        mode: "iframe",
        embedOrigin: "https://blocked.example",
      }),
    );
    expect(blockedAsset.status).toBe(403);
  });

  it("does not accept spoofed or unsupported secure-browser providers as proof", async () => {
    const published = await publishFixture({
      tenantId: "tenant_context_secure_alias",
      assessmentSlug: "context-secure-alias",
    });
    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: true,
        secureBrowserProviderHint: "SEB",
      },
    });

    const sebSpoof = await postJson(
      "/api/launch/preview",
      {
        mode: "preview",
        assessmentVersionId: published.assessmentVersionId,
        actor: {
          kind: "preview-operator",
          id: "preview_context_operator",
          displayName: "Context Preview",
        },
      },
      buildContextHeaders({
        mode: "standalone",
        userAgent: "Mozilla/5.0 SafeExamBrowser/3.7 Harbor",
      }),
    );
    expect(sebSpoof.status).toBe(403);
    expect(await sebSpoof.json<{ deliveryContext: DeliveryContextEvaluation }>()).toMatchObject({
      deliveryContext: {
        blockedReason: "secure_browser_required",
        secureBrowserPresent: true,
        secureBrowserVerified: false,
      },
    });

    const unsupportedProviderHeaders = buildContextHeaders({ mode: "standalone" });
    unsupportedProviderHeaders.set("x-harbor-secure-browser-provider", "unsupported-browser");
    const unsupportedProvider = await postJson(
      "/api/launch/preview",
      {
        mode: "preview",
        assessmentVersionId: published.assessmentVersionId,
        actor: {
          kind: "preview-operator",
          id: "preview_context_operator",
          displayName: "Context Preview",
        },
      },
      unsupportedProviderHeaders,
    );
    expect(unsupportedProvider.status).toBe(403);
    expect(
      await unsupportedProvider.json<{ deliveryContext: DeliveryContextEvaluation }>(),
    ).toMatchObject({
      deliveryContext: {
        blockedReason: "secure_browser_key_mismatch",
        secureBrowserPresent: true,
        secureBrowserVerified: false,
      },
    });
  });

  it("rejects a launch after its hidden verification policy changes", async () => {
    const published = await publishFixture({
      tenantId: "tenant_hidden_policy",
      assessmentSlug: "hidden-policy",
    });
    const policy: DeliveryPolicySnapshot = {
      ...DEFAULT_DELIVERY_POLICY_SNAPSHOT,
      secureBrowserRequired: true,
      secureBrowserProviderHint: "safe-exam-browser",
      safeExamBrowser: { verificationMode: "config-key", configKeyHash: SEB_CONFIG_KEY_HASH },
    };
    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: policy,
    });
    const launched = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      headers: await buildSafeExamBrowserConfigKeyHeaders("/api/launch/preview"),
    });
    const newKey = "e".repeat(64);
    await getTestEnv()
      .HARBOR_DB.prepare("UPDATE attempt_entries SET delivery_policy_snapshot = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          ...policy,
          safeExamBrowser: { verificationMode: "config-key", configKeyHash: newKey },
        }),
        launched.attemptId,
      )
      .run();
    const response = await exchangeBootstrap(
      launched.envelope.bootstrapToken,
      await buildSafeExamBrowserConfigKeyHeaders("/api/bootstrap", { configKeyHash: newKey }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "Bootstrap token does not match the pinned attempt context",
    });
  });

  it("requires both SEB proofs at admission, content reads and final submission", async () => {
    const published = await publishFixture({
      tenantId: "tenant_both_proofs",
      assessmentSlug: "both-proofs",
    });
    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        ...DEFAULT_DELIVERY_POLICY_SNAPSHOT,
        secureBrowserRequired: true,
        secureBrowserProviderHint: "safe-exam-browser",
        safeExamBrowser: {
          verificationMode: "config-key-and-browser-exam-key",
          configKeyHash: SEB_CONFIG_KEY_HASH,
          browserExamKeys: [{ keyHash: SEB_BROWSER_EXAM_KEY }],
        },
      },
    });
    async function bothHeaders(path: string): Promise<Headers> {
      const headers = await buildSafeExamBrowserConfigKeyHeaders(path);
      const browser = await buildSafeExamBrowserBrowserExamKeyHeaders(path);
      browser.forEach((value, key) => headers.set(key, value));
      return headers;
    }
    const body = {
      assessmentVersionId: published.assessmentVersionId,
      actor: { id: "candidate-both", displayName: "Both proofs" },
    };
    const denied = await postJson(
      "/api/launch/preview",
      body,
      await buildSafeExamBrowserConfigKeyHeaders("/api/launch/preview"),
    );
    expect(denied.status).toBe(403);
    const launched = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      headers: await bothHeaders("/api/launch/preview"),
    });
    expect(
      (
        await exchangeBootstrap(
          launched.envelope.bootstrapToken,
          await buildSafeExamBrowserConfigKeyHeaders("/api/bootstrap"),
        )
      ).status,
    ).toBe(403);
    const bootstrap = await exchangeBootstrap(
      launched.envelope.bootstrapToken,
      await bothHeaders("/api/bootstrap"),
    );
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();
    expect(payload.deliveryContext?.secureBrowserVerificationMethod).toBe(
      "config-key-and-browser-exam-key",
    );
    const manifestPath = `/api/content/manifest?attemptId=${launched.attemptId}`;
    expect(
      (await getRequest(manifestPath, await buildSafeExamBrowserConfigKeyHeaders(manifestPath)))
        .status,
    ).toBe(403);
    expect((await getRequest(manifestPath, await bothHeaders(manifestPath))).status).toBe(200);
    const path = `/api/attempts/${launched.attemptId}/events`;
    const event = {
      attemptId: launched.attemptId,
      eventId: "evt-both-submit",
      idempotencyKey: "idem-both-submit",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "context_session_01",
      itemRef: payload.session.currentItemRef,
      type: "submit.requested",
      payload: { requestedAt: new Date().toISOString() },
    };
    expect(
      (await postJson(path, event, await buildSafeExamBrowserConfigKeyHeaders(path))).status,
    ).toBe(403);
    const accepted = await postJson(path, event, await bothHeaders(path));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      outcome: "accepted",
      attemptStatus: "submitted",
    });
  });

  it("requires key-verified Safe Exam Browser proof and protects attempt events", async () => {
    const published = await publishFixture({
      tenantId: "tenant_context_secure",
      assessmentSlug: "context-secure",
    });
    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: true,
        secureBrowserProviderHint: "safe-exam-browser",
        safeExamBrowser: {
          verificationMode: "config-key",
          configKeyHash: SEB_CONFIG_KEY_HASH,
          browserExamKeys: [],
        },
      },
    });

    const spoofedHeaders = buildContextHeaders({
      mode: "standalone",
      userAgent: "Mozilla/5.0 SafeExamBrowser/3.7 Harbor",
    });
    const spoofedLaunch = await postJson(
      "/api/launch/preview",
      {
        mode: "preview",
        assessmentVersionId: published.assessmentVersionId,
        actor: {
          kind: "preview-operator",
          id: "preview_context_operator",
          displayName: "Context Preview",
        },
      },
      spoofedHeaders,
    );
    expect(spoofedLaunch.status).toBe(403);
    expect(
      await spoofedLaunch.json<{ deliveryContext: DeliveryContextEvaluation }>(),
    ).toMatchObject({
      deliveryContext: {
        allowed: false,
        blockedReason: "secure_browser_required",
        secureBrowserPresent: true,
        secureBrowserVerified: false,
      },
    });

    const mismatchedHeaders = buildContextHeaders({
      mode: "standalone",
    });
    mismatchedHeaders.set(SAFE_EXAM_BROWSER_CONFIG_KEY_HASH_HEADER, "f".repeat(64));
    const mismatchedLaunch = await postJson(
      "/api/launch/preview",
      {
        mode: "preview",
        assessmentVersionId: published.assessmentVersionId,
        actor: {
          kind: "preview-operator",
          id: "preview_context_operator",
          displayName: "Context Preview",
        },
      },
      mismatchedHeaders,
    );
    expect(mismatchedLaunch.status).toBe(403);
    expect(
      await mismatchedLaunch.json<{ deliveryContext: DeliveryContextEvaluation }>(),
    ).toMatchObject({
      deliveryContext: {
        allowed: false,
        blockedReason: "secure_browser_key_mismatch",
      },
    });

    const crossOriginJsHeaders = await buildSafeExamBrowserJsConfigKeyHeaders({
      proofUrl: "https://evil.example/attempt",
      mode: "standalone",
    });
    const crossOriginJsLaunch = await postJson(
      "/api/launch/preview",
      {
        mode: "preview",
        assessmentVersionId: published.assessmentVersionId,
        actor: {
          kind: "preview-operator",
          id: "preview_context_operator",
          displayName: "Context Preview",
        },
      },
      crossOriginJsHeaders,
    );
    expect(crossOriginJsLaunch.status).toBe(403);
    expect(
      await crossOriginJsLaunch.json<{ deliveryContext: DeliveryContextEvaluation }>(),
    ).toMatchObject({
      deliveryContext: {
        allowed: false,
        blockedReason: "secure_browser_key_mismatch",
      },
    });

    const jsProofHeaders = await buildSafeExamBrowserJsConfigKeyHeaders({
      proofUrl: "https://harbor.local/runtime",
      mode: "standalone",
    });
    const jsProofLaunch = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      headers: jsProofHeaders,
    });
    const jsProofBootstrap = await exchangeBootstrap(
      jsProofLaunch.envelope.bootstrapToken,
      await buildSafeExamBrowserJsConfigKeyHeaders({
        proofUrl: "https://harbor.local/runtime",
        mode: "standalone",
      }),
    );
    expect(jsProofBootstrap.status).toBe(200);
    expect(await jsProofBootstrap.json<BootstrapPayload>()).toMatchObject({
      deliveryContext: {
        secureBrowserVerified: true,
        secureBrowserVerificationMethod: "config-key-js-api",
      },
    });

    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: true,
        secureBrowserProviderHint: "safe-exam-browser",
        safeExamBrowser: {
          verificationMode: "browser-exam-key",
          configKeyHash: null,
          browserExamKeys: [
            {
              keyHash: SEB_BROWSER_EXAM_KEY,
              platform: "unknown",
            },
          ],
        },
      },
    });
    const browserExamKeyHeaders = await buildSafeExamBrowserBrowserExamKeyHeaders(
      "/api/launch/preview",
      {
        mode: "standalone",
      },
    );
    const browserExamKeyLaunch = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      headers: browserExamKeyHeaders,
    });
    const browserExamKeyBootstrap = await exchangeBootstrap(
      browserExamKeyLaunch.envelope.bootstrapToken,
      await buildSafeExamBrowserBrowserExamKeyHeaders("/api/bootstrap", {
        mode: "standalone",
      }),
    );
    expect(browserExamKeyBootstrap.status).toBe(200);
    expect(await browserExamKeyBootstrap.json<BootstrapPayload>()).toMatchObject({
      deliveryContext: {
        secureBrowserVerified: true,
        secureBrowserVerificationMethod: "browser-exam-key-header",
      },
    });

    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: true,
        secureBrowserProviderHint: "safe-exam-browser",
        safeExamBrowser: {
          verificationMode: "config-key",
          configKeyHash: null,
          browserExamKeys: [],
          allowUserAgentFallback: true,
        },
      },
    });
    const disabledFallbackLaunch = await postJson(
      "/api/launch/preview",
      {
        mode: "preview",
        assessmentVersionId: published.assessmentVersionId,
        actor: {
          kind: "preview-operator",
          id: "preview_context_operator",
          displayName: "Context Preview",
        },
      },
      spoofedHeaders,
    );
    expect(disabledFallbackLaunch.status).toBe(403);

    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: true,
        secureBrowserProviderHint: "safe-exam-browser",
        safeExamBrowser: {
          verificationMode: "config-key",
          configKeyHash: SEB_CONFIG_KEY_HASH,
          browserExamKeys: [],
        },
      },
    });

    const secureHeaders = await buildSafeExamBrowserConfigKeyHeaders("/api/launch/preview", {
      mode: "standalone",
    });
    const launched = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      headers: secureHeaders,
    });
    const bootstrapHeaders = await buildSafeExamBrowserConfigKeyHeaders("/api/bootstrap", {
      mode: "standalone",
    });
    const bootstrap = await exchangeBootstrap(launched.envelope.bootstrapToken, bootstrapHeaders);
    expect(bootstrap.status).toBe(200);
    const bootstrapPayload = await bootstrap.json<BootstrapPayload>();
    expect(bootstrapPayload).toMatchObject({
      deliveryContext: {
        allowed: true,
        secureBrowserRequired: true,
        secureBrowserPresent: true,
        secureBrowserVerified: true,
        secureBrowserVerificationMethod: "config-key-header",
        secureBrowserProviderHint: "safe-exam-browser",
      },
    });

    const eventPath = `/api/attempts/${launched.attemptId}/events`;
    const event = {
      attemptId: launched.attemptId,
      eventId: "evt_secure_response_01",
      idempotencyKey: "idem_secure_response_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-05-12T15:00:00.000Z",
      clientSessionId: "context_session_01",
      itemRef: bootstrapPayload.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE",
        responseState: {
          capturedAt: "2026-05-12T15:00:00.000Z",
          itemState: {
            responseVariables: [],
          },
        },
      },
    };

    const blockedEvent = await postJson(eventPath, event, spoofedHeaders);
    expect(blockedEvent.status).toBe(403);

    const eventHeaders = await buildSafeExamBrowserConfigKeyHeaders(eventPath, {
      mode: "standalone",
    });
    const acceptedEvent = await postJson(eventPath, event, eventHeaders);
    expect(acceptedEvent.status).toBe(200);
  });

  it("pins asset urls to the evaluated context so renderer subrequests stay allowed without custom headers", async () => {
    const published = await publishFixture({
      tenantId: "tenant_context_asset_url",
      assessmentSlug: "context-asset-url",
    });
    await updatePublishedDeliveryPolicy({
      assessmentVersionId: published.assessmentVersionId,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 300,
        standaloneAllowed: true,
        iframeAllowed: true,
        allowedEmbedOrigins: ["https://allowed.example"],
        secureBrowserRequired: true,
        secureBrowserProviderHint: "safe-exam-browser",
        safeExamBrowser: {
          verificationMode: "config-key",
          configKeyHash: SEB_CONFIG_KEY_HASH,
          browserExamKeys: [],
        },
      },
    });

    const allowedLaunchHeaders = await buildSafeExamBrowserConfigKeyHeaders("/api/launch/preview", {
      mode: "iframe",
      embedOrigin: "https://allowed.example",
    });
    const launched = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      headers: allowedLaunchHeaders,
    });
    const allowedBootstrapHeaders = await buildSafeExamBrowserConfigKeyHeaders("/api/bootstrap", {
      mode: "iframe",
      embedOrigin: "https://allowed.example",
    });
    const bootstrap = await exchangeBootstrap(
      launched.envelope.bootstrapToken,
      allowedBootstrapHeaders,
    );
    expect(bootstrap.status).toBe(200);

    const manifestPath = `/api/content/manifest?attemptId=${encodeURIComponent(launched.attemptId)}`;
    const manifestResponse = await getRequest(
      manifestPath,
      await buildSafeExamBrowserConfigKeyHeaders(manifestPath, {
        mode: "iframe",
        embedOrigin: "https://allowed.example",
      }),
    );
    expect(manifestResponse.status).toBe(200);
    expect(await manifestResponse.clone().text()).not.toContain(SEB_CONFIG_KEY_HASH);
    expect(await bootstrap.clone().text()).not.toContain(SEB_CONFIG_KEY_HASH);
    const signingSecret: unknown = Reflect.get(env, "BOOTSTRAP_SIGNING_SECRET");
    if (typeof signingSecret !== "string") throw new Error("Missing test signing binding");
    const publicClaims = await verifyBootstrapToken({
      token: launched.envelope.bootstrapToken,
      secret: signingSecret,
    });
    expect(publicClaims.deliveryPolicy.safeExamBrowser).toBeNull();
    expect(publicClaims.deliveryPolicyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const manifest = await manifestResponse.json<{
      currentItemId: string;
    }>();

    const itemPath = `/api/content/items/${manifest.currentItemId}?attemptId=${encodeURIComponent(launched.attemptId)}`;
    const itemResponse = await getRequest(
      itemPath,
      await buildSafeExamBrowserConfigKeyHeaders(itemPath, {
        mode: "iframe",
        embedOrigin: "https://allowed.example",
      }),
    );
    expect(itemResponse.status).toBe(200);
    const item = await itemResponse.json<{
      item: {
        xml: string;
        assets: Array<{ url: string }>;
      };
    }>();

    const stimulusAsset = item.item.assets.at(0);
    expect(stimulusAsset).toBeDefined();
    if (!stimulusAsset) throw new Error("Fixture stimulus asset was not delivered.");
    expect(stimulusAsset.url).toContain("contextMode=iframe");
    expect(stimulusAsset.url).toContain(encodeURIComponent("https://allowed.example"));
    expect(stimulusAsset.url).not.toContain("secureBrowserProvider=");
    expect(item.item.xml).toContain("../assets/stimulus.svg");

    const assetResponse = await getRequest(
      stimulusAsset.url,
      await buildSafeExamBrowserConfigKeyHeaders(stimulusAsset.url, {
        mode: "iframe",
        embedOrigin: "https://allowed.example",
      }),
    );
    expect(assetResponse.status).toBe(200);
  });
});
