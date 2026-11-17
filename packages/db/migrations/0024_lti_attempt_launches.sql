CREATE TABLE "lti_attempt_launches" (
  "attempt_id" TEXT PRIMARY KEY,
  "registration_id" TEXT NOT NULL,
  "lti_session_id" TEXT NOT NULL,
  "harbor_session_id" TEXT NOT NULL,
  "learner_id" TEXT NOT NULL,
  "resource_link_id" TEXT NOT NULL,
  "context_id" TEXT,
  "ags_lineitem_url" TEXT,
  "ags_lineitems_url" TEXT,
  "ags_scopes_json" TEXT NOT NULL DEFAULT '[]',
  "nrps_membership_url" TEXT,
  "nrps_versions_json" TEXT NOT NULL DEFAULT '[]',
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("registration_id") REFERENCES "lti_registrations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("harbor_session_id") REFERENCES "harbor_sessions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("learner_id") REFERENCES "harbor_learners"("id") ON DELETE CASCADE
);

CREATE INDEX "lti_attempt_launches_registration_idx"
  ON "lti_attempt_launches" ("registration_id", "updated_at" DESC);

CREATE INDEX "lti_attempt_launches_learner_idx"
  ON "lti_attempt_launches" ("learner_id", "updated_at" DESC);
