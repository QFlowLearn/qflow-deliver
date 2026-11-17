import { getResultsOps, postResultsOpsRetry } from "../../results-ops";
import type { InstructorContext } from "../context";
import { readInstructorTenantId, withAttempt } from "../context";

export function handleInstructorResultsOpsList(c: InstructorContext): Promise<Response> {
  return getResultsOps({
    env: c.env,
    tenantId: readInstructorTenantId(c),
    request: c.req.raw,
  });
}

export async function handleInstructorResultsOpsRetry(c: InstructorContext): Promise<Response> {
  return withAttempt(c, async (scope, attemptId) =>
    postResultsOpsRetry({
      env: scope.env,
      tenantId: scope.tenantId,
      attemptId,
      request: c.req.raw,
    }),
  );
}
