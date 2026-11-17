import type { Hono } from "hono";
import type { InstructorRouteEnv } from "./middleware";
import {
  handleInstructorManualScoringAttemptRead,
  handleInstructorManualScoringFinalize,
  handleInstructorManualScoringItemSave,
  handleInstructorManualScoringQueue,
} from "./handlers/manual-scoring";

export function registerManualScoringRoutes(instructor: Hono<InstructorRouteEnv>): void {
  instructor.get("/manual-scoring", handleInstructorManualScoringQueue);
  instructor.get("/manual-scoring/attempts/:attemptId", handleInstructorManualScoringAttemptRead);
  instructor.put(
    "/manual-scoring/attempts/:attemptId/items/:itemId",
    handleInstructorManualScoringItemSave,
  );
  instructor.post(
    "/manual-scoring/attempts/:attemptId/finalize",
    handleInstructorManualScoringFinalize,
  );
}
