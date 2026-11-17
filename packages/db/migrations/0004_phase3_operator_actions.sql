CREATE TABLE "assessment_version_activations" (
  "id" TEXT PRIMARY KEY,
  "assessment_id" TEXT NOT NULL,
  "assessment_version_id" TEXT NOT NULL,
  "actor_role" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_display_name" TEXT,
  "reason" TEXT NOT NULL,
  "activated_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE
);

CREATE INDEX "assessment_version_activations_assessment_idx"
  ON "assessment_version_activations" ("assessment_id", "activated_at" DESC, "created_at" DESC);

CREATE INDEX "assessment_version_activations_version_idx"
  ON "assessment_version_activations" ("assessment_version_id");

CREATE TABLE "attempt_timeline_events" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "sequence_number" INTEGER,
  "actor_role" TEXT,
  "actor_id" TEXT,
  "actor_display_name" TEXT,
  "reason" TEXT,
  "summary_json" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE
);

CREATE INDEX "attempt_timeline_events_attempt_idx"
  ON "attempt_timeline_events" ("attempt_id", "created_at", "id");

CREATE INDEX "attempt_timeline_events_type_idx"
  ON "attempt_timeline_events" ("event_type", "created_at");
