import {
  enqueuePersistedResultExport,
  readInitialResultExportForFinalization,
  type ResultExportProducerEnv,
} from "../queues/result-export";

interface ManualFinalizationSideEffectContext {
  attempt_id: string;
  attempt_result_id: string;
  result_finalization_id: string;
  assignment_id: string | null;
  assessment_version_id: string;
  source_receipt_id: string;
}

export async function scheduleManualFinalizationSideEffects(input: {
  db: D1Database;
  env: ResultExportProducerEnv;
  context: ManualFinalizationSideEffectContext;
}): Promise<void> {
  const resultExport = await readInitialResultExportForFinalization({
    db: input.db,
    resultFinalizationId: input.context.result_finalization_id,
  });

  if (resultExport?.status === "pending" && input.env.RESULT_EXPORT_QUEUE) {
    await enqueuePersistedResultExport({
      db: input.db,
      env: input.env,
      resultExport,
    });
  }
}
