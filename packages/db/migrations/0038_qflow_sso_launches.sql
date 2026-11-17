CREATE TABLE "qflow_sso_launches" (
  "id" TEXT PRIMARY KEY,
  "qflow_tenant_id" TEXT NOT NULL,
  "jti" TEXT NOT NULL,
  "assignment_id" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "consumed_at" TEXT NOT NULL,
  UNIQUE ("qflow_tenant_id", "jti")
);

CREATE INDEX "qflow_sso_launches_expiry_idx"
  ON "qflow_sso_launches" ("expires_at");
