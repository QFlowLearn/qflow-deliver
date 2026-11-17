CREATE TABLE "attempt_evidence_events" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "assessment_version_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "event_id" TEXT,
  "event_type" TEXT NOT NULL,
  "evidence_kind" TEXT NOT NULL,
  "sequence_number" INTEGER,
  "idempotency_key" TEXT,
  "client_session_id" TEXT,
  "item_id" TEXT,
  "item_href" TEXT,
  "response_key" TEXT,
  "client_timestamp" TEXT,
  "server_timestamp" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "receipt_id" TEXT,
  "event_source" TEXT NOT NULL DEFAULT 'client',
  "flags_json" TEXT NOT NULL DEFAULT '{}',
  "payload_json" TEXT NOT NULL DEFAULT '{}',
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL
);

CREATE INDEX "attempt_evidence_events_attempt_idx"
  ON "attempt_evidence_events" ("attempt_id", "created_at", "id");

CREATE INDEX "attempt_evidence_events_type_idx"
  ON "attempt_evidence_events" ("event_type", "created_at");

CREATE INDEX "attempt_evidence_events_item_idx"
  ON "attempt_evidence_events" ("attempt_id", "item_id", "sequence_number");

CREATE INDEX "attempt_evidence_events_submit_idx"
  ON "attempt_evidence_events" ("attempt_id", "event_type", "created_at");
