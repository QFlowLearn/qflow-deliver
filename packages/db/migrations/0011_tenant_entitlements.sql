CREATE TABLE "tenant_feature_entitlements" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "feature_key" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "effective_at" TEXT NOT NULL,
  "expires_at" TEXT,
  "granted_by" TEXT,
  "reason" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  UNIQUE ("tenant_id", "feature_key")
);

CREATE INDEX "tenant_feature_entitlements_lookup_idx"
  ON "tenant_feature_entitlements" (
    "tenant_id",
    "feature_key",
    "status",
    "effective_at",
    "expires_at"
  );
