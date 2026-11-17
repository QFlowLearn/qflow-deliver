import { LaunchRequestError } from "../launch/create-preview-attempt";

export type PathParamContext = {
  req: {
    param(name: string): string | undefined;
  };
};

export function readRequiredPathParam(c: PathParamContext, name: string): string {
  const value = c.req.param(name);
  if (!value) {
    throw new LaunchRequestError(400, `${name} is required`);
  }

  return value;
}

export function readAttemptIdParam(c: PathParamContext): string {
  return readRequiredPathParam(c, "attemptId");
}

export function readAssignmentIdParam(c: PathParamContext): string {
  return readRequiredPathParam(c, "assignmentId");
}

export function readAssessmentIdParam(c: PathParamContext): string {
  return readRequiredPathParam(c, "assessmentId");
}

export function readItemIdParam(c: PathParamContext): string {
  return readRequiredPathParam(c, "itemId");
}

export function readAssetIdParam(c: PathParamContext): string {
  return readRequiredPathParam(c, "assetId");
}

export function readAttemptIdQueryParam(url: URL): string {
  const attemptId = url.searchParams.get("attemptId")?.trim();
  if (!attemptId) {
    throw new LaunchRequestError(400, "attemptId query parameter is required");
  }

  return attemptId;
}
