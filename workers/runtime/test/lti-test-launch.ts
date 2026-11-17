import { expect } from "vitest";

import { get, postForm } from "./lti-test-environment";
import { extractAuthorizeParams, issueSignedIdToken } from "./lti-test-platform";

export async function performLtiLaunch(input: {
  issuer: string;
  clientId: string;
  deploymentId: string;
  subject: string;
  resourceLinkId: string;
  contextId?: string | null;
  displayName?: string;
  email?: string | null;
  ags?: {
    lineitem?: string;
    lineitems?: string;
    scopes?: string[];
  };
  nrps?: {
    membershipUrl?: string;
    versions?: string[];
  };
  custom?: Record<string, string>;
}): Promise<{
  launchResponse: Response;
  cookie: string;
  bootstrapToken: string;
  state: string;
  idToken: string;
}> {
  const loginResponse = await get(
    `/api/lti/login?iss=${encodeURIComponent(input.issuer)}&client_id=${encodeURIComponent(
      input.clientId,
    )}&lti_deployment_id=${encodeURIComponent(input.deploymentId)}&login_hint=${encodeURIComponent(
      input.subject,
    )}&target_link_uri=${encodeURIComponent(
      "https://harbor.local/api/lti/launch",
    )}&lti_message_hint=${encodeURIComponent(
      JSON.stringify({
        resourceLinkId: input.resourceLinkId,
        contextId: input.contextId ?? null,
        displayName: input.displayName ?? "Taylor LTI",
        email: input.email ?? "taylor.lti@example.edu",
        ...(input.ags ? { ags: input.ags } : {}),
        ...(input.nrps ? { nrps: input.nrps } : {}),
      }),
    )}`,
  );

  expect(loginResponse.status).toBe(302);
  const authorizeLocation = loginResponse.headers.get("location");
  expect(authorizeLocation).toContain("https://platform.harbor.test/authorize");
  const authorizeParams = extractAuthorizeParams(authorizeLocation);
  const idToken = await issueSignedIdToken({
    issuer: input.issuer,
    audience: input.clientId,
    subject: authorizeParams.login_hint,
    nonce: authorizeParams.nonce,
    deploymentId: input.deploymentId,
    targetLinkUri: authorizeParams.redirect_uri,
    resourceLinkId: input.resourceLinkId,
    contextId: input.contextId,
    displayName: input.displayName,
    email: input.email,
    ags: input.ags,
    nrps: input.nrps,
    custom: input.custom,
  });

  const launchResponse = await postForm("/api/lti/launch", {
    state: authorizeParams.state,
    id_token: idToken,
  });
  const cookie = launchResponse.headers.get("set-cookie");
  const location = launchResponse.headers.get("location");

  expect(cookie).toBeTruthy();
  expect(location).toContain("/session?mode=lti&bootstrapToken=");
  if (!cookie || !location) {
    throw new Error("Verified LTI launch did not return its session redirect");
  }
  const bootstrapToken = new URL(`https://harbor.local${location}`).searchParams.get(
    "bootstrapToken",
  );
  if (!bootstrapToken) {
    throw new Error("Verified LTI launch redirect did not contain a bootstrap token");
  }

  return {
    launchResponse,
    cookie,
    bootstrapToken,
    state: authorizeParams.state,
    idToken,
  };
}

export async function submitLtiLaunch(input: {
  issuer: string;
  clientId: string;
  deploymentId: string;
  subject: string;
  resourceLinkId: string;
  contextId?: string | null;
  custom?: Record<string, string>;
}): Promise<Response> {
  const loginResponse = await get(
    `/api/lti/login?iss=${encodeURIComponent(input.issuer)}&client_id=${encodeURIComponent(
      input.clientId,
    )}&lti_deployment_id=${encodeURIComponent(input.deploymentId)}&login_hint=${encodeURIComponent(
      input.subject,
    )}&target_link_uri=${encodeURIComponent(
      "https://harbor.local/api/lti/launch",
    )}&lti_message_hint=${encodeURIComponent(
      JSON.stringify({
        resourceLinkId: input.resourceLinkId,
        contextId: input.contextId ?? null,
        ...(input.custom ? { custom: input.custom } : {}),
      }),
    )}`,
  );
  const authorizeParams = extractAuthorizeParams(loginResponse.headers.get("location"));
  const idToken = await issueSignedIdToken({
    issuer: input.issuer,
    audience: input.clientId,
    subject: authorizeParams.login_hint,
    nonce: authorizeParams.nonce,
    deploymentId: input.deploymentId,
    targetLinkUri: authorizeParams.redirect_uri,
    resourceLinkId: input.resourceLinkId,
    contextId: input.contextId,
    custom: input.custom,
  });

  return postForm("/api/lti/launch", {
    state: authorizeParams.state,
    id_token: idToken,
  });
}
