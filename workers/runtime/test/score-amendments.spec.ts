import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AssignmentHistoryResponse,
  CreateScoreAmendmentResponse,
  DeactivateScoreAmendmentResponse,
  InstructorAssignmentResultsResponse,
  ScoreAmendmentEvidenceExportResponse,
  ScoreAmendmentPreviewResponse,
  ScoreAmendmentsResponse,
  StudentLaunchActor,
} from "@harbor/attempt-protocol";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";
import { createAttemptEntry } from "../src/launch/create-preview-attempt";
import { ensureLearnerIdentity } from "../src/routes/auth/session";

const SCORE_AMENDMENTS_TENANT_ID = "tenant_local_demo";

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

async function resetDb(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "score_amendment_applications",
    "result_score_revisions",
    "score_amendments",
    "result_exports",
    "attempt_result_items",
    "attempt_results",
    "result_finalizations",
    "attempt_evidence_events",
    "attempt_entries",
    "assignment_learner_targets",
    "learner_identities",
    "harbor_learners",
    "assignments",
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

async function publishFixture(): Promise<{
  assessmentId: string;
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request("https://harbor.local/internal/publish?assessmentSlug=score-amendments", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "score-amendments.zip",
        "x-harbor-tenant-id": SCORE_AMENDMENTS_TENANT_ID,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function getJson(path: string): Promise<Response> {
  return workerExports.default.fetch(new Request(`https://harbor.local${path}`));
}

async function createLearner(
  subject: string,
  displayName: string,
): Promise<{
  id: string;
  displayName: string;
}> {
  const { HARBOR_DB } = getTestEnv();
  const learner = await ensureLearnerIdentity({
    db: HARBOR_DB,
    tenantId: SCORE_AMENDMENTS_TENANT_ID,
    providerKind: "institutional-sso",
    issuer: "https://institution.harbor.local",
    subject,
    displayName,
    email: `${subject}@example.edu`,
  });

  return {
    id: learner.id,
    displayName: learner.displayName,
  };
}

async function createAssignedAttempt(input: {
  assessmentVersionId: string;
  assignmentId: string;
  learnerId: string;
  displayName: string;
}) {
  const { HARBOR_DB, CONTENT_BUCKET } = getTestEnv();
  const actor: StudentLaunchActor = {
    kind: "student-learner",
    learnerId: input.learnerId,
    sessionId: null,
    id: input.learnerId,
    displayName: input.displayName,
  };

  return createAttemptEntry({
    db: HARBOR_DB,
    bucket: CONTENT_BUCKET,
    assessmentVersionId: input.assessmentVersionId,
    assignmentId: input.assignmentId,
    launch: {
      mode: "institutional-sso",
      actor,
    },
    launchSnapshot: {
      launchMode: "institutional-sso",
      assignmentId: input.assignmentId,
      learnerId: input.learnerId,
      sessionId: null,
      actor,
      launchedAt: new Date().toISOString(),
    },
  });
}

async function seedScoredResult(input: {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string;
  responseSummary: string;
  score: number;
  maxScore: number;
}): Promise<{
  resultId: string;
  finalizationId: string;
  sourceReceiptId: string;
}> {
  const { HARBOR_DB } = getTestEnv();
  const now = new Date().toISOString();
  const finalizationId = `rfinal_${input.attemptId.replaceAll("-", "")}`;
  const resultId = `ares_${input.attemptId.replaceAll("-", "")}`;
  const sourceReceiptId = `receipt_${input.attemptId}`;

  await HARBOR_DB.batch([
    HARBOR_DB.prepare(
      "INSERT INTO result_finalizations (id, attempt_id, assessment_version_id, assignment_id, source_receipt_id, source_sequence_number, status, materialized_from, submitted_at, finalized_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      finalizationId,
      input.attemptId,
      input.assessmentVersionId,
      input.assignmentId,
      sourceReceiptId,
      1,
      "complete",
      "authoritative-qti-snapshot",
      now,
      now,
      null,
      now,
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO attempt_results (id, attempt_id, result_finalization_id, assessment_version_id, assignment_id, source_receipt_id, status, summary_source, total_score, max_score, passed, test_outcome_variables_json, submitted_at, finalized_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      resultId,
      input.attemptId,
      finalizationId,
      input.assessmentVersionId,
      input.assignmentId,
      sourceReceiptId,
      "complete",
      "authoritative-qti-snapshot",
      input.score,
      input.maxScore,
      input.score === input.maxScore ? 1 : 0,
      JSON.stringify([
        {
          identifier: "SCORE",
          value: input.score,
        },
        {
          identifier: "MAXSCORE",
          value: input.maxScore,
        },
        {
          identifier: "PASSED",
          value: input.score === input.maxScore,
        },
      ]),
      now,
      now,
      now,
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO attempt_result_items (id, attempt_result_id, item_position, item_id, item_identifier, item_title, answered, response_summary_text, score, max_score, outcome_variables_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      `aresitm_${input.attemptId.replaceAll("-", "")}`,
      resultId,
      0,
      "item-1",
      "item-1",
      "Example item",
      1,
      input.responseSummary,
      input.score,
      input.maxScore,
      JSON.stringify([
        {
          identifier: "SCORE",
          value: input.score,
        },
        {
          identifier: "MAXSCORE",
          value: input.maxScore,
        },
      ]),
      now,
    ),
  ]);

  return {
    resultId,
    finalizationId,
    sourceReceiptId,
  };
}

async function seedCompletedResultExport(input: {
  exportId: string;
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
  assignmentId: string;
  assessmentVersionId: string;
  sourceReceiptId: string;
}): Promise<void> {
  const { HARBOR_DB } = getTestEnv();
  const now = new Date().toISOString();

  await HARBOR_DB.prepare(
    "INSERT INTO result_exports (id, attempt_id, attempt_result_id, result_finalization_id, assignment_id, assessment_version_id, source_receipt_id, export_format, status, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, retry_of_export_id, exported_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      input.exportId,
      input.attemptId,
      input.attemptResultId,
      input.resultFinalizationId,
      input.assignmentId,
      input.assessmentVersionId,
      input.sourceReceiptId,
      "qti3-results-report",
      "complete",
      `results/${input.exportId}.xml`,
      "application/xml; charset=utf-8",
      "stale-artifact-sha",
      128,
      null,
      now,
      null,
      now,
      now,
    )
    .run();
}

async function seedResponseEvidence(input: {
  evidenceId: string;
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string;
  responseSummary: string;
  sequenceNumber: number;
}): Promise<void> {
  const { HARBOR_DB } = getTestEnv();
  const now = new Date(Date.now() + input.sequenceNumber).toISOString();

  await HARBOR_DB.prepare(
    "INSERT INTO attempt_evidence_events (id, attempt_id, assessment_version_id, assignment_id, event_id, event_type, evidence_kind, sequence_number, idempotency_key, client_session_id, item_id, item_href, response_key, client_timestamp, server_timestamp, outcome, receipt_id, event_source, flags_json, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      input.evidenceId,
      input.attemptId,
      input.assessmentVersionId,
      input.assignmentId,
      `evt_${input.evidenceId}`,
      "response.changed",
      "response",
      input.sequenceNumber,
      `idem_${input.evidenceId}`,
      "score_amendment_session",
      "item-1",
      "items/item-1.xml",
      "RESPONSE",
      now,
      now,
      "accepted",
      `receipt_${input.evidenceId}`,
      "client",
      "{}",
      JSON.stringify({
        responseKey: "RESPONSE",
        responseState: {
          itemState: {
            responseVariables: [
              {
                identifier: "RESPONSE",
                value: input.responseSummary,
              },
            ],
          },
        },
      }),
      now,
    )
    .run();
}

beforeEach(async () => {
  await resetDb();
});

describe("score amendments and rescoring", () => {
  it("keeps submitted results, applies corrected-answer amendments, and records item-level revision evidence", async () => {
    const published = await publishFixture();
    const learners = await Promise.all([
      createLearner("choice-c-learner", "Choice C Learner"),
      createLearner("choice-a-learner", "Choice A Learner"),
    ]);
    const assignmentId = "assign_score_amendments_01";
    const createAssignment = await postJson("/api/instructor/assignments", {
      assignmentId,
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Score Amendments",
      status: "active",
      actor: {
        role: "instructor",
        actorId: "instructor_score",
        displayName: "Score Instructor",
      },
      policySnapshot: {
        availableFrom: "2026-03-27T00:00:00.000Z",
        availableUntil: "2026-03-30T00:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 3,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
      targets: learners.map((learner) => ({
        kind: "learner",
        learnerId: learner.id,
      })),
    });
    expect(createAssignment.status).toBe(201);

    const choiceCAttempt = await createAssignedAttempt({
      assessmentVersionId: published.assessmentVersionId,
      assignmentId,
      learnerId: learners[0].id,
      displayName: learners[0].displayName,
    });
    const choiceAAttempt = await createAssignedAttempt({
      assessmentVersionId: published.assessmentVersionId,
      assignmentId,
      learnerId: learners[1].id,
      displayName: learners[1].displayName,
    });
    const choiceCSeedResult = await seedScoredResult({
      attemptId: choiceCAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId,
      responseSummary: "choice-c",
      score: 0,
      maxScore: 1,
    });
    await seedResponseEvidence({
      evidenceId: "aev_choice_c_latest",
      attemptId: choiceCAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId,
      responseSummary: "choice-c",
      sequenceNumber: 4,
    });
    await seedScoredResult({
      attemptId: choiceAAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId,
      responseSummary: "choice-a",
      score: 1,
      maxScore: 1,
    });
    await seedResponseEvidence({
      evidenceId: "aev_choice_a_latest",
      attemptId: choiceAAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId,
      responseSummary: "choice-a",
      sequenceNumber: 3,
    });
    await seedCompletedResultExport({
      exportId: "rexp_choice_c_stale",
      attemptId: choiceCAttempt.attemptId,
      attemptResultId: choiceCSeedResult.resultId,
      resultFinalizationId: choiceCSeedResult.finalizationId,
      assignmentId,
      assessmentVersionId: published.assessmentVersionId,
      sourceReceiptId: choiceCSeedResult.sourceReceiptId,
    });

    const previewResponse = await postJson(
      `/api/instructor/assignments/${assignmentId}/score-amendments/preview`,
      {
        actor: {
          role: "instructor",
          actorId: "instructor_score",
          displayName: "Score Instructor",
        },
        itemId: "item-1",
        action: "set-correct-response",
        responseMatchText: "choice-c",
        reason: "Correct answer should have been C, not A.",
      },
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<ScoreAmendmentPreviewResponse>();
    expect(preview).toMatchObject({
      assignmentId,
      itemId: "item-1",
      action: "set-correct-response",
      responseMatchText: "choice-c",
      totalScoredAttemptCount: 2,
      affectedAttemptCount: 2,
      affectedApplicationCount: 2,
      supersededAmendmentIds: [],
    });
    expect(
      new Map(
        preview.attempts.map((attempt) => [
          attempt.attemptId,
          {
            currentTotalScore: attempt.currentTotalScore,
            amendedTotalScore: attempt.amendedTotalScore,
            evidenceId: attempt.applications[0]?.responseEvidenceEventId,
            evidenceSequence: attempt.applications[0]?.responseEvidenceSequenceNumber,
          },
        ]),
      ),
    ).toEqual(
      new Map([
        [
          choiceAAttempt.attemptId,
          {
            currentTotalScore: 1,
            amendedTotalScore: 0,
            evidenceId: "aev_choice_a_latest",
            evidenceSequence: 3,
          },
        ],
        [
          choiceCAttempt.attemptId,
          {
            currentTotalScore: 0,
            amendedTotalScore: 1,
            evidenceId: "aev_choice_c_latest",
            evidenceSequence: 4,
          },
        ],
      ]),
    );
    const previewRevisionCount = await getTestEnv()
      .HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM result_score_revisions")
      .first<{ count: number }>();
    expect(previewRevisionCount?.count).toBe(0);

    const correctionResponse = await postJson(
      `/api/instructor/assignments/${assignmentId}/score-amendments`,
      {
        actor: {
          role: "instructor",
          actorId: "instructor_score",
          displayName: "Score Instructor",
        },
        itemId: "item-1",
        action: "set-correct-response",
        responseMatchText: "choice-c",
        reason: "Correct answer should have been C, not A.",
      },
    );
    expect(correctionResponse.status).toBe(201);
    const correction = await correctionResponse.json<CreateScoreAmendmentResponse>();
    expect(correction.appliedAttemptCount).toBe(2);
    expect(correction.revisionCount).toBe(2);

    const { HARBOR_DB } = getTestEnv();
    const staleExport = await HARBOR_DB.prepare(
      "SELECT status, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, exported_at, error_message FROM result_exports WHERE id = ?",
    )
      .bind("rexp_choice_c_stale")
      .first<{
        status: string;
        artifact_path: string | null;
        artifact_content_type: string | null;
        artifact_sha256: string | null;
        artifact_size_bytes: number | null;
        exported_at: string | null;
        error_message: string | null;
      }>();
    expect(staleExport).toEqual({
      status: "pending",
      artifact_path: null,
      artifact_content_type: null,
      artifact_sha256: null,
      artifact_size_bytes: null,
      exported_at: null,
      error_message: null,
    });

    const correctedResults = await HARBOR_DB.prepare(
      "SELECT attempt_id, status, total_score, max_score, passed, test_outcome_variables_json FROM attempt_results ORDER BY attempt_id",
    ).all<{
      attempt_id: string;
      status: string;
      total_score: number;
      max_score: number;
      passed: number | null;
      test_outcome_variables_json: string;
    }>();
    expect(
      new Map(
        correctedResults.results.map((row) => [
          row.attempt_id,
          {
            status: row.status,
            totalScore: row.total_score,
            maxScore: row.max_score,
            passed: row.passed,
            outcomes: JSON.parse(row.test_outcome_variables_json),
          },
        ]),
      ),
    ).toEqual(
      new Map([
        [
          choiceAAttempt.attemptId,
          {
            status: "rescored",
            totalScore: 0,
            maxScore: 1,
            passed: null,
            outcomes: [
              {
                identifier: "SCORE",
                value: 0,
              },
              {
                identifier: "MAXSCORE",
                value: 1,
              },
            ],
          },
        ],
        [
          choiceCAttempt.attemptId,
          {
            status: "rescored",
            totalScore: 1,
            maxScore: 1,
            passed: null,
            outcomes: [
              {
                identifier: "SCORE",
                value: 1,
              },
              {
                identifier: "MAXSCORE",
                value: 1,
              },
            ],
          },
        ],
      ]),
    );

    const itemRows = await HARBOR_DB.prepare(
      "SELECT attempt_result_id, response_summary_text, score, max_score, base_score, base_max_score, score_amended, score_amendment_ids_json FROM attempt_result_items ORDER BY response_summary_text",
    ).all<{
      attempt_result_id: string;
      response_summary_text: string;
      score: number;
      max_score: number;
      base_score: number;
      base_max_score: number;
      score_amended: number;
      score_amendment_ids_json: string;
    }>();
    expect(itemRows.results.map((row) => row.response_summary_text)).toEqual([
      "choice-a",
      "choice-c",
    ]);
    expect(itemRows.results.map((row) => row.score)).toEqual([0, 1]);
    expect(itemRows.results.map((row) => row.base_score)).toEqual([1, 0]);
    expect(itemRows.results.every((row) => row.score_amended === 1)).toBe(true);
    expect(
      itemRows.results.every((row) =>
        row.score_amendment_ids_json.includes(correction.amendment.id),
      ),
    ).toBe(true);

    const revisionCount = await HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM result_score_revisions",
    ).first<{ count: number }>();
    const applicationCount = await HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM score_amendment_applications",
    ).first<{ count: number }>();
    expect(revisionCount?.count).toBe(2);
    expect(applicationCount?.count).toBe(2);

    const listResponse = await getJson(
      `/api/instructor/assignments/${assignmentId}/score-amendments`,
    );
    expect(listResponse.status).toBe(200);
    const amendmentList = await listResponse.json<ScoreAmendmentsResponse>();
    expect(amendmentList.amendments).toHaveLength(1);
    expect(amendmentList.amendments[0]).toMatchObject({
      id: correction.amendment.id,
      status: "active",
      appliedAttemptCount: 2,
    });

    const resultsResponse = await getJson(`/api/instructor/assignments/${assignmentId}/results`);
    expect(resultsResponse.status).toBe(200);
    const results = await resultsResponse.json<InstructorAssignmentResultsResponse>();
    const choiceCResult = results.rows.find(
      (row) => row.learner.displayName === "Choice C Learner",
    );
    expect(choiceCResult?.latestResultStatus).toBe("rescored");
    expect(choiceCResult?.latestScoreRevision).toMatchObject({
      attemptId: choiceCAttempt.attemptId,
      previousTotalScore: 0,
      amendedTotalScore: 1,
      reason: "Correct answer should have been C, not A.",
    });
    expect(choiceCResult?.latestScoreRevision?.applications[0]?.responseEvidenceEventId).toBe(
      "aev_choice_c_latest",
    );
    expect(
      choiceCResult?.latestScoreRevision?.applications[0]?.responseEvidenceSequenceNumber,
    ).toBe(4);

    const historyResponse = await getJson(`/api/attempts/${choiceCAttempt.attemptId}/history`);
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json<AssignmentHistoryResponse>();
    expect(history.attempts[0]?.latestScoreRevision).toMatchObject({
      attemptId: choiceCAttempt.attemptId,
      revisionNumber: 1,
      previousTotalScore: 0,
      amendedTotalScore: 1,
    });
    expect(history.attempts[0]?.items[0]).toMatchObject({
      itemId: "item-1",
      score: 1,
      maxScore: 1,
      baseScore: 0,
      baseMaxScore: 1,
      scoreAmended: true,
      scoreAmendmentIds: [correction.amendment.id],
    });
    expect(history.attempts[0]?.latestScoreRevision?.applications[0]?.responseEvidenceEventId).toBe(
      "aev_choice_c_latest",
    );

    const exportResponse = await getJson(
      `/api/instructor/assignments/${assignmentId}/score-amendments/export`,
    );
    expect(exportResponse.status).toBe(200);
    const exported = await exportResponse.json<ScoreAmendmentEvidenceExportResponse>();
    expect(exported.amendments).toHaveLength(1);
    expect(exported.revisions).toHaveLength(2);
    expect(exported.revisions.flatMap((revision) => revision.applications)).toHaveLength(2);
    expect(
      exported.revisions
        .flatMap((revision) => revision.applications)
        .map((application) => application.responseEvidenceEventId)
        .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["aev_choice_a_latest", "aev_choice_c_latest"]);

    const csvResponse = await getJson(
      `/api/instructor/assignments/${assignmentId}/score-amendments/export?format=csv`,
    );
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get("content-type")).toContain("text/csv");
    const csv = await csvResponse.text();
    expect(csv).toContain("assignment_id,amendment_id");
    expect(csv).toContain(correction.amendment.id);
    expect(csv).toContain("choice-c");
    expect(csv).toContain("aev_choice_c_latest");

    const deactivateResponse = await postJson(
      `/api/instructor/assignments/${assignmentId}/score-amendments/${correction.amendment.id}/deactivate`,
      {
        actor: {
          role: "instructor",
          actorId: "instructor_score",
          displayName: "Score Instructor",
        },
        reason: "Question restored after review.",
      },
    );
    expect(deactivateResponse.status).toBe(200);
    const deactivation = await deactivateResponse.json<DeactivateScoreAmendmentResponse>();
    expect(deactivation).toMatchObject({
      revertedAttemptCount: 2,
      revisionCount: 2,
      amendment: {
        id: correction.amendment.id,
        status: "inactive",
        deactivatedReason: "Question restored after review.",
        deactivatedBy: {
          actorId: "instructor_score",
        },
      },
    });

    const restoredResults = await HARBOR_DB.prepare(
      "SELECT attempt_id, status, total_score, max_score, passed, test_outcome_variables_json FROM attempt_results ORDER BY attempt_id",
    ).all<{
      attempt_id: string;
      status: string;
      total_score: number;
      max_score: number;
      passed: number | null;
      test_outcome_variables_json: string;
    }>();
    expect(
      new Map(
        restoredResults.results.map((row) => [
          row.attempt_id,
          {
            status: row.status,
            totalScore: row.total_score,
            maxScore: row.max_score,
            passed: row.passed,
            outcomes: JSON.parse(row.test_outcome_variables_json),
          },
        ]),
      ),
    ).toEqual(
      new Map([
        [
          choiceAAttempt.attemptId,
          {
            status: "rescored",
            totalScore: 1,
            maxScore: 1,
            passed: null,
            outcomes: [
              {
                identifier: "SCORE",
                value: 1,
              },
              {
                identifier: "MAXSCORE",
                value: 1,
              },
            ],
          },
        ],
        [
          choiceCAttempt.attemptId,
          {
            status: "rescored",
            totalScore: 0,
            maxScore: 1,
            passed: null,
            outcomes: [
              {
                identifier: "SCORE",
                value: 0,
              },
              {
                identifier: "MAXSCORE",
                value: 1,
              },
            ],
          },
        ],
      ]),
    );

    const restoredItemRows = await HARBOR_DB.prepare(
      "SELECT response_summary_text, score, max_score, base_score, base_max_score, score_amended, score_amendment_ids_json FROM attempt_result_items ORDER BY response_summary_text",
    ).all<{
      response_summary_text: string;
      score: number;
      max_score: number;
      base_score: number;
      base_max_score: number;
      score_amended: number;
      score_amendment_ids_json: string;
    }>();
    expect(restoredItemRows.results.map((row) => row.score)).toEqual([1, 0]);
    expect(restoredItemRows.results.map((row) => row.base_score)).toEqual([1, 0]);
    expect(restoredItemRows.results.every((row) => row.score_amended === 0)).toBe(true);
    expect(restoredItemRows.results.every((row) => row.score_amendment_ids_json === "[]")).toBe(
      true,
    );

    const restoredRevisionCount = await HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM result_score_revisions",
    ).first<{ count: number }>();
    const restoredApplicationCount = await HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM score_amendment_applications",
    ).first<{ count: number }>();
    expect(restoredRevisionCount?.count).toBe(4);
    expect(restoredApplicationCount?.count).toBe(4);

    const restoredResultsResponse = await getJson(
      `/api/instructor/assignments/${assignmentId}/results`,
    );
    expect(restoredResultsResponse.status).toBe(200);
    const restoredInstructorResults =
      await restoredResultsResponse.json<InstructorAssignmentResultsResponse>();
    const restoredChoiceCResult = restoredInstructorResults.rows.find(
      (row) => row.learner.displayName === "Choice C Learner",
    );
    expect(restoredChoiceCResult?.latestScoreRevision).toMatchObject({
      attemptId: choiceCAttempt.attemptId,
      revisionNumber: 2,
      previousTotalScore: 1,
      amendedTotalScore: 0,
      reason: "Score amendment deactivated: Question restored after review.",
    });
    expect(restoredChoiceCResult?.latestScoreRevision?.applications[0]?.amendmentId).toBe(
      correction.amendment.id,
    );

    const inactiveListResponse = await getJson(
      `/api/instructor/assignments/${assignmentId}/score-amendments`,
    );
    expect(inactiveListResponse.status).toBe(200);
    const inactiveList = await inactiveListResponse.json<ScoreAmendmentsResponse>();
    expect(inactiveList.amendments[0]).toMatchObject({
      id: correction.amendment.id,
      status: "inactive",
      deactivatedReason: "Question restored after review.",
      appliedAttemptCount: 2,
    });
  });
});
