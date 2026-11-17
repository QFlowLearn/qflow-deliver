import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { requireAdminKeyResponse } from "../middleware/admin-key";
import { LaunchRequestError } from "../launch/create-preview-attempt";
import { readJsonObject, readRequiredString } from "../routes/route-request-utils";
import type { AppContext } from "../routes/hono-utils";
import { parseStaffRole } from "./permissions";
import { staffGrants } from "./schema";
import { recordStaffAccess } from "./store";

/** Create an immutable staff grant through the explicit privileged admin credential. */
export async function handleStaffGrantPut(c: AppContext): Promise<Response> {
  return auditStaffGrantCommand(c, "staff-grant.create", () => putStaffGrant(c));
}

async function putStaffGrant(c: AppContext): Promise<Response> {
  const id = readRequiredString(c.req.param("grantId"), "grantId is required");
  const body = await readJsonObject(c.req.raw);
  const allowed = new Set(["tenantId", "learnerId", "role", "assignmentId", "expiresAt"]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throw new LaunchRequestError(400, "Staff grant contains unsupported fields");
  const tenantId = readRequiredString(body.tenantId, "tenantId is required");
  const learnerId = readRequiredString(body.learnerId, "learnerId is required");
  const role = parseStaffRole(body.role);
  if (!role) throw new LaunchRequestError(400, "Staff role is invalid");
  const assignmentId =
    body.assignmentId == null
      ? null
      : readRequiredString(body.assignmentId, "assignmentId is invalid");
  if ((role === "scorer" || role === "invigilator") !== (assignmentId !== null))
    throw new LaunchRequestError(
      400,
      "Scoped staff roles require an assignment; tenant roles require tenant scope",
    );
  let expiresAt: string | null = null;
  if (body.expiresAt != null) {
    const input = readRequiredString(body.expiresAt, "expiresAt is invalid");
    const time = Date.parse(input);
    if (!Number.isFinite(time) || time <= Date.now())
      throw new LaunchRequestError(400, "expiresAt must be a future timestamp");
    expiresAt = new Date(time).toISOString();
  }
  const learner = await c.env.HARBOR_DB.prepare(
    "SELECT tenant_id FROM harbor_learners WHERE id = ?",
  )
    .bind(learnerId)
    .first<{ tenant_id: string }>();
  if (learner?.tenant_id !== tenantId)
    throw new LaunchRequestError(403, "Staff identity does not belong to the requested tenant");
  if (assignmentId) {
    const assignment = await c.env.HARBOR_DB.prepare(
      "SELECT assessments.tenant_id FROM assignments JOIN assessments ON assessments.id=assignments.assessment_id WHERE assignments.id = ?",
    )
      .bind(assignmentId)
      .first<{ tenant_id: string }>();
    if (assignment?.tenant_id !== tenantId)
      throw new LaunchRequestError(403, "Staff assignment does not belong to the requested tenant");
  }
  const db = drizzle(c.env.HARBOR_DB);
  await db
    .insert(staffGrants)
    .values({
      id,
      tenantId,
      learnerId,
      role,
      assignmentId,
      expiresAt,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
  const stored = await db.select().from(staffGrants).where(eq(staffGrants.id, id)).get();
  if (
    !stored ||
    stored.tenantId !== tenantId ||
    stored.learnerId !== learnerId ||
    stored.role !== role ||
    stored.assignmentId !== assignmentId ||
    stored.expiresAt !== expiresAt ||
    stored.revokedAt !== null
  )
    throw new LaunchRequestError(409, "Grant ID is already bound; provision a new explicit grant");
  await recordStaffAccess(c.env.HARBOR_DB, {
    tenantId,
    actorId: "internal-admin",
    actorRole: "admin-credential",
    operation: "staff-grant.create",
    resourceId: id,
    outcome: "completed",
    responseStatus: 200,
  });
  return c.json({ grant: stored }, 200);
}

/** Revoke an existing grant; repeat revocations preserve the original timestamp. */
export async function handleStaffGrantDelete(c: AppContext): Promise<Response> {
  return auditStaffGrantCommand(c, "staff-grant.revoke", () => revokeStaffGrant(c));
}

async function revokeStaffGrant(c: AppContext): Promise<Response> {
  const id = readRequiredString(c.req.param("grantId"), "grantId is required");
  const db = drizzle(c.env.HARBOR_DB);
  const stored = await db.select().from(staffGrants).where(eq(staffGrants.id, id)).get();
  if (!stored) throw new LaunchRequestError(404, "Staff grant not found");
  if (!stored.revokedAt)
    await db
      .update(staffGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(staffGrants.id, id))
      .run();
  await recordStaffAccess(c.env.HARBOR_DB, {
    tenantId: stored.tenantId,
    actorId: "internal-admin",
    actorRole: "admin-credential",
    operation: "staff-grant.revoke",
    resourceId: id,
    outcome: "completed",
    responseStatus: 200,
  });
  return c.json({ grantId: id, revoked: true }, 200);
}

async function auditStaffGrantCommand(
  c: AppContext,
  operation: string,
  invoke: () => Promise<Response>,
): Promise<Response> {
  // Provisioning needs the actual credential even when local fixtures bypass general admin auth.
  const denied = requireAdminKeyResponse(c.req.raw, c.env);
  if (denied) {
    await recordStaffAccess(c.env.HARBOR_DB, {
      tenantId: null,
      actorId: null,
      actorRole: null,
      operation,
      resourceId: null,
      outcome: "denied",
      responseStatus: denied.status,
    });
    return denied;
  }
  try {
    return await invoke();
  } catch (error: unknown) {
    await recordStaffAccess(c.env.HARBOR_DB, {
      tenantId: null,
      actorId: "internal-admin",
      actorRole: "admin-credential",
      operation,
      resourceId: c.req.param("grantId") ?? null,
      outcome: "failed",
      responseStatus: error instanceof LaunchRequestError ? error.status : 500,
    });
    throw error;
  }
}
