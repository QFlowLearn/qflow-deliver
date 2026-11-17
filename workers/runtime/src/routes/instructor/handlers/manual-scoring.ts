import {
  finalizeManualScoring,
  readManualScoringAttempt,
  readManualScoringQueue,
  saveManualScore,
} from "../../../results/manual-scoring";
import { requestUrl } from "../../hono-utils";
import {
  readFinalizeManualScoringRequest,
  readManualScoringRequestBody,
  readSaveManualScoreRequest,
} from "../../instructor-manual-scoring";
import type { InstructorContext } from "../context";
import { readInstructorTenantId, withAttempt, withAttemptItem } from "../context";

export async function handleInstructorManualScoringQueue(c: InstructorContext): Promise<Response> {
  const url = requestUrl(c);
  return c.json(
    await readManualScoringQueue({
      db: c.env.HARBOR_DB,
      tenantId: readInstructorTenantId(c),
      assignmentId: url.searchParams.get("assignmentId"),
    }),
    200,
  );
}

export async function handleInstructorManualScoringAttemptRead(
  c: InstructorContext,
): Promise<Response> {
  return withAttempt(c, async (scope, attemptId) =>
    c.json(
      await readManualScoringAttempt({
        db: scope.db,
        attemptId,
      }),
      200,
    ),
  );
}

export async function handleInstructorManualScoringItemSave(
  c: InstructorContext,
): Promise<Response> {
  return withAttemptItem(c, async (scope, attemptId, itemId) =>
    c.json(
      await saveManualScore({
        db: scope.db,
        attemptId,
        itemId,
        request: readSaveManualScoreRequest(await readManualScoringRequestBody(c.req.raw)),
      }),
      200,
    ),
  );
}

export async function handleInstructorManualScoringFinalize(
  c: InstructorContext,
): Promise<Response> {
  return withAttempt(c, async (scope, attemptId) =>
    c.json(
      await finalizeManualScoring({
        db: scope.db,
        env: scope.env,
        attemptId,
        request: readFinalizeManualScoringRequest(await readManualScoringRequestBody(c.req.raw)),
      }),
      200,
    ),
  );
}
