import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  AssignmentHistoryResponse,
  AssignmentLearnerOverrideRecord,
  InstructorAssignmentListResponse,
  InstructorAssignmentResultsResponse,
  InstructorAssignmentRosterResponse,
  ResultFinalizationStateSnapshot,
  UpdateAssignmentRequest,
  UpsertAssignmentLearnerOverrideRequest,
} from "@harbor/attempt-protocol";
import { INSTRUCTOR_ASSIGNMENT_ACTIONS } from "@harbor/attempt-protocol";

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
    "assignment_learner_overrides",
    "attempt_result_items",
    "attempt_results",
    "result_finalizations",
    "attempt_entries",
    "assignment_section_targets",
    "assignment_learner_targets",
    "learner_identities",
    "harbor_learners",
    "assignments",
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

async function readIndexNames(tableName: string): Promise<string[]> {
  const { HARBOR_DB } = getTestEnv();
  const result = await HARBOR_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name ASC",
  )
    .bind(tableName)
    .all<{ name: string }>();

  return result.results.map((row) => row.name);
}

beforeEach(async () => {
  await resetDb();
});

describe("instructor contracts", () => {
  it("defines instructor assignment, override, roster, and authoritative history types", () => {
    expect(INSTRUCTOR_ASSIGNMENT_ACTIONS).toEqual(["create", "edit", "activate", "close"]);

    expectTypeOf<UpdateAssignmentRequest>().toMatchTypeOf<{
      title: string;
      actor: {
        role:
          | "instructor"
          | "operator"
          | "system"
          | "qflow"
          | "tenant-administrator"
          | "assessment-manager"
          | "invigilator"
          | "scorer";
        actorId: string;
      };
      policySnapshot: {
        maxAttempts: number;
        navigationMode: "linear" | "free";
      };
    }>();

    expectTypeOf<UpsertAssignmentLearnerOverrideRequest>().toHaveProperty("policyOverrides");
    expectTypeOf<UpsertAssignmentLearnerOverrideRequest>().toHaveProperty("accommodations");

    expectTypeOf<AssignmentLearnerOverrideRecord>().toHaveProperty("assignmentId");
    expectTypeOf<AssignmentLearnerOverrideRecord>().toHaveProperty("learnerId");
    expectTypeOf<AssignmentLearnerOverrideRecord>().toHaveProperty("policyOverrides");
    expectTypeOf<AssignmentLearnerOverrideRecord>().toHaveProperty("accommodations");

    expectTypeOf<ResultFinalizationStateSnapshot>().toMatchTypeOf<{
      status: "pending" | "complete" | "failed";
      errorMessage: string | null;
      updatedAt: string;
    }>();

    expectTypeOf<InstructorAssignmentListResponse>().toMatchTypeOf<{
      assignments: Array<{
        assignmentId: string;
        learnerTargetCount: number;
        sectionTargetCount: number;
      }>;
    }>();

    expectTypeOf<InstructorAssignmentRosterResponse>().toMatchTypeOf<{
      rows: Array<{
        learner: {
          id: string;
          displayName: string;
        };
        latestAttempt: {
          status:
            | "not-started"
            | "active"
            | "soft_closed"
            | "accepting_late_within_grace"
            | "submitted"
            | "expired_pending_recovery"
            | "reopened";
        };
        latestResultStatus: "pending" | "complete" | "failed" | "rescored" | null;
      }>;
    }>();

    expectTypeOf<InstructorAssignmentResultsResponse>().toMatchTypeOf<{
      summary: {
        pendingCount: number;
        completeCount: number;
        failedCount: number;
        rescoredCount: number;
      };
    }>();

    expectTypeOf<AssignmentHistoryResponse>().toMatchTypeOf<{
      assignmentId: string | null;
      assessment: {
        assignmentTitle: string | null;
      };
      actor: {
        learnerId: string | null;
      };
      attempts: Array<{
        resultStatus: "pending" | "complete" | "failed" | "rescored" | null;
        finalization: {
          status: "pending" | "complete" | "failed";
          errorMessage: string | null;
        } | null;
      }>;
    }>();
  });
});

describe("instructor migration schema", () => {
  it("creates learner override storage and read-heavy indexes for roster and result queries", async () => {
    const overrides = await readSchema("assignment_learner_overrides");
    const overrideIndexes = await readIndexNames("assignment_learner_overrides");
    const attemptEntryIndexes = await readIndexNames("attempt_entries");
    const resultIndexes = await readIndexNames("attempt_results");
    const finalizationIndexes = await readIndexNames("result_finalizations");

    expect(overrides).toContain('"assignment_id" TEXT NOT NULL');
    expect(overrides).toContain('"learner_id" TEXT NOT NULL');
    expect(overrides).toContain('"policy_overrides_json" TEXT NOT NULL');
    expect(overrides).toContain('"accommodations_json" TEXT NOT NULL');
    expect(overrides).toContain('UNIQUE ("assignment_id", "learner_id")');

    expect(overrideIndexes).toContain("assignment_learner_overrides_assignment_idx");
    expect(overrideIndexes).toContain("assignment_learner_overrides_learner_idx");
    expect(attemptEntryIndexes).toContain("attempt_entries_assignment_actor_idx");
    expect(resultIndexes).toContain("attempt_results_assignment_status_idx");
    expect(finalizationIndexes).toContain("result_finalizations_assignment_status_idx");
  });
});
