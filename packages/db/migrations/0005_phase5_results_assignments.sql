CREATE TABLE "assignments" (
  "id" TEXT PRIMARY KEY,
  "assessment_id" TEXT NOT NULL,
  "assessment_version_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "policy_snapshot_json" TEXT NOT NULL,
  "created_by_role" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_by_display_name" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE
);

CREATE INDEX "assignments_assessment_version_idx"
  ON "assignments" ("assessment_version_id", "created_at" DESC);

CREATE TABLE "qflow_handoffs" (
  "id" TEXT PRIMARY KEY,
  "handoff_kind" TEXT NOT NULL,
  "assessment_id" TEXT NOT NULL,
  "assessment_version_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "request_sha256" TEXT NOT NULL,
  "payload_json" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL
);

CREATE INDEX "qflow_handoffs_version_idx"
  ON "qflow_handoffs" ("assessment_version_id", "created_at" DESC);

CREATE TABLE "result_finalizations" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "assessment_version_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "source_receipt_id" TEXT NOT NULL,
  "source_sequence_number" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "materialized_from" TEXT NOT NULL,
  "submitted_at" TEXT NOT NULL,
  "finalized_at" TEXT,
  "error_message" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL,
  UNIQUE ("source_receipt_id")
);

CREATE INDEX "result_finalizations_attempt_idx"
  ON "result_finalizations" ("attempt_id", "submitted_at" DESC);

CREATE TABLE "attempt_results" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "result_finalization_id" TEXT NOT NULL,
  "assessment_version_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "source_receipt_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "summary_source" TEXT NOT NULL,
  "total_score" REAL,
  "max_score" REAL,
  "passed" INTEGER,
  "test_outcome_variables_json" TEXT NOT NULL DEFAULT '[]',
  "submitted_at" TEXT NOT NULL,
  "finalized_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("result_finalization_id") REFERENCES "result_finalizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL,
  UNIQUE ("attempt_id"),
  UNIQUE ("result_finalization_id")
);

CREATE INDEX "attempt_results_assignment_idx"
  ON "attempt_results" ("assignment_id", "submitted_at" DESC);

CREATE TABLE "attempt_result_items" (
  "id" TEXT PRIMARY KEY,
  "attempt_result_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "item_identifier" TEXT,
  "item_title" TEXT,
  "answered" INTEGER NOT NULL,
  "score" REAL,
  "max_score" REAL,
  "outcome_variables_json" TEXT NOT NULL DEFAULT '[]',
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_result_id") REFERENCES "attempt_results"("id") ON DELETE CASCADE,
  UNIQUE ("attempt_result_id", "item_id")
);

CREATE INDEX "attempt_result_items_result_idx"
  ON "attempt_result_items" ("attempt_result_id", "item_id");

ALTER TABLE "access_codes" ADD COLUMN "assignment_id" TEXT REFERENCES "assignments"("id");
CREATE INDEX "access_codes_assignment_idx"
  ON "access_codes" ("assignment_id");

ALTER TABLE "attempt_entries" ADD COLUMN "assignment_id" TEXT REFERENCES "assignments"("id");
ALTER TABLE "attempt_entries" ADD COLUMN "assignment_policy_snapshot" TEXT;
ALTER TABLE "attempt_entries" ADD COLUMN "launch_snapshot_json" TEXT;

CREATE INDEX "attempt_entries_assignment_idx"
  ON "attempt_entries" ("assignment_id", "created_at" DESC);
