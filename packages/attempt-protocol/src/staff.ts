/** Roles granted explicitly to authenticated staff identities. */
export const STAFF_ROLES = [
  "tenant-administrator",
  "assessment-manager",
  "invigilator",
  "scorer",
] as const;
/** Staff role vocabulary shared by persisted grants and audit projections. */
export type StaffActorRole = (typeof STAFF_ROLES)[number];
/** Parse a staff role at an HTTP or persisted-data boundary. */
export function parseStaffActorRole(value: unknown): StaffActorRole | null {
  for (const role of STAFF_ROLES) if (value === role) return role;
  return null;
}

/** Server-derived read capabilities for one authorized assessment workspace. */
export interface AssignmentStaffCapabilities {
  readonly assignmentId: string;
  readonly canOperateExam: boolean;
  readonly canReadResults: boolean;
  readonly canScoreResults: boolean;
  readonly canManageAccommodations: boolean;
}

/** Parse the public capability response without trusting decoded JSON. */
export function parseAssignmentStaffCapabilities(
  value: unknown,
): AssignmentStaffCapabilities | null {
  if (
    value === null ||
    typeof value !== "object" ||
    !("assignmentId" in value) ||
    typeof value.assignmentId !== "string" ||
    !value.assignmentId ||
    !("canOperateExam" in value) ||
    typeof value.canOperateExam !== "boolean" ||
    !("canReadResults" in value) ||
    typeof value.canReadResults !== "boolean" ||
    !("canScoreResults" in value) ||
    typeof value.canScoreResults !== "boolean" ||
    !("canManageAccommodations" in value) ||
    typeof value.canManageAccommodations !== "boolean"
  )
    return null;
  return {
    assignmentId: value.assignmentId,
    canOperateExam: value.canOperateExam,
    canReadResults: value.canReadResults,
    canScoreResults: value.canScoreResults,
    canManageAccommodations: value.canManageAccommodations,
  };
}
