CREATE UNIQUE INDEX "attempt_evidence_events_attempt_idempotency_idx"
  ON "attempt_evidence_events" ("attempt_id", "idempotency_key")
  WHERE "idempotency_key" LIKE 'support-availability:%';
