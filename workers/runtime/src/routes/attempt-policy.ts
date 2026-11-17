import { ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER } from "../attempts/attempt-durable-object";
import type { AppContext } from "./hono-utils";
import { readAttemptIdParam } from "./route-params";

interface AttemptPolicyEnv {
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
}

export async function handleAttemptPolicyRequest(c: AppContext): Promise<Response> {
  return getAttemptPolicy({
    env: c.env,
    attemptId: readAttemptIdParam(c),
  });
}

export async function getAttemptPolicy(input: {
  env: AttemptPolicyEnv;
  attemptId: string;
}): Promise<Response> {
  const stub = input.env.ATTEMPT_COORDINATOR.get(
    input.env.ATTEMPT_COORDINATOR.idFromName(input.attemptId),
  );
  return stub.fetch("https://harbor-attempt.local/policy", {
    method: "GET",
    headers: {
      [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: input.attemptId,
    },
  });
}

export async function handlePostAttemptPolicyRequest(c: AppContext): Promise<Response> {
  return postAttemptPolicy({
    env: c.env,
    attemptId: readAttemptIdParam(c),
    request: c.req.raw,
  });
}

export async function postAttemptPolicy(input: {
  env: AttemptPolicyEnv;
  attemptId: string;
  request: Request;
}): Promise<Response> {
  const stub = input.env.ATTEMPT_COORDINATOR.get(
    input.env.ATTEMPT_COORDINATOR.idFromName(input.attemptId),
  );
  return stub.fetch("https://harbor-attempt.local/policy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: input.attemptId,
    },
    body: await input.request.text(),
  });
}
