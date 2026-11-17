import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DELIVERY_POLICY_SNAPSHOT } from "@harbor/content-model";
import {
  InvalidStoredImportValidationCategoryError,
  InvalidStoredImportValidationFindingError,
  readAssessmentVersionValidationReport,
} from "../src/publish/qti-validation-read";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

describe("QTI validation report read adapter", () => {
  beforeEach(async () => {
    const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();
    await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);
    await HARBOR_DB.exec(
      "DELETE FROM assessment_version_validation_findings; DELETE FROM assessment_versions; DELETE FROM assessments;",
    );
    await seedAssessmentVersion(HARBOR_DB);
  });

  it("fails readback when persisted validation contains an unknown category", async () => {
    const { HARBOR_DB } = getTestEnv();
    await insertFinding(HARBOR_DB, { category: "silently-ready" });

    const failure = readAssessmentVersionValidationReport(HARBOR_DB, "vers_read");
    await expect(failure).rejects.toBeInstanceOf(InvalidStoredImportValidationCategoryError);
    await expect(failure).rejects.toMatchObject({
      kind: "invalid-stored-import-validation-category",
      category: "silently-ready",
    });
  });

  it.each([
    [{ scope: "everything" }, "scope"],
    [{ metadataJson: "not-json" }, "metadata_json"],
    [{ metadataJson: "[]" }, "metadata_json"],
  ] as const)("fails readback for invalid persisted finding fields", async (overrides, field) => {
    const { HARBOR_DB } = getTestEnv();
    await insertFinding(HARBOR_DB, overrides);

    await expect(
      readAssessmentVersionValidationReport(HARBOR_DB, "vers_read"),
    ).rejects.toMatchObject({
      kind: "invalid-stored-import-validation-finding",
      field,
    } satisfies Partial<InvalidStoredImportValidationFindingError>);
  });
});

async function seedAssessmentVersion(db: D1Database): Promise<void> {
  const createdAt = "2026-07-21T12:00:00.000Z";
  await db.batch([
    db
      .prepare(
        "INSERT INTO assessments (id, tenant_id, slug, title, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("asmt_read", "tenant-1", "read", "Read", createdAt),
    db
      .prepare(
        "INSERT INTO assessment_versions (id, assessment_id, version_number, source_package_sha256, package_object_key, manifest_object_key, delivery_policy_snapshot, qti_timing_metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "vers_read",
        "asmt_read",
        1,
        "sha256",
        "package.zip",
        "delivery.json",
        JSON.stringify(DEFAULT_DELIVERY_POLICY_SNAPSHOT),
        JSON.stringify({ assessmentTest: null, testParts: [], sections: [], itemRefs: [] }),
        createdAt,
      ),
  ]);
}

async function insertFinding(
  db: D1Database,
  overrides: {
    readonly category?: string;
    readonly scope?: string;
    readonly metadataJson?: string;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO assessment_version_validation_findings (id, assessment_version_id, category, scope, code, message, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "finding_read",
      "vers_read",
      overrides.category ?? "accepted",
      overrides.scope ?? "package",
      "qti.test.category",
      "Category fixture",
      null,
      overrides.metadataJson ?? "{}",
      "2026-07-21T12:00:00.000Z",
    )
    .run();
}
