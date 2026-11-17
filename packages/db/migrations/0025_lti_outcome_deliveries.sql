CREATE TABLE "lti_outcome_deliveries" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "attempt_result_id" TEXT NOT NULL,
  "result_finalization_id" TEXT NOT NULL,
  "lti_session_id" TEXT,
  "status" TEXT NOT NULL,
  "score_given" REAL,
  "score_maximum" REAL,
  "submitted_at" TEXT,
  "delivered_at" TEXT,
  "error_message" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("attempt_result_id") REFERENCES "attempt_results"("id") ON DELETE CASCADE,
  FOREIGN KEY ("result_finalization_id") REFERENCES "result_finalizations"("id") ON DELETE CASCADE,
  UNIQUE ("result_finalization_id")
);

CREATE INDEX "lti_outcome_deliveries_attempt_idx"
  ON "lti_outcome_deliveries" ("attempt_id", "updated_at" DESC);

CREATE INDEX "lti_outcome_deliveries_status_idx"
  ON "lti_outcome_deliveries" ("status", "updated_at" DESC);
