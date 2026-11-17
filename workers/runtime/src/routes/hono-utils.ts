import type { Context } from "hono";

import type { Env } from "../env";

/** Default Hono context for Harbor route handlers mounted on `app.ts` sub-routers. */
export type AppContext = Context<{ Bindings: Env }>;

export function requestUrl(c: { req: { url: string } }): URL {
  return new URL(c.req.url);
}
