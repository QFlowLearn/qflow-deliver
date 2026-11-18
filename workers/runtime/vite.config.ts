import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  // Use the self-contained distribution: the Node entry loads grammar JSON with createRequire.
  resolve: { alias: { "css-tree": "css-tree/dist/csstree.esm" } },
  server: { host: "127.0.0.1", port: 8787, strictPort: true },
  plugins: [
    cloudflare({
      types: { generate: false },
      remoteBindings: false,
      // Keep local state in the existing directories and isolate strict staff tests.
      persistState: {
        path: fileURLToPath(
          new URL(
            mode === "staff-test" ? "./.wrangler/staff-e2e" : "./.wrangler/state",
            import.meta.url,
          ),
        ),
      },
    }),
  ],
}));
