import type { AttemptVariableSnapshot } from "@harbor/attempt-protocol";
import {
  buildQtiResultsReport,
  QTI_RESULTS_REPORT_CONTENT_TYPE,
} from "../results/build-qti-results-report";

export const RESULT_EXPORT_QUEUE_NAME = "harbor-result-export";
export const RESULT_EXPORT_DLQ_NAME = "harbor-result-export-dlq";

export interface ResultExportEnvelope {
  exportId: string;
  attemptId: string;
  sourceReceiptId: string;
}

export interface ResultExportProducerEnv {
  RESULT_EXPORT_QUEUE?: Queue<ResultExportEnvelope>;
}

interface ResultExportConsumerEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  record?: (entry: { exportId: string; attemptId: string; outcome: "consumed" }) => void;
}

export interface PersistedResultExport {
  id: string;
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
  exportFormat: "qti3-results-report";
  status: "pending" | "complete" | "failed";
  artifactPath: string | null;
  artifactContentType: string | null;
  artifactSha256: string | null;
  artifactSizeBytes: number | null;
  retryOfExportId: string | null;
  exportedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ResultExportContextRow extends PersistedResultExport {
  assessmentId: string;
  actorId: string | null;
  finalizedAt: string;
  submittedAt: string;
  totalScore: number | null;
  maxScore: number | null;
  passed: number | null;
  testResponseVariablesJson: string;
  testOutcomeVariablesJson: string;
}

interface ResultExportItemRow {
  item_id: string;
  item_identifier: string | null;
  score: number | null;
  max_score: number | null;
  response_variables_json: string;
  outcome_variables_json: string;
}

export async function queueInitialResultExport(input: {
  db: D1Database;
  env: ResultExportProducerEnv;
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
}): Promise<void> {
  const created = await ensureInitialResultExport(input);
  if (created.status !== "pending") {
    return;
  }

  if (!input.env.RESULT_EXPORT_QUEUE) {
    return;
  }

  await enqueuePersistedResultExport({
    db: input.db,
    env: input.env,
    resultExport: created,
  });
}

export async function ensureInitialResultExport(input: {
  db: D1Database;
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
}): Promise<PersistedResultExport> {
  const existing = await input.db
    .prepare(
      "SELECT id, attempt_id AS attemptId, attempt_result_id AS attemptResultId, result_finalization_id AS resultFinalizationId, assignment_id AS assignmentId, assessment_version_id AS assessmentVersionId, source_receipt_id AS sourceReceiptId, export_format AS exportFormat, status, artifact_path AS artifactPath, artifact_content_type AS artifactContentType, artifact_sha256 AS artifactSha256, artifact_size_bytes AS artifactSizeBytes, retry_of_export_id AS retryOfExportId, exported_at AS exportedAt, error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt FROM result_exports WHERE result_finalization_id = ? AND retry_of_export_id IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(input.resultFinalizationId)
    .first<PersistedResultExport>();

  if (existing) {
    return existing;
  }

  const createdAt = new Date().toISOString();
  const created: PersistedResultExport = {
    id: createInitialResultExportId(input.resultFinalizationId),
    attemptId: input.attemptId,
    attemptResultId: input.attemptResultId,
    resultFinalizationId: input.resultFinalizationId,
    assignmentId: input.assignmentId,
    assessmentVersionId: input.assessmentVersionId,
    sourceReceiptId: input.sourceReceiptId,
    exportFormat: "qti3-results-report",
    status: "pending",
    artifactPath: null,
    artifactContentType: null,
    artifactSha256: null,
    artifactSizeBytes: null,
    retryOfExportId: null,
    exportedAt: null,
    errorMessage: null,
    createdAt,
    updatedAt: createdAt,
  };

  await input.db
    .prepare(
      "INSERT INTO result_exports (id, attempt_id, attempt_result_id, result_finalization_id, assignment_id, assessment_version_id, source_receipt_id, export_format, status, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, retry_of_export_id, exported_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      created.id,
      created.attemptId,
      created.attemptResultId,
      created.resultFinalizationId,
      created.assignmentId,
      created.assessmentVersionId,
      created.sourceReceiptId,
      created.exportFormat,
      created.status,
      created.artifactPath,
      created.artifactContentType,
      created.artifactSha256,
      created.artifactSizeBytes,
      created.retryOfExportId,
      created.exportedAt,
      created.errorMessage,
      created.createdAt,
      created.updatedAt,
    )
    .run();

  return created;
}

export function buildInitialResultExportIntentStatement(input: {
  db: D1Database;
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
  now: string;
}): D1PreparedStatement {
  return input.db
    .prepare(
      "INSERT OR IGNORE INTO result_exports (id, attempt_id, attempt_result_id, result_finalization_id, assignment_id, assessment_version_id, source_receipt_id, export_format, status, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, retry_of_export_id, exported_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      createInitialResultExportId(input.resultFinalizationId),
      input.attemptId,
      input.attemptResultId,
      input.resultFinalizationId,
      input.assignmentId,
      input.assessmentVersionId,
      input.sourceReceiptId,
      "qti3-results-report",
      "pending",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      input.now,
      input.now,
    );
}

export async function readInitialResultExportForFinalization(input: {
  db: D1Database;
  resultFinalizationId: string;
}): Promise<PersistedResultExport | null> {
  return input.db
    .prepare(
      "SELECT id, attempt_id AS attemptId, attempt_result_id AS attemptResultId, result_finalization_id AS resultFinalizationId, assignment_id AS assignmentId, assessment_version_id AS assessmentVersionId, source_receipt_id AS sourceReceiptId, export_format AS exportFormat, status, artifact_path AS artifactPath, artifact_content_type AS artifactContentType, artifact_sha256 AS artifactSha256, artifact_size_bytes AS artifactSizeBytes, retry_of_export_id AS retryOfExportId, exported_at AS exportedAt, error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt FROM result_exports WHERE result_finalization_id = ? AND retry_of_export_id IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(input.resultFinalizationId)
    .first<PersistedResultExport>();
}

export async function enqueuePersistedResultExport(input: {
  db: D1Database;
  env: ResultExportProducerEnv;
  resultExport: Pick<PersistedResultExport, "id" | "attemptId" | "sourceReceiptId">;
}): Promise<void> {
  try {
    await enqueueResultExport({
      env: input.env,
      exportId: input.resultExport.id,
      attemptId: input.resultExport.attemptId,
      sourceReceiptId: input.resultExport.sourceReceiptId,
    });
  } catch (error) {
    await markResultExportFailed({
      db: input.db,
      exportId: input.resultExport.id,
      error,
    });
    console.error(
      JSON.stringify({
        queue: RESULT_EXPORT_QUEUE_NAME,
        exportId: input.resultExport.id,
        attemptId: input.resultExport.attemptId,
        sourceReceiptId: input.resultExport.sourceReceiptId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function queueResultExportRetry(input: {
  db: D1Database;
  env: ResultExportProducerEnv;
  requestId: string;
  retryOfExportId: string;
}): Promise<{ exportId: string; attemptId: string }> {
  if (!input.env.RESULT_EXPORT_QUEUE) {
    throw new Error("Result export queue binding is unavailable");
  }

  const exportId = createRetryExportId(input.requestId);
  const existing = await readPersistedResultExport(input.db, exportId);
  if (existing) {
    return {
      exportId: existing.id,
      attemptId: existing.attemptId,
    };
  }

  const original = await readPersistedResultExport(input.db, input.retryOfExportId);
  if (!original) {
    throw new Error("Result export retry target not found");
  }

  const createdAt = new Date().toISOString();
  await input.db
    .prepare(
      "INSERT INTO result_exports (id, attempt_id, attempt_result_id, result_finalization_id, assignment_id, assessment_version_id, source_receipt_id, export_format, status, artifact_path, artifact_content_type, artifact_sha256, artifact_size_bytes, retry_of_export_id, exported_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      exportId,
      original.attemptId,
      original.attemptResultId,
      original.resultFinalizationId,
      original.assignmentId,
      original.assessmentVersionId,
      original.sourceReceiptId,
      original.exportFormat,
      "pending",
      null,
      null,
      null,
      null,
      original.id,
      null,
      null,
      createdAt,
      createdAt,
    )
    .run();

  try {
    await enqueueResultExport({
      env: input.env,
      exportId,
      attemptId: original.attemptId,
      sourceReceiptId: original.sourceReceiptId,
    });
    return {
      exportId,
      attemptId: original.attemptId,
    };
  } catch (error) {
    await markResultExportFailed({
      db: input.db,
      exportId,
      error,
    });
    throw error;
  }
}

export async function requeueCompletedResultExportsForAttemptResult(input: {
  db: D1Database;
  env?: ResultExportProducerEnv;
  attemptResultId: string;
}): Promise<number> {
  const completed = await input.db
    .prepare(
      "SELECT id, attempt_id AS attemptId, source_receipt_id AS sourceReceiptId FROM result_exports WHERE attempt_result_id = ? AND status = ?",
    )
    .bind(input.attemptResultId, "complete")
    .all<{
      id: string;
      attemptId: string;
      sourceReceiptId: string;
    }>();

  if (completed.results.length === 0) {
    return 0;
  }

  const updatedAt = new Date().toISOString();
  await input.db
    .prepare(
      "UPDATE result_exports SET status = ?, artifact_path = NULL, artifact_content_type = NULL, artifact_sha256 = NULL, artifact_size_bytes = NULL, exported_at = NULL, error_message = NULL, updated_at = ? WHERE attempt_result_id = ? AND status = ?",
    )
    .bind("pending", updatedAt, input.attemptResultId, "complete")
    .run();

  if (!input.env?.RESULT_EXPORT_QUEUE) {
    return completed.results.length;
  }

  for (const row of completed.results) {
    try {
      await enqueueResultExport({
        env: input.env,
        exportId: row.id,
        attemptId: row.attemptId,
        sourceReceiptId: row.sourceReceiptId,
      });
    } catch (error) {
      await markResultExportFailed({
        db: input.db,
        exportId: row.id,
        error,
      });
      console.error(
        JSON.stringify({
          queue: RESULT_EXPORT_QUEUE_NAME,
          exportId: row.id,
          attemptId: row.attemptId,
          sourceReceiptId: row.sourceReceiptId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return completed.results.length;
}

export async function enqueueResultExport(input: {
  env: ResultExportProducerEnv;
  exportId: string;
  attemptId: string;
  sourceReceiptId: string;
}): Promise<ResultExportEnvelope> {
  if (!input.env.RESULT_EXPORT_QUEUE) {
    throw new Error("Result export queue binding is unavailable");
  }

  const envelope: ResultExportEnvelope = {
    exportId: input.exportId,
    attemptId: input.attemptId,
    sourceReceiptId: input.sourceReceiptId,
  };

  await input.env.RESULT_EXPORT_QUEUE.send(envelope);
  return envelope;
}

export async function consumeResultExportBatch(
  batch: MessageBatch<ResultExportEnvelope>,
  env: ResultExportConsumerEnv,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processResultExportEnvelope(message.body, env);
      env.record?.({
        exportId: message.body.exportId,
        attemptId: message.body.attemptId,
        outcome: "consumed",
      });
    } catch (error) {
      await markResultExportFailed({
        db: env.HARBOR_DB,
        exportId: message.body.exportId,
        error,
      });
      console.error(
        JSON.stringify({
          queue: RESULT_EXPORT_QUEUE_NAME,
          exportId: message.body.exportId,
          attemptId: message.body.attemptId,
          sourceReceiptId: message.body.sourceReceiptId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      message.ack();
    }
  }
}

export async function processResultExportEnvelope(
  envelope: ResultExportEnvelope,
  env: ResultExportConsumerEnv,
): Promise<void> {
  const context = await loadResultExportContext(env.HARBOR_DB, envelope.exportId);
  if (!context) {
    throw new Error("Result export record not found");
  }

  if (context.status === "complete" || context.status === "failed") {
    return;
  }

  const items = await loadResultExportItems(env.HARBOR_DB, context.attemptResultId);
  const xml = buildQtiResultsReport({
    attemptId: context.attemptId,
    actorId: context.actorId,
    assessmentVersionId: context.assessmentVersionId,
    finalizedAt: context.finalizedAt,
    submittedAt: context.submittedAt,
    totalScore: context.totalScore,
    maxScore: context.maxScore,
    passed: context.passed === null ? null : context.passed === 1,
    testResponseVariables: parseJsonArray<AttemptVariableSnapshot>(
      context.testResponseVariablesJson,
    ),
    testOutcomeVariables: parseJsonArray<AttemptVariableSnapshot>(context.testOutcomeVariablesJson),
    items: items.map((item) => ({
      itemId: item.item_id,
      itemIdentifier: item.item_identifier,
      score: item.score,
      maxScore: item.max_score,
      responseVariables: parseJsonArray<AttemptVariableSnapshot>(item.response_variables_json),
      outcomeVariables: parseJsonArray<AttemptVariableSnapshot>(item.outcome_variables_json),
    })),
  });

  const bytes = new TextEncoder().encode(xml);
  const artifactPath = `results/${context.assessmentVersionId}/${context.attemptId}/${context.id}.xml`;
  await env.CONTENT_BUCKET.put(artifactPath, bytes, {
    httpMetadata: {
      contentType: QTI_RESULTS_REPORT_CONTENT_TYPE,
    },
  });

  const exportedAt = new Date().toISOString();
  await env.HARBOR_DB.prepare(
    "UPDATE result_exports SET status = ?, artifact_path = ?, artifact_content_type = ?, artifact_sha256 = ?, artifact_size_bytes = ?, exported_at = ?, error_message = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(
      "complete",
      artifactPath,
      QTI_RESULTS_REPORT_CONTENT_TYPE,
      await digestSha256Hex(bytes),
      bytes.byteLength,
      exportedAt,
      exportedAt,
      context.id,
    )
    .run();
}

async function loadResultExportContext(
  db: D1Database,
  exportId: string,
): Promise<ResultExportContextRow | null> {
  return db
    .prepare(
      `SELECT
        re.id,
        re.attempt_id AS attemptId,
        re.attempt_result_id AS attemptResultId,
        re.result_finalization_id AS resultFinalizationId,
        re.assignment_id AS assignmentId,
        re.assessment_version_id AS assessmentVersionId,
        re.source_receipt_id AS sourceReceiptId,
        re.export_format AS exportFormat,
        re.status,
        re.artifact_path AS artifactPath,
        re.artifact_content_type AS artifactContentType,
        re.artifact_sha256 AS artifactSha256,
        re.artifact_size_bytes AS artifactSizeBytes,
        re.retry_of_export_id AS retryOfExportId,
        re.exported_at AS exportedAt,
        re.error_message AS errorMessage,
        re.created_at AS createdAt,
        re.updated_at AS updatedAt,
        ar.total_score AS totalScore,
        ar.max_score AS maxScore,
        ar.passed,
        ar.test_response_variables_json AS testResponseVariablesJson,
        ar.test_outcome_variables_json AS testOutcomeVariablesJson,
        ar.finalized_at AS finalizedAt,
        ar.submitted_at AS submittedAt,
        ae.actor_id AS actorId,
        av.assessment_id AS assessmentId
      FROM result_exports re
      JOIN attempt_results ar ON ar.id = re.attempt_result_id
      JOIN attempt_entries ae ON ae.id = re.attempt_id
      JOIN assessment_versions av ON av.id = re.assessment_version_id
      WHERE re.id = ?`,
    )
    .bind(exportId)
    .first<ResultExportContextRow>();
}

async function loadResultExportItems(
  db: D1Database,
  attemptResultId: string,
): Promise<ResultExportItemRow[]> {
  const result = await db
    .prepare(
      "SELECT item_id, item_identifier, score, max_score, response_variables_json, outcome_variables_json FROM attempt_result_items WHERE attempt_result_id = ? ORDER BY created_at ASC, item_id ASC",
    )
    .bind(attemptResultId)
    .all<ResultExportItemRow>();

  return result.results;
}

async function markResultExportFailed(input: {
  db: D1Database;
  exportId: string;
  error: unknown;
}): Promise<void> {
  const updatedAt = new Date().toISOString();
  await input.db
    .prepare(
      "UPDATE result_exports SET status = ?, artifact_path = NULL, artifact_content_type = NULL, artifact_sha256 = NULL, artifact_size_bytes = NULL, exported_at = NULL, error_message = ?, updated_at = ? WHERE id = ?",
    )
    .bind(
      "failed",
      input.error instanceof Error ? input.error.message : String(input.error),
      updatedAt,
      input.exportId,
    )
    .run();
}

async function readPersistedResultExport(
  db: D1Database,
  exportId: string,
): Promise<PersistedResultExport | null> {
  return db
    .prepare(
      "SELECT id, attempt_id AS attemptId, attempt_result_id AS attemptResultId, result_finalization_id AS resultFinalizationId, assignment_id AS assignmentId, assessment_version_id AS assessmentVersionId, source_receipt_id AS sourceReceiptId, export_format AS exportFormat, status, artifact_path AS artifactPath, artifact_content_type AS artifactContentType, artifact_sha256 AS artifactSha256, artifact_size_bytes AS artifactSizeBytes, retry_of_export_id AS retryOfExportId, exported_at AS exportedAt, error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt FROM result_exports WHERE id = ?",
    )
    .bind(exportId)
    .first<PersistedResultExport>();
}

function parseJsonArray<T>(value: string | null): T[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function digestSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (entry) => entry.toString(16).padStart(2, "0")).join(
    "",
  );
}

function createInitialResultExportId(resultFinalizationId: string): string {
  return `rexp_${resultFinalizationId.replaceAll("-", "")}`;
}

function createRetryExportId(requestId: string): string {
  return `rexp_retry_${requestId.replaceAll("-", "")}`;
}
