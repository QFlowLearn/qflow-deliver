import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  markSubmitFinalizationFailed,
  processSubmitFinalizationEnvelope,
  type SubmitFinalizationConsumerEnv,
} from "../queues/submit-finalization";
import { queueResultExportRetry, type ResultExportProducerEnv } from "../queues/result-export";

export interface ResultRemediationWorkflowParams {
  requestId: string;
}

export interface ResultRemediationWorkflowEnv
  extends SubmitFinalizationConsumerEnv, ResultExportProducerEnv {}

interface RemediationRequestRow {
  id: string;
  attempt_id: string;
  source_receipt_id: string;
  scope_kind: string;
  status: "pending" | "complete" | "failed";
  result_finalization_id: string | null;
  result_export_id: string | null;
  source_sequence_number: number | null;
  source_event_type: "submit.requested" | "timing.auto-submit.requested" | null;
  submitted_at: string | null;
}

export class ResultRemediationWorkflow extends WorkflowEntrypoint<
  ResultRemediationWorkflowEnv,
  ResultRemediationWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<ResultRemediationWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ requestId: string; status: "complete" | "failed" }> {
    return step.do("execute result remediation", async () =>
      executeResultRemediationRequest({
        env: this.env as ResultRemediationWorkflowEnv & { HARBOR_DB: D1Database },
        requestId: event.payload.requestId,
      }),
    );
  }
}

export async function executeResultRemediationRequest(input: {
  env: ResultRemediationWorkflowEnv & {
    HARBOR_DB: D1Database;
  };
  requestId: string;
}): Promise<{ requestId: string; status: "complete" | "failed" }> {
  const request = await readRemediationRequest(input.env.HARBOR_DB, input.requestId);
  if (!request) {
    throw new Error("Result remediation request not found");
  }

  if (request.status === "complete") {
    return {
      requestId: request.id,
      status: "complete",
    };
  }

  try {
    if (request.scope_kind === "result-finalization") {
      if (request.source_sequence_number === null || request.submitted_at === null) {
        throw new Error("Result finalization remediation is missing source context");
      }

      await processSubmitFinalizationEnvelope(
        {
          attemptId: request.attempt_id,
          eventType: request.source_event_type ?? "submit.requested",
          receiptId: request.source_receipt_id,
          acceptedSequenceNumber: request.source_sequence_number,
          submittedAt: request.submitted_at,
        },
        input.env,
      );
    } else if (request.scope_kind === "result-export") {
      if (!request.result_export_id) {
        throw new Error("Result export remediation is missing export target");
      }

      await queueResultExportRetry({
        db: input.env.HARBOR_DB,
        env: input.env,
        requestId: request.id,
        retryOfExportId: request.result_export_id,
      });
    } else {
      throw new Error(`Unsupported remediation scope: ${request.scope_kind}`);
    }

    await markRemediationComplete(input.env.HARBOR_DB, request.id);
    return {
      requestId: request.id,
      status: "complete",
    };
  } catch (error) {
    if (request.scope_kind === "result-finalization") {
      await markSubmitFinalizationFailed({
        db: input.env.HARBOR_DB,
        envelope: {
          attemptId: request.attempt_id,
          eventType: request.source_event_type ?? "submit.requested",
          receiptId: request.source_receipt_id,
          acceptedSequenceNumber: request.source_sequence_number ?? 0,
          submittedAt: request.submitted_at ?? new Date().toISOString(),
        },
        error,
      });
    }

    await markRemediationFailed(input.env.HARBOR_DB, request.id, error);
    throw error;
  }
}

async function readRemediationRequest(
  db: D1Database,
  requestId: string,
): Promise<RemediationRequestRow | null> {
  return db
    .prepare(
      `SELECT
        rr.id,
        rr.attempt_id,
        rr.source_receipt_id,
        rr.scope_kind,
        rr.status,
        rr.result_finalization_id,
        rr.result_export_id,
        rf.source_sequence_number,
        COALESCE(rf.source_event_type, 'submit.requested') AS source_event_type,
        rf.submitted_at
      FROM result_remediation_requests rr
      LEFT JOIN result_finalizations rf ON rf.id = rr.result_finalization_id
      WHERE rr.id = ?`,
    )
    .bind(requestId)
    .first<RemediationRequestRow>();
}

async function markRemediationComplete(db: D1Database, requestId: string): Promise<void> {
  const completedAt = new Date().toISOString();
  await db
    .prepare(
      "UPDATE result_remediation_requests SET status = ?, completed_at = ?, error_message = NULL, updated_at = ? WHERE id = ?",
    )
    .bind("complete", completedAt, completedAt, requestId)
    .run();
}

async function markRemediationFailed(
  db: D1Database,
  requestId: string,
  error: unknown,
): Promise<void> {
  const completedAt = new Date().toISOString();
  await db
    .prepare(
      "UPDATE result_remediation_requests SET status = ?, completed_at = ?, error_message = ?, updated_at = ? WHERE id = ?",
    )
    .bind(
      "failed",
      completedAt,
      error instanceof Error ? error.message : String(error),
      completedAt,
      requestId,
    )
    .run();
}
