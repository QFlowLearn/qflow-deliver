CREATE TABLE "provisioning_staff_users" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "sourced_id" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "email" TEXT,
  "username" TEXT,
  "identifier" TEXT,
  "primary_org_sourced_id" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "sourced_id")
);

CREATE INDEX "provisioning_staff_users_tenant_idx"
  ON "provisioning_staff_users" ("tenant_id", "display_name");

CREATE TABLE "provisioning_class_staff" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "section_id" TEXT NOT NULL,
  "class_sourced_id" TEXT NOT NULL,
  "staff_sourced_id" TEXT NOT NULL,
  "enrollment_sourced_id" TEXT,
  "role" TEXT NOT NULL,
  "primary_flag" TEXT,
  "begin_date" TEXT,
  "end_date" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "class_sourced_id", "staff_sourced_id", "role")
);

CREATE INDEX "provisioning_class_staff_section_idx"
  ON "provisioning_class_staff" ("section_id", "role");
