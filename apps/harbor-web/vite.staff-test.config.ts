import { mergeConfig } from "vite";
import base from "./vite.config";

// Strict authorization tests use a separate Worker/database and never reuse a demo server.
export default mergeConfig(base, {
  server: {
    port: 4175,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8791", "/internal": "http://127.0.0.1:8791" },
  },
});
