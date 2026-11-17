CREATE TABLE "qflow_publish_requests" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "qflow_tenant_id" TEXT NOT NULL,
  "qflow_assessment_id" TEXT NOT NULL,
  "assessment_slug" TEXT NOT NULL,
  "package_url" TEXT NOT NULL,
  "package_name" TEXT NOT NULL,
  "export_format" TEXT NOT NULL,
  "export_warnings_json" TEXT NOT NULL DEFAULT '[]',
  "request_sha256" TEXT NOT NULL,
  "package_sha256" TEXT NOT NULL,
  "package_size_bytes" INTEGER NOT NULL,
  "package_content_type" TEXT,
  "assessment_id" TEXT NOT NULL,
  "assessment_version_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "payload_json" TEXT NOT NULL,
  "fetched_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE
);

CREATE INDEX "qflow_publish_requests_source_idx"
  ON "qflow_publish_requests" (
    "tenant_id",
    "qflow_tenant_id",
    "qflow_assessment_id",
    "created_at" DESC
  );

CREATE TABLE "qflow_assessment_mappings" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "qflow_tenant_id" TEXT NOT NULL,
  "qflow_assessment_id" TEXT NOT NULL,
  "assessment_id" TEXT NOT NULL,
  "latest_assessment_version_id" TEXT NOT NULL,
  "latest_publish_request_id" TEXT NOT NULL,
  "package_url" TEXT NOT NULL,
  "export_format" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("latest_assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("latest_publish_request_id") REFERENCES "qflow_publish_requests"("id") ON DELETE CASCADE,
  UNIQUE ("tenant_id", "qflow_tenant_id", "qflow_assessment_id")
);

CREATE INDEX "qflow_assessment_mappings_version_idx"
  ON "qflow_assessment_mappings" ("latest_assessment_version_id");
