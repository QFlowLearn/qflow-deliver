import { getInternalAttemptEvidence } from "../../attempt-evidence";
import { getOperatorAttemptTimeline, postOperatorAttemptAction } from "../../operator-actions";
import type { InstructorContext } from "../context";
import { withAttempt } from "../context";

export async function handleInstructorAttemptAction(c: InstructorContext): Promise<Response> {
  return withAttempt(c, async (scope, attemptId) =>
    postOperatorAttemptAction({
      env: scope.env,
      attemptId,
      request: c.req.raw,
    }),
  );
}

export async function handleInstructorAttemptTimeline(c: InstructorContext): Promise<Response> {
  return withAttempt(c, async (scope, attemptId) =>
    getOperatorAttemptTimeline({
      env: scope.env,
      attemptId,
    }),
  );
}

export async function handleInstructorAttemptEvidence(c: InstructorContext): Promise<Response> {
  return withAttempt(c, async (scope, attemptId) =>
    getInternalAttemptEvidence({
      env: scope.env,
      attemptId,
    }),
  );
}
