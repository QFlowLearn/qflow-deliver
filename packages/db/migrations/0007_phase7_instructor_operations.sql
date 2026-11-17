CREATE TABLE "assignment_learner_overrides" (
  "id" TEXT PRIMARY KEY,
  "assignment_id" TEXT NOT NULL,
  "learner_id" TEXT NOT NULL,
  "policy_overrides_json" TEXT NOT NULL DEFAULT '{}',
  "accommodations_json" TEXT NOT NULL DEFAULT '{"rendererPnp":{},"sessionControl":{}}',
  "created_by_role" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_by_display_name" TEXT,
  "updated_by_role" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "updated_by_display_name" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("learner_id") REFERENCES "harbor_learners"("id") ON DELETE CASCADE,
  UNIQUE ("assignment_id", "learner_id")
);

CREATE INDEX "assignment_learner_overrides_assignment_idx"
  ON "assignment_learner_overrides" ("assignment_id", "updated_at" DESC);

CREATE INDEX "assignment_learner_overrides_learner_idx"
  ON "assignment_learner_overrides" ("learner_id", "assignment_id");

CREATE INDEX "attempt_entries_assignment_actor_idx"
  ON "attempt_entries" ("assignment_id", "actor_kind", "actor_id", "created_at" DESC);

CREATE INDEX "attempt_results_assignment_status_idx"
  ON "attempt_results" ("assignment_id", "status", "submitted_at" DESC);

CREATE INDEX "result_finalizations_assignment_status_idx"
  ON "result_finalizations" ("assignment_id", "status", "updated_at" DESC);
