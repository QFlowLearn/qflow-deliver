#!/usr/bin/env node

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const runtimeRoot = path.join(repoRoot, "workers", "runtime");
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "qti", "presidents-sampler-demo");
const wranglerBinPath = path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const assignmentId = "assign_reporting_demo";
const tenantId = "tenant_reporting_demo";
const webOrigin = "http://127.0.0.1:4173";
const workerOrigin = "http://127.0.0.1:8787";

const policySnapshot = {
  availableFrom: "2026-04-29T00:00:00.000Z",
  availableUntil: "2026-05-29T00:00:00.000Z",
  reportingTimezone: "America/New_York",
  maxAttempts: 3,
  timeLimitSeconds: 1800,
  gracePeriodSeconds: 60,
  navigationMode: "free",
  standaloneAllowed: true,
  iframeAllowed: false,
  allowedEmbedOrigins: [],
  secureBrowserRequired: false,
  secureBrowserProviderHint: null,
  proctoringProvider: null,
};

const itemTitles = [
  "Opening Warmup",
  "Declaration Era",
  "Union And Emancipation",
  "Conservation Legacy",
  "New Deal Leadership",
  "Cold War Flashpoint",
  "Civil Rights Era",
  "Presidential Resignation",
  "Unelected Successor",
  "The Great Communicator",
  "Modern Presidency",
  "After The White House",
];

const standards = [
  {
    id: "SS.US.PRES.1",
    code: "SS.US.PRES.1",
    label: "Founding documents and early executive power",
  },
  {
    id: "SS.US.PRES.2",
    code: "SS.US.PRES.2",
    label: "Civil War, reconstruction, and union",
  },
  {
    id: "SS.US.PRES.3",
    code: "SS.US.PRES.3",
    label: "Modern policy leadership",
  },
  {
    id: "SS.US.PRES.4",
    code: "SS.US.PRES.4",
    label: "Contemporary presidency and civic impact",
  },
];

const learners = [
  {
    slug: "avery-trend",
    name: "Avery Trend",
    attempts: [
      { score: 5, submittedAt: "2026-04-29T13:00:00.000Z" },
      { score: 8, submittedAt: "2026-04-29T13:20:00.000Z" },
      {
        score: 10,
        submittedAt: "2026-04-29T13:40:00.000Z",
        status: "rescored",
        amended: true,
      },
    ],
  },
  { slug: "bailey-low", name: "Bailey Low", attempts: [{ score: 4 }] },
  { slug: "casey-low", name: "Casey Low", attempts: [{ score: 5 }] },
  { slug: "dakota-emerging", name: "Dakota Emerging", attempts: [{ score: 6 }] },
  { slug: "emerson-emerging", name: "Emerson Emerging", attempts: [{ score: 6 }] },
  { slug: "finley-developing", name: "Finley Developing", attempts: [{ score: 7 }] },
  { slug: "gray-developing", name: "Gray Developing", attempts: [{ score: 7 }] },
  { slug: "harper-steady", name: "Harper Steady", attempts: [{ score: 8 }] },
  { slug: "indigo-steady", name: "Indigo Steady", attempts: [{ score: 8 }] },
  { slug: "jordan-steady", name: "Jordan Steady", attempts: [{ score: 8 }] },
  { slug: "kai-proficient", name: "Kai Proficient", attempts: [{ score: 9 }] },
  { slug: "logan-proficient", name: "Logan Proficient", attempts: [{ score: 9 }] },
  { slug: "morgan-strong", name: "Morgan Strong", attempts: [{ score: 10 }] },
  { slug: "nova-strong", name: "Nova Strong", attempts: [{ score: 10 }] },
  { slug: "oakley-advanced", name: "Oakley Advanced", attempts: [{ score: 11 }] },
  { slug: "parker-advanced", name: "Parker Advanced", attempts: [{ score: 11 }] },
  { slug: "quinn-complete", name: "Quinn Complete", attempts: [{ score: 12 }] },
  { slug: "riley-complete", name: "Riley Complete", attempts: [{ score: 12 }] },
  { slug: "sage-pending", name: "Sage Pending", attempts: [{ pending: true }] },
  { slug: "taylor-pending", name: "Taylor Pending", attempts: [{ pending: true }] },
  { slug: "urban-failed", name: "Urban Failed", attempts: [{ failed: true }] },
  { slug: "val-active", name: "Val Active", attempts: [{ active: true }] },
  { slug: "winter-not-started", name: "Winter Not Started", attempts: [] },
  { slug: "zion-not-started", name: "Zion Not Started", attempts: [] },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(args["base-url"] ?? workerOrigin);
  const seed = sanitizeSeed(args.seed ?? `reporting-${Date.now()}`);
  const assessmentSlug = `reporting-demo-${seed}`;

  const packageBytes = await createFixturePackage();
  const published = await publishFixture({
    baseUrl,
    assessmentSlug,
    packageBytes,
  });

  const sql = buildSeedSql({
    assessmentId: published.assessmentId,
    assessmentVersionId: published.assessmentVersionId,
  });
  await executeLocalSql(sql);

  console.log("Seeded Harbor reporting demo.");
  console.log(`Assessment version: ${published.assessmentVersionId}`);
  console.log(`Assessment: ${webOrigin}/assessments`);
  console.log(`Roster charts: ${webOrigin}/roster`);
}

async function createFixturePackage() {
  const zip = new JSZip();
  const entries = await collectFixtureFiles(fixtureRoot);
  for (const entry of entries) {
    zip.file(entry.relativePath, await readFile(entry.absolutePath));
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

async function collectFixtureFiles(root) {
  const directories = [root];
  const entries = [];

  while (directories.length > 0) {
    const directory = directories.pop();
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        directories.push(absolutePath);
        continue;
      }

      entries.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).replaceAll("\\", "/"),
      });
    }
  }

  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function publishFixture(input) {
  const publishUrl = new URL("/internal/publish", input.baseUrl);
  publishUrl.searchParams.set("assessmentSlug", input.assessmentSlug);

  const response = await fetch(publishUrl, {
    method: "POST",
    headers: {
      "content-type": "application/zip",
      "x-harbor-package-name": "presidents-sampler-demo.zip",
      "x-harbor-tenant-id": tenantId,
    },
    body: input.packageBytes,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    throw new Error(`Publish failed (${response.status}): ${payload?.error ?? text}`);
  }

  if (
    typeof payload?.assessmentId !== "string" ||
    typeof payload.assessmentVersionId !== "string"
  ) {
    throw new Error("Publish response did not include assessment ids.");
  }

  return payload;
}

function buildSeedSql(input) {
  const statements = [
    "PRAGMA foreign_keys = OFF;",
    "BEGIN TRANSACTION;",
    ...buildCleanupStatements(),
    insert("assignments", {
      id: assignmentId,
      assessment_id: input.assessmentId,
      assessment_version_id: input.assessmentVersionId,
      title: "Presidents Sampler Reporting Demo",
      status: "active",
      policy_snapshot_json: json(policySnapshot),
      created_by_role: "instructor",
      created_by_id: "demo_reporting_seed",
      created_by_display_name: "Reporting Demo Seeder",
      created_at: "2026-04-29T13:00:00.000Z",
      updated_at: new Date().toISOString(),
    }),
    ...buildStandardsStatements(input.assessmentVersionId),
    ...buildLearnerStatements(input.assessmentVersionId),
    "COMMIT;",
    "PRAGMA foreign_keys = ON;",
  ];

  return `${statements.join("\n")}\n`;
}

function buildCleanupStatements() {
  return [
    `DELETE FROM score_amendment_applications WHERE attempt_id LIKE ${sqlValue("attempt_reporting_demo_%")};`,
    `DELETE FROM result_score_revisions WHERE assignment_id = ${sqlValue(assignmentId)};`,
    `DELETE FROM score_amendments WHERE assignment_id = ${sqlValue(assignmentId)};`,
    `DELETE FROM attempt_result_items WHERE attempt_result_id LIKE ${sqlValue("ares_reporting_demo_%")};`,
    `DELETE FROM attempt_results WHERE assignment_id = ${sqlValue(assignmentId)};`,
    `DELETE FROM result_finalizations WHERE assignment_id = ${sqlValue(assignmentId)};`,
    `DELETE FROM attempt_evidence_events WHERE assignment_id = ${sqlValue(assignmentId)};`,
    `DELETE FROM attempt_accommodation_snapshots WHERE assignment_id = ${sqlValue(assignmentId)};`,
    `DELETE FROM attempt_entries WHERE assignment_id = ${sqlValue(assignmentId)};`,
    `DELETE FROM assignment_learner_targets WHERE assignment_id = ${sqlValue(assignmentId)};`,
    `DELETE FROM assignments WHERE id = ${sqlValue(assignmentId)};`,
    `DELETE FROM assessment_item_standard_alignments WHERE id LIKE ${sqlValue("aistd_reporting_demo_%")};`,
    `DELETE FROM learner_identities WHERE learner_id LIKE ${sqlValue("learner_reporting_demo_%")};`,
    `DELETE FROM harbor_learners WHERE id LIKE ${sqlValue("learner_reporting_demo_%")};`,
  ];
}

function buildStandardsStatements(assessmentVersionId) {
  return itemTitles.flatMap((_, index) => {
    const itemNumber = index + 1;
    const standard = standards[Math.floor(index / 3)];
    const itemId = `item-${itemNumber}`;
    return [
      `DELETE FROM assessment_item_standard_alignments WHERE assessment_version_id = ${sqlValue(assessmentVersionId)} AND item_id = ${sqlValue(itemId)};`,
      insert("assessment_item_standard_alignments", {
        id: `aistd_reporting_demo_${itemNumber}`,
        assessment_version_id: assessmentVersionId,
        item_id: itemId,
        standard_id: standard.id,
        standard_code: standard.code,
        standard_label: standard.label,
        standard_uri: `https://standards.example.edu/${standard.id}`,
        provider_id: "LOCAL-DEMO",
        resource_label: null,
        weight: null,
        metadata_json: "{}",
        created_at: "2026-04-29T13:00:00.000Z",
      }),
    ];
  });
}

function buildLearnerStatements(assessmentVersionId) {
  return learners.flatMap((learner, learnerIndex) => {
    const learnerId = `learner_reporting_demo_${learner.slug.replaceAll("-", "_")}`;
    const createdAt = timestampForOffset(learnerIndex * 60);
    const statements = [
      insert("harbor_learners", {
        id: learnerId,
        tenant_id: tenantId,
        display_name: learner.name,
        email: `${learner.slug}@demo.harbor.local`,
        created_at: createdAt,
        updated_at: createdAt,
      }),
      insert("learner_identities", {
        id: `identity_reporting_demo_${learner.slug.replaceAll("-", "_")}`,
        learner_id: learnerId,
        provider_kind: "institutional-sso",
        issuer: "https://institution.harbor.local",
        subject: learner.slug,
        email: `${learner.slug}@demo.harbor.local`,
        display_name: learner.name,
        created_at: createdAt,
        updated_at: createdAt,
      }),
      insert("assignment_learner_targets", {
        id: `target_reporting_demo_${learner.slug.replaceAll("-", "_")}`,
        assignment_id: assignmentId,
        learner_id: learnerId,
        created_at: createdAt,
      }),
    ];

    learner.attempts.forEach((attempt, attemptIndex) => {
      statements.push(
        ...buildAttemptStatements({
          assessmentVersionId,
          learner,
          learnerId,
          learnerIndex,
          attempt,
          attemptIndex,
        }),
      );
    });

    return statements;
  });
}

function buildAttemptStatements(input) {
  const attemptId = `attempt_reporting_demo_${input.learner.slug.replaceAll("-", "_")}_${input.attemptIndex + 1}`;
  const submittedAt =
    input.attempt.submittedAt ??
    timestampForOffset(1_800 + input.learnerIndex * 180 + input.attemptIndex * 60);
  const launchSnapshot = {
    launchMode: "institutional-sso",
    assignmentId,
    learnerId: input.learnerId,
    sessionId: null,
    actor: {
      kind: "student-learner",
      learnerId: input.learnerId,
      sessionId: null,
      id: input.learnerId,
      displayName: input.learner.name,
    },
    launchedAt: timestampForOffset(1_500 + input.learnerIndex * 180),
  };
  const statements = [
    insert("attempt_entries", {
      id: attemptId,
      assessment_version_id: input.assessmentVersionId,
      access_code_id: null,
      launch_mode: "institutional-sso",
      actor_kind: "student-learner",
      actor_id: input.learnerId,
      actor_display_name: input.learner.name,
      delivery_policy_snapshot: json(policySnapshot),
      manifest_object_key: raw(
        `(SELECT manifest_object_key FROM assessment_versions WHERE id = ${sqlValue(input.assessmentVersionId)})`,
      ),
      current_item_id: "item-1",
      current_item_href: "items/item-1.xml",
      created_at: launchSnapshot.launchedAt,
      assignment_id: assignmentId,
      assignment_policy_snapshot: json(policySnapshot),
      launch_snapshot_json: json(launchSnapshot),
    }),
  ];

  if (input.attempt.active) {
    return statements;
  }

  const finalizationStatus = input.attempt.failed
    ? "failed"
    : input.attempt.pending
      ? "pending"
      : "complete";
  const resultId = `ares_reporting_demo_${input.learner.slug.replaceAll("-", "_")}_${input.attemptIndex + 1}`;
  const finalizationId = `rfinal_reporting_demo_${input.learner.slug.replaceAll("-", "_")}_${input.attemptIndex + 1}`;

  statements.push(
    insert("result_finalizations", {
      id: finalizationId,
      attempt_id: attemptId,
      assessment_version_id: input.assessmentVersionId,
      assignment_id: assignmentId,
      source_receipt_id: `receipt_reporting_demo_${input.learner.slug}_${input.attemptIndex + 1}`,
      source_sequence_number: 1,
      status: finalizationStatus,
      materialized_from: "demo-reporting-seed",
      submitted_at: submittedAt,
      finalized_at: finalizationStatus === "pending" ? null : submittedAt,
      error_message: input.attempt.failed ? "Demo scoring service error for visual QA" : null,
      created_at: submittedAt,
      updated_at: submittedAt,
    }),
  );

  if (input.attempt.pending || input.attempt.failed) {
    return statements;
  }

  const score = input.attempt.score;
  statements.push(
    insert("attempt_results", {
      id: resultId,
      attempt_id: attemptId,
      result_finalization_id: finalizationId,
      assessment_version_id: input.assessmentVersionId,
      assignment_id: assignmentId,
      source_receipt_id: `receipt_reporting_demo_${input.learner.slug}_${input.attemptIndex + 1}`,
      status: input.attempt.status ?? "complete",
      summary_source: "demo-reporting-seed",
      total_score: score,
      max_score: 12,
      passed: score >= 8 ? 1 : 0,
      test_outcome_variables_json: json([
        { identifier: "SCORE", value: score },
        { identifier: "MAXSCORE", value: 12 },
      ]),
      submitted_at: submittedAt,
      finalized_at: submittedAt,
      created_at: submittedAt,
      updated_at: submittedAt,
    }),
    ...buildItemResultStatements({
      resultId,
      score,
      submittedAt,
      amended: Boolean(input.attempt.amended),
    }),
  );

  if (input.attempt.amended) {
    statements.push(
      ...buildAmendmentStatements({
        assessmentVersionId: input.assessmentVersionId,
        attemptId,
        resultId,
        submittedAt,
      }),
    );
  }

  if (input.learner.slug === "avery-trend" && input.attemptIndex === 2) {
    statements.push(
      ...buildEvidenceStatements({
        assessmentVersionId: input.assessmentVersionId,
        attemptId,
        submittedAt,
      }),
    );
  }

  return statements;
}

function buildItemResultStatements(input) {
  return itemTitles.map((title, index) => {
    const itemNumber = index + 1;
    const correct = itemNumber <= input.score;
    const amended = input.amended && itemNumber === 11;
    return insert("attempt_result_items", {
      id: `${input.resultId}_item_${itemNumber}`,
      attempt_result_id: input.resultId,
      item_position: index,
      item_id: `item-${itemNumber}`,
      item_identifier: `ITEM_${String(itemNumber).padStart(2, "0")}`,
      item_title: title,
      answered: 1,
      response_summary_text: correct ? "Correct choice" : "Distractor choice",
      score: correct || amended ? 1 : 0,
      max_score: 1,
      base_score: correct ? 1 : 0,
      base_max_score: 1,
      score_amended: amended ? 1 : 0,
      score_amendment_ids_json: amended ? json(["amendment_reporting_demo"]) : "[]",
      outcome_variables_json: json([
        { identifier: "SCORE", value: correct || amended ? 1 : 0 },
        { identifier: "MAXSCORE", value: 1 },
      ]),
      created_at: input.submittedAt,
    });
  });
}

function buildAmendmentStatements(input) {
  return [
    insert("score_amendments", {
      id: "amendment_reporting_demo",
      assignment_id: assignmentId,
      assessment_version_id: input.assessmentVersionId,
      item_id: "item-11",
      action: "set-correct-response",
      response_match_text: "Correct choice",
      reason: "Demo correction: item key changed after review",
      status: "active",
      created_by_role: "instructor",
      created_by_id: "demo_reporting_seed",
      created_by_display_name: "Reporting Demo Seeder",
      superseded_by_id: null,
      superseded_at: null,
      created_at: input.submittedAt,
      updated_at: input.submittedAt,
    }),
    insert("result_score_revisions", {
      id: "srev_reporting_demo",
      attempt_result_id: input.resultId,
      attempt_id: input.attemptId,
      assignment_id: assignmentId,
      revision_number: 1,
      amendment_ids_json: json(["amendment_reporting_demo"]),
      previous_total_score: 9,
      previous_max_score: 12,
      amended_total_score: 10,
      amended_max_score: 12,
      reason: "Demo correction: item key changed after review",
      created_by_role: "instructor",
      created_by_id: "demo_reporting_seed",
      created_by_display_name: "Reporting Demo Seeder",
      created_at: input.submittedAt,
    }),
    insert("score_amendment_applications", {
      id: "sapp_reporting_demo",
      score_revision_id: "srev_reporting_demo",
      amendment_id: "amendment_reporting_demo",
      attempt_result_id: input.resultId,
      attempt_id: input.attemptId,
      item_id: "item-11",
      response_summary_text: "Correct choice",
      base_score: 0,
      base_max_score: 1,
      previous_score: 0,
      previous_max_score: 1,
      amended_score: 1,
      amended_max_score: 1,
      applied_at: input.submittedAt,
      response_evidence_event_id: "ev_reporting_demo_response_item_11",
    }),
  ];
}

function buildEvidenceStatements(input) {
  const baseEvents = [
    {
      id: "ev_reporting_demo_present_item_11",
      eventType: "item-presented",
      evidenceKind: "item-presentation",
      sequenceNumber: 11,
      itemId: "item-11",
      responseKey: null,
      outcome: "observed",
      receiptId: null,
    },
    {
      id: "ev_reporting_demo_response_item_11",
      eventType: "response-committed",
      evidenceKind: "response",
      sequenceNumber: 12,
      itemId: "item-11",
      responseKey: "RESPONSE",
      outcome: "accepted",
      receiptId: "receipt_reporting_demo_response_item_11",
    },
    {
      id: "ev_reporting_demo_submit",
      eventType: "attempt-submitted",
      evidenceKind: "submit",
      sequenceNumber: 13,
      itemId: null,
      responseKey: null,
      outcome: "accepted",
      receiptId: `receipt_${input.attemptId}`,
    },
  ];

  return baseEvents.map((event) =>
    insert("attempt_evidence_events", {
      id: event.id,
      attempt_id: input.attemptId,
      assessment_version_id: input.assessmentVersionId,
      assignment_id: assignmentId,
      event_id: event.id,
      event_type: event.eventType,
      evidence_kind: event.evidenceKind,
      sequence_number: event.sequenceNumber,
      idempotency_key: `idem_${event.id}`,
      client_session_id: "session_reporting_demo",
      item_id: event.itemId,
      item_href: event.itemId ? `items/${event.itemId}.xml` : null,
      response_key: event.responseKey,
      client_timestamp: input.submittedAt,
      server_timestamp: input.submittedAt,
      outcome: event.outcome,
      receipt_id: event.receiptId,
      event_source: "client",
      flags_json: "{}",
      payload_json: "{}",
      created_at: input.submittedAt,
    }),
  );
}

async function executeLocalSql(sql) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "harbor-reporting-demo-"));
  const sqlPath = path.join(temporaryDirectory, "seed-reporting-demo.sql");
  await writeFile(sqlPath, sql, "utf8");

  try {
    await runCommand(
      process.execPath,
      [
        wranglerBinPath,
        "d1",
        "execute",
        "harbor-runtime-local",
        "--local",
        "--config",
        "wrangler.jsonc",
        "--file",
        sqlPath,
      ],
      { cwd: runtimeRoot },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function insert(table, values) {
  const columns = Object.keys(values);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
    .map((column) => sqlValue(values[column]))
    .join(", ")});`;
}

function raw(value) {
  return { rawSql: value };
}

function sqlValue(value) {
  if (value && typeof value === "object" && "rawSql" in value) {
    return value.rawSql;
  }

  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}

function json(value) {
  return JSON.stringify(value);
}

function timestampForOffset(offsetSeconds) {
  return new Date(Date.UTC(2026, 3, 29, 13, 0, offsetSeconds)).toISOString();
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      continue;
    }

    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function normalizeBaseUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("A Harbor worker base URL is required.");
  }

  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function sanitizeSeed(value) {
  const trimmed = String(value ?? "")
    .trim()
    .toLowerCase();
  return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "reporting";
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const output = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.stdout.on("data", (chunk) => {
      output.push(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      output.push(chunk.toString("utf8"));
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const recentOutput = output.join("").trim().split("\n").slice(-30).join("\n");
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed with ${
            signal ? `signal ${signal}` : `exit code ${String(code ?? 0)}`
          }.${recentOutput ? `\n${recentOutput}` : ""}`,
        ),
      );
    });
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
