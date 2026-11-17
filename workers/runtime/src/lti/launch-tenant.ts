import { assertAssignmentAndSectionBelongToTenant } from "./linkage-tenant";

import type { LtiRegistrationRow } from "./types";

export async function resolveLaunchTenantId(input: {
  db: D1Database;
  registration: LtiRegistrationRow;
  assignmentId: string;
  sectionId: string | null;
}): Promise<string> {
  await assertAssignmentAndSectionBelongToTenant({
    db: input.db,
    tenantId: input.registration.tenant_id,
    assignmentId: input.assignmentId,
    sectionId: input.sectionId,
    assignmentNotFoundMessage: "LTI launch assignment not found",
    assignmentTenantMismatchMessage: "LTI registration does not match the linked assignment tenant",
    sectionNotFoundMessage: "LTI launch section not found",
    sectionTenantMismatchMessage: "LTI launch section does not belong to the assignment tenant",
  });

  return input.registration.tenant_id;
}
