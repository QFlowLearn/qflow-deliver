import { isLocalDemoUrl } from "../security/local-demo";
import type { AssignmentActorSnapshot } from "@harbor/attempt-protocol";
import type { InstructorTenantEnv } from "../routes/instructor-scope";
import { requireHarborSessionContext } from "../routes/auth/session";
import { LaunchRequestError } from "../launch/create-preview-attempt";
import { permitsStaffOperation, type StaffGrant, type StaffRole } from "./permissions";
import type { StaffRoute } from "./routes";
import { readActiveStaffGrants } from "./store";

/** Authenticated principal with live, explicit grants. */
export interface StaffPrincipal {
  readonly tenantId: string;
  readonly learnerId: string;
  readonly displayName: string;
  readonly grants: readonly StaffGrant[];
  readonly localDemo: boolean;
}
/** Establish identity independently of permission; tenant membership alone is never authority. */
export async function readStaffPrincipal(
  request: Request,
  env: InstructorTenantEnv,
): Promise<StaffPrincipal> {
  if (env.ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH?.trim().toLowerCase() === "true") {
    if (!isLocalDemoUrl(new URL(request.url)))
      throw new LaunchRequestError(
        503,
        "Local instructor authentication is not permitted on this origin",
      );
    return {
      tenantId: env.ALLOW_UNSAFE_LOCAL_INSTRUCTOR_TENANT_ID?.trim() || "tenant_local_demo",
      learnerId: "local-demo-staff",
      displayName: "Local demo staff",
      grants: [{ id: "local-demo", role: "tenant-administrator", assignmentId: null }],
      localDemo: true,
    };
  }
  const secret = env.BOOTSTRAP_SIGNING_SECRET;
  if (!secret?.trim())
    throw new LaunchRequestError(503, "BOOTSTRAP_SIGNING_SECRET is required for instructor auth");
  const context = await requireHarborSessionContext(request, {
    HARBOR_DB: env.HARBOR_DB,
    BOOTSTRAP_SIGNING_SECRET: secret,
  });
  if (
    context.session.providerKind === "institutional-sso" &&
    context.session.issuer === "https://institution.harbor.local" &&
    !isLocalDemoUrl(new URL(request.url))
  )
    throw new LaunchRequestError(403, "Local demo sessions cannot authorize staff on this origin");
  return {
    tenantId: context.learner.tenantId,
    learnerId: context.learner.id,
    displayName: context.learner.displayName,
    grants: await readActiveStaffGrants(
      env.HARBOR_DB,
      context.learner.tenantId,
      context.learner.id,
      Date.now(),
    ),
    localDemo: false,
  };
}
/** Determine scoped permission from server-owned assignment relationships. */
export async function authorizeStaffRoute(
  db: D1Database,
  principal: StaffPrincipal,
  route: StaffRoute,
  params: Readonly<Record<string, string>>,
  url: URL,
): Promise<{
  readonly role: StaffRole;
  readonly assignmentId: string | null;
  readonly visibleAssignmentIds: readonly string[] | null;
} | null> {
  const eligible = principal.grants.filter((grant) =>
    permitsStaffOperation(grant.role, route.permission),
  );
  if (!eligible.length) return null;
  let assignmentId: string | null = null;
  if (route.resource === "assignment") assignmentId = params.assignmentId ?? null;
  if (route.resource === "attempt") {
    const row = await db
      .prepare("SELECT assignment_id FROM attempt_entries WHERE id = ?")
      .bind(params.attemptId ?? "")
      .first<{ assignment_id: string | null }>();
    assignmentId = row?.assignment_id ?? null;
  }
  if (route.resource === "scoring-queue") assignmentId = url.searchParams.get("assignmentId");
  const tenantGrant = eligible.find((grant) => grant.assignmentId === null);
  if (tenantGrant) return { role: tenantGrant.role, assignmentId, visibleAssignmentIds: null };
  if (route.resource === "assignment-list") {
    const first = eligible[0];
    if (!first) return null;
    return {
      role: first.role,
      assignmentId: null,
      visibleAssignmentIds: eligible.flatMap((grant) =>
        grant.assignmentId === null ? [] : [grant.assignmentId],
      ),
    };
  }
  if (!assignmentId) return null;
  const grant = eligible.find((value) => value.assignmentId === assignmentId);
  if (!grant) return null;
  return { role: grant.role, assignmentId, visibleAssignmentIds: [assignmentId] };
}
/** Derive the downstream command actor from authenticated identity and the authorizing grant. */
export function staffCommandActor(
  principal: StaffPrincipal,
  role: StaffRole,
): AssignmentActorSnapshot {
  return { role, actorId: principal.learnerId, displayName: principal.displayName };
}
