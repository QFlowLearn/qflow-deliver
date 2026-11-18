import { existsSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrationsDir = "packages/db/migrations";

export default defineConfig(async () => {
  const testMigrations = existsSync(migrationsDir) ? await readD1Migrations(migrationsDir) : [];

  return {
    plugins: [
      cloudflareTest({
        main: "./workers/runtime/test/runtime-main.ts",
        config: "./workers/runtime/cloudflare.config.ts",
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: testMigrations,
          },
        },
      }),
    ],
    test: {
      include: ["workers/**/*.spec.ts"],
    },
  };
});
