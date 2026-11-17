import type { Hono } from "hono";
import type { InstructorRouteEnv } from "./middleware";
import {
  handleInstructorAssignmentActivate,
  handleInstructorAssignmentCapabilities,
  handleInstructorAssignmentClose,
  handleInstructorAssignmentCreate,
  handleInstructorAssignmentLearnerOverrideRead,
  handleInstructorAssignmentLearnerOverrideUpsert,
  handleInstructorAssignmentList,
  handleInstructorAssignmentRead,
  handleInstructorAssignmentResults,
  handleInstructorAssignmentRoster,
  handleInstructorAssignmentUpdate,
  handleInstructorAssessmentVersionList,
  handleInstructorLearnerList,
  handleInstructorSectionList,
} from "./handlers/core";

export function registerCoreRoutes(instructor: Hono<InstructorRouteEnv>): void {
  instructor.get("/assignments", handleInstructorAssignmentList);
  instructor.post("/assignments", handleInstructorAssignmentCreate);
  instructor.get("/assessment-versions", handleInstructorAssessmentVersionList);
  instructor.get("/sections", handleInstructorSectionList);
  instructor.get("/learners", handleInstructorLearnerList);
  instructor.post("/assignments/:assignmentId/activate", handleInstructorAssignmentActivate);
  instructor.post("/assignments/:assignmentId/close", handleInstructorAssignmentClose);
  instructor.get("/assignments/:assignmentId/roster", handleInstructorAssignmentRoster);
  instructor.get("/assignments/:assignmentId/capabilities", handleInstructorAssignmentCapabilities);
  instructor.get("/assignments/:assignmentId/results", handleInstructorAssignmentResults);
  instructor.get(
    "/assignments/:assignmentId/learners/:learnerId/override",
    handleInstructorAssignmentLearnerOverrideRead,
  );
  instructor.put(
    "/assignments/:assignmentId/learners/:learnerId/override",
    handleInstructorAssignmentLearnerOverrideUpsert,
  );
  instructor.get("/assignments/:assignmentId", handleInstructorAssignmentRead);
  instructor.put("/assignments/:assignmentId", handleInstructorAssignmentUpdate);
}
