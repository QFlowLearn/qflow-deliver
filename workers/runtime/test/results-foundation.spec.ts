import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  AttemptResultFinalizationRecord,
  AttemptSubmissionMaterializationInput,
  AuthoritativeAttemptResultRecord,
  SubmitRequestedPayload,
} from "@harbor/attempt-protocol";
import {
  ATTEMPT_RESULT_SOURCES,
  ATTEMPT_RESULT_STATUSES,
  RESULT_FINALIZATION_STATUSES,
  SCORE_AMENDMENT_ACTIONS,
  SCORE_AMENDMENT_STATUSES,
} from "@harbor/attempt-protocol";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetDb(): Promise<void> {
  const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "score_amendment_applications",
    "result_score_revisions",
    "score_amendments",
    "attempt_result_items",
    "attempt_results",
    "result_finalizations",
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
}

async function readSchema(tableName: string): Promise<string | null> {
  const { HARBOR_DB } = getTestEnv();
  const table = await HARBOR_DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
    .bind(tableName)
    .first<{ sql: string | null }>();

  return table?.sql ?? null;
}

beforeEach(async () => {
  await resetDb();
});

describe("authoritative result contracts", () => {
  it("defines receipt-keyed finalization and server-owned authoritative result records", () => {
    expect(RESULT_FINALIZATION_STATUSES).toEqual(["pending", "complete", "failed"]);
    expect(ATTEMPT_RESULT_STATUSES).toEqual(["pending", "complete", "failed", "rescored"]);
    expect(ATTEMPT_RESULT_SOURCES).toEqual([
      "authoritative-qti-snapshot",
      "compatibility-submission-summary",
    ]);
    expect(SCORE_AMENDMENT_ACTIONS).toEqual([
      "exclude-from-score",
      "set-correct-response",
      "award-full-credit",
    ]);
    expect(SCORE_AMENDMENT_STATUSES).toEqual(["active", "superseded", "inactive"]);

    expectTypeOf<AttemptResultFinalizationRecord>().toMatchTypeOf<{
      attemptId: string;
      assessmentVersionId: string;
      assignmentId: string | null;
      sourceReceiptId: string;
      sourceSequenceNumber: number;
      status: "pending" | "complete" | "failed";
      materializedFrom: "authoritative-qti-snapshot" | "compatibility-submission-summary";
    }>();

    expectTypeOf<AuthoritativeAttemptResultRecord>().toMatchTypeOf<{
      attemptId: string;
      resultFinalizationId: string;
      assessmentVersionId: string;
      assignmentId: string | null;
      sourceReceiptId: string;
      status: "pending" | "complete" | "failed" | "rescored";
      totalScore: number | null;
      maxScore: number | null;
      passed: boolean | null;
      items: Array<{
        itemId: string;
        score: number | null;
        maxScore: number | null;
      }>;
    }>();
  });

  it("allows submit payloads to carry canonical QTI materialization inputs without promoting compatibility summaries to the institutional record", () => {
    expectTypeOf<SubmitRequestedPayload>().toMatchTypeOf<{
      requestedAt?: string | null;
      submissionSummary?: unknown;
      submissionMaterialization?: AttemptSubmissionMaterializationInput | null;
    }>();

    expectTypeOf<AttemptSubmissionMaterializationInput>().toMatchTypeOf<{
      itemOrder: string[];
      testState: {
        identifier: string;
        outcomeVariables: Array<{ identifier: string; value: unknown }>;
      } | null;
      partStates: Record<string, unknown>;
      sectionStates: Record<string, unknown>;
      items: Record<
        string,
        {
          itemId: string;
          itemIdentifier: string | null;
          itemTitle: string | null;
          responseVariables: Array<{ identifier: string; value: unknown }>;
          outcomeVariables: Array<{ identifier: string; value: unknown }>;
        }
      >;
    }>();
  });
});

describe("authoritative result migration schema", () => {
  it("creates receipt-keyed finalization rows and authoritative result ledgers", async () => {
    const finalizations = await readSchema("result_finalizations");
    const results = await readSchema("attempt_results");
    const items = await readSchema("attempt_result_items");
    const amendments = await readSchema("score_amendments");
    const revisions = await readSchema("result_score_revisions");
    const applications = await readSchema("score_amendment_applications");

    expect(finalizations).toContain('"source_receipt_id" TEXT NOT NULL');
    expect(finalizations).toContain('"source_sequence_number" INTEGER NOT NULL');
    expect(finalizations).toContain('"source_event_type" TEXT NOT NULL');
    expect(finalizations).toContain('"materialized_from" TEXT NOT NULL');
    expect(finalizations).toContain('UNIQUE ("source_receipt_id")');

    expect(results).toContain('"result_finalization_id" TEXT NOT NULL');
    expect(results).toContain('"summary_source" TEXT NOT NULL');
    expect(results).toContain('"passed" INTEGER');
    expect(results).toContain('"test_outcome_variables_json" TEXT NOT NULL');

    expect(items).toContain('"attempt_result_id" TEXT NOT NULL');
    expect(items).toContain('"item_position" INTEGER');
    expect(items).toContain('"item_id" TEXT NOT NULL');
    expect(items).toContain('"response_summary_text" TEXT');
    expect(items).toContain('"base_score" REAL');
    expect(items).toContain('"score_amended" INTEGER NOT NULL DEFAULT 0');
    expect(items).toContain('"score_amendment_ids_json" TEXT NOT NULL');
    expect(items).toContain('"outcome_variables_json" TEXT NOT NULL');

    expect(amendments).toContain('"assignment_id" TEXT NOT NULL');
    expect(amendments).toContain('"item_id" TEXT NOT NULL');
    expect(amendments).toContain('"action" TEXT NOT NULL');
    expect(amendments).toContain('"superseded_by_id" TEXT');
    expect(amendments).toContain('"deactivated_by_id" TEXT');
    expect(amendments).toContain('"deactivated_reason" TEXT');
    expect(amendments).toContain('"deactivated_at" TEXT');

    expect(revisions).toContain('"attempt_result_id" TEXT NOT NULL');
    expect(revisions).toContain('"revision_number" INTEGER NOT NULL');
    expect(revisions).toContain('"amendment_ids_json" TEXT NOT NULL');

    expect(applications).toContain('"score_revision_id" TEXT NOT NULL');
    expect(applications).toContain('"amendment_id" TEXT NOT NULL');
    expect(applications).toContain('"response_evidence_event_id" TEXT');
    expect(applications).toContain('"base_score" REAL');
    expect(applications).toContain('"amended_score" REAL');
  });
});
