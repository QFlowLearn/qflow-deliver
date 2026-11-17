CREATE TABLE "provisioning_gradebook_score_scales" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "sourced_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "raw_row_json" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "sourced_id")
);

CREATE INDEX "provisioning_gradebook_score_scales_tenant_idx"
  ON "provisioning_gradebook_score_scales" ("tenant_id", "title");

CREATE TABLE "provisioning_gradebook_results" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "sourced_id" TEXT NOT NULL,
  "line_item_sourced_id" TEXT,
  "student_sourced_id" TEXT,
  "score" TEXT,
  "text_score" TEXT,
  "score_status" TEXT,
  "score_date" TEXT,
  "score_scale_sourced_id" TEXT,
  "comment" TEXT,
  "status" TEXT NOT NULL,
  "raw_row_json" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "sourced_id")
);

CREATE INDEX "provisioning_gradebook_results_line_item_idx"
  ON "provisioning_gradebook_results" ("tenant_id", "line_item_sourced_id");

CREATE INDEX "provisioning_gradebook_results_student_idx"
  ON "provisioning_gradebook_results" ("tenant_id", "student_sourced_id");
