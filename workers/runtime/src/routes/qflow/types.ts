export interface QflowSignedRequestEnv {
  HARBOR_DB: D1Database;
  QFLOW_HANDOFF_SECRET?: string;
}

export interface QflowHandoffEnv extends QflowSignedRequestEnv {
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
}

export interface QflowPublishEnv extends QflowSignedRequestEnv {
  CONTENT_BUCKET: R2Bucket;
  QFLOW_RUNNER_KEY?: string;
  QFLOW_PACKAGE_ORIGIN?: string;
}

export interface QflowSsoLaunchEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET: string;
  QFLOW_HANDOFF_SECRET?: string;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
}

export interface QflowAdminEnv {
  HARBOR_DB: D1Database;
  HARBOR_ADMIN_KEY?: string;
}
