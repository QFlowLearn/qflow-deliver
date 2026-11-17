import { Hono } from "hono";
import type { OneRosterPreviewService } from "../../provisioning/oneroster-rest-preview";
import { instructorAuthMiddleware } from "./middleware";
import { registerAccommodationsRoutes } from "./register-accommodations";
import { registerAttemptRoutes } from "./register-attempts";
import { registerCoreRoutes } from "./register-core";
import { registerLmsRoutes } from "./register-lms";
import { registerManualScoringRoutes } from "./register-manual-scoring";
import { registerProvisioningRoutes } from "./register-provisioning";
import { registerReportingRoutes } from "./register-reporting";
import { registerResultsOpsRoutes } from "./register-results-ops";
import type { InstructorRouteEnv } from "./middleware";

export function createInstructorRoutes(input: {
  readonly oneRosterPreview: OneRosterPreviewService;
}): Hono<InstructorRouteEnv> {
  const instructor = new Hono<InstructorRouteEnv>();

  instructor.use("*", instructorAuthMiddleware);
  registerCoreRoutes(instructor);
  registerReportingRoutes(instructor);
  registerAccommodationsRoutes(instructor);
  registerLmsRoutes(instructor);
  registerManualScoringRoutes(instructor);
  registerAttemptRoutes(instructor);
  registerProvisioningRoutes(instructor, input);
  registerResultsOpsRoutes(instructor);

  return instructor;
}
