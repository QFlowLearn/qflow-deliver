import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  InstructorLearnerReportResponse,
  InstructorAssignmentReportingResponse,
  InstructorAssignmentResultsResponse,
  InstructorAssignmentRosterResponse,
  StudentLaunchActor,
} from "@harbor/attempt-protocol";
import { INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS } from "@harbor/attempt-protocol";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";
import { ensureLearnerIdentity } from "../src/routes/auth/session";
import { createAttemptEntry } from "../src/launch/create-preview-attempt";
import { buildCsv } from "../src/reports/csv";

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
    "assignment_learner_overrides",
    "score_amendment_applications",
    "result_score_revisions",
    "score_amendments",
    "attempt_result_items",
    "attempt_results",
    "result_finalizations",
    "attempt_accommodation_snapshots",
    "attempt_evidence_events",
    "attempt_entries",
    "assignment_section_targets",
    "assignment_learner_targets",
    "section_memberships",
    "sections",
    "learner_identities",
    "harbor_learners",
    "assignments",
    "assessment_item_standard_alignments",
    "assessment_item_metadata",
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
  assessmentId: string;
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "instructor-results.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function seedStandardAlignment(input: {
  assessmentVersionId: string;
  itemId: string;
  standardId: string;
  standardCode: string;
  standardLabel: string;
}) {
  const { HARBOR_DB } = getTestEnv();
  const now = new Date().toISOString();
  await HARBOR_DB.prepare(
    "INSERT INTO assessment_item_standard_alignments (id, assessment_version_id, item_id, standard_id, standard_code, standard_label, standard_uri, provider_id, resource_label, weight, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `aistd_${input.standardId.replaceAll(/[^a-zA-Z0-9]/g, "")}`,
      input.assessmentVersionId,
      input.itemId,
      input.standardId,
      input.standardCode,
      input.standardLabel,
      `https://case.example.org/${input.standardId}`,
      "CASE",
      null,
      null,
      "{}",
      now,
    )
    .run();
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

async function get(path: string): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
    }),
  );
}

async function createLearner(
  subject: string,
  displayName: string,
): Promise<{
  id: string;
  displayName: string;
  email: string | null;
}> {
  const { HARBOR_DB } = getTestEnv();
  return ensureLearnerIdentity({
    db: HARBOR_DB,
    tenantId: "tenant_local_demo",
    providerKind: "institutional-sso",
    issuer: "https://institution.harbor.local",
    subject,
    displayName,
    email: `${subject}@example.edu`,
  });
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

async function seedFinalization(input: {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string;
  finalizationStatus: "pending" | "complete" | "failed";
  resultStatus?: "complete" | "rescored";
  totalScore?: number | null;
  maxScore?: number | null;
  errorMessage?: string | null;
  submittedAt?: string;
  items?: Array<{
    itemId: string;
    itemIdentifier?: string | null;
    itemTitle?: string | null;
    itemPosition?: number | null;
    answered: boolean;
    responseSummary?: string | null;
    score: number | null;
    maxScore: number | null;
    scoreAmended?: boolean;
  }>;
}) {
  const { HARBOR_DB } = getTestEnv();
  const now = input.submittedAt ?? new Date().toISOString();
  const finalizationId = `rfinal_${input.attemptId.replaceAll("-", "")}`;

  await HARBOR_DB.prepare(
    "INSERT INTO result_finalizations (id, attempt_id, assessment_version_id, assignment_id, source_receipt_id, source_sequence_number, status, materialized_from, submitted_at, finalized_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      finalizationId,
      input.attemptId,
      input.assessmentVersionId,
      input.assignmentId,
      `receipt_${input.attemptId}`,
      1,
      input.finalizationStatus,
      "compatibility-submission-summary",
      now,
      input.finalizationStatus === "pending" ? null : now,
      input.errorMessage ?? null,
      now,
      now,
    )
    .run();

  if (!input.resultStatus) {
    return;
  }

  await HARBOR_DB.prepare(
    "INSERT INTO attempt_results (id, attempt_id, result_finalization_id, assessment_version_id, assignment_id, source_receipt_id, status, summary_source, total_score, max_score, passed, test_outcome_variables_json, submitted_at, finalized_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `ares_${input.attemptId.replaceAll("-", "")}`,
      input.attemptId,
      finalizationId,
      input.assessmentVersionId,
      input.assignmentId,
      `receipt_${input.attemptId}`,
      input.resultStatus,
      "compatibility-submission-summary",
      input.totalScore ?? null,
      input.maxScore ?? null,
      null,
      "[]",
      now,
      now,
      now,
      now,
    )
    .run();

  const resultId = `ares_${input.attemptId.replaceAll("-", "")}`;
  for (const [index, item] of (input.items ?? []).entries()) {
    await HARBOR_DB.prepare(
      "INSERT INTO attempt_result_items (id, attempt_result_id, item_position, item_id, item_identifier, item_title, answered, response_summary_text, score, max_score, base_score, base_max_score, score_amended, score_amendment_ids_json, outcome_variables_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        `aritm_${input.attemptId.replaceAll("-", "")}_${index}`,
        resultId,
        item.itemPosition ?? index,
        item.itemId,
        item.itemIdentifier ?? item.itemId,
        item.itemTitle ?? item.itemId,
        item.answered ? 1 : 0,
        item.responseSummary ?? null,
        item.score,
        item.maxScore,
        item.score,
        item.maxScore,
        item.scoreAmended ? 1 : 0,
        item.scoreAmended ? '["amendment_fixture"]' : "[]",
        "[]",
        now,
      )
      .run();
  }
}

async function seedAccommodationSnapshot(input: {
  attemptId: string;
  tenantId: string;
  learnerId: string;
  assignmentId: string;
}) {
  const { HARBOR_DB } = getTestEnv();
  await HARBOR_DB.prepare(
    "INSERT INTO attempt_accommodation_snapshots (id, attempt_id, tenant_id, learner_id, assignment_id, profile_ids_json, learner_assignment_ids_json, assignment_override_id, accommodations_json, shell_tools_json, timing_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `accsnap_${input.attemptId.replaceAll("-", "")}`,
      input.attemptId,
      input.tenantId,
      input.learnerId,
      input.assignmentId,
      '["profile_high_contrast"]',
      '["lap_high_contrast"]',
      "override_extended_time",
      JSON.stringify({
        rendererPnp: {
          textAppearance: {
            colorStyle: "qti3-player-color-blackwhite",
          },
          layoutSingleColumn: true,
        },
        sessionControl: {},
        shellTools: {
          textToSpeech: true,
          lineReader: true,
        },
      }),
      JSON.stringify({
        textToSpeech: true,
        lineReader: true,
      }),
      JSON.stringify({
        additionalTimeSeconds: 600,
        effectiveTimeLimitSeconds: 2400,
      }),
      "2026-03-28T12:14:30.000Z",
    )
    .run();
}

async function seedAttemptEvidence(input: {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string;
}) {
  const { HARBOR_DB } = getTestEnv();
  const events = [
    {
      id: "ev_present_item_1",
      eventType: "item-presented",
      evidenceKind: "item-presentation",
      sequenceNumber: 1,
      itemId: "item-1",
      responseKey: null,
      clientTimestamp: "2026-03-28T12:14:40.000Z",
      serverTimestamp: "2026-03-28T12:14:41.000Z",
      outcome: "accepted",
      receiptId: null,
      payload: {},
    },
    {
      id: "ev_glossary_offered",
      eventType: "accommodation.support",
      evidenceKind: "accommodation-support",
      sequenceNumber: null,
      itemId: "item-1",
      responseKey: null,
      clientTimestamp: "2026-03-28T12:14:42.000Z",
      serverTimestamp: "2026-03-28T12:14:42.000Z",
      outcome: "accepted",
      receiptId: null,
      payload: { support: "glossary-on-screen", state: "offered" },
    },
    {
      id: "ev_glossary_opened",
      eventType: "accommodation.support",
      evidenceKind: "accommodation-support",
      sequenceNumber: null,
      itemId: "item-1",
      responseKey: null,
      clientTimestamp: "2026-03-28T12:14:43.000Z",
      serverTimestamp: "2026-03-28T12:14:43.000Z",
      outcome: "accepted",
      receiptId: null,
      payload: { support: "glossary-on-screen", state: "opened" },
    },
    {
      id: "ev_keyword_offered",
      eventType: "accommodation.support",
      evidenceKind: "accommodation-support",
      sequenceNumber: null,
      itemId: "item-1",
      responseKey: null,
      clientTimestamp: "2026-03-28T12:14:44.000Z",
      serverTimestamp: "2026-03-28T12:14:44.000Z",
      outcome: "accepted",
      receiptId: null,
      payload: {
        support: "keyword-translation",
        state: "offered",
        requestedLanguage: "es-MX",
        resolvedLanguage: "es",
        selectionReason: "primary-language",
        catalogIds: ["photosynthesis-supports"],
        assetReferences: ["items/translations/photosynthesis-es.txt"],
        mediaTypes: ["text/plain"],
        control: "keyword-translation-dialog",
      },
    },
    {
      id: "ev_keyword_activated",
      eventType: "accommodation.support",
      evidenceKind: "accommodation-support",
      sequenceNumber: null,
      itemId: "item-1",
      responseKey: null,
      clientTimestamp: "2026-03-28T12:14:45.000Z",
      serverTimestamp: "2026-03-28T12:14:45.000Z",
      outcome: "accepted",
      receiptId: null,
      payload: {
        support: "keyword-translation",
        state: "activated",
        requestedLanguage: "es-MX",
        resolvedLanguage: "es",
        selectionReason: "primary-language",
        catalogIds: ["photosynthesis-supports"],
        assetReferences: ["items/translations/photosynthesis-es.txt"],
        mediaTypes: ["text/plain"],
        control: "keyword-translation-dialog",
        reason: "translation-shown",
      },
    },
    {
      id: "ev_keyword_language_selected",
      eventType: "keyword-translation.language.selected",
      evidenceKind: "accommodation-support",
      sequenceNumber: 2,
      itemId: "item-1",
      responseKey: null,
      clientTimestamp: "2026-03-28T12:14:46.000Z",
      serverTimestamp: "2026-03-28T12:14:46.000Z",
      outcome: "accepted",
      receiptId: "receipt_keyword_language_selected",
      payload: {
        support: "keyword-translation",
        state: "language-selected",
        requestedLanguage: "fr-CA",
      },
    },
    {
      id: "ev_response_item_1",
      eventType: "response-committed",
      evidenceKind: "response",
      sequenceNumber: 2,
      itemId: "item-1",
      responseKey: "RESPONSE",
      clientTimestamp: "2026-03-28T12:14:50.000Z",
      serverTimestamp: "2026-03-28T12:14:51.000Z",
      outcome: "accepted",
      receiptId: "receipt_response_item_1",
      payload: {},
    },
    {
      id: "ev_submit_rescored",
      eventType: "attempt-submitted",
      evidenceKind: "submit",
      sequenceNumber: 3,
      itemId: null,
      responseKey: null,
      clientTimestamp: "2026-03-28T12:15:00.000Z",
      serverTimestamp: "2026-03-28T12:15:01.000Z",
      outcome: "accepted",
      receiptId: `receipt_${input.attemptId}`,
      payload: {},
    },
  ];

  for (const event of events) {
    await HARBOR_DB.prepare(
      "INSERT INTO attempt_evidence_events (id, attempt_id, assessment_version_id, assignment_id, event_id, event_type, evidence_kind, sequence_number, idempotency_key, client_session_id, item_id, item_href, response_key, client_timestamp, server_timestamp, outcome, receipt_id, event_source, flags_json, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        event.id,
        input.attemptId,
        input.assessmentVersionId,
        input.assignmentId,
        event.id,
        event.eventType,
        event.evidenceKind,
        event.sequenceNumber,
        `idem_${event.id}`,
        "session_fixture",
        event.itemId,
        event.itemId ? `items/${event.itemId}.xml` : null,
        event.responseKey,
        event.clientTimestamp,
        event.serverTimestamp,
        event.outcome,
        event.receiptId,
        "client",
        "{}",
        JSON.stringify(event.payload),
        event.serverTimestamp,
      )
      .run();
  }
}

async function seedScoreRevision(input: {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string;
  itemId: string;
}) {
  const { HARBOR_DB } = getTestEnv();
  const resultId = `ares_${input.attemptId.replaceAll("-", "")}`;
  await HARBOR_DB.prepare(
    "INSERT INTO score_amendments (id, assignment_id, assessment_version_id, item_id, action, response_match_text, reason, status, created_by_role, created_by_id, created_by_display_name, superseded_by_id, superseded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "amendment_fixture",
      input.assignmentId,
      input.assessmentVersionId,
      input.itemId,
      "set-correct-response",
      "C",
      "Correct key changed from A to C",
      "active",
      "instructor",
      "inst_results",
      "Results Instructor",
      null,
      null,
      "2026-03-28T12:20:00.000Z",
      "2026-03-28T12:20:00.000Z",
    )
    .run();

  await HARBOR_DB.prepare(
    "INSERT INTO result_score_revisions (id, attempt_result_id, attempt_id, assignment_id, revision_number, amendment_ids_json, previous_total_score, previous_max_score, amended_total_score, amended_max_score, reason, created_by_role, created_by_id, created_by_display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "srev_fixture",
      resultId,
      input.attemptId,
      input.assignmentId,
      1,
      '["amendment_fixture"]',
      8,
      10,
      9,
      10,
      "Correct key changed from A to C",
      "instructor",
      "inst_results",
      "Results Instructor",
      "2026-03-28T12:20:00.000Z",
    )
    .run();

  await HARBOR_DB.prepare(
    "INSERT INTO score_amendment_applications (id, score_revision_id, amendment_id, attempt_result_id, attempt_id, item_id, response_summary_text, base_score, base_max_score, previous_score, previous_max_score, amended_score, amended_max_score, applied_at, response_evidence_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "sapp_fixture",
      "srev_fixture",
      "amendment_fixture",
      resultId,
      input.attemptId,
      input.itemId,
      "C",
      0,
      1,
      0,
      1,
      1,
      1,
      "2026-03-28T12:20:00.000Z",
      "ev_response_item_1",
    )
    .run();
}

beforeEach(async () => {
  await resetDb();
});

describe("instructor roster and results views", () => {
  it("reports roster state and authoritative result statuses from Harbor ledgers", async () => {
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "instructor-results-roster",
    });
    await seedStandardAlignment({
      assessmentVersionId: published.assessmentVersionId,
      itemId: "item-1",
      standardId: "std_fraction_add",
      standardCode: "MA.5.FR.1.1",
      standardLabel: "MA.5.FR.1.1 Add and subtract fractions.",
    });

    const learners = await Promise.all([
      createLearner("pending-learner", "Pending Learner"),
      createLearner("complete-learner", "Complete Learner"),
      createLearner("failed-learner", "Failed Learner"),
      createLearner("rescored-learner", "Rescored Learner"),
      createLearner("active-learner", "Active Learner"),
      createLearner("not-started-learner", "Not Started Learner"),
    ]);

    const createAssignment = await postJson("/api/instructor/assignments", {
      assignmentId: "assign_instructor_results_01",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Results Assignment",
      status: "active",
      actor: {
        role: "instructor",
        actorId: "inst_results",
        displayName: "Results Instructor",
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

    const pendingAttempt = await createAssignedAttempt({
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      learnerId: learners[0].id,
      displayName: learners[0].displayName,
    });
    await seedFinalization({
      attemptId: pendingAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      finalizationStatus: "pending",
      submittedAt: "2026-03-28T12:00:00.000Z",
    });

    const completeAttempt = await createAssignedAttempt({
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      learnerId: learners[1].id,
      displayName: learners[1].displayName,
    });
    await seedFinalization({
      attemptId: completeAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      finalizationStatus: "complete",
      resultStatus: "complete",
      totalScore: 8,
      maxScore: 10,
      submittedAt: "2026-03-28T12:05:00.000Z",
      items: [
        {
          itemId: "item-1",
          itemIdentifier: "ITEM_ONE",
          itemTitle: "Evidence item",
          itemPosition: 0,
          answered: true,
          responseSummary: "A",
          score: 0.5,
          maxScore: 1,
        },
      ],
    });

    const failedAttempt = await createAssignedAttempt({
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      learnerId: learners[2].id,
      displayName: learners[2].displayName,
    });
    await seedFinalization({
      attemptId: failedAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      finalizationStatus: "failed",
      errorMessage: "QTI snapshot was invalid",
      submittedAt: "2026-03-28T12:10:00.000Z",
    });

    const rescoredAttempt = await createAssignedAttempt({
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      learnerId: learners[3].id,
      displayName: learners[3].displayName,
    });
    await seedFinalization({
      attemptId: rescoredAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      finalizationStatus: "complete",
      resultStatus: "rescored",
      totalScore: 9,
      maxScore: 10,
      submittedAt: "2026-03-28T12:15:00.000Z",
      items: [
        {
          itemId: "item-1",
          itemIdentifier: "ITEM_ONE",
          itemTitle: "Evidence item",
          itemPosition: 0,
          answered: true,
          responseSummary: "C",
          score: 1,
          maxScore: 1,
          scoreAmended: true,
        },
      ],
    });
    await seedAccommodationSnapshot({
      attemptId: rescoredAttempt.attemptId,
      tenantId: "tenant_local_demo",
      learnerId: learners[3].id,
      assignmentId: "assign_instructor_results_01",
    });
    await seedAttemptEvidence({
      attemptId: rescoredAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
    });
    await seedScoreRevision({
      attemptId: rescoredAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      itemId: "item-1",
    });

    await createAssignedAttempt({
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_instructor_results_01",
      learnerId: learners[4].id,
      displayName: learners[4].displayName,
    });

    const rosterResponse = await get(
      "/api/instructor/assignments/assign_instructor_results_01/roster",
    );
    expect(rosterResponse.status).toBe(200);
    const roster = await rosterResponse.json<InstructorAssignmentRosterResponse>();
    expect(roster.rows).toHaveLength(6);

    const rosterByName = new Map(roster.rows.map((row) => [row.learner.displayName, row]));
    expect(rosterByName.get("Pending Learner")?.latestAttempt.status).toBe("submitted");
    expect(rosterByName.get("Pending Learner")?.latestResultStatus).toBe("pending");

    expect(rosterByName.get("Complete Learner")?.latestResultStatus).toBe("complete");
    expect(rosterByName.get("Complete Learner")?.latestScore).toEqual({
      totalScore: 8,
      maxScore: 10,
    });

    expect(rosterByName.get("Failed Learner")?.latestResultStatus).toBe("failed");
    expect(rosterByName.get("Failed Learner")?.latestFinalization?.errorMessage).toBe(
      "QTI snapshot was invalid",
    );

    expect(rosterByName.get("Rescored Learner")?.latestResultStatus).toBe("rescored");
    expect(rosterByName.get("Active Learner")?.latestAttempt.status).toBe("active");
    expect(rosterByName.get("Active Learner")?.latestResultStatus).toBeNull();
    expect(rosterByName.get("Not Started Learner")?.latestAttempt.status).toBe("not-started");

    const resultsResponse = await get(
      "/api/instructor/assignments/assign_instructor_results_01/results",
    );
    expect(resultsResponse.status).toBe(200);
    const results = await resultsResponse.json<InstructorAssignmentResultsResponse>();

    expect(results.summary).toEqual({
      targetedLearnerCount: 6,
      notStartedCount: 1,
      inProgressCount: 1,
      pendingCount: 1,
      completeCount: 1,
      failedCount: 1,
      rescoredCount: 1,
    });

    const reportingResponse = await get(
      "/api/instructor/assignments/assign_instructor_results_01/reporting",
    );
    expect(reportingResponse.status).toBe(200);
    const reporting = await reportingResponse.json<InstructorAssignmentReportingResponse>();

    expect(reporting.summary).toMatchObject({
      targetedLearnerCount: 6,
      submittedAttemptCount: 4,
      scoredAttemptCount: 2,
      pendingCount: 1,
      failedCount: 1,
      rescoredCount: 1,
      amendedResultCount: 1,
      averageScore: 8.5,
      averageMaxScore: 10,
      averagePercent: 85,
      minPercent: 80,
      maxPercent: 90,
      latestSubmittedAt: "2026-03-28T12:15:00.000Z",
      latestFinalizedAt: "2026-03-28T12:15:00.000Z",
    });
    expect(reporting.standardsMastery).toEqual({
      metadataAvailable: true,
      rows: [
        {
          standardId: "std_fraction_add",
          label: "MA.5.FR.1.1 Add and subtract fractions.",
          itemCount: 1,
          scoredAttemptCount: 2,
          averagePercent: 75,
          weakItemCount: 0,
          weakestItemAveragePercent: 75,
          weaknessSignal: "ok",
        },
      ],
    });
    expect(reporting.itemAnalysis).toEqual([
      {
        itemId: "item-1",
        itemIdentifier: "ITEM_ONE",
        itemTitle: "Evidence item",
        itemPosition: 0,
        answeredCount: 2,
        skippedCount: 0,
        scoredCount: 2,
        fullCreditCount: 1,
        amendedCount: 1,
        averageScore: 0.75,
        maxScore: 1,
        averagePercent: 75,
        pValue: 0.75,
        discriminationIndex: 0.5,
        responseDistribution: [
          {
            responseSummary: "A",
            responseCount: 1,
            responsePercent: 50,
            averageScore: 0.5,
            averagePercent: 50,
            fullCreditCount: 0,
            distractorSignal: "mixed",
          },
          {
            responseSummary: "C",
            responseCount: 1,
            responsePercent: 50,
            averageScore: 1,
            averagePercent: 100,
            fullCreditCount: 1,
            distractorSignal: "full-credit",
          },
        ],
        averageTimeOnItemSeconds: 10,
        timeOnItemSampleCount: 1,
        changedAnswerCount: 0,
        averageResponseChangeCount: 1,
      },
    ]);
    expect(
      reporting.rosterSummary.find((row) => row.learner.displayName === "Rescored Learner"),
    ).toMatchObject({
      resultStatus: "rescored",
      totalScore: 9,
      maxScore: 10,
      percentScore: 90,
      scoreAmended: true,
      submittedAt: "2026-03-28T12:15:00.000Z",
      finalizedAt: "2026-03-28T12:15:00.000Z",
    });

    const learnerReportResponse = await get(
      `/api/instructor/assignments/assign_instructor_results_01/learners/${learners[3].id}/report`,
    );
    expect(learnerReportResponse.status).toBe(200);
    const learnerReport = await learnerReportResponse.json<InstructorLearnerReportResponse>();
    expect(learnerReport.learner.displayName).toBe("Rescored Learner");
    expect(learnerReport.latestResult).toMatchObject({
      status: "rescored",
      totalScore: 9,
      maxScore: 10,
      percentScore: 90,
    });
    expect(learnerReport.itemResults).toEqual([
      {
        itemId: "item-1",
        itemIdentifier: "ITEM_ONE",
        itemTitle: "Evidence item",
        itemPosition: 0,
        answered: true,
        responseSummary: "C",
        score: 1,
        maxScore: 1,
        baseScore: 1,
        baseMaxScore: 1,
        percentScore: 100,
        scoreAmended: true,
        scoreAmendmentIds: ["amendment_fixture"],
        standards: [
          {
            standardId: "std_fraction_add",
            code: "MA.5.FR.1.1",
            label: "MA.5.FR.1.1 Add and subtract fractions.",
          },
        ],
      },
    ]);
    expect(learnerReport.standardsMastery).toEqual({
      metadataAvailable: true,
      rows: [
        {
          standardId: "std_fraction_add",
          label: "MA.5.FR.1.1 Add and subtract fractions.",
          itemCount: 1,
          scoredItemCount: 1,
          averagePercent: 100,
        },
      ],
    });
    expect(learnerReport.accommodationSnapshot).toMatchObject({
      profileIds: ["profile_high_contrast"],
      learnerProfileAssignmentIds: ["lap_high_contrast"],
      assignmentOverrideId: "override_extended_time",
      shellTools: {
        textToSpeech: true,
        lineReader: true,
      },
      timing: {
        additionalTimeSeconds: 600,
        effectiveTimeLimitSeconds: 2400,
      },
      summary: {
        pnp: expect.arrayContaining(["color-theme", "layout-single-column"]),
        shellTools: expect.arrayContaining(["spoken", "line-reader"]),
        extraTimeSeconds: 600,
        effectiveTimeLimitSeconds: 2400,
        colorTheme: "qti3-player-color-blackwhite",
        ttsReadAloud: true,
        calculator: "none",
      },
    });
    expect(learnerReport.evidence.summary).toMatchObject({
      itemPresentationCount: 1,
      responseCount: 1,
      submitCount: 1,
      flaggedCount: 0,
      glossaryAvailableCount: 1,
      glossaryOpenedCount: 1,
      keywordTranslationAvailableCount: 1,
      keywordTranslationUsedCount: 1,
      latestKeywordTranslationRequestedLanguage: "fr-CA",
      latestKeywordTranslationResolvedLanguage: "es",
      latestSubmitAt: "2026-03-28T12:15:01.000Z",
    });
    expect(learnerReport.evidence.events.map((event) => event.evidenceKind)).toEqual([
      "item-presentation",
      "accommodation-support",
      "accommodation-support",
      "accommodation-support",
      "accommodation-support",
      "accommodation-support",
      "response",
      "submit",
    ]);
    expect(
      learnerReport.evidence.events.find((event) => event.id === "ev_keyword_activated"),
    ).toMatchObject({
      support: "keyword-translation",
      supportState: "activated",
      requestedLanguage: "es-MX",
      resolvedLanguage: "es",
      selectionReason: "primary-language",
      catalogIds: ["photosynthesis-supports"],
      assetReferences: ["items/translations/photosynthesis-es.txt"],
      mediaTypes: ["text/plain"],
    });
    expect(learnerReport.scoreHistory).toHaveLength(1);
    expect(learnerReport.scoreHistory[0]).toMatchObject({
      revisionNumber: 1,
      reason: "Correct key changed from A to C",
      applications: [
        {
          itemId: "item-1",
          responseSummary: "C",
          responseEvidenceEventId: "ev_response_item_1",
          responseEvidenceSequenceNumber: 2,
        },
      ],
    });

    const learnerItemsCsvResponse = await get(
      `/api/instructor/assignments/assign_instructor_results_01/learners/${learners[3].id}/report?format=csv&type=items`,
    );
    expect(learnerItemsCsvResponse.status).toBe(200);
    await expect(learnerItemsCsvResponse.text()).resolves.toContain(
      "item-1,ITEM_ONE,Evidence item,0,true,C,1,1,100,true,MA.5.FR.1.1 Add and subtract fractions.",
    );

    const learnerEvidenceCsvResponse = await get(
      `/api/instructor/assignments/assign_instructor_results_01/learners/${learners[3].id}/report?format=csv&type=evidence`,
    );
    expect(learnerEvidenceCsvResponse.status).toBe(200);
    await expect(learnerEvidenceCsvResponse.text()).resolves.toContain(
      "attempt-submitted,submit,accepted,3",
    );
    const learnerEvidenceCsv = await (
      await get(
        `/api/instructor/assignments/assign_instructor_results_01/learners/${learners[3].id}/report?format=csv&type=evidence`,
      )
    ).text();
    expect(learnerEvidenceCsv).toContain(
      "support,support_state,requested_language,resolved_language,selection_reason,catalog_ids,asset_references,media_types,control,reason",
    );
    expect(learnerEvidenceCsv).toContain(
      "keyword-translation,activated,es-MX,es,primary-language,photosynthesis-supports,items/translations/photosynthesis-es.txt,text/plain,keyword-translation-dialog,translation-shown",
    );

    const learnerAttemptsCsvResponse = await get(
      `/api/instructor/assignments/assign_instructor_results_01/learners/${learners[3].id}/report?format=csv&type=attempts`,
    );
    expect(learnerAttemptsCsvResponse.status).toBe(200);
    const learnerAttemptsCsv = await learnerAttemptsCsvResponse.text();
    expect(learnerAttemptsCsv).toContain(
      "accommodation_profiles,accommodation_profile_assignments,accommodation_assignment_override_id,accommodation_pnp,accommodation_shell_tools,accommodation_extra_time_seconds,accommodation_effective_time_limit_seconds,accommodation_color_theme,accommodation_masking,accommodation_tts_read_aloud,accommodation_captions,accommodation_transcripts,accommodation_calculator,accommodation_notes",
    );
    expect(learnerAttemptsCsv).toContain(
      "glossary_available_events,glossary_opened_events,glossary_unavailable_events,keyword_translation_available_events,keyword_translation_used_events,keyword_translation_unavailable_events,latest_keyword_translation_requested_language,latest_keyword_translation_resolved_language",
    );
    expect(learnerAttemptsCsv).toContain(
      "profile_high_contrast,lap_high_contrast,override_extended_time",
    );
    expect(learnerAttemptsCsv).toContain(
      "600,2400,qti3-player-color-blackwhite,false,true,false,false,none,false",
    );

    const rosterCsvResponse = await get(
      "/api/instructor/assignments/assign_instructor_results_01/reporting?format=csv&type=roster",
    );
    expect(rosterCsvResponse.status).toBe(200);
    await expect(rosterCsvResponse.text()).resolves.toContain(
      "learner_id,display_name,email,target_source,attempt_id,result_status,total_score,max_score,percent_score,submitted_at,finalized_at,score_amended",
    );

    const itemCsvResponse = await get(
      "/api/instructor/assignments/assign_instructor_results_01/reporting?format=csv&type=items",
    );
    expect(itemCsvResponse.status).toBe(200);
    await expect(itemCsvResponse.text()).resolves.toContain(
      "item-1,ITEM_ONE,Evidence item,0,2,0,2,1,1,0.75,1,75",
    );

    const standardsCsvResponse = await get(
      "/api/instructor/assignments/assign_instructor_results_01/reporting?format=csv&type=standards",
    );
    expect(standardsCsvResponse.status).toBe(200);
    await expect(standardsCsvResponse.text()).resolves.toContain(
      "std_fraction_add,MA.5.FR.1.1 Add and subtract fractions.,1,2,75",
    );

    const catalogResponse = await get("/api/instructor/report-exports/catalog");
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json<{
      entries: Array<{ artifactType: string; filename: string }>;
      dataDictionary: Array<{
        artifactName: string;
        columnName: string;
        displayLabel: string;
        fieldType: string;
        definition: string;
        sensitivity: string;
      }>;
    }>();
    expect(catalog.entries.map((entry) => entry.artifactType)).toContain("result-export-bundle");
    expect(
      catalog.dataDictionary.some(
        (row) => row.artifactName === "roster.csv" && row.columnName === "learner_id",
      ),
    ).toBe(true);
    expect(
      catalog.dataDictionary.some(
        (row) => row.artifactName === "evidence.csv" && row.columnName === "requested_language",
      ),
    ).toBe(true);
    for (const projection of INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS) {
      expect(catalog.dataDictionary).toContainEqual(
        expect.objectContaining({
          artifactName: "attempts.csv",
          columnName: projection.csvColumn,
          displayLabel: projection.displayLabel,
          fieldType: "number",
          definition: projection.definition,
          sensitivity: "sensitive",
        }),
      );
    }

    const dictionaryCsvResponse = await get(
      "/api/instructor/report-exports/data-dictionary?format=csv",
    );
    expect(dictionaryCsvResponse.status).toBe(200);
    await expect(dictionaryCsvResponse.text()).resolves.toContain(
      "artifact_name,column_name,display_label,type,nullable,definition,source,sensitivity,example,version_introduced",
    );

    const bundleResponse = await get(
      "/api/instructor/assignments/assign_instructor_results_01/report-exports/bundle",
    );
    expect(bundleResponse.status).toBe(200);
    expect(bundleResponse.headers.get("content-type")).toBe("application/zip");
    const bundleZip = await JSZip.loadAsync(await bundleResponse.arrayBuffer());
    expect(Object.keys(bundleZip.files).sort()).toEqual(
      [
        "attempts.csv",
        "data_dictionary.csv",
        "evidence.csv",
        "item_analysis.csv",
        "item_results.csv",
        "manifest.json",
        "roster.csv",
        "score_amendments.csv",
        "score_history.csv",
        "standards_mastery.csv",
      ].sort(),
    );
    const bundleManifest = JSON.parse(await bundleZip.file("manifest.json")!.async("string")) as {
      exportType: string;
      scopeKind: string;
      assignmentId: string;
      artifacts: Array<{ name: string; sha256: string; rowCount: number | null }>;
    };
    expect(bundleManifest).toMatchObject({
      exportType: "result-export-bundle",
      scopeKind: "assessment-administration",
      assignmentId: "assign_instructor_results_01",
    });
    expect(
      bundleManifest.artifacts.find((artifact) => artifact.name === "roster.csv")?.rowCount,
    ).toBe(6);
    expect(bundleManifest.artifacts.every((artifact) => artifact.sha256.length === 64)).toBe(true);
    const assignmentEvidenceCsv = await bundleZip.file("evidence.csv")!.async("string");
    expect(assignmentEvidenceCsv).toContain(
      "keyword-translation,activated,es-MX,es,primary-language",
    );

    const learnerBundleResponse = await get(
      `/api/instructor/assignments/assign_instructor_results_01/learners/${learners[3].id}/report-exports/bundle`,
    );
    expect(learnerBundleResponse.status).toBe(200);
    const learnerZip = await JSZip.loadAsync(await learnerBundleResponse.arrayBuffer());
    expect(Object.keys(learnerZip.files).sort()).toEqual(
      [
        "data_dictionary.csv",
        "learner_attempts.csv",
        "learner_evidence.csv",
        "learner_items.csv",
        "learner_report.json",
        "manifest.json",
        "score_history.csv",
      ].sort(),
    );
    await expect(learnerZip.file("learner_evidence.csv")!.async("string")).resolves.toContain(
      "items/translations/photosynthesis-es.txt",
    );

    expect(buildCsv([["display_name"], ["=2+2"]])).toContain("'=2+2");
  });
});
