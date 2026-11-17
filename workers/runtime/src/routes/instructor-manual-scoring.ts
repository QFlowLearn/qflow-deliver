import type {
  FinalizeManualScoringRequest,
  SaveManualScoreRequest,
} from "@harbor/attempt-protocol";
import {
  readAssignmentActor,
  readFiniteNumber,
  readJsonObject,
  readOptionalString,
} from "./route-request-utils";

export function readSaveManualScoreRequest(body: Record<string, unknown>): SaveManualScoreRequest {
  return {
    actor: readAssignmentActor(body.actor),
    score: readFiniteNumber(body.score, "score"),
    maxScore: readFiniteNumber(body.maxScore, "maxScore"),
    studentFeedback: readOptionalString(body.studentFeedback, "studentFeedback"),
    privateNote: readOptionalString(body.privateNote, "privateNote"),
  };
}

export function readFinalizeManualScoringRequest(
  body: Record<string, unknown>,
): FinalizeManualScoringRequest {
  return {
    actor: readAssignmentActor(body.actor),
  };
}

export async function readManualScoringRequestBody(
  request: Request,
): Promise<Record<string, unknown>> {
  return readJsonObject(request);
}
