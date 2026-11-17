import type { Hono } from "hono";
import type { InstructorRouteEnv } from "./middleware";
import {
  handleInstructorLmsEvidenceReportCsv,
  handleInstructorLmsIntegrationList,
  handleInstructorLmsNrpsScheduleUpsert,
  handleInstructorLmsNrpsSync,
} from "./handlers/lms";

export function registerLmsRoutes(instructor: Hono<InstructorRouteEnv>): void {
  instructor.get("/lms/evidence-report.csv", handleInstructorLmsEvidenceReportCsv);
  instructor.get("/lms", handleInstructorLmsIntegrationList);
  instructor.post("/lms/nrps-sync", handleInstructorLmsNrpsSync);
  instructor.post(
    "/lms/resource-links/:resourceLinkRowId/nrps-schedule",
    handleInstructorLmsNrpsScheduleUpsert,
  );
}
