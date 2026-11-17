import {
  upsertLaunchRegistration,
  type LtiDynamicRegistrationCompletionResult,
  type LTI13LoginInitiation,
  type LTISession,
} from "@longsightgroup/lti-tool";

import { createLtiId } from "./ids";
import { LtiRegistrationError } from "./registration-error";
import { D1RegistrationProjectionStore } from "./registration-projection-store";
import { getHarborLtiCore, type HarborLtiToolEnv } from "./tool";
import type { HarborRegistrationPersistInput, LtiRegistrationRow } from "./types";
import { resolveEndpointUrl } from "./url";

export const LTI_REGISTRATION_SELECT =
  "id, tenant_id, issuer, client_id, deployment_id, authorization_endpoint, token_endpoint, jwks_url";

const LTI_REGISTRATION_FROM_REGISTRATIONS_SELECT =
  "registrations.id, registrations.tenant_id, registrations.issuer, registrations.client_id, registrations.deployment_id, registrations.authorization_endpoint, registrations.token_endpoint, registrations.jwks_url";

/**
 * Harbor control-plane registrations are globally unique on (issuer, client_id, deployment_id).
 * One LMS deployment maps to one Harbor tenant; a second tenant cannot claim the same triple.
 */

function optionalTrimmedString(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function readRegistrationForLogin(
  db: D1Database,
  url: URL,
  loginRequest: LTI13LoginInitiation,
): Promise<LtiRegistrationRow> {
  const row = await findRegistrationForLogin(db, url, loginRequest);
  if (!row) {
    throw new LtiRegistrationError(404, "LTI registration not found");
  }

  return row;
}

export async function readRegistrationForLaunch(
  db: D1Database,
  session: LTISession,
): Promise<LtiRegistrationRow> {
  const row = await db
    .prepare(
      `SELECT ${LTI_REGISTRATION_SELECT} FROM lti_registrations WHERE issuer = ? AND client_id = ? AND deployment_id = ?`,
    )
    .bind(session.platform.issuer, session.platform.clientId, session.platform.deploymentId)
    .first<LtiRegistrationRow>();
  if (!row) {
    throw new LtiRegistrationError(404, "LTI registration not found");
  }

  return row;
}

export async function readRegistrationForBoundSession(
  db: D1Database,
  ltiSessionId: string,
): Promise<LtiRegistrationRow> {
  const row = await db
    .prepare(
      `SELECT ${LTI_REGISTRATION_FROM_REGISTRATIONS_SELECT}
       FROM lti_session_bindings bindings
       INNER JOIN lti_registrations registrations
         ON registrations.id = bindings.registration_id
        AND registrations.tenant_id = bindings.tenant_id
       WHERE bindings.lti_session_id = ?`,
    )
    .bind(ltiSessionId)
    .first<LtiRegistrationRow>();
  if (!row) {
    throw new LtiRegistrationError(404, "LTI session binding not found");
  }

  return row;
}

export async function persistHarborRegistrationAndProjectToProtocol(
  env: HarborLtiToolEnv,
  input: HarborRegistrationPersistInput,
  requestOrigin: string,
): Promise<string> {
  const registrationId = await new D1RegistrationProjectionStore(env.HARBOR_DB).upsert(input);
  await projectHarborRegistrationToProtocolStorage(
    env,
    {
      id: registrationId,
      tenant_id: input.tenantId,
      issuer: input.issuer,
      client_id: input.clientId,
      deployment_id: input.deploymentId,
      authorization_endpoint: input.authorizationEndpoint,
      token_endpoint: input.tokenEndpoint,
      jwks_url: input.jwksUrl,
    },
    requestOrigin,
  );
  return registrationId;
}

/** Writes Harbor projection only; dynamic registration already stored protocol rows. */
export async function persistHarborRegistrationProjectionOnly(
  env: HarborLtiToolEnv,
  completion: LtiDynamicRegistrationCompletionResult,
  tenantId: string,
): Promise<string> {
  return new D1RegistrationProjectionStore(env.HARBOR_DB).upsert({
    registrationId: createLtiId("ltireg"),
    tenantId,
    issuer: completion.client.iss,
    clientId: completion.client.clientId,
    deploymentId: completion.deployment.deploymentId,
    authorizationEndpoint: completion.client.authUrl,
    tokenEndpoint: completion.client.tokenUrl,
    jwksUrl: completion.client.jwksUrl,
  });
}

async function projectHarborRegistrationToProtocolStorage(
  env: HarborLtiToolEnv,
  registration: LtiRegistrationRow,
  requestOrigin: string,
): Promise<void> {
  const tokenEndpoint = optionalTrimmedString(registration.token_endpoint);
  if (!tokenEndpoint) {
    throw new LtiRegistrationError(400, "LTI registration token endpoint is required");
  }

  const { storage } = await getHarborLtiCore(env, registration.tenant_id);
  await upsertLaunchRegistration(storage, {
    iss: registration.issuer,
    clientId: registration.client_id,
    deploymentId: registration.deployment_id,
    authUrl: resolveEndpointUrl(registration.authorization_endpoint, requestOrigin),
    tokenUrl: resolveEndpointUrl(tokenEndpoint, requestOrigin),
    jwksUrl: resolveEndpointUrl(registration.jwks_url, requestOrigin),
  });
}

async function findRegistrationForLogin(
  db: D1Database,
  url: URL,
  loginRequest: LTI13LoginInitiation,
): Promise<LtiRegistrationRow | null> {
  const registrationId = optionalTrimmedString(url.searchParams.get("registration_id"));
  if (registrationId) {
    return readRegistrationById(db, registrationId);
  }

  const clientId = optionalTrimmedString(loginRequest.client_id);
  if (!clientId) {
    throw new LtiRegistrationError(400, "client_id is required");
  }

  const deploymentId = optionalTrimmedString(loginRequest.lti_deployment_id);
  if (deploymentId) {
    const row = await db
      .prepare(
        `SELECT ${LTI_REGISTRATION_SELECT} FROM lti_registrations WHERE issuer = ? AND client_id = ? AND deployment_id = ?`,
      )
      .bind(loginRequest.iss, clientId, deploymentId)
      .first<LtiRegistrationRow>();
    return row ?? null;
  }

  const matches = await db
    .prepare(
      `SELECT ${LTI_REGISTRATION_SELECT} FROM lti_registrations WHERE issuer = ? AND client_id = ?`,
    )
    .bind(loginRequest.iss, clientId)
    .all<LtiRegistrationRow>();

  if (matches.results.length === 0) {
    return null;
  }

  if (matches.results.length > 1) {
    throw new LtiRegistrationError(
      409,
      "lti_deployment_id is required when multiple registrations share the same issuer and client_id",
    );
  }

  return matches.results[0]!;
}

async function readRegistrationById(
  db: D1Database,
  registrationId: string,
): Promise<LtiRegistrationRow> {
  const row = await db
    .prepare(`SELECT ${LTI_REGISTRATION_SELECT} FROM lti_registrations WHERE id = ?`)
    .bind(registrationId)
    .first<LtiRegistrationRow>();
  if (!row) {
    throw new LtiRegistrationError(404, "LTI registration not found");
  }

  return row;
}
