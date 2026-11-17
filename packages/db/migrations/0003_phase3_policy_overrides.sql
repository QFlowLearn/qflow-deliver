CREATE TABLE "attempt_policy_overlays" (
  "attempt_id" TEXT PRIMARY KEY,
  "overlay_revision" INTEGER NOT NULL DEFAULT 0,
  "additional_time_seconds" INTEGER NOT NULL DEFAULT 0,
  "reopen_status" TEXT NOT NULL DEFAULT 'closed',
  "reopened_at" TEXT,
  "reopen_until" TEXT,
  "operator_message_json" TEXT,
  "accommodations_json" TEXT NOT NULL DEFAULT '{"rendererPnp":{},"sessionControl":{}}',
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE
);

CREATE INDEX "attempt_policy_overlays_updated_idx"
  ON "attempt_policy_overlays" ("updated_at");

CREATE TABLE "attempt_policy_commands" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "command_type" TEXT NOT NULL,
  "actor_role" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_display_name" TEXT,
  "reason" TEXT NOT NULL,
  "issued_at" TEXT NOT NULL,
  "effective_at" TEXT NOT NULL,
  "payload_json" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("attempt_id") REFERENCES "attempt_entries"("id") ON DELETE CASCADE
);

CREATE INDEX "attempt_policy_commands_attempt_idx"
  ON "attempt_policy_commands" ("attempt_id", "created_at");
