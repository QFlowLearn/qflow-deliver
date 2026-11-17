import type { LtiAssignmentLinkage } from "@harbor/attempt-protocol";

import { LaunchRequestError } from "../launch/create-preview-attempt";

const REGISTRATION_TENANT_MISMATCH = "LTI registration does not match the linked assignment tenant";

export async function assertAssignmentAndSectionBelongToTenant(input: {
  db: D1Database;
  tenantId: string;
  assignmentId: string;
  sectionId?: string | null;
  assignmentNotFoundMessage?: string;
  assignmentTenantMismatchMessage?: string;
  sectionNotFoundMessage?: string;
  sectionTenantMismatchMessage?: string;
}): Promise<void> {
  const assignmentRow = await input.db
    .prepare(
      `SELECT assessments.tenant_id AS tenant_id
       FROM assignments
       INNER JOIN assessments ON assessments.id = assignments.assessment_id
       WHERE assignments.id = ?`,
    )
    .bind(input.assignmentId)
    .first<{ tenant_id: string }>();

  if (!assignmentRow?.tenant_id) {
    throw new LaunchRequestError(404, input.assignmentNotFoundMessage ?? "Assignment not found");
  }

  if (assignmentRow.tenant_id !== input.tenantId) {
    throw new LaunchRequestError(
      403,
      input.assignmentTenantMismatchMessage ?? REGISTRATION_TENANT_MISMATCH,
    );
  }

  if (!input.sectionId) {
    return;
  }

  const section = await input.db
    .prepare("SELECT tenant_id FROM sections WHERE id = ?")
    .bind(input.sectionId)
    .first<{ tenant_id: string }>();

  if (!section) {
    throw new LaunchRequestError(404, input.sectionNotFoundMessage ?? "LTI section not found");
  }

  if (section.tenant_id !== input.tenantId) {
    throw new LaunchRequestError(
      403,
      input.sectionTenantMismatchMessage ?? "LTI section does not belong to the assignment tenant",
    );
  }
}

export async function assertDeepLinkPlacementBelongsToRegistrationTenant(input: {
  db: D1Database;
  registrationTenantId: string;
  assignmentId: string;
  sectionId?: string | null;
}): Promise<void> {
  await assertAssignmentAndSectionBelongToTenant({
    db: input.db,
    tenantId: input.registrationTenantId,
    assignmentId: input.assignmentId,
    sectionId: input.sectionId,
    assignmentNotFoundMessage: "Deep link assignment not found",
    assignmentTenantMismatchMessage:
      "Deep link assignment does not belong to the registration tenant",
    sectionNotFoundMessage: "Deep link section not found",
    sectionTenantMismatchMessage: "Deep link section does not belong to the registration tenant",
  });
}

export async function readAssignmentTenantId(
  db: D1Database,
  assignmentId: string,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT assessments.tenant_id AS tenant_id
       FROM assignments
       INNER JOIN assessments ON assessments.id = assignments.assessment_id
       WHERE assignments.id = ?`,
    )
    .bind(assignmentId)
    .first<{ tenant_id: string }>();

  if (!row?.tenant_id) {
    throw new LaunchRequestError(404, "LTI launch assignment not found");
  }

  return row.tenant_id;
}

export async function assertLtiLinkagesBelongToAssessmentTenant(input: {
  db: D1Database;
  assessmentId: string;
  linkages: LtiAssignmentLinkage[];
}): Promise<void> {
  if (input.linkages.length === 0) {
    return;
  }

  const assessment = await input.db
    .prepare("SELECT tenant_id FROM assessments WHERE id = ?")
    .bind(input.assessmentId)
    .first<{ tenant_id: string }>();

  if (!assessment?.tenant_id) {
    throw new LaunchRequestError(404, "Assessment not found");
  }

  for (const linkage of input.linkages) {
    await assertLtiLinkageBelongsToTenant({
      db: input.db,
      tenantId: assessment.tenant_id,
      linkage,
      registrationNotFoundMessage: "LTI registration not found",
      sectionNotFoundMessage: "LTI section not found",
      sectionTenantMismatchMessage: "LTI linkage section does not belong to the assignment tenant",
    });
  }
}

export async function assertLtiLinkageBelongsToTenant(input: {
  db: D1Database;
  tenantId: string;
  linkage: Pick<LtiAssignmentLinkage, "registrationId" | "sectionId">;
  registrationNotFoundMessage?: string;
  sectionNotFoundMessage?: string;
  sectionTenantMismatchMessage?: string;
}): Promise<void> {
  const registration = await input.db
    .prepare("SELECT tenant_id FROM lti_registrations WHERE id = ?")
    .bind(input.linkage.registrationId)
    .first<{ tenant_id: string }>();

  if (!registration) {
    throw new LaunchRequestError(
      404,
      input.registrationNotFoundMessage ?? "LTI registration not found",
    );
  }

  if (registration.tenant_id !== input.tenantId) {
    throw new LaunchRequestError(403, REGISTRATION_TENANT_MISMATCH);
  }

  if (!input.linkage.sectionId) {
    return;
  }

  const section = await input.db
    .prepare("SELECT tenant_id FROM sections WHERE id = ?")
    .bind(input.linkage.sectionId)
    .first<{ tenant_id: string }>();

  if (!section) {
    throw new LaunchRequestError(404, input.sectionNotFoundMessage ?? "LTI section not found");
  }

  if (section.tenant_id !== input.tenantId) {
    throw new LaunchRequestError(
      403,
      input.sectionTenantMismatchMessage ?? "LTI section does not belong to the assignment tenant",
    );
  }
}
