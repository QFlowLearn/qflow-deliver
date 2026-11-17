import type {
  AttemptEventType,
  AttemptItemScoreSummary,
  AttemptSubmissionMaterializationInput,
  AttemptSubmissionSummary,
  AttemptVariableSnapshot,
  CommitAttemptEventReceipt,
} from "@harbor/attempt-protocol";
import { hasPendingManualScoringOutcome } from "@harbor/attempt-protocol";
import type { AttemptPolicyReadResponse } from "@harbor/attempt-protocol";
import type { DeliveryManifest } from "@harbor/content-model";
import {
  buildSubmitFinalizationEnvelope,
  ensurePendingSubmitFinalization,
  loadAttemptResultContext,
  readPendingSubmitFinalizationEnvelopes,
  type AttemptResultContextRow,
  type PersistedResultFinalization,
  type SubmitFinalizationEnvelope,
} from "./submit-finalization-outbox";
import {
  buildSubmitFinalizationMetric,
  createAttemptRuntimeLog,
  recordAttemptRuntimeMetric,
} from "../observability/attempt-runtime-metrics";
import { queueInitialResultExport, type ResultExportProducerEnv } from "./result-export";
import { applyActiveScoreAmendmentsForAttemptResult } from "../results/score-amendments";
import { publishLtiOutcomeForAttemptResult } from "../lti/outcomes";
import { materializeSubmissionWithAuthoritativeQti } from "../results/qti-server-scoring";

export const SUBMIT_FINALIZATION_QUEUE_NAME = "harbor-submit-finalization";
export const SUBMIT_FINALIZATION_DLQ_NAME = "harbor-submit-finalization-dlq";
const RESULT_MATERIALIZATION_PATH = "https://harbor-attempt.local/result-materialization";
const ATTEMPT_POLICY_PATH = "https://harbor-attempt.local/policy";
const DEFAULT_PENDING_FINALIZATION_REQUEUE_LIMIT = 50;

export {
  buildSubmitFinalizationEnvelope,
  type SubmitFinalizationEnvelope,
} from "./submit-finalization-outbox";

export interface SubmitFinalizationConsumptionRecord {
  attemptId: string;
  outcome: "consumed";
  receiptId: string;
}

export interface SubmitFinalizationConsumerEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET?: string;
  LTI_STATE_SECRET?: string;
  LTI_TOOL_PRIVATE_KEY_JWK?: string;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
  RESULT_EXPORT_QUEUE?: ResultExportProducerEnv["RESULT_EXPORT_QUEUE"];
  record?: (entry: SubmitFinalizationConsumptionRecord) => void;
}

interface SubmitFinalizationProducerEnv {
  HARBOR_DB: D1Database;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
  SUBMIT_FINALIZATION_QUEUE: Queue<SubmitFinalizationEnvelope>;
}

interface ResultMaterializationPayload {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  submissionMaterialization: AttemptSubmissionMaterializationInput;
  submissionSummary: AttemptSubmissionSummary | null;
}

export interface PendingSubmitFinalizationRequeueSummary {
  checkedCount: number;
  queuedCount: number;
  failedCount: number;
}

interface ComputedResultProjection {
  source: "authoritative-qti-snapshot" | "compatibility-submission-summary";
  totalScore: number | null;
  maxScore: number | null;
  passed: boolean | null;
  resultStatus: "pending" | "complete";
  testResponseVariables: AttemptVariableSnapshot[];
  testOutcomeVariables: AttemptVariableSnapshot[];
  items: Array<{
    itemPosition: number;
    itemId: string;
    itemIdentifier: string | null;
    itemTitle: string | null;
    answered: boolean;
    responseSummary: string | null;
    score: number | null;
    maxScore: number | null;
    responseVariables: AttemptVariableSnapshot[];
    outcomeVariables: AttemptVariableSnapshot[];
    sessionStatus:
      | "initial"
      | "pendingSubmission"
      | "pendingResponseProcessing"
      | "pendingExternalScoring"
      | "final";
  }>;
}

export async function consumeSubmitFinalizationBatch(
  batch: MessageBatch<SubmitFinalizationEnvelope>,
  env: SubmitFinalizationConsumerEnv,
): Promise<void> {
  for (const message of batch.messages) {
    const startedAt = performance.now();

    try {
      await processSubmitFinalizationEnvelope(message.body, env);
      env.record?.({
        attemptId: message.body.attemptId,
        outcome: "consumed",
        receiptId: message.body.receiptId,
      });
      recordAttemptRuntimeMetric(
        env,
        buildSubmitFinalizationMetric({
          attemptId: message.body.attemptId,
          outcome: "consumed",
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          acceptedSequenceNumber: message.body.acceptedSequenceNumber,
        }),
      );
    } catch (error) {
      await markSubmitFinalizationFailed({
        db: env.HARBOR_DB,
        envelope: message.body,
        error,
      });
      const metric = buildSubmitFinalizationMetric({
        attemptId: message.body.attemptId,
        outcome: "failed",
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        acceptedSequenceNumber: message.body.acceptedSequenceNumber,
      });
      recordAttemptRuntimeMetric(env, metric);
      console.error(
        JSON.stringify({
          ...createAttemptRuntimeLog(metric),
          queue: SUBMIT_FINALIZATION_QUEUE_NAME,
          receiptId: message.body.receiptId,
          submittedAt: message.body.submittedAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      message.ack();
    }
  }
}

export async function processSubmitFinalizationEnvelope(
  envelope: SubmitFinalizationEnvelope,
  env: SubmitFinalizationConsumerEnv,
): Promise<void> {
  await finalizeAttemptResult(envelope, env);
}

export async function enqueueSubmitFinalization(input: {
  env: SubmitFinalizationProducerEnv;
  eventType: AttemptEventType;
  receipt: CommitAttemptEventReceipt;
}): Promise<SubmitFinalizationEnvelope> {
  const envelope = buildSubmitFinalizationEnvelope({
    eventType: input.eventType,
    receipt: input.receipt,
  });

  await ensurePendingSubmitFinalization({
    db: input.env.HARBOR_DB,
    envelope,
  });
  await sendSubmitFinalizationEnvelope(input.env, envelope);
  return envelope;
}

export async function runPendingSubmitFinalizationRequeues(input: {
  env: SubmitFinalizationProducerEnv;
  limit?: number;
}): Promise<PendingSubmitFinalizationRequeueSummary> {
  const pending = await readPendingSubmitFinalizationEnvelopes({
    db: input.env.HARBOR_DB,
    limit: input.limit ?? DEFAULT_PENDING_FINALIZATION_REQUEUE_LIMIT,
  });
  const summary: PendingSubmitFinalizationRequeueSummary = {
    checkedCount: pending.length,
    queuedCount: 0,
    failedCount: 0,
  };

  for (const envelope of pending) {
    const queued = await sendSubmitFinalizationEnvelope(input.env, envelope);
    if (queued) {
      summary.queuedCount += 1;
    } else {
      summary.failedCount += 1;
    }
  }

  return summary;
}

/** Send a handoff whose pending D1 record is already durable; scheduled requeue recovers failures. */
export async function sendSubmitFinalizationEnvelope(
  env: SubmitFinalizationProducerEnv,
  envelope: SubmitFinalizationEnvelope,
): Promise<boolean> {
  try {
    await env.SUBMIT_FINALIZATION_QUEUE.send(envelope);
    recordAttemptRuntimeMetric(
      env,
      buildSubmitFinalizationMetric({
        attemptId: envelope.attemptId,
        outcome: "queued",
        latencyMs: 0,
        acceptedSequenceNumber: envelope.acceptedSequenceNumber,
      }),
    );
    return true;
  } catch (error) {
    const metric = buildSubmitFinalizationMetric({
      attemptId: envelope.attemptId,
      outcome: "failed",
      latencyMs: 0,
      acceptedSequenceNumber: envelope.acceptedSequenceNumber,
    });

    recordAttemptRuntimeMetric(env, metric);
    console.error(
      JSON.stringify({
        ...createAttemptRuntimeLog(metric),
        queue: SUBMIT_FINALIZATION_QUEUE_NAME,
        receiptId: envelope.receiptId,
        submittedAt: envelope.submittedAt,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

async function finalizeAttemptResult(
  envelope: SubmitFinalizationEnvelope,
  env: SubmitFinalizationConsumerEnv,
): Promise<void> {
  const context = await loadAttemptResultContext(env.HARBOR_DB, envelope.attemptId);
  const finalization = await ensurePendingSubmitFinalization({
    db: env.HARBOR_DB,
    envelope,
    context,
  });
  const materialization = await readResultMaterialization({
    coordinator: env.ATTEMPT_COORDINATOR,
    attemptId: envelope.attemptId,
  });
  const policy = await readAttemptPolicy({
    coordinator: env.ATTEMPT_COORDINATOR,
    attemptId: envelope.attemptId,
  });
  const manifest = await loadDeliveryManifest({
    bucket: env.CONTENT_BUCKET,
    manifestObjectKey: context.manifest_object_key,
  });
  const finalizedAt = new Date().toISOString();
  const scoredMaterialization = await materializeSubmissionWithAuthoritativeQti({
    bucket: env.CONTENT_BUCKET,
    manifest,
    materialization: materialization.submissionMaterialization,
    scoredAt: finalizedAt,
    allowIncompleteResponses:
      envelope.eventType === "timing.auto-submit.requested" ||
      policy.policy.accommodations.sessionControl.allow_skipping !== false,
  });
  const projection = computeResultProjection(
    {
      ...materialization,
      submissionMaterialization: scoredMaterialization,
      submissionSummary: null,
    },
    buildManifestMaxScoreMap(manifest),
  );

  const resultId = await persistAttemptResult({
    db: env.HARBOR_DB,
    finalization,
    envelope,
    projection,
    materialization,
    finalizedAt,
  });
  if (projection.resultStatus === "complete") {
    await applyActiveScoreAmendmentsForAttemptResult({
      db: env.HARBOR_DB,
      attemptResultId: resultId,
    });
    await publishLtiOutcomeForAttemptResult({
      db: env.HARBOR_DB,
      env,
      attemptId: envelope.attemptId,
      attemptResultId: resultId,
      resultFinalizationId: finalization.id,
    });
    await queueInitialResultExport({
      db: env.HARBOR_DB,
      env,
      attemptId: envelope.attemptId,
      attemptResultId: resultId,
      resultFinalizationId: finalization.id,
      assignmentId: materialization.assignmentId,
      assessmentVersionId: materialization.assessmentVersionId,
      sourceReceiptId: envelope.receiptId,
    });
  }
}

async function readAttemptPolicy(input: {
  coordinator: DurableObjectNamespace;
  attemptId: string;
}): Promise<AttemptPolicyReadResponse> {
  const stub = input.coordinator.get(input.coordinator.idFromName(input.attemptId));
  const response = await stub.fetch(ATTEMPT_POLICY_PATH, {
    method: "GET",
    headers: {
      "x-harbor-attempt-id": input.attemptId,
    },
  });

  if (!response.ok) {
    const payload = await response.json<{ error?: string }>().catch(() => ({ error: undefined }));
    throw new Error(payload.error ?? "Attempt policy is unavailable during finalization");
  }

  return response.json<AttemptPolicyReadResponse>();
}

async function readResultMaterialization(input: {
  coordinator: DurableObjectNamespace;
  attemptId: string;
}): Promise<ResultMaterializationPayload> {
  const stub = input.coordinator.get(input.coordinator.idFromName(input.attemptId));
  const response = await stub.fetch(RESULT_MATERIALIZATION_PATH, {
    method: "GET",
    headers: {
      "x-harbor-attempt-id": input.attemptId,
    },
  });

  if (!response.ok) {
    const payload = await response.json<{ error?: string }>().catch(() => ({ error: undefined }));
    throw new Error(payload.error ?? "Attempt result materialization payload is unavailable");
  }

  return response.json<ResultMaterializationPayload>();
}

function computeResultProjection(
  materialization: ResultMaterializationPayload,
  manifestMaxScores: Map<string, number | null>,
): ComputedResultProjection {
  const authoritativeItems = buildAuthoritativeItems(
    materialization.submissionMaterialization,
    manifestMaxScores,
  );
  const hasAuthoritativeSnapshot =
    authoritativeItems.length > 0 ||
    materialization.submissionMaterialization.testState !== null ||
    Object.keys(materialization.submissionMaterialization.partStates).length > 0 ||
    Object.keys(materialization.submissionMaterialization.sectionStates).length > 0;

  if (hasAuthoritativeSnapshot) {
    const testResponseVariables = [
      ...(materialization.submissionMaterialization.testState?.responseVariables ?? []),
      ...Object.values(materialization.submissionMaterialization.partStates).flatMap(
        (state) => state.responseVariables ?? [],
      ),
      ...Object.values(materialization.submissionMaterialization.sectionStates).flatMap(
        (state) => state.responseVariables ?? [],
      ),
    ];
    const testOutcomeVariables = [
      ...(materialization.submissionMaterialization.testState?.outcomeVariables ?? []),
      ...Object.values(materialization.submissionMaterialization.partStates).flatMap(
        (state) => state.outcomeVariables,
      ),
      ...Object.values(materialization.submissionMaterialization.sectionStates).flatMap(
        (state) => state.outcomeVariables,
      ),
    ];

    const hasPendingManualScoring = authoritativeItems.some(
      (item) => item.sessionStatus === "pendingExternalScoring",
    );

    return {
      source: "authoritative-qti-snapshot",
      totalScore: hasPendingManualScoring
        ? null
        : (readNumericOutcome(testOutcomeVariables, "SCORE") ??
          sumNullableNumbers(authoritativeItems.map((item) => item.score))),
      maxScore: hasPendingManualScoring
        ? null
        : (readNumericOutcome(testOutcomeVariables, "MAXSCORE") ??
          sumNullableNumbers(authoritativeItems.map((item) => item.maxScore))),
      passed: hasPendingManualScoring ? null : readBooleanOutcome(testOutcomeVariables, "PASSED"),
      resultStatus: hasPendingManualScoring ? "pending" : "complete",
      testResponseVariables,
      testOutcomeVariables,
      items: authoritativeItems,
    };
  }

  const summary = materialization.submissionSummary;
  const compatibilityItems: ComputedResultProjection["items"] =
    summary?.items.map((item, itemPosition) => ({
      itemPosition,
      itemId: item.itemId,
      itemIdentifier: item.itemIdentifier,
      itemTitle: item.itemTitle,
      answered: item.answered,
      responseSummary: item.responseSummary ?? null,
      score: item.score,
      maxScore: resolveItemMaxScore(item.maxScore, manifestMaxScores.get(item.itemId) ?? null),
      outcomeVariables: buildCompatibilityOutcomeVariables({
        ...item,
        maxScore: resolveItemMaxScore(item.maxScore, manifestMaxScores.get(item.itemId) ?? null),
      }),
      responseVariables: buildCompatibilityResponseVariables(item),
      sessionStatus: "final" as const,
    })) ?? [];

  return {
    source: "compatibility-submission-summary",
    totalScore: summary?.totalScore ?? null,
    maxScore: resolveAggregateMaxScore(summary?.maxScore ?? null, compatibilityItems),
    passed: null,
    resultStatus: "complete",
    testResponseVariables: [],
    testOutcomeVariables: [],
    items: compatibilityItems,
  };
}

function buildAuthoritativeItems(
  materialization: AttemptSubmissionMaterializationInput,
  manifestMaxScores: Map<string, number | null>,
): ComputedResultProjection["items"] {
  const orderedItemIds = materialization.itemOrder.length
    ? materialization.itemOrder
    : Object.keys(materialization.items);
  const seen = new Set<string>();

  for (const itemId of Object.keys(materialization.items)) {
    if (!orderedItemIds.includes(itemId)) {
      orderedItemIds.push(itemId);
    }
  }

  return orderedItemIds.reduce<ComputedResultProjection["items"]>((items, itemId) => {
    if (seen.has(itemId)) {
      return items;
    }
    seen.add(itemId);
    const item = materialization.items[itemId];
    if (!item) {
      return items;
    }

    const answered = hasAnsweredResponse(item);
    const maxScore = resolveItemMaxScore(
      readNumericOutcome(item.outcomeVariables, "MAXSCORE"),
      manifestMaxScores.get(item.itemId) ?? null,
    );

    const sessionStatus = hasPendingManualScoringOutcome(item.outcomeVariables)
      ? "pendingExternalScoring"
      : "final";

    const measuredScore = readNumericOutcome(item.outcomeVariables, "SCORE");
    const resolvedScore =
      sessionStatus === "pendingExternalScoring"
        ? null
        : resolveItemScore(measuredScore, maxScore, answered);

    items.push({
      itemPosition: items.length,
      itemId: item.itemId,
      itemIdentifier: item.itemIdentifier,
      itemTitle: item.itemTitle,
      answered,
      responseSummary: buildResponseSummary(item.responseVariables),
      score: resolvedScore,
      maxScore,
      responseVariables: item.responseVariables,
      outcomeVariables: item.outcomeVariables,
      sessionStatus,
    });

    return items;
  }, []);
}

async function loadDeliveryManifest(input: {
  bucket: R2Bucket;
  manifestObjectKey: string;
}): Promise<DeliveryManifest> {
  const manifestObject = await input.bucket.get(input.manifestObjectKey);
  if (!manifestObject) {
    throw new Error("Attempt delivery manifest object is missing during finalization.");
  }

  return manifestObject.json<DeliveryManifest>();
}

function buildManifestMaxScoreMap(manifest: DeliveryManifest): Map<string, number | null> {
  return new Map(Object.values(manifest.items).map((item) => [item.id, item.maxScore ?? null]));
}

async function persistAttemptResult(input: {
  db: D1Database;
  finalization: PersistedResultFinalization;
  envelope: SubmitFinalizationEnvelope;
  projection: ComputedResultProjection;
  materialization: ResultMaterializationPayload;
  finalizedAt: string;
}): Promise<string> {
  const resultId = `ares_${input.envelope.attemptId.replaceAll("-", "")}`;
  const updatedAt = input.finalizedAt;

  await input.db.batch([
    input.db
      .prepare(
        "INSERT INTO attempt_results (id, attempt_id, result_finalization_id, assessment_version_id, assignment_id, source_receipt_id, status, summary_source, total_score, max_score, passed, test_response_variables_json, test_outcome_variables_json, submitted_at, finalized_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET result_finalization_id = excluded.result_finalization_id, assessment_version_id = excluded.assessment_version_id, assignment_id = excluded.assignment_id, source_receipt_id = excluded.source_receipt_id, status = excluded.status, summary_source = excluded.summary_source, total_score = excluded.total_score, max_score = excluded.max_score, passed = excluded.passed, test_response_variables_json = excluded.test_response_variables_json, test_outcome_variables_json = excluded.test_outcome_variables_json, submitted_at = excluded.submitted_at, finalized_at = excluded.finalized_at, updated_at = excluded.updated_at",
      )
      .bind(
        resultId,
        input.envelope.attemptId,
        input.finalization.id,
        input.materialization.assessmentVersionId,
        input.materialization.assignmentId,
        input.envelope.receiptId,
        input.projection.resultStatus,
        input.projection.source,
        input.projection.totalScore,
        input.projection.maxScore,
        input.projection.passed === null ? null : input.projection.passed ? 1 : 0,
        JSON.stringify(input.projection.testResponseVariables),
        JSON.stringify(input.projection.testOutcomeVariables),
        input.envelope.submittedAt,
        input.finalizedAt,
        input.finalization.createdAt,
        updatedAt,
      ),
    input.db
      .prepare(
        "UPDATE result_finalizations SET status = ?, materialized_from = ?, finalized_at = ?, error_message = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(
        "complete",
        input.projection.source,
        input.finalizedAt,
        updatedAt,
        input.finalization.id,
      ),
    input.db.prepare("DELETE FROM attempt_result_items WHERE attempt_result_id = ?").bind(resultId),
  ]);

  if (input.projection.items.length > 0) {
    await input.db.batch(
      input.projection.items.map((item) =>
        input.db
          .prepare(
            "INSERT INTO attempt_result_items (id, attempt_result_id, item_position, item_id, item_identifier, item_title, answered, response_summary_text, score, max_score, base_score, base_max_score, response_variables_json, outcome_variables_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            createId("aresitm"),
            resultId,
            item.itemPosition,
            item.itemId,
            item.itemIdentifier,
            item.itemTitle,
            item.answered ? 1 : 0,
            item.responseSummary,
            item.score,
            item.maxScore,
            item.score,
            item.maxScore,
            JSON.stringify(item.responseVariables),
            JSON.stringify(item.outcomeVariables),
            input.finalizedAt,
          ),
      ),
    );
  }

  return resultId;
}

export async function markSubmitFinalizationFailed(input: {
  db: D1Database;
  envelope: SubmitFinalizationEnvelope;
  error: unknown;
}): Promise<void> {
  const updatedAt = new Date().toISOString();
  await input.db
    .prepare(
      "UPDATE result_finalizations SET status = ?, finalized_at = ?, error_message = ?, updated_at = ? WHERE source_receipt_id = ?",
    )
    .bind(
      "failed",
      updatedAt,
      input.error instanceof Error ? input.error.message : String(input.error),
      updatedAt,
      input.envelope.receiptId,
    )
    .run();
}

function hasAnsweredResponse(
  item: Pick<AttemptSubmissionMaterializationInput["items"][string], "responseVariables">,
): boolean {
  return item.responseVariables.some(
    (variable) => isStudentResponseVariable(variable.identifier) && hasValue(variable.value),
  );
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasValue(entry));
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => hasValue(entry));
  }

  return false;
}

function buildResponseSummary(responseVariables: AttemptVariableSnapshot[]): string | null {
  const studentResponseVariables = responseVariables.filter((variable) =>
    isStudentResponseVariable(variable.identifier),
  );
  const visibleValues = studentResponseVariables.flatMap((variable) => {
    const formatted = formatResponseValue(variable.value);
    if (!formatted) {
      return [];
    }

    if (studentResponseVariables.length > 1 && variable.identifier) {
      return [`${variable.identifier}: ${formatted}`];
    }

    return [formatted];
  });

  return visibleValues.length > 0 ? visibleValues.join(" · ") : null;
}

function formatResponseValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => formatResponseValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join(", ") : null;
  }

  if (typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>)
      .map((entry) => formatResponseValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join(", ") : null;
  }

  return null;
}

function isStudentResponseVariable(identifier: string | undefined): boolean {
  return identifier !== "numAttempts" && identifier !== "duration";
}

function readNumericOutcome(
  outcomeVariables: AttemptVariableSnapshot[],
  identifier: string,
): number | null {
  const variable = outcomeVariables.find((entry) => entry.identifier === identifier);
  if (!variable) {
    return null;
  }

  return readNumericValue(variable.value);
}

function readBooleanOutcome(
  outcomeVariables: AttemptVariableSnapshot[],
  identifier: string,
): boolean | null {
  const variable = outcomeVariables.find((entry) => entry.identifier === identifier);
  if (!variable) {
    return null;
  }

  if (typeof variable.value === "boolean") {
    return variable.value;
  }

  if (typeof variable.value === "string") {
    const normalized = variable.value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

function readNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function sumNullableNumbers(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
}

function resolveItemMaxScore(
  measuredMaxScore: number | null,
  authoredMaxScore: number | null,
): number | null {
  if (measuredMaxScore !== null) {
    if (measuredMaxScore > 0) {
      return measuredMaxScore;
    }

    if (authoredMaxScore === null || authoredMaxScore <= 0) {
      return measuredMaxScore;
    }
  }

  return authoredMaxScore;
}

function resolveItemScore(
  measuredScore: number | null,
  resolvedMaxScore: number | null,
  answered: boolean,
): number | null {
  if (measuredScore !== null) {
    return measuredScore;
  }

  if (!answered && resolvedMaxScore !== null && resolvedMaxScore > 0) {
    return 0;
  }

  return null;
}

function resolveAggregateMaxScore(
  measuredMaxScore: number | null,
  items: Array<{ maxScore: number | null }>,
): number | null {
  if (measuredMaxScore !== null) {
    if (measuredMaxScore > 0) {
      return measuredMaxScore;
    }

    const fallback = sumNullableNumbers(items.map((item) => item.maxScore));
    return fallback !== null && fallback > 0 ? fallback : measuredMaxScore;
  }

  return sumNullableNumbers(items.map((item) => item.maxScore));
}

function buildCompatibilityOutcomeVariables(
  item: AttemptItemScoreSummary,
): AttemptVariableSnapshot[] {
  const outcomeVariables: AttemptVariableSnapshot[] = [];

  if (item.score !== null) {
    outcomeVariables.push({
      identifier: "SCORE",
      value: item.score,
    });
  }

  if (item.maxScore !== null) {
    outcomeVariables.push({
      identifier: "MAXSCORE",
      value: item.maxScore,
    });
  }

  return outcomeVariables;
}

function buildCompatibilityResponseVariables(
  item: AttemptItemScoreSummary,
): AttemptVariableSnapshot[] {
  const responseVariables: AttemptVariableSnapshot[] = [];

  if (item.responseSummary) {
    responseVariables.push({
      identifier: "RESPONSE",
      value: item.responseSummary,
    });
  }

  return responseVariables;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
