ALTER TABLE "score_amendment_applications"
  ADD COLUMN "response_evidence_event_id" TEXT;

CREATE INDEX "score_amendment_applications_evidence_idx"
  ON "score_amendment_applications" ("response_evidence_event_id");
