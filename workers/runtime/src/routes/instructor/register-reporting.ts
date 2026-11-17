import type { Hono } from "hono";
import type { InstructorRouteEnv } from "./middleware";
import {
  handleInstructorAssignmentReportBundle,
  handleInstructorAssignmentReportDataDictionary,
  handleInstructorAssignmentReporting,
  handleInstructorLearnerReport,
  handleInstructorLearnerReportBundle,
  handleInstructorReportDataDictionary,
  handleInstructorReportExportCatalog,
  handleInstructorScoreAmendmentCreate,
  handleInstructorScoreAmendmentDeactivate,
  handleInstructorScoreAmendmentExport,
  handleInstructorScoreAmendmentList,
  handleInstructorScoreAmendmentPreview,
} from "./handlers/reporting";

export function registerReportingRoutes(instructor: Hono<InstructorRouteEnv>): void {
  instructor.get("/report-exports/catalog", handleInstructorReportExportCatalog);
  instructor.get("/report-exports/data-dictionary", handleInstructorReportDataDictionary);
  instructor.get(
    "/assignments/:assignmentId/report-exports/data-dictionary",
    handleInstructorAssignmentReportDataDictionary,
  );
  instructor.get(
    "/assignments/:assignmentId/report-exports/bundle",
    handleInstructorAssignmentReportBundle,
  );
  instructor.get(
    "/assignments/:assignmentId/learners/:learnerId/report-exports/bundle",
    handleInstructorLearnerReportBundle,
  );
  instructor.get("/assignments/:assignmentId/reporting", handleInstructorAssignmentReporting);
  instructor.get(
    "/assignments/:assignmentId/learners/:learnerId/report",
    handleInstructorLearnerReport,
  );
  instructor.get(
    "/assignments/:assignmentId/score-amendments/export",
    handleInstructorScoreAmendmentExport,
  );
  instructor.post(
    "/assignments/:assignmentId/score-amendments/preview",
    handleInstructorScoreAmendmentPreview,
  );
  instructor.post(
    "/assignments/:assignmentId/score-amendments/:amendmentId/deactivate",
    handleInstructorScoreAmendmentDeactivate,
  );
  instructor.get("/assignments/:assignmentId/score-amendments", handleInstructorScoreAmendmentList);
  instructor.post(
    "/assignments/:assignmentId/score-amendments",
    handleInstructorScoreAmendmentCreate,
  );
}
