import { AttemptDurableObject } from "./attempts/attempt-durable-object";
import { createApp } from "./app";
import type { Env } from "./env";
import { createOneRosterPreview } from "./provisioning/oneroster-rest-preview";
import { runDueLtiNrpsSyncSchedules } from "./lti/nrps-sync";
import {
  consumeSubmitFinalizationBatch,
  runPendingSubmitFinalizationRequeues,
  type SubmitFinalizationEnvelope,
} from "./queues/submit-finalization";
import {
  consumeResultExportBatch,
  RESULT_EXPORT_QUEUE_NAME,
  type ResultExportEnvelope,
} from "./queues/result-export";
import { ResultRemediationWorkflow } from "./workflows/result-remediation";

export type { Env } from "./env";
export { PHASE_ONE_BOUNDARY } from "./phase-boundary";

const app = createApp({
  oneRosterPreview: createOneRosterPreview({ fetcher: fetch }),
});

export default {
  fetch: app.fetch,
  async queue(
    this: void,
    batch: MessageBatch<SubmitFinalizationEnvelope | ResultExportEnvelope>,
    env: Env,
  ): Promise<void> {
    if (batch.queue === RESULT_EXPORT_QUEUE_NAME) {
      await consumeResultExportBatch(batch as MessageBatch<ResultExportEnvelope>, env);
      return;
    }

    await consumeSubmitFinalizationBatch(batch as MessageBatch<SubmitFinalizationEnvelope>, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime).toISOString();
    ctx.waitUntil(
      runPendingSubmitFinalizationRequeues({
        env,
      }),
    );
    ctx.waitUntil(
      runDueLtiNrpsSyncSchedules({
        env,
        now,
      }),
    );
  },
};

export { AttemptDurableObject, ResultRemediationWorkflow };
