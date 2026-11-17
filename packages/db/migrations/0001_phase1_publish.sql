CREATE TABLE "assessments" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);

CREATE UNIQUE INDEX "assessments_tenant_slug_idx"
  ON "assessments" ("tenant_id", "slug");

CREATE TABLE "assessment_versions" (
  "id" TEXT PRIMARY KEY,
  "assessment_id" TEXT NOT NULL,
  "version_number" INTEGER NOT NULL,
  "source_package_sha256" TEXT NOT NULL,
  "package_object_key" TEXT NOT NULL,
  "manifest_object_key" TEXT NOT NULL,
  "delivery_policy_snapshot" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id"),
  UNIQUE ("assessment_id", "version_number")
);

CREATE TABLE "delivery_artifacts" (
  "id" TEXT PRIMARY KEY,
  "assessment_version_id" TEXT NOT NULL,
  "artifact_type" TEXT NOT NULL,
  "logical_id" TEXT NOT NULL,
  "href" TEXT NOT NULL,
  "object_key" TEXT NOT NULL,
  "media_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" TEXT,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id"),
  UNIQUE ("assessment_version_id", "artifact_type", "logical_id")
);
