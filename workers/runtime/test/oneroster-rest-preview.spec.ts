import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  OneRosterV1p2RestSourceRecord,
  OneRosterV1p2RosteringPreviewResponse,
} from "@harbor/attempt-protocol";

import { createApp } from "../src/app";
import {
  ONEROSTER_V1P2_PREVIEW_LIMITS,
  createOneRosterPreview,
  runOneRosterV1p2RosteringPreview,
} from "../src/provisioning/oneroster-rest-preview";
import { previewCsvRosterImport } from "../src/routes/provisioning";
import {
  createOneRosterV1p2RestSourceRoute,
  previewOneRosterV1p2RestSourceRoute,
} from "../src/routes/instructor/oneroster-rest-preview-route";
import {
  buildOneRosterV1p2PreviewConfiguration,
  buildOneRosterTestCredentialBinding,
  createOneRosterV1p2TestProvider,
  ONEROSTER_TEST_CREDENTIAL_BINDING_ID,
} from "./fixtures/oneroster/v1p2-provider";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

beforeEach(async () => {
  const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);
  await HARBOR_DB.exec(
    "DELETE FROM provisioning_run_errors; DELETE FROM provisioning_runs; DELETE FROM provisioning_sources;",
  );
});

describe("OneRoster 1.2 Rostering REST preview", () => {
  it("fails fast when explicit source configuration is missing or excessive", async () => {
    const configuration = buildOneRosterV1p2PreviewConfiguration();
    const valid = {
      sourceName: "District OneRoster REST",
      credentialBindingId: ONEROSTER_TEST_CREDENTIAL_BINDING_ID,
      ...configuration,
    };
    const invalidBodies = [
      { ...valid, version: "1.1" },
      { ...valid, discoveryUrl: undefined },
      { ...valid, discoveryUrl: "http://sis.example/discovery.json" },
      { ...valid, rosteringBaseUrl: undefined },
      { ...valid, credentialBindingId: undefined },
      { ...valid, credentialBindingId: "BOOTSTRAP_SIGNING_SECRET" },
      { ...valid, oauth: undefined },
      {
        ...valid,
        oauth: { ...configuration.oauth, clientSecret: "must-not-enter-request" },
      },
      { ...valid, oauth: { ...configuration.oauth, scopes: [] } },
      { ...valid, traversal: { ...configuration.traversal, maxItems: undefined } },
      {
        ...valid,
        traversal: {
          ...configuration.traversal,
          pageSize: ONEROSTER_V1P2_PREVIEW_LIMITS.pageSize + 1,
        },
      },
      {
        ...valid,
        traversal: {
          ...configuration.traversal,
          maxPages: Number.MAX_SAFE_INTEGER,
        },
      },
      {
        ...valid,
        traversal: {
          ...configuration.traversal,
          maxItems: ONEROSTER_V1P2_PREVIEW_LIMITS.maxItems + 1,
        },
      },
      {
        ...valid,
        traversal: {
          ...configuration.traversal,
          maxElapsedMilliseconds: ONEROSTER_V1P2_PREVIEW_LIMITS.maxElapsedMilliseconds + 1,
        },
      },
      { ...valid, retry: { ...configuration.retry, maxAttempts: undefined } },
      {
        ...valid,
        retry: {
          ...configuration.retry,
          maxAttempts: ONEROSTER_V1P2_PREVIEW_LIMITS.retryMaxAttempts + 1,
        },
      },
      {
        ...valid,
        retry: {
          ...configuration.retry,
          maxElapsedMilliseconds: ONEROSTER_V1P2_PREVIEW_LIMITS.retryMaxElapsedMilliseconds + 1,
        },
      },
      { ...valid, retry: { ...configuration.retry, statusCodes: [500] } },
    ];

    for (const body of invalidBodies) {
      const response = await workerExports.default.fetch(
        new Request(
          "https://harbor.local/api/instructor/provisioning/oneroster/rest/v1p2/sources",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
      );
      expect(response.status).toBe(400);
    }
    expect(
      await getTestEnv()
        .HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM provisioning_sources")
        .first(),
    ).toEqual({ count: 0 });

    const inlineConfiguration = await workerExports.default.fetch(
      new Request("https://harbor.local/api/instructor/provisioning/oneroster/rest/v1p2/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: "psrc_inline_configuration",
          actor: { role: "instructor", actorId: "roster-manager" },
          oauth: { clientSecret: "must-not-enter-preview" },
        }),
      }),
    );
    expect(inlineConfiguration.status).toBe(400);
  });

  it("rejects excessive bounds in the preview service before discovery", async () => {
    const provider = createOneRosterV1p2TestProvider();
    const configuration = buildOneRosterV1p2PreviewConfiguration();
    const result = await runOneRosterV1p2RosteringPreview({
      configuration: {
        ...configuration,
        traversal: {
          ...configuration.traversal,
          maxPages: Number.MAX_SAFE_INTEGER,
        },
      },
      credentials: { clientId: "fixture-client", clientSecret: "fixture-secret" },
      fetch: provider.fetch,
      signal: new AbortController().signal,
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "oneroster.rest.configuration.max_pages_exceeds_server_limit",
      }),
    ]);
    expect(provider.calls).toEqual([]);
  });

  it("creates stable REST source identities without storing credential values", async () => {
    const provider = createOneRosterV1p2TestProvider();
    const first = await configureSource("tenant-source-identity");
    const second = await configureSource("tenant-source-identity");
    const csv = await previewCsvRosterImport({
      env: { HARBOR_DB: getTestEnv().HARBOR_DB },
      tenantId: "tenant-source-identity",
      request: jsonRequest({
        sourceName: "District OneRoster REST",
        csvText: "student_id,display_name,section_id,section_name\nstudent-1,Ada,class-1,Biology",
        actor: { role: "instructor", actorId: "roster-manager" },
      }),
    });

    expect(csv.status).toBe(200);
    expect(first.source).toMatchObject({
      sourceKind: "oneroster-rest-v1p2",
      sourceName: "District OneRoster REST",
    });
    expect(second.source.id).not.toBe(first.source.id);
    expect(first.source.sourceKey).toBe(first.source.id);
    const sources = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT source_kind FROM provisioning_sources WHERE tenant_id = ? AND source_name = ? ORDER BY source_kind",
      )
      .bind("tenant-source-identity", "District OneRoster REST")
      .all<{ source_kind: string }>();
    expect(sources.results.map((source) => source.source_kind)).toEqual([
      "csv",
      "oneroster-rest-v1p2",
      "oneroster-rest-v1p2",
    ]);
    const persisted = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT credential_binding_id FROM oneroster_rest_v1p2_sources WHERE source_id = ?",
      )
      .bind(first.source.id)
      .first<{ credential_binding_id: string }>();
    expect(persisted).toEqual({
      credential_binding_id: ONEROSTER_TEST_CREDENTIAL_BINDING_ID,
    });
    expect(JSON.stringify({ first, second, persisted })).not.toContain("fixture-secret");
  });

  it("requires a tenant-scoped configured source and resolves credentials from its binding", async () => {
    const provider = createOneRosterV1p2TestProvider();
    await expect(
      createOneRosterV1p2RestSourceRoute({
        env: providerEnv("tenant-binding-owner"),
        tenantId: "tenant-source-owner",
        request: jsonRequest(sourceConfigurationBody()),
      }),
    ).rejects.toMatchObject({ status: 503 });
    const configured = await configureSource("tenant-source-owner");
    const command = {
      sourceId: configured.source.id,
      actor: { role: "instructor", actorId: "roster-manager" },
    };

    await expect(
      previewOneRosterV1p2RestSourceRoute({
        env: providerEnv("tenant-source-owner"),
        tenantId: "tenant-source-other",
        request: jsonRequest(command),
        oneRosterPreview: createOneRosterPreview({ fetcher: provider.fetch }),
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      previewOneRosterV1p2RestSourceRoute({
        env: { HARBOR_DB: getTestEnv().HARBOR_DB },
        tenantId: "tenant-source-owner",
        request: jsonRequest(command),
        oneRosterPreview: createOneRosterPreview({ fetcher: provider.fetch }),
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.not.stringContaining("fixture-secret"),
    });
    expect(
      await getTestEnv()
        .HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM provisioning_runs")
        .first(),
    ).toEqual({ count: 0 });
  });

  it("discovers, authenticates, paginates, projects inactive records, and writes preview ledgers", async () => {
    const provider = createOneRosterV1p2TestProvider();
    const tenantId = "tenant_local_demo";
    const app = createApp({
      oneRosterPreview: createOneRosterPreview({ fetcher: provider.fetch }),
    });
    const appEnvironment = providerAppEnv(tenantId);
    const sourceResponse = await app.fetch(
      routeRequest("/api/instructor/provisioning/oneroster/rest/v1p2/sources", {
        ...sourceConfigurationBody(),
      }),
      appEnvironment,
    );
    expect(sourceResponse.status).toBe(201);
    const configured = await sourceResponse.json<OneRosterV1p2RestSourceRecord>();

    const response = await app.fetch(
      routeRequest("/api/instructor/provisioning/oneroster/rest/v1p2/preview", {
        sourceId: configured.source.id,
        actor: { role: "instructor", actorId: "roster-manager" },
      }),
      appEnvironment,
    );

    expect(response.status).toBe(200);
    const preview = await response.json<OneRosterV1p2RosteringPreviewResponse>();
    expect(preview.diagnostics).toEqual([]);
    expect(preview.run).toMatchObject({ mode: "dry-run", status: "previewed" });
    expect(preview.source).toMatchObject({
      tenantId,
      sourceKind: "oneroster-rest-v1p2",
      id: configured.source.id,
    });
    expect(preview.counts).toMatchObject({
      organizations: { received: 2, unique: 2, active: 1, inactive: 1 },
      academicSessions: { received: 2, unique: 2 },
      courses: { received: 1, unique: 1 },
      classes: { received: 1, unique: 1 },
      users: { received: 2, unique: 2, active: 1, inactive: 1 },
      enrollments: { received: 2, unique: 2, active: 1, inactive: 1 },
    });
    expect(provider.calls.filter((call) => call.path.includes("/rostering/"))).toSatisfy(
      (calls: typeof provider.calls) => calls.every((call) => call.method === "GET"),
    );
    expect(
      provider.calls.some((call) => call.path === "/oauth/token" && call.method === "POST"),
    ).toBe(true);
    expect(
      await getTestEnv()
        .HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM provisioning_runs WHERE tenant_id = ?")
        .bind(tenantId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await getTestEnv().HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM harbor_learners").first(),
    ).toEqual({ count: 0 });

    const report = await app.fetch(
      new Request(
        `https://harbor.local/api/instructor/provisioning/runs/${preview.run.id}/report.csv`,
      ),
      appEnvironment,
    );
    expect(report.status).toBe(200);
    const reportCsv = await report.text();
    expect(reportCsv).toContain("organizations.received,2");
    expect(reportCsv).toContain("academicSessions.unique,2");
    expect(reportCsv).toContain("enrollments.inactive,1");
    expect(reportCsv).not.toContain("[object Object]");
  });

  it("sends an explicit status filter and returns only inactive records", async () => {
    const provider = createOneRosterV1p2TestProvider();
    const result = await run(provider.fetch, {}, new AbortController().signal, "inactive");

    expect(result.counts.organizations).toMatchObject({ unique: 1, active: 0, inactive: 1 });
    expect(result.counts.users).toMatchObject({ unique: 0 });
    expect(result.counts.enrollments).toMatchObject({ unique: 1, inactive: 1 });
  });

  it("diagnoses duplicate delivery while counting each sourcedId once", async () => {
    const provider = createOneRosterV1p2TestProvider({ duplicateOrganizations: true });
    const result = await run(provider.fetch);

    expect(result.counts.organizations).toMatchObject({ received: 3, unique: 2 });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "oneroster.rest.duplicate_delivery", severity: "warning" }),
      ]),
    );
  });

  it("retries an eligible rate-limited read within the explicit bounded policy", async () => {
    const provider = createOneRosterV1p2TestProvider({ rateLimitOnce: "getAllCourses" });
    const result = await run(provider.fetch);

    expect(result.counts.courses.unique).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(provider.calls.filter((call) => call.path.endsWith("/courses"))).toHaveLength(2);
  });

  it("reports malformed responses without retaining the response body", async () => {
    const provider = createOneRosterV1p2TestProvider({ malformedOperation: "getAllUsers" });
    const result = await run(provider.fetch);

    expect(result.counts.users.unique).toBe(0);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oneroster.rest.malformed_json",
          entityKind: "users",
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("not-json");
  });

  it("continues after a bounded partial read failure", async () => {
    const provider = createOneRosterV1p2TestProvider({ failOperation: "getAllCourses" });
    const result = await run(provider.fetch);

    expect(result.counts.courses.unique).toBe(0);
    expect(result.counts.classes.unique).toBe(1);
    expect(result.counts.enrollments.unique).toBe(2);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "oneroster.rest.http_failure", status: 503 }),
      ]),
    );
    expect(provider.calls.filter((call) => call.path.endsWith("/courses"))).toHaveLength(2);
  });

  it("shares page and item budgets across all collections", async () => {
    const pageProvider = createOneRosterV1p2TestProvider();
    const pageLimited = await run(pageProvider.fetch, {
      traversal: {
        pageSize: 1,
        maxPages: 3,
        maxItems: 100,
        maxElapsedMilliseconds: 5_000,
      },
    });
    expect(pageLimited.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ limitKind: "maxPages", entityKind: "academicSessions" }),
      ]),
    );
    expect(pageProvider.calls.filter((call) => call.path.includes("/rostering/"))).toHaveLength(3);
    expect(pageProvider.calls.some((call) => call.path.endsWith("/courses"))).toBe(false);

    const itemProvider = createOneRosterV1p2TestProvider();
    const itemLimited = await run(itemProvider.fetch, {
      traversal: {
        pageSize: 10,
        maxPages: 10,
        maxItems: 2,
        maxElapsedMilliseconds: 5_000,
      },
    });
    expect(itemLimited.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ limitKind: "maxItems" })]),
    );
    expect(itemProvider.calls.filter((call) => call.path.includes("/rostering/"))).toHaveLength(1);
    expect(itemProvider.calls.some((call) => call.path.endsWith("/academicSessions"))).toBe(false);
  });

  it("honors caller cancellation and the shared elapsed-time bound", async () => {
    const cancelledProvider = createOneRosterV1p2TestProvider({ hangOperation: "getAllUsers" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const cancelled = await run(cancelledProvider.fetch, {}, controller.signal);
    expect(cancelled.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.stringContaining("cancelled") }),
      ]),
    );

    const elapsedProvider = createOneRosterV1p2TestProvider({ hangOperation: "getAllUsers" });
    const elapsed = await run(elapsedProvider.fetch, {
      traversal: {
        pageSize: 10,
        maxPages: 10,
        maxItems: 100,
        maxElapsedMilliseconds: 5,
      },
    });
    expect(elapsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oneroster.rest.traversal.elapsed_time",
          limitKind: "elapsedTime",
        }),
      ]),
    );
  });
});

async function run(
  providerFetch: ReturnType<typeof createOneRosterV1p2TestProvider>["fetch"],
  overrides: Parameters<typeof buildOneRosterV1p2PreviewConfiguration>[0] = {},
  signal: AbortSignal = new AbortController().signal,
  statusFilter?: "active" | "inactive",
) {
  return runOneRosterV1p2RosteringPreview({
    configuration: buildOneRosterV1p2PreviewConfiguration(overrides),
    credentials: { clientId: "fixture-client", clientSecret: "fixture-secret" },
    ...(statusFilter === undefined ? {} : { statusFilter }),
    fetch: providerFetch,
    signal,
  });
}

async function configureSource(tenantId: string): Promise<OneRosterV1p2RestSourceRecord> {
  const response = await createOneRosterV1p2RestSourceRoute({
    env: providerEnv(tenantId),
    tenantId,
    request: jsonRequest(sourceConfigurationBody()),
  });
  expect(response.status).toBe(201);
  return response.json<OneRosterV1p2RestSourceRecord>();
}

function sourceConfigurationBody(configuration = buildOneRosterV1p2PreviewConfiguration()) {
  return {
    sourceName: "District OneRoster REST",
    credentialBindingId: ONEROSTER_TEST_CREDENTIAL_BINDING_ID,
    ...configuration,
  };
}

function providerEnv(tenantId: string) {
  return {
    HARBOR_DB: getTestEnv().HARBOR_DB,
    [ONEROSTER_TEST_CREDENTIAL_BINDING_ID]: buildOneRosterTestCredentialBinding(tenantId),
  };
}

function providerAppEnv(tenantId: string) {
  return {
    ...env,
    [ONEROSTER_TEST_CREDENTIAL_BINDING_ID]: buildOneRosterTestCredentialBinding(tenantId),
  };
}

function routeRequest(path: string, body: unknown): Request {
  return new Request(`https://harbor.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonRequest(body: unknown): Request {
  return new Request("https://harbor.test/oneroster", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
