import type {
  InstructorAssignmentListItem,
  InstructorPublishedAssessmentVersionListItem,
} from "@harbor/attempt-protocol";

/** Keep an explicit published-version link scoped to its assessment across all versions. */
export function assessmentManagementContext(
  requestedVersionId: string | null,
  versions: readonly InstructorPublishedAssessmentVersionListItem[],
  assignments: readonly InstructorAssignmentListItem[],
) {
  const version = versions.find((entry) => entry.assessmentVersionId === requestedVersionId);
  return {
    version,
    assignments: assignments.filter(
      (entry) => !requestedVersionId || entry.assessmentId === version?.assessmentId,
    ),
    versions: versions.filter(
      (entry) => !requestedVersionId || entry.assessmentId === version?.assessmentId,
    ),
  };
}
