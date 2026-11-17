ALTER TABLE "attempt_result_items"
  ADD COLUMN "base_score" REAL;

ALTER TABLE "attempt_result_items"
  ADD COLUMN "base_max_score" REAL;

ALTER TABLE "attempt_result_items"
  ADD COLUMN "score_amended" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "attempt_result_items"
  ADD COLUMN "score_amendment_ids_json" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE "score_amendments" (
  "id" TEXT PRIMARY KEY,
  "assignment_id" TEXT NOT NULL,
  "assessment_version_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "response_match_text" TEXT,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_by_role" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_by_display_name" TEXT,
  "superseded_by_id" TEXT,
  "superseded_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("superseded_by_id") REFERENCES "score_amendments"("id") ON DELETE SET NULL
);

CREATE INDEX "score_amendments_assignment_idx"
  ON "score_amendments" ("assignment_id", "status", "updated_at" DESC);

CREATE INDEX "score_amendments_item_idx"
  ON "score_amendments" ("assignment_id", "item_id", "status");

CREATE TABLE "result_score_revisions" (
  "id" TEXT PRIMARY KEY,
  "attempt_result_id" TEXT NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "revision_number" INTEGER NOT NULL,
  "amendment_ids_json" TEXT NOT NULL,
  "previous_total_score" REAL,
  "previous_max_score" REAL,
  "amended_total_score" REAL,
  "amended_max_score" REAL,
  "reason" TEXT NOT NULL,
  "created_by_role" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_by_display_name" TEXT,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_result_id") REFERENCES "attempt_results"("id") ON DELETE CASCADE,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL,
  UNIQUE ("attempt_result_id", "revision_number")
);

CREATE INDEX "result_score_revisions_attempt_idx"
  ON "result_score_revisions" ("attempt_id", "created_at" DESC);

CREATE INDEX "result_score_revisions_assignment_idx"
  ON "result_score_revisions" ("assignment_id", "created_at" DESC);

CREATE TABLE "score_amendment_applications" (
  "id" TEXT PRIMARY KEY,
  "score_revision_id" TEXT NOT NULL,
  "amendment_id" TEXT NOT NULL,
  "attempt_result_id" TEXT NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "response_summary_text" TEXT,
  "base_score" REAL,
  "base_max_score" REAL,
  "previous_score" REAL,
  "previous_max_score" REAL,
  "amended_score" REAL,
  "amended_max_score" REAL,
  "applied_at" TEXT NOT NULL,
  FOREIGN KEY ("score_revision_id") REFERENCES "result_score_revisions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("amendment_id") REFERENCES "score_amendments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("attempt_result_id") REFERENCES "attempt_results"("id") ON DELETE CASCADE,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE
);

CREATE INDEX "score_amendment_applications_amendment_idx"
  ON "score_amendment_applications" ("amendment_id", "applied_at" DESC);

CREATE INDEX "score_amendment_applications_attempt_idx"
  ON "score_amendment_applications" ("attempt_id", "applied_at" DESC);
