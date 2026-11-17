import { handleStaffGrantPut, handleStaffGrantDelete } from "../../staff/grant-routes";
import { Hono } from "hono";
import type { Env } from "../../env";
import {
  handleGetInternalAssignmentRequest,
  handlePostInternalAssignmentRequest,
} from "../assignments";
import { handleGetInternalAttemptEvidenceRequest } from "../attempt-evidence";
import { handlePostAttemptPolicyRequest } from "../attempt-policy";
import { handleMockInstitutionalAuthorizeRequest } from "../auth/session";
import { handlePasswordAccountCreateRequest } from "../auth/password-handlers";
import { handleIssueAccessCodesRequest } from "../launch";
import {
  handleGetOperatorAttemptTimelineRequest,
  handlePostActivateAssessmentVersionRequest,
  handlePostOperatorAttemptActionBatchRequest,
  handlePostOperatorAttemptActionRequest,
} from "../operator-actions";
import { handlePublishPackageRequest } from "../publish";
import { handleQflowAdminRequest } from "../qflow/admin";
import { handleQflowCapabilityRequest } from "../qflow/capability";
import { handleQflowHandoffRequest } from "../qflow/handoff";
import { handleQflowPublishRequest } from "../qflow/publish";
import { handleQflowStateRequest } from "../qflow/state";

export function createInternalRoutes(): Hono<{ Bindings: Env }> {
  const internal = new Hono<{ Bindings: Env }>();

  internal.put("/staff/grants/:grantId", handleStaffGrantPut);
  internal.delete("/staff/grants/:grantId", handleStaffGrantDelete);

  internal.post("/publish", handlePublishPackageRequest);
  internal.post("/access-codes", handleIssueAccessCodesRequest);
  internal.get("/mock-institutional/authorize", handleMockInstitutionalAuthorizeRequest);
  internal.post("/auth/password/accounts", handlePasswordAccountCreateRequest);
  internal.post("/assignments", handlePostInternalAssignmentRequest);
  internal.get("/assignments/:assignmentId", handleGetInternalAssignmentRequest);
  internal.post("/attempts/:attemptId/actions", handlePostOperatorAttemptActionRequest);
  internal.post("/attempt-actions/batch", handlePostOperatorAttemptActionBatchRequest);
  internal.get("/attempts/:attemptId/timeline", handleGetOperatorAttemptTimelineRequest);
  internal.post(
    "/assessments/:assessmentId/activate-version",
    handlePostActivateAssessmentVersionRequest,
  );
  internal.get("/attempts/:attemptId/evidence", handleGetInternalAttemptEvidenceRequest);
  internal.post("/attempts/:attemptId/policy", handlePostAttemptPolicyRequest);

  internal.post("/qflow/handoff", handleQflowHandoffRequest);
  internal.post("/qflow/capability", handleQflowCapabilityRequest);
  internal.post("/qflow/publish", handleQflowPublishRequest);
  internal.post("/qflow/state", handleQflowStateRequest);
  internal.get("/admin/qflow-tenants", handleQflowAdminRequest);
  internal.post("/admin/qflow-tenants", handleQflowAdminRequest);

  return internal;
}
