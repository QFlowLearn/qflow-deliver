import { Hono } from "hono";

import type { Env } from "../../env";
import { launchErrorToResponse } from "../../middleware/launch-errors";
import {
  handleHarborLtiDeepLinkingLaunch,
  handleHarborLtiDeepLinkingResponse,
} from "../../lti/deep-linking-route";
import {
  handleHarborLtiDynamicRegistrationComplete,
  handleHarborLtiDynamicRegistrationStart,
} from "../../lti/dynamic-registration-routes";
import { handleHarborLtiJwks } from "../../lti/jwks-route";
import { handleHarborLtiLaunch } from "../../lti/launch-protocol-route";
import { handleHarborLtiLogin } from "../../lti/login-route";

export function createPublicLtiRoutes(): Hono<{ Bindings: Env }> {
  const lti = new Hono<{ Bindings: Env }>();

  lti.onError((error, c) => {
    const response = launchErrorToResponse(error);
    if (response) {
      return response;
    }

    console.error("LTI public route error", {
      path: new URL(c.req.url).pathname,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  });

  lti.get("/jwks", handleHarborLtiJwks);
  lti.get("/register/:registrationCode", handleHarborLtiDynamicRegistrationStart);
  lti.post("/register/:registrationCode/complete", handleHarborLtiDynamicRegistrationComplete);
  lti.get("/login", handleHarborLtiLogin);
  lti.post("/login", handleHarborLtiLogin);

  lti.post("/launch", handleHarborLtiLaunch);
  lti.post("/deep-linking", handleHarborLtiDeepLinkingLaunch);
  lti.post("/deep-linking/response", handleHarborLtiDeepLinkingResponse);

  return lti;
}
