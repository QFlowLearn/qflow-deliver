import { LaunchRequestError } from "../../launch/create-preview-attempt";

export interface QflowLaunchAuthority {
  tenantId: string;
  qflowTenantId: string;
  assignmentId: string;
  launchId: string;
}

export async function resolveQflowLaunchAuthority(input: {
  db: D1Database;
  qflowTenantId: string;
  assignmentId: string;
  launchId: string;
}): Promise<QflowLaunchAuthority> {
  const tenantId = await resolveQflowTenantLink({
    db: input.db,
    qflowTenantId: input.qflowTenantId,
  });
  await requireQflowAssignment({
    db: input.db,
    tenantId,
    qflowTenantId: input.qflowTenantId,
    assignmentId: input.assignmentId,
  });

  return {
    tenantId,
    qflowTenantId: input.qflowTenantId,
    assignmentId: input.assignmentId,
    launchId: input.launchId,
  };
}

async function resolveQflowTenantLink(input: {
  db: D1Database;
  qflowTenantId: string;
}): Promise<string> {
  const now = new Date().toISOString();
  const row = await input.db
    .prepare(
      "SELECT tenant_id FROM qflow_tenant_links WHERE qflow_tenant_id = ? AND status = ? AND effective_at <= ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
    )
    .bind(input.qflowTenantId, "active", now, now)
    .first<{ tenant_id: string }>();

  if (!row) {
    throw new LaunchRequestError(
      403,
      "QFlow tenant is not linked to an active QFlowLearn Delivery subscription",
    );
  }

  return row.tenant_id;
}

async function requireQflowAssignment(input: {
  db: D1Database;
  tenantId: string;
  qflowTenantId: string;
  assignmentId: string;
}): Promise<void> {
  const row = await input.db
    .prepare(
      "SELECT assignments.id FROM assignments INNER JOIN assessments ON assessments.id = assignments.assessment_id INNER JOIN qflow_handoffs ON qflow_handoffs.assignment_id = assignments.id INNER JOIN qflow_publish_requests ON qflow_publish_requests.assessment_id = assignments.assessment_id AND qflow_publish_requests.assessment_version_id = assignments.assessment_version_id WHERE assignments.id = ? AND assessments.tenant_id = ? AND qflow_publish_requests.tenant_id = ? AND qflow_publish_requests.qflow_tenant_id = ? LIMIT 1",
    )
    .bind(input.assignmentId, input.tenantId, input.tenantId, input.qflowTenantId)
    .first<{ id: string }>();

  if (!row) {
    throw new LaunchRequestError(404, "QFlow assignment launch not found");
  }
}
