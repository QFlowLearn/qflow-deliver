import {
  SCORE_AMENDMENT_ACTIONS,
  createEmptyAttemptPolicyState,
  type AssignmentActorSnapshot,
  type HarborAccommodationProfileDefinition,
  type ScoreAmendmentAction,
  type UpsertAssignmentLearnerOverrideRequest,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../../launch/create-preview-attempt";
import { readAssignmentActor, readJsonObject, readRequiredString } from "../../route-request-utils";
import {
  readAccommodationProfileDefinition,
  readAssignmentLearnerPolicyOverrides,
  readAttemptAccommodations,
  readOptionalLearnerAccommodationStatus,
  readOptionalProfileStatus,
  readOptionalString,
} from "./json-parsers";

export async function readAccommodationProfileCreateRequest(request: Request): Promise<{
  profileId?: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "inactive";
  profile: HarborAccommodationProfileDefinition;
  actor: AssignmentActorSnapshot;
}> {
  const body = await readJsonObject(request);
  return {
    profileId:
      body.profileId === undefined
        ? undefined
        : readRequiredString(body.profileId, "profileId must be a string"),
    tenantId: readRequiredString(body.tenantId, "tenantId must be a string"),
    name: readRequiredString(body.name, "name must be a string"),
    description: readOptionalString(body.description),
    status: readOptionalProfileStatus(body.status) ?? "active",
    profile: readAccommodationProfileDefinition(body.profile),
    actor: readAssignmentActor(body.actor),
  };
}

export async function readAccommodationProfileUpdateRequest(request: Request): Promise<{
  name?: string;
  description?: string | null;
  status?: "draft" | "active" | "inactive";
  profile?: HarborAccommodationProfileDefinition;
  actor: AssignmentActorSnapshot;
}> {
  const body = await readJsonObject(request);
  return {
    name:
      body.name === undefined ? undefined : readRequiredString(body.name, "name must be a string"),
    description: body.description === undefined ? undefined : readOptionalString(body.description),
    status: readOptionalProfileStatus(body.status),
    profile:
      body.profile === undefined ? undefined : readAccommodationProfileDefinition(body.profile),
    actor: readAssignmentActor(body.actor),
  };
}

export async function readLearnerAccommodationAssignmentRequest(request: Request): Promise<{
  status: "active" | "inactive";
  sourceKind: string;
  effectiveAt: string;
  expiresAt: string | null;
}> {
  const body = await readJsonObject(request);
  return {
    status: readOptionalLearnerAccommodationStatus(body.status) ?? "active",
    sourceKind:
      body.sourceKind === undefined
        ? "instructor"
        : readRequiredString(body.sourceKind, "sourceKind must be a string"),
    effectiveAt:
      body.effectiveAt === undefined
        ? new Date().toISOString()
        : readRequiredString(body.effectiveAt, "effectiveAt must be a string"),
    expiresAt: readOptionalString(body.expiresAt),
  };
}

export async function readUpsertAssignmentLearnerOverrideRequest(
  request: Request,
): Promise<UpsertAssignmentLearnerOverrideRequest> {
  const body = await readJsonObject(request);
  return {
    actor: readAssignmentActor(body.actor),
    policyOverrides: readAssignmentLearnerPolicyOverrides(body.policyOverrides),
    accommodations:
      body.accommodations === undefined
        ? createEmptyAttemptPolicyState().accommodations
        : readAttemptAccommodations(body.accommodations),
  };
}

export async function readCreateScoreAmendmentRequest(
  request: Request,
): Promise<import("@harbor/attempt-protocol").CreateScoreAmendmentRequest> {
  const body = await readJsonObject(request);
  return {
    actor: readAssignmentActor(body.actor),
    itemId: readRequiredString(body.itemId, "itemId is required"),
    action: readScoreAmendmentAction(body.action),
    responseMatchText:
      body.responseMatchText === undefined || body.responseMatchText === null
        ? null
        : readRequiredString(body.responseMatchText, "responseMatchText must be a string"),
    reason: readRequiredString(body.reason, "reason is required"),
  };
}

export async function readDeactivateScoreAmendmentRequest(
  request: Request,
): Promise<import("@harbor/attempt-protocol").DeactivateScoreAmendmentRequest> {
  const body = await readJsonObject(request);
  return {
    actor: readAssignmentActor(body.actor),
    reason: readRequiredString(body.reason, "reason is required"),
  };
}

function readScoreAmendmentAction(value: unknown): ScoreAmendmentAction {
  const action = readRequiredString(value, "score amendment action is required");
  if (!SCORE_AMENDMENT_ACTIONS.includes(action as ScoreAmendmentAction)) {
    throw new LaunchRequestError(400, "Score amendment action is not supported");
  }

  return action as ScoreAmendmentAction;
}
