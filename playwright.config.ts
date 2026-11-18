import { defineConfig } from "@playwright/test";

const remoteBaseUrl =
  process.env.PLAYWRIGHT_BASE_URL ?? process.env.STAGING_UI_URL ?? process.env.STAGING_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  snapshotPathTemplate: "{testDir}/{testFileName}-snapshots/{arg}{ext}",
  reporter: "list",
  fullyParallel: true,
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.03,
    },
  },
  webServer: remoteBaseUrl
    ? undefined
    : [
        {
          command:
            "pnpm --dir workers/runtime db:migrate && pnpm --dir workers/runtime exec vite --host 127.0.0.1 --port 8787",
          port: 8787,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "pnpm --dir apps/harbor-web exec vite --host 127.0.0.1 --port 4173",
          port: 4173,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
  use: {
    baseURL: remoteBaseUrl || "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
