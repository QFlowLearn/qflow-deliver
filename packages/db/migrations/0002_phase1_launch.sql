CREATE TABLE "access_codes" (
  "id" TEXT PRIMARY KEY,
  "assessment_version_id" TEXT NOT NULL,
  "code_sha256" TEXT NOT NULL,
  "code_last4" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "expires_at" TEXT,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id"),
  UNIQUE ("code_sha256")
);

CREATE INDEX "access_codes_assessment_version_idx"
  ON "access_codes" ("assessment_version_id");

CREATE TABLE "attempt_entries" (
  "id" TEXT PRIMARY KEY,
  "assessment_version_id" TEXT NOT NULL,
  "access_code_id" TEXT,
  "launch_mode" TEXT NOT NULL,
  "actor_kind" TEXT NOT NULL,
  "actor_id" TEXT,
  "actor_display_name" TEXT,
  "delivery_policy_snapshot" TEXT NOT NULL,
  "manifest_object_key" TEXT NOT NULL,
  "current_item_id" TEXT NOT NULL,
  "current_item_href" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id"),
  FOREIGN KEY ("access_code_id") REFERENCES "access_codes"("id")
);

CREATE INDEX "attempt_entries_assessment_version_idx"
  ON "attempt_entries" ("assessment_version_id", "created_at");

CREATE INDEX "attempt_entries_access_code_idx"
  ON "attempt_entries" ("access_code_id");
