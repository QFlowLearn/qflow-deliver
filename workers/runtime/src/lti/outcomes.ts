import {
  formatLtiServiceError,
  isLtiAgsLineItemAvailable,
  type LTISession,
} from "@longsightgroup/lti-tool";

import { getTenantLtiToolForSession } from "./tenant-routing";

interface LtiOutcomeEnv {
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET?: string;
  LTI_STATE_SECRET?: string;
  LTI_TOOL_PRIVATE_KEY_JWK?: string;
}

interface LtiAttemptLaunchRow {
  lti_session_id: string;
}

interface AttemptResultRow {
  attempt_id: string;
  id: string;
  result_finalization_id: string;
  status: "pending" | "complete" | "failed" | "rescored";
  total_score: number | null;
  max_score: number | null;
  finalized_at: string;
  test_outcome_variables_json: string;
}

export async function publishLtiOutcomeForAttemptResult(input: {
  db: D1Database;
  env: LtiOutcomeEnv;
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
}): Promise<void> {
  const intent = await ensurePendingLtiOutcomeDeliveryForAttemptResult(input);
  if (!intent) {
    return;
  }

  const { ltiSessionId, result } = intent;
  const deliveryId = createDeliveryId(input.resultFinalizationId);
  try {
    const outcomes: unknown = JSON.parse(result.test_outcome_variables_json);
    if (!Array.isArray(outcomes)) throw new Error("Invalid stored result outcomes.");
    if (
      outcomes.some(
        (entry: unknown) =>
          entry &&
          typeof entry === "object" &&
          "identifier" in entry &&
          entry.identifier === "HARBOR_SEQUENCE_TARGET",
      )
    ) {
      await upsertOutcomeDelivery({
        db: input.db,
        deliveryId,
        result,
        ltiSessionId,
        status: "skipped",
        errorMessage: "Grade passback is not supported for adaptive assessments.",
        deliveredAt: null,
      });
      return;
    }
    if (result.total_score === null || result.max_score === null) {
      await upsertOutcomeDelivery({
        db: input.db,
        deliveryId,
        result,
        ltiSessionId,
        status: "skipped",
        errorMessage: "LTI AGS score passback requires total and maximum scores",
        deliveredAt: null,
      });
      return;
    }

    const { ltiSession, ltiTool } = await readStoredLtiSession(input.env, ltiSessionId);
    if (!isLtiAgsLineItemAvailable(ltiSession)) {
      await upsertOutcomeDelivery({
        db: input.db,
        deliveryId,
        result,
        ltiSessionId,
        status: "skipped",
        errorMessage: "LTI AGS lineitem is not available for this launch",
        deliveredAt: null,
      });
      return;
    }

    const submission = await ltiTool.createAdvantage(ltiSession).submitScore({
      userId: ltiSession.user.id,
      scoreGiven: result.total_score,
      scoreMaximum: result.max_score,
      timestamp: result.finalized_at,
      activityProgress: "Completed",
      gradingProgress: result.status === "failed" ? "Failed" : "FullyGraded",
    });
    if (!submission.success) {
      await upsertOutcomeDelivery({
        db: input.db,
        deliveryId,
        result,
        ltiSessionId,
        status: "failed",
        errorMessage: formatLtiServiceError(submission.error),
        deliveredAt: null,
      });
      return;
    }

    await upsertOutcomeDelivery({
      db: input.db,
      deliveryId,
      result,
      ltiSessionId,
      status: "complete",
      errorMessage: null,
      deliveredAt: new Date().toISOString(),
    });
  } catch (error) {
    await upsertOutcomeDelivery({
      db: input.db,
      deliveryId,
      result,
      ltiSessionId,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      deliveredAt: null,
    });
  }
}

export async function ensurePendingLtiOutcomeDeliveryForAttemptResult(input: {
  db: D1Database;
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
}): Promise<{ result: AttemptResultRow; ltiSessionId: string } | null> {
  const ltiLaunch = await readLtiAttemptLaunch(input.db, input.attemptId);
  if (!ltiLaunch) {
    return null;
  }

  const result = await readAttemptResult(input.db, input.attemptResultId);
  if (!result) {
    return null;
  }

  const deliveryId = createDeliveryId(input.resultFinalizationId);
  await upsertOutcomeDelivery({
    db: input.db,
    deliveryId,
    result,
    ltiSessionId: ltiLaunch.lti_session_id,
    status: "pending",
    errorMessage: null,
    deliveredAt: null,
  });

  return {
    result,
    ltiSessionId: ltiLaunch.lti_session_id,
  };
}

export function buildPendingLtiOutcomeDeliveryIntentStatement(input: {
  db: D1Database;
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
  totalScore: number | null;
  maxScore: number | null;
  finalizedAt: string;
  now: string;
}): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT OR IGNORE INTO lti_outcome_deliveries
         (id, attempt_id, attempt_result_id, result_finalization_id, lti_session_id, status, score_given, score_maximum, submitted_at, delivered_at, error_message, created_at, updated_at)
       SELECT ?, ?, ?, ?, launches.lti_session_id, ?, ?, ?, ?, NULL, NULL, ?, ?
         FROM lti_attempt_launches launches
        WHERE launches.attempt_id = ?`,
    )
    .bind(
      createDeliveryId(input.resultFinalizationId),
      input.attemptId,
      input.attemptResultId,
      input.resultFinalizationId,
      "pending",
      input.totalScore,
      input.maxScore,
      input.finalizedAt,
      input.now,
      input.now,
      input.attemptId,
    );
}

async function readLtiAttemptLaunch(
  db: D1Database,
  attemptId: string,
): Promise<LtiAttemptLaunchRow | null> {
  return db
    .prepare("SELECT lti_session_id FROM lti_attempt_launches WHERE attempt_id = ?")
    .bind(attemptId)
    .first<LtiAttemptLaunchRow>();
}

async function readAttemptResult(
  db: D1Database,
  attemptResultId: string,
): Promise<AttemptResultRow | null> {
  return db
    .prepare(
      "SELECT attempt_id, id, result_finalization_id, status, total_score, max_score, finalized_at, test_outcome_variables_json FROM attempt_results WHERE id = ?",
    )
    .bind(attemptResultId)
    .first<AttemptResultRow>();
}

async function readStoredLtiSession(
  env: LtiOutcomeEnv,
  sessionId: string,
): Promise<{
  ltiTool: Awaited<ReturnType<typeof getTenantLtiToolForSession>>;
  ltiSession: LTISession;
}> {
  const ltiTool = await getTenantLtiToolForSession(requireLtiToolEnv(env), sessionId);
  const session = await ltiTool.getSession(sessionId);
  if (!session) {
    throw new Error("Stored LTI session is unavailable");
  }

  return { ltiTool, ltiSession: session };
}

async function upsertOutcomeDelivery(input: {
  db: D1Database;
  deliveryId: string;
  result: AttemptResultRow;
  ltiSessionId: string | null;
  status: "pending" | "complete" | "failed" | "skipped";
  errorMessage: string | null;
  deliveredAt: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await input.db
    .prepare(
      "INSERT INTO lti_outcome_deliveries (id, attempt_id, attempt_result_id, result_finalization_id, lti_session_id, status, score_given, score_maximum, submitted_at, delivered_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(result_finalization_id) DO UPDATE SET lti_session_id = excluded.lti_session_id, status = excluded.status, score_given = excluded.score_given, score_maximum = excluded.score_maximum, submitted_at = excluded.submitted_at, delivered_at = excluded.delivered_at, error_message = excluded.error_message, updated_at = excluded.updated_at",
    )
    .bind(
      input.deliveryId,
      input.result.attempt_id,
      input.result.id,
      input.result.result_finalization_id,
      input.ltiSessionId,
      input.status,
      input.result.total_score,
      input.result.max_score,
      input.result.finalized_at,
      input.deliveredAt,
      input.errorMessage,
      now,
      now,
    )
    .run();
}

function requireLtiToolEnv(env: LtiOutcomeEnv): LtiOutcomeEnv & {
  BOOTSTRAP_SIGNING_SECRET: string;
  LTI_TOOL_PRIVATE_KEY_JWK: string;
} {
  if (!env.BOOTSTRAP_SIGNING_SECRET) {
    throw new Error("BOOTSTRAP_SIGNING_SECRET is required for LTI services");
  }
  if (!env.LTI_TOOL_PRIVATE_KEY_JWK) {
    throw new Error("LTI_TOOL_PRIVATE_KEY_JWK is required for LTI services");
  }
  return env as LtiOutcomeEnv & {
    BOOTSTRAP_SIGNING_SECRET: string;
    LTI_TOOL_PRIVATE_KEY_JWK: string;
  };
}

function createDeliveryId(resultFinalizationId: string): string {
  return `ltiout_${resultFinalizationId.replaceAll("-", "")}`;
}
