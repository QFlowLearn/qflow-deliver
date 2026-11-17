import type { Context } from "hono";

import type { Env } from "../env";

/** Hono adapter edge for public LTI protocol routes. */
export type PublicLtiContext = Context<{ Bindings: Env }>;

/** Hono adapter edge for internal LTI admin and service routes. */
export type InternalLtiContext = Context<{ Bindings: Env }>;
