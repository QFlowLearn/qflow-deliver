import { describe, expect, it } from "vitest";
import { assessmentManagementContext } from "./assessment-management-context";
import type { InstructorAssignmentListItem } from "@harbor/attempt-protocol";
const versions = [
  {
    assessmentId: "a",
    assessmentTitle: "Science",
    assessmentSlug: "science",
    assessmentVersionId: "v1",
    versionNumber: 1,
    createdAt: "",
  },
  {
    assessmentId: "a",
    assessmentTitle: "Science",
    assessmentSlug: "science",
    assessmentVersionId: "v2",
    versionNumber: 2,
    createdAt: "",
  },
  {
    assessmentId: "b",
    assessmentTitle: "Math",
    assessmentSlug: "math",
    assessmentVersionId: "v3",
    versionNumber: 1,
    createdAt: "",
  },
];
const assignments: InstructorAssignmentListItem[] = versions.map((version) => ({
  ...version,
  assignmentId: version.assessmentVersionId,
  title: version.assessmentTitle,
  status: "draft",
  availableFrom: null,
  availableUntil: null,
  learnerTargetCount: 0,
  sectionTargetCount: 0,
  updatedAt: "",
}));
describe("assessment management context", () => {
  it("includes delivery assignments across versions of the requested assessment only", () => {
    const result = assessmentManagementContext("v2", versions, assignments);
    expect(result.version?.assessmentTitle).toBe("Science");
    expect(result.assignments.map((entry) => entry.assignmentId)).toEqual(["v1", "v2"]);
    expect(result.versions.map((entry) => entry.assessmentVersionId)).toEqual(["v1", "v2"]);
  });
  it("does not show unrelated assessments for an unavailable version", () => {
    expect(assessmentManagementContext("missing", versions, assignments).assignments).toEqual([]);
  });
  it("shows the whole workspace when no assessment was requested", () => {
    expect(assessmentManagementContext(null, versions, assignments).assignments).toEqual(
      assignments,
    );
  });
});
