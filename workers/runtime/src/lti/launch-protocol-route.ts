import type { Handler } from "hono";

import type { Env } from "../env";

import { launchLtiResourceLink } from "./launch-route";
import {
  readLtiLaunchForm,
  readResourceLinkLaunchMessage,
  verifyAndStoreLtiSession,
} from "./session";
import type { LtiEnv } from "./types";

/** Handles the public LTI Resource Link launch path with one form parse and verify/bind. */
export const handleHarborLtiLaunch: Handler<{ Bindings: Env }> = async (c) => {
  return launchLtiResourceLinkFromRequest({ request: c.req.raw, env: c.env });
};

/** Verifies an LTI Resource Link launch and enters the linked Harbor assignment. */
export async function launchLtiResourceLinkFromRequest(input: {
  readonly request: Request;
  readonly env: LtiEnv;
}): Promise<Response> {
  const { idToken, state } = await readLtiLaunchForm(input.request);
  const launch = await verifyAndStoreLtiSession(input.env, idToken, state);
  return launchLtiResourceLink({
    env: input.env,
    ltiSession: launch.ltiSession,
    registration: launch.registration,
    launchMessage: readResourceLinkLaunchMessage(launch.ltiSession),
  });
}
