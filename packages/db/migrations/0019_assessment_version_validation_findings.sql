CREATE TABLE "assessment_version_validation_findings" (
  "id" TEXT PRIMARY KEY,
  "assessment_version_id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "target_id" TEXT,
  "metadata_json" TEXT NOT NULL DEFAULT '{}',
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE
);

CREATE INDEX "assessment_version_validation_findings_version_idx"
  ON "assessment_version_validation_findings" ("assessment_version_id", "category", "scope");

CREATE INDEX "assessment_version_validation_findings_code_idx"
  ON "assessment_version_validation_findings" ("assessment_version_id", "code");
