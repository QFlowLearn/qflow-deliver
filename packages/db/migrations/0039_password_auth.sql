CREATE TABLE "password_auth_accounts" (
  "id" TEXT PRIMARY KEY,
  "learner_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "username_normalized" TEXT NOT NULL,
  "email_normalized" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "password_salt" TEXT NOT NULL,
  "password_algorithm" TEXT NOT NULL,
  "password_iterations" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "last_login_at" TEXT,
  FOREIGN KEY ("learner_id") REFERENCES "harbor_learners"("id") ON DELETE CASCADE,
  UNIQUE ("tenant_id", "username_normalized"),
  UNIQUE ("tenant_id", "email_normalized")
);

CREATE INDEX "password_auth_accounts_learner_idx"
  ON "password_auth_accounts" ("learner_id");

CREATE INDEX "password_auth_accounts_status_idx"
  ON "password_auth_accounts" ("tenant_id", "status");

CREATE TABLE "password_reset_tokens" (
  "id" TEXT PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "requested_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "consumed_at" TEXT,
  FOREIGN KEY ("account_id") REFERENCES "password_auth_accounts"("id") ON DELETE CASCADE,
  UNIQUE ("token_hash")
);

CREATE INDEX "password_reset_tokens_account_idx"
  ON "password_reset_tokens" ("account_id", "expires_at");

CREATE TABLE "password_login_attempts" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "identifier_hash" TEXT NOT NULL,
  "client_key_hash" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "attempted_at" TEXT NOT NULL
);

CREATE INDEX "password_login_attempts_identifier_idx"
  ON "password_login_attempts" ("tenant_id", "identifier_hash", "attempted_at");

CREATE INDEX "password_login_attempts_client_idx"
  ON "password_login_attempts" ("tenant_id", "client_key_hash", "attempted_at");

CREATE TABLE "password_reset_requests" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "identifier_hash" TEXT NOT NULL,
  "client_key_hash" TEXT NOT NULL,
  "requested_at" TEXT NOT NULL
);

CREATE INDEX "password_reset_requests_identifier_idx"
  ON "password_reset_requests" ("tenant_id", "identifier_hash", "requested_at");

CREATE INDEX "password_reset_requests_client_idx"
  ON "password_reset_requests" ("tenant_id", "client_key_hash", "requested_at");
