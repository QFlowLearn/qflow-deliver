CREATE TABLE "harbor_learners" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "email" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX "harbor_learners_tenant_idx"
  ON "harbor_learners" ("tenant_id", "created_at" DESC);

CREATE TABLE "learner_identities" (
  "id" TEXT PRIMARY KEY,
  "learner_id" TEXT NOT NULL,
  "provider_kind" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "email" TEXT,
  "display_name" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("learner_id") REFERENCES "harbor_learners"("id") ON DELETE CASCADE,
  UNIQUE ("provider_kind", "issuer", "subject")
);

CREATE INDEX "learner_identities_learner_idx"
  ON "learner_identities" ("learner_id", "provider_kind");

CREATE TABLE "sections" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  UNIQUE ("tenant_id", "source_kind", "source_id")
);

CREATE TABLE "section_memberships" (
  "id" TEXT PRIMARY KEY,
  "section_id" TEXT NOT NULL,
  "learner_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE,
  FOREIGN KEY ("learner_id") REFERENCES "harbor_learners"("id") ON DELETE CASCADE,
  UNIQUE ("section_id", "learner_id")
);

CREATE INDEX "section_memberships_learner_idx"
  ON "section_memberships" ("learner_id", "status");

CREATE TABLE "assignment_learner_targets" (
  "id" TEXT PRIMARY KEY,
  "assignment_id" TEXT NOT NULL,
  "learner_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("learner_id") REFERENCES "harbor_learners"("id") ON DELETE CASCADE,
  UNIQUE ("assignment_id", "learner_id")
);

CREATE INDEX "assignment_learner_targets_learner_idx"
  ON "assignment_learner_targets" ("learner_id", "assignment_id");

CREATE TABLE "assignment_section_targets" (
  "id" TEXT PRIMARY KEY,
  "assignment_id" TEXT NOT NULL,
  "section_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE,
  UNIQUE ("assignment_id", "section_id")
);

CREATE INDEX "assignment_section_targets_section_idx"
  ON "assignment_section_targets" ("section_id", "assignment_id");

CREATE TABLE "harbor_sessions" (
  "id" TEXT PRIMARY KEY,
  "learner_id" TEXT NOT NULL,
  "provider_kind" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "last_seen_at" TEXT NOT NULL,
  "revoked_at" TEXT,
  FOREIGN KEY ("learner_id") REFERENCES "harbor_learners"("id") ON DELETE CASCADE
);

CREATE INDEX "harbor_sessions_learner_idx"
  ON "harbor_sessions" ("learner_id", "status", "expires_at");

CREATE TABLE "institutional_auth_states" (
  "id" TEXT PRIMARY KEY,
  "state" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "provider_key" TEXT NOT NULL,
  "redirect_to" TEXT NOT NULL,
  "profile_hint" TEXT,
  "requested_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "consumed_at" TEXT,
  UNIQUE ("state")
);

CREATE TABLE "lti_registrations" (
  "id" TEXT PRIMARY KEY,
  "issuer" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "deployment_id" TEXT NOT NULL,
  "authorization_endpoint" TEXT NOT NULL,
  "jwks_url" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  UNIQUE ("issuer", "client_id", "deployment_id")
);

CREATE TABLE "lti_launch_states" (
  "id" TEXT PRIMARY KEY,
  "registration_id" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "login_hint" TEXT NOT NULL,
  "lti_message_hint" TEXT,
  "target_link_uri" TEXT NOT NULL,
  "requested_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "consumed_at" TEXT,
  FOREIGN KEY ("registration_id") REFERENCES "lti_registrations"("id") ON DELETE CASCADE,
  UNIQUE ("state")
);

CREATE INDEX "lti_launch_states_registration_idx"
  ON "lti_launch_states" ("registration_id", "expires_at");

CREATE TABLE "lti_resource_links" (
  "id" TEXT PRIMARY KEY,
  "registration_id" TEXT NOT NULL,
  "assignment_id" TEXT NOT NULL,
  "resource_link_id" TEXT NOT NULL,
  "context_id" TEXT,
  "section_id" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("registration_id") REFERENCES "lti_registrations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL,
  UNIQUE ("registration_id", "resource_link_id")
);

CREATE INDEX "lti_resource_links_assignment_idx"
  ON "lti_resource_links" ("assignment_id", "resource_link_id");
