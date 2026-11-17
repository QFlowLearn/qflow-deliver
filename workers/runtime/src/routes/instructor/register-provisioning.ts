import type { Hono } from "hono";
import type { OneRosterPreviewService } from "../../provisioning/oneroster-rest-preview";
import type { InstructorRouteEnv } from "./middleware";
import {
  handleInstructorProvisioningCsvApply,
  handleInstructorProvisioningCsvPreview,
  handleInstructorProvisioningOneRosterApply,
  handleInstructorProvisioningOneRosterPreview,
  handleInstructorProvisioningRunList,
  handleInstructorProvisioningRunRead,
  handleInstructorProvisioningRunReportCsv,
} from "./handlers/provisioning";
import {
  createInstructorProvisioningOneRosterV1p2RestPreviewHandler,
  handleInstructorProvisioningOneRosterV1p2RestSourceCreate,
} from "./oneroster-rest-preview-route";

export function registerProvisioningRoutes(
  instructor: Hono<InstructorRouteEnv>,
  input: { readonly oneRosterPreview: OneRosterPreviewService },
): void {
  instructor.get("/provisioning/runs", handleInstructorProvisioningRunList);
  instructor.get("/provisioning/runs/:runId", handleInstructorProvisioningRunRead);
  instructor.get("/provisioning/runs/:runId/report.csv", handleInstructorProvisioningRunReportCsv);
  instructor.post("/provisioning/csv/preview", handleInstructorProvisioningCsvPreview);
  instructor.post("/provisioning/csv/apply", handleInstructorProvisioningCsvApply);
  instructor.post("/provisioning/oneroster/preview", handleInstructorProvisioningOneRosterPreview);
  instructor.post(
    "/provisioning/oneroster/rest/v1p2/sources",
    handleInstructorProvisioningOneRosterV1p2RestSourceCreate,
  );
  instructor.post(
    "/provisioning/oneroster/rest/v1p2/preview",
    createInstructorProvisioningOneRosterV1p2RestPreviewHandler(input.oneRosterPreview),
  );
  instructor.post("/provisioning/oneroster/apply", handleInstructorProvisioningOneRosterApply);
}
