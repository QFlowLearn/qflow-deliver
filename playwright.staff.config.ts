import { defineConfig } from "@playwright/test";

// Fixed local test origins deliberately ignore inherited remote Playwright settings.
export default defineConfig({
  testDir: "./tests/staff-e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4175", trace: "retain-on-failure" },
  projects: [{ name: "chromium-staff", use: { browserName: "chromium" } }],
  webServer: [
    {
      command:
        "pnpm --dir workers/runtime exec wrangler d1 migrations apply harbor-runtime-local --local --config wrangler.jsonc --persist-to .wrangler/staff-e2e && pnpm --dir workers/runtime exec wrangler dev --config wrangler.jsonc --persist-to .wrangler/staff-e2e --ip 127.0.0.1 --port 8791 --var ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH:false --var ALLOW_UNSAFE_LOCAL_INTERNAL_API:false --var ALLOW_UNSAFE_LOCAL_INSTITUTIONAL_AUTH:false --var HARBOR_ADMIN_KEY:staff-e2e-test-admin",
      port: 8791,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm --dir apps/harbor-web exec vite --config vite.staff-test.config.ts",
      port: 4175,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
