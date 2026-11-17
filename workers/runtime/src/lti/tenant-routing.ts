import type { LTISession } from "@longsightgroup/lti-tool";
import { decodeJwt } from "jose";

import { LaunchRequestError } from "../launch/create-preview-attempt";

import { LTI_REGISTRATION_SELECT } from "./harbor-registration";
import { getHarborLtiTool, type HarborLtiToolEnv } from "./tool";
import type { LtiRegistrationRow } from "./types";

const DEPLOYMENT_ID_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/deployment_id";
const MAX_LTI_ROUTING_AUDIENCES = 8;

interface LaunchRoutingHint {
  readonly issuer: string;
  readonly deploymentId: string;
  readonly clientIds: ReadonlyArray<string>;
}

/** Routing hints are read from an unverified JWT; tenant-scoped verifyLaunch is authoritative. */
export async function resolveRegistrationFromLaunchHint(
  db: D1Database,
  idToken: string,
): Promise<LtiRegistrationRow> {
  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(idToken);
  } catch {
    throw new LaunchRequestError(400, "Invalid LTI launch token");
  }

  const hint = parseLaunchRoutingHint(claims);
  const clientPlaceholders = hint.clientIds.map(() => "?").join(", ");
  const matches = await db
    .prepare(
      `SELECT ${LTI_REGISTRATION_SELECT}
       FROM lti_registrations
       WHERE issuer = ?
         AND deployment_id = ?
         AND client_id IN (${clientPlaceholders})`,
    )
    .bind(hint.issuer, hint.deploymentId, ...hint.clientIds)
    .all<LtiRegistrationRow>();

  if (matches.results.length === 0) {
    throw new LaunchRequestError(404, "LTI registration not found");
  }
  if (matches.results.length > 1) {
    throw new LaunchRequestError(409, "LTI launch routing hints are ambiguous");
  }

  const registration = matches.results.at(0);
  if (!registration) {
    throw new Error("LTI registration lookup returned an inconsistent result");
  }
  return registration;
}

/** Binds a verified package session to immutable Harbor registration ownership. */
export async function bindVerifiedLtiSession(
  db: D1Database,
  session: LTISession,
  selectedRegistration: LtiRegistrationRow,
): Promise<void> {
  if (!registrationMatchesVerifiedSession(session, selectedRegistration)) {
    throw new LaunchRequestError(403, "Verified LTI launch does not match the selected tenant");
  }

  const now = new Date().toISOString();
  const binding = await db
    .prepare(
      `INSERT INTO lti_session_bindings
         (lti_session_id, registration_id, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lti_session_id) DO UPDATE SET
         updated_at = excluded.updated_at
       WHERE lti_session_bindings.registration_id = excluded.registration_id
         AND lti_session_bindings.tenant_id = excluded.tenant_id
       RETURNING registration_id, tenant_id`,
    )
    .bind(session.id, selectedRegistration.id, selectedRegistration.tenant_id, now, now)
    .first<{ registration_id: string; tenant_id: string }>();
  if (!binding) {
    throw new LaunchRequestError(409, "LTI session is already bound to another registration");
  }
}

/** Selects the tenant-specific package tool previously bound to a verified session. */
export async function getTenantLtiToolForSession(env: HarborLtiToolEnv, ltiSessionId: string) {
  const binding = await env.HARBOR_DB.prepare(
    "SELECT tenant_id FROM lti_session_bindings WHERE lti_session_id = ?",
  )
    .bind(ltiSessionId)
    .first<{ tenant_id: string }>();
  if (!binding) {
    throw new LaunchRequestError(404, "LTI session binding not found");
  }

  return getHarborLtiTool(env, binding.tenant_id);
}

function parseLaunchRoutingHint(claims: ReturnType<typeof decodeJwt>): LaunchRoutingHint {
  return {
    issuer: readRequiredHint(claims.iss, "LTI launch issuer hint is required"),
    deploymentId: readRequiredHint(
      claims[DEPLOYMENT_ID_CLAIM],
      "LTI launch deployment hint is required",
    ),
    clientIds: readAudienceHints(claims.aud),
  };
}

function readAudienceHints(audience: unknown): ReadonlyArray<string> {
  if (typeof audience === "string" && audience.trim()) {
    return [audience.trim()];
  }
  if (Array.isArray(audience)) {
    const clientIds = new Set<string>();
    for (const value of audience) {
      if (typeof value !== "string" || !value.trim()) {
        throw new LaunchRequestError(400, "LTI launch client hint is invalid");
      }
      clientIds.add(value.trim());
      if (clientIds.size > MAX_LTI_ROUTING_AUDIENCES) {
        throw new LaunchRequestError(400, "LTI launch contains too many client hints");
      }
    }
    if (clientIds.size > 0) {
      return [...clientIds];
    }
  }

  throw new LaunchRequestError(400, "LTI launch client hint is required");
}

function registrationMatchesVerifiedSession(
  session: LTISession,
  registration: LtiRegistrationRow,
): boolean {
  return (
    session.platform.issuer === registration.issuer &&
    session.platform.clientId === registration.client_id &&
    session.platform.deploymentId === registration.deployment_id
  );
}

function readRequiredHint(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LaunchRequestError(400, message);
  }
  return value.trim();
}
