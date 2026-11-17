CREATE TABLE "result_exports" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "attempt_result_id" TEXT NOT NULL,
  "result_finalization_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "assessment_version_id" TEXT NOT NULL,
  "source_receipt_id" TEXT NOT NULL,
  "export_format" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "artifact_path" TEXT,
  "artifact_content_type" TEXT,
  "artifact_sha256" TEXT,
  "artifact_size_bytes" INTEGER,
  "retry_of_export_id" TEXT,
  "exported_at" TEXT,
  "error_message" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("attempt_result_id") REFERENCES "attempt_results"("id") ON DELETE CASCADE,
  FOREIGN KEY ("result_finalization_id") REFERENCES "result_finalizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("retry_of_export_id") REFERENCES "result_exports"("id") ON DELETE SET NULL
);

CREATE INDEX "result_exports_attempt_idx"
  ON "result_exports" ("attempt_id", "updated_at" DESC);

CREATE INDEX "result_exports_assignment_status_idx"
  ON "result_exports" ("assignment_id", "status", "updated_at" DESC);

CREATE INDEX "result_exports_receipt_idx"
  ON "result_exports" ("source_receipt_id", "updated_at" DESC);

CREATE TABLE "result_remediation_requests" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "assessment_version_id" TEXT NOT NULL,
  "source_receipt_id" TEXT NOT NULL,
  "scope_kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "result_finalization_id" TEXT,
  "result_export_id" TEXT,
  "retry_of_request_id" TEXT,
  "requested_by_role" TEXT NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "requested_by_display_name" TEXT,
  "reason" TEXT NOT NULL,
  "workflow_instance_id" TEXT,
  "completed_at" TEXT,
  "error_message" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("result_finalization_id") REFERENCES "result_finalizations"("id") ON DELETE SET NULL,
  FOREIGN KEY ("result_export_id") REFERENCES "result_exports"("id") ON DELETE SET NULL,
  FOREIGN KEY ("retry_of_request_id") REFERENCES "result_remediation_requests"("id") ON DELETE SET NULL
);

CREATE INDEX "result_remediation_requests_attempt_idx"
  ON "result_remediation_requests" ("attempt_id", "updated_at" DESC);

CREATE INDEX "result_remediation_requests_assignment_status_idx"
  ON "result_remediation_requests" ("assignment_id", "status", "updated_at" DESC);

CREATE INDEX "result_remediation_requests_receipt_idx"
  ON "result_remediation_requests" ("source_receipt_id", "updated_at" DESC);
