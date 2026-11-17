CREATE TABLE "provisioning_orgs" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "sourced_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "org_type" TEXT NOT NULL,
  "identifier" TEXT,
  "parent_sourced_id" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "sourced_id")
);

CREATE INDEX "provisioning_orgs_tenant_idx"
  ON "provisioning_orgs" ("tenant_id", "org_type", "name");

CREATE TABLE "provisioning_academic_sessions" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "sourced_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "session_type" TEXT NOT NULL,
  "start_date" TEXT,
  "end_date" TEXT,
  "parent_sourced_id" TEXT,
  "school_year" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "sourced_id")
);

CREATE INDEX "provisioning_academic_sessions_tenant_idx"
  ON "provisioning_academic_sessions" ("tenant_id", "session_type", "start_date");

CREATE TABLE "provisioning_courses" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "sourced_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "course_code" TEXT,
  "org_sourced_id" TEXT,
  "school_year_sourced_id" TEXT,
  "grades_json" TEXT NOT NULL,
  "subjects_json" TEXT NOT NULL,
  "subject_codes_json" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "sourced_id")
);

CREATE INDEX "provisioning_courses_tenant_idx"
  ON "provisioning_courses" ("tenant_id", "org_sourced_id", "title");

CREATE TABLE "provisioning_section_metadata" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "section_id" TEXT NOT NULL,
  "class_sourced_id" TEXT NOT NULL,
  "course_sourced_id" TEXT,
  "school_sourced_id" TEXT,
  "term_sourced_ids_json" TEXT NOT NULL,
  "class_code" TEXT,
  "class_type" TEXT,
  "location" TEXT,
  "grades_json" TEXT NOT NULL,
  "subjects_json" TEXT NOT NULL,
  "subject_codes_json" TEXT NOT NULL,
  "periods_json" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "class_sourced_id")
);

CREATE INDEX "provisioning_section_metadata_section_idx"
  ON "provisioning_section_metadata" ("section_id");
