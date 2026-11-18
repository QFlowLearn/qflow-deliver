import { bindings, defineConfig } from "cf/config";
import { runtimeWorker } from "./runtime-config.ts";

export default defineConfig(({ mode }) => ({
  worker:
    mode === "test"
      ? {
          ...runtimeWorker,
          // Native test deliveries use single-message batches with no batching delay.
          triggers: runtimeWorker.triggers.map((trigger) =>
            trigger.type === "queue"
              ? { ...trigger, maxBatchSize: 1, maxBatchTimeout: 0 }
              : trigger,
          ),
        }
      : mode === "staff-test"
        ? {
            ...runtimeWorker,
            env: {
              ...runtimeWorker.env,
              ALLOW_UNSAFE_LOCAL_INTERNAL_API: bindings.text("false"),
              ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH: bindings.text("false"),
              ALLOW_UNSAFE_LOCAL_INSTITUTIONAL_AUTH: bindings.text("false"),
              HARBOR_ADMIN_KEY: bindings.text("staff-e2e-test-admin"),
            },
          }
        : runtimeWorker,
}));
