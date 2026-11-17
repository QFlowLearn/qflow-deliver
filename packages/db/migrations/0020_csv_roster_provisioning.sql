CREATE TABLE "provisioning_sources" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "source_name" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  UNIQUE ("tenant_id", "source_kind", "source_key")
);

CREATE INDEX "provisioning_sources_tenant_idx"
  ON "provisioning_sources" ("tenant_id", "source_kind", "updated_at" DESC);

CREATE TABLE "provisioning_runs" (
  "id" TEXT PRIMARY KEY,
  "source_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_name" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "actor_role" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_display_name" TEXT,
  "input_sha256" TEXT NOT NULL,
  "row_count" INTEGER NOT NULL,
  "valid_row_count" INTEGER NOT NULL,
  "invalid_row_count" INTEGER NOT NULL,
  "learner_create_count" INTEGER NOT NULL,
  "learner_update_count" INTEGER NOT NULL,
  "section_create_count" INTEGER NOT NULL,
  "section_update_count" INTEGER NOT NULL,
  "membership_create_count" INTEGER NOT NULL,
  "membership_reactivate_count" INTEGER NOT NULL,
  "membership_deactivate_count" INTEGER NOT NULL,
  "membership_unchanged_count" INTEGER NOT NULL,
  "summary_json" TEXT NOT NULL,
  "started_at" TEXT NOT NULL,
  "completed_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE
);

CREATE INDEX "provisioning_runs_tenant_idx"
  ON "provisioning_runs" ("tenant_id", "source_kind", "started_at" DESC);

CREATE INDEX "provisioning_runs_source_idx"
  ON "provisioning_runs" ("source_id", "started_at" DESC);

CREATE TABLE "provisioning_run_errors" (
  "id" TEXT PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "row_number" INTEGER,
  "field" TEXT,
  "code" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "raw_row_json" TEXT,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("run_id") REFERENCES "provisioning_runs"("id") ON DELETE CASCADE
);

CREATE INDEX "provisioning_run_errors_run_idx"
  ON "provisioning_run_errors" ("run_id", "row_number");

CREATE TABLE "external_id_mappings" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "entity_kind" TEXT NOT NULL,
  "source_external_id" TEXT NOT NULL,
  "harbor_entity_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "entity_kind", "source_external_id")
);

CREATE INDEX "external_id_mappings_entity_idx"
  ON "external_id_mappings" ("tenant_id", "entity_kind", "harbor_entity_id");
