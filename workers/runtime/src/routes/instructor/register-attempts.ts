import type { Hono } from "hono";
import type { InstructorRouteEnv } from "./middleware";
import {
  handleInstructorAttemptAction,
  handleInstructorAttemptEvidence,
  handleInstructorAttemptTimeline,
} from "./handlers/attempts";

export function registerAttemptRoutes(instructor: Hono<InstructorRouteEnv>): void {
  instructor.post("/attempts/:attemptId/actions", handleInstructorAttemptAction);
  instructor.get("/attempts/:attemptId/timeline", handleInstructorAttemptTimeline);
  instructor.get("/attempts/:attemptId/evidence", handleInstructorAttemptEvidence);
}
