import type { Hono } from "hono";
import type { InstructorRouteEnv } from "./middleware";
import {
  handleInstructorAccommodationProfileCreate,
  handleInstructorAccommodationProfileList,
  handleInstructorAccommodationProfileUpdate,
  handleInstructorLearnerAccommodationProfileList,
  handleInstructorLearnerAccommodationProfileUpsert,
} from "./handlers/accommodations";

export function registerAccommodationsRoutes(instructor: Hono<InstructorRouteEnv>): void {
  instructor.get("/accommodation-profiles", handleInstructorAccommodationProfileList);
  instructor.post("/accommodation-profiles", handleInstructorAccommodationProfileCreate);
  instructor.put("/accommodation-profiles/:profileId", handleInstructorAccommodationProfileUpdate);
  instructor.get(
    "/learners/:learnerId/accommodation-profiles",
    handleInstructorLearnerAccommodationProfileList,
  );
  instructor.put(
    "/learners/:learnerId/accommodation-profiles/:profileId",
    handleInstructorLearnerAccommodationProfileUpsert,
  );
}
