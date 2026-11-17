CREATE TABLE "lti_nrps_sync_runs" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "registration_id" TEXT NOT NULL,
  "lti_session_id" TEXT NOT NULL,
  "resource_link_id" TEXT NOT NULL,
  "section_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "total_members" INTEGER NOT NULL DEFAULT 0,
  "learner_memberships_upserted" INTEGER NOT NULL DEFAULT 0,
  "learner_memberships_deactivated" INTEGER NOT NULL DEFAULT 0,
  "skipped_members" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT,
  "started_at" TEXT NOT NULL,
  "completed_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("registration_id") REFERENCES "lti_registrations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE
);

CREATE INDEX "lti_nrps_sync_runs_section_idx"
  ON "lti_nrps_sync_runs" ("section_id", "started_at" DESC);

CREATE INDEX "lti_nrps_sync_runs_registration_idx"
  ON "lti_nrps_sync_runs" ("registration_id", "started_at" DESC);
