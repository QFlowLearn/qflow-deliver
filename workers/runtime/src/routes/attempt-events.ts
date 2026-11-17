import type {
  AttemptEventCommitResponse,
  AttemptEventType,
  CommitAttemptEventReceipt,
} from "@harbor/attempt-protocol";
import {
  ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER,
  ATTEMPT_COORDINATOR_DELIVERY_CONTEXT_URL_HEADER,
} from "../attempts/attempt-durable-object";
import {
  buildAttemptEventMetric,
  recordAttemptRuntimeMetric,
} from "../observability/attempt-runtime-metrics";
import {
  buildSubmitFinalizationEnvelope,
  sendSubmitFinalizationEnvelope,
  type SubmitFinalizationEnvelope,
} from "../queues/submit-finalization";
import { projectAttemptEvidenceEvent } from "./attempt-evidence";
import type { AppContext } from "./hono-utils";
import { readAttemptIdParam } from "./route-params";

interface AttemptEventsEnv {
  HARBOR_DB: D1Database;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
  SUBMIT_FINALIZATION_QUEUE: Queue<SubmitFinalizationEnvelope>;
}

export async function handleAttemptEventRequest(c: AppContext): Promise<Response> {
  return commitAttemptEvent({
    request: c.req.raw,
    env: c.env,
    attemptId: readAttemptIdParam(c),
    ctx: c.executionCtx,
  });
}

export async function commitAttemptEvent(input: {
  request: Request;
  env: AttemptEventsEnv;
  attemptId: string;
  ctx: ExecutionContext;
}): Promise<Response> {
  const requestBody = await input.request.text();
  const eventType = readEventType(requestBody);
  const stub = input.env.ATTEMPT_COORDINATOR.get(
    input.env.ATTEMPT_COORDINATOR.idFromName(input.attemptId),
  );
  const headers = new Headers(input.request.headers);
  headers.set("content-type", "application/json");
  headers.set(ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER, input.attemptId);
  headers.set(ATTEMPT_COORDINATOR_DELIVERY_CONTEXT_URL_HEADER, input.request.url);

  const startedAt = performance.now();
  const response = await stub.fetch("https://harbor-attempt.local/commit", {
    method: "POST",
    headers,
    body: requestBody,
  });

  const commitResponse = await response
    .clone()
    .json<AttemptEventCommitResponse>()
    .catch(() => null);

  if (eventType && response.ok && commitResponse) {
    const receivedAt = new Date().toISOString();
    const submitReceipt = readSubmitFinalizationReceipt(eventType, commitResponse);
    if (commitResponse.outcome === "accepted" || commitResponse.outcome === "duplicate") {
      // Opportunistic delivery is post-response; the durable alarm owns recovery.
      input.ctx.waitUntil(
        stub
          .fetch("https://harbor-attempt.local/deliver-outbox", {
            method: "POST",
            headers: { [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: input.attemptId },
          })
          .then(async (deliveryResponse) => {
            const result: unknown = await deliveryResponse.json();
            if (
              !deliveryResponse.ok ||
              !result ||
              typeof result !== "object" ||
              !("outcome" in result) ||
              (result.outcome !== "ready" && result.outcome !== "deferred")
            ) {
              throw new Error("Invalid attempt outbox delivery result");
            }
            if (result.outcome === "deferred" || !submitReceipt) return;
            await sendSubmitFinalizationEnvelope(
              input.env,
              buildSubmitFinalizationEnvelope({
                eventType: eventType === "item.submit-requested" ? "submit.requested" : eventType,
                receipt: submitReceipt,
              }),
            );
          })
          .catch(() => {
            console.error("Attempt commit outbox wake-up deferred", { attemptId: input.attemptId });
          }),
      );
    }
    if (commitResponse.outcome !== "accepted" && commitResponse.outcome !== "late_preserved") {
      input.ctx.waitUntil(
        projectAttemptEvidenceEvent({
          db: input.env.HARBOR_DB,
          attemptId: input.attemptId,
          requestBody,
          commitResponse,
          receivedAt,
        }).catch((error) => {
          console.error("Unable to project attempt evidence event", {
            attemptId: input.attemptId,
            eventType,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    recordAttemptRuntimeMetric(
      input.env,
      buildAttemptEventMetric({
        attemptId: input.attemptId,
        eventType,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        response: commitResponse,
      }),
    );
  }

  return response;
}

function readSubmitFinalizationReceipt(
  eventType: AttemptEventType,
  response: AttemptEventCommitResponse,
): CommitAttemptEventReceipt | null {
  if (
    eventType !== "submit.requested" &&
    eventType !== "timing.auto-submit.requested" &&
    eventType !== "item.submit-requested"
  ) {
    return null;
  }

  if (response.outcome === "accepted" && response.attemptStatus === "submitted") {
    return response;
  }

  if (response.outcome === "duplicate" && response.storedReceipt.attemptStatus === "submitted") {
    return response.storedReceipt;
  }

  return null;
}

function readEventType(body: string): AttemptEventType | null {
  try {
    const parsed = JSON.parse(body) as { type?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }

    return parsed.type as AttemptEventType;
  } catch {
    return null;
  }
}
