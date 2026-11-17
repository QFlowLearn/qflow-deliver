import { Hono } from "hono";
import type { Env } from "../../env";
import { handleAttemptEventRequest } from "../attempt-events";
import { handleAttemptPolicyRequest } from "../attempt-policy";
import {
  handleConfigDownloadRequest,
  handleLaunchMetadataRequest,
} from "../safe-exam-browser-config";

export function createStudentAttemptRoutes(): Hono<{ Bindings: Env }> {
  const attempts = new Hono<{ Bindings: Env }>();

  attempts.post("/attempts/:attemptId/events", handleAttemptEventRequest);
  attempts.get("/attempts/:attemptId/policy", handleAttemptPolicyRequest);
  attempts.post(
    "/student/assignments/:assignmentId/safe-exam-browser/launch",
    handleLaunchMetadataRequest,
  );
  attempts.get(
    "/student/assignments/:assignmentId/safe-exam-browser/config.seb",
    handleConfigDownloadRequest,
  );

  return attempts;
}
