import {
  LtiLaunchMessageResolutionError,
  LtiRequestParseError,
  parseLtiDeepLinkingResponseRequest,
  parseLtiLaunchFormData,
  resolveLtiLaunchMessage,
  type DeepLinkingContentItem,
  type LTISession,
  type ParsedLtiLaunchForm,
  type ResolvedLtiDeepLinkingLaunchMessage,
  type ResolvedLtiResourceLinkLaunchMessage,
} from "@longsightgroup/lti-tool";

import { LaunchRequestError } from "../launch/create-preview-attempt";

import type { VerifiedLtiLaunch } from "./launch-context";
import { getHarborLtiTool } from "./tool";
import { bindVerifiedLtiSession, resolveRegistrationFromLaunchHint } from "./tenant-routing";
import type { LtiEnv } from "./types";

export async function readLtiLaunchForm(request: Request): Promise<ParsedLtiLaunchForm> {
  try {
    return await parseLtiLaunchFormData(request);
  } catch (error) {
    if (error instanceof LtiRequestParseError) {
      throw new LaunchRequestError(400, error.message);
    }

    throw error;
  }
}

export function readLtiDeepLinkingContentItems(
  body: Record<string, unknown>,
): DeepLinkingContentItem[] {
  try {
    return parseLtiDeepLinkingResponseRequest(body).contentItems;
  } catch (error) {
    if (error instanceof LtiRequestParseError) {
      throw new LaunchRequestError(400, error.message);
    }

    throw error;
  }
}

export async function verifyAndStoreLtiSession(
  env: LtiEnv,
  idToken: string,
  state: string,
): Promise<VerifiedLtiLaunch> {
  const registration = await resolveRegistrationFromLaunchHint(env.HARBOR_DB, idToken);
  const ltiTool = await getHarborLtiTool(env, registration.tenant_id);
  const verification = await ltiTool.verifyLaunch(idToken, state);
  if (!verification.success) {
    if (verification.error.code === "nonce_replay") {
      throw new LaunchRequestError(409, "LTI launch state has already been used");
    }

    throw new LaunchRequestError(401, "LTI launch could not be verified");
  }

  const ltiSession = await ltiTool.createSessionFromVerifiedLaunch(verification.launch);
  await bindVerifiedLtiSession(env.HARBOR_DB, ltiSession, registration);
  return { ltiSession, registration };
}

export function readResourceLinkLaunchMessage(
  session: LTISession,
): ResolvedLtiResourceLinkLaunchMessage {
  const launchMessage = readLtiLaunchMessage(session);
  if (launchMessage.kind !== "resource-link") {
    throw new LaunchRequestError(400, "LTI resource link launch is required");
  }

  return launchMessage;
}

export function readDeepLinkingLaunchMessage(
  session: LTISession,
): ResolvedLtiDeepLinkingLaunchMessage {
  const launchMessage = readLtiLaunchMessage(session);
  if (launchMessage.kind !== "deep-linking") {
    throw new LaunchRequestError(400, "LTI deep linking is not available");
  }

  return launchMessage;
}

function readLtiLaunchMessage(
  session: LTISession,
): ResolvedLtiResourceLinkLaunchMessage | ResolvedLtiDeepLinkingLaunchMessage {
  try {
    return resolveLtiLaunchMessage(session);
  } catch (error) {
    if (error instanceof LtiLaunchMessageResolutionError) {
      throw new LaunchRequestError(400, "LTI launch message is not supported");
    }

    throw error;
  }
}
