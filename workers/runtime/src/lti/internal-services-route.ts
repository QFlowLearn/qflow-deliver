import { formatLtiServiceError, type LTISession } from "@longsightgroup/lti-tool";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import {
  readJsonObject,
  readOptionalString,
  readRequiredNumber,
  readRequiredString,
} from "../routes/route-request-utils";

import type { InternalLtiContext } from "./context";
import { syncLtiNrpsMembersForAttempt } from "./nrps-sync";
import { getTenantLtiToolForSession } from "./tenant-routing";
import type { LtiEnv } from "./types";

export async function handleHarborLtiListLineItems(c: InternalLtiContext): Promise<Response> {
  return listLtiLineItems({
    env: c.env,
    attemptId: readAttemptId(c),
  });
}

export async function handleHarborLtiCreateLineItem(c: InternalLtiContext): Promise<Response> {
  return createLtiLineItem({
    request: c.req.raw,
    env: c.env,
    attemptId: readAttemptId(c),
  });
}

export async function handleHarborLtiLineItem(c: InternalLtiContext): Promise<Response> {
  return getLtiLineItem({
    env: c.env,
    attemptId: readAttemptId(c),
  });
}

export async function handleHarborLtiNrpsMembers(c: InternalLtiContext): Promise<Response> {
  return listLtiNrpsMembers({
    env: c.env,
    attemptId: readAttemptId(c),
  });
}

export async function handleHarborLtiNrpsSync(c: InternalLtiContext): Promise<Response> {
  return syncLtiNrpsForAttempt({
    env: c.env,
    attemptId: readAttemptId(c),
  });
}

function readAttemptId(c: InternalLtiContext): string {
  const attemptId = c.req.param("attemptId");
  if (!attemptId) {
    throw new LaunchRequestError(400, "attemptId is required");
  }

  return attemptId;
}

export async function listLtiLineItems(input: {
  readonly env: LtiEnv;
  readonly attemptId: string;
}): Promise<Response> {
  const { ltiTool, ltiSession } = await readLtiToolSessionForAttempt(input.env, input.attemptId);

  const result = await ltiTool.createAdvantage(ltiSession).listLineItems();
  if (!result.success) {
    throw new LaunchRequestError(502, formatLtiServiceError(result.error));
  }

  return Response.json(
    {
      lineItems: result.data,
    },
    { status: 200 },
  );
}

export async function createLtiLineItem(input: {
  readonly request: Request;
  readonly env: LtiEnv;
  readonly attemptId: string;
}): Promise<Response> {
  const { ltiTool, ltiSession } = await readLtiToolSessionForAttempt(input.env, input.attemptId);

  const body = await readJsonObject(input.request);
  const label = readRequiredString(body.label, "label is required");
  const scoreMaximum = readRequiredNumber(body.scoreMaximum, "scoreMaximum is required");
  const resourceId = readOptionalString(body.resourceId);
  const resourceLinkId = readOptionalString(body.resourceLinkId);
  const tag = readOptionalString(body.tag);

  const result = await ltiTool.createAdvantage(ltiSession).createLineItem({
    label,
    scoreMaximum,
    ...(resourceId === null ? {} : { resourceId }),
    ...(resourceLinkId === null ? {} : { resourceLinkId }),
    ...(tag === null ? {} : { tag }),
  });
  if (!result.success) {
    throw new LaunchRequestError(502, formatLtiServiceError(result.error));
  }

  return Response.json(
    {
      lineItem: result.data,
    },
    { status: 201 },
  );
}

export async function getLtiLineItem(input: {
  readonly env: LtiEnv;
  readonly attemptId: string;
}): Promise<Response> {
  const { ltiTool, ltiSession } = await readLtiToolSessionForAttempt(input.env, input.attemptId);

  const result = await ltiTool.createAdvantage(ltiSession).getLineItem();
  if (!result.success) {
    throw new LaunchRequestError(502, formatLtiServiceError(result.error));
  }

  return Response.json(
    {
      lineItem: result.data,
    },
    { status: 200 },
  );
}

export async function listLtiNrpsMembers(input: {
  readonly env: LtiEnv;
  readonly attemptId: string;
}): Promise<Response> {
  const { ltiTool, ltiSession } = await readLtiToolSessionForAttempt(input.env, input.attemptId);

  const members = await ltiTool.createAdvantage(ltiSession).getMembers();
  if (!members.success) {
    throw new LaunchRequestError(502, formatLtiServiceError(members.error));
  }

  return Response.json(
    {
      members: members.data,
    },
    { status: 200 },
  );
}

export async function syncLtiNrpsForAttempt(input: {
  readonly env: LtiEnv;
  readonly attemptId: string;
}): Promise<Response> {
  try {
    return Response.json(
      await syncLtiNrpsMembersForAttempt({ env: input.env, attemptId: input.attemptId }),
      { status: 200 },
    );
  } catch (error) {
    throw new LaunchRequestError(
      502,
      error instanceof Error ? error.message : "LTI NRPS sync failed",
    );
  }
}

async function readLtiToolSessionForAttempt(
  env: LtiEnv,
  attemptId: string,
): Promise<{
  ltiTool: Awaited<ReturnType<typeof getTenantLtiToolForSession>>;
  ltiSession: LTISession;
}> {
  const launch = await env.HARBOR_DB.prepare(
    "SELECT lti_session_id FROM lti_attempt_launches WHERE attempt_id = ?",
  )
    .bind(attemptId)
    .first<{ lti_session_id: string }>();
  if (!launch) {
    throw new LaunchRequestError(404, "LTI attempt launch not found");
  }

  const ltiTool = await getTenantLtiToolForSession(env, launch.lti_session_id);
  const ltiSession = await ltiTool.getSession(launch.lti_session_id);
  if (!ltiSession) {
    throw new LaunchRequestError(404, "LTI session not found");
  }

  return { ltiTool, ltiSession };
}
