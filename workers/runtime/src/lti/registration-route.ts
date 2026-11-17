import { persistHarborRegistrationAndProjectToProtocol } from "./harbor-registration";
import type { InternalLtiContext } from "./context";
import { resolveEndpointUrl } from "./url";
import type { LtiEnv } from "./types";
import { readJsonObject, readRequiredString } from "../routes/route-request-utils";

export async function handleHarborLtiRegistrationUpsert(c: InternalLtiContext): Promise<Response> {
  return upsertLtiRegistration({
    request: c.req.raw,
    env: c.env,
    url: new URL(c.req.url),
  });
}

export async function upsertLtiRegistration(input: {
  readonly request: Request;
  readonly env: LtiEnv;
  readonly url: URL;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const requestedRegistrationId = readRequiredString(
    body.registrationId ?? `ltireg_${crypto.randomUUID().replaceAll("-", "")}`,
    "registrationId is required",
  );
  const issuer = readRequiredString(body.issuer, "issuer is required");
  const clientId = readRequiredString(body.clientId, "clientId is required");
  const deploymentId = readRequiredString(body.deploymentId, "deploymentId is required");
  const tenantId = readRequiredString(body.tenantId, "tenantId is required");
  const authorizationEndpoint = resolveEndpointUrl(
    readRequiredString(body.authorizationEndpoint, "authorizationEndpoint is required"),
    input.url.origin,
  );
  const jwksUrl = resolveEndpointUrl(
    readRequiredString(body.jwksUrl, "jwksUrl is required"),
    input.url.origin,
  );
  const tokenEndpoint = resolveEndpointUrl(
    readRequiredString(body.tokenEndpoint, "tokenEndpoint is required"),
    input.url.origin,
  );

  const registrationId = await persistHarborRegistrationAndProjectToProtocol(
    input.env,
    {
      registrationId: requestedRegistrationId,
      tenantId,
      issuer,
      clientId,
      deploymentId,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUrl,
    },
    input.url.origin,
  );

  return Response.json(
    {
      registrationId,
      tenantId,
      issuer,
      clientId,
      deploymentId,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUrl,
    },
    { status: 201 },
  );
}
