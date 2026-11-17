import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { parseStaffRole, type StaffGrant } from "./permissions";
import { staffAccessEvents, staffGrants } from "./schema";

/** Read fresh grants on every protected request so revocation applies immediately. */
export async function readActiveStaffGrants(
  db: D1Database,
  tenantId: string,
  learnerId: string,
  now: number,
): Promise<readonly StaffGrant[]> {
  const rows = await drizzle(db)
    .select()
    .from(staffGrants)
    .where(and(eq(staffGrants.tenantId, tenantId), eq(staffGrants.learnerId, learnerId)))
    .all();
  const grants: StaffGrant[] = [];
  for (const row of rows) {
    const role = parseStaffRole(row.role);
    if (
      !role ||
      row.revokedAt ||
      (row.expiresAt !== null &&
        (!Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= now))
    )
      continue;
    if ((role === "invigilator" || role === "scorer") !== (row.assignmentId !== null)) continue;
    grants.push({ id: row.id, role, assignmentId: row.assignmentId });
  }
  return grants;
}

/** Append safe request outcomes; failures are not silently discarded. */
export async function recordStaffAccess(
  db: D1Database,
  event: Omit<typeof staffAccessEvents.$inferInsert, "id" | "createdAt">,
): Promise<void> {
  await drizzle(db)
    .insert(staffAccessEvents)
    .values({ ...event, id: crypto.randomUUID(), createdAt: new Date().toISOString() })
    .run();
}
