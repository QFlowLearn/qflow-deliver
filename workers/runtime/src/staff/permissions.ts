import {
  parseStaffActorRole,
  type StaffActorRole,
  type AssignmentStaffCapabilities,
} from "@harbor/attempt-protocol";
/** Explicitly provisioned management roles. Scoped roles always require an assignment. */
export type StaffRole = StaffActorRole;
/** Supported staff operations; unknown operations have no permission. */
export type StaffPermission =
  | "exam.read"
  | "exam.operate"
  | "assessment.manage"
  | "results.read"
  | "results.score"
  | "results.remediate"
  | "roster.manage"
  | "integration.manage"
  | "accommodation.manage";
/** A live role grant reconstructed at the request boundary. */
export interface StaffGrant {
  readonly id: string;
  readonly role: StaffRole;
  readonly assignmentId: string | null;
}
/** Determine authority without performing IO or trusting a caller-provided role. */
export function permitsStaffOperation(role: StaffRole, permission: StaffPermission): boolean {
  switch (role) {
    case "tenant-administrator":
      return true;
    case "assessment-manager":
      return (
        permission === "exam.read" ||
        permission === "exam.operate" ||
        permission === "assessment.manage" ||
        permission === "results.read" ||
        permission === "results.remediate" ||
        permission === "roster.manage" ||
        permission === "integration.manage" ||
        permission === "accommodation.manage"
      );
    case "invigilator":
      return permission === "exam.read" || permission === "exam.operate";
    case "scorer":
      return (
        permission === "exam.read" ||
        permission === "results.read" ||
        permission === "results.score"
      );
  }
}
/** Parse the closed role vocabulary from HTTP or persisted rows. */
export function parseStaffRole(value: unknown): StaffRole | null {
  return parseStaffActorRole(value);
}

/** Describe optional workspace reads using the same scoped grants that enforce each route. */
export function assignmentStaffCapabilities(
  grants: readonly StaffGrant[],
  assignmentId: string,
): AssignmentStaffCapabilities {
  const allows = (permission: StaffPermission) =>
    grants.some(
      (grant) =>
        (grant.assignmentId === null || grant.assignmentId === assignmentId) &&
        permitsStaffOperation(grant.role, permission),
    );
  return {
    assignmentId,
    canOperateExam: allows("exam.operate"),
    canReadResults: allows("results.read"),
    canScoreResults: allows("results.score"),
    canManageAccommodations: allows("accommodation.manage"),
  };
}
