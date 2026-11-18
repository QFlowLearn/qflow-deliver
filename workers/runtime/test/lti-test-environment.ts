import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";

export const ADMIN_HEADERS = {
  "x-harbor-admin-key": "harbor-admin-local-secret",
} as const;

/** Tables cleared by resetDb and resetLtiProtocolTables (delete order is irrelevant). */
export const LTI_TEST_RESET_TABLES = [
  "lti_outcome_deliveries",
  "lti_nrps_sync_schedules",
  "lti_nrps_sync_runs",
  "lti_attempt_launches",
  "lti_session_bindings",
  "lti_registration_sessions",
  "lti_nonces",
  "lti_sessions",
  "lti_deployments",
  "lti_clients",
  "lti_deep_link_placements",
  "lti_resource_links",
  "lti_launch_states",
  "lti_registrations",
  "harbor_sessions",
  "assignment_section_targets",
  "assignment_learner_targets",
  "section_memberships",
  "sections",
  "learner_identities",
  "harbor_learners",
  "attempt_results",
  "result_finalizations",
  "attempt_entries",
  "assignments",
  "delivery_artifacts",
  "assessment_versions",
  "assessments",
] as const;

export function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  BOOTSTRAP_SIGNING_SECRET: string;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
    BOOTSTRAP_SIGNING_SECRET: string;
  };
}

export async function applyTestMigrations(): Promise<void> {
  const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);
}

async function deleteFromKnownTables(
  database: D1Database,
  tableNames: ReadonlyArray<string>,
): Promise<void> {
  const tables = await database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tableNames
        .map(() => "?")
        .join(", ")})`,
    )
    .bind(...tableNames)
    .all<{ name: string }>();

  const deleteStatements = tableNames
    .filter((tableName) => tables.results.some((table) => table.name === tableName))
    .map((tableName) => `DELETE FROM ${tableName}`);

  if (deleteStatements.length > 0) {
    await database.exec(`${deleteStatements.join("; ")};`);
  }
}

export async function resetLtiProtocolTables(): Promise<void> {
  await applyTestMigrations();
  await deleteFromKnownTables(getTestEnv().HARBOR_DB, [...LTI_TEST_RESET_TABLES]);
}

export async function resetDb(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET } = getTestEnv();
  await applyTestMigrations();
  await deleteFromKnownTables(HARBOR_DB, [...LTI_TEST_RESET_TABLES]);

  let cursor: string | undefined;
  do {
    const listed = await CONTENT_BUCKET.list({ cursor });
    await Promise.all(listed.objects.map((object) => CONTENT_BUCKET.delete(object.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export async function postJson(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

export async function postForm(
  path: string,
  body: Record<string, string>,
  headers?: Record<string, string>,
): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body),
    }),
  );
}

export async function get(path: string, headers?: Record<string, string>): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
      redirect: "manual",
      headers,
    }),
  );
}

export async function exchangeBootstrap(bootstrapToken: string): Promise<Response> {
  return postJson("/api/bootstrap", { bootstrapToken });
}

export async function countRows(tableName: string): Promise<number> {
  const { HARBOR_DB } = getTestEnv();
  const row = await HARBOR_DB.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

export async function tableExists(tableName: string): Promise<boolean> {
  const { HARBOR_DB } = getTestEnv();
  const row = await HARBOR_DB.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
    .bind(tableName)
    .first<{ "1": number }>();
  return Boolean(row);
}
