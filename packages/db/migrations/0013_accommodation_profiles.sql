CREATE TABLE "accommodation_profiles" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL,
  "profile_json" TEXT NOT NULL,
  "created_by_role" TEXT,
  "created_by_id" TEXT,
  "created_by_display_name" TEXT,
  "updated_by_role" TEXT,
  "updated_by_id" TEXT,
  "updated_by_display_name" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX "accommodation_profiles_tenant_status_idx"
  ON "accommodation_profiles" ("tenant_id", "status", "updated_at");

CREATE TABLE "learner_accommodation_assignments" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "learner_id" TEXT NOT NULL,
  "profile_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "effective_at" TEXT NOT NULL,
  "expires_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  UNIQUE ("tenant_id", "learner_id", "profile_id")
);

CREATE INDEX "learner_accommodation_assignments_lookup_idx"
  ON "learner_accommodation_assignments" (
    "tenant_id",
    "learner_id",
    "status",
    "effective_at",
    "expires_at"
  );

CREATE TABLE "attempt_accommodation_snapshots" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL UNIQUE,
  "tenant_id" TEXT NOT NULL,
  "learner_id" TEXT,
  "assignment_id" TEXT,
  "profile_ids_json" TEXT NOT NULL,
  "learner_assignment_ids_json" TEXT NOT NULL,
  "assignment_override_id" TEXT,
  "accommodations_json" TEXT NOT NULL,
  "shell_tools_json" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);

CREATE INDEX "attempt_accommodation_snapshots_learner_idx"
  ON "attempt_accommodation_snapshots" (
    "tenant_id",
    "learner_id",
    "created_at"
  );
