import {
  type LtiDynamicRegistrationCompletionResult,
  type LtiLogger,
} from "@longsightgroup/lti-tool";
import {
  completeDynamicRegistrationRouteHandler,
  initiateDynamicRegistrationRouteHandler,
} from "@longsightgroup/lti-tool/hono";

import { persistHarborRegistrationProjectionOnly } from "./harbor-registration";
import { readHarborLtiRegistrationTenantId } from "./registration-link";
import { getHarborLtiDynamicRegistration } from "./tool";

import type { PublicLtiContext } from "./context";

const HARBOR_LTI_ROUTE_LOGGER: LtiLogger = {
  debug() {},
  info() {},
  warn: logSafeLtiRouteWarning,
  error: logSafeLtiRouteError,
};

/** Verifies Harbor tenant ownership before delegating registration initiation to lti-tool. */
export async function handleHarborLtiDynamicRegistrationStart(
  c: PublicLtiContext,
): Promise<Response> {
  const tenantId = await readRegistrationTenantId(c);
  if (!tenantId) {
    return Response.json({ error: "Registration link is invalid" }, { status: 404 });
  }

  const dynamicRegistration = await getHarborLtiDynamicRegistration(c.env, tenantId);
  const handler = initiateDynamicRegistrationRouteHandler({
    initiateDynamicRegistration: (request, routePath, options) =>
      dynamicRegistration.initiateDynamicRegistration(request, routePath, options),
    getDynamicRegistrationAppState: () => ({ tenantId }),
    logger: HARBOR_LTI_ROUTE_LOGGER,
  });
  return handler(c, emptyLtiNext);
}

/** Verifies Harbor tenant ownership before delegating registration completion to lti-tool. */
export async function handleHarborLtiDynamicRegistrationComplete(
  c: PublicLtiContext,
): Promise<Response> {
  const tenantId = await readRegistrationTenantId(c);
  if (!tenantId) {
    return Response.json({ error: "Registration link is invalid" }, { status: 404 });
  }

  const dynamicRegistration = await getHarborLtiDynamicRegistration(c.env, tenantId);
  const handler = completeDynamicRegistrationRouteHandler({
    completeDynamicRegistration: (form) => dynamicRegistration.completeDynamicRegistration(form),
    onRegistrationComplete: async (completion) => {
      assertCompletionTenant(completion, tenantId);
      await persistHarborRegistrationProjectionOnly(c.env, completion, tenantId);
    },
    logger: HARBOR_LTI_ROUTE_LOGGER,
  });
  return handler(c, emptyLtiNext);
}

async function readRegistrationTenantId(c: PublicLtiContext): Promise<string | null> {
  const registrationCode = c.req.param("registrationCode");
  if (!registrationCode) {
    return null;
  }
  return readHarborLtiRegistrationTenantId(c.env, registrationCode);
}

function assertCompletionTenant(
  completion: LtiDynamicRegistrationCompletionResult,
  signedRouteTenantId: string,
): void {
  const appState = completion.appState;
  if (appState === null || typeof appState !== "object" || Array.isArray(appState)) {
    throw new Error("LTI dynamic registration tenant state is missing");
  }

  const tenantId = Object.getOwnPropertyDescriptor(appState, "tenantId")?.value;
  if (typeof tenantId !== "string" || tenantId !== signedRouteTenantId) {
    throw new Error("LTI dynamic registration tenant state does not match the signed route");
  }
}

function emptyLtiNext(): Promise<void> {
  return Promise.resolve();
}

function logSafeLtiRouteWarning(
  fieldsOrMessage: string | Readonly<Record<string, unknown>>,
  message?: string,
): void {
  console.warn(readSafeLogMessage(fieldsOrMessage, message), {
    errorType: readSafeErrorType(fieldsOrMessage),
  });
}

function logSafeLtiRouteError(
  fieldsOrMessage: string | Readonly<Record<string, unknown>>,
  message?: string,
): void {
  console.error(readSafeLogMessage(fieldsOrMessage, message), {
    errorType: readSafeErrorType(fieldsOrMessage),
  });
}

function readSafeLogMessage(
  fieldsOrMessage: string | Readonly<Record<string, unknown>>,
  message: string | undefined,
): string {
  return typeof fieldsOrMessage === "string" ? fieldsOrMessage : (message ?? "LTI route error");
}

function readSafeErrorType(
  fieldsOrMessage: string | Readonly<Record<string, unknown>>,
): string | undefined {
  if (typeof fieldsOrMessage === "string") {
    return undefined;
  }

  const error = fieldsOrMessage.error;
  return error instanceof Error ? error.name : typeof error;
}
