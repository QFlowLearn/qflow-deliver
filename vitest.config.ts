import { existsSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsDir = "packages/db/migrations";

export default defineConfig(async () => {
  const testMigrations = existsSync(migrationsDir) ? await readD1Migrations(migrationsDir) : [];

  return {
    plugins: [
      cloudflareTest({
        main: "./workers/runtime/test/runtime-main.ts",
        wrangler: {
          configPath: "./workers/runtime/wrangler.jsonc",
        },
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
