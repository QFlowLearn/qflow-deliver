CREATE TABLE "attempt_deadline_jobs" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "assessment_version_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "scope_key" TEXT NOT NULL,
  "scope_type" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "deadline_at" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "auto_submit_receipt_id" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL
);

CREATE INDEX "attempt_deadline_jobs_due_idx"
  ON "attempt_deadline_jobs" ("status", "deadline_at", "attempt_id");

CREATE INDEX "attempt_deadline_jobs_attempt_idx"
  ON "attempt_deadline_jobs" ("attempt_id", "status", "deadline_at");

CREATE UNIQUE INDEX "attempt_deadline_jobs_unique_scope_idx"
  ON "attempt_deadline_jobs" ("attempt_id", "scope_key", "policy_version", "deadline_at");

CREATE UNIQUE INDEX "attempt_late_evidence_idempotency_idx"
  ON "attempt_evidence_events" ("attempt_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL
    AND "outcome" = 'late_preserved';
