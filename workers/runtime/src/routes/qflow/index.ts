import { Hono } from "hono";
import type { Env } from "../../env";
import { handleQflowSsoLaunchRequest } from "./sso-launch";

export function createQflowSsoRoutes(): Hono<{ Bindings: Env }> {
  const qflow = new Hono<{ Bindings: Env }>();

  qflow.get("/sso/launch", handleQflowSsoLaunchRequest);

  return qflow;
}
