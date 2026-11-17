CREATE TABLE "oneroster_rest_v1p2_sources" (
  "source_id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "version" TEXT NOT NULL CHECK ("version" = '1.2'),
  "discovery_url" TEXT NOT NULL,
  "rostering_base_url" TEXT NOT NULL,
  "token_endpoint" TEXT NOT NULL,
  "credential_binding_id" TEXT NOT NULL,
  "client_authentication" TEXT NOT NULL CHECK (
    "client_authentication" IN ('client_secret_basic', 'client_secret_post')
  ),
  "scopes_json" TEXT NOT NULL,
  "page_size" INTEGER NOT NULL CHECK ("page_size" BETWEEN 1 AND 500),
  "max_pages" INTEGER NOT NULL CHECK ("max_pages" BETWEEN 1 AND 100),
  "max_items" INTEGER NOT NULL CHECK ("max_items" BETWEEN 1 AND 50000),
  "max_elapsed_milliseconds" INTEGER NOT NULL CHECK (
    "max_elapsed_milliseconds" BETWEEN 1 AND 120000
  ),
  "retry_max_attempts" INTEGER NOT NULL CHECK ("retry_max_attempts" BETWEEN 1 AND 4),
  "retry_max_elapsed_milliseconds" INTEGER NOT NULL CHECK (
    "retry_max_elapsed_milliseconds" BETWEEN 1 AND 30000
  ),
  "retry_status_codes_json" TEXT NOT NULL,
  "retry_connection_errors" INTEGER NOT NULL CHECK ("retry_connection_errors" IN (0, 1)),
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("source_id") REFERENCES "provisioning_sources"("id") ON DELETE CASCADE,
  UNIQUE ("tenant_id", "source_id")
);

CREATE INDEX "oneroster_rest_v1p2_sources_tenant_idx"
  ON "oneroster_rest_v1p2_sources" ("tenant_id", "updated_at" DESC);
