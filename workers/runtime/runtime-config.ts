import type { WorkerConfig } from "cf/config";

/** Synthetic local/test resources only. Never use these credentials for a public service. */
export const runtimeWorker = {
  name: "harbor-runtime",
  compatibilityDate: "2026-03-17",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "src/index.ts",
  observability: {
    enabled: true,
    logs: {
      enabled: true,
      invocationLogs: true,
    },
  },
  triggers: [
    {
      type: "scheduled",
      schedule: "* * * * *",
    },
    {
      type: "queue",
      deadLetterQueue: "harbor-submit-finalization-dlq",
      name: "harbor-submit-finalization",
    },
    {
      type: "queue",
      deadLetterQueue: "harbor-result-export-dlq",
      name: "harbor-result-export",
    },
  ],
  env: {
    BOOTSTRAP_SIGNING_SECRET: {
      type: "text",
      value: "harbor-bootstrap-test-secret",
    },
    LTI_STATE_SECRET: {
      type: "text",
      value: "lti-state-local-secret",
    },
    LTI_REGISTRATION_LINK_SECRET: {
      type: "text",
      value: "lti-registration-link-local-secret",
    },
    QFLOW_HANDOFF_SECRET: {
      type: "text",
      value: "qflow-handoff-local-secret",
    },
    QFLOW_RUNNER_KEY: {
      type: "text",
      value: "qflow-runner-local-secret",
    },
    HARBOR_ADMIN_KEY: {
      type: "text",
      value: "harbor-admin-local-secret",
    },
    HARBOR_PASSWORD_RESET_FROM_EMAIL: {
      type: "text",
      value: "no-reply@deliver.example.test",
    },
    HARBOR_PUBLIC_ORIGIN: {
      type: "text",
      value: "https://harbor.local",
    },
    ALLOW_UNSAFE_LOCAL_INTERNAL_API: {
      type: "text",
      value: "true",
    },
    ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH: {
      type: "text",
      value: "true",
    },
    ALLOW_UNSAFE_LOCAL_INSTITUTIONAL_AUTH: {
      type: "text",
      value: "true",
    },
    LTI_TOOL_PRIVATE_KEY_JWK: {
      type: "text",
      value:
        '{"kty":"RSA","n":"hY5zZmWOto-xPpKT3bbZaZtKzCE3as9tA6IUEZhZA6-dVQBbUN0Sm0wir4xSY8gYshZiY5c3o76Ma2X6W_Ypi5otCtgSy080pL3LjqrG3xiXYlyF4rQMMBUD6WIoD8T-nGgY--IhqMN4XRRtxKArZQrM8UR9Oax0dFWl5KUnHldBsbod8cuLypiZ_uS1Ff0ggby1nralZSnuxAgjjvvPeE4B-HJqmQADGsO2QpISp-fbKMSRmT8zC8nTHOgN3x5TQ4A6tHRxyRjXl7dW7P09rcBwtkpKF72EWIAXR1X-spsGRX_KbAnaYIu8ZLW-aJuQs-CqDvCn009EviQcaX_oNw","e":"AQAB","d":"DrymuCxJoJRfcu-amFLmT5RenwKlSkhkF4wJWd2tKM52dlwpN1WFiZRPmX5K0w7PxsrYhXO4pH1QokMo6n_RmsFi6fjorf1p6im1LeNjOVfN0IE0Fs1WMPIIsfZuRDsw-xIze4u6uhQDkoXADPu9fhNAhPjRNo10difDO-ULWXoPi6I5GxuZoZctGA8ZU183Oh15D5tSWHyziMeNKRIchay-DXZ4eDQzVUD5HZi7UARBYSfxrpYXP2nlI1RF7-_X3kDRm8NR04WD7YF_OCI51PRDV5TZvIGbgnTdAOlR6A-He1aNqIZ6XnFNcWYU7u7ehKy3DOxKtVlYfPNgoVI1IQ","p":"uWnPvyvwsvuH8xV5QKB-cXKNv_aD4gBwK3wHUhvzfKKELZ1Nu9mI6uhtxQd-aKHC7paWqPwp0DvM820zfi4zz8rkDnzwhkunrXVq9RYB5VDttaZ7FTtY5Wt8Xet0P4OhbGx8La_vODEckjFkLakIBjh4DPH5tnaz4xycvinr-dc","q":"uGa46C_EMyB-URecXXMWDboJqKPZIWOXVbwLKEPjCxprwwmvfbY4OLtBM78FQmE1x0wXnKkOmE1-7xz0d8C2aSEudAY0aCQz2jdYw7NIPJWaPQp1AxMuXmNdDyACANaZeAt1dgDvkoX3EnUKAkcdZJWGrbqXevEFuxP3Wvd9eKE","dp":"b2uFmzU1jOkYllxmJA8OTPBw_FWQhUSMI6WB5LbFSDWFRsAL0YH1BG0uYcOSFCB5OtUlrmDyY588F2CdHAt5uToMeCReieV22wb_gk56Tyql3o4v0t96GUvRTcNLdUuNutEqgm4CTHs-1x91OvcjylEu22CiFiMZELbF_oTEuLs","dq":"OGGAC83_CTrYJGc5sgDsL0pAhcWDMAhJTzdtmeQX2V88r6eYdrFuQzpN10qCiyc50DPdzFKMWdjoBKgvvyW3IDG7CFKVV3oqOIBPrZZ1ccC0JhG6cTQ-KzHqVCOPOT5kMiYexfPHTF-ViZkrdELWI9jsEtZIVpi3Ddou-StOu8E","qi":"jSeQUv6QDVjosaMYa6awBWhesn828ABpgNHrTo5R1lyEXUZfyoXXgJWuwxSH-xO5VJoqRWD0kbn4jgpxdmhcq_Yrb53KdUg7qDGkRvbXioYAVHQ6-ZCmk3kpQYIJQYG0se4w2Bl30Tzqdcs81xvFkJuxoLEUfrGWbn2Ayyqn5zU","alg":"RS256","use":"sig","kid":"main"}',
    },
    ATTEMPT_RUNTIME_METRICS: {
      type: "analytics-engine-dataset",
      name: "ATTEMPT_RUNTIME_METRICS",
    },
    HARBOR_DB: {
      type: "d1",
      name: "harbor-runtime-local",
      id: "00000000-0000-4000-8000-000000000001",
    },
    CONTENT_BUCKET: {
      type: "r2",
      name: "harbor-content-local",
    },
    EMAIL: {
      type: "send-email",
    },
    SUBMIT_FINALIZATION_QUEUE: {
      type: "queue",
      name: "harbor-submit-finalization",
    },
    RESULT_EXPORT_QUEUE: {
      type: "queue",
      name: "harbor-result-export",
    },
    ATTEMPT_COORDINATOR: {
      type: "durable-object",
      worker: "harbor-runtime",
      exportName: "AttemptDurableObject",
    },
    RESULT_REMEDIATION_WORKFLOW: {
      type: "workflow",
      name: "harbor-result-remediation",
      worker: "harbor-runtime",
      exportName: "ResultRemediationWorkflow",
    },
  },
  exports: {
    AttemptDurableObject: {
      type: "durable-object",
      storage: "sqlite",
    },
    ResultRemediationWorkflow: {
      type: "workflow",
      name: "harbor-result-remediation",
    },
  },
} as const satisfies WorkerConfig;
