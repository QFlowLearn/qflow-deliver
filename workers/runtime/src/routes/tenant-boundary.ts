import { LaunchRequestError } from "../launch/create-preview-attempt";

export async function assertAttemptBelongsToTenant(input: {
  db: D1Database;
  attemptId: string;
  tenantId: string;
}): Promise<void> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS matched
         FROM attempt_entries
         INNER JOIN assessment_versions
           ON assessment_versions.id = attempt_entries.assessment_version_id
         INNER JOIN assessments
           ON assessments.id = assessment_versions.assessment_id
        WHERE attempt_entries.id = ?
          AND assessments.tenant_id = ?
        LIMIT 1`,
    )
    .bind(input.attemptId, input.tenantId)
    .first<{ matched: number }>();

  if (!row) {
    throw new LaunchRequestError(404, "Attempt not found");
  }
}

export async function assertAssignmentBelongsToTenant(input: {
  db: D1Database;
  assignmentId: string;
  tenantId: string;
}): Promise<void> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS matched
         FROM assignments
         INNER JOIN assessments
           ON assessments.id = assignments.assessment_id
        WHERE assignments.id = ?
          AND assessments.tenant_id = ?
        LIMIT 1`,
    )
    .bind(input.assignmentId, input.tenantId)
    .first<{ matched: number }>();

  if (!row) {
    throw new LaunchRequestError(404, "Assignment not found");
  }
}

export async function assertLearnerBelongsToTenant(input: {
  db: D1Database;
  learnerId: string;
  tenantId: string;
}): Promise<void> {
  const row = await input.db
    .prepare("SELECT 1 AS matched FROM harbor_learners WHERE id = ? AND tenant_id = ? LIMIT 1")
    .bind(input.learnerId, input.tenantId)
    .first<{ matched: number }>();

  if (!row) {
    throw new LaunchRequestError(404, "Learner not found");
  }
}

export async function assertAccommodationProfileBelongsToTenant(input: {
  db: D1Database;
  profileId: string;
  tenantId: string;
}): Promise<void> {
  const row = await input.db
    .prepare(
      "SELECT 1 AS matched FROM accommodation_profiles WHERE id = ? AND tenant_id = ? LIMIT 1",
    )
    .bind(input.profileId, input.tenantId)
    .first<{ matched: number }>();

  if (!row) {
    throw new LaunchRequestError(404, "Accommodation profile not found");
  }
}

export async function assertAssessmentVersionBelongsToTenant(input: {
  db: D1Database;
  assessmentId: string;
  assessmentVersionId: string;
  tenantId: string;
}): Promise<void> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS matched
         FROM assessment_versions
         INNER JOIN assessments
           ON assessments.id = assessment_versions.assessment_id
        WHERE assessments.id = ?
          AND assessment_versions.id = ?
          AND assessments.tenant_id = ?
        LIMIT 1`,
    )
    .bind(input.assessmentId, input.assessmentVersionId, input.tenantId)
    .first<{ matched: number }>();

  if (!row) {
    throw new LaunchRequestError(404, "Assessment version not found");
  }
}

export function assertRequestedTenantMatches(
  requestedTenantId: string | null,
  tenantId: string,
): void {
  const trimmed = requestedTenantId?.trim();
  if (trimmed && trimmed !== tenantId) {
    throw new LaunchRequestError(403, "Requested tenant is outside the session");
  }
}
