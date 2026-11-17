import { LaunchRequestError } from "../../launch/create-preview-attempt";

/** Aggregate delivery state only for a publication owned by the signed QFlow tenant. */
export async function readQflowAssessmentState(
  db: D1Database,
  input: Record<string, unknown>,
): Promise<Response> {
  const qflowTenantId = required(input.qflowTenantId);
  const qflowAssessmentId = required(input.qflowAssessmentId);
  const assessmentVersionId = required(input.assessmentVersionId);
  const publication = await db
    .prepare(`SELECT p.assessment_id, p.tenant_id FROM qflow_publish_requests p
    INNER JOIN qflow_tenant_links l ON l.qflow_tenant_id = p.qflow_tenant_id AND l.tenant_id = p.tenant_id
    WHERE p.qflow_tenant_id = ? AND p.qflow_assessment_id = ? AND p.assessment_version_id = ? AND p.status = 'published'
    AND l.status = 'active' AND l.effective_at <= ? AND (l.expires_at IS NULL OR l.expires_at > ?) LIMIT 1`)
    .bind(
      qflowTenantId,
      qflowAssessmentId,
      assessmentVersionId,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .first<{ assessment_id: string; tenant_id: string }>();
  if (!publication) throw new LaunchRequestError(404, "Published assessment not found");
  const rows = await db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM assignments WHERE assessment_id = ? AND assessment_version_id = ? GROUP BY status`,
    )
    .bind(publication.assessment_id, assessmentVersionId)
    .all<{ status: string; count: number }>();
  const counts = { draft: 0, active: 0, closed: 0 };
  for (const row of rows.results) {
    if (row.status !== "draft" && row.status !== "active" && row.status !== "closed")
      throw new LaunchRequestError(500, "Unknown assignment status");
    counts[row.status] = row.count;
  }
  return Response.json(
    { assessmentVersionId, ...counts },
    { headers: { "cache-control": "no-store" } },
  );
}
function required(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new LaunchRequestError(400, "Assessment identity is required");
  return value.trim();
}
