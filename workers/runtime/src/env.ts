import type { SubmitFinalizationEnvelope } from "./queues/submit-finalization";
import type { ResultExportEnvelope } from "./queues/result-export";
import type { ResultRemediationWorkflowParams } from "./workflows/result-remediation";

export interface Env {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET: string;
  LTI_STATE_SECRET?: string;
  LTI_REGISTRATION_LINK_SECRET?: string;
  LTI_TOOL_PRIVATE_KEY_JWK: string;
  QFLOW_HANDOFF_SECRET?: string;
  QFLOW_RUNNER_KEY?: string;
  QFLOW_PACKAGE_ORIGIN?: string;
  HARBOR_ADMIN_KEY?: string;
  HARBOR_PASSWORD_RESET_FROM_EMAIL?: string;
  HARBOR_PUBLIC_ORIGIN?: string;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
  ALLOW_UNSAFE_LOCAL_INTERNAL_API?: string;
  ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH?: string;
  ALLOW_UNSAFE_LOCAL_INSTITUTIONAL_AUTH?: string;
  ALLOW_UNSAFE_LOCAL_INSTRUCTOR_TENANT_ID?: string;
  ASSETS?: {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  };
  EMAIL?: SendEmail;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
  SUBMIT_FINALIZATION_QUEUE: Queue<SubmitFinalizationEnvelope>;
  RESULT_EXPORT_QUEUE?: Queue<ResultExportEnvelope>;
  RESULT_REMEDIATION_WORKFLOW?: Workflow<ResultRemediationWorkflowParams>;
}
