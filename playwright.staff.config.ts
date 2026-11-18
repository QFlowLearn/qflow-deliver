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
        "pnpm --dir workers/runtime exec cf d1 migrations apply 00000000-0000-4000-8000-000000000001 --local --dir ../../packages/db/migrations --persist-to .wrangler/staff-e2e --mode staff-test && pnpm --dir workers/runtime exec vite --mode staff-test --host 127.0.0.1 --port 8791",
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
