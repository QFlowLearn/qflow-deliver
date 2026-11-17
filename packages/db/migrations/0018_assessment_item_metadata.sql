CREATE TABLE "assessment_item_metadata" (
  "id" TEXT PRIMARY KEY,
  "assessment_version_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "item_identifier" TEXT,
  "item_title" TEXT,
  "item_type" TEXT,
  "max_score" REAL,
  "metadata_json" TEXT NOT NULL DEFAULT '{}',
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  UNIQUE ("assessment_version_id", "item_id")
);

CREATE INDEX "assessment_item_metadata_version_idx"
  ON "assessment_item_metadata" ("assessment_version_id", "item_id");

CREATE TABLE "assessment_item_standard_alignments" (
  "id" TEXT PRIMARY KEY,
  "assessment_version_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "standard_id" TEXT NOT NULL,
  "standard_code" TEXT,
  "standard_label" TEXT,
  "standard_uri" TEXT,
  "provider_id" TEXT,
  "resource_label" TEXT,
  "weight" REAL,
  "metadata_json" TEXT NOT NULL DEFAULT '{}',
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assessment_version_id", "item_id") REFERENCES "assessment_item_metadata"("assessment_version_id", "item_id") ON DELETE CASCADE,
  UNIQUE ("assessment_version_id", "item_id", "provider_id", "standard_id")
);

CREATE INDEX "assessment_item_standard_alignments_version_idx"
  ON "assessment_item_standard_alignments" ("assessment_version_id", "standard_id");

CREATE INDEX "assessment_item_standard_alignments_item_idx"
  ON "assessment_item_standard_alignments" ("assessment_version_id", "item_id");
