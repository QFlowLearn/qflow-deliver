CREATE TABLE "qflow_tenant_links" (
  "id" TEXT PRIMARY KEY,
  "qflow_tenant_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "effective_at" TEXT NOT NULL,
  "expires_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  UNIQUE ("qflow_tenant_id")
);

CREATE INDEX "qflow_tenant_links_lookup_idx"
  ON "qflow_tenant_links" (
    "qflow_tenant_id",
    "status",
    "effective_at",
    "expires_at"
  );

CREATE INDEX "qflow_tenant_links_harbor_tenant_idx"
  ON "qflow_tenant_links" ("tenant_id", "status");
