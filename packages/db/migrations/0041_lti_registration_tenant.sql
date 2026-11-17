ALTER TABLE "lti_registrations" ADD COLUMN "tenant_id" TEXT NOT NULL DEFAULT 'tenant_local_demo';

CREATE INDEX "lti_registrations_tenant_idx" ON "lti_registrations" ("tenant_id");
