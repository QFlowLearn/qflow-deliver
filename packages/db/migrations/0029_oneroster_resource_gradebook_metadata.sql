CREATE TABLE "provisioning_resources" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "sourced_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "vendor_resource_id" TEXT,
  "resource_type" TEXT,
  "roles_json" TEXT NOT NULL,
  "importance" TEXT,
  "vendor_id" TEXT,
  "application_id" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "sourced_id")
);

CREATE INDEX "provisioning_resources_tenant_idx"
  ON "provisioning_resources" ("tenant_id", "title");

CREATE TABLE "provisioning_class_resources" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "class_sourced_id" TEXT NOT NULL,
  "resource_sourced_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "class_sourced_id", "resource_sourced_id")
);

CREATE INDEX "provisioning_class_resources_class_idx"
  ON "provisioning_class_resources" ("tenant_id", "class_sourced_id");

CREATE TABLE "provisioning_course_resources" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "course_sourced_id" TEXT NOT NULL,
  "resource_sourced_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "course_sourced_id", "resource_sourced_id")
);

CREATE INDEX "provisioning_course_resources_course_idx"
  ON "provisioning_course_resources" ("tenant_id", "course_sourced_id");

CREATE TABLE "provisioning_gradebook_categories" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "sourced_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "sourced_id")
);

CREATE INDEX "provisioning_gradebook_categories_tenant_idx"
  ON "provisioning_gradebook_categories" ("tenant_id", "title");

CREATE TABLE "provisioning_gradebook_line_items" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "sourced_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "assign_date" TEXT,
  "due_date" TEXT,
  "class_sourced_id" TEXT,
  "school_sourced_id" TEXT,
  "category_sourced_id" TEXT,
  "result_value_min" TEXT,
  "result_value_max" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("source_id", "sourced_id")
);

CREATE INDEX "provisioning_gradebook_line_items_class_idx"
  ON "provisioning_gradebook_line_items" ("tenant_id", "class_sourced_id");
