PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS "lti_session_bindings";
DROP TABLE IF EXISTS "lti_deployments";
DROP TABLE IF EXISTS "lti_clients";
DROP TABLE IF EXISTS "lti_registration_sessions";
DROP TABLE IF EXISTS "lti_sessions";
DROP TABLE IF EXISTS "lti_nonces";
DROP TABLE IF EXISTS "lti_registration_attempts";

CREATE TABLE "lti_clients" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "platform_name" TEXT NOT NULL,
  "iss" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "auth_url" TEXT NOT NULL,
  "token_url" TEXT NOT NULL,
  "jwks_url" TEXT NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);

CREATE INDEX "lti_clients_issuer_client_idx"
  ON "lti_clients" ("tenant_id", "client_id", "iss");
CREATE UNIQUE INDEX "lti_clients_iss_client_id_uniq"
  ON "lti_clients" ("tenant_id", "iss", "client_id");

CREATE TABLE "lti_deployments" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "deployment_id" TEXT NOT NULL,
  "deployment_name" TEXT,
  "deployment_description" TEXT,
  PRIMARY KEY ("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "client_id")
    REFERENCES "lti_clients" ("tenant_id", "id")
    ON DELETE CASCADE
);

CREATE INDEX "lti_deployments_deployment_id_idx"
  ON "lti_deployments" ("tenant_id", "deployment_id");
CREATE UNIQUE INDEX "lti_deployments_client_deployment_uniq"
  ON "lti_deployments" ("tenant_id", "client_id", "deployment_id");

CREATE TABLE "lti_registration_sessions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);

CREATE INDEX "lti_registration_sessions_expires_at_idx"
  ON "lti_registration_sessions" ("expires_at");

CREATE TABLE "lti_sessions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);

CREATE UNIQUE INDEX "lti_sessions_id_uniq"
  ON "lti_sessions" ("id");
CREATE INDEX "lti_sessions_expires_at_idx"
  ON "lti_sessions" ("expires_at");

CREATE TABLE "lti_nonces" (
  "nonce" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL,
  PRIMARY KEY ("tenant_id", "nonce")
);

CREATE INDEX "lti_nonces_expires_at_idx"
  ON "lti_nonces" ("expires_at");

CREATE UNIQUE INDEX IF NOT EXISTS "lti_registrations_id_tenant_uniq"
  ON "lti_registrations" ("id", "tenant_id");

CREATE TRIGGER "lti_registrations_tenant_immutable"
BEFORE UPDATE OF "tenant_id" ON "lti_registrations"
WHEN OLD."tenant_id" <> NEW."tenant_id"
BEGIN
  SELECT RAISE(ABORT, 'lti_registration_tenant_conflict');
END;

CREATE TABLE "lti_session_bindings" (
  "lti_session_id" TEXT PRIMARY KEY NOT NULL,
  "registration_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("registration_id", "tenant_id")
    REFERENCES "lti_registrations" ("id", "tenant_id")
    ON DELETE CASCADE,
  FOREIGN KEY ("tenant_id", "lti_session_id")
    REFERENCES "lti_sessions" ("tenant_id", "id")
    ON DELETE CASCADE
);

CREATE INDEX "lti_session_bindings_tenant_idx"
  ON "lti_session_bindings" ("tenant_id");
CREATE INDEX "lti_session_bindings_registration_idx"
  ON "lti_session_bindings" ("registration_id");

PRAGMA foreign_keys = ON;
