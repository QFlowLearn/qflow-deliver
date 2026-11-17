import {
  createLtiPostMessageStorageRedirect,
  parseLtiLoginInitiation,
  renderLtiPostMessageStorageRedirectPage,
  type LTI13LoginInitiation,
} from "@longsightgroup/lti-tool";

import { launchErrorToResponse } from "../middleware/launch-errors";

import type { PublicLtiContext } from "./context";
import { readRegistrationForLogin } from "./harbor-registration";
import { getHarborLtiCore } from "./tool";
import { normalizeLtiLoginTargetLinkUri } from "./url";

export async function handleHarborLtiLogin(c: PublicLtiContext): Promise<Response> {
  const url = new URL(c.req.url);
  try {
    const loginRequest = await readLoginInitiation(c, url);
    const registration = await readRegistrationForLogin(c.env.HARBOR_DB, url, loginRequest);
    const { ltiTool } = await getHarborLtiCore(c.env, registration.tenant_id);
    const launchUrl = new URL(url.pathname.replace(/\/login$/, "/launch"), url.origin);
    const authRedirectUrl = await ltiTool.handleLogin({
      iss: loginRequest.iss,
      login_hint: loginRequest.login_hint,
      target_link_uri: loginRequest.target_link_uri,
      client_id: loginRequest.client_id ?? registration.client_id,
      lti_deployment_id: loginRequest.lti_deployment_id ?? registration.deployment_id,
      ...(loginRequest.lti_message_hint ? { lti_message_hint: loginRequest.lti_message_hint } : {}),
      launchUrl,
    });

    const storageResponse = renderPostMessageStorageResponse(
      authRedirectUrl,
      loginRequest.lti_storage_target,
    );
    if (storageResponse) {
      return storageResponse;
    }

    return Response.redirect(authRedirectUrl, 302);
  } catch (error) {
    const response = launchErrorToResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

async function readLoginInitiation(c: PublicLtiContext, url: URL): Promise<LTI13LoginInitiation> {
  if (c.req.method === "GET") {
    return parseHarborLtiLoginInitiation(
      {
        iss: url.searchParams.get("iss"),
        login_hint: url.searchParams.get("login_hint"),
        target_link_uri: url.searchParams.get("target_link_uri"),
        client_id: url.searchParams.get("client_id"),
        lti_deployment_id: url.searchParams.get("lti_deployment_id"),
        lti_message_hint: url.searchParams.get("lti_message_hint"),
        lti_storage_target: url.searchParams.get("lti_storage_target"),
      },
      url.origin,
    );
  }

  const formData = await c.req.formData();
  return parseHarborLtiLoginInitiation(
    {
      iss: readLoginFormValue(formData.get("iss")),
      login_hint: readLoginFormValue(formData.get("login_hint")),
      target_link_uri: readLoginFormValue(formData.get("target_link_uri")),
      client_id: readLoginFormValue(formData.get("client_id")),
      lti_deployment_id: readLoginFormValue(formData.get("lti_deployment_id")),
      lti_message_hint: readLoginFormValue(formData.get("lti_message_hint")),
      lti_storage_target: readLoginFormValue(formData.get("lti_storage_target")),
    },
    url.origin,
  );
}

function parseHarborLtiLoginInitiation(
  input: {
    iss: string | null;
    login_hint: string | null;
    target_link_uri: string | null;
    client_id: string | null;
    lti_deployment_id: string | null;
    lti_message_hint: string | null;
    lti_storage_target: string | null;
  },
  requestOrigin: string,
): LTI13LoginInitiation {
  return parseLtiLoginInitiation({
    iss: input.iss,
    login_hint: input.login_hint,
    target_link_uri: normalizeLtiLoginTargetLinkUri(input.target_link_uri, requestOrigin),
    client_id: input.client_id,
    lti_deployment_id: input.lti_deployment_id,
    lti_message_hint: input.lti_message_hint,
    lti_storage_target: input.lti_storage_target,
  });
}

function readLoginFormValue(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" ? value : null;
}

function renderPostMessageStorageResponse(
  authorizationRedirectUrl: string,
  storageTarget: string | undefined,
): Response | null {
  const postMessageStorageRedirect = createLtiPostMessageStorageRedirect({
    authorizationRedirectUrl,
    storageTarget,
  });
  if (!postMessageStorageRedirect) {
    return null;
  }

  return new Response(renderLtiPostMessageStorageRedirectPage(postMessageStorageRedirect), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
