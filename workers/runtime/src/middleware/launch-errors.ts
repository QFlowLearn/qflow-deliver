import { LtiRequestParseError } from "@longsightgroup/lti-tool";
import type { ErrorHandler } from "hono";
import { BootstrapTokenError } from "../launch/sign-bootstrap";
import { LaunchRequestError } from "../launch/create-preview-attempt";
import { LtiRegistrationError } from "../lti/registration-error";
import { PublishInputError } from "../publish/publish-errors";
import {
  createDeliveryContextErrorResponse,
  isDeliveryContextError,
} from "../routes/delivery-context";
import type { Env } from "../env";

export function launchErrorToResponse(error: unknown): Response | null {
  if (isDeliveryContextError(error)) {
    return createDeliveryContextErrorResponse(error);
  }

  if (error instanceof LaunchRequestError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof LtiRegistrationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof LtiRequestParseError) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  if (error instanceof Error && error.name === "ZodError") {
    return Response.json({ error: error.message }, { status: 400 });
  }

  if (error instanceof BootstrapTokenError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof PublishInputError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  return null;
}

export async function toRouteResponse(invoke: () => Promise<Response>): Promise<Response> {
  try {
    return await invoke();
  } catch (error) {
    const response = launchErrorToResponse(error);
    if (response) {
      return response;
    }

    throw error;
  }
}

export const launchErrorHandler: ErrorHandler<{ Bindings: Env }> = (error) => {
  const response = launchErrorToResponse(error);
  if (response) {
    return response;
  }

  throw error;
};
