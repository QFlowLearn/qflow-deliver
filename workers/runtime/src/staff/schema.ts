import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Persisted, explicitly provisioned staff authority; no role is inferred from login. */
export const staffGrants = sqliteTable("staff_grants", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  learnerId: text("learner_id").notNull(),
  role: text("role").notNull(),
  assignmentId: text("assignment_id"),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
});

/** Safe management access evidence, without request payloads or credentials. */
export const staffAccessEvents = sqliteTable("staff_access_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  actorId: text("actor_id"),
  actorRole: text("actor_role"),
  operation: text("operation").notNull(),
  resourceId: text("resource_id"),
  outcome: text("outcome").notNull(),
  responseStatus: integer("response_status").notNull(),
  createdAt: text("created_at").notNull(),
});
