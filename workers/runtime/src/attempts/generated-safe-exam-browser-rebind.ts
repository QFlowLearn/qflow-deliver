import type { AssignmentPolicySnapshot, DeliveryContextEvaluation } from "@harbor/attempt-protocol";
import { parseStoredAssignmentPolicySnapshot } from "../routes/assignment-request-parsers";
import { verifySafeExamBrowserLaunchToken } from "../routes/safe-exam-browser-config";
import { readHarborSessionContextBySessionId } from "../routes/auth/session";
import { requireAllowedDeliveryContext } from "../routes/delivery-context";
import { resolveGeneratedSafeExamBrowserConfigPolicy } from "../security/generated-safe-exam-browser-config";
import { readJsonObject, readRequiredString } from "./attempt-request-parsing";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";
import { resolveAttemptStatus } from "./attempt-status";
import type { StoredAttemptState } from "./attempt-state-bootstrap";

/** Prepare a narrowly scoped generated-config replacement from authenticated launch evidence. */
export async function prepareGeneratedSafeExamBrowserRebind(input: {
  readonly db: D1Database;
  readonly secret: string;
  readonly request: Request;
  readonly deliveryRequest: Request;
  readonly storedState: StoredAttemptState;
}): Promise<{
  readonly state: StoredAttemptState;
  readonly assignmentPolicy: AssignmentPolicySnapshot;
  readonly context: DeliveryContextEvaluation;
}> {
  const body = await readJsonObject(input.request);
  if (Object.keys(body).some((key) => key !== "launchToken"))
    throw new AttemptDurableObjectRequestError(
      400,
      "Generated SEB rebind accepts only a launch token",
    );
  const launchToken = readRequiredString(body.launchToken, "SEB launch token is required");
  const claims = await verifySafeExamBrowserLaunchToken({
    token: launchToken,
    secret: input.secret,
  });
  const state = input.storedState;
  const entry = await input.db
    .prepare(
      "SELECT assignment_id, actor_kind, actor_id, assignment_policy_snapshot FROM attempt_entries WHERE id = ?",
    )
    .bind(state.attemptId)
    .first<{
      assignment_id: string | null;
      actor_kind: string;
      actor_id: string | null;
      assignment_policy_snapshot: string | null;
    }>();
  const session = await readHarborSessionContextBySessionId(
    { HARBOR_DB: input.db },
    claims.sessionId,
  );
  if (
    !entry ||
    entry.actor_kind !== "student-learner" ||
    entry.actor_id !== claims.learnerId ||
    entry.assignment_id !== claims.assignmentId ||
    state.assignmentId !== claims.assignmentId ||
    session?.learner.id !== claims.learnerId
  )
    throw new AttemptDurableObjectRequestError(403, "SEB launch does not own this attempt");
  if (resolveAttemptStatus(state) === "submitted")
    throw new AttemptDurableObjectRequestError(
      409,
      "Submitted attempts cannot replace SEB configuration",
    );
  if (!entry.assignment_policy_snapshot)
    throw new AttemptDurableObjectRequestError(
      409,
      "Pinned assignment policy is required for SEB relaunch",
    );
  const pinnedAssignment = parseStoredAssignmentPolicySnapshot(entry.assignment_policy_snapshot);
  const resolved = await resolveGeneratedSafeExamBrowserConfigPolicy({
    assignmentPolicy: {
      ...pinnedAssignment,
      safeExamBrowser: state.deliveryPolicy.safeExamBrowser,
    },
    deliveryPolicy: state.deliveryPolicy,
    requestUrl: input.deliveryRequest.url,
    assignmentId: claims.assignmentId,
    launchToken,
  });
  if (!resolved)
    throw new AttemptDurableObjectRequestError(409, "Attempt has no generated SEB configuration");
  const context = await requireAllowedDeliveryContext({
    request: input.deliveryRequest,
    deliveryPolicy: resolved.deliveryPolicy,
  });
  if (!context.secureBrowserVerified)
    throw new AttemptDurableObjectRequestError(
      403,
      "Generated SEB relaunch requires verified browser proof",
    );
  return {
    state: { ...state, deliveryPolicy: resolved.deliveryPolicy },
    assignmentPolicy: resolved.assignmentPolicy,
    context,
  };
}

/** Mirror only the coordinator-approved generated policy into the attempt's control-plane record. */
export async function projectGeneratedSafeExamBrowserRebind(
  db: D1Database,
  state: StoredAttemptState,
  assignmentPolicy: AssignmentPolicySnapshot,
): Promise<void> {
  await db
    .prepare(
      "UPDATE attempt_entries SET delivery_policy_snapshot = ?, assignment_policy_snapshot = ? WHERE id = ? AND assignment_id = ?",
    )
    .bind(
      JSON.stringify(state.deliveryPolicy),
      JSON.stringify(assignmentPolicy),
      state.attemptId,
      state.assignmentId,
    )
    .run();
}
