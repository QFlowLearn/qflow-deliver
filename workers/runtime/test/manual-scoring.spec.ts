import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  FinalizeManualScoringResponse,
  ManualScoringQueueResponse,
  SaveManualScoreResponse,
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
    "manual_score_events",
    "manual_score_entries",
    "result_exports",
    "lti_outcome_deliveries",
    "score_amendment_applications",
    "result_score_revisions",
    "score_amendments",
    "attempt_result_items",
    "attempt_results",
    "result_finalizations",
    "attempt_entries",
    "assignment_learner_targets",
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
    .filter((name) => tables.results.some((table) => table.name === name))
    .map((name) => `DELETE FROM ${name}`);
  if (deleteStatements.length > 0) {
    await HARBOR_DB.exec(`${deleteStatements.join("; ")};`);
  }
}

async function get(path: string): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
    }),
  );
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function putJson(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function seedManualAttempt(
  input: {
    tenantId?: string;
    attemptId?: string;
  } = {},
): Promise<{
  attemptId: string;
  itemId: string;
  assignmentId: string;
  assessmentVersionId: string;
  seededAt: string;
}> {
  const { HARBOR_DB } = getTestEnv();
  const tenantId = input.tenantId ?? "tenant_local_demo";
  const suffix = tenantId === "tenant_local_demo" ? "local" : "other";
  const now = "2026-05-24T12:00:00.000Z";
  const assessmentId = `asmt_manual_${suffix}`;
  const assessmentVersionId = `vers_manual_${suffix}`;
  const assignmentId = `assign_manual_${suffix}`;
  const learnerId = `learner_manual_${suffix}`;
  const attemptId = input.attemptId ?? `attempt_manual_${suffix}`;
  const resultFinalizationId = `rfinal_manual_${suffix}`;
  const attemptResultId = `ares_manual_${suffix}`;
  const itemId = `manual-item-${suffix}`;

  await HARBOR_DB.batch([
    HARBOR_DB.prepare(
      "INSERT INTO assessments (id, tenant_id, slug, title, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(assessmentId, tenantId, `manual-${suffix}`, "Manual Assessment", now),
    HARBOR_DB.prepare(
      "INSERT INTO assessment_versions (id, assessment_id, version_number, source_package_sha256, package_object_key, manifest_object_key, delivery_policy_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      assessmentVersionId,
      assessmentId,
      1,
      "sha",
      "packages/manual.zip",
      "manifests/manual.json",
      "{}",
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO assignments (id, assessment_id, assessment_version_id, title, status, policy_snapshot_json, created_by_role, created_by_id, created_by_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      assignmentId,
      assessmentId,
      assessmentVersionId,
      "Manual Assignment",
      "active",
      JSON.stringify({
        availableFrom: null,
        availableUntil: null,
        reportingTimezone: "UTC",
        maxAttempts: 1,
        timeLimitSeconds: null,
        gracePeriodSeconds: null,
        navigationMode: "linear",
        standaloneAllowed: true,
        iframeAllowed: true,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      }),
      "instructor",
      "inst_manual",
      "Manual Instructor",
      now,
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO harbor_learners (id, tenant_id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(learnerId, tenantId, "Manual Learner", "manual@example.edu", now, now),
    HARBOR_DB.prepare(
      "INSERT INTO assignment_learner_targets (id, assignment_id, learner_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(`target_manual_${suffix}`, assignmentId, learnerId, now),
    HARBOR_DB.prepare(
      "INSERT INTO attempt_entries (id, assessment_version_id, access_code_id, launch_mode, actor_kind, actor_id, actor_display_name, delivery_policy_snapshot, manifest_object_key, current_item_id, current_item_href, created_at, assignment_id, assignment_policy_snapshot, launch_snapshot_json) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      attemptId,
      assessmentVersionId,
      "student",
      "student-learner",
      learnerId,
      "Manual Learner",
      "{}",
      "manifests/manual.json",
      itemId,
      "items/manual.xml",
      now,
      assignmentId,
      "{}",
      "{}",
    ),
    HARBOR_DB.prepare(
      "INSERT INTO result_finalizations (id, attempt_id, assessment_version_id, assignment_id, source_receipt_id, source_sequence_number, status, materialized_from, submitted_at, finalized_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    ).bind(
      resultFinalizationId,
      attemptId,
      assessmentVersionId,
      assignmentId,
      `receipt_manual_${suffix}`,
      1,
      "complete",
      "authoritative-qti-snapshot",
      now,
      now,
      now,
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO attempt_results (id, attempt_id, result_finalization_id, assessment_version_id, assignment_id, source_receipt_id, status, summary_source, total_score, max_score, passed, test_response_variables_json, test_outcome_variables_json, submitted_at, finalized_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)",
    ).bind(
      attemptResultId,
      attemptId,
      resultFinalizationId,
      assessmentVersionId,
      assignmentId,
      `receipt_manual_${suffix}`,
      "pending",
      "authoritative-qti-snapshot",
      "[]",
      "[]",
      now,
      now,
      now,
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO attempt_result_items (id, attempt_result_id, item_position, item_id, item_identifier, item_title, answered, response_summary_text, score, max_score, base_score, base_max_score, response_variables_json, outcome_variables_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)",
    ).bind(
      `aresitm_manual_${suffix}`,
      attemptResultId,
      0,
      itemId,
      itemId,
      "Manual Upload",
      1,
      "uploaded-reflection.pdf",
      JSON.stringify([{ identifier: "RESPONSE", value: "uploaded-reflection.pdf" }]),
      JSON.stringify([{ identifier: "HARBOR_SCORING_STATUS", value: "pending-manual-scoring" }]),
      now,
    ),
  ]);

  return {
    attemptId,
    itemId,
    assignmentId,
    assessmentVersionId,
    seededAt: now,
  };
}

async function seedActiveScoreAmendment(input: {
  assignmentId: string;
  assessmentVersionId: string;
  itemId: string;
}): Promise<void> {
  await getTestEnv()
    .HARBOR_DB.prepare(
      "INSERT INTO score_amendments (id, assignment_id, assessment_version_id, item_id, action, response_match_text, reason, status, created_by_role, created_by_id, created_by_display_name, superseded_by_id, superseded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      `samend_${input.itemId}`,
      input.assignmentId,
      input.assessmentVersionId,
      input.itemId,
      "award-full-credit",
      null,
      "Award full credit for reviewed manual item.",
      "active",
      "instructor",
      "inst_manual",
      "Manual Instructor",
      null,
      null,
      "2026-05-24T12:30:00.000Z",
      "2026-05-24T12:30:00.000Z",
    )
    .run();
}

beforeEach(async () => {
  await resetDb();
});

describe("manual scoring", () => {
  it("queues pending manual items, saves drafts, validates scores, and finalizes the result", async () => {
    const seeded = await seedManualAttempt();

    const queueResponse = await get("/api/instructor/manual-scoring");
    expect(queueResponse.status).toBe(200);
    const queue = await queueResponse.json<ManualScoringQueueResponse>();
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0]).toMatchObject({
      attemptId: seeded.attemptId,
      pendingItemCount: 1,
      scoredItemCount: 0,
      status: "needs-review",
    });

    const invalidResponse = await putJson(
      `/api/instructor/manual-scoring/attempts/${seeded.attemptId}/items/${seeded.itemId}`,
      {
        actor: { role: "instructor", actorId: "inst_manual", displayName: "Manual Instructor" },
        score: 3,
        maxScore: 2,
      },
    );
    expect(invalidResponse.status).toBe(400);

    const saveResponse = await putJson(
      `/api/instructor/manual-scoring/attempts/${seeded.attemptId}/items/${seeded.itemId}`,
      {
        actor: { role: "instructor", actorId: "inst_manual", displayName: "Manual Instructor" },
        score: 1.5,
        maxScore: 2,
        studentFeedback: "Strong evidence, add one citation next time.",
        privateNote: "Rubric row B.",
      },
    );
    expect(saveResponse.status).toBe(200);
    const saved = await saveResponse.json<SaveManualScoreResponse>();
    expect(saved.entry).toMatchObject({
      itemId: seeded.itemId,
      score: 1.5,
      maxScore: 2,
      status: "draft",
    });

    const finalizeResponse = await postJson(
      `/api/instructor/manual-scoring/attempts/${seeded.attemptId}/finalize`,
      {
        actor: { role: "instructor", actorId: "inst_manual", displayName: "Manual Instructor" },
      },
    );
    expect(finalizeResponse.status).toBe(200);
    const finalized = await finalizeResponse.json<FinalizeManualScoringResponse>();
    expect(finalized).toMatchObject({
      attemptId: seeded.attemptId,
      status: "complete",
      totalScore: 1.5,
      maxScore: 2,
    });

    const dbRow = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT results.status, results.total_score, results.max_score AS result_max_score, results.passed, results.finalized_at, items.score, items.max_score AS item_max_score, items.outcome_variables_json, manual.status AS manual_status, manual.released_at FROM attempt_results results INNER JOIN attempt_result_items items ON items.attempt_result_id = results.id INNER JOIN manual_score_entries manual ON manual.attempt_result_item_id = items.id WHERE results.attempt_id = ?",
      )
      .bind(seeded.attemptId)
      .first<{
        status: string;
        total_score: number;
        result_max_score: number;
        passed: number | null;
        finalized_at: string;
        score: number;
        item_max_score: number;
        outcome_variables_json: string;
        manual_status: string;
        released_at: string | null;
      }>();
    expect(dbRow?.status).toBe("complete");
    expect(dbRow?.total_score).toBe(1.5);
    expect(dbRow?.result_max_score).toBe(2);
    expect(dbRow?.passed).toBeNull();
    expect(dbRow?.finalized_at).toBe(finalized.finalizedAt);
    expect(dbRow?.finalized_at).not.toBe(seeded.seededAt);
    expect(dbRow?.manual_status).toBe("released");
    expect(dbRow?.released_at).toBeTruthy();
    expect(dbRow?.outcome_variables_json).toContain("manual-scoring-complete");
    expect(dbRow?.outcome_variables_json).toContain("HARBOR_MANUAL_FEEDBACK");

    const auditRows = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT event_type, score, max_score, actor_id FROM manual_score_events WHERE attempt_id = ? ORDER BY created_at ASC",
      )
      .bind(seeded.attemptId)
      .all<{
        event_type: string;
        score: number | null;
        max_score: number | null;
        actor_id: string;
      }>();
    expect(auditRows.results).toEqual([
      {
        event_type: "draft-saved",
        score: 1.5,
        max_score: 2,
        actor_id: "inst_manual",
      },
      {
        event_type: "attempt-finalized",
        score: 1.5,
        max_score: 2,
        actor_id: "inst_manual",
      },
    ]);
  });

  it("rejects manual max points greater than the authored item max", async () => {
    const seeded = await seedManualAttempt();
    await getTestEnv()
      .HARBOR_DB.prepare("UPDATE attempt_result_items SET max_score = ? WHERE item_id = ?")
      .bind(2, seeded.itemId)
      .run();

    const response = await putJson(
      `/api/instructor/manual-scoring/attempts/${seeded.attemptId}/items/${seeded.itemId}`,
      {
        actor: { role: "instructor", actorId: "inst_manual", displayName: "Manual Instructor" },
        score: 2,
        maxScore: 3,
      },
    );

    expect(response.status).toBe(400);
  });

  it("applies active score amendments before publishing manually finalized results", async () => {
    const seeded = await seedManualAttempt();
    await seedActiveScoreAmendment({
      assignmentId: seeded.assignmentId,
      assessmentVersionId: seeded.assessmentVersionId,
      itemId: seeded.itemId,
    });

    const saveResponse = await putJson(
      `/api/instructor/manual-scoring/attempts/${seeded.attemptId}/items/${seeded.itemId}`,
      {
        actor: { role: "instructor", actorId: "inst_manual", displayName: "Manual Instructor" },
        score: 1.5,
        maxScore: 2,
      },
    );
    expect(saveResponse.status).toBe(200);

    const finalizeResponse = await postJson(
      `/api/instructor/manual-scoring/attempts/${seeded.attemptId}/finalize`,
      {
        actor: { role: "instructor", actorId: "inst_manual", displayName: "Manual Instructor" },
      },
    );
    expect(finalizeResponse.status).toBe(200);
    const finalized = await finalizeResponse.json<FinalizeManualScoringResponse>();
    expect(finalized).toMatchObject({
      attemptId: seeded.attemptId,
      status: "rescored",
      totalScore: 2,
      maxScore: 2,
    });

    const dbRow = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT results.status, results.total_score, results.max_score AS result_max_score, results.finalized_at, items.score, items.max_score AS item_max_score, items.base_score, items.base_max_score, items.score_amended FROM attempt_results results INNER JOIN attempt_result_items items ON items.attempt_result_id = results.id WHERE results.attempt_id = ?",
      )
      .bind(seeded.attemptId)
      .first<{
        status: string;
        total_score: number;
        result_max_score: number;
        finalized_at: string;
        score: number;
        item_max_score: number;
        base_score: number;
        base_max_score: number;
        score_amended: number;
      }>();
    expect(dbRow).toMatchObject({
      status: "rescored",
      total_score: 2,
      result_max_score: 2,
      score: 2,
      item_max_score: 2,
      base_score: 1.5,
      base_max_score: 2,
      score_amended: 1,
    });
    expect(dbRow?.finalized_at).toBe(finalized.finalizedAt);
    expect(dbRow?.finalized_at).not.toBe(seeded.seededAt);

    const revisionCounts = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT (SELECT COUNT(*) FROM result_score_revisions) AS revisions, (SELECT COUNT(*) FROM score_amendment_applications) AS applications",
      )
      .first<{ revisions: number; applications: number }>();
    expect(revisionCounts).toMatchObject({
      revisions: 1,
      applications: 1,
    });
  });

  it("treats repeated manual finalize requests as idempotent side-effect scheduling", async () => {
    const seeded = await seedManualAttempt();

    const saveResponse = await putJson(
      `/api/instructor/manual-scoring/attempts/${seeded.attemptId}/items/${seeded.itemId}`,
      {
        actor: { role: "instructor", actorId: "inst_manual", displayName: "Manual Instructor" },
        score: 2,
        maxScore: 2,
      },
    );
    expect(saveResponse.status).toBe(200);

    const firstFinalize = await postJson(
      `/api/instructor/manual-scoring/attempts/${seeded.attemptId}/finalize`,
      {
        actor: { role: "instructor", actorId: "inst_manual", displayName: "Manual Instructor" },
      },
    );
    const secondFinalize = await postJson(
      `/api/instructor/manual-scoring/attempts/${seeded.attemptId}/finalize`,
      {
        actor: { role: "instructor", actorId: "inst_manual", displayName: "Manual Instructor" },
      },
    );

    expect(firstFinalize.status).toBe(200);
    expect(secondFinalize.status).toBe(200);
    await expect(secondFinalize.json<FinalizeManualScoringResponse>()).resolves.toMatchObject({
      attemptId: seeded.attemptId,
      status: "complete",
      totalScore: 2,
      maxScore: 2,
    });

    const exportCount = await getTestEnv()
      .HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM result_exports")
      .first<{ count: number }>();
    expect(exportCount?.count).toBe(1);
  });

  it("blocks cross-tenant manual scoring access", async () => {
    const seeded = await seedManualAttempt({
      tenantId: "tenant_other_manual",
      attemptId: "attempt_manual_other_tenant",
    });

    const response = await get(`/api/instructor/manual-scoring/attempts/${seeded.attemptId}`);
    expect(response.status).toBe(404);
  });
});
