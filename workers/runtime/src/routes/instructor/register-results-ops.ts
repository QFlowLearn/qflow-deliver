import type { Hono } from "hono";
import type { InstructorRouteEnv } from "./middleware";
import {
  handleInstructorResultsOpsList,
  handleInstructorResultsOpsRetry,
} from "./handlers/results-ops";

export function registerResultsOpsRoutes(instructor: Hono<InstructorRouteEnv>): void {
  instructor.get("/results-ops", handleInstructorResultsOpsList);
  instructor.post("/results-ops/attempts/:attemptId/retry", handleInstructorResultsOpsRetry);
}
