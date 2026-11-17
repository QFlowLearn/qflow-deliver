import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // The app and linked player adapters must share Preact's hooks and ref runtime.
    dedupe: ["preact"],
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/internal": "http://127.0.0.1:8787",
    },
  },
});
