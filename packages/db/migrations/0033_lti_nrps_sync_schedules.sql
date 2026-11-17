CREATE TABLE "lti_nrps_sync_schedules" (
  "id" TEXT PRIMARY KEY,
  "resource_link_row_id" TEXT NOT NULL UNIQUE,
  "registration_id" TEXT NOT NULL,
  "resource_link_id" TEXT NOT NULL,
  "section_id" TEXT NOT NULL,
  "enabled" INTEGER NOT NULL DEFAULT 1,
  "interval_minutes" INTEGER NOT NULL DEFAULT 1440,
  "reconciliation_policy" TEXT NOT NULL DEFAULT 'additive-only',
  "next_run_at" TEXT NOT NULL,
  "last_run_at" TEXT,
  "last_run_id" TEXT,
  "last_error_message" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("resource_link_row_id") REFERENCES "lti_resource_links"("id") ON DELETE CASCADE,
  FOREIGN KEY ("registration_id") REFERENCES "lti_registrations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE,
  FOREIGN KEY ("last_run_id") REFERENCES "lti_nrps_sync_runs"("id") ON DELETE SET NULL
);

CREATE INDEX "lti_nrps_sync_schedules_due_idx"
  ON "lti_nrps_sync_schedules" ("enabled", "next_run_at");

CREATE INDEX "lti_nrps_sync_schedules_registration_idx"
  ON "lti_nrps_sync_schedules" ("registration_id", "resource_link_id");
