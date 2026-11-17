CREATE TABLE "manual_score_entries" (
  "id" TEXT PRIMARY KEY,
  "attempt_result_id" TEXT NOT NULL,
  "attempt_result_item_id" TEXT NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "assessment_version_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "score" REAL NOT NULL,
  "max_score" REAL NOT NULL,
  "student_feedback" TEXT,
  "private_note" TEXT,
  "scored_by_role" TEXT NOT NULL,
  "scored_by_id" TEXT NOT NULL,
  "scored_by_display_name" TEXT,
  "scored_at" TEXT NOT NULL,
  "released_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_result_id") REFERENCES "attempt_results"("id") ON DELETE CASCADE,
  FOREIGN KEY ("attempt_result_item_id") REFERENCES "attempt_result_items"("id") ON DELETE CASCADE,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  UNIQUE ("attempt_result_item_id")
);

CREATE INDEX "manual_score_entries_attempt_idx"
  ON "manual_score_entries" ("attempt_id", "status", "updated_at" DESC);

CREATE INDEX "manual_score_entries_assignment_idx"
  ON "manual_score_entries" ("assignment_id", "status", "updated_at" DESC);

CREATE TABLE "manual_score_events" (
  "id" TEXT PRIMARY KEY,
  "attempt_result_id" TEXT NOT NULL,
  "attempt_result_item_id" TEXT,
  "attempt_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "assessment_version_id" TEXT NOT NULL,
  "item_id" TEXT,
  "event_type" TEXT NOT NULL,
  "score" REAL,
  "max_score" REAL,
  "student_feedback" TEXT,
  "private_note" TEXT,
  "actor_role" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_display_name" TEXT,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_result_id") REFERENCES "attempt_results"("id") ON DELETE CASCADE,
  FOREIGN KEY ("attempt_result_item_id") REFERENCES "attempt_result_items"("id") ON DELETE SET NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE
);

CREATE INDEX "manual_score_events_attempt_idx"
  ON "manual_score_events" ("attempt_id", "created_at" DESC);

CREATE INDEX "manual_score_events_assignment_idx"
  ON "manual_score_events" ("assignment_id", "created_at" DESC);
